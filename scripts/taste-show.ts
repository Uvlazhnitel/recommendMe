import { userId } from '../src/lib/profiles';
import { loadEnvConfig } from '@next/env';
import { parseArgs } from 'node:util';
import { openDatabase } from '../src/lib/db';
import { displayTasteProfile } from '../src/lib/taste-profile';

try {
  const { values } = parseArgs({ options: { user: { type: 'string' },}, strict: true });
  const profileId = userId(values.user);
  loadEnvConfig(process.cwd(), process.env.NODE_ENV !== 'production');
  const database = openDatabase({ readonly: true });
  try { console.log(displayTasteProfile(database, profileId)); }
  finally { database.close(); }
} catch (error) { console.error(error instanceof Error ? error.message : 'Cannot read taste profile.'); process.exitCode = 1; }
