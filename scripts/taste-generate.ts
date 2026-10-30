import { userId } from '../src/lib/profiles';
import { loadEnvConfig } from '@next/env';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { openDatabase } from '../src/lib/db';
import { generateTasteProfile } from '../src/lib/taste-profile';

async function main() {
  loadEnvConfig(process.cwd(), process.env.NODE_ENV !== 'production');
  const { values } = parseArgs({ options: { user: { type: 'string' }, 'dry-run': { type: 'boolean' }, live: { type: 'boolean' }, force: { type: 'boolean' } }, strict: true });
  const profileId = userId(values.user);
  if (values['dry-run'] && values.live) throw new Error('--dry-run and --live are mutually exclusive.');
  if (values.force && !values.live) throw new Error('--force requires --live.');
  const database = openDatabase({ readonly: !values.live });
  try {
    let backupPath: string | undefined;
    if (values.live) {
      mkdirSync(resolve('data/backups'), { recursive: true });
      backupPath = resolve('data/backups', `before-taste-${randomUUID()}.sqlite`);
    }
    const result = await generateTasteProfile(database, profileId, { live: values.live, force: values.force, backupPath,
      apiKey: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL });
    console.log(JSON.stringify(result, null, 2));
  } finally { database.close(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Taste profile generation failed.'); process.exitCode = 1; });
