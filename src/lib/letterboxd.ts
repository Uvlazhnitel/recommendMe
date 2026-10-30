import { requireProfileSchema } from './profiles';
import { personalScope, type UserId } from './profiles';
import type Database from 'better-sqlite3';

type Source = 'watched' | 'ratings';
type Issue = { source: Source; record: number; reason: string };
type Row = { source: Source; record: number; title: string; year: number | null; uri: string | null; date: string | null; stars: number | null };
type Group = { rows: Row[]; title: string; year: number | null; uri: string | null };
type Movie = { id: number; title: string; release_year: number | null; letterboxd_uri: string | null };
type Counts = { watched: number; rated: number; unrated: number };
export type ImportPlan = { groups: Group[]; rowsRead: Record<Source, number>; duplicates: number; issues: Issue[] };

// Strict CSV state machine: malformed quoting is fatal, before any database work.
export function parseCsv(text: string): string[][] {
  text = text.replace(/^\uFEFF/, '');
  const records: string[][] = [];
  let row: string[] = [], field = '', state: 'start' | 'plain' | 'quoted' | 'closed' = 'start';
  const endField = () => { row.push(field); field = ''; state = 'start'; };
  const endRecord = () => { endField(); if (row.some(value => value.trim())) records.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (state === 'quoted') {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else state = 'closed';
      } else field += char;
      continue;
    }
    if (char === ',') { endField(); continue; }
    if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      endRecord(); continue;
    }
    if (state === 'closed') throw new Error('Invalid CSV: characters after closing quote.');
    if (char === '"') {
      if (state !== 'start') throw new Error('Invalid CSV: unexpected quote.');
      state = 'quoted';
    } else { field += char; state = 'plain'; }
  }
  if (state === 'quoted') throw new Error('Invalid CSV: unclosed quote.');
  if (row.length || field || state === 'closed') endRecord();
  return records;
}

function normalize(title: string) { return title.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase(); }
function key(title: string, year: number | null) { return year === null ? null : JSON.stringify([normalize(title), year]); }
function date(value: string): string | null {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Invalid date.');
  const parsed = new Date(value + 'T00:00:00.000Z');
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new Error('Invalid calendar date.');
  return value;
}
function readRows(text: string, source: Source, issues: Issue[]): { rows: Row[]; count: number } {
  const records = parseCsv(text);
  const headers = records.shift()?.map(value => value.trim()) ?? [];
  const required = ['Date', 'Name', 'Year', 'Letterboxd URI', ...(source === 'ratings' ? ['Rating'] : [])];
  if (new Set(headers).size !== headers.length || required.some(name => !headers.includes(name))) {
    throw new Error(`${source}: missing or duplicate CSV headers.`);
  }
  const rows: Row[] = [];
  records.forEach((fields, index) => {
    const record = index + 2;
    try {
      if (fields.length !== headers.length) throw new Error('Incorrect number of columns.');
      const values = Object.fromEntries(headers.map((name, i) => [name, fields[i].trim()]));
      if (!values.Name) throw new Error('Empty title.');
      if (values.Year && !/^\d{1,4}$/.test(values.Year)) throw new Error('Invalid year.');
      const rating = source === 'ratings' ? values.Rating : '';
      if (rating && (!/^(?:[0-5](?:\.0)?|[0-4]\.5)$/.test(rating))) throw new Error('Rating must be 0–5 in half-star increments.');
      rows.push({ source, record, title: values.Name, year: values.Year ? Number(values.Year) : null,
        uri: values['Letterboxd URI'] || null, date: date(values.Date), stars: rating ? Number(rating) : null });
    } catch (error) {
      issues.push({ source, record, reason: (error as Error).message });
    }
  });
  return { rows, count: records.length };
}

export function prepareLetterboxd(watchedCsv: string, ratingsCsv: string): ImportPlan {
  const issues: Issue[] = [];
  const watched = readRows(watchedCsv, 'watched', issues);
  const ratings = readRows(ratingsCsv, 'ratings', issues);
  const groups: Group[] = [];
  const byUri = new Map<string, Group>();
  const missing: Row[] = [];
  for (const row of [...watched.rows, ...ratings.rows]) {
    if (!row.uri) { missing.push(row); continue; }
    let group = byUri.get(row.uri);
    if (!group) {
      group = { rows: [], title: row.title, year: row.year, uri: row.uri };
      byUri.set(row.uri, group); groups.push(group);
    }
    group.rows.push(row);
    if (group.year === null) group.year = row.year;
  }
  const missingByKey = new Map<string, Row[]>();
  for (const row of missing) {
    const identity = key(row.title, row.year);
    if (!identity) { issues.push({ ...row, reason: 'Missing URI and year; cannot identify safely.' }); continue; }
    const bucket = missingByKey.get(identity) ?? [];
    bucket.push(row); missingByKey.set(identity, bucket);
  }
  for (const [identity, rows] of missingByKey) {
    const candidates = groups.filter(group => key(group.title, group.year) === identity);
    if (candidates.length > 1) {
      issues.push(...rows.map(row => ({ source: row.source, record: row.record, reason: 'Ambiguous title/year without URI.' })));
    } else if (candidates.length === 1) candidates[0].rows.push(...rows);
    else groups.push({ rows, title: rows[0].title, year: rows[0].year, uri: null });
  }
  let duplicates = 0;
  const valid = groups.filter(group => {
    const unique: Row[] = [];
    let conflict = false;
    for (const row of group.rows) {
      if (normalize(row.title) !== normalize(group.title) || (row.year !== null && group.year !== null && row.year !== group.year)) conflict = true;
      const prior = unique.find(other => other.source === row.source);
      if (!prior) unique.push(row);
      else if (normalize(prior.title) === normalize(row.title) && prior.year === row.year && prior.date === row.date && prior.stars === row.stars) duplicates++;
      else conflict = true;
    }
    if (conflict) {
      issues.push(...group.rows.map(row => ({ source: row.source, record: row.record, reason: 'Conflicting records for the same identity.' })));
      return false;
    }
    group.rows = unique;
    return true;
  });
  return { groups: valid, rowsRead: { watched: watched.count, ratings: ratings.count }, duplicates, issues };
}

