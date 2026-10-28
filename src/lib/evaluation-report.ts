import type Database from 'better-sqlite3';
import { evaluationMetadata } from './evaluation-storage';
import { runStore } from './recommendation-runs';

export type EvaluationPeriod = { from?: string; to?: string };
export function evaluationPeriod(period: EvaluationPeriod) {
  const day = (s: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !Number.isFinite(Date.parse(s)) || new Date(s).toISOString().slice(0, 10) !== s) throw Error('Use valid YYYY-MM-DD UTC dates.');
    return Date.parse(s);
  };
  const from = period.from !== undefined ? day(period.from) : -Infinity, to = period.to !== undefined ? day(period.to) + 86400000 : Infinity;
  if (from >= to) throw Error('from must not be later than to.');
  return { from, to };
}
type Metadata = ReturnType<typeof evaluationMetadata>;
type Row = { id: number; result_id: string | null; recommended_at: string; rating_100: number | null; watched: number | null;
  first_rating_recorded_at: string | null; watch_recorded_at: string | null; outcome_id: number | null; saved_at: string | null; metadata_json: string | null };
const tokenFields = ['input_tokens', 'output_tokens', 'total_tokens', 'cached_input_tokens', 'reasoning_tokens'] as const;
type TokenField = typeof tokenFields[number];
function field(stage: Metadata['candidates'], key: TokenField): number | null {
  const u = stage?.usage;
  if (key === 'cached_input_tokens') return u?.input_tokens_details?.cached_tokens ?? null;
  if (key === 'reasoning_tokens') return u?.output_tokens_details?.reasoning_tokens ?? null;
  if (key === 'total_tokens') return u?.total_tokens ?? (u?.input_tokens != null && u?.output_tokens != null ? u.input_tokens + u.output_tokens : null);
  return u?.[key] ?? null;
}
function summary(batches: { rows: Row[]; metadata: Metadata }[]) {
  const rows = batches.flatMap(b => b.rows);
  const scores = rows.filter(r => r.outcome_id === r.id && r.watch_recorded_at && r.first_rating_recorded_at && r.watched === 1 && r.rating_100 !== null)
    .map(r => r.rating_100!).sort((a, b) => a - b);
  const high = scores.filter(n => n >= 80).length, middle = scores.filter(n => n >= 61 && n < 80).length;
  const tokens = Object.fromEntries(tokenFields.map(key => {
    const values = batches.map(b => [field(b.metadata.candidates, key), field(b.metadata.ranking, key)]);
    const known = values.flat().filter((v): v is number => v !== null);
    const complete = values.filter(v => v.every(n => n !== null)).map(v => v.reduce<number>((a, b) => a + b!, 0));
    return [key, { known_tokens: known.length ? known.reduce((a, b) => a + b, 0) : null, known_stages: known.length, total_stages: batches.length * 2,
      complete_batches: complete.length, mean_per_complete_batch: complete.length ? complete.reduce((a, b) => a + b, 0) / complete.length : null }];
  }));
  const stages = batches.flatMap(b => [b.metadata.candidates, b.metadata.ranking]);
  return { batches: batches.length, recommendations: rows.length, observed: scores.length, unobserved: rows.length - scores.length,
    coverage: { numerator: scores.length, denominator: rows.length, percent: rows.length ? scores.length / rows.length * 100 : null },
    high, middle, low: scores.length - high - middle, hit_rate_80: { numerator: high, denominator: scores.length, percent: scores.length ? high / scores.length * 100 : null },
    mean_rating: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
    median_rating: scores.length ? (scores[Math.floor((scores.length - 1) / 2)] + scores[Math.floor(scores.length / 2)]) / 2 : null,
    status: scores.length < 20 ? 'insufficient_data' : 'observational_data', tokens,
    models: [...new Set(stages.flatMap(s => s?.model ? [s.model] : []))].sort(),
    profile_versions: [...new Set(stages.flatMap(s => s?.profile_version ? [s.profile_version] : []))].sort((a, b) => a - b) };
}
export function evaluationReport(db: Database.Database, period: EvaluationPeriod = {}) {
  const bounds = evaluationPeriod(period), version = db.pragma('user_version', { simple: true }) as number;
  if (version < 3 || version > 7) throw Error('Evaluation report supports schema 3–7.');
  const warnings = ['Наблюдательное сравнение: разные периоды, история вкуса и выбор просмотренных фильмов не позволяют установить причинный эффект.',
    'Порог 20 — только предупреждение о малой выборке, не доказательство статистической надёжности.'];
  const rows = db.prepare(`SELECT r.id,${version >= 4 ? 'r.result_id' : 'NULL'} result_id,r.recommended_at,u.rating_100,u.watched,
    ${version >= 7 ? 'o.recommendation_id outcome_id,o.watch_recorded_at,o.first_rating_recorded_at,e.saved_at,e.metadata_json' : 'NULL outcome_id,NULL watch_recorded_at,NULL first_rating_recorded_at,NULL saved_at,NULL metadata_json'}
    FROM recommendations r LEFT JOIN user_movies u ON u.movie_id=r.movie_id
    ${version >= 7 ? 'LEFT JOIN recommendation_outcomes o ON o.movie_id=r.movie_id LEFT JOIN recommendation_evaluation e ON e.result_id=r.result_id' : ''}
    ORDER BY r.id`).all() as Row[];
  const journals = new Map<string, Metadata[]>();
  try {
    for (const run of runStore(db.name).list()) {
      if (!run.ranking?.result_id || run.ranking.status !== 'ok') continue;
      const id = run.ranking.result_id;
      // Old journals can recover factual usage only, not a current version.
      const metadata = evaluationMetadata({ statistics: run.candidates?.mode === 'live' ? run.candidates.statistics : undefined, context: run.candidates?.mode === 'live' ? run.candidates.context : undefined },
        { statistics: run.ranking.statistics, context: run.ranking.context });
      journals.set(id, [...(journals.get(id) ?? []), metadata]);
    }
  } catch { warnings.push('Журнал недоступен или повреждён; исторический usage из него не восстановлен.'); journals.clear(); }
  let manual = 0, unidentified = 0, legacyDates = 0, invalidDates = 0;
  const batches = new Map<string, { rows: Row[]; metadata: Metadata }>();
  for (const row of rows) {
    const timestamp = Date.parse(row.saved_at ?? row.recommended_at);
    if (!Number.isFinite(timestamp)) { invalidDates++; continue; }
    if (timestamp < bounds.from || timestamp >= bounds.to) continue;
    if (!row.saved_at) legacyDates++;
    if (!row.result_id) { unidentified++; continue; }
    if (row.result_id.startsWith('manual:')) { manual++; continue; }
    let metadata = evaluationMetadata(null, null);
    if (row.metadata_json) metadata = JSON.parse(row.metadata_json) as Metadata;
    else if (journals.get(row.result_id)?.length === 1) metadata = journals.get(row.result_id)![0];
    if (!batches.has(row.result_id)) batches.set(row.result_id, { rows: [], metadata });
    batches.get(row.result_id)!.rows.push(row);
  }
  const values = [...batches.values()], algorithms = [...new Set(values.map(b => b.metadata.algorithm_id))].sort();
  const total = summary(values);
  if (total.status === 'insufficient_data') warnings.unshift('Недостаточно наблюдаемых результатов для оценки качества.');
  if (legacyDates) warnings.push('Для исторических записей используется recommended_at: фактическое время сохранения неизвестно.');
  if (invalidDates) warnings.push('Записи с недостоверной датой исключены из периода.');
  return { report_version: 1, period: { ...period, timezone: 'UTC', cohort: 'saved_batches', rating_state: 'current' },
    attribution: 'last_saved_ai_recommendation_before_recorded_watch', total,
    algorithms: algorithms.map(algorithm_id => ({ algorithm_id, ...summary(values.filter(b => b.metadata.algorithm_id === algorithm_id)) })),
    manual_recommendations: manual, unidentified_recommendations: unidentified, legacy_date_recommendations: legacyDates,
    warnings };
}
export function formatEvaluationReport(report: ReturnType<typeof evaluationReport>) {
  const lines = ['recommendMe Evaluation', `Cohort: saved batches, UTC ${report.period.from ?? 'all'} … ${report.period.to ?? 'all'}; ratings: current`,
    'Attribution: last saved AI recommendation before recorded watch', ''];
  for (const group of [{ algorithm_id: 'All algorithms', ...report.total }, ...report.algorithms]) {
    const rate = group.hit_rate_80;
    lines.push(`Algorithm: ${group.algorithm_id}`, `Saved batches: ${group.batches}; recommendations: ${group.recommendations}`,
      `Observed: ${group.observed}/${group.recommendations}; unobserved: ${group.unobserved}`,
      `Hit rate 80+: ${rate.numerator}/${rate.denominator} (${rate.percent === null ? 'unknown' : rate.percent.toFixed(1) + '%'})`,
      `Mean: ${group.mean_rating ?? 'unknown'}; median: ${group.median_rating ?? 'unknown'}`,
      `80–100: ${group.high}; 61–79: ${group.middle}; 0–60: ${group.low}`, `Status: ${group.status}`,
      `Models: ${group.models.join(', ') || 'unknown'}; profiles: ${group.profile_versions.join(', ') || 'unknown'}`);
    for (const [key, token] of Object.entries(group.tokens)) lines.push(`${key}: ${token.known_tokens ?? 'unknown'} known; stages ${token.known_stages}/${token.total_stages}; mean per complete batch ${token.mean_per_complete_batch ?? 'unknown'} (${token.complete_batches} batches)`);
    lines.push('');
  }
  lines.push(`Manual: ${report.manual_recommendations}; unidentified: ${report.unidentified_recommendations}`, ...report.warnings);
  return lines.join('\n');
}
