import { assertReportOwner } from './profiles';
import { personalScope, type UserId } from './profiles';
import { parsePreferences, preferenceExclusion, samePreferences, type RecommendationPreferences } from './recommendation-preferences';
import { stageEvaluation, type StageEvaluation } from './evaluation-metadata';
import type Database from 'better-sqlite3';
import { blockedReason, readCandidateHistory } from './candidate-context';
import { buildRankingContext } from './recommendation-context';
import { parseCandidateReport, validateRanking, type RankingDiagnostic } from './recommendation-schema';
import { requestStructuredOutput, requireOpenAIConfig, type OpenAIOptions, type Usage } from './openai';
import type { MovieCandidate } from './candidates';
import type { Evidence } from './taste-schema';
import { randomUUID } from 'node:crypto';
import { RECOMMENDATION_REPEAT_DAYS } from './recommendation-policy';
import { backupForRecommendationWrite, recordRecommendations, type SaveReport } from './recommendation-memory';

export type RankedRecommendation = { tmdb_id: number; title: string; year: number; why_fit: string; possible_mismatch: string;
  evidence: (Evidence & { title: string; year: number | null })[] };
function exclusion(movie: MovieCandidate, history: ReturnType<typeof readCandidateHistory>) {
  if (movie.media_type !== 'movie') return 'not_movie';
  if (!Number.isSafeInteger(movie.runtime) || movie.runtime < 60) return 'invalid_runtime';
  return blockedReason({ id: movie.tmdb_id, title: movie.title, original_title: movie.original_title, year: movie.year }, history);
}
export async function rankRecommendations(db: Database.Database, userId: UserId, candidateReport: unknown, options: OpenAIOptions & { live?: boolean; save?: boolean; backupPath?: string; preferences?: RecommendationPreferences } = {}) {
  personalScope(db, userId);
  assertReportOwner(candidateReport,userId);
  if (options.save && !options.live) throw new Error('--save requires explicit --live and cannot be used with dry-run.');
  const candidatePreferences = candidateReport && typeof candidateReport === 'object' && 'preferences' in candidateReport ? parsePreferences(candidateReport.preferences) : undefined;
  const preferences = options.preferences === undefined ? candidatePreferences : parsePreferences(options.preferences);
  if (candidatePreferences && preferences && !samePreferences(candidatePreferences, preferences)) throw new Error('Preference snapshots disagree.');
  const parsed = parseCandidateReport(candidateReport), diagnostics: RankingDiagnostic[] = [...parsed.diagnostics];
  const history = readCandidateHistory(db, userId);
  const candidates = parsed.candidates.filter(movie => {
    const reason = exclusion(movie, history) || preferenceExclusion(movie, parsePreferences(preferences));
    if (reason) diagnostics.push({ stage: 'input', tmdb_id: movie.tmdb_id, reason });
    return !reason;
  });
  const result = { user_id: userId, ...(preferences ? { preferences } : {}), evaluation: null as StageEvaluation | null, mode: options.live ? 'live' : 'dry-run', status: 'ok' as 'ok' | 'error', recommendations: [] as RankedRecommendation[], diagnostics,
    errors: [] as string[], warnings: [...parsed.warnings], context: null as ReturnType<typeof buildRankingContext>['summary'] | null,
    input_count: parsed.input_count, eligible_count: candidates.length, result_id: null as string | null, generated_at: null as string | null, save: null as SaveReport | null,
    readiness: { openai_key: Boolean(options.apiKey?.trim()), openai_model: Boolean(options.model?.trim()) },
    statistics: { openai_requests: 0, tmdb_requests: 0, model: null as string | null, usage: null as Usage | null } };
  const recent = diagnostics.filter(row => row.reason === 'recently_recommended').length;
  if (recent) result.warnings.push(`${recent} recently recommended candidates excluded for ${RECOMMENDATION_REPEAT_DAYS} days. A smaller result is allowed; the cooldown is not relaxed.`);
  if (!candidates.length) { result.status = 'error'; result.errors.push('No eligible candidates remain; no API call made.'); return result; }
  const context = buildRankingContext(db, userId, candidates, undefined, preferences);
  result.context = context.summary; result.warnings.push(...context.warnings);
  if (context.summary.profile_refresh.refresh_recommended) result.warnings.push(`${context.summary.profile_refresh.notice} ${context.summary.profile_refresh.refresh_command}`);
  if (!options.live) return result;
  requireOpenAIConfig(options.apiKey, options.model);
  result.evaluation = stageEvaluation(context.input, context.format, context.summary, preferences);
  if (options.save) await backupForRecommendationWrite(db, options.backupPath);
  try {
    result.statistics.openai_requests = 1;
    const output = await requestStructuredOutput({ input: context.input, format: context.format, maxInputBytes: context.summary.max_input_bytes }, options);
    result.statistics.model = output.model; result.statistics.usage = output.usage;
    result.evaluation.model = output.model; result.evaluation.usage = output.usage;
    const checked = validateRanking(output.body, candidates, context.snapshot);
    diagnostics.push(...checked.diagnostics);
    // One new SQL snapshot supplies both exclusions and current evidence at return time.
    const current = readCandidateHistory(db, userId), currentById = new Map(current.map(row => [row.id, row]));
    const allowed = new Map(candidates.map(row => [row.tmdb_id, row]));
    for (const recommendation of checked.recommendations) {
      const movie = allowed.get(recommendation.tmdb_id)!;
      let reason = exclusion(movie, current) || preferenceExclusion(movie, parsePreferences(preferences));
      if (!reason && recommendation.evidence.some(ref => currentById.get(ref.movie_id)?.rating_100 !== ref.rating_100)) reason = 'evidence_changed';
      if (reason) { diagnostics.push({ stage: 'final', tmdb_id: movie.tmdb_id, reason }); continue; }
      result.recommendations.push({ ...recommendation, title: movie.title, year: movie.year,
        evidence: recommendation.evidence.map(ref => ({ ...ref, title: currentById.get(ref.movie_id)!.title, year: currentById.get(ref.movie_id)!.release_year })) });
    }
    if (!result.recommendations.length) { result.status = 'error'; result.errors.push('No valid recommendations remain after server validation. No fallback or automatic retry was made.'); }
  } catch (error) {
    result.status = 'error'; result.recommendations = [];
    result.errors.push(error instanceof Error ? error.message : 'Recommendation ranking failed; no automatic retry was made.');
  }
  if (result.status === 'ok' && result.recommendations.length) {
    result.result_id = randomUUID(); result.generated_at = new Date().toISOString();
    if (options.save) {
      try {
        result.save = recordRecommendations(db, userId, candidateReport, { result }, { dryRun: false });
        result.recommendations = result.recommendations.filter(row => !result.save!.skipped.some(skip => skip.tmdb_id === row.tmdb_id));
        if (!result.recommendations.length) { result.status = 'error'; result.errors.push('All recommendations became ineligible before saving; no new AI request was made.'); }
      } catch (error) {
        result.save = { status: 'error', result_id: result.result_id, saved_count: 0, already_saved_count: 0, would_save_count: 0, skipped: [],
          error: error instanceof Error ? error.message : 'SQLite save failed. Retry the saved result without another AI request.' };
      }
    }
  }
  return result;
}
