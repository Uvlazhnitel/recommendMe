import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { SCHEMA_VERSION } from '../src/lib/migrations';
import { addCatalogMovie } from '../src/lib/movie-catalog';
import { movieHandlers } from '../src/lib/movie-http';
import { createTmdbClient, parseDetails, TmdbError } from '../src/lib/tmdb';

const raw = (id = 10, title = 'Dune', date = '2021-10-01') => ({ id, title, original_title: title, release_date: date });
const rich = (id = 10) => ({ ...raw(id), runtime: 155, overview: 'Verified overview', genres: [{ id: 1, name: 'Drama' }],
  poster_path: '/poster.jpg', original_language: 'en', vote_average: 7, vote_count: 100, popularity: 3,
  credits: { cast: [{ id: 2, name: 'Actor', order: 0, character: 'Role' }], crew: [{ id: 3, name: 'Director', job: 'Director' }] } });
function fixture(version = 4) {
  const folder = mkdtempSync(join(tmpdir(), 'catalog-')); const path = join(folder, 'movies.sqlite'); const db = new Database(path);
  db.pragma('foreign_keys=ON');
  for (const file of ['001_initial.sql', '002_letterboxd_rating_date.sql', '003_tmdb_metadata.sql', '004_recommendation_memory.sql'].slice(0, version)) db.exec(readFileSync(`migrations/${file}`, 'utf8'));
  db.pragma(`user_version=${version}`);
  db.exec("INSERT INTO movies (title,release_year,letterboxd_uri) VALUES ('Legacy',2000,'https://example.test/legacy'); INSERT INTO user_movies (movie_id,watched,rating_100,original_rating_stars,rating_source,not_interested) VALUES (1,1,0,0,'letterboxd',1); INSERT INTO recommendations (movie_id) VALUES (1); INSERT INTO taste_profile (profile_json) VALUES ('{}')");
  return { db, folder, path, close: () => { if (db.open) db.close(); rmSync(folder, { recursive: true, force: true }); } };
}
function snapshot(db: Database.Database) {
  return JSON.stringify(['user_movies', 'recommendations', 'taste_profile'].map(table => db.prepare(table === 'recommendations' ? 'SELECT id,movie_id,recommended_at,why_fit,possible_mismatch,rejected FROM recommendations' : `SELECT * FROM ${table}`).all().map(row => table === 'user_movies' ? { review_text: null, ...row as object } : row)));
}
function mocked(handler: (url: URL) => unknown) {
  const urls: URL[] = []; let clock = 0;
  const api = createTmdbClient('synthetic-key', { fetch: async input => { const url = new URL(String(input)); urls.push(url); return Response.json(handler(url)); },
    now: () => clock, sleep: async ms => { clock += ms; } });
  return { api, urls };
}
const post = (value: unknown) => new Request('http://localhost/api/movies', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });

test('interactive search preserves same-name years, optional year, poster, page limit and strict search', async () => {
  const { api, urls } = mocked(() => ({ total_pages: 2, results: [raw(), raw(11, 'Dune', '1984-12-14'), raw()] }));
  const first = await api.searchInteractive('Dune');
  assert.equal(first.results.length, 2); assert.equal(first.has_more, true); assert.equal(first.results[0].poster_path, null);
  assert.equal(urls[0].searchParams.has('year'), false); assert.equal(urls[0].searchParams.get('language'), 'en-US');
  await api.searchInteractive('Dune', 1984); assert.equal(urls[1].searchParams.get('year'), '1984');
  const strict = await api.search('Dune', 2021); assert.equal(strict.complete, true); assert.equal(urls.length, 4);
  assert.ok(urls.every(url => url.pathname === '/3/search/movie'));
});

