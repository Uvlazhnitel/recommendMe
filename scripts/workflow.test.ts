import { profileRequest } from './fixtures/profile-request';
import { api, ApiError, scoreValue } from '../src/app/workbench-api';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { readJsonBody } from '../src/lib/http-json';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { migrateDatabase, SCHEMA_VERSION } from '../src/lib/migrations';
import { movieHandlers } from '../src/lib/movie-http';
import { watchHandler } from '../src/lib/watch-http';
import { libraryHandlers } from '../src/lib/library-http';
import { rejectionHandler } from '../src/lib/recommendation-http';
import { createTmdbClient } from '../src/lib/tmdb';
import { backupForRecommendationWrite, recordRecommendations } from '../src/lib/recommendation-memory';
import { buildTasteContext } from '../src/lib/taste-context';
import { blockedReason, buildCandidateContext, prepareTasteInputs, readCandidateHistory } from '../src/lib/candidate-context';
import { buildRankingContext } from '../src/lib/recommendation-context';
import { rankRecommendations } from '../src/lib/recommendations';
import { generateCandidates, type MovieCandidate } from '../src/lib/candidates';
import { RECOMMENDATION_REPEAT_MS } from '../src/lib/recommendation-policy';

const candidate = (id = 201, title = 'Workflow Film'): MovieCandidate => ({ tmdb_id: id, media_type: 'movie', title, original_title: null, year: 2000,
  runtime: 100, overview: 'Verified synthetic description', genres: [{ id: 1, name: 'Drama' }], directors: [{ id: 1, name: 'Director' }], popularity: null, vote_count: null, source: 'llm' });
const report = (movies = [candidate()]) => ({ mode: 'live', status: 'ok', candidates: movies });
const result = (id = 201) => ({ mode: 'live', status: 'ok', result_id: `workflow-${id}`, generated_at: new Date().toISOString(), recommendations: [{ tmdb_id: id,
  why_fit: 'Supported by a known high score.', possible_mismatch: 'The cause of the preference remains uncertain.', evidence: [{ movie_id: 1, rating_100: 100 }] }] });
