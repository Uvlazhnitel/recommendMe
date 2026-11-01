// Display-only titles. Never use these overlays in recommendation or identity inputs.
import type Database from 'better-sqlite3';
import type { UserId } from './profiles';
import { russianMovie } from './russian-presentation';

export type DisplayTitle = { title: string; subtitle?: string | null };
const clean = (value?: string | null) => value?.trim() || null;
const russian = (value?: string | null) => clean(value) && /[А-Яа-яЁё]/u.test(value!) ? clean(value) : null;
const same = (a: string, b: string) => a.normalize('NFKC').replace(/\s+/gu, ' ').toLowerCase() === b.normalize('NFKC').replace(/\s+/gu, ' ').toLowerCase();
export function movieTitle(userId: UserId, input: { title: string; english?: string | null; original?: string | null; russian?: string | null }): DisplayTitle {
  if (userId !== 'ilya') return { title: input.title };
  const title = clean(input.english) ?? clean(input.original) ?? input.title;
  const translated = russian(input.russian);
  return { title, subtitle: translated && !same(title, translated) ? translated : null };
}
export type TitleRow = { title: string; tmdb_id: number | null; tmdb_title?: string | null; original_title?: string | null };
export function catalogTitle(db: Database.Database, userId: UserId, row: TitleRow, fallback: string = row.title): DisplayTitle {
  const localized = russianMovie(db, row.tmdb_id)?.title;
  return movieTitle(userId, { title: userId === 'ilya' ? row.title : localized ?? fallback,
    english: russian(row.tmdb_title) ? null : row.tmdb_title, original: row.original_title,
    russian: russian(localized) ?? russian(row.tmdb_title) ?? russian(row.title) });
}
export function titleForMatch<T extends { movie_id: number; title: string }>(db: Database.Database, userId: UserId, match: T): T & DisplayTitle {
  if (userId !== 'ilya') return match;
  const row = db.prepare('SELECT title,tmdb_id,tmdb_title,original_title FROM movies WHERE id=?').get(match.movie_id) as TitleRow | undefined;
  return { ...match, ...(row ? catalogTitle(db, userId, row) : movieTitle(userId, { title: match.title, russian: match.title })) };
}
