import { openDatabase } from './db';
import { JsonInputError, readJsonBody } from './http-json';
import { LibraryError, localMovieId } from './library';
import { REVIEW_BODY_BYTES, ReviewError, reviewValue, updateMovieReview } from './movie-review';

const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
export function reviewHandler(dependencies: { open?: typeof openDatabase; backup?: Parameters<typeof updateMovieReview>[3] } = {}) {
  return async (request: Request, context: { params: Promise<{ id: string }> }) => {
    let db: ReturnType<typeof openDatabase> | undefined;
    try {
      const { id } = await context.params;
      if (!/^[1-9]\d*$/.test(id)) throw new LibraryError('invalid_movie_id');
      const movieId = localMovieId(Number(id));
      const body = await readJsonBody(request, REVIEW_BODY_BYTES);
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || !Object.hasOwn(body, 'review_text')) throw new ReviewError();
      const review = reviewValue((body as { review_text: unknown }).review_text);
      db = (dependencies.open ?? openDatabase)();
      return reply(await updateMovieReview(db, movieId, review, dependencies.backup));
    } catch (error) {
      if (error instanceof JsonInputError) return reply({ error: error.code }, error.status);
      if (error instanceof ReviewError) return reply({ error: error.code }, 400);
      if (error instanceof LibraryError) return reply({ error: error.code }, error.code === 'movie_not_found' ? 404 : error.code === 'movie_not_watched' ? 409 : 400);
      return reply({ error: 'review_unavailable' }, 500);
    } finally { db?.close(); }
  };
}
