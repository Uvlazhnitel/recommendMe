import { fixture } from './recommendation-screen';
import { buildTasteContext } from '../../src/lib/taste-context';

// Generated records, never the owner's export. Three original fixture ratings keep a valid taste snapshot.
export function libraryFixture() {
  const f = fixture();
  const insert = f.db.prepare(`INSERT INTO movies(id,title,release_year,tmdb_id,original_title,overview,genres_json,runtime_minutes)
    VALUES(?,?,?,?,?,'A synthetic story used only for interface verification.','[{"id":1,"name":"Drama"}]',100)`);
  const personal = f.db.prepare(`INSERT INTO user_movies(movie_id,watched,rating_100,rating_source,original_rating_stars,letterboxd_date,letterboxd_rating_date,created_at)
    VALUES(?,1,?,'letterboxd',?,'2020-01-01','2020-02-01',?)`);
  f.db.transaction(() => {
    for (let id = 4; id <= 830; id++) {
      const rating = id % 3 === 0 ? null : id % 101;
      insert.run(id, id === 10 ? 'Кино ＡＢＣ 100%_тест' : id === 11 ? 'Очень длинное название фильма, которое сохраняет сетку и читабельность на телефоне' : `Кинокадр ${String(id).padStart(4,'0')}`,
        id % 10 === 0 ? null : 1980 + id % 45, id % 7 === 0 ? null : 100000 + id, id === 10 ? 'Original Test' : `Original ${id}`);
      personal.run(id, rating, 3, `2020-01-${String(1 + id % 28).padStart(2,'0')}T00:00:00.000Z`);
    }
  })();
  const context = buildTasteContext(f.db);
  const profile = JSON.parse((f.db.prepare('SELECT profile_json FROM taste_profile').get() as { profile_json: string }).profile_json);
  Object.assign(profile, { ratings_snapshot: context.snapshot, ratings_count: context.snapshot.length, context_fingerprint: context.fingerprint });
  f.db.prepare('UPDATE taste_profile SET profile_json=?').run(JSON.stringify(profile));
  return f;
}
