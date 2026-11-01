import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { requireProfileSchema } from './profiles';
import { extractLetterboxdIdentity, letterboxdUrl, LetterboxdError } from './letterboxd-identity';
import { matches, parseDetails, TmdbError, type Details, type TmdbClient } from './tmdb';
import { hasRussianCache, saveRussianMovie } from './russian-presentation';

type Row = { id: number; title: string; release_year: number | null; letterboxd_uri: string | null; tmdb_id: number | null; media_type: string; [key: string]: unknown };
export type RepairItem = { movieId: number; title: string; year: number | null; fingerprint: string; status: 'ready' | 'unresolved' | 'error'; reason: string;
  evidence?: { source: string; identity: { type: 'movie'; id: number } | null }; details?: Details; presentation?: { title: string; overview: string | null } };
export type RepairReport = { version: 1; schema: number; stopped: boolean; items: RepairItem[] };
export type RepairApi = Pick<TmdbClient, 'search' | 'details' | 'presentation'>;
const fingerprint = (row: Row) => createHash('sha256').update(JSON.stringify(Object.keys(row).sort().map(key => [key, row[key]]))).digest('hex');
const rows = (db: Database.Database) => db.prepare('SELECT * FROM movies ORDER BY id').all() as Row[];

// Re-validate serialized metadata with the same parser as live TMDB responses.
export function validateRepairDetails(value: Details): Details {
  if (!value || typeof value !== 'object') throw Error('Некорректные метаданные отчёта.');
  return parseDetails({ ...value, release_date: value.year === null ? null : `${value.year}-01-01`,
    credits: value.credits === null && value.directors === null ? null : {
      cast: value.credits?.cast, crew: [...(value.credits?.crew ?? []).filter(person => person.job !== 'Director'), ...(value.directors ?? []).map(person => ({ ...person, job: 'Director' }))],
    } });
}
export async function previewRepair(db: Database.Database, api: RepairApi, readPage: (url: string) => Promise<string>, onProgress?: (report: RepairReport) => void) {
  requireProfileSchema(db);
  const all = rows(db), claimed = new Set(all.filter(row => row.tmdb_id !== null).map(row => row.tmdb_id));
  const report: RepairReport = { version: 1, schema: db.pragma('user_version', { simple: true }) as number, stopped: false, items: [] };
  for (const row of all.filter(row => row.tmdb_id === null && row.letterboxd_uri && row.media_type !== 'tv')) {
    const item: RepairItem = { movieId: row.id, title: row.title, year: row.release_year, fingerprint: fingerprint(row), status: 'unresolved', reason: '' };
    try {
      const source = letterboxdUrl(row.letterboxd_uri!).href;
      const identity = extractLetterboxdIdentity(await readPage(source));
      if (identity?.type === 'tv') throw Error('Исходная запись относится к сериалу.');
      item.evidence = { source, identity: identity ? { type: 'movie', id: identity.id } : null };
      let details: Details;
      if (identity) details = validateRepairDetails(await api.details(identity.id));
      else {
        if (row.release_year === null) throw Error('Неизвестен исходный год.');
        const found = await api.search(row.title, row.release_year);
        const exact = found.candidates.filter(candidate => matches(row, candidate));
        if (!found.complete || exact.length !== 1) throw Error('Нет единственного подтверждённого совпадения TMDB.');
        details = validateRepairDetails(await api.details(exact[0].id));
        if (details.id !== exact[0].id) throw Error('TMDB вернул другой ID.');
      }
      if (identity && details.id !== identity.id) throw Error('TMDB вернул другой ID.');
      if (!matches(row, details)) throw Error('Название или год не подтверждены TMDB.');
      if (claimed.has(details.id)) throw Error('TMDB ID уже занят другой записью; объединение не выполнялось.');
      const presentation = await api.presentation(details.id);
      validatePresentation(presentation);
      item.details = details; item.presentation = presentation;
      item.status = 'ready'; item.reason = details.poster_path ? 'Идентичность подтверждена.' : 'Идентичность подтверждена; постера в TMDB нет.';
      claimed.add(details.id);
    } catch (error) {
      const external = error instanceof LetterboxdError || error instanceof TmdbError;
      item.status = external ? 'error' : 'unresolved';
      item.reason = error instanceof Error ? error.message : 'Ошибка проверки фильма.';
      if (external && error.stop) report.stopped = true;
    }
    report.items.push(item); onProgress?.(report);
    if (report.stopped) break;
  }
  return report;
}
function validatePresentation(value: { title: string; overview: string | null }) {
  if (!value || typeof value.title !== 'string' || !value.title.trim() || value.title.length > 1000 ||
    (value.overview !== null && (typeof value.overview !== 'string' || value.overview.length > 20000))) throw Error('Некорректное русское представление.');
}
export async function applyRepair(db: Database.Database, report: RepairReport, backup: () => Promise<unknown>) {
  requireProfileSchema(db);
  if (report.version !== 1 || report.schema !== db.pragma('user_version', { simple: true }) || !Array.isArray(report.items)) throw Error('Неподдерживаемый отчёт или схема.');
  const ready = report.items.filter(item => item.status === 'ready');
  const validate = () => {
    const seen = new Set<number>(), ids = new Set<number>();
    const pending: { item: RepairItem; details: Details }[] = [];
    for (const item of ready) {
      if (!Number.isSafeInteger(item.movieId) || seen.has(item.movieId) || !item.details || !item.presentation || !item.evidence) throw Error('Некорректная или повторная запись отчёта.');
      seen.add(item.movieId);
      const details = validateRepairDetails(item.details); validatePresentation(item.presentation);
      if (ids.has(details.id)) throw Error('Повторный TMDB ID в отчёте.'); ids.add(details.id);
      if (item.evidence.identity !== null && (item.evidence.identity.type !== 'movie' || item.evidence.identity.id !== details.id)) throw Error('Противоречивый источник идентичности.');
      const row = db.prepare('SELECT * FROM movies WHERE id=?').get(item.movieId) as Row | undefined;
      if (!row) throw Error('Исходная запись удалена.');
      if (!matches(row, details) || row.media_type === 'tv' || !row.letterboxd_uri || letterboxdUrl(row.letterboxd_uri).href !== item.evidence.source) throw Error('Идентичность исходной записи изменилась.');
      const owner = db.prepare('SELECT id FROM movies WHERE tmdb_id=?').get(details.id) as { id: number } | undefined;
      if (owner && owner.id !== row.id) throw Error('TMDB ID занят другой записью.');
      if (row.tmdb_id === details.id && row.tmdb_enrichment_status === 'matched') continue;
      if (row.tmdb_id !== null || fingerprint(row) !== item.fingerprint) throw Error('Исходная запись изменилась после предпросмотра.');
      pending.push({ item, details });
    }
    return pending;
  };
  if (!validate().length) return { applied: 0, withoutPoster: 0 };
  await backup();
  return db.transaction(() => {
    const pending = validate(), now = new Date().toISOString();
    const json = (value: unknown) => value === null ? null : JSON.stringify(value);
    for (const { item, details: d } of pending) {
      db.prepare(`UPDATE movies SET tmdb_id=?,tmdb_title=?,original_title=?,tmdb_release_year=?,original_language=?,
        overview=?,genres_json=?,runtime_minutes=?,poster_path=?,backdrop_path=?,tmdb_vote_average=?,tmdb_vote_count=?,tmdb_popularity=?,
        directors_json=?,credits_json=?,metadata_updated_at=?,media_type='movie',tmdb_enrichment_status='matched',tmdb_attempted_at=? WHERE id=?`)
        .run(d.id,d.title,d.original_title,d.year,d.original_language,d.overview,json(d.genres),d.runtime,d.poster_path,d.backdrop_path,d.vote_average,d.vote_count,d.popularity,
          json(d.directors),json(d.credits),now,now,item.movieId);
      if (hasRussianCache(db)) saveRussianMovie(db, d.id, item.presentation!);
    }
    return { applied: pending.length, withoutPoster: pending.filter(value => !value.details.poster_path).length };
  }).immediate();
}