test('catalog migrates 3→4 after backup; stores verified details and leaves personal data unchanged', async () => {
  const f = fixture(3);
  try {
    const before = snapshot(f.db); const { api, urls } = mocked(() => rich());
    const result = await addCatalogMovie(f.db, api, 10); assert.equal(result.status, 'created'); assert.equal(urls.length, 1);
    assert.equal(urls[0].pathname, '/3/movie/10'); assert.equal(urls[0].searchParams.get('append_to_response'), 'credits');
    assert.equal(f.db.pragma('user_version', { simple: true }), SCHEMA_VERSION); assert.equal(snapshot(f.db), before);
    const row = f.db.prepare('SELECT * FROM movies WHERE tmdb_id=10').get() as Record<string, unknown>;
    assert.equal(row.title, 'Dune'); assert.equal(row.media_type, 'movie'); assert.equal(row.runtime_minutes, 155);
    assert.equal(row.letterboxd_uri, null); assert.equal(row.tmdb_enrichment_status, 'matched'); assert.equal(row.original_language, 'en');
    assert.equal(JSON.parse(String(row.directors_json))[0].id, 3); assert.equal(JSON.parse(String(row.credits_json)).cast[0].id, 2);
    const backup = new Database(join(f.folder, 'backups', readdirSync(join(f.folder, 'backups'))[0]), { readonly: true });
    assert.equal(backup.pragma('user_version', { simple: true }), 3); assert.equal(snapshot(backup), before); backup.close();
    const all = JSON.stringify(f.db.prepare('SELECT * FROM movies').all());
    assert.equal((await addCatalogMovie(f.db, { details: async () => { throw Error('Unexpected network'); } }, 10)).status, 'already_exists');
    assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM movies').all()), all);
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
    f.db.close(); const reopened = new Database(f.path, { readonly: true }); assert.equal((reopened.prepare('SELECT count(*) n FROM movies').get() as { n: number }).n, 2); reopened.close();
  } finally { f.close(); }
});

test('existing recommendation film is reused without metadata, rating or hidden-state changes', async () => {
  const f = fixture(); try {
    f.db.prepare('UPDATE movies SET tmdb_id=10 WHERE id=1').run();
    const before = snapshot(f.db); const film = f.db.prepare('SELECT * FROM movies').get();
    assert.deepEqual(await addCatalogMovie(f.db, { details: async () => { throw Error('No network'); } }, 10), { status: 'already_exists', movie_id: 1, tmdb_id: 10 });
    assert.deepEqual(f.db.prepare('SELECT * FROM movies').get(), film); assert.equal(snapshot(f.db), before);
  } finally { f.close(); }
});

test('potential legacy matches, including original title and unknown year, never merge', async () => {
  for (const year of [2021, null]) {
    const f = fixture(3); try {
      f.db.prepare('UPDATE movies SET original_title=?,release_year=? WHERE id=1').run(' DUNE! ', year);
      const before = JSON.stringify(f.db.prepare('SELECT * FROM movies').all());
      let result = await addCatalogMovie(f.db, { details: async () => parseDetails(rich()) }, 10);
      assert.equal(result.status, 'possible_duplicate'); assert.equal(f.db.pragma('user_version', { simple: true }), 3);
      assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM movies').all()), before);
      f.db.prepare('INSERT INTO movies(title,release_year) VALUES (?,?)').run('Dune', 2021);
      result = await addCatalogMovie(f.db, { details: async () => parseDetails(rich()) }, 10);
      assert.equal(result.status === 'possible_duplicate' && result.matches.length, 2);
    } finally { f.close(); }
  }
});

test('different years stay distinct; missing metadata stays NULL and shorts are catalog-only', async () => {
  const f = fixture(); try {
    f.db.prepare("UPDATE movies SET title='Dune', release_year=1984 WHERE id=1").run();
    for (const [id, runtime] of [[10, undefined], [11, 50]] as const) {
      await addCatalogMovie(f.db, { details: async () => parseDetails({ ...raw(id), runtime }) }, id);
      const row = f.db.prepare('SELECT * FROM movies WHERE tmdb_id=?').get(id) as Record<string, unknown>;
      for (const key of ['overview', 'genres_json', 'poster_path', 'directors_json', 'credits_json', 'original_language', 'tmdb_vote_average']) assert.equal(row[key], null);
      assert.equal(row.runtime_minutes, runtime ?? null);
    }
    assert.equal((f.db.prepare('SELECT count(*) n FROM user_movies').get() as { n: number }).n, 1);
    assert.equal((f.db.prepare("SELECT count(*) n FROM movies WHERE media_type='movie' AND runtime_minutes>=60").get() as { n: number }).n, 0);
  } finally { f.close(); }
});

test('invalid ID, TMDB failure and invalid details never write; backup failure prevents migration', async () => {
  const f = fixture(3); try {
    const before = snapshot(f.db); let calls = 0;
    const api = { details: async () => { calls++; throw new TmdbError('Synthetic failure'); } };
    for (const id of [0, -1, 1.5, NaN]) await assert.rejects(addCatalogMovie(f.db, api, id));
    assert.equal(calls, 0); await assert.rejects(addCatalogMovie(f.db, api, 10));
    await assert.rejects(addCatalogMovie(f.db, { details: async () => parseDetails({ ...rich(), media_type: 'tv' }) }, 10));
    await assert.rejects(addCatalogMovie(f.db, { details: async () => parseDetails(rich()) }, 10, { backup: async () => { throw Error('Backup failure'); } }));
    assert.equal(f.db.pragma('user_version', { simple: true }), 3); assert.equal(snapshot(f.db), before);
    assert.equal((f.db.prepare('SELECT count(*) n FROM movies').get() as { n: number }).n, 1);
  } finally { f.close(); }
});

