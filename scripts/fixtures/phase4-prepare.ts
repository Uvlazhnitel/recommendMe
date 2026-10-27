import { writeFileSync } from 'node:fs';
import { libraryFixture } from './library';

const destination = process.argv[2];
if (!destination) throw new Error('Pass a temporary metadata file for this synthetic fixture.');
const f = libraryFixture();
f.db.exec(`UPDATE movies SET letterboxd_uri='https://letterboxd.test/qa-favourite/' WHERE id=1;
  UPDATE movies SET title='Legacy Duplicate',release_year=2000,tmdb_id=NULL WHERE id=830;
  UPDATE user_movies SET rating_source='letterboxd',original_rating_stars=5,letterboxd_date='2020-01-01',letterboxd_rating_date='2020-02-01' WHERE movie_id=1`);
writeFileSync(destination, JSON.stringify({ dir: f.dir, path: f.path,
  profile: f.db.prepare('SELECT * FROM taste_profile').get(),
  importedMovie: f.db.prepare('SELECT * FROM movies WHERE id=1').get(),
  imported: f.db.prepare('SELECT * FROM user_movies WHERE movie_id=1').get(),
}), { mode: 0o600 });
f.db.close();
