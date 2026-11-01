import { loadEnvConfig } from '@next/env';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { openDatabase } from '../src/lib/db';
import { createTmdbClient } from '../src/lib/tmdb';
import { createLetterboxdReader } from '../src/lib/letterboxd-identity';
import { applyRepair, previewRepair, type RepairReport } from '../src/lib/tmdb-repair';
import { previewAllRepair, applyAllRepair, type AllRepairReport, type RepairReview } from '../src/lib/tmdb-repair-all';
import { backupDatabase } from './container-db.mjs';

function save(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(temporary, path);
}
async function main() {
  const { values } = parseArgs({ strict: true, options: {
    database: { type: 'string' }, 'dry-run': { type: 'boolean' }, apply: { type: 'boolean' }, offline: { type: 'boolean' },
    report: { type: 'string' }, cache: { type: 'string' }, 'all-profiles': { type: 'boolean' }, review: { type: 'string' },
  } });
  if (!values.database) throw Error('Укажите --database с явным путём базы.');
  if (values.apply && (!values.offline || values['dry-run'] || !values.report)) throw Error('Применение требует --apply --offline --report; --dry-run несовместим.');
  loadEnvConfig(process.cwd(), process.env.NODE_ENV !== 'production');
  const path = resolve(values.database);
  if (!existsSync(path)) throw Error('База не найдена.');
  process.env.DATABASE_PATH = path;
  const cacheFolder = resolve(values.cache ?? join(dirname(path), 'tmdb-repair', 'cache'));
  const reportPath = resolve(values.report ?? join(dirname(path), 'tmdb-repair', `report-${Date.now()}.json`));
  if ([path, path + '-wal', path + '-shm'].includes(reportPath) || (existsSync(reportPath) && realpathSync(reportPath) === realpathSync(path))) throw Error('Отчёт не может перезаписывать базу или её служебные файлы.');
  const db = openDatabase({ readonly: !values.apply });
  const lockPath = `${path}.tmdb-repair.lock`;
  let lock: number | undefined;
  try {
    if (values.apply) {
      lock = openSync(lockPath, 'wx', 0o600);
      if (statSync(reportPath).size > 30 * 1024 * 1024) throw Error('Отчёт слишком большой.');
      const report = JSON.parse(readFileSync(reportPath, 'utf8')) as RepairReport | AllRepairReport;
      const backup = async () => {
        const backup = await backupDatabase(path, process.env.BACKUP_DIR ?? join(dirname(path), 'backups'));
        console.log(JSON.stringify({ backup }));
      };
      const result = report.version === 2 ? await applyAllRepair(db, report, backup) : await applyRepair(db, report, backup);
      console.log(JSON.stringify({ ...result, reportPath }));
    } else {
      const tmdb = createTmdbClient(process.env.TMDB_API_KEY, { maxRequests: values['all-profiles'] ? 4000 : 1500 });
      async function cached<T>(key: string, fetchValue: () => Promise<T>): Promise<T> {
        const file = join(cacheFolder, createHash('sha256').update(key).digest('hex') + '.json');
        if (existsSync(file)) {
          if (statSync(file).size > 14 * 1024 * 1024) throw Error('Некорректный размер кеша.');
          const entry = JSON.parse(readFileSync(file, 'utf8'));
          if (entry.key !== key || !Number.isFinite(entry.at) || Date.now() - entry.at > 7 * 86400000 || entry.at > Date.now()) {
            const value = await fetchValue(); save(file, { key, at: Date.now(), value }); return value;
          }
          return entry.value as T;
        }
        const value = await fetchValue(); save(file, { key, at: Date.now(), value }); return value;
      }
      const readPage = createLetterboxdReader();
      if (values['all-profiles']) {
        const report = await previewAllRepair(db, {
          repairWork: hit => cached(`${hit.type==='episode'?'work-v3':'work-v2'}:${JSON.stringify(hit)}`, () => tmdb.repairWork(hit)),
          repairFind: imdb => cached(`find-v2:${imdb}`, () => tmdb.repairFind(imdb)),
          repairSearch: (query, year, type) => cached(`search-v2:${JSON.stringify([query,year,type])}`, () => tmdb.repairSearch(query,year,type)),
        }, url => cached(`letterboxd-v1:${url}`, () => readPage(url)), report => save(reportPath, report), values.review ? JSON.parse(readFileSync(resolve(values.review),'utf8')) as RepairReview[] : []);
        save(reportPath, report);
        console.log(JSON.stringify({ reportPath, processed: report.items.length, ready: report.items.filter(i=>i.status==='ready').length, stopped: report.stopped, requests: tmdb.stats.requests }));
        if(report.stopped)process.exitCode=1;
        return;
      }
      const report = await previewRepair(db, {
        details: id => cached(`details-v1:${id}`, () => tmdb.details(id)),
        presentation: id => cached(`presentation-v1:${id}`, () => tmdb.presentation(id)),
        search: (title, year) => cached(`search-v1:${JSON.stringify([title, year])}`, () => tmdb.search(title, year)),
      }, url => cached(`letterboxd-v1:${url}`, () => readPage(url)), report => save(reportPath, report));
      save(reportPath, report);
      console.log(JSON.stringify({ reportPath, processed: report.items.length, ready: report.items.filter(item => item.status === 'ready').length,
        unresolved: report.items.filter(item => item.status === 'unresolved').length, errors: report.items.filter(item => item.status === 'error').length,
        withoutPoster: report.items.filter(item => item.status === 'ready' && !item.details?.poster_path).length, stopped: report.stopped, tmdbRequests: tmdb.stats.requests }));
      if (report.stopped || report.items.some(item => item.status === 'error')) process.exitCode = 1;
    }
  } finally {
    db.close();
    if (lock !== undefined) { closeSync(lock); unlinkSync(lockPath); }
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Ошибка восстановления привязок.'); process.exitCode = 1; });
