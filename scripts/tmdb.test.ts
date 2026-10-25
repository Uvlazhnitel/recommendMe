import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { createTmdbClient, matches, parseDetails, TmdbError } from '../src/lib/tmdb';
import { enrichTmdb, type EnrichmentReport } from '../src/lib/tmdb-enrichment';
import { migrateDatabase } from '../src/lib/migrations';
import { openDatabase } from '../src/lib/db';

const key = 'test-key-never-real';
const identity = (id = 10, title = 'Test', release_date = '2000-01-01') => ({ id, title, original_title: title, release_date });
const details = (id = 10, title = 'Test') => ({ ...identity(id, title), overview: 'Verified description', genres: [{ id: 1, name: 'Drama' }],
  runtime: 50, poster_path: '/poster.jpg', original_language: 'en', vote_average: 7.2, vote_count: 100, popularity: 1,
  credits: { crew: [{ id: 1, name: 'Director', job: 'Director' }, { id: 2, name: 'Producer', job: 'Producer' }, { id: 3, name: 'Ignored', job: 'Other' }],
    cast: Array.from({ length: 12 }, (_, index) => ({ id: index + 20, name: `Actor ${index}`, order: 11 - index, character: 'Role' })) } });
const response = (body: unknown, status = 200, headers?: Record<string, string>) => new Response(JSON.stringify(body), { status, headers });
function client(handler: (url: URL, signal: AbortSignal | null | undefined) => Response | Promise<Response>) {
  const calls: URL[] = []; const waits: number[] = []; let clock = 0;
  const requestFetch: typeof fetch = async (input, init) => { const url = new URL(String(input)); calls.push(url); return handler(url, init?.signal); };
  const api = createTmdbClient(key, { fetch: requestFetch, now: () => clock, sleep: async ms => { waits.push(ms); clock += ms; } });
  return { api, calls, waits };
}
function happy() {
  return client(url => url.pathname.includes('/search/') ? response({ total_pages: 1, results: [identity()] }) : response(details()));
}
function fixture(old = false) {
  const directory = mkdtempSync(join(tmpdir(), 'tmdb-'));
  const path = join(directory, 'movies.sqlite'); const db = new Database(path); db.pragma('foreign_keys=ON');
  if (old) {
    db.exec(readFileSync('migrations/001_initial.sql', 'utf8')); db.exec(readFileSync('migrations/002_letterboxd_rating_date.sql', 'utf8')); db.pragma('user_version=2');
  } else migrateDatabase(db);
  db.exec("INSERT INTO movies (title,release_year,letterboxd_uri) VALUES ('Test',2000,'uri:test'); INSERT INTO user_movies (movie_id,watched,rating_100) VALUES (1,1,0); INSERT INTO recommendations (movie_id) VALUES (1); INSERT INTO taste_profile (profile_json) VALUES ('{}')");
  let sequence = 0;
  return { db, directory, path, options: () => ({ backupPath: join(directory, `backup-${sequence++}.sqlite`) }),
    cleanup: () => { db.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('movie client uses v3, en-US, year and appended credits; parses people and short runtime', async () => {
  const { api, calls, waits } = happy();
  const result = await api.search('Test', 2000); const film = await api.details(10);
  assert.equal(result.complete, true); assert.equal(film.runtime, 50);
  assert.deepEqual(film.directors, [{ id: 1, name: 'Director' }]);
  assert.equal(film.credits?.cast?.length, 10); assert.equal(film.credits?.crew?.length, 2);
  assert.equal(film.credits?.cast?.[0].name, 'Actor 11');
  assert.equal(calls[0].origin, 'https://api.themoviedb.org'); assert.equal(calls[0].searchParams.get('year'), '2000');
  assert.ok(calls.every(url => url.searchParams.get('language') === 'en-US'));
  assert.equal(calls[1].searchParams.get('append_to_response'), 'credits'); assert.deepEqual(waits, [250]);
});

test('matching is conservative about year, accents and words; allows safe punctuation normalization', () => {
  const source = { title: '  Test: The—Film! ', release_year: 2000 };
  assert.ok(matches(source, { id: 1, title: 'test the-film', original_title: null, year: 2000 }));
  assert.ok(matches(source, { id: 1, title: 'Different', original_title: 'Test The Film', year: 2000 }));
  assert.ok(!matches(source, { id: 1, title: 'Test Film', original_title: null, year: 2000 }));
  assert.ok(!matches(source, { id: 1, title: 'Test The Film', original_title: null, year: 2001 }));
  assert.ok(!matches({ title: 'Cafe', release_year: 2000 }, { id: 1, title: 'Café', original_title: null, year: 2000 }));
});

test('search paginates, deduplicates IDs and marks truncated result incomplete', async () => {
  const { api, calls } = client(url => response({ total_pages: 2, results: [identity(Number(url.searchParams.get('page')) === 1 ? 10 : 11), identity()] }));
  assert.equal((await api.search('Test', 2000)).candidates.length, 2); assert.equal(calls.length, 2);
  const large = client(() => response({ total_pages: 6, results: [identity()] }));
  assert.equal((await large.api.search('Test', 2000)).complete, false); assert.equal(large.calls.length, 5);
});

test('missing metadata is NULL; invalid IDs, dates, numbers, lists, credits and JSON are rejected', async () => {
  const film = parseDetails(identity());
  assert.equal(film.overview, null); assert.equal(film.directors, null); assert.equal(film.genres, null); assert.equal(film.credits, null);
  assert.deepEqual(parseDetails({ ...identity(), credits: { cast: [], crew: [] }, genres: [] }).directors, []);
  for (const patch of [{ id: -1 }, { title: '' }, { release_date: '2000-02-30' }, { runtime: -1 }, { vote_average: 11 }, { vote_count: 1.5 }, { genres: {} }, { credits: { crew: [{}] } }]) {
    assert.throws(() => parseDetails({ ...identity(), ...patch }), TmdbError);
  }
  const malformed = client(() => new Response('{bad'));
  await assert.rejects(() => malformed.api.details(10), /invalid JSON/);
  const wrongId = client(() => response(details(11)));
  await assert.rejects(() => wrongId.api.details(10), /different movie ID/);
});

test('429/5xx retry with bounded delays and Retry-After; long pauses and auth stop immediately', async () => {
  let n = 0;
  const retry = client(() => ++n === 1 ? response({}, 429, { 'Retry-After': '3' }) : n === 2 ? response({}, 503) : response(details()));
  await retry.api.details(10); assert.equal(retry.calls.length, 3); assert.ok(retry.waits.includes(3000)); assert.ok(retry.waits.includes(2000));
  const exhausted = client(() => response({}, 500));
  await assert.rejects(() => exhausted.api.details(10), /three attempts/); assert.equal(exhausted.calls.length, 3);
  for (const status of [401, 403, 429]) {
    const blocked = client(() => response({}, status, { 'Retry-After': '61' }));
    await assert.rejects(() => blocked.api.details(10), (error: unknown) => error instanceof TmdbError && error.stop);
    assert.equal(blocked.calls.length, 1);
  }
});

test('network errors are sanitized; timeouts abort and retry three times', async () => {
  const net = client(() => { throw new Error(`URL contains ${key}`); });
  await assert.rejects(() => net.api.details(10), error => error instanceof Error && !error.message.includes(key));
  assert.equal(net.calls.length, 3);
  let requests = 0;
  const aborting: typeof fetch = async (_input, init) => new Promise((_resolve, reject) => {
    requests++; init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  const timeout = createTmdbClient(key, { fetch: aborting, timeoutMs: 2, sleep: async () => {} });
  await assert.rejects(() => timeout.details(10), /three attempts/); assert.equal(requests, 3);
});

test('successful enrichment migrates version 2, preserves source and personal data, resumes without requests', async () => {
  const f = fixture(true);
  try {
    const before = ['user_movies', 'recommendations', 'taste_profile'].map(table => f.db.prepare(`SELECT * FROM ${table}`).all());
    const original = f.db.prepare('SELECT title,release_year,letterboxd_uri FROM movies').all();
    const progress: number[] = [];
    const result = await enrichTmdb(f.db, happy().api, { ...f.options(), onProgress: report => progress.push(report.processed) });
    assert.equal(result.matched, 1); assert.deepEqual(progress, [0, 1]); assert.equal(result.remainingWithoutId, 0);
    assert.equal(f.db.pragma('user_version', { simple: true }), 3);
    assert.deepEqual(['user_movies', 'recommendations', 'taste_profile'].map(table => f.db.prepare(`SELECT * FROM ${table}`).all()), before);
    assert.deepEqual(f.db.prepare('SELECT title,release_year,letterboxd_uri FROM movies').all(), original);
    const row = f.db.prepare('SELECT tmdb_title,original_title,tmdb_release_year,runtime_minutes,tmdb_enrichment_status FROM movies').get();
    assert.deepEqual(row, { tmdb_title: 'Test', original_title: 'Test', tmdb_release_year: 2000, runtime_minutes: 50, tmdb_enrichment_status: 'matched' });
    const snapshot = f.db.serialize(); const repeatClient = happy();
    assert.equal((await enrichTmdb(f.db, repeatClient.api, f.options())).processed, 0);
    assert.equal(repeatClient.calls.length, 0); assert.deepEqual(f.db.serialize(), snapshot);
    const backup = new Database(result.backupPath!, { readonly: true });
    try { assert.equal(backup.pragma('user_version', { simple: true }), 2); assert.equal((backup.prepare('SELECT tmdb_id FROM movies').get() as { tmdb_id: number | null }).tmdb_id, null); }
    finally { backup.close(); }
  } finally { f.cleanup(); }
});

test('dry-run opens schema 2 read-only and changes neither file nor schema', async () => {
  const f = fixture(true);
  const previous = process.env.DATABASE_PATH;
  try {
    process.env.DATABASE_PATH = f.path;
    const readonly = openDatabase({ readonly: true });
    try {
      const before = readFileSync(f.path);
      const result = await enrichTmdb(readonly, happy().api, { dryRun: true, limit: 1 });
      assert.equal(result.matched, 1); assert.equal(result.remainingWithoutId, 1); assert.equal(result.backupPath, null);
      assert.equal(readonly.pragma('user_version', { simple: true }), 2); assert.deepEqual(readFileSync(f.path), before);
      assert.throws(() => readonly.exec("UPDATE movies SET title='Wrong'"), /readonly/);
    } finally { readonly.close(); }
  } finally { if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous; f.cleanup(); }
});

test('ambiguous, missing, incomplete search and missing year remain unresolved; explicit retry is required', async () => {
  const scenarios = [
    { candidates: [identity(), identity(11)], pages: 1, status: 'ambiguous' },
    { candidates: [identity(10, 'Test', '2001-01-01')], pages: 1, status: 'not_found' },
    { candidates: [identity()], pages: 6, status: 'ambiguous' },
  ];
  for (const scenario of scenarios) {
    const f = fixture();
    try {
      const api = client(() => response({ total_pages: scenario.pages, results: scenario.candidates }));
      const result = await enrichTmdb(f.db, api.api, f.options());
      assert.equal(result.items[0].status, scenario.status);
      assert.equal((f.db.prepare('SELECT tmdb_id FROM movies').get() as { tmdb_id: number | null }).tmdb_id, null);
      const again = happy(); assert.equal((await enrichTmdb(f.db, again.api, f.options())).processed, 0);
      assert.equal(again.calls.length, 0);
      assert.equal((await enrichTmdb(f.db, happy().api, { ...f.options(), retryUnresolved: true })).matched, 1);
    } finally { f.cleanup(); }
  }
  const f = fixture();
  try {
    f.db.exec('UPDATE movies SET release_year=NULL'); const api = happy();
    assert.equal((await enrichTmdb(f.db, api.api, f.options())).ambiguous, 1); assert.equal(api.calls.length, 0);
  } finally { f.cleanup(); }
});

test('details mismatch and occupied TMDB IDs never cause merging', async () => {
  for (const collision of [false, true]) {
    const f = fixture();
    try {
      if (collision) f.db.exec("INSERT INTO movies (title,release_year,tmdb_id,tmdb_enrichment_status,metadata_updated_at) VALUES ('Other',2001,10,'matched','2020')");
      const api = client(url => url.pathname.includes('/search/') ? response({ total_pages: 1, results: [identity()] }) : response(details(10, collision ? 'Test' : 'Other')));
      assert.equal((await enrichTmdb(f.db, api.api, f.options())).ambiguous, 1);
      assert.equal((f.db.prepare('SELECT tmdb_id FROM movies WHERE id=1').get() as { tmdb_id: number | null }).tmdb_id, null);
    } finally { f.cleanup(); }
  }
});

test('per-record progress survives auth failure; retry resumes remaining/error rows; limit and known ID work', async () => {
  const f = fixture();
  try {
    f.db.exec("INSERT INTO movies (title,release_year,tmdb_id) VALUES ('Second',2000,11)");
    const limited = await enrichTmdb(f.db, happy().api, { ...f.options(), limit: 1 }); assert.equal(limited.processed, 1);
    const failure = client(() => response({}, 401));
    const reports: EnrichmentReport[] = [];
    const stopped = await enrichTmdb(f.db, failure.api, { ...f.options(), onProgress: r => reports.push(structuredClone(r)) });
    assert.equal(stopped.stopped, true); assert.equal(stopped.errors, 1); assert.equal(reports.at(-1)?.processed, 1);
    const known = client(url => { assert.ok(!url.pathname.includes('/search/')); return response(details(11, 'Second')); });
    assert.equal((await enrichTmdb(f.db, known.api, f.options())).matched, 1); assert.equal(known.calls.length, 1);
    assert.equal((f.db.prepare('SELECT count(*) AS n FROM movies').get() as { n: number }).n, 2);
  } finally { f.cleanup(); }
});

test('backup failure makes no changes; invalid limit fails before requests', async () => {
  const f = fixture(true);
  try {
    const before = f.db.serialize();
    await assert.rejects(() => enrichTmdb(f.db, happy().api, { backupPath: join(f.directory, 'missing', 'backup.sqlite') }));
    assert.deepEqual(f.db.serialize(), before);
    await assert.rejects(() => enrichTmdb(f.db, happy().api, { dryRun: true, limit: 0 }), /positive integer/);
    assert.deepEqual(f.db.serialize(), before);
  } finally { f.cleanup(); }
});

test('missing key CLI exits before opening/changing DB or creating report; secrets are not printed', () => {
  assert.throws(() => createTmdbClient(''), /TMDB_API_KEY/);
  const f = fixture(true);
  try {
    const before = readFileSync(f.path);
    const result = spawnSync(process.execPath, ['--import', createRequire(import.meta.url).resolve('tsx'), resolve('scripts/tmdb-enrich.ts'), '--dry-run', '--limit', '10'],
      { cwd: f.directory, env: { ...process.env, TMDB_API_KEY: '', DATABASE_PATH: f.path }, encoding: 'utf8' });
    assert.equal(result.status, 1); assert.match(result.stderr, /TMDB_API_KEY/); assert.ok(!result.stderr.includes(key));
    assert.deepEqual(readFileSync(f.path), before); assert.ok(!existsSync(join(f.directory, 'data')));
  } finally { f.cleanup(); }
});


test('dry-run detects duplicate proposed IDs within one run; known TV rows are skipped', async () => {
  const f = fixture();
  try {
    f.db.exec("INSERT INTO movies (title,release_year,letterboxd_uri) VALUES ('Test',2000,'uri:second'); INSERT INTO movies (title,release_year,media_type) VALUES ('TV',2000,'tv')");
    const before = f.db.serialize();
    const report = await enrichTmdb(f.db, happy().api, { dryRun: true });
    assert.equal(report.processed, 2); assert.equal(report.matched, 1); assert.equal(report.ambiguous, 1);
    assert.deepEqual(f.db.serialize(), before);
    assert.deepEqual(Object.keys(report.items[0].candidates[0]).sort(), ['id','original_title','title','year']);
  } finally { f.cleanup(); }
});

test('404 is not retried, HTTP-date Retry-After is honored and returned empty fields do not trigger endless refresh', async () => {
  const notFound = client(() => response({}, 404));
  await assert.rejects(() => notFound.api.details(10), /HTTP 404/); assert.equal(notFound.calls.length, 1);
  let n = 0;
  const dated = client(() => ++n === 1 ? response({}, 429, { 'Retry-After': new Date(5000).toUTCString() }) : response(identity()));
  await dated.api.details(10); assert.ok(dated.waits.includes(5000));
  const f = fixture();
  try {
    const sparse = client(url => url.pathname.includes('/search/') ? response({ total_pages: 1, results: [identity()] }) : response(identity()));
    assert.equal((await enrichTmdb(f.db, sparse.api, f.options())).matched, 1);
    assert.equal((f.db.prepare('SELECT runtime_minutes FROM movies').get() as {runtime_minutes: number|null}).runtime_minutes, null);
    assert.equal((await enrichTmdb(f.db, happy().api, f.options())).processed, 0);
  } finally { f.cleanup(); }
});
