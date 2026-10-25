import type { MovieCandidate } from './candidates';
import type { Evidence } from './taste-schema';

export const RANKING_LIMITS = { candidates: 40, recommendations: 5, evidence: 6, why_fit: 1000, possible_mismatch: 600, input_bytes: 120000 } as const;
export type RankingDiagnostic = { stage: 'input' | 'output' | 'final'; index?: number; tmdb_id?: number; reason: string };
export type Recommendation = { tmdb_id: number; why_fit: string; possible_mismatch: string; evidence: Evidence[] };
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown, minimum = 1, maximum = Number.MAX_SAFE_INTEGER): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
const text = (value: unknown, maximum = Infinity): value is string => typeof value === 'string' && Boolean(value.trim()) && [...value].length <= maximum;
function people(value: unknown): value is { id: number; name: string }[] {
  return Array.isArray(value) && value.every(row => object(row) && integer(row.id) && text(row.name));
}
export function parseCandidateReport(value: unknown) {
  if (!object(value) || value.mode !== 'live' || typeof value.status !== 'string' || !['ok', 'partial'].includes(value.status) || !Array.isArray(value.candidates)) {
    throw new Error('Input must be a saved live candidates:generate JSON report with status ok or partial.');
  }
  if (value.candidates.length > RANKING_LIMITS.candidates) throw new Error('Ranking accepts at most 40 input candidates; no API call made.');
  const candidates: MovieCandidate[] = [], diagnostics: RankingDiagnostic[] = [], seen = new Set<number>();
  for (const [index, row] of value.candidates.entries()) {
    if (object(row) && integer(row.tmdb_id)) {
      if (seen.has(row.tmdb_id)) throw new Error('Duplicate input TMDB ID; resolve the candidate file before ranking.');
      seen.add(row.tmdb_id);
    }
    if (object(row) && !Object.hasOwn(row, 'media_type')) throw new Error('Candidate input is missing media_type. Save a new report from candidates:generate; movie type cannot be inferred offline.');
    const reject = (reason: string) => diagnostics.push({ stage: 'input', index: index + 1, ...(object(row) && integer(row.tmdb_id) ? { tmdb_id: row.tmdb_id } : {}), reason });
    if (!object(row)) { reject('invalid_candidate_object'); continue; }
    if (row.media_type !== 'movie') { reject('not_movie'); continue; }
    if (row.runtime === null || row.runtime === undefined) { reject('unknown_runtime'); continue; }
    if (typeof row.runtime === 'number' && row.runtime < 60) { reject('short_film'); continue; }
    if (!integer(row.tmdb_id) || !text(row.title) || !integer(row.year, 1, 9999) || !integer(row.runtime, 60) ||
      !text(row.overview) || !people(row.genres) || !row.genres.length || !Object.hasOwn(row, 'original_title') ||
      (row.original_title !== null && !text(row.original_title)) || (row.directors !== null && !people(row.directors)) ||
      (row.vote_count !== null && !integer(row.vote_count, 0)) || (row.popularity !== null && (typeof row.popularity !== 'number' || !Number.isFinite(row.popularity) || row.popularity < 0)) ||
      typeof row.source !== 'string' || !['llm', 'tmdb', 'both'].includes(row.source)) { reject('invalid_candidate_metadata'); continue; }
    candidates.push({ tmdb_id: row.tmdb_id, media_type: 'movie', title: row.title.trim(), original_title: row.original_title === null ? null : row.original_title.trim(),
      year: row.year, overview: row.overview.trim(), runtime: row.runtime, genres: row.genres.map(({ id, name }) => ({ id, name: name.trim() })),
      directors: row.directors === null ? null : row.directors.map(({ id, name }) => ({ id, name: name.trim() })), vote_count: row.vote_count as number | null,
      popularity: row.popularity as number | null, source: row.source as MovieCandidate['source'] });
  }
  return { candidates, diagnostics, input_count: value.candidates.length,
    warnings: value.status === 'partial' ? ['Input came from a partial candidate generation; only its verified candidates are considered.'] : [] };
}
export function rankingFormat(ids: number[]) {
  return { type: 'json_schema', name: 'personal_movie_ranking', strict: true, schema: {
    type: 'object', additionalProperties: false, required: ['recommendations'], properties: { recommendations: {
      type: 'array', minItems: 1, maxItems: RANKING_LIMITS.recommendations, items: {
        type: 'object', additionalProperties: false, required: ['tmdb_id', 'why_fit', 'possible_mismatch', 'evidence'], properties: {
          tmdb_id: { type: 'integer', enum: ids }, why_fit: { type: 'string', minLength: 1, maxLength: RANKING_LIMITS.why_fit },
          possible_mismatch: { type: 'string', minLength: 1, maxLength: RANKING_LIMITS.possible_mismatch }, evidence: {
            type: 'array', minItems: 1, maxItems: RANKING_LIMITS.evidence, items: { type: 'object', additionalProperties: false,
              required: ['movie_id', 'rating_100'], properties: { movie_id: { type: 'integer', minimum: 1 }, rating_100: { type: 'integer', minimum: 0, maximum: 100 } } },
          },
        },
      },
    } },
  } };
}
export function validateRanking(value: unknown, candidates: MovieCandidate[], snapshot: Evidence[]) {
  if (!object(value) || Object.keys(value).length !== 1 || !Array.isArray(value.recommendations) || !value.recommendations.length || value.recommendations.length > RANKING_LIMITS.recommendations) {
    throw new Error('Invalid ranking response: expected one to five recommendations.');
  }
  const allowed = new Set(candidates.map(row => row.tmdb_id)), ratings = new Map(snapshot.map(row => [row.movie_id, row.rating_100]));
  const recommendations: Recommendation[] = [], diagnostics: RankingDiagnostic[] = [], seen = new Set<number>();
  for (const [index, row] of value.recommendations.entries()) {
    const reject = (reason: string) => diagnostics.push({ stage: 'output', index: index + 1, ...(object(row) && integer(row.tmdb_id) ? { tmdb_id: row.tmdb_id } : {}), reason });
    if (!object(row) || Object.keys(row).length !== 4 || !['tmdb_id', 'why_fit', 'possible_mismatch', 'evidence'].every(key => Object.hasOwn(row, key)) || !integer(row.tmdb_id)) { reject('invalid_recommendation_fields'); continue; }
    if (!allowed.has(row.tmdb_id)) { reject('outside_candidate_set'); continue; }
    if (seen.has(row.tmdb_id)) { reject('duplicate_recommendation'); continue; }
    if (!text(row.why_fit, RANKING_LIMITS.why_fit) || !text(row.possible_mismatch, RANKING_LIMITS.possible_mismatch)) { reject('invalid_explanation'); continue; }
    if (!Array.isArray(row.evidence) || !row.evidence.length || row.evidence.length > RANKING_LIMITS.evidence) { reject('invalid_evidence'); continue; }
    const evidence: Evidence[] = [], evidenceIds = new Set<number>();
    for (const ref of row.evidence) {
      if (!object(ref) || Object.keys(ref).length !== 2 || !integer(ref.movie_id) || !integer(ref.rating_100, 0, 100) || ratings.get(ref.movie_id) !== ref.rating_100 || evidenceIds.has(ref.movie_id)) break;
      evidence.push({ movie_id: ref.movie_id, rating_100: ref.rating_100 }); evidenceIds.add(ref.movie_id);
    }
    if (evidence.length !== row.evidence.length) { reject('invalid_evidence'); continue; }
    seen.add(row.tmdb_id);
    recommendations.push({ tmdb_id: row.tmdb_id, why_fit: row.why_fit.trim(), possible_mismatch: row.possible_mismatch.trim(), evidence });
  }
  return { recommendations, diagnostics };
}
