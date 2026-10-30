// Explicit offline maintenance, using Node 24's native TypeScript support.
// Never load .env.local or run this automatically when the server starts.
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { migrateDatabase, SCHEMA_VERSION } from '../src/lib/migrations.ts';

const tables = ['movies', 'user_movies', 'recommendations', 'taste_profile'];
const digest = file => createHash('sha256').update(readFileSync(file)).digest('hex');
function files(folder, prefix = '') {
  return readdirSync(folder).sort().flatMap(name => {
    const key = join(prefix, name), path = join(folder, name), stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw Error('Symlinks are not allowed in maintenance snapshots.');
    if (stat.isDirectory()) return files(path, key);
    if (!stat.isFile()) throw Error('Unexpected snapshot entry.');
    return [key];
  });
}
function inspect(path) {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    db.pragma('foreign_keys=ON');
    if (db.pragma('integrity_check', { simple: true }) !== 'ok' || db.pragma('foreign_key_check').length) throw Error('SQLite integrity verification failed.');
    const schema = db.pragma('user_version', { simple: true });
    if (schema < 1 || schema > SCHEMA_VERSION) throw Error('Unsupported SQLite schema.');
    return { schema, counts: Object.fromEntries([...tables, ...(schema >= 10 ? ['legacy_identity_decisions', 'personal_rating_history'] : []), ...(schema >= 9 ? ['legacy_import_sources', 'legacy_movie_marks'] : []), ...(schema >= 8 ? ['profiles'] : []), ...(schema >= 7 ? ['recommendation_evaluation', 'recommendation_outcomes'] : [])].map(table => [table, db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n])) };
  } finally { db.close(); }
}

export async function backupDatabase(databasePath, backupDirectory) {
  const canonical = realpathSync(databasePath);
  const summary = inspect(canonical);
  mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
  const folder = join(backupDirectory, `snapshot-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`);
  mkdirSync(folder, { mode: 0o700 });
  try {
    const db = new Database(canonical, { readonly: true, fileMustExist: true });
    try { await db.backup(join(folder, 'database.sqlite')); } finally { db.close(); }
    const state = join(folder, 'state');
    mkdirSync(state, { mode: 0o700 });
    for (const name of ['.recommendation-runs', `${basename(canonical)}.recommendations.lock`, `${basename(canonical)}.taste.lock`]) {
      const source = join(dirname(canonical), name);
      if (existsSync(source)) {
        // Validate recursively before copying: never follow arbitrary symlinks.
        if (lstatSync(source).isSymbolicLink()) throw Error('Symlink in application state.');
        if (lstatSync(source).isDirectory()) files(source);
        cpSync(source, join(state, name), { recursive: true, errorOnExist: true, force: false });
      }
    }
    const hashes = Object.fromEntries(files(folder).map(key => [key, digest(join(folder, key))]));
    writeFileSync(join(folder, 'manifest.json'), JSON.stringify({ version: 1, created_at: new Date().toISOString(), canonical_database: canonical, ...summary, hashes }, null, 2), { flag: 'wx', mode: 0o600 });
    verifyBackup(folder);
    return folder;
  } catch (error) { rmSync(folder, { recursive: true, force: true }); throw error; }
}

export function verifyBackup(folder) {
  const manifest = JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8'));
  if (manifest.version !== 1 || !manifest.hashes || !isAbsolute(manifest.canonical_database)) throw Error('Invalid backup manifest.');
  const actual = files(folder).filter(key => key !== 'manifest.json');
  if (JSON.stringify(actual.sort()) !== JSON.stringify(Object.keys(manifest.hashes).sort())) throw Error('Backup file list does not match manifest.');
  for (const key of actual) {
    if (digest(join(folder, key)) !== manifest.hashes[key]) throw Error('Backup checksum mismatch.');
  }
  const summary = inspect(join(folder, 'database.sqlite'));
  if (JSON.stringify(summary) !== JSON.stringify({ schema: manifest.schema, counts: manifest.counts })) throw Error('Backup database does not match manifest.');
  return manifest;
}

/**
 * @param {string} folder
 * @param {string} databasePath
 * @param {{ relocateFrom?: string }} options
 */
