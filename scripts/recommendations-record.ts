import { loadEnvConfig } from '@next/env';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { openDatabase } from '../src/lib/db';
import { parseCandidateReport } from '../src/lib/recommendation-schema';
import { backupForRecommendationWrite, recordRecommendations, type RecordRequest } from '../src/lib/recommendation-memory';

function readJSON(path: string) {
  let raw: string;
  try { raw = readFileSync(path, 'utf8'); } catch { throw new Error('Cannot read the supplied JSON file.'); }
  try { return JSON.parse(raw.replace(/^\uFEFF/, '')) as unknown; } catch { throw new Error('Invalid JSON file. Use npm run --silent when redirecting CLI output.'); }
}
async function main() {
  loadEnvConfig(process.cwd(), process.env.NODE_ENV !== 'production');
  const { values } = parseArgs({ options: { input: { type: 'string' }, 'tmdb-ids': { type: 'string' }, result: { type: 'string' },
    save: { type: 'boolean' }, 'dry-run': { type: 'boolean' } }, strict: true });
  if (values.save && values['dry-run']) throw new Error('--save and --dry-run are mutually exclusive.');
  if (!values.input?.trim()) throw new Error('--input is required.');
  if (Boolean(values['tmdb-ids']) === Boolean(values.result)) throw new Error('Provide exactly one of --tmdb-ids or --result.');
  const candidateReport = readJSON(values.input); parseCandidateReport(candidateReport);
  let request: RecordRequest;
  if (values.result) request = { result: readJSON(values.result) };
  else {
    if (!/^\d+(?:,\d+)*$/.test(values['tmdb-ids']!)) throw new Error('--tmdb-ids must be comma-separated positive integers.');
    request = { tmdbIds: values['tmdb-ids']!.split(',').map(Number) };
  }
  const db = openDatabase({ readonly: !values.save });
  try {
    // Validate the complete operation before creating a backup or applying migrations.
    const preview = recordRecommendations(db, candidateReport, request);
    if (!values.save || preview.status === 'already_saved') { console.log(JSON.stringify(preview, null, 2)); return; }
    await backupForRecommendationWrite(db);
    console.log(JSON.stringify(recordRecommendations(db, candidateReport, request, { dryRun: false }), null, 2));
  } finally { db.close(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Recording recommendations failed.'); process.exitCode = 1; });
