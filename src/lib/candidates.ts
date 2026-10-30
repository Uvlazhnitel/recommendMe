import { personalScope, type UserId } from './profiles';
import { parsePreferences, preferenceExclusion, type RecommendationPreferences } from './recommendation-preferences';
import { stageEvaluation } from './evaluation-metadata';
import type Database from 'better-sqlite3';
import { selectVerifiedCandidates } from './candidate-selection';
import { RECOMMENDATION_REPEAT_DAYS } from './recommendation-policy';
import { buildCandidateContext, blockedReason, CANDIDATE_FORMAT, CANDIDATE_LIMITS, readCandidateHistory } from './candidate-context';
import { requestStructuredOutput, requireOpenAIConfig, type Usage } from './openai';
import { createTmdbClient, matches, normalizeTitle, TmdbError, type Candidate, type Details } from './tmdb';

export type MovieCandidate = { tmdb_id: number; media_type: 'movie'; title: string; original_title: string | null; year: number; overview: string;
  genres: { id: number; name: string }[]; runtime: number; directors: { id: number; name: string }[] | null;
  vote_count: number | null; popularity: number | null; source: 'llm' | 'tmdb' | 'both';
  poster_path?: string | null; backdrop_path?: string | null };
type Proposal = { title: string; year: number };
type Source = 'llm' | 'tmdb';
type Diagnostic = { source: Source; title: string; year: number | null; tmdb_id?: number; reason: string };
type Options = { preferences?: RecommendationPreferences; live?: boolean; apiKey?: string; model?: string; tmdbKey?: string; openaiFetch?: typeof fetch; tmdbFetch?: typeof fetch;
  sleep?: (ms: number) => Promise<unknown>; now?: () => number; openaiTimeoutMs?: number; tmdbTimeoutMs?: number };
