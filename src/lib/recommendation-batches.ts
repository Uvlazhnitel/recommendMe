import { requireProfileSchema } from './profiles';
import { personalScope, type UserId } from './profiles';
import { parsePreferences, type RecommendationPreferences } from './recommendation-preferences';
// Node-only SQLite reader; no network, migration or filesystem writes.
import type Database from 'better-sqlite3';
import { blockedReason, readCandidateHistory } from './candidate-context';
import { tmdbImage } from './movie-images';

export type RecommendationMovie = {
  movie_id: number; tmdb_id: number; title: string; year: number; genres: string[]; runtime: number;
  poster_path: string | null; backdrop_path: string | null; why_fit: string; possible_mismatch: string;
};
export type RecommendationBatch = {
  result_id: string; generated_at: string | null; recommended_at: string; time_kind: 'generated' | 'recorded';
  preferences?: RecommendationPreferences | null; total_count: number; hidden_count: number; unavailable_count: number; movies: RecommendationMovie[];
};
type Row = {
  id: number; result_id: string; recommended_at: string; why_fit: string | null; possible_mismatch: string | null;
  movie_id: number; tmdb_id: number | null; title: string; tmdb_title: string | null; original_title: string | null;
  release_year: number | null; tmdb_release_year: number | null; media_type: string; runtime_minutes: number | null;
  poster_path: string | null; backdrop_path?: string | null; genres_json: string | null;
};
const meaningful = (value: unknown): value is string => typeof value === 'string' && Boolean(value.trim());
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isRequestId = (value: unknown): value is string => typeof value === 'string' && uuid.test(value);
export function recommendationSchema(db: Database.Database) {
  const version = db.pragma('user_version', { simple: true }) as number;
  requireProfileSchema(db);
  return version;
}
export function readRecommendationBatch(db: Database.Database, userId: UserId, resultId?: string): RecommendationBatch | null {
  personalScope(db, userId);
  return db.transaction(() => {
    if (recommendationSchema(db) < 4) return null;
    const groups = resultId ? [{ result_id: resultId }] : db.prepare(`SELECT result_id FROM recommendations
      WHERE user_id=@userId AND result_id IS NOT NULL AND result_id NOT LIKE 'manual:%'
      GROUP BY result_id ORDER BY max(recommended_at) DESC,max(id) DESC`).all({userId}) as { result_id: string }[];
    // Cooldown prevents a NEW show, not viewing an already saved batch.
    const history = readCandidateHistory(db, userId).map(row => ({ ...row, last_recommended_at: null }));
    for (const group of groups) {
      if (!meaningful(group.result_id) || (!group.result_id.startsWith('legacy:') && !isRequestId(group.result_id))) continue;
      const rows = db.prepare(`SELECT m.*,r.id,r.movie_id,r.result_id,r.recommended_at,r.why_fit,r.possible_mismatch
        FROM recommendations r LEFT JOIN movies m ON m.id=r.movie_id WHERE r.user_id=@userId AND r.result_id=? ORDER BY r.id`).all({userId}, group.result_id) as Row[];
      if (!rows.length || rows.length > 5 || rows.some(row => !meaningful(row.why_fit) || !meaningful(row.possible_mismatch)) ||
        new Set(rows.map(row => row.recommended_at)).size !== 1 || !Number.isFinite(Date.parse(rows[0].recommended_at))) continue;
      let preferences: RecommendationPreferences | null = null;
      if (recommendationSchema(db) >= 7) {
        const metadata = db.prepare('SELECT metadata_json FROM recommendation_evaluation WHERE user_id=@userId AND result_id=?').get({userId}, group.result_id) as { metadata_json: string } | undefined;
        try { const raw = metadata ? JSON.parse(metadata.metadata_json).preferences : undefined; if (raw !== undefined) preferences = parsePreferences(raw); } catch { /* Old/invalid optional metadata must not hide saved films. */ }
      }
      const generated = isRequestId(group.result_id);
      const batch: RecommendationBatch = { result_id: group.result_id, generated_at: generated ? rows[0].recommended_at : null,
        recommended_at: rows[0].recommended_at, time_kind: generated ? 'generated' : 'recorded', total_count: rows.length,
        preferences, hidden_count: 0, unavailable_count: 0, movies: [] };
      for (const row of rows) {
        const year = row.release_year ?? row.tmdb_release_year;
        if (row.tmdb_id === null || !Number.isSafeInteger(row.tmdb_id) || row.tmdb_id < 1 || row.media_type !== 'movie' || year === null || !Number.isInteger(year) || year < 1 || year > 9999 ||
          row.runtime_minutes === null || !Number.isSafeInteger(row.runtime_minutes) || row.runtime_minutes < 60 || !meaningful(row.title)) { batch.unavailable_count++; continue; }
        const reason = blockedReason({ id: row.tmdb_id, title: row.tmdb_title ?? row.title, original_title: row.original_title, year }, history);
        if (reason) { batch.hidden_count++; continue; }
        let genres: unknown;
        try { genres = JSON.parse(row.genres_json ?? '[]'); } catch { batch.unavailable_count++; continue; }
        if (!Array.isArray(genres) || !genres.every(genre => genre && typeof genre === 'object' && meaningful(genre.name))) { batch.unavailable_count++; continue; }
        batch.movies.push({ movie_id: row.movie_id, tmdb_id: row.tmdb_id, title: row.tmdb_title ?? row.title, year, genres: genres.map(genre => genre.name),
          runtime: row.runtime_minutes, poster_path: tmdbImage(row.poster_path) ? row.poster_path : null,
          backdrop_path: tmdbImage(row.backdrop_path) ? row.backdrop_path! : null,
          why_fit: row.why_fit!, possible_mismatch: row.possible_mismatch! });
      }
      return batch; // An exhausted latest batch must not fall back to older films.
    }
    return null;
  }).deferred();
}
