import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

function run(source: string, databasePath: string) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_PATH: databasePath },
    encoding: 'utf8',
  });
  assert.ifError(result.error);
  return result;
}
const databaseImport = `import { openDatabase } from './src/lib/db.ts';`;

test('SQLite preserves data across independent processes; connection creates no tables', () => {
  const directory = mkdtempSync(join(tmpdir(), 'movie-db-'));
  try {
    const path = join(directory, 'nested', 'test.sqlite');
    const writer = run(`${databaseImport}
      const db = openDatabase();
      if (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().length) throw Error('Unexpected tables');
      db.exec('CREATE TABLE probe (value TEXT NOT NULL)');
      db.prepare('INSERT INTO probe VALUES (?)').run('сохранено');
      db.close();`, path);
    assert.equal(writer.status, 0, writer.stderr);
    const reader = run(`${databaseImport}
      const db = openDatabase();
      console.log(db.prepare('SELECT value FROM probe').get().value);
      db.close();`, path);
    assert.equal(reader.status, 0, reader.stderr);
    assert.equal(reader.stdout.trim(), 'сохранено');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('CLI fails cleanly when database directory cannot be created', () => {
  const directory = mkdtempSync(join(tmpdir(), 'movie-db-error-'));
  try {
    const blocker = join(directory, 'file');
    writeFileSync(blocker, 'not a directory');
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/db-check.ts'], {
      env: { ...process.env, DATABASE_PATH: join(blocker, 'test.sqlite') }, encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /SQLite connection failed/);
    assert.ok(!result.stderr.includes(directory));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('relative database paths resolve from the project root', () => {
  const result = run(`${databaseImport}
    const db = openDatabase(); console.log(db.name); db.close();`, './data/movies.sqlite');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), resolve('data/movies.sqlite'));
});
