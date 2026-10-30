import { userId, requireProfileSchema } from '../src/lib/profiles';
import { loadEnvConfig } from '@next/env';
import { parseArgs } from 'node:util';
import { openDatabase } from '../src/lib/db';
import { backupForRecommendationWrite, rejectRecommendation } from '../src/lib/recommendation-memory';

async function main() {
  loadEnvConfig(process.cwd(), process.env.NODE_ENV !== 'production');
  const { values } = parseArgs({ options: { user: { type: 'string' }, 'tmdb-id': { type: 'string' }, undo: { type: 'boolean' } }, strict: true });
  const profileId = userId(values.user);
  if (!values['tmdb-id'] || !/^\d+$/.test(values['tmdb-id'])) throw new Error('--tmdb-id must be a positive integer.');
  const id = Number(values['tmdb-id']);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('--tmdb-id must be a positive integer.');
  const db = openDatabase();
  try {
    requireProfileSchema(db);
    if (!db.prepare('SELECT id FROM movies WHERE tmdb_id=?').get(id)) throw new Error('Movie is not in the local library. Record its verified candidate first.');
    await backupForRecommendationWrite(db);
    console.log(JSON.stringify(rejectRecommendation(db, profileId, id, values.undo), null, 2));
  } finally { db.close(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Rejecting recommendation failed.'); process.exitCode = 1; });
