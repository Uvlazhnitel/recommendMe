import { loadEnvConfig } from '@next/env';
import { parseArgs } from 'node:util';
import { closeSync, existsSync, openSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { openDatabase } from '../src/lib/db';
import { userId } from '../src/lib/profiles';
import { createTmdbClient } from '../src/lib/tmdb';
import { requireOpenAIConfig } from '../src/lib/openai';
import { hasRussianCache, russianMovie, saveRussianMovie, translateExplanation, explanationHash, russianText, type ExplanationSource } from '../src/lib/russian-presentation';
import { backupDatabase } from './container-db.mjs';

async function main() {
  const { values } = parseArgs({ options: { user: { type: 'string' }, write: { type: 'boolean' }, offline: { type: 'boolean' },
    limit: { type: 'string', default: '1000' }, 'retry-failed': { type: 'boolean' } }, strict: true });
  const user = userId(values.user);
  const limit = Number(values.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000) throw Error('Лимит должен быть целым числом от 1 до 10000.');
  if (values.write && !values.offline) throw Error('Остановите приложение и укажите --offline для записи.');
  loadEnvConfig(process.cwd(), process.env.NODE_ENV !== 'production');
  const path = resolve(process.env.DATABASE_PATH ?? 'data/movies.sqlite');
  if (!existsSync(path)) throw Error('База не найдена.');
  let lock: number | undefined;
  const lockPath = path + '.russian.lock';
  if (values.write) lock = openSync(lockPath, 'wx', 0o600);
  let db: ReturnType<typeof openDatabase> | undefined;
  try {
    db = openDatabase({ readonly: !values.write });
    const database = db;
    if (!hasRussianCache(db)) throw Error('Сначала остановите приложение и выполните npm run db:init -- --offline (создаёт и проверяет backup).');
    const movies = (db.prepare("SELECT tmdb_id FROM movies WHERE tmdb_id IS NOT NULL AND media_type='movie' ORDER BY id").all() as { tmdb_id: number }[])
      .filter(row => !russianMovie(database, row.tmdb_id)).slice(0, limit);
    const explanations = (db.prepare(`SELECT id,movie_id,why_fit,possible_mismatch FROM recommendations
      WHERE user_id=? AND why_fit IS NOT NULL AND possible_mismatch IS NOT NULL ORDER BY id`).all(user) as ExplanationSource[]).filter(row => {
      const cache = database.prepare('SELECT status,source_hash FROM ru_recommendation_text WHERE recommendation_id=? AND user_id=?').get(row.id, user) as { status: string; source_hash: string } | undefined;
      return !cache || cache.source_hash !== explanationHash(row) || (values['retry-failed'] && cache.status !== 'done');
    }).slice(0, limit);
    const paid = explanations.filter(row => !russianText(row.why_fit) || !russianText(row.possible_mismatch)).length;
    const blocked = (db.prepare("SELECT count(*) n FROM ru_recommendation_text WHERE user_id=? AND status<>'done'").get(user) as { n: number }).n;
    console.log(JSON.stringify({ mode: values.write ? 'запись' : 'предпросмотр', user, movies: movies.length, explanations: explanations.length, paid_requests_at_most: paid, failed_or_interrupted: blocked }));
    if (!values.write) return;
    if (!movies.length && !explanations.length) { console.log('Новых текстов для перевода нет.'); return; }
    if (paid) requireOpenAIConfig(process.env.OPENAI_API_KEY, process.env.OPENAI_MODEL);
    const tmdb = movies.length ? createTmdbClient(process.env.TMDB_API_KEY, { maxRequests: movies.length * 3 }) : null;
    // Snapshot includes SQLite and original journals; backupDatabase verifies it before returning.
    const backup = await backupDatabase(path, process.env.BACKUP_DIR ?? join(dirname(path), 'backups'));
    console.log(`Проверенная резервная копия: ${backup}`);
    for (const movie of movies) {
      saveRussianMovie(db, movie.tmdb_id, await tmdb!.presentation(movie.tmdb_id));
      console.log(`Сведения TMDB ${movie.tmdb_id}: сохранены.`);
    }
    for (const row of explanations) {
      const status = await translateExplanation(db, user, row.id, { apiKey: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL, retryFailed: values['retry-failed'] });
      console.log(`Объяснение ${row.id}: ${status === 'translated' ? 'переведено' : 'пропущено'}.`);
    }
    const usage = db.prepare('SELECT recommendation_id,status,model,usage_json FROM ru_recommendation_text WHERE user_id=? ORDER BY recommendation_id').all(user);
    console.log(JSON.stringify({ user, translation_usage: usage }));
  } finally {
    db?.close();
    if (lock !== undefined) { closeSync(lock); unlinkSync(lockPath); }
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Неизвестная ошибка.'); console.error('Перевод не завершён. Проверьте схему, настройки API, доступность базы и файл блокировки. Автоматического повтора платных запросов нет; подробности состояния доступны в ru_recommendation_text.'); process.exitCode = 1; });
