import { userId } from '../src/lib/profiles';
import { loadEnvConfig } from '@next/env';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { openDatabase } from '../src/lib/db';
import { importLetterboxd, prepareLetterboxd } from '../src/lib/letterboxd';

async function main() {
  loadEnvConfig(process.cwd(), process.env.NODE_ENV !== 'production');
  const { values } = parseArgs({ options: { user: { type: 'string' }, ratings: { type: 'string' }, watched: { type: 'string' } }, strict: true });
  const profileId = userId(values.user);
  const reportDirectory = resolve('data/import-reports', profileId);
  const backupDirectory = resolve('data/backups');
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
  mkdirSync(reportDirectory, { recursive: true });
  const reportPath = resolve(reportDirectory, `${runId}.json`);
  try {
    const decode = (path: string) => new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path));
    const watched = resolve(values.watched ?? 'data/import/watched(6).csv');
    const ratings = resolve(values.ratings ?? 'data/import/ratings(6).csv');
    const plan = prepareLetterboxd(decode(watched), decode(ratings));
    mkdirSync(backupDirectory, { recursive: true });
    const database = openDatabase();
    try {
      const result = await importLetterboxd(database, profileId, plan, resolve(backupDirectory, `before-letterboxd-${runId}.sqlite`));
      const report = { ...result, sources: { watched, ratings } };
      writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
      console.log(JSON.stringify(report, null, 2));
      console.log(`Report: ${reportPath}`);
      if (result.status !== 'complete') process.exitCode = 1;
    } finally { database.close(); }
  } catch (error) {
    const report = { status: 'failed', error: error instanceof Error ? error.message : 'Unknown error' };
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
    console.error(JSON.stringify(report));
    console.error(`Report: ${reportPath}`);
    process.exitCode = 1;
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
