// Node-only: shared by the server and CLI, never imported by Client Components.
import { setTimeout as delay } from 'node:timers/promises';

export class TmdbError extends Error {
  constructor(message: string, public readonly stop = false, public readonly status?: number) { super(message); }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TmdbError('Invalid TMDB object.');
  return value as Record<string, unknown>;
}
function number(value: unknown, integer = false, minimum = 0, maximum = Infinity): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum || (integer && !Number.isSafeInteger(value))) throw new TmdbError('Invalid TMDB numeric field.');
  return value;
}
function id(value: unknown): number {
  const result = number(value, true, 1);
  if (result === null) throw new TmdbError('Missing TMDB ID.');
  return result;
}
function string(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw new TmdbError('Invalid TMDB text field.');
  return value.trim() || null;
}
function title(value: unknown): string {
  const result = string(value);
  if (!result) throw new TmdbError('Missing TMDB title.');
  return result;
}
function array(value: unknown): unknown[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) throw new TmdbError('Invalid TMDB list.');
  return value;
}
function year(value: unknown): number | null {
  const date = string(value);
  if (!date) return null;
  const parsed = new Date(date + 'T00:00:00Z');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) throw new TmdbError('Invalid TMDB release date.');
  return Number(date.slice(0, 4));
}
export type Candidate = { id: number; title: string; original_title: string | null; year: number | null };
function candidate(value: unknown): Candidate {
  const row = object(value);
  if (row.media_type !== undefined && row.media_type !== 'movie') throw new TmdbError('TMDB returned a non-movie item.');
  return { id: id(row.id), title: title(row.title), original_title: string(row.original_title), year: year(row.release_date) };
}
export function normalizeTitle(value: string) {
  return value.normalize('NFKC').toLowerCase().replace(/[’‘'"“”]/g, '').replace(/[\p{P}\p{Z}\s]+/gu, ' ').trim();
}
export function matches(source: { title: string; release_year: number | null }, target: Candidate) {
  return source.release_year !== null && source.release_year === target.year &&
    [target.title, target.original_title].some(value => value !== null && normalizeTitle(value) === normalizeTitle(source.title));
}
function person(value: unknown) {
  const row = object(value);
  return { id: id(row.id), name: title(row.name), job: string(row.job), character: string(row.character), order: number(row.order, true) };
}
export function parseDetails(value: unknown) {
  const row = object(value);
  const identity = candidate(row);
  const credits = row.credits == null ? null : object(row.credits);
  const crew = credits ? array(credits.crew)?.map(person) ?? null : null;
  const cast = credits ? array(credits.cast)?.map(person) ?? null : null;
  const roles = new Set(['Director', 'Writer', 'Screenplay', 'Story', 'Producer', 'Executive Producer']);
  const runtime = number(row.runtime, true);
  return { ...identity, overview: string(row.overview),
    genres: array(row.genres)?.map(value => { const genre = object(value); return { id: id(genre.id), name: title(genre.name) }; }) ?? null,
    runtime: runtime === 0 ? null : runtime, poster_path: string(row.poster_path), backdrop_path: string(row.backdrop_path), original_language: string(row.original_language),
    vote_average: number(row.vote_average, false, 0, 10), vote_count: number(row.vote_count, true), popularity: number(row.popularity),
    directors: crew?.filter(value => value.job === 'Director').map(({ id, name }) => ({ id, name })) ?? null,
    credits: credits ? {
      cast: cast?.sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity)).slice(0, 10).map(({ id, name, character }) => ({ id, name, character })) ?? null,
      crew: crew?.filter(value => value.job !== null && roles.has(value.job)).map(({ id, name, job }) => ({ id, name, job })) ?? null,
    } : null,
  };
}
export type Details = ReturnType<typeof parseDetails>;
export type RepairWork = { type: 'movie' | 'tv' | 'episode' | 'season'; id: number; details: Details;
  presentation: { title: string; overview: string | null }; imdb: string | null; titles: string[]; years: number[];
  showId?: number; season?: number; episode?: number };
export type RepairHit = { type: 'movie' | 'tv' | 'episode' | 'season'; id: number; showId?: number; season?: number; episode?: number };


