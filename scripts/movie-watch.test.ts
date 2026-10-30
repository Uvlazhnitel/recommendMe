import { profileRequest } from './fixtures/profile-request';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { migrateDatabase, SCHEMA_VERSION } from '../src/lib/migrations';
import { confirmMovieWatch, WatchError } from '../src/lib/movie-watch';
import { watchHandler } from '../src/lib/watch-http';
import { buildTasteContext } from '../src/lib/taste-context';
import { buildCandidateContext, blockedReason, readCandidateHistory, prepareTasteInputs } from '../src/lib/candidate-context';
import { buildRankingContext } from '../src/lib/recommendation-context';
import { rankRecommendations } from '../src/lib/recommendations';
import { generateCandidates, type MovieCandidate } from '../src/lib/candidates';

const candidate = (id = 3): MovieCandidate => ({ tmdb_id: 100 + id, media_type: 'movie', title: `Film ${id}`, original_title: null, year: 2000,
  runtime: 100, overview: 'Confirmed description.', genres: [{ id: 1, name: 'Drama' }], directors: [{ id: 1, name: 'Director' }], vote_count: null, popularity: null, source: 'llm' });
function fixture(version = 4) {
  const folder = mkdtempSync(join(tmpdir(), 'watch-')); const path = join(folder, 'movies.sqlite'); const db = new Database(path); db.pragma('foreign_keys=ON');
  if (version === 3) {
    for (const file of ['001_initial.sql', '002_letterboxd_rating_date.sql', '003_tmdb_metadata.sql']) db.exec(readFileSync(`migrations/${file}`, 'utf8'));
    db.pragma('user_version=3');
  } else migrateDatabase(db);
  migrateDatabase(db);
  for (let id = 1; id <= 16; id++) db.prepare(`INSERT INTO movies(id,title,release_year,tmdb_id,media_type,runtime_minutes,overview,genres_json,directors_json)
    VALUES (?,?,2000,?,'movie',100,'Confirmed description.','[{"id":1,"name":"Drama"}]','[{"id":1,"name":"Director"}]')`).run(id, `Film ${id}`, 100 + id);
  db.exec(`UPDATE movies SET letterboxd_uri='https://example.test/film1' WHERE id=1;
    INSERT INTO user_movies(user_id,movie_id,watched,rating_100,rating_source,original_rating_stars,letterboxd_date,letterboxd_rating_date,not_interested)
      VALUES ('ilya',1,1,100,'letterboxd',5,'2020-01-01','2020-01-02',1),('ilya',2,1,0,'letterboxd',0,'2020-01-01','2020-01-02',0);
    INSERT INTO recommendations(user_id,movie_id,why_fit,possible_mismatch,rejected) VALUES('ilya',1,'Saved explanation','Saved risk',1),('ilya',3,'Another explanation',NULL,0);`);
  const taste = buildTasteContext(db, 'ilya');
  db.prepare('INSERT INTO taste_profile(user_id,profile_json) VALUES (\'ilya\',?)').run(JSON.stringify({
    strong_preferences: [{ summary: 'Positive', explanation: 'Confirmed high rating.', kind: 'observation', uncertainty: 'Small sample.', evidence: [{ movie_id: 1, rating_100: 100 }] }],
    negative_patterns: [{ summary: 'Negative', explanation: 'Confirmed zero.', kind: 'hypothesis', uncertainty: 'Cause unknown.', evidence: [{ movie_id: 2, rating_100: 0 }] }],
    contrasts: [{ higher: { movie_id: 1, rating_100: 100 }, lower: { movie_id: 2, rating_100: 0 }, similarity: 'Shared director.', possible_difference: 'Unknown.', uncertainty: 'Small sample.' }],
    uncertainties: [{ description: 'Limited evidence.', evidence: [] }], profile_version: 1, generated_at: new Date().toISOString(), ratings_count: 2,
    ratings_snapshot: taste.snapshot, context_fingerprint: taste.fingerprint, prompt_version: 1, schema_version: 1, contrast_pairs_count: 1,
    requested_model: 'mock-model', model: 'mock-model', response_id: null, usage: null }));
  return { db, path, folder, close: () => { if (db.open) db.close(); rmSync(folder, { recursive: true, force: true }); } };
}
const personal = (db: Database.Database, id: number) => db.prepare('SELECT * FROM user_movies WHERE movie_id=?').get(id) as Record<string, unknown> | undefined;
const all = (db: Database.Database) => JSON.stringify(['movies', 'user_movies', 'recommendations', 'taste_profile'].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()));
const preserved = (db: Database.Database) => JSON.stringify(['movies', 'recommendations', 'taste_profile'].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()));
const input = (movie_id = 3, rating_100?: number | null) => ({ movie_id, watched: true, rating_100 });
const post = (body: unknown = {}) => profileRequest('http://localhost/api/movies/3/watch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const params = (id = '3') => ({ params: Promise.resolve({ id }) });
const code = (expected: string) => (error: unknown) => error instanceof WatchError && error.code === expected;

test('watch creates NULL or first integer rating, including 0/1/99/100, without a fabricated date', async () => {
  const f = fixture(); try {
    const before = preserved(f.db);
    for (const [index, rating] of [undefined, null, 0, 1, 99, 100].entries()) {
      const id = 3 + index; const result = await confirmMovieWatch(f.db, 'ilya', input(id, rating));
      assert.equal(result.status, 'created'); assert.equal(result.watched, true); assert.equal(result.rating_100, rating ?? null);
      const row = personal(f.db, id)!; assert.equal(row.watched, 1); assert.equal(row.rating_100, rating ?? null);
      assert.equal(row.rating_source, rating == null ? 'none' : 'manual'); assert.equal(row.watched_at, null);
      assert.equal(row.letterboxd_date, null); assert.equal(row.letterboxd_rating_date, null); assert.equal(row.original_rating_stars, null);
    }
    assert.equal(preserved(f.db), before); assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  } finally { f.close(); }
});

test('invalid scores/IDs/watched states fail before backup; missing film makes no changes', async () => {
  const f = fixture(3); let backups = 0; const options = { backup: async () => { backups++; } };
  try {
    const before = all(f.db);
    for (const rating_100 of [-1, 101, 1.2, '0', NaN, Infinity, false, {}, []]) await assert.rejects(confirmMovieWatch(f.db, 'ilya', { ...input(), rating_100 }, options), code('invalid_watch'));
    for (const movie_id of [0, -1, 1.5, '3', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) await assert.rejects(confirmMovieWatch(f.db, 'ilya', { ...input(), movie_id }, options), code('invalid_watch'));
    for (const watched of [false, 1, 'true', null, undefined]) await assert.rejects(confirmMovieWatch(f.db, 'ilya', { ...input(), watched }, options), code('invalid_watch'));
    await assert.rejects(confirmMovieWatch(f.db, 'ilya', input(999), options), code('movie_not_found'));
    assert.equal(backups, 0); assert.equal(f.db.pragma('user_version', { simple: true }), SCHEMA_VERSION); assert.equal(all(f.db), before);
  } finally { f.close(); }
});

test('repeat and omitted/null scores preserve imported rating, source, timestamps and all Letterboxd fields', async () => {
  const f = fixture(3); try {
    const before = all(f.db);
    for (const rating of [undefined, null, 100]) {
      const result = await confirmMovieWatch(f.db, 'ilya', input(1, rating), { backup: async () => { throw Error('No backup for repeat'); } });
      assert.equal(result.status, 'unchanged'); assert.equal(result.rating_source, 'letterboxd');
    }
    assert.equal(all(f.db), before); assert.equal(f.db.pragma('user_version', { simple: true }), SCHEMA_VERSION);
    await assert.rejects(confirmMovieWatch(f.db, 'ilya', input(1, 0)), code('rating_already_exists'));
    assert.equal(all(f.db), before);
  } finally { f.close(); }
});

test('previously watched unrated row accepts its first score while preserving import fields and hidden flag', async () => {
  const f = fixture(); try {
    f.db.exec("INSERT INTO user_movies(user_id,movie_id,watched,rating_100,not_interested,letterboxd_date,letterboxd_rating_date,created_at,updated_at) VALUES('ilya',3,1,NULL,1,'2020-01-01','2020-01-02','2000-01-01T00:00:00.000Z','2000-01-01T00:00:00.000Z')");
    const before = personal(f.db, 3)!;
    const result = await confirmMovieWatch(f.db, 'ilya', input(3, 0)); assert.equal(result.status, 'updated'); assert.equal(result.rating_100, 0);
    const after = personal(f.db, 3)!;
    for (const key of ['not_interested', 'original_rating_stars', 'letterboxd_date', 'letterboxd_rating_date', 'created_at', 'watched_at']) assert.equal(after[key], before[key]);
    assert.equal(after.rating_source, 'manual'); assert.notEqual(after.updated_at, before.updated_at);
    const stable = all(f.db); await confirmMovieWatch(f.db, 'ilya', input(3, null)); await confirmMovieWatch(f.db, 'ilya', input(3, 0)); assert.equal(all(f.db), stable);
  } finally { f.close(); }
});

test('confirming an unwatched hidden row preserves an existing rating and rejection history', async () => {
  const f = fixture(); try {
    f.db.exec("INSERT INTO user_movies(user_id,movie_id,watched,rating_100,rating_source,not_interested,watched_at) VALUES('ilya',3,0,75,'manual',1,'2020-01-01T00:00:00.000Z')");
    const before = preserved(f.db);
    await assert.rejects(confirmMovieWatch(f.db, 'ilya', input(3, 76)), code('rating_already_exists'));
    assert.equal(personal(f.db, 3)!.watched, 0);
    await confirmMovieWatch(f.db, 'ilya', input(3));
    assert.equal(personal(f.db, 3)!.rating_100, 75); assert.equal(personal(f.db, 3)!.not_interested, 1);
    assert.equal(personal(f.db, 3)!.watched_at, '2020-01-01T00:00:00.000Z'); assert.equal(preserved(f.db), before);
  } finally { f.close(); }
});

test('backup precedes explicit schema8 setup; backup failure leaves data and schema unchanged', async () => {
  const f = fixture(3); try {
    const before = all(f.db);
    await assert.rejects(confirmMovieWatch(f.db, 'ilya', input(), { backup: async () => { throw Error('backup error'); } }));
    assert.equal(all(f.db), before); assert.equal(f.db.pragma('user_version', { simple: true }), SCHEMA_VERSION);
    await confirmMovieWatch(f.db, 'ilya', input(3, 100));
    const backup = new Database(join(f.folder, 'backups', readdirSync(join(f.folder, 'backups'))[0]), { readonly: true });
    assert.equal(backup.pragma('user_version', { simple: true }), SCHEMA_VERSION); assert.equal(all(backup), before); backup.close();
    assert.equal(f.db.pragma('user_version', { simple: true }), SCHEMA_VERSION);
    f.db.close(); const reopened = new Database(f.path, { readonly: true }); assert.equal(personal(reopened, 3)!.rating_100, 100); reopened.close();
  } finally { f.close(); }
});

test('unknown schema is rejected without backups or writes', async () => {
  const f = fixture(); try {
    for (const version of [2, SCHEMA_VERSION + 1]) {
      f.db.pragma(`user_version=${version}`); const before = all(f.db);
      await assert.rejects(confirmMovieWatch(f.db, 'ilya', input(), { backup: async () => { throw Error('Must not back up'); } }), /schema/);
      assert.equal(all(f.db), before); assert.equal(f.db.pragma('user_version', { simple: true }), version);
    }
  } finally { f.close(); }
});

test('SQL failures completely roll back insert and combined watch/rating update', async () => {
  for (const existing of [false, true]) {
    const f = fixture(); try {
      if (existing) f.db.exec('INSERT INTO user_movies(user_id,movie_id,watched,rating_100) VALUES(\'ilya\',3,0,NULL)');
      f.db.exec(`CREATE TRIGGER abort_watch AFTER ${existing ? 'UPDATE' : 'INSERT'} ON user_movies WHEN NEW.movie_id=3 BEGIN SELECT RAISE(ABORT,'synthetic SQL error'); END;`);
      const before = all(f.db); await assert.rejects(confirmMovieWatch(f.db, 'ilya', input(3, 100)), /synthetic SQL error/); assert.equal(all(f.db), before);
    } finally { f.close(); }
  }
});

test('concurrent initial scores are serialized: one first score wins and no duplicates are created', async () => {
  const f = fixture(); const other = new Database(f.path); other.pragma('foreign_keys=ON');
  try {
    const results = await Promise.allSettled([confirmMovieWatch(f.db, 'ilya', input(3, 0)), confirmMovieWatch(other, 'ilya', input(3, 100))]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    const rejected = results.find(r => r.status === 'rejected'); assert.ok(rejected?.status === 'rejected' && code('rating_already_exists')(rejected.reason));
    assert.equal((f.db.prepare('SELECT count(*) n FROM user_movies WHERE movie_id=3').get() as { n: number }).n, 1);
    assert.ok([0, 100].includes(personal(f.db, 3)!.rating_100 as number));
  } finally { other.close(); f.close(); }
});

test('state is checked again after asynchronous backup; matching concurrent operation becomes a no-op', async () => {
  const f = fixture(); try {
    const result = await confirmMovieWatch(f.db, 'ilya', input(3, 0), { backup: async db => {
      db.prepare("INSERT INTO user_movies(user_id,movie_id,watched,rating_100,rating_source) VALUES('ilya',3,1,0,'manual')").run();
    } });
    assert.equal(result.status, 'unchanged'); assert.equal(personal(f.db, 3)!.rating_100, 0);
  } finally { f.close(); }
});

test('watch without score excludes by TMDB ID or legacy identity and leaves rating/profile diffs empty', async () => {
  const f = fixture(); try {
    const profile = preserved(f.db); const before = prepareTasteInputs(f.db, 'ilya'); assert.equal(before.profileRefresh.status, 'current');
    await confirmMovieWatch(f.db, 'ilya', input(3)); await confirmMovieWatch(f.db, 'ilya', input(4, null));
    assert.equal(preserved(f.db), profile);
    const current = prepareTasteInputs(f.db, 'ilya'); assert.equal(current.rated.length, 2); assert.equal(current.changes.length, 0); assert.equal(current.profileRefresh.status, 'current');
    assert.equal(blockedReason({ id: 103, title: 'Film 3', original_title: null, year: 2000 }, readCandidateHistory(f.db, 'ilya')), 'watched');
    f.db.prepare('UPDATE movies SET tmdb_id=NULL WHERE id=4').run();
    assert.equal(blockedReason({ id: 9999, title: 'Film 4', original_title: null, year: 2000 }, readCandidateHistory(f.db, 'ilya')), 'watched_without_tmdb_id');
    const forbidden: typeof fetch = async () => { throw Error('No network permitted'); };
    const generated = await generateCandidates(f.db, 'ilya', { openaiFetch: forbidden, tmdbFetch: forbidden }); assert.ok('rating_changes' in generated); assert.equal(generated.rating_changes, 0);
    const ranked = await rankRecommendations(f.db, 'ilya', { mode: 'live', status: 'ok', candidates: [candidate(3)] }, { fetch: forbidden });
    assert.equal(ranked.eligible_count, 0); assert.equal(ranked.statistics.openai_requests, 0); assert.equal(ranked.diagnostics[0].reason, 'watched');
  } finally { f.close(); }
});

test('first ratings, including zero, enter both next contexts and hit the 9/10 refresh threshold without profile writes', async () => {
  const f = fixture(); try {
    const before = preserved(f.db);
    for (let id = 3; id <= 12; id++) {
      await confirmMovieWatch(f.db, 'ilya', input(id, id === 3 ? 0 : 90));
      const state = prepareTasteInputs(f.db, 'ilya'); assert.equal(state.changes.length, id - 2);
      if (id === 11) assert.equal(state.profileRefresh.status, 'stale');
      if (id === 12) assert.equal(state.profileRefresh.status, 'refresh_recommended');
    }
    const generated = buildCandidateContext(f.db, 'ilya'); const ranked = buildRankingContext(f.db, 'ilya', [candidate(16)]);
    for (const context of [generated.context, ranked.context]) {
      assert.equal(context.rating_changes.length, 10); assert.equal(context.rating_changes[0].rating_100, 0);
      assert.equal(context.rating_changes[0].previous_rating_100, null);
    }
    assert.ok(ranked.snapshot.some(row => row.movie_id === 3 && row.rating_100 === 0));
    assert.equal(preserved(f.db), before);
  } finally { f.close(); }
});

test('HTTP validates ID, JSON, fields and size before opening SQLite', async () => {
  let opens = 0; const handler = watchHandler({ open: () => { opens++; throw Error('No database'); } });
  for (const id of ['0', '-1', '1.5', '01', 'NaN', '9007199254740992']) assert.equal((await handler(post(), params(id))).status, 400);
  for (const body of [{ rating_100: '0' }, { rating_100: -1 }, { rating_100: 101 }, { rating_100: 2.5 }, { watched: false }, { movie_id: 1 }, [], null, { unknown: true }, { rating_100: 'a'.repeat(1500) }]) assert.equal((await handler(post(body), params())).status, 400);
  for (const [body, headers] of [['{', { 'Content-Type': 'application/json' }], ['{}', { 'Content-Type': 'text/plain' }]] as const) {
    assert.equal((await handler(profileRequest('http://localhost/', { method: 'POST', headers, body }), params())).status, 400);
  }
  assert.equal(opens, 0);
});

test('HTTP returns 201/200/404/409/500, no-store and sanitized errors without external API configuration', async () => {
  const f = fixture(); try {
    const handler = watchHandler({ open: () => { const db = new Database(f.path); db.pragma('foreign_keys=ON'); return db; } });
    const created = await handler(post({ rating_100: 0 }), params()); assert.equal(created.status, 201); assert.equal(created.headers.get('Cache-Control'), 'no-store');
    assert.equal((await created.json()).rating_100, 0);
    assert.equal((await handler(post(), params())).status, 200); assert.equal((await handler(post({ rating_100: null }), params())).status, 200);
    assert.equal((await handler(post({ rating_100: 100 }), params())).status, 409); assert.equal((await handler(post(), params('999'))).status, 404);
    const failed = watchHandler({ open: () => new Database(f.path), backup: { backup: async () => { throw Error('/private/path secret-key'); } } });
    const response = await failed(post(), params('4')); assert.equal(response.status, 500); assert.equal((await response.text()).includes('secret-key'), false); assert.equal(personal(f.db, 4), undefined);
  } finally { f.close(); }
});

test('generator and ranker actually exclude newly watched candidates, including legacy history without TMDB ID', async () => {
  const f = fixture(); try {
    await confirmMovieWatch(f.db, 'ilya', input(3)); await confirmMovieWatch(f.db, 'ilya', input(4));
    f.db.prepare('UPDATE movies SET tmdb_id=NULL WHERE id=4').run();
    const before = all(f.db); let llmCalls = 0; const detailsIds: number[] = [];
    const openaiFetch: typeof fetch = async () => {
      llmCalls++;
      return Response.json({ status: 'completed', model: 'mock-model', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ candidates: [3, 4, 16].map(id => ({ title: `Film ${id}`, year: 2000 })) }) }] }] });
    };
    const tmdbFetch: typeof fetch = async url => {
      const parsed = new URL(String(url));
      if (parsed.pathname.includes('/search/')) {
        const id = Number(parsed.searchParams.get('query')!.split(' ')[1]);
        return Response.json({ total_pages: 1, results: [{ id: 100 + id, title: `Film ${id}`, original_title: null, release_date: '2000-01-01' }] });
      }
      const id = Number(parsed.pathname.split('/').pop()); detailsIds.push(id);
      return Response.json({ id, title: `Film ${id - 100}`, release_date: '2000-01-01', overview: 'Verified description.', runtime: 100, genres: [{ id: 1, name: 'Drama' }] });
    };
    const result = await generateCandidates(f.db, 'ilya', { live: true, apiKey: 'mock-key', model: 'mock-model', tmdbKey: 'mock-tmdb', openaiFetch, tmdbFetch, sleep: async () => {} });
    assert.ok('candidates' in result); assert.deepEqual(result.candidates.map(row => row.tmdb_id), [116]);
    assert.equal(llmCalls, 1); assert.deepEqual(detailsIds, [116]);
    assert.ok(result.diagnostics.some(row => row.tmdb_id === 103 && row.reason === 'watched'));
    assert.ok(result.diagnostics.some(row => row.tmdb_id === 104 && row.reason === 'watched_without_tmdb_id'));
    const ranking = await rankRecommendations(f.db, 'ilya', { mode: 'live', status: 'ok', candidates: [candidate(3), candidate(4), candidate(16)] });
    assert.equal(ranking.eligible_count, 1); assert.equal(ranking.statistics.openai_requests, 0);
    assert.deepEqual(ranking.diagnostics.map(row => row.reason), ['watched', 'watched_without_tmdb_id']);
    assert.equal(all(f.db), before);
  } finally { f.close(); }
});
