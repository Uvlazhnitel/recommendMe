import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { migrateDatabase, SCHEMA_VERSION } from '../src/lib/migrations';
import { LibraryError, parseLibraryQuery, readLibrary, readLibraryMovie, updateLibraryRating } from '../src/lib/library';
import { libraryHandlers } from '../src/lib/library-http';
import { buildTasteContext } from '../src/lib/taste-context';
import { blockedReason, buildCandidateContext, prepareTasteInputs, readCandidateHistory } from '../src/lib/candidate-context';
import { buildRankingContext } from '../src/lib/recommendation-context';
import { confirmMovieWatch } from '../src/lib/movie-watch';
import type { MovieCandidate } from '../src/lib/candidates';

function fixture(version = 4) {
  const folder = mkdtempSync(join(tmpdir(), 'library-')), path = join(folder, 'movies.sqlite'), db = new Database(path); db.pragma('foreign_keys=ON');
  if (version === 3) {
    for (const file of ['001_initial.sql', '002_letterboxd_rating_date.sql', '003_tmdb_metadata.sql']) db.exec(readFileSync(`migrations/${file}`, 'utf8'));
    db.pragma('user_version=3');
  } else migrateDatabase(db);
  for (let id = 1; id <= 14; id++) {
    db.prepare(`INSERT INTO movies(id,title,release_year,tmdb_id,media_type,runtime_minutes,overview,genres_json,directors_json)
      VALUES (?,?,2000,?,'movie',100,'Verified overview','[{"id":1,"name":"Drama"}]','[{"id":1,"name":"Director"}]')`).run(id, `Film ${id}`, id + 100);
    if (id <= 12) db.prepare(`INSERT INTO user_movies(movie_id,watched,rating_100,rating_source,created_at,updated_at)
      VALUES(?,1,?,?,'2000-01-01T00:00:00.000Z','2000-01-01T00:00:00.000Z')`).run(id, id === 1 ? 100 : id === 3 ? 0 : id === 4 ? null : 60, id === 4 ? 'none' : id < 3 ? 'letterboxd' : 'manual');
  }
  db.exec(`UPDATE movies SET title='ТЁПЛЫЙ ФИЛЬМ' WHERE id=1; UPDATE movies SET title='Film 100%_Match',letterboxd_uri='https://example.test/imported' WHERE id=2;
    UPDATE movies SET title='Ｆｉｌｍ Three' WHERE id=3; UPDATE movies SET title='Local',tmdb_title='English Alias',original_title='原題 Original' WHERE id=4;
    UPDATE movies SET runtime_minutes=30 WHERE id=5; UPDATE movies SET media_type='tv',tmdb_id=NULL WHERE id=6;
    UPDATE movies SET release_year=NULL,tmdb_release_year=2001 WHERE id=7; UPDATE movies SET release_year=1999,tmdb_release_year=2000 WHERE id=8;
    UPDATE user_movies SET original_rating_stars=3,letterboxd_date='2020-01-01',letterboxd_rating_date='2020-01-02',not_interested=1 WHERE movie_id=2;
    INSERT INTO user_movies(movie_id,watched,not_interested) VALUES(14,0,1);
    INSERT INTO recommendations(movie_id,rejected,why_fit,possible_mismatch) VALUES(2,1,'Original explanation','Original risk');`);
  const taste = buildTasteContext(db);
  db.prepare('INSERT INTO taste_profile(profile_json) VALUES(?)').run(JSON.stringify({
    strong_preferences: [{ summary: 'Positive', explanation: 'High score.', kind: 'observation', uncertainty: 'Small sample.', evidence: [{ movie_id: 1, rating_100: 100 }] }],
    negative_patterns: [{ summary: 'Negative', explanation: 'Low score.', kind: 'hypothesis', uncertainty: 'Cause unknown.', evidence: [{ movie_id: 3, rating_100: 0 }] }],
    contrasts: [{ higher: { movie_id: 1, rating_100: 100 }, lower: { movie_id: 3, rating_100: 0 }, similarity: 'Shared director.', possible_difference: 'Unknown.', uncertainty: 'Small sample.' }],
    uncertainties: [{ description: 'Limited evidence.', evidence: [] }], profile_version: 1, generated_at: new Date().toISOString(), ratings_count: taste.snapshot.length,
    ratings_snapshot: taste.snapshot, context_fingerprint: taste.fingerprint, prompt_version: 1, schema_version: 1, contrast_pairs_count: 1,
    requested_model: 'mock-model', model: 'mock-model', response_id: null, usage: null }));
  return { db, path, folder, close: () => { if (db.open) db.close(); rmSync(folder, { recursive: true, force: true }); } };
}
const q = (value = '') => new URLSearchParams(value);
const personal = (db: Database.Database, id = 2) => db.prepare('SELECT * FROM user_movies WHERE movie_id=?').get(id) as Record<string, unknown>;
const all = (db: Database.Database) => JSON.stringify(['movies', 'user_movies', 'recommendations', 'taste_profile'].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()));
const protectedData = (db: Database.Database) => JSON.stringify(['movies', 'recommendations', 'taste_profile'].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()));
const expectCode = (code: string) => (error: unknown) => error instanceof LibraryError && error.code === code;
const candidate: MovieCandidate = { tmdb_id: 113, media_type: 'movie', title: 'Film 13', original_title: null, year: 2000, runtime: 100,
  overview: 'Confirmed', genres: [{ id: 1, name: 'Drama' }], directors: null, vote_count: null, popularity: null, source: 'llm' };