function fixture(version = 4) {
  const directory = mkdtempSync(join(tmpdir(), 'workflow-')), path = join(directory, 'movies.sqlite'), db = new Database(path); db.pragma('foreign_keys=ON');
  if (version === 3) {
    for (const file of ['001_initial.sql', '002_letterboxd_rating_date.sql', '003_tmdb_metadata.sql']) db.exec(readFileSync(`migrations/${file}`, 'utf8'));
    db.pragma('user_version=3');
  } else migrateDatabase(db);
  migrateDatabase(db);
  db.exec(`INSERT INTO movies(id,title,release_year,tmdb_id,media_type,runtime_minutes,overview,genres_json,directors_json) VALUES
    (1,'Favourite',2000,101,'movie',100,'Known','[{"id":1,"name":"Drama"}]','[{"id":1,"name":"Director"}]'),
    (2,'Disliked',2000,102,'movie',100,'Known','[{"id":1,"name":"Drama"}]','[{"id":1,"name":"Director"}]'),
    (3,'Imported',2000,103,'movie',100,'Known','[{"id":1,"name":"Drama"}]','[{"id":1,"name":"Director"}]'),
    (4,'Unresolved',2000,NULL,'unknown',NULL,NULL,NULL,NULL);
    UPDATE movies SET letterboxd_uri='https://example.test/imported' WHERE id=3;
    INSERT INTO user_movies(user_id,movie_id,watched,rating_100,rating_source,original_rating_stars,letterboxd_date,letterboxd_rating_date) VALUES
    ('ilya',1,1,100,'letterboxd',5,'2020-01-01','2020-01-02'),('ilya',2,1,0,'letterboxd',0,'2020-01-01','2020-01-02'),('ilya',3,1,60,'letterboxd',3,'2020-01-01','2020-01-02'),('ilya',4,1,NULL,'none',NULL,'2020-01-01',NULL);`);
  const taste = buildTasteContext(db, 'ilya');
  db.prepare('INSERT INTO taste_profile(user_id,profile_json) VALUES(\'ilya\',?)').run(JSON.stringify({
    strong_preferences: [{ summary: 'Positive', explanation: 'Known high.', kind: 'observation', uncertainty: 'Limited.', evidence: [{ movie_id: 1, rating_100: 100 }] }],
    negative_patterns: [{ summary: 'Negative', explanation: 'Known zero.', kind: 'hypothesis', uncertainty: 'Limited.', evidence: [{ movie_id: 2, rating_100: 0 }] }],
    contrasts: [{ higher: { movie_id: 1, rating_100: 100 }, lower: { movie_id: 2, rating_100: 0 }, similarity: 'Shared director.', possible_difference: 'Unknown.', uncertainty: 'Limited.' }],
    uncertainties: [{ description: 'Limited sample.', evidence: [] }], profile_version: 1, generated_at: new Date().toISOString(), ratings_count: 3, ratings_snapshot: taste.snapshot,
    context_fingerprint: taste.fingerprint, prompt_version: 1, schema_version: 1, contrast_pairs_count: 1, requested_model: 'mock', model: 'mock', response_id: null, usage: null }));
  const open = (options?: { readonly?: boolean }) => { const conn = new Database(path, { readonly: options?.readonly ?? false }); conn.pragma('foreign_keys=ON'); return conn; };
  const api = createTmdbClient('synthetic-key', { sleep: async () => {}, fetch: async input => {
    const url = new URL(String(input)), searching = url.pathname.includes('/search/');
    const title = searching ? url.searchParams.get('query')! : 'Workflow Film';
    return Response.json(searching ? { total_pages: 1, results: [{ id: 201, title, original_title: null, release_date: '2000-01-01' }] } :
      { id: Number(url.pathname.split('/').pop()), title, release_date: '2000-01-01', overview: 'Verified', runtime: 100, genres: [{ id: 1, name: 'Drama' }] });
  } });
  return { db, path, directory, open, api, close: () => { if (db.open) db.close(); rmSync(directory, { recursive: true, force: true }); } };
}
const request = (body: unknown, method = 'POST', headers: Record<string, string> = {}) => profileRequest('http://localhost/api/action', {
  method, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
});
const context = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });
const snapshot = (db: Database.Database) => JSON.stringify(['movies', 'user_movies', 'recommendations', 'taste_profile'].map(t => db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()));
const identity = { id: 201, title: 'Workflow Film', original_title: null, year: 2000 };
async function saved(f: ReturnType<typeof fixture>, id = 201) {
  await backupForRecommendationWrite(f.db, join(f.directory, `before-record-${id}.sqlite`));
  return recordRecommendations(f.db, 'ilya', report([candidate(id)]), { result: result(id) }, { dryRun: false });
}