function counts(database: Database.Database, userId: UserId, ids?: number[]): Counts {
  personalScope(database, userId);
  const rows = ids ? ids.map(id => database.prepare('SELECT watched, rating_100 FROM user_movies WHERE user_id=@userId AND movie_id = ?').get({userId}, id)) :
    database.prepare('SELECT watched, rating_100 FROM user_movies WHERE user_id=@userId').all({userId});
  const history = rows as { watched: number; rating_100: number | null }[];
  const viewed = history.filter(row => row.watched === 1);
  return { watched: viewed.length, rated: viewed.filter(row => row.rating_100 !== null).length, unrated: viewed.filter(row => row.rating_100 === null).length };
}

// Preflight uses no writes. Backup must succeed before schema or import changes.
export async function importLetterboxd(database: Database.Database, userId: UserId, plan: ImportPlan, backupPath: string) {
  personalScope(database, userId);
  await database.backup(backupPath);
  requireProfileSchema(database);
  return database.transaction(() => {
    const issues = [...plan.issues];
    const movies = database.prepare('SELECT id, title, release_year, letterboxd_uri FROM movies').all() as Movie[];
    const ids: number[] = [];
    let addedMovies = 0, addedHistory = 0, preservedHistory = 0, attachedUris = 0, ratingsOutsideWatched = 0;
    for (const group of plan.groups) {
      let movie = group.uri ? movies.find(item => item.letterboxd_uri === group.uri) : undefined;
      if (!movie) {
        const identity = key(group.title, group.year);
        const candidates = identity ? movies.filter(item => key(item.title, item.release_year) === identity) : [];
        const eligible = candidates.filter(item => !item.letterboxd_uri || !group.uri);
        const sourceCandidates = plan.groups.filter(item => key(item.title, item.year) === identity);
        if (eligible.length && (candidates.length > 1 || sourceCandidates.length > 1)) {
          issues.push(...group.rows.map(row => ({ source: row.source, record: row.record, reason: 'Ambiguous match with existing library.' })));
          continue;
        }
        movie = eligible[0];
      }
      if (!movie) {
        const inserted = database.prepare('INSERT INTO movies (title, release_year, letterboxd_uri) VALUES (?, ?, ?)').run(group.title, group.year, group.uri);
        movie = { id: Number(inserted.lastInsertRowid), title: group.title, release_year: group.year, letterboxd_uri: group.uri };
        movies.push(movie); addedMovies++;
      } else if (group.uri && !movie.letterboxd_uri) {
        database.prepare('UPDATE movies SET letterboxd_uri = ? WHERE id = ?').run(group.uri, movie.id);
        movie.letterboxd_uri = group.uri; attachedUris++;
      }
      ids.push(movie.id);
      const watched = group.rows.find(row => row.source === 'watched');
      const rated = group.rows.find(row => row.source === 'ratings');
      if (rated && !watched) ratingsOutsideWatched++;
      if (database.prepare('SELECT 1 FROM user_movies WHERE user_id=@userId AND movie_id = ?').get({userId}, movie.id)) { preservedHistory++; continue; }
      const stars = rated?.stars ?? null;
      database.prepare(`INSERT INTO user_movies
        (user_id,movie_id, watched, rating_100, original_rating_stars, rating_source, letterboxd_date, letterboxd_rating_date)
        VALUES (@userId,?, 1, ?, ?, ?, ?, ?)`).run({userId}, movie.id, stars === null ? null : stars * 20, stars,
        stars === null ? 'none' : 'letterboxd', watched?.date ?? null, rated?.date ?? null);
      addedHistory++;
    }
    const skippedRows = new Set(issues.map(issue => `${issue.source}:${issue.record}`)).size;
    return { status: skippedRows ? 'partial' : 'complete', rowsRead: plan.rowsRead, uniqueWorks: plan.groups.length,
      addedMovies, addedHistory, preservedHistory, attachedUris, duplicates: plan.duplicates,
      skippedRows, issues, ratingsOutsideWatched, importedHistory: counts(database, userId, [...new Set(ids)]), library: counts(database, userId), backupPath };
  }).immediate();
}
