import { requireProfileSchema } from './profiles';
import { personalScope, type UserId } from './profiles';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type Database from 'better-sqlite3';
import { LibraryError, localMovieId } from './library';
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
export function readReview(db: Database.Database, userId: UserId, movieId: number): string | null {
  personalScope(db, userId);
  if ((db.pragma('user_version', { simple: true }) as number) < 6) return null;
  return (db.prepare('SELECT review_text FROM user_movies WHERE user_id=@userId AND movie_id=?').get({userId}, movieId) as { review_text: string | null } | undefined)?.review_text ?? null;
}
function requireWatched(db: Database.Database, userId: UserId, movieId: number) {
  personalScope(db, userId);
  if (!db.prepare('SELECT 1 FROM movies WHERE id=?').get(movieId)) throw new LibraryError('movie_not_found');
  if ((db.prepare('SELECT watched FROM user_movies WHERE user_id=@userId AND movie_id=?').get({userId}, movieId) as { watched: number } | undefined)?.watched !== 1) throw new LibraryError('movie_not_watched');
}
export async function updateMovieReview(db: Database.Database, userId: UserId, movieId: number, value: unknown,
  options: { backup?: (db: Database.Database) => Promise<unknown> } = {}) {
  personalScope(db, userId);
  localMovieId(movieId); const review = reviewValue(value);
  const version = db.pragma('user_version', { simple: true }) as number;
  requireProfileSchema(db);
  requireWatched(db, userId, movieId);
  const result = (status: 'updated' | 'unchanged') => ({ status, movie_id: movieId, review_text: review });
  if (readReview(db, userId, movieId) === review) return result('unchanged');
  await (options.backup ?? (async database => {
    const folder = join(dirname(database.name), 'backups'); mkdirSync(folder, { recursive: true });
    await backupForRecommendationWrite(database, join(folder, `before-review-${randomUUID()}.sqlite`));
  }))(db);
  requireProfileSchema(db);
  return db.transaction(() => {
    requireWatched(db, userId, movieId);
    if (readReview(db, userId, movieId) === review) return result('unchanged');
    db.prepare('UPDATE user_movies SET review_text=? WHERE user_id=@userId AND movie_id=?').run({userId}, review, movieId);
    return result('updated');
  }).immediate();
}