test('HTTP workflow search→catalog→watch→library→edit/clear/zero updates both contexts without false snapshot events', async () => {
  const f = fixture(); try {
    const movies = movieHandlers({ open: f.open, api: () => f.api }), library = libraryHandlers({ open: f.open }), watch = watchHandler({ open: f.open });
    const search = await movies.search(profileRequest('http://localhost/api/movies/search?q=Workflow'));
    assert.equal(search.status, 200); assert.equal((await search.json()).results[0].id, 201);
    const added = await movies.add(request({ tmdb_id: 201 })); assert.equal(added.status, 201); const id = (await added.json()).movie_id;
    assert.equal((await (await library.details(profileRequest('http://localhost/'), context(id))).json()).watched, false);
    assert.equal(blockedReason(identity, readCandidateHistory(f.db, 'ilya')), null);
    const repeat = await movies.add(request({ tmdb_id: 201 })); assert.equal((await repeat.json()).movie_id, id);
    for (const score of [90, 40, null, 0]) {
      const response = score === 90 ? await watch(request({ rating_100: score }), context(id)) : await library.rating(request({ rating_100: score }, 'PATCH'), context(id));
      assert.ok(response.ok);
      const entry = (await (await library.list(profileRequest('http://localhost/api/library?q=Workflow'))).json()).items[0];
      assert.equal(entry.rating_100, score); assert.equal(entry.watched, true);
      const generated = buildCandidateContext(f.db, 'ilya'), ranked = buildRankingContext(f.db, 'ilya', [candidate(202)]);
      for (const input of [generated.context, ranked.context]) {
        const diff = input.rating_changes.find(row => row.movie_id === id);
        if (score === null) assert.equal(diff, undefined); else assert.equal(diff?.rating_100, score);
      }
      assert.equal(ranked.snapshot.find(row => row.movie_id === id)?.rating_100 ?? null, score);
      assert.equal(blockedReason(identity, readCandidateHistory(f.db, 'ilya')), 'watched');
    }
    await watch(request({}), context(id)); assert.equal((await (await library.details(profileRequest('http://localhost/'), context(id))).json()).rating_100, 0);
    await library.rating(request({ rating_100: null }, 'PATCH'), context(3));
    const imported = (await (await library.details(profileRequest('http://localhost/'), context(3))).json());
    assert.equal(imported.original_rating_stars, 3); assert.equal(imported.letterboxd_uri, 'https://example.test/imported'); assert.equal(imported.letterboxd_rating_date, '2020-01-02');
    assert.equal(prepareTasteInputs(f.db, 'ilya').profileRefresh.cleared, 1);
    const before = snapshot(f.db); f.db.close(); const reopened = f.open({ readonly: true }); assert.equal(snapshot(reopened), before); assert.deepEqual(reopened.pragma('foreign_key_check'), []); reopened.close();
  } finally { f.close(); }
});

test('saved ranking→catalog→watch shares one local identity and preserves historical date/explanations', async () => {
  const f = fixture(); try {
    assert.equal((await saved(f)).saved_count, 1);
    const local = f.db.prepare('SELECT id FROM movies WHERE tmdb_id=201').get() as { id: number };
    const history = f.db.prepare('SELECT * FROM recommendations').all();
    const movies = movieHandlers({ open: f.open, api: () => { throw Error('Existing catalog ID must not call TMDB'); } });
    const add = await movies.add(request({ tmdb_id: 201 })); assert.equal(add.status, 200); assert.equal((await add.json()).movie_id, local.id);
    assert.equal(f.db.prepare('SELECT 1 FROM user_movies WHERE movie_id=?').get(local.id), undefined);
    const watch = watchHandler({ open: f.open }); assert.equal((await watch(request({}), context(local.id))).status, 201);
    assert.deepEqual(f.db.prepare('SELECT * FROM recommendations').all(), history);
    const rank = await rankRecommendations(f.db, 'ilya', report()); assert.equal(rank.eligible_count, 0); assert.equal(rank.statistics.openai_requests, 0);
    const generated = await generateCandidates(f.db, 'ilya', { live: true, apiKey: 'mock', model: 'mock', tmdbKey: 'mock', sleep: async () => {},
      openaiFetch: async () => Response.json({ status: 'completed', model: 'mock', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ candidates: [{ title: 'Workflow Film', year: 2000 }] }) }] }] }),
      tmdbFetch: async url => Response.json(String(url).includes('/search/') ? { total_pages: 1, results: [{ id: 201, title: 'Workflow Film', release_date: '2000-01-01' }] } : { results: [] }),
    });
    assert.ok('candidates' in generated); assert.equal(generated.candidates.length, 0); assert.ok(generated.diagnostics.some(row => row.reason === 'watched'));
    assert.equal(prepareTasteInputs(f.db, 'ilya').changes.length, 0);
    assert.equal((f.db.prepare('SELECT count(*) n FROM movies WHERE tmdb_id=201').get() as { n: number }).n, 1);
  } finally { f.close(); }
});

