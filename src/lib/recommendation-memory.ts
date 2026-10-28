import { saveEvaluation } from './evaluation-storage';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { blockedReason, readCandidateHistory } from './candidate-context';
import { parseCandidateReport, validateRanking } from './recommendation-schema';
import { migrateDatabase } from './migrations';
import type { Evidence } from './taste-schema';

export type RecordRequest = { tmdbIds: number[]; result?: never } | { result: unknown; tmdbIds?: never };
export type SaveReport = { status: 'preview' | 'saved' | 'already_saved' | 'skipped' | 'error'; result_id: string | null;
  saved_count: number; already_saved_count: number; would_save_count: number; skipped: { tmdb_id: number; reason: string }[]; error?: string };
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const positiveId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
export async function backupForRecommendationWrite(db: Database.Database, backupPath?: string) {
  if (db.readonly || db.pragma('query_only', { simple: true })) throw new Error('Recommendation writes require a writable SQLite connection.');
  if (db.inTransaction) throw new Error('Create the backup outside a transaction.');
  if (!backupPath) { const folder = resolve(dirname(db.name), 'backups'); mkdirSync(folder, { recursive: true }); backupPath = resolve(folder, `before-recommendations-${randomUUID()}.sqlite`); }
  await db.backup(backupPath);
  return backupPath;
}
function savedRanking(value: unknown, now: number) {
  if (!object(value) || value.mode !== 'live' || value.status !== 'ok' || !Array.isArray(value.recommendations) || !value.recommendations.length || value.recommendations.length > 5 ||
    (value.errors !== undefined && (!Array.isArray(value.errors) || value.errors.length))) throw new Error('Only a successful live ranking result can be recorded.');
  const resultId = value.result_id === undefined || value.result_id === null ? `legacy:${hash(value)}` : value.result_id;
  if (typeof resultId !== 'string' || !/^[A-Za-z0-9:_-]{1,200}$/.test(resultId)) throw new Error('Invalid ranking result_id.');
  const generatedAt = value.generated_at ?? new Date(now).toISOString();
  if (typeof generatedAt !== 'string' || !Number.isFinite(Date.parse(generatedAt)) || new Date(generatedAt).toISOString() !== generatedAt || Date.parse(generatedAt) > now) throw new Error('Invalid or future ranking generated_at.');
  const seen = new Set<number>();
  const rows = value.recommendations.map(row => {
    if (!object(row) || !positiveId(row.tmdb_id) || seen.has(row.tmdb_id) || !Array.isArray(row.evidence) ||
      Object.keys(row).some(key => !['tmdb_id', 'title', 'year', 'why_fit', 'possible_mismatch', 'evidence'].includes(key))) throw new Error('Invalid or duplicate recommendation in saved result.');
    seen.add(row.tmdb_id);
    const evidence = row.evidence.map(ref => {
      if (!object(ref) || Object.keys(ref).some(key => !['movie_id', 'rating_100', 'title', 'year'].includes(key))) throw new Error('Invalid saved evidence.');
      return { movie_id: ref.movie_id, rating_100: ref.rating_100 };
    });
    return { tmdb_id: row.tmdb_id, why_fit: row.why_fit, possible_mismatch: row.possible_mismatch, evidence };
  });
  // Structural/evidence checks are reused below against a fresh SQLite snapshot.
  return { resultId, generatedAt, rows };
}
/** The caller creates a backup before writes. dryRun is the safe default; no network is used. */
export function recordRecommendations(db: Database.Database, candidateReport: unknown, request: RecordRequest, options: { dryRun?: boolean; now?: number } = {}): SaveReport {
  const dryRun = options.dryRun ?? true, now = options.now ?? Date.now();
  const parsed = parseCandidateReport(candidateReport), candidates = new Map(parsed.candidates.map(row => [row.tmdb_id, row]));
  if (request.tmdbIds !== undefined && request.result !== undefined) throw new Error('Choose TMDB IDs or a saved ranking result, not both.');
  const manual = request.tmdbIds !== undefined;
  let resultId: string, recommendedAt: string, rows: { tmdb_id: number; why_fit: unknown; possible_mismatch: unknown; evidence: unknown[] }[];
  if (manual) {
    const ids = request.tmdbIds!;
    if (!Array.isArray(ids) || !ids.length || ids.length > 40 || ids.some(id => !positiveId(id)) || new Set(ids).size !== ids.length) throw new Error('Provide 1-40 unique positive TMDB IDs.');
    resultId = `manual:${hash([...ids].sort((a, b) => a - b))}`; recommendedAt = new Date(now).toISOString();
    rows = ids.map(tmdb_id => ({ tmdb_id, why_fit: null, possible_mismatch: null, evidence: [] }));
  } else {
    const saved = savedRanking(request.result, now); resultId = saved.resultId; recommendedAt = saved.generatedAt; rows = saved.rows;
    // Check response shape and evidence syntax even on an idempotent replay; historical ratings may have changed.
    const syntaxSnapshot = rows.flatMap(row => row.evidence).filter(object).map(ref => ({ movie_id: ref.movie_id, rating_100: ref.rating_100 })) as Evidence[];
    const checked = validateRanking({ recommendations: rows }, [...candidates.values()], syntaxSnapshot);
    if (checked.diagnostics.length || checked.recommendations.length !== rows.length) throw new Error('Saved ranking failed structural validation.');
  }
  if (rows.some(row => !candidates.has(row.tmdb_id))) throw new Error('A requested TMDB ID is absent from the validated candidate file.');
  if (!dryRun) {
    if (db.readonly) throw new Error('Cannot record recommendations on a read-only database.');
    migrateDatabase(db);
  }
  const operation = db.transaction((): SaveReport => {
    const version = db.pragma('user_version', { simple: true }) as number;
    const previous = version >= 4 ? db.prepare(`SELECT m.tmdb_id,r.why_fit,r.possible_mismatch FROM recommendations r JOIN movies m ON m.id=r.movie_id WHERE r.result_id=?`).all(resultId) as
      { tmdb_id: number; why_fit: string | null; possible_mismatch: string | null }[] : [];
    const report: SaveReport = { status: dryRun ? 'preview' : 'saved', result_id: resultId, saved_count: 0, already_saved_count: 0, would_save_count: 0, skipped: [] };
    if (previous.length) {
      for (const saved of previous) {
        const row = rows.find(row => row.tmdb_id === saved.tmdb_id);
        if (!row || row.why_fit !== saved.why_fit || row.possible_mismatch !== saved.possible_mismatch) throw new Error('result_id conflicts with an already saved result.');
      }
      report.status = 'already_saved'; report.already_saved_count = previous.length;
      report.skipped = rows.filter(row => !previous.some(saved => saved.tmdb_id === row.tmdb_id)).map(row => ({ tmdb_id: row.tmdb_id, reason: 'result_already_processed' }));
      return report;
    }
    const history = readCandidateHistory(db), ratings = new Map(history.map(row => [row.id, row.rating_100]));
    for (const row of rows) {
      const movie = candidates.get(row.tmdb_id)!;
      const reason = blockedReason({ id: movie.tmdb_id, title: movie.title, original_title: movie.original_title, year: movie.year }, history, now);
      if (reason) { report.skipped.push({ tmdb_id: movie.tmdb_id, reason }); continue; }
      if (!manual) {
        const snapshot = [...ratings].flatMap(([movie_id, rating_100]) => rating_100 === null ? [] : [{ movie_id, rating_100 }]);
        const checked = validateRanking({ recommendations: [row] }, [movie], snapshot);
        if (!checked.recommendations.length) { report.skipped.push({ tmdb_id: movie.tmdb_id, reason: 'invalid_or_changed_evidence' }); continue; }
      }
      report.would_save_count++;
      if (dryRun) continue;
      let movieId = (db.prepare('SELECT id FROM movies WHERE tmdb_id=?').get(movie.tmdb_id) as { id: number } | undefined)?.id;
      if (movieId === undefined) {
        const inserted = db.prepare(`INSERT INTO movies(tmdb_id,title,release_year,media_type,runtime_minutes,overview,genres_json,tmdb_vote_count,tmdb_popularity,
          tmdb_title,original_title,tmdb_release_year,directors_json,tmdb_enrichment_status,metadata_updated_at,poster_path,backdrop_path)
          VALUES(?,?,?,'movie',?,?,?,?,?,?,?,?,?,'matched',?,?,?)`).run(movie.tmdb_id,movie.title,movie.year,movie.runtime,movie.overview,JSON.stringify(movie.genres),
          movie.vote_count,movie.popularity,movie.title,movie.original_title,movie.year,movie.directors === null ? null : JSON.stringify(movie.directors),new Date(now).toISOString(),movie.poster_path ?? null,movie.backdrop_path ?? null);
        movieId = Number(inserted.lastInsertRowid);
      } else if (movie.poster_path || movie.backdrop_path) {
        db.prepare('UPDATE movies SET poster_path=coalesce(poster_path,?),backdrop_path=coalesce(backdrop_path,?) WHERE id=?')
          .run(movie.poster_path ?? null,movie.backdrop_path ?? null,movieId);
      }
      db.prepare('INSERT INTO recommendations(movie_id,recommended_at,why_fit,possible_mismatch,result_id) VALUES(?,?,?,?,?)')
        .run(movieId,recommendedAt,row.why_fit,row.possible_mismatch,resultId);
      report.saved_count++;
    }
    if (!report.would_save_count) report.status = 'skipped';
    if (!dryRun && !manual && report.saved_count) saveEvaluation(db, resultId, candidateReport, request.result);
    return report;
  });
  return dryRun ? operation.deferred() : operation.immediate();
}
export function rejectRecommendation(db: Database.Database, tmdbId: number, undo = false) {
  if (!positiveId(tmdbId)) throw new Error('TMDB ID must be a positive integer.');
  return db.transaction(() => {
    const movie = db.prepare('SELECT id FROM movies WHERE tmdb_id=?').get(tmdbId) as { id: number } | undefined;
    if (!movie) throw new Error('Movie is not in the local library. Record its verified candidate first; no TMDB request was made.');
    let personalChanges = 0, historyChanges = 0;
    if (undo) personalChanges = db.prepare('UPDATE user_movies SET not_interested=0 WHERE movie_id=? AND not_interested=1').run(movie.id).changes;
    else {
      personalChanges = db.prepare(`INSERT INTO user_movies(movie_id,not_interested) VALUES(?,1)
        ON CONFLICT(movie_id) DO UPDATE SET not_interested=1 WHERE user_movies.not_interested<>1`).run(movie.id).changes;
      historyChanges = db.prepare('UPDATE recommendations SET rejected=1 WHERE movie_id=? AND rejected=0').run(movie.id).changes;
    }
    return { tmdb_id: tmdbId, not_interested: !undo, personal_changes: personalChanges, history_changes: historyChanges };
  }).immediate();
}
export function recommendationHistory(db: Database.Database) {
  return db.prepare(`SELECT m.title,coalesce(m.release_year,m.tmdb_release_year) year,m.tmdb_id,r.recommended_at,r.rejected,
    coalesce(u.not_interested,0) not_interested,r.why_fit,r.possible_mismatch FROM recommendations r JOIN movies m ON m.id=r.movie_id
    LEFT JOIN user_movies u ON u.movie_id=m.id ORDER BY r.recommended_at DESC,r.id DESC`).all();
}
