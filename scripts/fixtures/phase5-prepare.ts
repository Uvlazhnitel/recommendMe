// Development-only synthetic snapshot. Never included in the Docker context.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join } from 'node:path';
import { fixture, report, choice } from './recommendation-screen';
import { recordRecommendations } from '../../src/lib/recommendation-memory';

async function main() {
const destination = process.argv[2];
if (!destination || !isAbsolute(destination) || existsSync(destination)) throw Error('Pass a new absolute path for the synthetic SQLite snapshot.');
mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
const f = fixture();
try {
  const resultId = '5a100000-0000-4000-8000-000000000001';
  const requestId = '5a100000-0000-4000-8000-000000000002';
  recordRecommendations(f.db, 'ilya', report(), { result: { mode: 'live', status: 'ok', result_id: resultId,
    generated_at: new Date().toISOString(), recommendations: [choice(201), choice(202)] } }, { dryRun: false });
  f.db.exec(`UPDATE movies SET poster_path=NULL, backdrop_path=NULL;
    INSERT INTO movies(id,title,release_year,media_type) VALUES(20,'Synthetic New Watch',2020,'movie');
    UPDATE user_movies SET rating_source='letterboxd', original_rating_stars=5,
      letterboxd_date='2020-01-01',letterboxd_rating_date='2020-02-01' WHERE movie_id=1`);
  await f.db.backup(destination);
  const key = createHash('sha256').update('/app/data/movies.sqlite').digest('hex').slice(0, 24);
  const folder = join(dirname(destination), '.recommendation-runs', key);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  writeFileSync(join(folder, requestId + '.json'), JSON.stringify({ request_id: requestId, result_id: resultId,
    stage: 'saved', started_at: new Date().toISOString(), calls: { openai: 0, tmdb: 0 } }), { mode: 0o600 });
  writeFileSync(join(folder, 'latest.json'), JSON.stringify({ request_id: requestId }), { mode: 0o600 });
  console.log('Synthetic SQLite and saved journal prepared; no network requests.');
} finally { f.cleanup(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
