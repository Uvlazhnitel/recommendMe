import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { migrateDatabase, SCHEMA_VERSION } from '../../src/lib/migrations';
import { buildTasteContext } from '../../src/lib/taste-context';
import type { MovieCandidate } from '../../src/lib/candidates';

export const movie = (id = 201): MovieCandidate => ({ tmdb_id: id, media_type: 'movie', title: `Film ${id}`, original_title: null,
  year: 2000, overview: 'A verified story.', genres: [{ id: 1, name: 'Drama' }], runtime: 100, directors: [{ id: 10, name: 'Director' }],
  vote_count: 0, popularity: 0, source: 'llm', poster_path: '/poster.jpg', backdrop_path: '/backdrop.jpg' });
export const report = (ids = [201,202]) => ({ mode: 'live', status: 'ok', candidates: ids.map(movie) });
export const choice = (tmdb_id = 201) => ({ tmdb_id, why_fit: 'A personal parallel supported by your high rating.',
  possible_mismatch: 'The pacing may be less appealing; this remains uncertain.', evidence: [{ movie_id: 1, rating_100: 100 }] });
export function fixture(version = SCHEMA_VERSION) {
  const dir = mkdtempSync(join(tmpdir(), 'recommendations-ui-')), path = join(dir, 'movies.sqlite');
  const db = new Database(path); db.pragma('foreign_keys=ON');
  if (version === SCHEMA_VERSION) migrateDatabase(db);
  else {
    for (const file of ['001_initial','002_letterboxd_rating_date','003_tmdb_metadata','004_recommendation_memory','005_movie_backdrop','006_movie_reviews','007_evaluation'].slice(0,version)) db.exec(readFileSync(`migrations/${file}.sql`, 'utf8'));
    db.pragma(`user_version=${version}`);
  }
  migrateDatabase(db);
  db.exec(`INSERT INTO movies(id,title,release_year,tmdb_id,media_type,runtime_minutes,overview,genres_json,directors_json) VALUES
    (1,'Favourite',2000,101,'movie',100,'Confirmed story','[{"id":1,"name":"Drama"}]','[{"id":10,"name":"Director"}]'),
    (2,'Low',2000,102,'movie',100,'Confirmed story','[{"id":1,"name":"Drama"}]','[{"id":10,"name":"Director"}]'),
    (3,'Unrated',2000,103,'movie',100,'Confirmed story','[{"id":1,"name":"Drama"}]','[{"id":10,"name":"Director"}]');
    INSERT INTO user_movies(user_id,movie_id,watched,rating_100) VALUES('ilya',1,1,100),('ilya',2,1,0),('ilya',3,1,NULL)`);
  const context = buildTasteContext(db, 'ilya');
  db.prepare('INSERT INTO taste_profile(user_id,profile_json) VALUES(\'ilya\',?)').run(JSON.stringify({
    strong_preferences: [{ summary: 'Positive', explanation: 'High evidence.', kind: 'observation', uncertainty: 'Small sample.', evidence: [{ movie_id: 1, rating_100: 100 }] }],
    negative_patterns: [{ summary: 'Negative', explanation: 'Low evidence.', kind: 'hypothesis', uncertainty: 'Uncertain cause.', evidence: [{ movie_id: 2, rating_100: 0 }] }],
    contrasts: [{ higher: { movie_id: 1, rating_100: 100 }, lower: { movie_id: 2, rating_100: 0 }, similarity: 'Shared director.', possible_difference: 'Unconfirmed.', uncertainty: 'Limited.' }],
    uncertainties: [{ description: 'Small sample.', evidence: [] }], profile_version: 1, generated_at: new Date().toISOString(), ratings_count: 2, ratings_snapshot: context.snapshot,
    context_fingerprint: context.fingerprint, prompt_version: 1, schema_version: 1, contrast_pairs_count: 1, requested_model: 'mock-model', model: 'mock-model', response_id: null, usage: null,
  }));
  return { db, dir, path, open: (options: { readonly?: boolean } = {}) => { const connection = new Database(path, options); connection.pragma('foreign_keys=ON'); return connection; },
    cleanup() { if (db.open) db.close(); rmSync(dir, { recursive: true, force: true }); } };
}
export function mockProvider(ids = [201,202], intercept?: (url: URL, init?: RequestInit) => Response | Promise<Response> | undefined) {
  const calls: string[] = [], bodies: Record<string, unknown>[] = [];
  return { calls, bodies, fetch: (async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input)); calls.push(url.hostname + url.pathname);
    const override = intercept?.(url, init); if (override) return override;
    if (url.hostname === 'api.openai.com') {
      const body = JSON.parse(String(init?.body)); bodies.push(body);
      const output = body.text.format.name === 'movie_candidates' ? { candidates: ids.map(id => ({ title: `Film ${id}`, year: 2000 })) } : { recommendations: ids.slice(0,5).map(choice) };
      return Response.json({ status: 'completed', model: 'mock-model', usage: { input_tokens: 50, output_tokens: 20 }, output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(output) }] }] });
    }
    if (url.hostname !== 'api.themoviedb.org') throw Error('External network forbidden in this fixture');
    if (url.pathname.endsWith('/recommendations')) return Response.json({ results: [] });
    if (url.pathname.includes('/search/')) {
      const id = Number(url.searchParams.get('query')?.replace('Film ',''));
      return Response.json({ total_pages: 1, results: ids.includes(id) ? [{ id, title: `Film ${id}`, original_title: `Film ${id}`, release_date: '2000-01-01' }] : [] });
    }
    const id = Number(url.pathname.split('/').at(-1));
    return Response.json({ id, title: `Film ${id}`, original_title: `Film ${id}`, release_date: '2000-01-01', runtime: 100, overview: 'A verified story.',
      genres: [{ id: 1, name: 'Drama' }], poster_path: '/poster.jpg', backdrop_path: '/backdrop.jpg', credits: { cast: [], crew: [{ id: 10, name: 'Director', job: 'Director' }] } });
  }) as typeof fetch };
}
export const config = () => ({ apiKey: 'mock-openai', model: 'mock-model', tmdbKey: 'mock-tmdb' });
export const personal = (db: Database.Database) => JSON.stringify(['user_movies','taste_profile'].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all().map(row => table === 'user_movies' ? { review_text: null, ...row as object } : row)));