export function parseCandidateProposals(body: unknown): Proposal[] {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || !Object.hasOwn(body, 'candidates')) throw new Error('Invalid OpenAI candidate response fields.');
  const rows = (body as { candidates: unknown }).candidates;
  if (!Array.isArray(rows) || rows.length > CANDIDATE_LIMITS.llm) throw new Error('Invalid OpenAI candidate list size.');
  return rows.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid OpenAI candidate.');
    const row = value as Record<string, unknown>;
    if (Object.keys(row).length !== 2 || typeof row.title !== 'string' || !row.title.trim() || [...row.title].length > 300 ||
      !Number.isSafeInteger(row.year) || (row.year as number) < 1 || (row.year as number) > 9999) throw new Error('Invalid OpenAI candidate title/year.');
    return { title: row.title.trim(), year: row.year as number };
  });
}
export async function generateCandidates(db: Database.Database, userId: UserId, options: Options = {}) {
  personalScope(db, userId);
  const preferences = options.preferences === undefined ? undefined : parsePreferences(options.preferences);
  const context = buildCandidateContext(db, userId, undefined, preferences);
  const evaluation = stageEvaluation(context.input, CANDIDATE_FORMAT, context.summary, preferences);
  const readiness = { openai_key: Boolean(options.apiKey?.trim()), openai_model: Boolean(options.model?.trim()), tmdb_key: Boolean(options.tmdbKey?.trim()) };
  if (!options.live) return { user_id: userId, mode: 'dry-run' as const, ...context.summary, readiness, seeds: context.seeds, warnings: context.warnings };
  requireOpenAIConfig(options.apiKey, options.model);
  const tmdb = createTmdbClient(options.tmdbKey, { fetch: options.tmdbFetch, sleep: options.sleep, now: options.now,
    timeoutMs: options.tmdbTimeoutMs, maxRequests: CANDIDATE_LIMITS.tmdb_requests });
  const diagnostics: Diagnostic[] = [], errors: string[] = [], warnings = [...context.warnings];
  const accepted = new Map<number, MovieCandidate>();
  let usage: Usage | null = null, returnedModel: string | null = null, detailsChecked = 0, llmCount = 0, tmdbCount = 0;
  const finish = () => {
    const history = readCandidateHistory(db, userId);
    for (const [id, movie] of accepted) {
      const reason = blockedReason({ id, title: movie.title, original_title: movie.original_title, year: movie.year }, history) || preferenceExclusion(movie, parsePreferences(preferences));
      if (reason) { accepted.delete(id); diagnostics.push({ source: movie.source === 'tmdb' ? 'tmdb' : 'llm', title: movie.title, year: movie.year, tmdb_id: id, reason }); }
    }
    const { candidates, selection } = selectVerifiedCandidates([...accepted.values()], history);
    const recent = diagnostics.filter(row => row.reason === 'recently_recommended').length;
    if (recent) warnings.push(`${recent} recently recommended candidates excluded for ${RECOMMENDATION_REPEAT_DAYS} days. No automatic cooldown relaxation.`);
    if (accepted.size > CANDIDATE_LIMITS.results) warnings.push('Verified candidate pool selected locally by metadata support and diversity, capped at 40; no final ranking was performed.');
    return { user_id: userId, ...(preferences ? { preferences } : {}), mode: 'live' as const, status: errors.length ? (candidates.length ? 'partial' : 'error') : 'ok', candidates,
      rejected_by_reason: diagnostics.reduce<Record<string, number>>((counts, item) => { counts[item.reason] = (counts[item.reason] ?? 0) + 1; return counts; }, {}),
      diagnostics, errors, warnings, evaluation, selection, seed_selection: { rotation: context.summary.seed_rotation, seeds: context.seeds }, statistics: { openai_requests: 1, tmdb_requests: tmdb.stats.requests,
        tmdb_failed_requests: tmdb.stats.failedRequests, details_checked: detailsChecked, accepted: candidates.length, verified_before_cap: accepted.size, cap_excluded: selection.excluded_count, sources_before_cap: selection.before, sources_after_cap: selection.after,
        llm_proposals: llmCount, tmdb_proposals: tmdbCount, tmdb_seeds: context.seeds.length,
        model: returnedModel, usage }, context: context.summary };
  };
  let proposals: Proposal[];
  try {
    const result = await requestStructuredOutput({ input: context.input, format: CANDIDATE_FORMAT, maxInputBytes: CANDIDATE_LIMITS.input_bytes },
      { apiKey: options.apiKey, model: options.model, fetch: options.openaiFetch, timeoutMs: options.openaiTimeoutMs });
    usage = result.usage; returnedModel = result.model; evaluation.usage = usage; evaluation.model = returnedModel;
    proposals = parseCandidateProposals(result.body);
    llmCount = proposals.length;
  } catch (error) {
    errors.push(error instanceof Error ? error.message : 'OpenAI candidate generation failed.');
    return finish(); // Never substitute a TMDB-only result for a failed OpenAI call.
  }
  let stopped = false;
  const technicalError = (error: unknown) => {
    errors.push(error instanceof TmdbError ? error.message : 'TMDB candidate verification failed.');
    if (error instanceof TmdbError && error.stop) stopped = true;
  };
  const lists: Candidate[][] = [];
  for (const seed of context.seeds) {
    try { lists.push(await tmdb.recommendations(seed.tmdb_id)); }
    catch (error) { technicalError(error); }
    if (stopped) break;
  }
  if (!context.seeds.length) warnings.push('No eligible high-rated movie seeds for the supplementary TMDB source.');
  const supplementary = new Map<number, Candidate>();
  for (let index = 0; index < 20 && supplementary.size < CANDIDATE_LIMITS.tmdb; index++) {
    for (const list of lists) {
      const row = list[index];
      if (row && !supplementary.has(row.id)) supplementary.set(row.id, row);
      if (supplementary.size === CANDIDATE_LIMITS.tmdb) break;
    }
  }
  tmdbCount = supplementary.size;
  const searches = new Map<string, Awaited<ReturnType<typeof tmdb.search>>>();
  const detailsCache = new Map<number, Details | TmdbError>();
  const diagnose = (source: Source, movie: { title: string; year: number | null; id?: number }, reason: string) => diagnostics.push({ source, title: movie.title, year: movie.year, ...(movie.id ? { tmdb_id: movie.id } : {}), reason });
  const verify = async (identity: Candidate, source: Source) => {
    const blocked = blockedReason(identity, context.history);
    if (blocked) { diagnose(source, identity, blocked); return; }
    const already = accepted.get(identity.id);
    if (already) {
      if (!matches({ title: identity.title, release_year: identity.year ?? already.year },
        { id: already.tmdb_id, title: already.title, original_title: already.original_title, year: already.year })) {
        diagnose(source, identity, 'details_identity_mismatch'); return;
      }
      if (already.source !== source) already.source = 'both';
      diagnose(source, identity, 'duplicate'); return;
    }
    let detail = detailsCache.get(identity.id);
    if (!detail) {
      if (detailsChecked >= CANDIDATE_LIMITS.details) { diagnose(source, identity, 'details_limit'); return; }
      detailsChecked++;
      try { detail = await tmdb.details(identity.id); detailsCache.set(identity.id, detail); }
      catch (error) {
        technicalError(error);
        detailsCache.set(identity.id, error instanceof TmdbError ? error : new TmdbError('TMDB details failed.'));
        diagnose(source, identity, error instanceof Error && error.message.includes('non-movie') ? 'not_movie' : 'details_error'); return;
      }
    }
    if (detail instanceof TmdbError) { diagnose(source, identity, 'details_error'); return; }
    if (detail.id !== identity.id || !matches({ title: identity.title, release_year: identity.year ?? detail.year }, detail)) { diagnose(source, identity, 'details_identity_mismatch'); return; }
    const detailBlocked = blockedReason(detail, context.history);
    if (detailBlocked) { diagnose(source, identity, detailBlocked); return; }
    if (detail.runtime === null) { diagnose(source, identity, 'unknown_runtime'); return; }
    if (detail.runtime < 60) { diagnose(source, identity, 'short_film'); return; }
    if (detail.year === null || !detail.overview || !detail.genres?.length) { diagnose(source, identity, 'insufficient_metadata'); return; }
    accepted.set(detail.id, { tmdb_id: detail.id, media_type: 'movie', title: detail.title, original_title: detail.original_title, year: detail.year,
      overview: detail.overview, genres: detail.genres, runtime: detail.runtime, directors: detail.directors,
      vote_count: detail.vote_count, popularity: detail.popularity, source,
      ...(detail.poster_path ? { poster_path: detail.poster_path } : {}), ...(detail.backdrop_path ? { backdrop_path: detail.backdrop_path } : {}) });
  };
  const seen = new Set<string>();
  for (const proposal of proposals) {
    if (stopped) break;
    const key = `${normalizeTitle(proposal.title)}:${proposal.year}`;
    if (seen.has(key)) { diagnose('llm', proposal, 'duplicate'); continue; }
    seen.add(key);
    try {
      let search = searches.get(key);
      if (!search) { search = await tmdb.search(proposal.title, proposal.year); searches.set(key, search); }
      if (!search.complete) { diagnose('llm', proposal, 'incomplete_search'); continue; }
      const candidates = search.candidates.filter(row => matches({ title: proposal.title, release_year: proposal.year }, row));
      if (candidates.length !== 1) {
        const titleFound = search.candidates.some(row => [row.title, row.original_title].some(title => title !== null && normalizeTitle(title) === normalizeTitle(proposal.title)));
        diagnose('llm', proposal, candidates.length ? 'ambiguous' : titleFound ? 'year_mismatch' : 'not_found'); continue;
      }
      await verify(candidates[0], 'llm');
    } catch (error) { technicalError(error); diagnose('llm', proposal, 'search_error'); }
  }
  for (const identity of supplementary.values()) { if (stopped) break; await verify(identity, 'tmdb'); }
  return finish();
}
