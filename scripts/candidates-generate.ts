import { loadEnvConfig } from '@next/env';
import { parseArgs } from 'node:util';
import { openDatabase } from '../src/lib/db';
import { generateCandidates } from '../src/lib/candidates';

async function main() {
  loadEnvConfig(process.cwd(), process.env.NODE_ENV !== 'production');
  const { values } = parseArgs({ options: { 'dry-run': { type: 'boolean' }, live: { type: 'boolean' } }, strict: true });
  if (values['dry-run'] && values.live) throw new Error('--dry-run and --live are mutually exclusive.');
  const database = openDatabase({ readonly: true });
  try {
    const result = await generateCandidates(database, { live: values.live, apiKey: process.env.OPENAI_API_KEY,
      model: process.env.OPENAI_MODEL, tmdbKey: process.env.TMDB_API_KEY });
    console.log(JSON.stringify(result, null, 2));
    if (result.mode === 'live' && result.status !== 'ok') process.exitCode = 1;
  } finally { database.close(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Candidate generation failed.'); process.exitCode = 1; });
