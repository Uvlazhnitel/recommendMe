import { warmRussianMovies } from './russian-metadata';
import { profileRoute } from './profile-http';
import { ProfileError, requireProfileSchema, type UserId } from './profiles';
import { JsonInputError, readJsonBody } from './http-json';
import { openDatabase } from './db';
import { addCatalogMovie, validTmdbId, type CatalogApi } from './movie-catalog';
import { createTmdbClient, TmdbError } from './tmdb';

let shared: CatalogApi | undefined;
function manualApi(): CatalogApi {
  if (!shared) {
    const client = createTmdbClient(process.env.TMDB_API_KEY);
    let tail: Promise<unknown> = Promise.resolve();
    const sequential = <T>(operation: () => Promise<T>): Promise<T> => {
      const result = tail.then(operation);
      tail = result.catch(() => undefined);
      return result;
    };
    shared = {
      searchInteractive: (query, year) => sequential(() => client.searchInteractive(query, year)),
      details: id => sequential(() => client.details(id)),
    };
  }
  return shared;
}
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
function failure(error: unknown) {
  if (error instanceof ProfileError) throw error;
  if (error instanceof TmdbError) {
    if (error.status === 404) return reply({ error: 'movie_not_found' }, 404);
    return reply({ error: 'tmdb_unavailable', message: 'TMDB недоступен или неверно настроен на сервере.' }, 502);
  }
  return reply({ error: 'catalog_unavailable', message: 'Не удалось выполнить операцию с каталогом фильмов.' }, 503);
}
// Dependencies keep route tests on synthetic databases and mocked HTTP only.
export function movieHandlers(dependencies: { api?: () => CatalogApi; open?: typeof openDatabase;
  backup?: Parameters<typeof addCatalogMovie>[3] } = {}) {
  const handlers = {
    async search(request: Request, userId: UserId) {
      const url = new URL(request.url);
      const query = url.searchParams.get('q')?.trim() ?? '';
      const yearValue = url.searchParams.get('year');
      if (!query || [...query].length > 200 || (yearValue !== null && (!/^\d{1,4}$/.test(yearValue) || Number(yearValue) < 1))) {
        return reply({ error: 'invalid_search', message: 'Введите название от 1 до 200 символов и год целым числом от 1 до 9999.' }, 400);
      }
      try { const db=(dependencies.open??openDatabase)({readonly:true});try{requireProfileSchema(db);}finally{db.close();} return reply(await (dependencies.api ?? manualApi)().searchInteractive(query, yearValue === null ? undefined : Number(yearValue))); }
      catch (error) { if (error instanceof ProfileError) throw error; return failure(error); }
    },
    async add(request: Request, userId: UserId) {
      let body: unknown;
      try {
        body = await readJsonBody(request);
      } catch (error) { if (error instanceof ProfileError) throw error; return reply({ error: error instanceof JsonInputError ? error.code : 'invalid_json' }, error instanceof JsonInputError ? error.status : 400); }
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 ||
        !('tmdb_id' in body) || !validTmdbId(body.tmdb_id)) return reply({ error: 'invalid_tmdb_id', message: 'Передайте только положительный целочисленный идентификатор фильма TMDB.' }, 400);
      let db: ReturnType<typeof openDatabase> | undefined;
      try {
        db = (dependencies.open ?? openDatabase)();
        // Delay API construction until details are needed: existing IDs work without a configured key.
        const result = await addCatalogMovie(db, { details: id => (dependencies.api ?? manualApi)().details(id) }, body.tmdb_id, dependencies.backup);
        if (!dependencies.open && result.status !== 'possible_duplicate') await warmRussianMovies([result.movie_id]);
        return reply(result, result.status === 'created' ? 201 : result.status === 'possible_duplicate' ? 409 : 200);
      } catch (error) { if (error instanceof ProfileError) throw error; return failure(error); }
      finally { db?.close(); }
    },
  };
  return { search: profileRoute(handlers.search), add: profileRoute(handlers.add) };
}
