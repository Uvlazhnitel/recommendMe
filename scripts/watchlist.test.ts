import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from './fixtures/recommendation-screen';
import { setWatchlist } from '../src/lib/watchlist';
import { readLibrary, readLibraryMovie } from '../src/lib/library';
import { addCatalogMovie } from '../src/lib/movie-catalog';

const noBackup = async () => {};
test('watchlist preserves every personal field, historical marks, outcomes and the other profile', async () => {
  const f = fixture();
  try {
    f.db.exec("UPDATE user_movies SET review_text='Сохранённые впечатления' WHERE user_id='ilya' AND movie_id=1");
    const before = f.db.prepare("SELECT * FROM user_movies WHERE user_id='ilya' AND movie_id=1").get() as Record<string, unknown>;
    const tables = ['personal_rating_history', 'legacy_movie_marks', 'recommendation_outcomes', 'taste_profile', 'recommendations'];
    const snapshot = tables.map(table => f.db.prepare(`SELECT * FROM ${table}`).all());
    for (const value of [true, true, false]) {
      await setWatchlist(f.db, 'ilya', 1, value, noBackup);
      const after = f.db.prepare("SELECT * FROM user_movies WHERE user_id='ilya' AND movie_id=1").get() as Record<string, unknown>;
      for (const key of Object.keys(before).filter(key => !['watchlist', 'updated_at'].includes(key))) assert.deepEqual(after[key], before[key], key);
      assert.equal(readLibraryMovie(f.db, 'ilya', 1).watchlist, value);
      assert.equal(readLibraryMovie(f.db, 'valeriy', 1).watchlist, false);
      assert.equal(readLibrary(f.db, 'ilya').total, 3);
    }
    assert.deepEqual(tables.map(table => f.db.prepare(`SELECT * FROM ${table}`).all()), snapshot);
    await setWatchlist(f.db, 'valeriy', 1, true, noBackup);
    assert.equal(readLibraryMovie(f.db, 'valeriy', 1).watched, false);
    assert.equal(readLibraryMovie(f.db, 'valeriy', 1).rating_100, null);
    assert.equal(readLibrary(f.db, 'valeriy', new URLSearchParams('watchlist=true')).total, 1);
    assert.equal(readLibrary(f.db, 'ilya', new URLSearchParams('watchlist=true')).total, 0);
  } finally { f.cleanup(); }
});
test('existing catalog IDs are reused, explicit add survives new saved batches and reopening SQLite', async () => {
  const f = fixture();
  try {
    const result = await addCatalogMovie(f.db, { details: async () => { throw Error('Existing film needs no TMDB'); } }, 101, { backup: noBackup });
    assert.equal(result.status, 'already_exists');
    assert.equal(result.movie_id, 1);
    await setWatchlist(f.db, 'ilya', 1, true, noBackup);
    await setWatchlist(f.db, 'ilya', 1, true, async () => { throw Error('No-op must not back up'); });
    // Simulate persistence of two distinct batches without generating recommendations.
    f.db.prepare("INSERT INTO recommendations(user_id,movie_id,result_id) VALUES('ilya',2,?)").run('watchlist-old');
    f.db.prepare("INSERT INTO recommendations(user_id,movie_id,result_id) VALUES('ilya',3,?)").run('watchlist-new');
    const reopened = f.open({ readonly: true });
    try {
      const list = readLibrary(reopened, 'ilya', new URLSearchParams('watchlist=true'));
      assert.deepEqual(list.items.map(row => row.movie_id), [1]);
      assert.equal((reopened.prepare('SELECT count(*) n FROM movies').get() as {n:number}).n, 3);
      assert.equal((reopened.prepare("SELECT count(*) n FROM user_movies WHERE user_id='ilya' AND movie_id=1").get() as {n:number}).n, 1);
    } finally { reopened.close(); }
  } finally { f.cleanup(); }
});
