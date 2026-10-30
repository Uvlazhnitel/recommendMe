import { profileRoute } from './profile-http';
import { ProfileError } from './profiles';
import { requireProfileSchema } from './profiles';
import { personalScope, type UserId } from './profiles';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type Database from 'better-sqlite3';
import { openDatabase } from './db';
import { JsonInputError, readJsonBody } from './http-json';
import { validTmdbId } from './movie-catalog';
import { backupForRecommendationWrite, rejectRecommendation } from './recommendation-memory';

class RejectError extends Error {
  constructor(public readonly code: 'invalid_tmdb_id' | 'movie_not_found') { super(code); }
}
export async function setRecommendationRejection(db: Database.Database, userId: UserId, tmdbId: number, undo = false,
  options: { backup?: (db: Database.Database) => Promise<unknown> } = {}) {
  personalScope(db, userId);
  if (!validTmdbId(tmdbId)) throw new RejectError('invalid_tmdb_id');
  const version = db.pragma('user_version', { simple: true }) as number;
  requireProfileSchema(db);
  const state = db.prepare(`SELECT coalesce(u.not_interested,0) hidden,
    EXISTS(SELECT 1 FROM recommendations r WHERE r.user_id=@userId AND r.movie_id=m.id AND r.rejected=0) pending_history
    FROM movies m LEFT JOIN user_movies u ON u.movie_id=m.id AND u.user_id=@userId WHERE m.tmdb_id=?`).get({userId}, tmdbId) as
    { hidden: number; pending_history: number } | undefined;
  if (!state) throw new RejectError('movie_not_found');
  if (undo ? state.hidden === 0 : state.hidden === 1 && state.pending_history === 0) {
    return { tmdb_id: tmdbId, not_interested: !undo, personal_changes: 0, history_changes: 0 };
  }
  await (options.backup ?? (async database => {
    const folder = join(dirname(database.name), 'backups'); mkdirSync(folder, { recursive: true });
    await backupForRecommendationWrite(database, join(folder, `before-rejection-${randomUUID()}.sqlite`));
  }))(db);
  requireProfileSchema(db);
  // Existing function re-reads local identity and writes both states in its IMMEDIATE transaction.
  return rejectRecommendation(db, userId, tmdbId, undo);
}
export function rejectionHandler(undo = false, dependencies: { open?: typeof openDatabase; backup?: Parameters<typeof setRecommendationRejection>[4] } = {}) {
  return profileRoute(async (request: Request, userId: UserId) => {
    const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
    let tmdbId: number;
    try {
      const body = await readJsonBody(request);
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 ||
        !('tmdb_id' in body) || !validTmdbId(body.tmdb_id)) throw new RejectError('invalid_tmdb_id');
      tmdbId = body.tmdb_id;
    } catch (error) { if (error instanceof ProfileError) throw error; return reply({ error: error instanceof JsonInputError ? error.code : 'invalid_tmdb_id' }, error instanceof JsonInputError ? error.status : 400); }
    let db: ReturnType<typeof openDatabase> | undefined;
    try {
      db = (dependencies.open ?? openDatabase)();
      return reply(await setRecommendationRejection(db, userId, tmdbId, undo, dependencies.backup));
    } catch (error) { if (error instanceof ProfileError) throw error;
      if (error instanceof RejectError) return reply({ error: error.code }, error.code === 'movie_not_found' ? 404 : 400);
      return reply({ error: 'rejection_unavailable', message: 'Не удалось сохранить решение «Неинтересно».' }, 500);
    } finally { db?.close(); }
  });
}
