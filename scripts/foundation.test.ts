import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { prepareLetterboxd, importLetterboxd } from '../src/lib/letterboxd';
import { migrateDatabase } from '../src/lib/migrations';
import { createTmdbClient } from '../src/lib/tmdb';
import { enrichTmdb } from '../src/lib/tmdb-enrichment';

test('CSV → SQLite → mocked TMDB → reinitialization/reimport preserves metadata and personal history', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'foundation-'));
  const db = new Database(join(directory, 'movies.sqlite'));
  db.pragma('foreign_keys=ON');
  let sequence = 0;
  const backup = () => join(directory, `backup-${sequence++}.sqlite`);
  try {
    migrateDatabase(db);
    const plan = prepareLetterboxd('Date,Name,Year,Letterboxd URI\n2020-01-01,Zero,2000,uri:zero\n2020-01-02,High,2000,uri:high\n2020-01-03,Unrated,2000,uri:unrated\n',
      'Date,Name,Year,Letterboxd URI,Rating\n2020-02-01,Zero,2000,uri:zero,0\n2020-02-02,High,2000,uri:high,5\n');
    assert.equal((await importLetterboxd(db, plan, backup())).addedMovies, 3);
    const history = db.prepare('SELECT * FROM user_movies ORDER BY movie_id').all();
    const identities = db.prepare('SELECT id,title,release_year,letterboxd_uri FROM movies ORDER BY id').all();
    let requests = 0;
    const titles = ['Zero', 'High', 'Unrated'];
    const fetchMock: typeof fetch = async input => {
      requests++;
      const url = new URL(String(input));
      const isSearch = url.pathname.includes('/search/');
      const index = isSearch ? titles.indexOf(url.searchParams.get('query')!) : Number(url.pathname.split('/').at(-1)) - 100;
      assert.ok(index >= 0 && index < titles.length);
      const movie = { id: 100 + index, title: titles[index], original_title: titles[index], release_date: '2000-01-01' };
      return Response.json(isSearch ? { total_pages: 1, results: [movie] } : { ...movie, runtime: 100, overview: 'Verified metadata',
        genres: [{ id: 1, name: 'Drama' }], credits: { cast: [], crew: [{ id: 2, name: 'Director', job: 'Director' }] } });
    };
    const client = createTmdbClient('synthetic-test-key', { fetch: fetchMock, sleep: async () => {} });
    assert.equal((await enrichTmdb(db, client, { backupPath: backup() })).matched, 3);
    assert.equal(requests, 6);
    assert.deepEqual(db.prepare('SELECT * FROM user_movies ORDER BY movie_id').all(), history);
    assert.deepEqual(db.prepare('SELECT id,title,release_year,letterboxd_uri FROM movies ORDER BY id').all(), identities);
    const before = db.serialize();
    migrateDatabase(db);
    assert.equal((await importLetterboxd(db, plan, backup())).addedHistory, 0);
    assert.equal((await enrichTmdb(db, client, { backupPath: backup() })).processed, 0);
    assert.equal(requests, 6); assert.deepEqual(db.serialize(), before);
    assert.deepEqual(db.prepare('SELECT rating_100 FROM user_movies ORDER BY movie_id').all(),
      [{ rating_100: 0 }, { rating_100: 100 }, { rating_100: null }]);
    const metadata = db.prepare('SELECT * FROM movies ORDER BY id').all();
    db.exec("UPDATE user_movies SET rating_100=17,rating_source='manual' WHERE movie_id=1; UPDATE user_movies SET rating_100=NULL,rating_source='none' WHERE movie_id=2");
    const editedHistory = db.prepare('SELECT * FROM user_movies ORDER BY movie_id').all();
    await importLetterboxd(db, plan, backup());
    assert.deepEqual(db.prepare('SELECT * FROM user_movies ORDER BY movie_id').all(), editedHistory);
    assert.deepEqual(db.prepare('SELECT * FROM movies ORDER BY id').all(), metadata);
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});