test('HTTP reject→repeat→undo preserves history and ratings; cooldown survives undo and expires at exactly 30 days', async t => {
  const f = fixture(); try {
    await saved(f);
    const history = f.db.prepare('SELECT * FROM recommendations').get() as { recommended_at: string };
    const reject = rejectionHandler(false, { open: f.open }), undo = rejectionHandler(true, { open: f.open });
    const first = await reject(request({ tmdb_id: 201 })); assert.equal(first.status, 200); assert.equal((await first.json()).history_changes, 1);
    const after = snapshot(f.db); assert.equal((await (await reject(request({ tmdb_id: 201 }))).json()).personal_changes, 0); assert.equal(snapshot(f.db), after);
    assert.equal(blockedReason(identity, readCandidateHistory(f.db, 'ilya')), 'not_interested');
    const hidden = await rankRecommendations(f.db, 'ilya', report()); assert.equal(hidden.diagnostics[0].reason, 'not_interested');
    await undo(request({ tmdb_id: 201 }));
    assert.equal(blockedReason(identity, readCandidateHistory(f.db, 'ilya')), 'recently_recommended');
    const rec = f.db.prepare('SELECT * FROM recommendations').get() as Record<string, unknown>;
    assert.equal(rec.recommended_at, history.recommended_at); assert.equal(rec.rejected, 1);
    const row = f.db.prepare('SELECT * FROM user_movies WHERE movie_id=(SELECT id FROM movies WHERE tmdb_id=201)').get() as Record<string, unknown>;
    assert.equal(row.rating_100, null); assert.equal(row.watched, 0); assert.equal(row.not_interested, 0);
    t.mock.method(Date, 'now', () => Date.parse(history.recommended_at) + RECOMMENDATION_REPEAT_MS);
    assert.equal(blockedReason(identity, readCandidateHistory(f.db, 'ilya')), null);
    assert.equal((await rankRecommendations(f.db, 'ilya', report())).eligible_count, 1);
    // A historical unrated show is not a taste event.
    assert.equal(prepareTasteInputs(f.db, 'ilya').changes.length, 0);
    const ratedBefore = f.db.prepare('SELECT watched,rating_100,original_rating_stars FROM user_movies WHERE movie_id=3').get();
    await reject(request({ tmdb_id: 103 })); await undo(request({ tmdb_id: 103 }));
    assert.deepEqual(f.db.prepare('SELECT watched,rating_100,original_rating_stars FROM user_movies WHERE movie_id=3').get(), ratedBefore);
  } finally { f.close(); }
});

test('legacy conflict, external error, backup failure and SQL rollback never corrupt history; rejection migrates safely and handles pending historical flags', async () => {
  const f = fixture(3); try {
    const before = snapshot(f.db);
    const api = { ...f.api, details: async () => ({ ...await f.api.details(201), title: 'Unresolved' }) };
    const conflict = await movieHandlers({ open: f.open, api: () => api }).add(request({ tmdb_id: 201 }));
    assert.equal(conflict.status, 409); assert.equal(snapshot(f.db), before); assert.equal(f.db.pragma('user_version', { simple: true }), SCHEMA_VERSION);
    const unavailable = await movieHandlers({ open: f.open, api: () => { throw Error('synthetic external failure'); } }).add(request({ tmdb_id: 201 }));
    assert.ok(!unavailable.ok); assert.equal(snapshot(f.db), before);
    const failedBackup = rejectionHandler(false, { open: f.open, backup: { backup: async () => { throw Error('private backup path'); } } });
    const failure = await failedBackup(request({ tmdb_id: 103 })); assert.equal(failure.status, 500); assert.ok(!(await failure.text()).includes('private')); assert.equal(snapshot(f.db), before);
    const reject = rejectionHandler(false, { open: f.open }); await reject(request({ tmdb_id: 103 })); assert.equal(f.db.pragma('user_version', { simple: true }), SCHEMA_VERSION);
    f.db.exec("INSERT INTO recommendations(user_id,movie_id,rejected) VALUES('ilya',3,0)");
    const repeated = await reject(request({ tmdb_id: 103 })); assert.equal((await repeated.json()).history_changes, 1);
    f.db.exec("INSERT INTO recommendations(user_id,movie_id,rejected) VALUES('ilya',2,0); CREATE TRIGGER fail_reject AFTER UPDATE ON recommendations WHEN NEW.movie_id=2 BEGIN SELECT RAISE(ABORT,'synthetic SQL failure'); END;");
    const stable = snapshot(f.db); assert.equal((await reject(request({ tmdb_id: 102 }))).status, 500); assert.equal(snapshot(f.db), stable);
    assert.equal((await reject(request({ tmdb_id: 99999 }))).status, 404);
    assert.deepEqual(f.db.pragma('integrity_check'), [{ integrity_check: 'ok' }]);
  } finally { f.close(); }
});

