import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { migrateDatabase } from '../src/lib/migrations';
import { backupDatabase, restoreBackup, verifyBackup } from './container-db.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'recommendme-backup-'));
  const data = join(root, 'data'), path = join(data, 'movies.sqlite');
  mkdirSync(data);
  const db = new Database(path); db.pragma('foreign_keys=ON'); migrateDatabase(db);
  db.exec(`INSERT INTO movies(id,title) VALUES(1,'Synthetic Zero'),(2,'Synthetic Unrated');
    INSERT INTO user_movies(movie_id,watched,rating_100) VALUES(1,1,0),(2,1,NULL);
    INSERT INTO recommendations(movie_id,result_id,why_fit,possible_mismatch) VALUES(1,'legacy:test','Test fit','Test risk');
    INSERT INTO taste_profile(profile_json) VALUES('{"synthetic":true}')`);
  db.close();
  return { root, data, path, backups: join(root, 'backups'), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('offline SQLite API backup restores 0/NULL, profile, history, private journal and lock at the same canonical path', async () => {
  const f = fixture();
  try {
    const folder = join(f.data, '.recommendation-runs', 'synthetic'); mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'request.json'), '{"stage":"save_failed"}');
    writeFileSync(f.path + '.recommendations.lock', '{"pid":123,"request_id":"synthetic"}');
    const original = readFileSync(f.path);
    const snapshot = await backupDatabase(f.path, f.backups);
    assert.deepEqual(readFileSync(f.path), original);
    assert.equal(verifyBackup(snapshot).counts.user_movies, 2);
    assert.throws(() => restoreBackup(snapshot, f.path), /completely empty/);
    const other = join(f.root, 'other', 'movies.sqlite');
    assert.throws(() => restoreBackup(snapshot, other), /canonical/);
    renameSync(f.data, join(f.root, 'old-data'));
    restoreBackup(snapshot, f.path);
    const db = new Database(f.path, { readonly: true });
    try {
      assert.deepEqual(db.prepare('SELECT rating_100 FROM user_movies ORDER BY movie_id').all(), [{ rating_100: 0 }, { rating_100: null }]);
      assert.equal((db.prepare('SELECT count(*) n FROM recommendations').get() as { n: number }).n, 1);
      assert.equal((db.prepare('SELECT profile_json FROM taste_profile').get() as { profile_json: string }).profile_json, '{"synthetic":true}');
    } finally { db.close(); }
    assert.equal(readFileSync(join(folder, 'request.json'), 'utf8'), '{"stage":"save_failed"}');
    assert.ok(existsSync(f.path + '.recommendations.lock')); // Never auto-clear a restored lock.
  } finally { f.cleanup(); }
});

test('snapshot checksums reject corruption before restore; unknown schema refuses backup without an artifact', async () => {
  const f = fixture();
  try {
    const snapshot = await backupDatabase(f.path, f.backups);
    writeFileSync(join(snapshot, 'database.sqlite'), 'corrupt');
    assert.throws(() => verifyBackup(snapshot), /checksum/);
    const db = new Database(f.path); db.pragma('user_version=999'); db.close();
    await assert.rejects(backupDatabase(f.path, join(f.root, 'future-backups')), /Unsupported/);
    assert.equal(existsSync(join(f.root, 'future-backups')), false);
  } finally { f.cleanup(); }
});

test('explicit canonical relocation rekeys the journal without changing JSON, locks, SQL rows or source snapshot', async () => {
  const f = fixture();
  try {
    const canonical = realpathSync(f.path), key = (path: string) => createHash('sha256').update(path).digest('hex').slice(0, 24);
    const request = 'c5200000-0000-4000-8000-000000000001';
    const journal = join(f.data, '.recommendation-runs', key(canonical)); mkdirSync(journal, { recursive: true });
    const run = JSON.stringify({ request_id: request, result_id: 'legacy:test', stage: 'saved', calls: { openai: 2, tmdb: 76 } });
    writeFileSync(join(journal, request + '.json'), run);
    writeFileSync(join(journal, 'latest.json'), JSON.stringify({ request_id: request }));
    const lock = '{"pid":999999,"started_at":"2020-01-01T00:00:00.000Z"}';
    writeFileSync(f.path + '.recommendations.lock', lock);
    const snapshot = await backupDatabase(f.path, f.backups), before = verifyBackup(snapshot);
    const target = join(f.root, 'relocated'); mkdirSync(target);
    const relocated = join(target, 'movies.sqlite');
    assert.throws(() => restoreBackup(snapshot, relocated), /canonical/);
    assert.throws(() => restoreBackup(snapshot, relocated, { relocateFrom: canonical + '.wrong' }), /exactly match/);
    assert.deepEqual(readdirSync(target), []);
    restoreBackup(snapshot, relocated, { relocateFrom: canonical });
    const newJournal = join(target, '.recommendation-runs', key(realpathSync(relocated)));
    assert.equal(readFileSync(join(newJournal, request + '.json'), 'utf8'), run);
    assert.equal(readFileSync(relocated + '.recommendations.lock', 'utf8'), lock);
    assert.equal(existsSync(join(target, '.recommendation-runs', key(canonical))), false);
    const original = new Database(f.path, { readonly: true }), restored = new Database(relocated, { readonly: true });
    try {
      for (const table of ['movies', 'user_movies', 'recommendations', 'taste_profile']) {
        assert.deepEqual(restored.prepare(`SELECT * FROM ${table} ORDER BY 1`).all(), original.prepare(`SELECT * FROM ${table} ORDER BY 1`).all());
      }
    } finally { original.close(); restored.close(); }
    assert.deepEqual(verifyBackup(snapshot), before);
  } finally { f.cleanup(); }
});

test('journal relocation refuses a conflicting key and invalid CLI options without copying a database', async () => {
  const f = fixture();
  try {
    const target = join(f.root, 'relocated'); mkdirSync(target);
    const canonical = realpathSync(f.path), relocated = join(realpathSync(target), 'movies.sqlite');
    const key = createHash('sha256').update(relocated).digest('hex').slice(0, 24);
    const conflict = join(f.data, '.recommendation-runs', key); mkdirSync(conflict, { recursive: true });
    writeFileSync(join(conflict, 'latest.json'), '{"existing":true}');
    const snapshot = await backupDatabase(f.path, f.backups);
    assert.throws(() => restoreBackup(snapshot, relocated, { relocateFrom: canonical }), /already exists/);
    assert.deepEqual(readdirSync(target), []);
    for (const args of [['restore', snapshot, '--offline', '--relocate-from'], ['check', '--relocate-from', canonical], ['restore', snapshot, '--relocate-from', canonical]]) {
      const result = spawnSync(process.execPath, ['scripts/container-db.mjs', ...args], { env: { ...process.env, DATABASE_PATH: relocated }, encoding: 'utf8' });
      assert.equal(result.status, 1);
      assert.equal(existsSync(relocated), false);
    }
  } finally { f.cleanup(); }
});
