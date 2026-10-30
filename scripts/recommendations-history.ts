import { userId } from '../src/lib/profiles';
import { loadEnvConfig } from '@next/env';
import { parseArgs } from 'node:util';
import { openDatabase } from '../src/lib/db';
import { recommendationHistory } from '../src/lib/recommendation-memory';
loadEnvConfig(process.cwd(), process.env.NODE_ENV !== 'production');
try {
  const { values } = parseArgs({ options: { user: { type: 'string' },}, strict: true });
  const profileId = userId(values.user);
  const db = openDatabase({ readonly: true });
  try { console.log(JSON.stringify(recommendationHistory(db, profileId), null, 2)); } finally { db.close(); }
} catch (error) { console.error(error instanceof Error ? error.message : 'Reading history failed.'); process.exitCode = 1; }
