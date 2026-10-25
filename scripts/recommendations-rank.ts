import { loadEnvConfig } from '@next/env';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { openDatabase } from '../src/lib/db';
import { rankRecommendations } from '../src/lib/recommendations';

async function main() {
  loadEnvConfig(process.cwd(), process.env.NODE_ENV !== 'production');
  const { values } = parseArgs({ options: { input: { type: 'string' }, 'dry-run': { type: 'boolean' }, live: { type: 'boolean' } }, strict: true });
  if (values['dry-run'] && values.live) throw new Error('--dry-run and --live are mutually exclusive.');
  if (!values.input?.trim()) throw new Error('--input is required: provide a saved candidates:generate JSON report.');
  let raw: string;
  try { raw = readFileSync(values.input, 'utf8'); } catch { throw new Error('Cannot read the candidate input file.'); }
  let report: unknown;
  try { report = JSON.parse(raw.replace(/^\uFEFF/, '')); } catch { throw new Error('Candidate input is invalid JSON. Save with npm run --silent candidates:generate to avoid npm headers.'); }
  const database = openDatabase({ readonly: true });
  try {
    const result = await rankRecommendations(database, report, { live: values.live, apiKey: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL });
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== 'ok') process.exitCode = 1;
  } finally { database.close(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Recommendation ranking failed.'); process.exitCode = 1; });
