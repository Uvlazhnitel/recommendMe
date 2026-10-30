import { requireProfileSchema } from './profiles';
import { personalScope, type UserId } from './profiles';
import { observeOutcome } from './evaluation-storage';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type Database from 'better-sqlite3';
import { backupForRecommendationWrite } from './recommendation-memory';

export class LibraryError extends Error {
  constructor(public readonly code: 'invalid_library_query' | 'invalid_rating' | 'invalid_movie_id' | 'movie_not_found' | 'movie_not_watched') { super(code); }
}
export function localMovieId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new LibraryError('invalid_movie_id');
  return value;
}
const sorts = {
  added_desc: 'u.created_at DESC,m.id ASC', added_asc: 'u.created_at ASC,m.id ASC',
  rating_desc: 'u.rating_100 IS NULL ASC,u.rating_100 DESC,m.id ASC', rating_asc: 'u.rating_100 IS NULL ASC,u.rating_100 ASC,m.id ASC',
} as const;
export type LibraryQuery = { q: string; rated: 'all' | 'true' | 'false'; year?: number; page: number; limit: number; sort: keyof typeof sorts };
export function parseLibraryQuery(params: URLSearchParams): LibraryQuery {
  const allowed = ['q', 'rated', 'year', 'page', 'limit', 'sort'];
  if ([...params.keys()].some(key => !allowed.includes(key) || params.getAll(key).length !== 1)) throw new LibraryError('invalid_library_query');
  const q = params.get('q')?.trim() ?? '', rated = params.get('rated') ?? 'all', sort = params.get('sort') ?? 'added_desc';
  const integer = (value: string, max = Number.MAX_SAFE_INTEGER) => {
    if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max) throw new LibraryError('invalid_library_query');
    return Number(value);
  };
  const page = integer(params.get('page') ?? '1'), limit = integer(params.get('limit') ?? '25', 100);
  const year = params.has('year') ? integer(params.get('year')!, 9999) : undefined;
  if ([...q].length > 200 || !['all', 'true', 'false'].includes(rated) || !Object.hasOwn(sorts, sort) || !Number.isSafeInteger((page - 1) * limit)) throw new LibraryError('invalid_library_query');
  return { q, rated: rated as LibraryQuery['rated'], sort: sort as LibraryQuery['sort'], year, page, limit };
}
type Row = {
  id: number; tmdb_id: number | null; title: string; release_year: number | null; tmdb_release_year: number | null;
  tmdb_title: string | null; original_title: string | null; poster_path: string | null; genres_json: string | null; directors_json: string | null; credits_json: string | null;
  watched: number | null; rating_100: number | null; review_text?: string | null; rating_source: 'none' | 'manual' | 'letterboxd' | null; not_interested: number | null;
  letterboxd_uri: string | null; original_rating_stars: number | null; letterboxd_date: string | null; letterboxd_rating_date: string | null;
  watched_at: string | null; created_at: string | null; updated_at: string | null; media_type: string; runtime_minutes: number | null;
  overview: string | null; original_language: string | null; tmdb_vote_average: number | null; tmdb_vote_count: number | null; tmdb_popularity: number | null;
  metadata_updated_at: string | null; tmdb_enrichment_status: string; tmdb_attempted_at: string | null;
};
const columns = (db: Database.Database) => `${(db.pragma('user_version', { simple: true }) as number) >= 6 ? 'u.review_text' : 'NULL AS review_text'},m.*,u.watched,u.rating_100,u.rating_source,u.not_interested,u.original_rating_stars,
  u.letterboxd_date,u.letterboxd_rating_date,u.watched_at,u.created_at,u.updated_at`;
