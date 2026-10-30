import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDatabase } from '../src/lib/db';
import { migrateDatabase, SCHEMA_VERSION } from '../src/lib/migrations';

function fixture(initialize = true) {
  const directory = mkdtempSync(join(tmpdir(), 'movie-schema-'));
  const path = join(directory, 'movies.sqlite');
  const previous = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = path;
  let db: ReturnType<typeof openDatabase>;
  try {
    db = openDatabase({create:true});
  } finally {
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
  }
  try {
    if (initialize) migrateDatabase(db);
  } catch (error) {
    db.close();
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  return { db, path, cleanup() { db.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('fresh schema has seven STRICT tables; reinitialization preserves rows and version', () => {
  const { db, cleanup } = fixture(false);
  try {
    assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
    assert.equal(db.pragma('user_version', { simple: true }), 0);
    assert.equal(migrateDatabase(db), SCHEMA_VERSION);
    const tables = db.prepare("SELECT name, strict FROM pragma_table_list WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
    assert.deepEqual(tables, ['movies', 'profiles', 'recommendation_evaluation', 'recommendation_outcomes', 'recommendations', 'taste_profile', 'user_movies'].map(name => ({ name, strict: 1 })));
    db.prepare('INSERT INTO movies (title, release_year) VALUES (?, ?)').run('Фильм', 2000);
    db.exec('INSERT INTO user_movies (user_id,movie_id, watched) VALUES (\'ilya\',1, 1)');
    db.exec('INSERT INTO recommendations (user_id,movie_id) VALUES (\'ilya\',1)');
    db.prepare('INSERT INTO taste_profile (user_id,profile_json) VALUES (\'ilya\',?)').run('{"preferences":[]}');
    const before = db.serialize();
    assert.equal(migrateDatabase(db), SCHEMA_VERSION);
    assert.deepEqual(db.serialize(), before);
  } finally { cleanup(); }
});

test('migration failure rolls back tables and version without removing existing data', () => {
  const { db, cleanup } = fixture(false);
  try {
    db.exec("CREATE TABLE recommendations (existing TEXT); INSERT INTO recommendations VALUES ('keep')");
    assert.throws(() => migrateDatabase(db), /already exists/);
    assert.equal(db.pragma('user_version', { simple: true }), 0);
    assert.deepEqual(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='movies'").get(), { n: 0 });
    assert.deepEqual(db.prepare('SELECT * FROM recommendations').all(), [{ existing: 'keep' }]);
  } finally { cleanup(); }
});

test('unknown future schema version is rejected without changes', () => {
  const { db, cleanup } = fixture();
  try {
    db.pragma('user_version = 99');
    const before = db.serialize();
    assert.throws(() => migrateDatabase(db), /Unsupported database schema version 99/);
    assert.deepEqual(db.serialize(), before);
  } finally { cleanup(); }
});

test('watched without rating; 0 and 100; editing and clearing preserve a single watched row', () => {
  const { db, cleanup } = fixture();
  try {
    db.prepare('INSERT INTO movies (title) VALUES (?)').run('Без оценки');
    db.exec('INSERT INTO user_movies (user_id,movie_id, watched) VALUES (\'ilya\',1, 1)');
    assert.deepEqual(db.prepare('SELECT watched, rating_100, watched_at, letterboxd_date FROM user_movies').get(),
      { watched: 1, rating_100: null, watched_at: null, letterboxd_date: null });
    const update = db.prepare('UPDATE user_movies SET rating_100 = ?, rating_source = ? WHERE movie_id = 1');
    for (const value of [0, 100, 75, null]) {
      update.run(value, value === null ? 'none' : 'manual');
      assert.deepEqual(db.prepare('SELECT watched, rating_100 FROM user_movies').all(), [{ watched: 1, rating_100: value }]);
    }
    for (const value of [-1, 101, 5.5, 'invalid']) assert.throws(() => update.run(value, 'manual'));
    assert.throws(() => db.exec('INSERT INTO user_movies (user_id,movie_id) VALUES (\'ilya\',1)'));
  } finally { cleanup(); }
});

test('unique external IDs; unknown IDs and identical titles are allowed', () => {
  const { db, cleanup } = fixture();
  try {
    const insert = db.prepare('INSERT INTO movies (title, release_year, tmdb_id, letterboxd_uri) VALUES (?, ?, ?, ?)');
    insert.run('Same title', 2000, 10, 'https://letterboxd.com/film/example/');
    insert.run('Same title', 2000, null, null);
    insert.run('Same title', 2000, null, null);
    assert.throws(() => insert.run('Different title', 2020, 10, null));
    assert.throws(() => insert.run('Different title', 2020, null, 'https://letterboxd.com/film/example/'));
    assert.throws(() => insert.run('  ', null, null, null));
    assert.throws(() => db.exec("INSERT INTO movies (title, media_type, tmdb_id) VALUES ('TV', 'tv', 99)"));
    db.exec("INSERT INTO movies (title, media_type) VALUES ('TV', 'tv')");
  } finally { cleanup(); }
});

test('booleans, metadata JSON, rating source and original half stars are constrained', () => {
  const { db, cleanup } = fixture();
  try {
    db.exec("INSERT INTO movies (title, genres_json) VALUES ('Test', '[]'); INSERT INTO user_movies (user_id,movie_id) VALUES ('ilya',1)");
    for (const field of ['watched', 'not_interested']) {
      assert.throws(() => db.exec(`UPDATE user_movies SET ${field} = 2`));
    }
    for (const value of [-0.5, 5.5, 3.7]) {
      assert.throws(() => db.prepare('UPDATE user_movies SET original_rating_stars = ?').run(value));
    }
    for (const value of [null, 0, 0.5, 5]) db.prepare('UPDATE user_movies SET original_rating_stars = ?').run(value);
    assert.throws(() => db.exec("UPDATE user_movies SET rating_source = 'other'"));
    for (const json of ['invalid', '{}']) assert.throws(() => db.prepare('UPDATE movies SET genres_json = ?').run(json));
  } finally { cleanup(); }
});

test('recommendations can repeat; rejection does not change watched or rating', () => {
  const { db, cleanup } = fixture();
  try {
    db.exec("INSERT INTO movies (title) VALUES ('Test'); INSERT INTO user_movies (user_id,movie_id, rating_100) VALUES ('ilya',1, 80)");
    const insert = db.prepare('INSERT INTO recommendations (user_id,movie_id, why_fit, possible_mismatch) VALUES (\'ilya\',?, ?, ?)');
    insert.run(1, 'Fit', 'Risk'); insert.run(1, null, null);
    db.exec('UPDATE recommendations SET rejected = 1 WHERE id = 1; UPDATE user_movies SET not_interested = 1 WHERE movie_id = 1');
    assert.deepEqual(db.prepare('SELECT rejected FROM recommendations ORDER BY id').all(), [{ rejected: 1 }, { rejected: 0 }]);
    assert.deepEqual(db.prepare('SELECT watched, rating_100, not_interested FROM user_movies').get(), { watched: 0, rating_100: 80, not_interested: 1 });
    assert.throws(() => db.exec('UPDATE recommendations SET rejected = -1'));
  } finally { cleanup(); }
});

test('single valid JSON taste profile; updates touch timestamp while no-op updates do not', () => {
  const { db, cleanup } = fixture();
  try {
    db.prepare('INSERT INTO taste_profile (user_id,profile_json, updated_at) VALUES (\'ilya\',?, ?)').run('{"likes":[]}', '2000-01-01T00:00:00.000Z');
    const created = (db.prepare('SELECT created_at FROM taste_profile').get() as { created_at: string }).created_at;
    assert.match(created, /^\d{4}-\d{2}-\d{2}T.*Z$/);
    db.exec('UPDATE taste_profile SET profile_json = profile_json');
    assert.deepEqual(db.prepare('SELECT updated_at FROM taste_profile').get(), { updated_at: '2000-01-01T00:00:00.000Z' });
    db.prepare('UPDATE taste_profile SET profile_json = ?').run('{"likes":["drama"]}');
    const row = db.prepare('SELECT * FROM taste_profile').get() as { user_id: string; profile_json: string; created_at: string; updated_at: string };
    assert.equal(row.user_id, 'ilya'); assert.equal(row.created_at, created);
    assert.notEqual(row.updated_at, '2000-01-01T00:00:00.000Z');
    assert.deepEqual(JSON.parse(row.profile_json), { likes: ['drama'] });
    assert.throws(() => db.prepare('UPDATE taste_profile SET profile_json = ?').run('broken'));
    assert.throws(() => db.exec("INSERT INTO taste_profile (user_id, profile_json) VALUES (2, '{}')"));
    assert.throws(() => db.exec("INSERT INTO taste_profile (user_id,profile_json) VALUES ('ilya','{}')"));
  } finally { cleanup(); }
});

test('personal history timestamps update only on content changes and preserve original dates', () => {
  const { db, cleanup } = fixture();
  try {
    db.exec("INSERT INTO movies (title) VALUES ('Test')");
    db.prepare('INSERT INTO user_movies (user_id,movie_id, watched, original_rating_stars, rating_source, letterboxd_date, updated_at) VALUES (\'ilya\',1, 1, 4.5, ?, ?, ?)')
      .run('letterboxd', '2020-02-03', '2000-01-01T00:00:00.000Z');
    const before = db.prepare('SELECT created_at, updated_at FROM user_movies').get() as { created_at: string; updated_at: string };
    db.exec('UPDATE user_movies SET watched = watched');
    assert.deepEqual(db.prepare('SELECT created_at, updated_at FROM user_movies').get(), before);
    db.exec("UPDATE user_movies SET rating_100 = 0, rating_source = 'manual'");
    const after = db.prepare('SELECT * FROM user_movies').get() as Record<string, unknown>;
    assert.equal(after.created_at, before.created_at); assert.notEqual(after.updated_at, before.updated_at);
    assert.equal(after.original_rating_stars, 4.5); assert.equal(after.letterboxd_date, '2020-02-03'); assert.equal(after.watched_at, null);
  } finally { cleanup(); }
});

test('foreign keys reject orphan rows and deletion of referenced films', () => {
  const { db, cleanup } = fixture();
  try {
    for (const table of ['user_movies', 'recommendations']) {
      assert.throws(() => db.exec(`INSERT INTO ${table} (movie_id) VALUES (999)`));
    }
    db.exec("INSERT INTO movies (id, title) VALUES (1, 'History'), (2, 'Recommendation')");
    db.exec('INSERT INTO user_movies (user_id,movie_id) VALUES (\'ilya\',1); INSERT INTO recommendations (user_id,movie_id) VALUES (\'ilya\',2)');
    for (const id of [1, 2]) assert.throws(() => db.prepare('DELETE FROM movies WHERE id = ?').run(id));
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally { cleanup(); }
});

test('db:init CLI is repeatable; migrated data survives a new process', () => {
  const { db, path, cleanup } = fixture(false);
  try {
    const init = () => spawnSync(process.execPath, ['--import', 'tsx', 'scripts/db-init.ts','--offline'], {
      env: { ...process.env, DATABASE_PATH: path }, encoding: 'utf8',
    });
    const first = init(); assert.equal(first.status, 0, first.stderr);
    db.exec("INSERT INTO movies (title) VALUES ('Persisted'); INSERT INTO user_movies (user_id,movie_id, watched, rating_100) VALUES ('ilya',1, 1, 0)");
    const second = init(); assert.equal(second.status, 0, second.stderr);
    const reader = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import { openDatabase } from './src/lib/db.ts';
      const db = openDatabase({create:true});
      console.log(JSON.stringify(db.prepare('SELECT watched, rating_100 FROM user_movies').all())); db.close();
    `], { env: { ...process.env, DATABASE_PATH: path }, encoding: 'utf8' });
    assert.equal(reader.status, 0, reader.stderr);
    assert.deepEqual(JSON.parse(reader.stdout), [{ watched: 1, rating_100: 0 }]);
    db.pragma('user_version = 99');
    const bad = init(); assert.equal(bad.status, 1); assert.match(bad.stderr, /Unsupported database schema version/);
  } finally { cleanup(); }
});
