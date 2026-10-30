import { warmRussianMovies } from './russian-metadata';
import { profileRoute } from './profile-http';
import { ProfileError, type UserId } from './profiles';
import { openDatabase } from './db';
import { JsonInputError, readJsonBody } from './http-json';
import { LibraryError, localMovieId, parseLibraryQuery, ratingValue, readLibrary, readLibraryMovie, updateLibraryRating } from './library';

const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
function failure(error: unknown) {
  if (error instanceof ProfileError) throw error;
  if (error instanceof JsonInputError) return reply({ error: error.code }, error.status);
  if (error instanceof LibraryError) return reply({ error: error.code }, error.code === 'movie_not_found' ? 404 : error.code === 'movie_not_watched' ? 409 : 400);
  return reply({ error: 'library_unavailable', message: 'Не удалось выполнить операцию с библиотекой.' }, 500);
}
type Context = { params: Promise<{ id: string }> };
async function routeId(context: Context) {
  const { id } = await context.params;
  if (!/^[1-9]\d*$/.test(id)) throw new LibraryError('invalid_movie_id');
  return localMovieId(Number(id));
}
export function libraryHandlers(dependencies: { open?: typeof openDatabase; backup?: Parameters<typeof updateLibraryRating>[4] } = {}) {
  const handlers = {
    async list(request: Request, userId: UserId) {
      let db: ReturnType<typeof openDatabase> | undefined;
      try {
        const params = new URL(request.url).searchParams; parseLibraryQuery(params);
        db = (dependencies.open ?? openDatabase)({ readonly: true });
        const result = readLibrary(db, userId, params);
        if (!dependencies.open) { await warmRussianMovies(result.items.map(row => row.movie_id)); return reply(readLibrary(db, userId, params)); }
        return reply(result);
      } catch (error) { if (error instanceof ProfileError) throw error; return failure(error); }
      finally { db?.close(); }
    },
    async details(request: Request, userId: UserId, context: Context) {
      let db: ReturnType<typeof openDatabase> | undefined;
      try {
        const id = await routeId(context);
        db = (dependencies.open ?? openDatabase)({ readonly: true });
        if (!dependencies.open) await warmRussianMovies([id]);
        return reply(readLibraryMovie(db, userId, id));
      } catch (error) { if (error instanceof ProfileError) throw error; return failure(error); }
      finally { db?.close(); }
    },
    async rating(request: Request, userId: UserId, context: Context) {
      let id: number, rating: number | null;
      try {
        id = await routeId(context);
        let body: unknown;
        try { body = await readJsonBody(request); }
        catch (error) { if (error instanceof ProfileError) throw error; if (error instanceof JsonInputError) throw error; throw new LibraryError('invalid_rating'); }
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || !Object.hasOwn(body, 'rating_100')) throw new LibraryError('invalid_rating');
        rating = ratingValue((body as { rating_100: unknown }).rating_100);
      } catch (error) { if (error instanceof ProfileError) throw error; return failure(error); }
      let db: ReturnType<typeof openDatabase> | undefined;
      try {
        db = (dependencies.open ?? openDatabase)();
        return reply(await updateLibraryRating(db, userId, id, rating, dependencies.backup));
      } catch (error) { if (error instanceof ProfileError) throw error; return failure(error); }
      finally { db?.close(); }
    },
  };
  return { list: profileRoute(handlers.list), details: profileRoute(handlers.details), rating: profileRoute(handlers.rating) };
}
