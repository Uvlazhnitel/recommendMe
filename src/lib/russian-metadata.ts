// TMDB presentation hydration at HTTP boundaries; no LLM calls on reads.
import Database from 'better-sqlite3';
import { openDatabase } from './db';
import { backupForRecommendationWrite } from './recommendation-memory';
import { createTmdbClient } from './tmdb';
import { hasRussianCache, russianMovie, saveRussianMovie } from './russian-presentation';

export async function warmRussianMovies(movieIds: number[]) {
  if (!movieIds.length || !process.env.TMDB_API_KEY?.trim()) return;
  let db: ReturnType<typeof openDatabase> | undefined;
  try {
    db = openDatabase();
    const database = db;
    if (!hasRussianCache(db)) return; // Never migrate on reads/startup.
    const ids = [...new Set(movieIds)].slice(0, 100).flatMap(movieId => {
      const row = database.prepare("SELECT tmdb_id FROM movies WHERE id=? AND media_type='movie'").get(movieId) as { tmdb_id: number | null } | undefined;
      return row?.tmdb_id && !russianMovie(database, row.tmdb_id) ? [row.tmdb_id] : [];
    });
    if (!ids.length) return;
    const deadline = AbortSignal.timeout(8000);
    const client = createTmdbClient(process.env.TMDB_API_KEY, { maxRequests: ids.length, timeoutMs: 8000,
      fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.any([deadline, ...(init?.signal ? [init.signal] : [])]) }),
    });
    let backedUp = false;
    for (const id of ids) {
      if (russianMovie(db, id)) continue;
      const value = await client.presentation(id);
      if (!backedUp) {
        const path = await backupForRecommendationWrite(db);
        const backup = new Database(path, { readonly: true });
        try { if (backup.pragma('integrity_check', { simple: true }) !== 'ok' || (backup.pragma('foreign_key_check') as unknown[]).length) throw Error('Резервная копия не прошла проверку.'); }
        finally { backup.close(); }
        backedUp = true;
      }
      saveRussianMovie(db, id, value);
    }
  } catch {
    // Canonical data remain usable; readers show Russian missing-description text.
    console.warn('Не удалось обновить русские сведения о фильмах. Сохранённые данные доступны.');
  } finally { db?.close(); }
}