export function restoreBackup(folder, databasePath, { relocateFrom } = {}) {
  const manifest = verifyBackup(folder);
  if (relocateFrom !== undefined && (!isAbsolute(relocateFrom) || relocateFrom !== manifest.canonical_database)) {
    throw Error('Relocation source must exactly match the canonical path in the verified manifest.');
  }
  const target = dirname(databasePath);
  mkdirSync(target, { recursive: true, mode: 0o700 });
  const canonical = resolve(realpathSync(target), basename(databasePath));
  if (canonical !== manifest.canonical_database && relocateFrom === undefined) throw Error('Restore requires the same canonical database path.');
  if (basename(canonical) !== basename(manifest.canonical_database)) throw Error('Relocation must preserve the database filename and associated lock filenames.');
  if (readdirSync(target).length) throw Error('Restore target must be completely empty; nothing was overwritten.');
  const key = path => createHash('sha256').update(path).digest('hex').slice(0, 24);
  const sourceKey = key(manifest.canonical_database), targetKey = key(canonical);
  const sourceJournal = join(folder, 'state', '.recommendation-runs', sourceKey);
  if (sourceKey !== targetKey && existsSync(join(folder, 'state', '.recommendation-runs', targetKey))) {
    throw Error('Relocated journal key already exists in the snapshot; nothing was restored.');
  }
  try {
    cpSync(join(folder, 'database.sqlite'), databasePath, { errorOnExist: true, force: false });
    for (const name of readdirSync(join(folder, 'state'))) cpSync(join(folder, 'state', name), join(target, name), { recursive: true, errorOnExist: true, force: false });
    if (sourceKey !== targetKey && existsSync(sourceJournal)) {
      renameSync(join(target, '.recommendation-runs', sourceKey), join(target, '.recommendation-runs', targetKey));
    }
    inspect(databasePath);
  } catch (error) {
    // Only entries created in the verified empty target belong to this command.
    for (const name of readdirSync(target)) rmSync(join(target, name), { recursive: true, force: true });
    throw error;
  }
}

async function main() {
  process.umask(0o077);
  const [command, ...args] = process.argv.slice(2);
  const databasePath = process.env.DATABASE_PATH;
  if (!databasePath || !isAbsolute(databasePath)) throw Error('Set an explicit absolute DATABASE_PATH.');
  if (!['init', 'check', 'backup', 'verify', 'restore'].includes(command)) throw Error('Usage: container-db.mjs init|check|backup|verify|restore [snapshot] [--offline] [--relocate-from canonical-source-path]');
  let offline = false, relocateFrom;
  const operands = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--offline' && !offline) offline = true;
    else if (arg === '--relocate-from' && command === 'restore' && relocateFrom === undefined && args[index + 1] && !args[index + 1].startsWith('--')) relocateFrom = args[++index];
    else if (arg.startsWith('--')) throw Error('Unexpected maintenance option.');
    else operands.push(arg);
  }
  if (['init', 'backup', 'restore'].includes(command) && !offline) throw Error('Stop this app before maintenance, then explicitly supply --offline.');
  if (operands.length !== (['verify', 'restore'].includes(command) ? 1 : 0)) throw Error('Unexpected maintenance arguments.');
  if (command === 'check') return console.log(JSON.stringify(inspect(databasePath)));
  if (command === 'verify') return console.log(JSON.stringify({ status: 'verified', ...verifyBackup(resolve(operands[0])) }));
  if (command === 'restore') { restoreBackup(resolve(operands[0]), databasePath, { relocateFrom }); return console.log('Restore verified; no migrations or AI calls performed.'); }
  if (command === 'backup' || existsSync(databasePath)) {
    const backupDirectory = process.env.BACKUP_DIR;
    if (!backupDirectory || !isAbsolute(backupDirectory) || !relative(dirname(databasePath), backupDirectory).startsWith('..')) throw Error('Set an absolute BACKUP_DIR outside the data directory.');
    const folder = await backupDatabase(databasePath, backupDirectory);
    console.log(`Backup verified: ${folder}`);
    if (command === 'backup') return;
  }
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
  const db = new Database(databasePath);
  try { db.pragma('foreign_keys=ON'); console.log(`SQLite schema ${migrateDatabase(db)} initialized explicitly.`); } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
