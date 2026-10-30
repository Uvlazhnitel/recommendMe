import { requireProfileSchema } from './profiles';
import { personalScope, type UserId } from './profiles';
import { observeOutcome } from './evaluation-storage';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type Database from 'better-sqlite3';
import { readReview, reviewValue } from './movie-review';
import { backupForRecommendationWrite } from './recommendation-memory';

export class WatchError extends Error {
  constructor(public readonly code: 'invalid_watch' | 'movie_not_found' | 'rating_already_exists') { super(code); }
}
type WatchInput = { movie_id: number; watched: true; rating_100?: number | null; review_text?: string | null };
export type WatchResult = { status: 'created' | 'updated' | 'unchanged'; movie_id: number; watched: true;
  rating_100: number | null; rating_source: 'manual' | 'letterboxd' | 'none' };
type PersonalRow = { watched: number; rating_100: number | null; rating_source: WatchResult['rating_source'] };
export function validateWatchInput(value: unknown): WatchInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WatchError('invalid_watch');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !['movie_id', 'watched', 'rating_100', 'review_text'].includes(key)) ||
    typeof row.movie_id !== 'number' || !Number.isSafeInteger(row.movie_id) || row.movie_id < 1 || row.watched !== true ||
    (row.rating_100 !== undefined && row.rating_100 !== null &&
      (typeof row.rating_100 !== 'number' || !Number.isInteger(row.rating_100) || row.rating_100 < 0 || row.rating_100 > 100))) throw new WatchError('invalid_watch');
  return { movie_id: row.movie_id, watched: true, rating_100: row.rating_100 as number | null | undefined,
    ...(Object.hasOwn(row, 'review_text') ? { review_text: reviewValue(row.review_text) } : {}) };
}
function current(db: Database.Database, userId: UserId, input: WatchInput) {
  personalScope(db, userId);
  if (!db.prepare('SELECT 1 FROM movies WHERE id=?').get(input.movie_id)) throw new WatchError('movie_not_found');
  const row = db.prepare('SELECT watched,rating_100,rating_source FROM user_movies WHERE user_id=@userId AND movie_id=?').get({userId}, input.movie_id) as PersonalRow | undefined;
  const requested = input.rating_100 ?? null;
  if (row && row.rating_100 !== null && requested !== null && requested !== row.rating_100) throw new WatchError('rating_already_exists');
  return row;
}
function unchanged(db: Database.Database, userId: UserId, input: WatchInput, row: PersonalRow | undefined): WatchResult | null {
  personalScope(db, userId);
  if (!row || row.watched !== 1 || (row.rating_100 === null && input.rating_100 != null) ||
    (input.review_text !== undefined && readReview(db, userId, input.movie_id) !== input.review_text)) return null;
  return { status: 'unchanged', movie_id: input.movie_id, watched: true, rating_100: row.rating_100, rating_source: row.rating_source };
}

/** Only confirms watching and assigns an initial rating; never clears or replaces a rating. */
export async function confirmMovieWatch(db: Database.Database, userId: UserId, value: unknown,
  options: { backup?: (db: Database.Database) => Promise<unknown> } = {}): Promise<WatchResult> {
  personalScope(db, userId);
  const input = validateWatchInput(value);
  const version = db.pragma('user_version', { simple: true }) as number;
  requireProfileSchema(db);
  const before = current(db, userId, input);
  const stable = unchanged(db, userId, input, before);
  if (stable) return stable;
  await (options.backup ?? (async database => {
    const folder = join(dirname(database.name), 'backups'); mkdirSync(folder, { recursive: true });
    await backupForRecommendationWrite(database, join(folder, `before-watch-${randomUUID()}.sqlite`));
  }))(db);
  requireProfileSchema(db);
  return db.transaction((): WatchResult => {
    const row = current(db, userId, input);
    const stable = unchanged(db, userId, input, row);
    if (stable) return stable;
    const rating = row?.rating_100 ?? input.rating_100 ?? null;
    const assigning = (row?.rating_100 ?? null) === null && input.rating_100 != null;
    const source = assigning ? 'manual' : row?.rating_source ?? 'none';
    if (!row) db.prepare('INSERT INTO user_movies(user_id,movie_id,watched,rating_100,rating_source) VALUES (@userId,?,1,?,?)').run({userId}, input.movie_id, rating, source);
    else db.prepare('UPDATE user_movies SET watched=1,rating_100=?,rating_source=? WHERE user_id=@userId AND movie_id=?').run({userId}, rating, source, input.movie_id);
    if (input.review_text !== undefined) db.prepare('UPDATE user_movies SET review_text=? WHERE user_id=@userId AND movie_id=?').run({userId}, input.review_text, input.movie_id);
    observeOutcome(db, userId, input.movie_id, row, rating);
    return { status: row ? 'updated' : 'created', movie_id: input.movie_id, watched: true, rating_100: rating, rating_source: source };
  }).immediate();
}
