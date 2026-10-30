import { profileRoute } from './profile-http';
import { ProfileError, type UserId } from './profiles';
import { REVIEW_BODY_BYTES, ReviewError } from './movie-review';
import { openDatabase } from './db';
import { JsonInputError, readJsonBody } from './http-json';
import { confirmMovieWatch, validateWatchInput, WatchError } from './movie-watch';

const reply = (body: unknown, status: number) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
export function watchHandler(dependencies: { open?: typeof openDatabase; backup?: Parameters<typeof confirmMovieWatch>[3] } = {}) {
  return profileRoute(async (request: Request, userId: UserId, context: { params: Promise<{ id: string }> }) => {
    let input: ReturnType<typeof validateWatchInput>;
    try {
      const { id } = await context.params;
      if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) throw new WatchError('invalid_watch');
      const body = await readJsonBody(request, REVIEW_BODY_BYTES);
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['rating_100', 'review_text'].includes(key))) throw new WatchError('invalid_watch');
      input = validateWatchInput({ ...body, movie_id: Number(id), watched: true });
    } catch (error) { if (error instanceof ProfileError) throw error;
      return reply({ error: error instanceof JsonInputError || error instanceof ReviewError ? error.code : 'invalid_watch' }, error instanceof JsonInputError ? error.status : 400);
    }
    let db: ReturnType<typeof openDatabase> | undefined;
    try {
      db = (dependencies.open ?? openDatabase)();
      const result = await confirmMovieWatch(db, userId, input, dependencies.backup);
      return reply(result, result.status === 'created' ? 201 : 200);
    } catch (error) { if (error instanceof ProfileError) throw error;
      if (error instanceof WatchError) return reply({ error: error.code }, error.code === 'movie_not_found' ? 404 : error.code === 'rating_already_exists' ? 409 : 400);
      return reply({ error: 'watch_unavailable', message: 'Не удалось сохранить просмотр фильма.' }, 500);
    } finally { db?.close(); }
  });
}
