import { userId } from '../src/lib/profiles';
import { loadEnvConfig } from '@next/env';
import { parseArgs } from 'node:util';
import { openDatabase } from '../src/lib/db';
import { prepareTasteInputs } from '../src/lib/candidate-context';
loadEnvConfig(process.cwd(), process.env.NODE_ENV !== 'production');
try {
  const { values } = parseArgs({ options: { user: { type: 'string' },}, strict: true });
  const profileId = userId(values.user);
  const db = openDatabase({ readonly: true });
  try { const personal = prepareTasteInputs(db, profileId); console.log(JSON.stringify({ profile_version: personal.saved.profile_version,
    ratings_count: personal.rated.length, ...personal.profileRefresh }, null, 2)); } finally { db.close(); }
} catch (error) { console.error(error instanceof Error ? error.message : 'Reading taste status failed.'); process.exitCode = 1; }
