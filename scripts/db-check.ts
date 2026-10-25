import { loadEnvConfig } from '@next/env';
import { checkDatabase } from '../src/lib/db';

loadEnvConfig(process.cwd(), process.env.NODE_ENV !== 'production');
try {
  checkDatabase();
  console.log('SQLite connection OK.');
} catch {
  console.error('SQLite connection failed. Check DATABASE_PATH and directory permissions.');
  process.exitCode = 1;
}
