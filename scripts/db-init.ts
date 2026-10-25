import { loadEnvConfig } from '@next/env';
import { openDatabase } from '../src/lib/db';
import { migrateDatabase } from '../src/lib/migrations';

loadEnvConfig(process.cwd(), process.env.NODE_ENV !== 'production');
try {
  const database = openDatabase();
  try {
    const version = migrateDatabase(database);
    console.log(`SQLite schema ready (version ${version}).`);
  } finally {
    database.close();
  }
} catch (error) {
  console.error('SQLite initialization failed:', error instanceof Error ? error.message : 'Unknown error');
  process.exitCode = 1;
}
