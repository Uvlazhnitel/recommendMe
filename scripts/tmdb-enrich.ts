import { loadEnvConfig } from '@next/env';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { openDatabase } from '../src/lib/db';
import { createTmdbClient } from '../src/lib/tmdb';
import { enrichTmdb } from '../src/lib/tmdb-enrichment';

async function main() {
  loadEnvConfig(process.cwd(), process.env.NODE_ENV !== 'production');
  const { values } = parseArgs({ options: { 'dry-run': { type: 'boolean' }, limit: { type: 'string' }, 'retry-unresolved': { type: 'boolean' } }, strict: true });
  const limit = values.limit === undefined ? undefined : Number(values.limit);
  if (values.limit !== undefined && (!/^\d+$/.test(values.limit) || !Number.isSafeInteger(limit) || limit! <= 0)) throw new Error('--limit must be a positive integer.');
  // Validate credentials before opening the DB, applying migrations, or creating reports.
  const client = createTmdbClient(process.env.TMDB_API_KEY);
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
  const reportDirectory = resolve('data/tmdb-reports');
  mkdirSync(reportDirectory, { recursive: true });
  const reportPath = resolve(reportDirectory, `${runId}.json`);
  const saveReport = (report: unknown) => {
    writeFileSync(`${reportPath}.tmp`, JSON.stringify(report, null, 2) + '\n');
    renameSync(`${reportPath}.tmp`, reportPath);
  };
  const dryRun = Boolean(values['dry-run']);
  let backupPath: string | undefined;
  if (!dryRun) {
    mkdirSync(resolve('data/backups'), { recursive: true });
    backupPath = resolve('data/backups', `before-tmdb-${runId}.sqlite`);
  }
  const database = openDatabase({ readonly: dryRun });
  try {
    const report = await enrichTmdb(database, client, { dryRun, limit, retryUnresolved: values['retry-unresolved'], backupPath, onProgress: saveReport });
    console.log(JSON.stringify({ ...report, items: undefined, reportPath }, null, 2));
    if (report.errors || report.stopped) process.exitCode = 1;
  } finally { database.close(); }
}
main().catch(error => {
  // All client errors are sanitized; never log raw fetch errors or request URLs.
  console.error(error instanceof Error ? error.message : 'TMDB enrichment failed.');
  process.exitCode = 1;
});
