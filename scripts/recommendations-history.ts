import { loadEnvConfig } from '@next/env';
import { parseArgs } from 'node:util';
import { openDatabase } from '../src/lib/db';
import { recommendationHistory } from '../src/lib/recommendation-memory';
loadEnvConfig(process.cwd(), process.env.NODE_ENV !== 'production');
try {
  parseArgs({ options: {}, strict: true });
  const db = openDatabase({ readonly: true });
  try { console.log(JSON.stringify(recommendationHistory(db), null, 2)); } finally { db.close(); }
} catch (error) { console.error(error instanceof Error ? error.message : 'Reading history failed.'); process.exitCode = 1; }
