import { openDatabase } from './db';
import { JsonInputError, readJsonBody } from './http-json';
import { confirmMovieWatch, validateWatchInput, WatchError } from './movie-watch';

const reply = (body: unknown, status: number) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
export function watchHandler(dependencies: { open?: typeof openDatabase; backup?: Parameters<typeof confirmMovieWatch>[2] } = {}) {
  return async (request: Request, context: { params: Promise<{ id: string }> }) => {
    let input: ReturnType<typeof validateWatchInput>;
    try {
      const { id } = await context.params;
      if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) throw new WatchError('invalid_watch');
      const body = await readJsonBody(request);
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'rating_100')) throw new WatchError('invalid_watch');
      input = validateWatchInput({ ...body, movie_id: Number(id), watched: true });
    } catch (error) {
      return reply({ error: error instanceof JsonInputError ? error.code : 'invalid_watch' }, error instanceof JsonInputError ? error.status : 400);
    }
    let db: ReturnType<typeof openDatabase> | undefined;
    try {
      db = (dependencies.open ?? openDatabase)();
      const result = await confirmMovieWatch(db, input, dependencies.backup);
      return reply(result, result.status === 'created' ? 201 : 200);
    } catch (error) {
      if (error instanceof WatchError) return reply({ error: error.code }, error.code === 'movie_not_found' ? 404 : error.code === 'rating_already_exists' ? 409 : 400);
      return reply({ error: 'watch_unavailable', message: 'The local watch operation could not be completed.' }, 500);
    } finally { db?.close(); }
  };
}
