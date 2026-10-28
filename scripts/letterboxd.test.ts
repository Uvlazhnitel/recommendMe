import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { parseCsv, prepareLetterboxd, importLetterboxd } from '../src/lib/letterboxd';
import { migrateDatabase, SCHEMA_VERSION } from '../src/lib/migrations';

const wh = 'Date,Name,Year,Letterboxd URI\n';
const rh = 'Date,Name,Year,Letterboxd URI,Rating\n';
const w = '2020-01-02,Test,2000,uri:test\n';
const r = '2021-03-04,Test,2000,uri:test,4.5\n';
function fixture(version1 = false) {
  const directory = mkdtempSync(join(tmpdir(), 'letterboxd-'));
  const db = new Database(join(directory, 'db.sqlite'));
  db.pragma('foreign_keys=ON');
  if (version1) { db.exec(readFileSync('migrations/001_initial.sql', 'utf8')); db.pragma('user_version=1'); }
  else migrateDatabase(db);
  let sequence = 0;
  return { db, backup: () => join(directory, `backup-${sequence++}.sqlite`),
    cleanup: () => { db.close(); rmSync(directory, { recursive: true, force: true }); } };
}
function snapshot(db: Database.Database) { return db.serialize(); }

test('CSV handles BOM, escaped quotes, commas, embedded newlines, CRLF, column order and extra columns', () => {
  assert.deepEqual(parseCsv('\uFEFFa,b\r\n"one, two","say ""hi""\nnext"\r\n'), [['a', 'b'], ['one, two', 'say "hi"\nnext']]);
  const plan = prepareLetterboxd('\uFEFFName,Extra,Year,Letterboxd URI,Date\r\n"Film, ""A""\nB",x,2000,uri:a,2020-01-01\r\n', rh);
  assert.equal(plan.groups[0].title, 'Film, "A"\nB'); assert.equal(plan.issues.length, 0);
  for (const text of ['a\n"broken', 'a\nabc"', 'a\n"x"tail']) assert.throws(() => parseCsv(text), /CSV/);
});

test('merge sources, preserve both dates and unrated history; repeated import is byte-for-byte stable', async () => {
  const f = fixture();
  try {
    const plan = prepareLetterboxd(wh + w + '2020-02-03,Short,2001,uri:short\n', rh + r);
    const result = await importLetterboxd(f.db, plan, f.backup());
    assert.deepEqual(result.importedHistory, { watched: 2, rated: 1, unrated: 1 });
    assert.equal(result.addedMovies, 2); assert.equal(result.addedHistory, 2);
    assert.deepEqual(f.db.prepare('SELECT rating_100, original_rating_stars, letterboxd_date, letterboxd_rating_date, watched_at FROM user_movies WHERE movie_id=1').get(),
      { rating_100: 90, original_rating_stars: 4.5, letterboxd_date: '2020-01-02', letterboxd_rating_date: '2021-03-04', watched_at: null });
    assert.deepEqual(f.db.prepare('SELECT DISTINCT media_type, tmdb_id, runtime_minutes FROM movies').all(), [{ media_type: 'unknown', tmdb_id: null, runtime_minutes: null }]);
    const before = snapshot(f.db);
    const repeat = await importLetterboxd(f.db, plan, f.backup());
    assert.equal(repeat.addedMovies, 0); assert.equal(repeat.addedHistory, 0); assert.equal(repeat.preservedHistory, 2);
    assert.deepEqual(snapshot(f.db), before);
  } finally { f.cleanup(); }
});

test('all exact half-star ratings including zero; empty rating is NULL; invalid values are reported', async () => {
  const f = fixture();
  try {
    const records = Array.from({ length: 11 }, (_, i) => `2020-01-01,Film${i},2000,uri:${i},${i / 2}\n`).join('');
    const plan = prepareLetterboxd(wh, rh + records + '2020-01-01,Empty,2000,uri:empty,\n' +
      ['-1', '5.5', '3.7', 'abc'].map((rating, i) => `2020-01-01,Bad${i},2000,uri:bad${i},${rating}\n`).join(''));
    const result = await importLetterboxd(f.db, plan, f.backup());
    assert.equal(result.skippedRows, 4); assert.equal(result.status, 'partial');
    assert.deepEqual(f.db.prepare('SELECT rating_100 FROM user_movies ORDER BY movie_id').all(), [...Array.from({ length: 11 }, (_, i) => ({ rating_100: i * 10 })), { rating_100: null }]);
    assert.equal(result.ratingsOutsideWatched, 12);
  } finally { f.cleanup(); }
});

