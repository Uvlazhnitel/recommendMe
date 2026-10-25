import type Database from 'better-sqlite3';
import { migrateDatabase } from './migrations';
import { matches, TmdbError, type Candidate, type Details, type TmdbClient } from './tmdb';

type Status = 'matched' | 'not_found' | 'ambiguous' | 'error';
type Movie = { id: number; title: string; release_year: number | null; tmdb_id: number | null; media_type: string;
  tmdb_enrichment_status?: string; metadata_updated_at: string | null };
type Item = { movieId: number; title: string; year: number | null; status: Status; reason: string; candidates: Candidate[] };
export type EnrichmentReport = { dryRun: boolean; processed: number; matched: number; notFound: number; ambiguous: number; errors: number;
  requests: number; failedRequests: number; remainingWithoutId: number; stopped: boolean; items: Item[]; backupPath: string | null };
type Options = { dryRun?: boolean; limit?: number; retryUnresolved?: boolean; backupPath?: string;
  onProgress?: (report: EnrichmentReport) => void };
const json = (value: unknown) => value === null ? null : JSON.stringify(value);

export async function enrichTmdb(database: Database.Database, client: TmdbClient, options: Options = {}): Promise<EnrichmentReport> {
  if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit <= 0)) throw new Error('limit must be a positive integer.');
  const version = database.pragma('user_version', { simple: true }) as number;
  if (version < 2 || version > 3) throw new Error('TMDB enrichment requires schema version 2 or 3.');
  if (!options.dryRun) {
    if (!options.backupPath) throw new Error('A backup path is required before enrichment.');
    await database.backup(options.backupPath);
    migrateDatabase(database);
  }
  // SELECT * also permits a read-only dry-run against schema 2, before migration.
  const allMovies = database.prepare('SELECT * FROM movies ORDER BY id').all() as Movie[];
  const targets = allMovies.filter(movie => {
    const status = movie.tmdb_enrichment_status ?? 'pending';
    if (movie.media_type === 'tv') return false;
    if (status === 'not_found' || status === 'ambiguous') return Boolean(options.retryUnresolved);
    return status === 'pending' || status === 'error' || (movie.tmdb_id !== null && movie.metadata_updated_at === null);
  }).slice(0, options.limit);
  const claimed = new Map(allMovies.filter(movie => movie.tmdb_id !== null).map(movie => [movie.tmdb_id!, movie.id]));
  const report: EnrichmentReport = { dryRun: Boolean(options.dryRun), processed: 0, matched: 0, notFound: 0, ambiguous: 0, errors: 0,
    requests: 0, failedRequests: 0, remainingWithoutId: allMovies.filter(movie => movie.tmdb_id === null).length,
    stopped: false, items: [], backupPath: options.dryRun ? null : options.backupPath! };
  const progress = () => {
    report.requests = client.stats.requests; report.failedRequests = client.stats.failedRequests;
    report.remainingWithoutId = (database.prepare('SELECT count(*) AS n FROM movies WHERE tmdb_id IS NULL').get() as { n: number }).n;
    options.onProgress?.(report);
  };
  progress();
  for (const movie of targets) {
    let details: Details | null = null;
    const item: Item = { movieId: movie.id, title: movie.title, year: movie.release_year, status: 'not_found', reason: '', candidates: [] };
    try {
      if (movie.release_year === null) {
        item.status = 'ambiguous'; item.reason = 'Missing source year; manual review required.';
      } else if (movie.tmdb_id !== null) {
        details = await client.details(movie.tmdb_id);
      } else {
        const result = await client.search(movie.title, movie.release_year);
        item.candidates = result.candidates;
        const exact = result.candidates.filter(candidate => matches(movie, candidate));
        if (!result.complete) { item.status = 'ambiguous'; item.reason = 'Search exceeds five pages; candidates cannot be checked completely.'; }
        else if (exact.length > 1) { item.status = 'ambiguous'; item.reason = 'Several candidates have matching title and year.'; }
        else if (exact.length === 0) item.reason = 'No exact movie title/year match.';
        else details = await client.details(exact[0].id);
      }
      if (details) {
        item.candidates = [{ id: details.id, title: details.title, original_title: details.original_title, year: details.year }];
        if (!matches(movie, details)) { item.status = 'ambiguous'; item.reason = 'Movie details do not confirm source title/year.'; details = null; }
        else if (claimed.has(details.id) && claimed.get(details.id) !== movie.id) {
          item.status = 'ambiguous'; item.reason = 'TMDB ID belongs to another local record; no merge performed.'; details = null;
        } else { item.status = 'matched'; item.reason = 'Exact normalized title and year confirmed by movie details.'; }
      }
    } catch (error) {
      item.status = 'error'; item.reason = error instanceof TmdbError ? error.message : 'Unexpected enrichment failure.';
      if (error instanceof TmdbError && error.stop) report.stopped = true;
    }
    if (!options.dryRun) {
      database.transaction(() => {
        const now = new Date().toISOString();
        if (details && item.status === 'matched') {
          const owner = database.prepare('SELECT id FROM movies WHERE tmdb_id = ? AND id != ?').get(details.id, movie.id);
          if (owner) { item.status = 'ambiguous'; item.reason = 'TMDB ID was assigned to another record; no merge performed.'; }
          else {
            database.prepare(`UPDATE movies SET tmdb_id=?, tmdb_title=?, original_title=?, tmdb_release_year=?, original_language=?,
              overview=?, genres_json=?, runtime_minutes=?, poster_path=?, tmdb_vote_average=?, tmdb_vote_count=?, tmdb_popularity=?,
              directors_json=?, credits_json=?, metadata_updated_at=?, media_type='movie' WHERE id=?`).run(
              details.id, details.title, details.original_title, details.year, details.original_language,
              details.overview, json(details.genres), details.runtime, details.poster_path, details.vote_average, details.vote_count, details.popularity,
              json(details.directors), json(details.credits), now, movie.id);
          }
        }
        database.prepare('UPDATE movies SET tmdb_enrichment_status=?, tmdb_attempted_at=? WHERE id=?').run(item.status, now, movie.id);
      }).immediate();
    }
    if (details && item.status === 'matched') claimed.set(details.id, movie.id);
    report.items.push(item); report.processed++;
    if (item.status === 'matched') report.matched++;
    else if (item.status === 'not_found') report.notFound++;
    else if (item.status === 'ambiguous') report.ambiguous++;
    else report.errors++;
    progress();
    if (report.stopped) break;
  }
  return report;
}