test('all mutating routes enforce Origin before body/SQLite and retain explicit same-origin and curl compatibility', async () => {
  let opened = 0; const open = () => { opened++; throw Error('Expected fake DB failure'); };
  const handlers = [
    { call: (r: Request) => movieHandlers({ open }).add(r), body: { tmdb_id: 201 } },
    { call: (r: Request) => watchHandler({ open })(r, context(1)), body: {} },
    { call: (r: Request) => libraryHandlers({ open }).rating(r, context(1)), body: { rating_100: 0 } },
    { call: rejectionHandler(false, { open }), body: { tmdb_id: 201 } },
    { call: rejectionHandler(true, { open }), body: { tmdb_id: 201 } },
  ];
  for (const handler of handlers) {
    for (const headers of [
      { Origin: 'https://foreign.example' }, { Origin: 'null' }, { Origin: 'not an origin' }, { Origin: 'http://localhost/path' },
      { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' }, { Origin: 'http://localhost', 'Sec-Fetch-Site': 'cross-site' },
      { Origin: 'https://foreign.example', 'X-Forwarded-Host': 'foreign.example', 'X-Forwarded-Proto': 'https' },
    ] as Record<string, string>[]) {
      const before = opened; const response = await handler.call(request(handler.body, 'POST', headers));
      assert.equal(response.status, 403); assert.equal(opened, before); assert.equal(response.headers.get('Cache-Control'), 'no-store');
    }
    for (const headers of [{}, { Origin: 'http://localhost' }, { 'Sec-Fetch-Site': 'same-origin' }, { 'Sec-Fetch-Site': 'none' }] as Record<string, string>[]) {
      const before = opened; await handler.call(request(handler.body, 'POST', headers)); assert.equal(opened, before + 1);
    }
  }
});

// Next.js normalizes 127.0.0.1/[::1] to localhost in request.url.
test('Origin follows the actual HTTP Host for NextRequest loopback URLs while rejecting alias/forwarded spoofing', async () => {
  for (const host of ['127.0.0.1:45140', 'localhost:45140', '[::1]:45140']) {
    const make = (origin: string, extra: Record<string, string> = {}) => new NextRequest(`http://${host}/api/movies`, { method: 'POST',
      headers: { host, origin, 'Content-Type': 'application/json', ...extra }, body: '{"tmdb_id":201}' });
    assert.deepEqual(await readJsonBody(make(`http://${host}`)), { tmdb_id: 201 });
    await assert.rejects(readJsonBody(make('http://foreign.example', { 'X-Forwarded-Host': 'foreign.example' })), /forbidden_origin/);
    if (host !== 'localhost:45140') await assert.rejects(readJsonBody(make('http://localhost:45140')), /forbidden_origin/);
  }
});

test('workbench understands the catalog conflict status payload and preserves optional blank versus score zero', async t => {
  Object.defineProperty(globalThis,'window',{value:{location:{origin:'http://localhost'},recommendmeProfile:{active:{user_id:'ilya',selection_id:'test'},epoch:0,reads:new Set()}},configurable:true});
  t.after(()=>Reflect.deleteProperty(globalThis,'window'));
  const matches = [{ movie_id: 4, title: 'Unresolved', year: 2000 }];
  t.mock.method(globalThis, 'fetch', async () => Response.json({ status: 'possible_duplicate', tmdb_id: 201, matches }, { status: 409 }));
  await assert.rejects(api('/api/movies'), error => error instanceof ApiError && error.message.includes('Возможно, фильм уже есть') && error.matches?.[0].movie_id === 4);
  assert.equal(scoreValue('0'), 0); assert.equal(scoreValue('', true), undefined); assert.throws(() => scoreValue(''));
});
