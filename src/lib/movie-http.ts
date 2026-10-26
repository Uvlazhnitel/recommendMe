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
  if (error instanceof TmdbError) {
    if (error.status === 404) return reply({ error: 'movie_not_found' }, 404);
    return reply({ error: 'tmdb_unavailable', message: 'TMDB is unavailable or its server configuration is invalid.' }, 502);
  }
  return reply({ error: 'catalog_unavailable', message: 'The local catalog could not complete the operation.' }, 503);
}
// Dependencies keep route tests on synthetic databases and mocked HTTP only.
export function movieHandlers(dependencies: { api?: () => CatalogApi; open?: typeof openDatabase;
  backup?: Parameters<typeof addCatalogMovie>[3] } = {}) {
  return {
    async search(request: Request) {
      const url = new URL(request.url);
      const query = url.searchParams.get('q')?.trim() ?? '';
      const yearValue = url.searchParams.get('year');
      if (!query || [...query].length > 200 || (yearValue !== null && (!/^\d{1,4}$/.test(yearValue) || Number(yearValue) < 1))) {
        return reply({ error: 'invalid_search', message: 'q must contain 1–200 characters; year must be an integer from 1 to 9999.' }, 400);
      }
      try { return reply(await (dependencies.api ?? manualApi)().searchInteractive(query, yearValue === null ? undefined : Number(yearValue))); }
      catch (error) { return failure(error); }
    },
    async add(request: Request) {
      let body: unknown;
      try {
        body = await readJsonBody(request);
      } catch (error) { return reply({ error: error instanceof JsonInputError ? error.code : 'invalid_json' }, error instanceof JsonInputError ? error.status : 400); }
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 ||
        !('tmdb_id' in body) || !validTmdbId(body.tmdb_id)) return reply({ error: 'invalid_tmdb_id', message: 'Provide only a positive integer tmdb_id.' }, 400);
      let db: ReturnType<typeof openDatabase> | undefined;
      try {
        db = (dependencies.open ?? openDatabase)();
        // Delay API construction until details are needed: existing IDs work without a configured key.
        const result = await addCatalogMovie(db, { details: id => (dependencies.api ?? manualApi)().details(id) }, body.tmdb_id, dependencies.backup);
        return reply(result, result.status === 'created' ? 201 : result.status === 'possible_duplicate' ? 409 : 200);
      } catch (error) { return failure(error); }
      finally { db?.close(); }
    },
  };
}
