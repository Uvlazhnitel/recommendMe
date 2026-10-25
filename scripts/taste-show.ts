import { loadEnvConfig } from '@next/env';
import { parseArgs } from 'node:util';
import { openDatabase } from '../src/lib/db';
import { displayTasteProfile } from '../src/lib/taste-profile';

try {
  parseArgs({ options: {}, strict: true });
  loadEnvConfig(process.cwd(), process.env.NODE_ENV !== 'production');
  const database = openDatabase({ readonly: true });
  try { console.log(displayTasteProfile(database)); }
  finally { database.close(); }
} catch (error) { console.error(error instanceof Error ? error.message : 'Cannot read taste profile.'); process.exitCode = 1; }