const patch = (body: unknown) => new Request('http://localhost/api/library/2/rating', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const context = (id = '2') => ({ params: Promise.resolve({ id }) });

test('read-only library includes all watches, including NULL, shorts, TV and legacy records; excludes catalog/unwatched rows', () => {
  const f = fixture(3); try {
    const bytes = readFileSync(f.path), ro = new Database(f.path, { readonly: true });
    try {
      const result = readLibrary(ro); assert.equal(result.total, 12); assert.equal(result.page, 1); assert.equal(result.limit, 25); assert.equal(result.total_pages, 1);
      assert.deepEqual(result.items.map(row => row.movie_id), Array.from({ length: 12 }, (_, i) => i + 1));
      assert.equal(result.items[2].rating_100, 0); assert.equal(result.items[3].rating_100, null); assert.equal(result.items[5].tmdb_id, null);
      assert.equal(ro.pragma('user_version', { simple: true }), 3);
    } finally { ro.close(); }
    assert.deepEqual(readFileSync(f.path), bytes);
  } finally { f.close(); }
});

test('Unicode case-insensitive substring search checks all titles and treats wildcard/SQL-looking text literally', () => {
  const f = fixture(); try {
    for (const [term, ids] of [['тёплый', [1]], ['film three', [3]], ['ENGLISH ALIAS', [4]], ['original', [4]], ['%_', [2]], ["' OR 1=1 --", []]] as const) {
      assert.deepEqual(readLibrary(f.db, new URLSearchParams({ q: term })).items.map(row => row.movie_id), ids);
    }
    assert.equal(readLibrary(f.db, q('q=%20%20')).total, 12);
  } finally { f.close(); }
});

test('rated filter includes zero; year follows displayed source-first fallback year', () => {
  const f = fixture(); try {
    const rated = readLibrary(f.db, q('rated=true')); assert.equal(rated.total, 11); assert.ok(rated.items.some(row => row.rating_100 === 0));
    assert.deepEqual(readLibrary(f.db, q('rated=false')).items.map(row => row.movie_id), [4]);
    assert.deepEqual(readLibrary(f.db, q('year=2001')).items.map(row => row.movie_id), [7]);
    assert.deepEqual(readLibrary(f.db, q('year=1999')).items.map(row => row.movie_id), [8]);
    assert.ok(!readLibrary(f.db, q('year=2000')).items.some(row => row.movie_id === 8));
  } finally { f.close(); }
});

test('pagination is bounded and stable on ties; NULL scores sort last in either direction', () => {
  const f = fixture(); try {
    for (const sort of ['added_desc', 'added_asc', 'rating_desc', 'rating_asc']) {
      const whole = readLibrary(f.db, q(`sort=${sort}`)).items.map(row => row.movie_id);
      const pages = [1, 2, 3, 4].flatMap(page => readLibrary(f.db, q(`sort=${sort}&page=${page}&limit=3`)).items.map(row => row.movie_id));
      assert.deepEqual(pages, whole); assert.equal(new Set(pages).size, 12);
      if (sort.startsWith('rating')) assert.equal(whole.at(-1), 4);
    }
    assert.equal(readLibrary(f.db, q('page=100')).items.length, 0);
    const empty = readLibrary(f.db, q('q=absent')); assert.equal(empty.total, 0); assert.equal(empty.total_pages, 0);
    assert.deepEqual(readLibrary(f.db, q('sort=rating_asc')).items.slice(1, 4).map(row => row.movie_id), [2, 5, 6]);
  } finally { f.close(); }
});

test('details read catalog-only movies without creating personal rows and preserve unknown metadata', () => {
  const f = fixture(); try {
    const before = all(f.db); const row = readLibraryMovie(f.db, 13);
    assert.equal(row.watched, false); assert.equal(row.rating_100, null); assert.equal(row.rating_source, 'none'); assert.equal(row.created_at, null);
    assert.equal(row.poster_path, null); assert.equal(row.credits, null); assert.deepEqual(row.genres, [{ id: 1, name: 'Drama' }]);
    const imported = readLibraryMovie(f.db, 2); assert.equal(imported.original_rating_stars, 3); assert.equal(imported.letterboxd_rating_date, '2020-01-02');
    assert.equal(imported.watched_at, null); assert.equal(all(f.db), before);
    assert.throws(() => readLibraryMovie(f.db, 999), expectCode('movie_not_found'));
  } finally { f.close(); }
});

test('query validation rejects wrong types/ranges, duplicates, unknown fields and unsafe offsets', () => {
  for (const value of ['rated=yes', 'year=0', 'year=10000', 'page=-1', 'page=1.5', 'page=NaN', 'limit=0', 'limit=101', 'sort=rating', 'sort=toString', 'q=a&q=b', 'extra=x', 'page=9007199254740991&limit=100']) {
    assert.throws(() => parseLibraryQuery(q(value)), expectCode('invalid_library_query'));
  }
  assert.throws(() => parseLibraryQuery(new URLSearchParams({ q: 'я'.repeat(201) })), expectCode('invalid_library_query'));
});

test('editing imported/manual ratings and clearing preserve all Letterboxd data, watch state, hidden flag and recommendation history', async () => {
  const f = fixture(); try {
    const before = protectedData(f.db), original = personal(f.db);
    for (const score of [85, 20, 0, 1, 99, 100, null]) {
      const result = await updateLibraryRating(f.db, 2, score); assert.equal(result.status, 'updated'); assert.equal(result.rating_source, score === null ? 'none' : 'manual');
      const row = personal(f.db);
      for (const key of ['movie_id', 'watched', 'watched_at', 'not_interested', 'original_rating_stars', 'letterboxd_date', 'letterboxd_rating_date', 'created_at']) assert.equal(row[key], original[key]);
      assert.equal(row.rating_100, score); assert.equal(readLibraryMovie(f.db, 2).rating_100, score);
      assert.notEqual(row.updated_at, original.updated_at);
    }
    await updateLibraryRating(f.db, 3, 75); assert.equal(personal(f.db, 3).rating_100, 75);
    assert.equal(protectedData(f.db), before); assert.equal(readLibrary(f.db, q('rated=false')).total, 2);
    assert.equal((f.db.prepare('SELECT count(*) n FROM user_movies WHERE movie_id=2').get() as { n: number }).n, 1);
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  } finally { f.close(); }
});

test('same score/NULL is a true no-op preserving source/timestamps without backups or migration', async () => {
  const f = fixture(3); try {
    const before = all(f.db), options = { backup: async () => { throw Error('No backup for no-op'); } };
    assert.equal((await updateLibraryRating(f.db, 2, 60, options)).rating_source, 'letterboxd');
    assert.equal((await updateLibraryRating(f.db, 4, null, options)).status, 'unchanged');
    assert.equal(f.db.pragma('user_version', { simple: true }), 3); assert.equal(all(f.db), before);
  } finally { f.close(); }
});

test('invalid score/ID, missing movie and unwatched movie fail before any backup/write', async () => {
  const f = fixture(3); try {
    const before = all(f.db); let backups = 0; const options = { backup: async () => { backups++; } };
    for (const score of [-1, 101, 1.5, NaN, Infinity, '0', false, {}, undefined]) await assert.rejects(updateLibraryRating(f.db, 2, score, options), expectCode('invalid_rating'));
    for (const id of [0, -1, 2.5, NaN, Infinity]) await assert.rejects(updateLibraryRating(f.db, id, 0, options), expectCode('invalid_movie_id'));
    await assert.rejects(updateLibraryRating(f.db, 999, 0, options), expectCode('movie_not_found'));
    for (const id of [13, 14]) await assert.rejects(updateLibraryRating(f.db, id, 0, options), expectCode('movie_not_watched'));
    assert.equal(backups, 0); assert.equal(all(f.db), before); assert.equal(f.db.pragma('user_version', { simple: true }), 3);
  } finally { f.close(); }
});

test('backup failure prevents writes/migration; successful 3→4 backup can restore original state', async () => {
  const f = fixture(3); try {
    const before = all(f.db); await assert.rejects(updateLibraryRating(f.db, 2, 85, { backup: async () => { throw Error('Backup failure'); } }));
    assert.equal(all(f.db), before); assert.equal(f.db.pragma('user_version', { simple: true }), 3);
    await updateLibraryRating(f.db, 2, 85); assert.equal(f.db.pragma('user_version', { simple: true }), SCHEMA_VERSION);
    const backup = new Database(join(f.folder, 'backups', readdirSync(join(f.folder, 'backups'))[0]), { readonly: true });
    assert.equal(backup.pragma('user_version', { simple: true }), 3); assert.equal(all(backup), before); backup.close();
    f.db.close(); const reopened = new Database(f.path, { readonly: true }); assert.equal(readLibraryMovie(reopened, 2).rating_100, 85); reopened.close();
  } finally { f.close(); }
});

test('SQL failure rolls back both score/source and timestamps; unknown schemas are rejected', async () => {
  const f = fixture(); try {
    f.db.exec("CREATE TRIGGER fail_rating AFTER UPDATE OF rating_100 ON user_movies BEGIN SELECT RAISE(ABORT,'Synthetic SQL failure'); END;");
    const before = all(f.db); await assert.rejects(updateLibraryRating(f.db, 2, 85)); assert.equal(all(f.db), before);
    f.db.pragma(`user_version=${SCHEMA_VERSION + 1}`); await assert.rejects(updateLibraryRating(f.db, 2, 85), /schema/);
    assert.throws(() => readLibrary(f.db), /schema/); assert.throws(() => readLibraryMovie(f.db, 2), /schema/);
  } finally { f.close(); }
});

test('transaction rechecks watch/current score after backup and cannot undo a concurrent watch change', async () => {
  const f = fixture(); try {
    const stable = await updateLibraryRating(f.db, 2, 85, { backup: async db => { db.prepare("UPDATE user_movies SET rating_100=85,rating_source='manual' WHERE movie_id=2").run(); } });
    assert.equal(stable.status, 'unchanged');
    await assert.rejects(updateLibraryRating(f.db, 2, 20, { backup: async db => { db.prepare('UPDATE user_movies SET watched=0 WHERE movie_id=2').run(); } }), expectCode('movie_not_watched'));
    assert.equal(personal(f.db).watched, 0); assert.equal(personal(f.db).rating_100, 85);
  } finally { f.close(); }
});

test('rating edits/clears update both contexts and current evidence; cleared watches remain excluded and never restore imported stars', async () => {
  const f = fixture(); try {
    const before = protectedData(f.db);
    for (const value of [85, 20, 0, null]) {
      await updateLibraryRating(f.db, 2, value);
      const generated = buildCandidateContext(f.db), ranked = buildRankingContext(f.db, [candidate]);
      for (const context of [generated.context, ranked.context]) {
        const diff = context.rating_changes.find(row => row.movie_id === 2)!; assert.equal(diff.previous_rating_100, 60); assert.equal(diff.rating_100, value);
      }
      assert.equal(ranked.snapshot.find(row => row.movie_id === 2)?.rating_100 ?? null, value);
      assert.equal(prepareTasteInputs(f.db).profileRefresh[value === null ? 'cleared' : 'changed'], 1);
      assert.equal(blockedReason({ id: 102, title: 'Film 100%_Match', original_title: null, year: 2000 }, readCandidateHistory(f.db)), 'watched');
    }
    await confirmMovieWatch(f.db, { movie_id: 2, watched: true }); assert.equal(personal(f.db).rating_100, null); assert.equal(personal(f.db).original_rating_stars, 3);
    assert.equal(protectedData(f.db), before);
  } finally { f.close(); }
});

test('ten net differences recommend refresh and returning to snapshot scores removes differences without regenerating profile', async () => {
  const f = fixture(); try {
    const profile = protectedData(f.db);
    for (let id = 1; id <= 10; id++) {
      await updateLibraryRating(f.db, id, 85);
      const refresh = prepareTasteInputs(f.db).profileRefresh;
      assert.equal(refresh.total_changes, id);
      if (id === 9) assert.equal(refresh.status, 'stale');
      if (id === 10) assert.equal(refresh.status, 'refresh_recommended');
    }
    for (let id = 1; id <= 10; id++) await updateLibraryRating(f.db, id, id === 1 ? 100 : id === 3 ? 0 : id === 4 ? null : 60);
    const state = prepareTasteInputs(f.db); assert.equal(state.changes.length, 0); assert.equal(state.profileRefresh.status, 'current'); assert.equal(protectedData(f.db), profile);
  } finally { f.close(); }
});

test('HTTP read handlers require readonly connections; query/body validation precedes opening SQLite', async () => {
  const f = fixture(3); try {
    let opens = 0;
    const handlers = libraryHandlers({ open: options => { opens++; assert.equal(options?.readonly, true); return new Database(f.path, { readonly: true }); } });
    const before = readFileSync(f.path);
    assert.equal((await handlers.list(new Request('http://localhost/api/library'))).status, 200);
    assert.equal((await handlers.details(new Request('http://localhost/'), context('13'))).status, 200);
    assert.equal((await handlers.details(new Request('http://localhost/'), context('999'))).status, 404);
    const count = opens;
    for (const id of ['0', '-1', '2.5', '9007199254740992']) assert.equal((await handlers.details(new Request('http://localhost/'), context(id))).status, 400);
    assert.equal((await handlers.list(new Request('http://localhost/api/library?limit=101'))).status, 400);
    for (const body of [{}, { rating_100: '0' }, { rating_100: 85, watched: false }, [], null, { rating_100: 'a'.repeat(2000) }]) assert.equal((await handlers.rating(patch(body), context())).status, 400);
    assert.equal((await handlers.rating(new Request('http://localhost/', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{' }), context())).status, 400);
    assert.equal(opens, count); assert.deepEqual(readFileSync(f.path), before);
  } finally { f.close(); }
});

test('HTTP edit/read/clear preserves watched state, returns no-store and sanitizes technical errors without network', async () => {
  const f = fixture(); const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => { throw Error('Network forbidden'); };
    const handlers = libraryHandlers({ open: options => { const db = new Database(f.path, { readonly: options?.readonly ?? false }); db.pragma('foreign_keys=ON'); return db; } });
    for (const value of [85, null]) {
      const response = await handlers.rating(patch({ rating_100: value }), context()); assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'no-store');
      const details = await handlers.details(new Request('http://localhost/'), context()); assert.equal(details.headers.get('Cache-Control'), 'no-store');
      const body = await details.json(); assert.equal(body.watched, true); assert.equal(body.rating_100, value);
    }
    assert.equal((await handlers.rating(patch({ rating_100: 0 }), context('13'))).status, 409);
    assert.equal((await handlers.rating(patch({ rating_100: 0 }), context('999'))).status, 404);
    const failed = libraryHandlers({ open: () => { throw Error('/private/db/path secret'); } });
    const error = await failed.list(new Request('http://localhost/')); assert.equal(error.status, 500); assert.ok(!(await error.text()).includes('/private'));
  } finally { globalThis.fetch = originalFetch; f.close(); }
});