test('fatal header or CSV errors preclude import; invalid rows report source and record', () => {
  for (const watched of ['Name,Year\nTest,2000', 'Date,Name,Name,Year,Letterboxd URI\n', wh + '"unclosed']) {
    assert.throws(() => prepareLetterboxd(watched, rh));
  }
  const plan = prepareLetterboxd(wh + '2020-02-30,Test,2000,u\n2020-01-01,,2000,u\n2020-01-01,Test,no,u\nwrong,column,count\n', rh);
  assert.equal(plan.groups.length, 0); assert.equal(plan.issues.length, 4);
  assert.deepEqual(plan.issues.map(x => [x.source, x.record]), [['watched', 2], ['watched', 3], ['watched', 4], ['watched', 5]]);
});

test('duplicates collapse, URI conflicts skip entire identity, different URI/year remain distinct', async () => {
  const f = fixture();
  try {
    const plan = prepareLetterboxd(wh + w + w + '2020-01-01,Test,2001,uri:other\n2020-01-01,Test,2000,uri:third\n' +
      '2020-01-01,Conflict,2000,uri:conflict\n2020-01-01,Conflict,2001,uri:conflict\n', rh + r);
    const result = await importLetterboxd(f.db, plan, f.backup());
    assert.equal(result.addedMovies, 3); assert.equal(result.duplicates, 1); assert.equal(result.skippedRows, 2);
  } finally { f.cleanup(); }
});

test('missing URI uses only unambiguous normalized title/year; missing year is reported', async () => {
  const f = fixture();
  try {
    const plan = prepareLetterboxd(wh + w + '2020-01-01,Twin,2000,uri:a\n2020-01-01,Twin,2000,uri:b\n2020-01-01,Unknown,,\n',
      rh + '2020-01-01, test ,2000,,5\n2020-01-01,Twin,2000,,4\n2020-01-01,No URI,2005,,3\n');
    const result = await importLetterboxd(f.db, plan, f.backup());
    assert.equal(result.addedMovies, 4); assert.equal(result.skippedRows, 2);
    const before = snapshot(f.db);
    const repeat = await importLetterboxd(f.db, plan, f.backup());
    assert.equal(repeat.addedMovies, 0); assert.deepEqual(snapshot(f.db), before);
  } finally { f.cleanup(); }
});

test('manual rating, cleared rating, movie metadata, recommendation, profile and timestamps are preserved', async () => {
  const f = fixture();
  try {
    const plan = prepareLetterboxd(wh + w + '2020-01-01,Other,2001,uri:other\n', rh + r + '2020-01-01,Other,2001,uri:other,5\n');
    await importLetterboxd(f.db, plan, f.backup());
    f.db.exec("UPDATE user_movies SET rating_100=12, rating_source='manual', not_interested=1 WHERE movie_id=1; UPDATE user_movies SET rating_100=NULL, rating_source='none' WHERE movie_id=2");
    f.db.exec("UPDATE movies SET overview='Keep', tmdb_id=42, media_type='movie' WHERE id=1; INSERT INTO recommendations (movie_id, rejected) VALUES (1,1); INSERT INTO taste_profile (profile_json) VALUES ('{}')");
    const before = snapshot(f.db);
    await importLetterboxd(f.db, plan, f.backup());
    assert.deepEqual(snapshot(f.db), before);
  } finally { f.cleanup(); }
});

test('existing unknown-URI movie can be linked without overwriting personal history; ambiguous library is skipped', async () => {
  const f = fixture();
  try {
    f.db.exec("INSERT INTO movies (title,release_year,overview) VALUES ('Test',2000,'Keep'); INSERT INTO user_movies (movie_id,rating_100) VALUES (1,80)");
    const beforeHistory = f.db.prepare('SELECT * FROM user_movies').all();
    const result = await importLetterboxd(f.db, prepareLetterboxd(wh + w, rh + r), f.backup());
    assert.equal(result.attachedUris, 1); assert.equal(result.addedMovies, 0);
    assert.deepEqual(f.db.prepare('SELECT * FROM user_movies').all(), beforeHistory);
    f.db.exec("INSERT INTO movies (title,release_year) VALUES ('Twin',2000),('Twin',2000)");
    const bad = await importLetterboxd(f.db, prepareLetterboxd(wh + '2020-01-01,Twin,2000,uri:twin\n', rh), f.backup());
    assert.equal(bad.addedMovies, 0); assert.equal(bad.skippedRows, 1);
  } finally { f.cleanup(); }
});

