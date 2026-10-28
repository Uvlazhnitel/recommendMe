import { fixture, movie, choice } from './recommendation-screen';
import { buildTasteContext } from '../../src/lib/taste-context';
import type { MovieCandidate } from '../../src/lib/candidates';

export function candidatesFixture() {
  const f = fixture();
  const add = (id: number, rating: number | null, genres: number[], directors: number[]) => {
    f.db.prepare(`INSERT INTO movies(id,title,release_year,tmdb_id,media_type,runtime_minutes,overview,genres_json,directors_json)
      VALUES(?,?,2000,?,'movie',100,'A confirmed story.',?,?)`).run(id, `History ${id}`, id + 10000,
      JSON.stringify(genres.map(id => ({ id, name: `Genre ${id}` }))), JSON.stringify(directors.map(id => ({ id, name: `Director ${id}` }))));
    f.db.prepare('INSERT INTO user_movies(movie_id,watched,rating_100) VALUES(?,1,?)').run(id, rating);
  };
  // The old novelty sum favours many directors on four animation seeds.
  for (let i = 0; i < 4; i++) add(10 + i, 100, [16, 12], [400 + i * 10, 401 + i * 10, 402 + i * 10]);
  add(14, 100, [27, 53], [800, 801]);
  add(20, 90, [1, 2], [900]);
  for (let i = 0; i < 4; i++) {
    add(30 + i, 90, [3 + i * 2, 4 + i * 2], [100 + i]);
    add(40 + i, 90, [3 + i * 2, 4 + i * 2], [200 + i]);
  }
  const candidate = (id: number, source: MovieCandidate['source'], genres: number[], director: number): MovieCandidate => ({ ...movie(id),
    original_title: `Film ${id}`, source, overview: 'A verified story. '.repeat(40).trim(),
    genres: genres.map(id => ({ id, name: `Genre ${id}` })), directors: [{ id: director, name: `Director ${director}` }] });
  const candidates = [
    ...Array.from({ length: 24 }, (_, i) => candidate(1000 + i, 'llm', i < 20 ? [16, 12] : [901], i < 20 ? 400 : 9999)),
    ...Array.from({ length: 20 }, (_, i) => candidate(2000 + i, 'tmdb', i < 16 ? [1, 2] : [3 + (i - 16) * 2, 4 + (i - 16) * 2], i < 16 ? 10 : 100 + i - 16)),
  ];
  const taste = buildTasteContext(f.db);
  const profile = JSON.parse((f.db.prepare('SELECT profile_json FROM taste_profile').get() as { profile_json: string }).profile_json);
  f.db.prepare('UPDATE taste_profile SET profile_json=?').run(JSON.stringify({ ...profile, ratings_count: taste.snapshot.length, ratings_snapshot: taste.snapshot, context_fingerprint: taste.fingerprint }));
  const calls: string[] = [], bodies: Record<string, unknown>[] = [];
  const identity = (row: MovieCandidate) => ({ id: row.tmdb_id, title: row.title, original_title: row.original_title, release_date: '2000-01-01' });
  const fetch = (async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input)); calls.push(url.hostname + url.pathname);
    if (url.hostname === 'api.openai.com') {
      const body = JSON.parse(String(init?.body)); bodies.push(body);
      const ids: number[] = body.text.format.schema.properties.recommendations?.items.properties.tmdb_id.enum ?? [];
      const output = body.text.format.name === 'movie_candidates' ? { candidates: candidates.filter(row => row.source === 'llm').map(({ title, year }) => ({ title, year })) }
        : { recommendations: ids.slice(0, 5).map(choice) };
      return Response.json({ status: 'completed', model: 'mock-model', usage: { input_tokens: 100, output_tokens: 50 }, output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(output) }] }] });
    }
    if (url.hostname !== 'api.themoviedb.org') throw Error('External network forbidden');
    if (url.pathname.endsWith('/recommendations')) return Response.json({ results: candidates.filter(row => row.source === 'tmdb').map(identity) });
    if (url.pathname.includes('/search/')) return Response.json({ total_pages: 1, results: candidates.filter(row => row.title === url.searchParams.get('query')).map(identity) });
    const row = candidates.find(row => row.tmdb_id === Number(url.pathname.split('/').at(-1)))!;
    return Response.json({ ...identity(row), overview: row.overview, runtime: row.runtime, genres: row.genres, vote_count: row.vote_count, popularity: row.popularity,
      poster_path: row.poster_path, backdrop_path: row.backdrop_path, credits: { cast: [], crew: row.directors!.map(person => ({ ...person, job: 'Director' })) } });
  }) as typeof globalThis.fetch;
  return { ...f, add, candidates, fetch, calls, bodies };
}
