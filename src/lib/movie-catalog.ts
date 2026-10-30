import { requireProfileSchema } from './profiles';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type Database from 'better-sqlite3';
import { normalizeTitle, type Details, type TmdbClient } from './tmdb';
import { backupForRecommendationWrite } from './recommendation-memory';

export type CatalogResult = { status: 'created' | 'already_exists'; movie_id: number; tmdb_id: number } |
  { status: 'possible_duplicate'; tmdb_id: number; matches: { movie_id: number; title: string; year: number | null }[] };
export type CatalogApi = Pick<TmdbClient, 'details' | 'searchInteractive'>;
export function validTmdbId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
function existing(db: Database.Database, tmdbId: number): CatalogResult | null {
  const row = db.prepare('SELECT id FROM movies WHERE tmdb_id = ?').get(tmdbId) as { id: number } | undefined;
  return row ? { status: 'already_exists', movie_id: row.id, tmdb_id: tmdbId } : null;
}
function conflicts(db: Database.Database, details: Details): CatalogResult | null {
  const names = new Set([details.title, details.original_title].filter((v): v is string => Boolean(v)).map(normalizeTitle).filter(Boolean));
  const rows = db.prepare('SELECT id, title, release_year, tmdb_release_year, tmdb_title, original_title FROM movies WHERE tmdb_id IS NULL ORDER BY id').all() as
    { id: number; title: string; release_year: number | null; tmdb_release_year: number | null; tmdb_title: string | null; original_title: string | null }[];
  const matches = rows.filter(row => {
    const year = row.release_year ?? row.tmdb_release_year;
    return (year === null || details.year === null || year === details.year) &&
      [row.title, row.tmdb_title, row.original_title].some(name => name !== null && names.has(normalizeTitle(name)));
  }).map(row => ({ movie_id: row.id, title: row.title, year: row.release_year ?? row.tmdb_release_year }));
  return matches.length ? { status: 'possible_duplicate', tmdb_id: details.id, matches } : null;
}

/** HTTP is completed before backups, migrations and the short write transaction. */
export async function addCatalogMovie(db: Database.Database, api: Pick<CatalogApi, 'details'>, tmdbId: number,
  options: { backup?: (db: Database.Database) => Promise<unknown> } = {}): Promise<CatalogResult> {
  if (!validTmdbId(tmdbId)) throw new Error('Invalid TMDB ID.');
  const version = db.pragma('user_version', { simple: true }) as number;
  requireProfileSchema(db);
  const found = existing(db, tmdbId);
  if (found) return found;
  const details = await api.details(tmdbId);
  if (details.id !== tmdbId) throw new Error('TMDB returned a different movie ID.');
  const conflict = conflicts(db, details);
  if (conflict) return conflict;
  await (options.backup ?? (async database => {
    const folder = join(dirname(database.name), 'backups'); mkdirSync(folder, { recursive: true });
    await backupForRecommendationWrite(database, join(folder, `before-catalog-${randomUUID()}.sqlite`));
  }))(db);
  requireProfileSchema(db);
  return db.transaction((): CatalogResult => {
    const duplicate = existing(db, tmdbId) ?? conflicts(db, details);
    if (duplicate) return duplicate;
    const json = (value: unknown) => value === null ? null : JSON.stringify(value);
    const now = new Date().toISOString();
    const result = db.prepare(`INSERT INTO movies
      (tmdb_id,title,release_year,media_type,runtime_minutes,overview,genres_json,poster_path,
       tmdb_vote_count,tmdb_popularity,metadata_updated_at,tmdb_title,original_title,tmdb_release_year,
       original_language,tmdb_vote_average,directors_json,credits_json,tmdb_enrichment_status,tmdb_attempted_at,backdrop_path)
      VALUES (?,?,?,'movie',?,?,?,?,?,?,?,?,?,?,?,?,?,?,'matched',?,?)`).run(
      details.id, details.title, details.year, details.runtime, details.overview, json(details.genres), details.poster_path,
      details.vote_count, details.popularity, now, details.title, details.original_title, details.year,
      details.original_language, details.vote_average, json(details.directors), json(details.credits), now, details.backdrop_path);
    return { status: 'created', movie_id: Number(result.lastInsertRowid), tmdb_id: tmdbId };
  }).immediate();
}