test('backup is readable, backup failure prevents changes, SQL failure rolls back all import rows', async () => {
  const f = fixture();
  try {
    const plan = prepareLetterboxd(wh + w + '2020-01-01,Other,2000,uri:other\n', rh + r);
    const before = snapshot(f.db);
    await assert.rejects(() => importLetterboxd(f.db, plan, join(f.backup(), 'missing', 'db.sqlite')));
    assert.deepEqual(snapshot(f.db), before);
    f.db.exec("CREATE TRIGGER fail_import BEFORE INSERT ON movies WHEN NEW.title='Other' BEGIN SELECT RAISE(ABORT, 'forced failure'); END");
    const backup = f.backup();
    const beforeFailure = snapshot(f.db);
    await assert.rejects(() => importLetterboxd(f.db, plan, backup), /forced failure/);
    assert.deepEqual(snapshot(f.db), beforeFailure);
    const restored = new Database(backup, { readonly: true });
    try { assert.deepEqual(restored.prepare('SELECT * FROM movies').all(), []); assert.deepEqual(restored.pragma('integrity_check'), [{ integrity_check: 'ok' }]); }
    finally { restored.close(); }
  } finally { f.cleanup(); }
});

test('migration from version 1 preserves data and includes new date in update trigger', async () => {
  const f = fixture(true);
  try {
    f.db.exec("INSERT INTO movies (title,letterboxd_uri) VALUES ('Existing','uri:existing'); INSERT INTO user_movies (movie_id,rating_100,updated_at) VALUES (1,75,'2000-01-01T00:00:00.000Z')");
    const old = f.db.prepare('SELECT * FROM user_movies').get() as Record<string, unknown>;
    const backup = f.backup();
    await importLetterboxd(f.db, prepareLetterboxd(wh + w, rh + r), backup);
    assert.equal(f.db.pragma('user_version', { simple: true }), SCHEMA_VERSION);
    assert.deepEqual(f.db.prepare('SELECT * FROM user_movies WHERE movie_id=1').get(), { ...old, letterboxd_rating_date: null, review_text: null });
    f.db.exec("UPDATE user_movies SET letterboxd_rating_date='2020-01-01' WHERE movie_id=1");
    assert.notEqual((f.db.prepare('SELECT updated_at FROM user_movies WHERE movie_id=1').get() as { updated_at: string }).updated_at, old.updated_at);
    const saved = new Database(backup, { readonly: true });
    try { assert.equal(saved.pragma('user_version', { simple: true }), 1); } finally { saved.close(); }
  } finally { f.cleanup(); }
});

test('CLI defaults and arguments, partial reports, missing files and fatal errors', () => {
  const f = fixture();
  const directory = mkdtempSync(join(tmpdir(), 'letterboxd-cli-'));
  try {
    const imports = join(directory, 'data/import');
    mkdirSync(imports, { recursive: true });
    const watched = join(imports, 'watched(6).csv');
    const ratings = join(imports, 'ratings(6).csv');
    writeFileSync(watched, wh + w + '2020-02-30,Bad,2000,uri:bad\n');
    writeFileSync(ratings, rh + r);
    const run = (args: string[] = []) => spawnSync(process.execPath,
      ['--import', createRequire(import.meta.url).resolve('tsx'), resolve('scripts/seed-letterboxd.ts'), ...args],
      { cwd: directory, env: { ...process.env, DATABASE_PATH: f.db.name }, encoding: 'utf8' });
    const partial = run();
    assert.equal(partial.status, 1, partial.stderr);
    const reports = join(directory, 'data/import-reports');
    const report = JSON.parse(readFileSync(join(reports, readdirSync(reports)[0]), 'utf8'));
    assert.equal(report.status, 'partial'); assert.equal(report.addedMovies, 1); assert.equal(report.skippedRows, 1);
    assert.equal(readdirSync(join(directory, 'data/backups')).length, 1);
    const before = snapshot(f.db);
    const missing = run(['--watched', join(directory, 'absent.csv')]);
    assert.equal(missing.status, 1); assert.match(missing.stderr, /ENOENT/);
    writeFileSync(watched, 'Name,Year\nWrong,2000\n');
    const bad = run(['--watched', watched, '--ratings', ratings]);
    assert.equal(bad.status, 1); assert.match(bad.stderr, /headers/);
    assert.equal(readdirSync(join(directory, 'data/backups')).length, 1);
    assert.deepEqual(snapshot(f.db), before);
    assert.equal(run(['--unknown']).status, 1);
  } finally { f.cleanup(); rmSync(directory, { recursive: true, force: true }); }
});