test('SQL failure rolls back movie insertion and preserves all history', async () => {
  const f = fixture(); try {
    const before = snapshot(f.db);
    f.db.exec("CREATE TRIGGER fail_catalog AFTER INSERT ON movies BEGIN SELECT RAISE(ABORT,'Synthetic failure'); END;");
    await assert.rejects(addCatalogMovie(f.db, { details: async () => parseDetails(rich()) }, 10));
    assert.equal(snapshot(f.db), before); assert.equal((f.db.prepare('SELECT count(*) n FROM movies').get() as { n: number }).n, 1);
  } finally { f.close(); }
});

test('two connections adding concurrently recheck identity inside transaction', async () => {
  const f = fixture(); const second = new Database(f.path); second.pragma('foreign_keys=ON');
  try {
    const api = { details: async () => parseDetails(rich()) };
    const results = await Promise.all([addCatalogMovie(f.db, api, 10), addCatalogMovie(second, api, 10)]);
    assert.deepEqual(results.map(r => r.status).sort(), ['already_exists', 'created']);
    assert.equal((f.db.prepare('SELECT count(*) n FROM movies WHERE tmdb_id=10').get() as { n: number }).n, 1);
  } finally { second.close(); f.close(); }
});

test('state added while HTTP is pending is checked before write', async () => {
  const f = fixture(); try {
    const result = await addCatalogMovie(f.db, { details: async () => {
      f.db.prepare("INSERT INTO movies(title,release_year) VALUES ('Dune',2021)").run(); return parseDetails(rich());
    } }, 10);
    assert.equal(result.status, 'possible_duplicate');
  } finally { f.close(); }
});

test('HTTP search validates input without SQLite and POST validates before opening it', async () => {
  let opens = 0; const { api } = mocked(() => ({ total_pages: 1, results: [raw()] }));
  const handlers = movieHandlers({ api: () => api, open: () => { opens++; throw Error('Forbidden'); } });
  for (const suffix of ['?q=', `?q=${'a'.repeat(201)}`, '?q=Dune&year=0', '?q=Dune&year=2.5', '?q=Dune&year=10000']) assert.equal((await handlers.search(new Request('http://localhost/' + suffix))).status, 400);
  const response = await handlers.search(new Request('http://localhost/?q=Dune&year=2021'));
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  for (const body of [{}, { tmdb_id: '10' }, { tmdb_id: 1.2 }, { tmdb_id: 0 }, { tmdb_id: 10, watched: 1 }]) assert.equal((await handlers.add(post(body))).status, 400);
  assert.equal((await handlers.add(new Request('http://localhost/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' }))).status, 400);
  assert.equal((await handlers.add(post({ tmdb_id: 10, payload: 'a'.repeat(2000) }))).status, 400);
  assert.equal(opens, 0);
});

test('HTTP add returns created, already_exists, possible_duplicate and sanitized errors', async () => {
  const f = fixture(); try {
    const handlers = movieHandlers({ api: () => ({ ...mocked(() => rich()).api }), open: () => new Database(f.path) });
    assert.equal((await handlers.add(post({ tmdb_id: 10 }))).status, 201);
    assert.equal((await handlers.add(post({ tmdb_id: 10 }))).status, 200);
    f.db.prepare("UPDATE movies SET title='Dune',release_year=2021 WHERE id=1").run();
    assert.equal((await handlers.add(post({ tmdb_id: 11 }))).status, 502); // details ID differs
    const conflict = movieHandlers({ api: () => mocked(() => rich(11)).api, open: () => new Database(f.path) });
    assert.equal((await conflict.add(post({ tmdb_id: 11 }))).status, 409);
    for (const status of [404, 500]) {
      const failed = movieHandlers({ api: () => ({ ...mocked(() => rich()).api, details: async () => { throw new TmdbError('secret-url', false, status); } }), open: () => new Database(f.path) });
      const response = await failed.add(post({ tmdb_id: 12 })); assert.equal(response.status, status === 404 ? 404 : 502);
      assert.ok(!(await response.text()).includes('secret-url'));
    }
  } finally { f.close(); }
});