const decode = (value: string | null): unknown => value === null ? null : JSON.parse(value);
function summary(row: Row) {
  return { movie_id: row.id, tmdb_id: row.tmdb_id, title: row.title, tmdb_title: row.tmdb_title, original_title: row.original_title,
    year: row.release_year ?? row.tmdb_release_year, poster_path: row.poster_path, genres: decode(row.genres_json), directors: decode(row.directors_json),
    watched: row.watched === 1, rating_100: row.rating_100, review_text: row.review_text ?? null, rating_source: row.rating_source ?? 'none', not_interested: row.not_interested === 1,
    letterboxd_uri: row.letterboxd_uri, original_rating_stars: row.original_rating_stars, letterboxd_date: row.letterboxd_date,
    letterboxd_rating_date: row.letterboxd_rating_date, watched_at: row.watched_at, created_at: row.created_at, updated_at: row.updated_at };
}
function schema(db: Database.Database) {
  const version = db.pragma('user_version', { simple: true }) as number;
  requireProfileSchema(db);
}
export function readLibrary(db: Database.Database, userId: UserId, params = new URLSearchParams()) {
  personalScope(db, userId);
  const query = parseLibraryQuery(params); schema(db);
  // Registering a connection-local SQL function does not modify the SQLite file.
  db.function('library_casefold', { deterministic: true }, (value: unknown) => typeof value === 'string' ? value.normalize('NFKC').toLowerCase() : '');
  const conditions = ['u.watched=1']; const values: (string | number)[] = [];
  if (query.q) {
    conditions.push('(instr(library_casefold(m.title),?)>0 OR instr(library_casefold(m.tmdb_title),?)>0 OR instr(library_casefold(m.original_title),?)>0)');
    const needle = query.q.normalize('NFKC').toLowerCase(); values.push(needle, needle, needle);
  }
  if (query.rated !== 'all') conditions.push(`u.rating_100 IS ${query.rated === 'true' ? 'NOT ' : ''}NULL`);
  if (query.year !== undefined) { conditions.push('coalesce(m.release_year,m.tmdb_release_year)=?'); values.push(query.year); }
  const from = `FROM movies m JOIN user_movies u ON u.movie_id=m.id AND u.user_id=@userId WHERE ${conditions.join(' AND ')}`;
  return db.transaction(() => {
    const total = (db.prepare(`SELECT count(*) total ${from}`).get({userId}, ...values) as { total: number }).total;
    const rows = db.prepare(`SELECT ${columns(db)} ${from} ORDER BY ${sorts[query.sort]} LIMIT ? OFFSET ?`).all({userId}, ...values, query.limit, (query.page - 1) * query.limit) as Row[];
    return { items: rows.map(summary), total, page: query.page, limit: query.limit, total_pages: Math.ceil(total / query.limit) };
  }).deferred();
}
export function readLibraryMovie(db: Database.Database, userId: UserId, movieId: number) {
  personalScope(db, userId);
  localMovieId(movieId); schema(db);
  const row = db.prepare(`SELECT ${columns(db)} FROM movies m LEFT JOIN user_movies u ON u.movie_id=m.id AND u.user_id=@userId WHERE m.id=?`).get({userId}, movieId) as Row | undefined;
  if (!row) throw new LibraryError('movie_not_found');
  return { ...summary(row), release_year: row.release_year, tmdb_release_year: row.tmdb_release_year, media_type: row.media_type,
    runtime_minutes: row.runtime_minutes, overview: row.overview, original_language: row.original_language, tmdb_vote_average: row.tmdb_vote_average,
    tmdb_vote_count: row.tmdb_vote_count, tmdb_popularity: row.tmdb_popularity, credits: decode(row.credits_json), metadata_updated_at: row.metadata_updated_at,
    tmdb_enrichment_status: row.tmdb_enrichment_status, tmdb_attempted_at: row.tmdb_attempted_at };
}
export function ratingValue(value: unknown): number | null {
  if (value !== null && (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 100)) throw new LibraryError('invalid_rating');
  return value as number | null;
}
function watchedMovie(db: Database.Database, userId: UserId, movieId: number) {
  personalScope(db, userId);
  if (!db.prepare('SELECT 1 FROM movies WHERE id=?').get(movieId)) throw new LibraryError('movie_not_found');
  const row = db.prepare('SELECT watched,rating_100,rating_source FROM user_movies WHERE user_id=@userId AND movie_id=?').get({userId}, movieId) as
    { watched: number; rating_100: number | null; review_text?: string | null; rating_source: 'none' | 'manual' | 'letterboxd' } | undefined;
  if (!row || row.watched !== 1) throw new LibraryError('movie_not_watched');
  return row;
}
export async function updateLibraryRating(db: Database.Database, userId: UserId, movieId: number, value: unknown,
  options: { backup?: (db: Database.Database) => Promise<unknown> } = {}) {
  personalScope(db, userId);
  localMovieId(movieId); const rating = ratingValue(value); schema(db);
  const result = (status: 'updated' | 'unchanged', source: 'none' | 'manual' | 'letterboxd') =>
    ({ status, movie_id: movieId, watched: true as const, rating_100: rating, rating_source: source });
  const before = watchedMovie(db, userId, movieId);
  if (before.rating_100 === rating) return result('unchanged', before.rating_source);
  await (options.backup ?? (async database => {
    const folder = join(dirname(database.name), 'backups'); mkdirSync(folder, { recursive: true });
    await backupForRecommendationWrite(database, join(folder, `before-rating-${randomUUID()}.sqlite`));
  }))(db);
  requireProfileSchema(db);
  return db.transaction(() => {
    const row = watchedMovie(db, userId, movieId);
    if (row.rating_100 === rating) return result('unchanged', row.rating_source);
    const source = rating === null ? 'none' : 'manual';
    db.prepare('UPDATE user_movies SET rating_100=?,rating_source=? WHERE user_id=@userId AND movie_id=?').run({userId}, rating, source, movieId);
    observeOutcome(db, userId, movieId, row, rating);
    return result('updated', source);
  }).immediate();
}
