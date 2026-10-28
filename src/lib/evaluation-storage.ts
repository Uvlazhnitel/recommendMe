import { reportPreferences } from './recommendation-preferences';
import type Database from 'better-sqlite3';
import { parseUsage } from './openai';

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
// Persist only compact, validated metadata from reports. Never copy prompts/library.
function stage(value: unknown) {
  if (!object(value)) return null;
  const text = (key: string, pattern: RegExp) => typeof value[key] === 'string' && pattern.test(value[key] as string) ? value[key] as string : 'unknown';
  const version = (key: string) => Number.isSafeInteger(value[key]) && Number(value[key]) > 0 ? Number(value[key]) : null;
  return { algorithm_id: text('algorithm_id', /^[a-zA-Z0-9._-]{1,100}$/), candidate_selection: text('candidate_selection', /^[a-zA-Z0-9._-]{1,100}$/),
    git_sha: text('git_sha', /^[a-f0-9]{40}$/), profile_version: version('profile_version'), profile_prompt_version: version('profile_prompt_version'),
    profile_schema_version: version('profile_schema_version'), prompt_sha256: text('prompt_sha256', /^[a-f0-9]{64}$/), format_sha256: text('format_sha256', /^[a-f0-9]{64}$/),
    model: typeof value.model === 'string' && value.model.trim() && value.model.length <= 200 ? value.model : null, usage: parseUsage(value.usage) };
}
export function evaluationMetadata(candidateReport: unknown, result: unknown) {
  const from = (report: unknown) => {
    if (!object(report)) return null;
    const parsed = stage(report.evaluation);
    if (parsed) return parsed;
    // Legacy usage is factual, but never infer an algorithm/release from it.
    const stats = object(report.statistics) ? report.statistics : {};
    const context = object(report.context) ? report.context : {};
    return { algorithm_id: 'unknown', candidate_selection: 'unknown', git_sha: 'unknown', profile_version: Number.isSafeInteger(context.profile_version) ? Number(context.profile_version) : null,
      profile_prompt_version: null, profile_schema_version: null, prompt_sha256: 'unknown', format_sha256: 'unknown',
      model: typeof stats.model === 'string' ? stats.model.slice(0, 200) : null, usage: parseUsage(stats.usage) };
  };
  const candidates = from(candidateReport), ranking = from(result);
  const sum = (a: number | null | undefined, b: number | null | undefined) => a != null && b != null ? a + b : null;
  const total = (u: ReturnType<typeof parseUsage>) => u?.total_tokens ?? sum(u?.input_tokens, u?.output_tokens);
  const a = candidates?.usage, b = ranking?.usage;
  const preferences = reportPreferences(candidateReport, result);
  return { ...(preferences ? { preferences } : {}), algorithm_id: candidates && ranking && candidates.algorithm_id === ranking.algorithm_id ? ranking.algorithm_id : 'unknown', candidates, ranking,
    totals: { input_tokens: sum(a?.input_tokens, b?.input_tokens), output_tokens: sum(a?.output_tokens, b?.output_tokens),
      total_tokens: sum(total(a ?? null), total(b ?? null)), cached_input_tokens: sum(a?.input_tokens_details?.cached_tokens, b?.input_tokens_details?.cached_tokens),
      reasoning_tokens: sum(a?.output_tokens_details?.reasoning_tokens, b?.output_tokens_details?.reasoning_tokens) } };
}
export function saveEvaluation(db: Database.Database, resultId: string, candidateReport: unknown, result: unknown) {
  db.prepare('INSERT INTO recommendation_evaluation(result_id,metadata_json) VALUES(?,?)').run(resultId, JSON.stringify(evaluationMetadata(candidateReport, result)));
}

/** Called only inside the existing write transaction, with the pre-write state. */
export function observeOutcome(db: Database.Database, movieId: number, before: { watched: number; rating_100: number | null } | undefined, rating: number | null) {
  if ((before?.watched ?? 0) === 0 && (before?.rating_100 ?? null) === null) {
    const row = db.prepare(`SELECT id FROM recommendations WHERE movie_id=? AND result_id IS NOT NULL AND result_id NOT LIKE 'manual:%'
      AND length(trim(why_fit))>0 AND length(trim(possible_mismatch))>0 ORDER BY id DESC LIMIT 1`).get(movieId) as { id: number } | undefined;
    if (row) db.prepare('INSERT OR IGNORE INTO recommendation_outcomes(movie_id,recommendation_id) VALUES(?,?)').run(movieId, row.id);
  }
  if ((before?.rating_100 ?? null) === null && rating !== null) {
    db.prepare(`UPDATE recommendation_outcomes SET first_rating_recorded_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE movie_id=? AND first_rating_recorded_at IS NULL`).run(movieId);
  }
}
