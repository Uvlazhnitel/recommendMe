import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type Database from 'better-sqlite3';
import { LibraryError, localMovieId } from './library';
import { migrateDatabase } from './migrations';
import { backupForRecommendationWrite } from './recommendation-memory';

export const REVIEW_MAX_LENGTH = 2000;
// JSON may escape each UTF-16 code unit as six ASCII bytes.
export const REVIEW_BODY_BYTES = 24576;
export class ReviewError extends Error { readonly code = 'invalid_review'; }
export function reviewValue(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > REVIEW_MAX_LENGTH || value.includes('\0')) throw new ReviewError();
  return value.trim() ? value : null;
}
export function readReview(db: Database.Database, movieId: number): string | null {
  if ((db.pragma('user_version', { simple: true }) as number) < 6) return null;
  return (db.prepare('SELECT review_text FROM user_movies WHERE movie_id=?').get(movieId) as { review_text: string | null } | undefined)?.review_text ?? null;
}
function requireWatched(db: Database.Database, movieId: number) {
  if (!db.prepare('SELECT 1 FROM movies WHERE id=?').get(movieId)) throw new LibraryError('movie_not_found');
  if ((db.prepare('SELECT watched FROM user_movies WHERE movie_id=?').get(movieId) as { watched: number } | undefined)?.watched !== 1) throw new LibraryError('movie_not_watched');
}
export async function updateMovieReview(db: Database.Database, movieId: number, value: unknown,
  options: { backup?: (db: Database.Database) => Promise<unknown> } = {}) {
  localMovieId(movieId); const review = reviewValue(value);
  const version = db.pragma('user_version', { simple: true }) as number;
  if (![3, 4, 5, 6, 7].includes(version)) throw new Error('Reviews require SQLite schema 3, 4, 5, 6 or 7.');
  requireWatched(db, movieId);
  const result = (status: 'updated' | 'unchanged') => ({ status, movie_id: movieId, review_text: review });
  if (readReview(db, movieId) === review) return result('unchanged');
  await (options.backup ?? (async database => {
    const folder = join(dirname(database.name), 'backups'); mkdirSync(folder, { recursive: true });
    await backupForRecommendationWrite(database, join(folder, `before-review-${randomUUID()}.sqlite`));
  }))(db);
  migrateDatabase(db);
  return db.transaction(() => {
    requireWatched(db, movieId);
    if (readReview(db, movieId) === review) return result('unchanged');
    db.prepare('UPDATE user_movies SET review_text=? WHERE movie_id=?').run(review, movieId);
    return result('updated');
  }).immediate();
}
