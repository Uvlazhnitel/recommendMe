import { fixture, movie } from './recommendation-screen';
import { buildTasteContext } from '../../src/lib/taste-context';
import type { MovieCandidate } from '../../src/lib/candidates';

export type ContextScenario = 'director' | 'counterexample' | 'redundant' | 'reviews' | 'sparse' | 'large';
export const contextScenarios: ContextScenario[] = ['director', 'counterexample', 'redundant', 'reviews', 'sparse', 'large'];
export function contextFixture(scenario: ContextScenario) {
  const f = fixture();
  f.db.exec(`UPDATE movies SET genres_json='[{"id":99,"name":"Base"}]',directors_json='[{"id":999,"name":"Base Director"}]'`);
  const add = (id: number, rating: number | null, genres: number[], directors: number[], overview: string | null = 'A confirmed plot. '.repeat(40)) => {
    f.db.prepare(`INSERT INTO movies(id,title,release_year,tmdb_id,media_type,runtime_minutes,overview,genres_json,directors_json)
      VALUES(?,?,2000,?,'movie',100,?,?,?)`).run(id, `History ${id}`, id + 10000, overview,
      JSON.stringify(genres.map(id => ({ id, name: `Genre ${id}` }))), JSON.stringify(directors.map(id => ({ id, name: `Director ${id}` }))));
    f.db.prepare('INSERT INTO user_movies(user_id,movie_id,watched,rating_100) VALUES(\'ilya\',?,1,?)').run(id, rating);
  };
  const candidate = (id: number, genres: number[], directors: number[]): MovieCandidate => ({ ...movie(id),
    genres: genres.map(id => ({ id, name: `Genre ${id}` })), directors: directors.map(id => ({ id, name: `Director ${id}` })), overview: 'A verified candidate story. '.repeat(40) });
  let candidates = [candidate(201, [1, 2], [10]), candidate(202, [3], [20]), candidate(203, [4], [30])];
  if (['director', 'reviews', 'sparse'].includes(scenario)) {
    for (let id = 10; id < 25; id++) add(id, 70, [1, 2], [10]);
    add(100, 70, [3], [20]); add(200, 70, [4], [30]);
  } else if (scenario === 'counterexample') {
    for (let id = 10; id < 40; id++) add(id, 90, [1, 2], [10]);
    add(100, 70, [1], [10]); candidates = [candidate(201, [1, 2], [10])];
  } else if (scenario === 'redundant') {
    for (let id = 10; id < 40; id++) add(id, 90, [1, 2, 3], [id * 3, id * 3 + 1, id * 3 + 2]);
    add(200, 90, [8], [800]); candidates = [candidate(201, [8], [800])];
  } else {
    for (let id = 10; id < 100; id++) add(id, id % 3 === 0 ? 90 : id % 3 === 1 ? 20 : 70, [id % 9 + 1, id % 9 + 11], [id % 13 + 1], 'я🎬'.repeat(800));
    candidates = Array.from({ length: 40 }, (_, index) => ({ ...candidate(201 + index, [index % 9 + 1, index % 9 + 11], [index % 13 + 1]), overview: 'я🎬'.repeat(800) }));
  }
  if (scenario === 'reviews') f.db.prepare('UPDATE user_movies SET review_text=?').run('В этом фильме темп работал иначе. '.repeat(40));
  if (scenario === 'sparse') f.db.exec('UPDATE movies SET overview=NULL');
  const taste = buildTasteContext(f.db, 'ilya');
  const profile = JSON.parse((f.db.prepare('SELECT profile_json FROM taste_profile').get() as { profile_json: string }).profile_json);
  if (scenario === 'redundant') profile.strong_preferences.push({ summary: 'Another supported side', explanation: 'A distinct confirmed example.', kind: 'observation',
    uncertainty: 'Not a general genre rule.', evidence: [{ movie_id: 200, rating_100: 90 }] });
  f.db.prepare('UPDATE taste_profile SET profile_json=?').run(JSON.stringify({ ...profile, ratings_count: taste.snapshot.length, ratings_snapshot: taste.snapshot,
    context_fingerprint: taste.fingerprint, contrast_pairs_count: taste.context.contrast_pairs.length }));
  return { ...f, candidates, add };
}