type Dependencies = { fetch?: typeof fetch; sleep?: (ms: number) => Promise<unknown>; now?: () => number; timeoutMs?: number; maxRequests?: number };
export function createTmdbClient(apiKey: string | undefined, dependencies: Dependencies = {}) {
  if (!apiKey?.trim()) throw new TmdbError('TMDB_API_KEY is not configured. Set it in the server environment.', true);
  if (dependencies.maxRequests !== undefined && (!Number.isSafeInteger(dependencies.maxRequests) || dependencies.maxRequests < 1)) throw new TmdbError('Invalid TMDB request budget.', true);
  const requestFetch = dependencies.fetch ?? fetch;
  const sleep = dependencies.sleep ?? delay;
  const now = dependencies.now ?? Date.now;
  let previousStart: number | null = null;
  const stats = { requests: 0, failedRequests: 0 };
  async function request(path: string, params: Record<string, string>, language = 'en-US'): Promise<unknown> {
    const url = new URL(`https://api.themoviedb.org/3${path}`);
    url.search = new URLSearchParams({ ...params, api_key: apiKey!.trim(), language }).toString();
    for (let attempt = 0; attempt < 3; attempt++) {
      if (stats.requests >= (dependencies.maxRequests ?? Infinity)) throw new TmdbError('TMDB request budget exhausted.', true);
      if (previousStart !== null) await sleep(Math.max(0, 250 - (now() - previousStart)));
      previousStart = now(); stats.requests++;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), dependencies.timeoutMs ?? 10000);
      let retryAfter = 0;
      try {
        const response = await requestFetch(url, { signal: controller.signal, redirect: 'error', cache: 'no-store' });
        if (!response.ok) {
          stats.failedRequests++;
          if (response.status === 401 || response.status === 403) throw new TmdbError('TMDB authorization failed.', true);
          const header = response.headers.get('retry-after');
          if (header && (response.status === 429 || response.status >= 500)) {
            retryAfter = /^\d+(?:\.\d+)?$/.test(header) ? Number(header) * 1000 : Math.max(0, Date.parse(header) - now());
            if (!Number.isFinite(retryAfter)) retryAfter = 0;
            if (retryAfter > 60000) throw new TmdbError('TMDB requests a pause longer than 60 seconds. Resume later.', true);
          }
          if (response.status !== 429 && response.status < 500) throw new TmdbError(`TMDB HTTP ${response.status}.`, false, response.status);
        } else {
          try { return await response.json(); }
          catch {
            if (controller.signal.aborted) throw new Error('Response timeout.');
            stats.failedRequests++; throw new TmdbError('TMDB returned invalid JSON.');
          }
        }
      } catch (error) {
        if (error instanceof TmdbError) throw error;
        stats.failedRequests++;
        // Discard raw network messages: they can contain a URL with the secret.
      } finally { clearTimeout(timer); }
      if (attempt < 2) await sleep(Math.max((attempt + 1) * 1000, retryAfter));
    }
    throw new TmdbError('TMDB request failed after three attempts.');
  }
  return {
    stats,
    async repairFind(imdb: string): Promise<RepairHit[]> {
      if (!/^tt\d+$/.test(imdb)) throw new TmdbError('Invalid IMDb ID.');
      const body = object(await request(`/find/${imdb}`, { external_source: 'imdb_id' }));
      const hits: RepairHit[] = [];
      for (const [key, type] of [['movie_results','movie'],['tv_results','tv'],['tv_episode_results','episode']] as const) {
        for (const value of array(body[key]) ?? []) {
          const row = object(value);
          hits.push({ type, id: id(row.id), ...(type === 'episode' ? { showId: id(row.show_id), season: number(row.season_number,true,0)!, episode: id(row.episode_number) } : {}) });
        }
      }
      return hits;
    },
    async repairSearch(query: string, releaseYear: number | null, type: 'movie'|'tv') {
      const hits = new Map<number, Candidate>(); let complete = true;
      for (const language of ['ru-RU','en-US']) {
        for (let page = 1; page <= 5; page++) {
          const params: Record<string,string> = { query, page: String(page), include_adult: 'true' };
          if (releaseYear !== null) params[type === 'movie' ? 'year' : 'first_air_date_year'] = String(releaseYear);
          const body = object(await request(`/search/${type}`, params, language));
          const pages = number(body.total_pages, true);
          if (pages === null || !Array.isArray(body.results)) throw new TmdbError('Invalid repair search.');
          for (const value of body.results) { const row = object(value); const c = { id: id(row.id), title: title(type === 'movie' ? row.title : row.name), original_title: string(type === 'movie' ? row.original_title : row.original_name), year: year(type === 'movie' ? row.release_date : row.first_air_date) }; hits.set(c.id,c); }
          if (pages <= page) break;
          if (page === 5) complete = false;
        }
      }
      return { candidates: [...hits.values()], complete };
    },
    async repairSeasons(showId: number): Promise<RepairHit[]> {
      id(showId); const body=object(await request(`/tv/${showId}`,{}));
      if(id(body.id)!==showId)throw new TmdbError('Wrong TV identity.');
      return (array(body.seasons)??[]).map(value=>{const s=object(value);const season=number(s.season_number,true,0);if(season===null)throw new TmdbError('Missing season number.');return {type:'season',id:id(s.id),showId,season};});
    },
    async repairWork(hit: RepairHit): Promise<RepairWork> {
      id(hit.id);
      const path = hit.type === 'season' ? `/tv/${id(hit.showId)}/season/${number(hit.season,true,0)}` : hit.type === 'episode' ? `/tv/${id(hit.showId)}/season/${number(hit.season,true,0)}/episode/${id(hit.episode)}` : `/${hit.type}/${hit.id}`;
      const row = object(await request(path, { append_to_response: hit.type === 'movie' ? 'credits,external_ids,alternative_titles,release_dates' : 'credits,external_ids,alternative_titles' }));
      if (id(row.id) !== hit.id) throw new TmdbError('Wrong repair identity.');
      const localized = object(await request(path, {}, 'ru-RU'));
      if (id(localized.id) !== hit.id) throw new TmdbError('Wrong localized repair identity.');
      const movieLike = hit.type === 'movie' ? row : { ...row, title: row.name, original_title: row.original_name ?? row.name, release_date: row.air_date ?? row.first_air_date, runtime: hit.type === 'episode' ? row.runtime : hit.type === 'season' ? (array(row.episodes)??[]).reduce<number>((sum,value)=>sum+(number(object(value).runtime,true)??0),0) : null, poster_path: hit.type === 'episode' ? row.still_path : row.poster_path, backdrop_path: hit.type === 'episode' ? row.still_path : row.backdrop_path };
      const details = parseDetails({ ...movieLike, media_type: 'movie' });
      const localizedTitle = string(hit.type === 'movie' ? localized.title : localized.name);
      const localizedOverview = string(localized.overview);
      const external = row.external_ids == null ? {} : object(row.external_ids);
      const imdb = string(external.imdb_id);
      if (imdb && !/^tt\d+$/.test(imdb)) throw new TmdbError('Invalid external IMDb ID.');
      const titles = new Set([details.title, details.original_title, localizedTitle].filter((s): s is string => !!s));
      if (row.alternative_titles) { const a=object(row.alternative_titles); for (const v of array(a.titles ?? a.results) ?? []) { const t=string(object(v).title); if(t)titles.add(t); } }
      const years = new Set<number>(details.year === null ? [] : [details.year]);
      if (row.release_dates) for(const v of array(object(row.release_dates).results) ?? []) for(const d of array(object(v).release_dates) ?? []) {
        const date=string(object(d).release_date); if(date&&/^\d{4}-\d{2}-\d{2}T/.test(date)) years.add(Number(date.slice(0,4)));
      }
      return { ...hit, details, imdb, titles: [...titles], years: [...years], presentation: {
        title: localizedTitle && /[А-Яа-яЁё]/u.test(localizedTitle) ? localizedTitle : details.original_title ?? details.title,
        overview: localizedOverview && /[А-Яа-яЁё]/u.test(localizedOverview) ? localizedOverview : null,
      } };
    },
    async identitySearch(query: string, releaseYear: number | null, mediaType: 'movie'|'tv', language='ru-RU') {
      const params:Record<string,string>={query,page:'1',include_adult:'true'};
      if(releaseYear!==null)params[mediaType==='tv'?'first_air_date_year':'year']=String(releaseYear);
      const body=object(await request(`/search/${mediaType}`,params,language));
      if(!Array.isArray(body.results))throw new TmdbError('Invalid identity search');
      return {candidates:body.results.map(value=>{const r=object(value);return {id:id(r.id),title:title(mediaType==='tv'?r.name:r.title),original_title:string(mediaType==='tv'?r.original_name:r.original_title),year:year(mediaType==='tv'?r.first_air_date:r.release_date)};}),complete:Number(body.total_pages??0)<=1};
    },
    async identityDetails(identityId:number, mediaType:'movie'|'tv', language='ru-RU') {
      id(identityId);const raw=await request(`/${mediaType}/${identityId}`,{append_to_response:'credits'},language);
      if(mediaType==='movie')return {...parseDetails(raw),media_type:mediaType};
      const r=object(raw);if(id(r.id)!==identityId)throw new TmdbError('Wrong TV identity');
      return {id:identityId,title:title(r.name),original_title:string(r.original_name),year:year(r.first_air_date),runtime:null,
        overview:string(r.overview),genres:array(r.genres)?.map(v=>{const g=object(v);return {id:id(g.id),name:title(g.name)};})??null,
        directors:null,poster_path:string(r.poster_path),backdrop_path:string(r.backdrop_path),media_type:mediaType};
    },
    async recommendations(movieId: number) {
      id(movieId);
      const body = object(await request(`/movie/${movieId}/recommendations`, { page: '1' }));
      if (!Array.isArray(body.results) || body.results.length > 20) throw new TmdbError('Invalid TMDB recommendations response.');
      return [...new Map(body.results.map(row => { const parsed = candidate(row); return [parsed.id, parsed] as const; })).values()];
    },
    async presentation(movieId: number) {
      id(movieId);
      const raw = object(await request(`/movie/${movieId}`, {}, 'ru-RU'));
      if (id(raw.id) !== movieId || (raw.media_type !== undefined && raw.media_type !== 'movie')) throw new TmdbError('Invalid movie presentation identity.');
      const localizedTitle = string(raw.title), overview = string(raw.overview);
      return { title: localizedTitle && /[А-Яа-яЁё]/u.test(localizedTitle) ? localizedTitle : string(raw.original_title) ?? title(raw.title),
        overview: overview && /[А-Яа-яЁё]/u.test(overview) ? overview : null };
    },
    async searchInteractive(query: string, releaseYear?: number) {
      const params: Record<string, string> = { query, page: '1', include_adult: 'true' };
      if (releaseYear !== undefined) params.year = String(releaseYear);
      const body = object(await request('/search/movie', params, 'ru-RU'));
      const pages = number(body.total_pages, true);
      if (pages === null || !Array.isArray(body.results) || body.results.length > 20) throw new TmdbError('Invalid TMDB search response.');
      const results = new Map<number, Candidate & { poster_path: string | null }>();
      for (const value of body.results) {
        const parsed = candidate(value);
        results.set(parsed.id, { ...parsed, poster_path: string(object(value).poster_path) });
      }
      return { results: [...results.values()], has_more: pages > 1 };
    },
    async search(title: string, releaseYear: number) {
      const results = new Map<number, Candidate>();
      for (let page = 1; page <= 5; page++) {
        const body = object(await request('/search/movie', { query: title, year: String(releaseYear), page: String(page), include_adult: 'true' }));
        const pages = number(body.total_pages, true);
        if (pages === null || !Array.isArray(body.results)) throw new TmdbError('Invalid TMDB search response.');
        for (const row of body.results) { const parsed = candidate(row); results.set(parsed.id, parsed); }
        if (pages <= page) return { candidates: [...results.values()], complete: true };
      }
      return { candidates: [...results.values()], complete: false };
    },
    async details(movieId: number) {
      id(movieId);
      const details = parseDetails(await request(`/movie/${movieId}`, { append_to_response: 'credits' }));
      if (details.id !== movieId) throw new TmdbError('TMDB returned a different movie ID.');
      return details;
    },
  };
}
export type TmdbClient = ReturnType<typeof createTmdbClient>;
