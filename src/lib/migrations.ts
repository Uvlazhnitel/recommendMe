import { readFileSync } from 'node:fs';
import type Database from 'better-sqlite3';

const migrations = [
  new URL('../../migrations/001_initial.sql', import.meta.url),
  new URL('../../migrations/002_letterboxd_rating_date.sql', import.meta.url),
  new URL('../../migrations/003_tmdb_metadata.sql', import.meta.url),
];

// Run explicitly via db:init; opening a connection never changes the schema.
export function migrateDatabase(database: Database.Database): number {
  return database.transaction(() => {
    const current = database.pragma('user_version', { simple: true }) as number;
    if (current > migrations.length) {
      throw new Error(`Unsupported database schema version ${current}; supported through ${migrations.length}.`);
    }
    for (let index = current; index < migrations.length; index++) {
      database.exec(readFileSync(migrations[index], 'utf8'));
      database.pragma(`user_version = ${index + 1}`);
    }
    return migrations.length;
  }).immediate();
}
