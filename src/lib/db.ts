// Node-only module: never import into a Client Component.
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';

export function openDatabase(options: { readonly?: boolean } = {}) {
  const configuredPath = process.env.DATABASE_PATH ?? './data/movies.sqlite';
  if (!configuredPath.trim() || configuredPath === ':memory:') {
    throw new Error('DATABASE_PATH must point to a persistent SQLite file.');
  }
  const databasePath = resolve(process.cwd(), configuredPath);
  if (!options.readonly) mkdirSync(dirname(databasePath), { recursive: true });
  const database = new Database(databasePath, { readonly: options.readonly ?? false });
  try {
    database.pragma('foreign_keys = ON');
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export function checkDatabase(options: { readonly?: boolean } = {}) {
  const database = openDatabase(options);
  try {
    database.prepare('SELECT 1').get();
  } finally {
    database.close();
  }
}
