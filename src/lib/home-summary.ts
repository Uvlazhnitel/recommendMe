import { russianMovie } from './russian-presentation';
import { personalScope, type UserId } from './profiles';
// Small readonly summary; never ship the library or reviews to the home screen.
import type Database from 'better-sqlite3';
export type FavoriteMovie = { movie_id: number; title: string; year: number | null; poster_path: string | null; rating_100: number };
type Row = FavoriteMovie & { tmdb_id: number | null; genres_json: string | null; directors_json: string | null };
function ids(raw: string | null): number[] {
  try { const value = JSON.parse(raw ?? '[]'); return Array.isArray(value) ? [...new Set<number>(value.flatMap(v => v && Number.isSafeInteger(v.id) && v.id > 0 ? [v.id] : []))] : []; }
  catch { return []; }
}
export function readHomeSummary(db: Database.Database, userId: UserId) {
  personalScope(db, userId);
  const stats = db.prepare(`SELECT count(*) watched,count(rating_100) rated FROM user_movies WHERE user_id=@userId AND watched=1`).get({userId}) as { watched: number; rated: number };
  const pool = (db.prepare(`SELECT m.id movie_id,m.tmdb_id,coalesce(m.tmdb_title,m.title) title,coalesce(m.release_year,m.tmdb_release_year) year,
    m.poster_path,u.rating_100,m.genres_json,m.directors_json FROM movies m JOIN user_movies u ON u.movie_id=m.id AND u.user_id=@userId
    WHERE u.watched=1 AND u.rating_100>=80 ORDER BY u.rating_100 DESC,m.id ASC LIMIT 60`).all({userId}) as Row[])
    .map(row => ({ row, genres: ids(row.genres_json), directors: ids(row.directors_json) }));
  const selected: typeof pool = [];
  const repeats = (v: typeof pool[number]) => selected.reduce((n, s) => n + v.directors.filter(id => s.directors.includes(id)).length, 0);
  const overlap = (v: typeof pool[number]) => Math.max(0, ...selected.map(s => {
    const union = new Set([...v.genres, ...s.genres]).size;
    return union ? v.genres.filter(id => s.genres.includes(id)).length / union : 0;
  }));
  while (pool.length && selected.length < 6) {
    pool.sort((a, b) => b.row.rating_100 - a.row.rating_100 || repeats(a) - repeats(b) || overlap(a) - overlap(b) || a.row.movie_id - b.row.movie_id);
    selected.push(pool.shift()!);
  }
  return { stats, favorites: selected.map(({ row: { movie_id, tmdb_id, title, year, poster_path, rating_100 } }) => ({ movie_id, title: russianMovie(db, tmdb_id)?.title ?? title, year, poster_path, rating_100 })) };
}
