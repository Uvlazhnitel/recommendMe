import { readHomeSummary } from './home-summary';
import { parsePreferences, samePreferences, reportPreferences, type RecommendationPreferences } from './recommendation-preferences';
// Node-only orchestration. Existing candidate/ranking functions own every AI rule.
import { setTimeout as delay } from 'node:timers/promises';
import type Database from 'better-sqlite3';
import { openDatabase } from './db';
import { buildCandidateContext, prepareTasteInputs } from './candidate-context';
import { generateCandidates } from './candidates';
import { rankRecommendations } from './recommendations';
import { backupForRecommendationWrite, recordRecommendations } from './recommendation-memory';
import { migrateDatabase } from './migrations';
import { recommendationSchema, readRecommendationBatch } from './recommendation-batches';
import { GenerationError, runStore, type StoredRun } from './recommendation-runs';

export const GENERATION_TIMEOUT_MS = 15 * 60 * 1000;
export type RecommendationDependencies = {
  open?: typeof openDatabase;
  config?: () => { apiKey?: string; model?: string; tmdbKey?: string };
  backup?: (db: Database.Database) => Promise<unknown>;
  fetch?: typeof fetch; sleep?: (ms: number) => Promise<unknown>; timeoutMs?: number;
};
const configuration = () => ({ apiKey: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL, tmdbKey: process.env.TMDB_API_KEY });
function readiness(db: Database.Database, config: { apiKey?: string; model?: string; tmdbKey?: string }) {
  const settings = Boolean(config.apiKey?.trim() && config.model?.trim() && config.tmdbKey?.trim());
  try {
    const personal = prepareTasteInputs(db);
    return { can_generate: settings && personal.rated.length > 0, reason: !settings ? 'configuration_missing' : !personal.rated.length ? 'ratings_missing' : null,
      profile_refresh: { status: personal.profileRefresh.status, total_changes: personal.profileRefresh.total_changes, review_changes: personal.profileRefresh.review_changes, total_feedback_changes: personal.profileRefresh.total_feedback_changes, threshold: personal.profileRefresh.threshold } };
  } catch {
    return { can_generate: false, reason: 'profile_unavailable', profile_refresh: null };
  }
}
function hasResult(db: Database.Database, id: string | undefined | null) {
  return Boolean(id && recommendationSchema(db) >= 4 && db.prepare('SELECT 1 FROM recommendations WHERE result_id=? LIMIT 1').get(id));
}
function publicGeneration(db: Database.Database) {
  try {
    const store = runStore(db.name), latest = store.latest();
    if (store.locked()) {
      const id = store.activeRequestId();
      return { state: store.ownerAlive() ? 'running' as const : 'interrupted' as const, stage: latest && id === latest.request_id ? latest.stage : 'starting', request_id: id, recoverable_save: false };
    }
    if (!latest) return { state: 'idle' as const, stage: null, request_id: null, recoverable_save: false };
    if (hasResult(db, latest.result_id ?? latest.ranking?.result_id)) return { state: 'saved' as const, stage: 'saved', request_id: latest.request_id, recoverable_save: false };
    const recovery = ['saving', 'save_failed'].includes(latest.stage) && Boolean(latest.ranking && latest.candidates);
    return { state: recovery ? 'save_failed' as const : latest.stage === 'failed' ? 'failed' as const : 'interrupted' as const,
      stage: latest.stage, request_id: latest.request_id, recoverable_save: recovery };
  } catch {
    // An unreadable journal must not hide the previous SQL batch or enable an automatic paid retry.
    return { state: 'interrupted' as const, stage: null, request_id: null, recoverable_save: false };
  }
}
export function recommendationState(dependencies: RecommendationDependencies = {}) {
  const db = (dependencies.open ?? openDatabase)({ readonly: true });
  try {
    recommendationSchema(db);
    return db.transaction(() => ({ status: 'ok' as const, batch: readRecommendationBatch(db), home: readHomeSummary(db), readiness: readiness(db, (dependencies.config ?? configuration)()), generation: publicGeneration(db) })).deferred();
  } finally { db.close(); }
}

export async function generateRecommendationBatch(requestId: string, dependencies: RecommendationDependencies = {}, options: { saveOnly?: boolean; preferences?: RecommendationPreferences } = {}) {
  const open = dependencies.open ?? openDatabase, config = (dependencies.config ?? configuration)();
  let preferences = parsePreferences(options.preferences);
  const requested = options.preferences === undefined ? undefined : preferences;
  const checkSnapshot = (existing: StoredRun | null) => {
    if (!existing) return;
    const prepared = existing.candidates && existing.ranking ? reportPreferences(existing.candidates, existing.ranking) : null;
    const frozen = existing.preferences === undefined ? prepared : parsePreferences(existing.preferences);
    if (prepared && frozen && !samePreferences(prepared, frozen)) throw new GenerationError('generation_state_unavailable', 409);
    if (existing.preferences !== undefined && existing.candidates && existing.ranking && !prepared) throw new GenerationError('generation_state_unavailable', 409);
    if (requested && !samePreferences(requested, frozen ?? parsePreferences(undefined))) throw new GenerationError('preferences_conflict', 409);
    preferences = frozen ?? parsePreferences(undefined);
  };
  const ro = open({ readonly: true });
  let store: ReturnType<typeof runStore>;
  try {
    recommendationSchema(ro); store = runStore(ro.name);
    const existing = store.read(requestId), resultId = existing?.result_id ?? existing?.ranking?.result_id;
    checkSnapshot(existing);
    if (hasResult(ro, resultId)) return { status: 'ok' as const, replayed: true, saved_count: 0, batch: readRecommendationBatch(ro, resultId!), request_id: requestId };
    if (options.saveOnly && !existing) throw new GenerationError('saved_result_unavailable', 409);
    if (existing && !(['saving', 'save_failed'].includes(existing.stage) && existing.candidates && existing.ranking)) {
      throw new GenerationError(existing.stage === 'failed' ? 'generation_failed_before' : store.ownerAlive() ? 'generation_busy' : 'generation_interrupted', 409);
    }
    if (!existing) {
      const ready = readiness(ro, config);
      if (!ready.can_generate) throw new GenerationError(ready.reason!, ready.reason === 'configuration_missing' ? 503 : 409);
      buildCandidateContext(ro, undefined, preferences); // Complete free context/size validation before any payment.
    }
  } finally { ro.close(); }
  const release = store!.acquire(requestId);
  let db: Database.Database | undefined;
  let run: StoredRun | null = null;
  let savePhase = false;
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), dependencies.timeoutMs ?? GENERATION_TIMEOUT_MS);
  const checkDeadline = () => { if (deadline.signal.aborted) throw new GenerationError('generation_timeout', 504); };
  const calls = { openai: 0, tmdb: 0 };
  const boundedFetch: typeof fetch = async (input, init) => {
    checkDeadline();
    const host = new URL(input instanceof Request ? input.url : String(input)).hostname;
    if (host === 'api.openai.com') calls.openai++;
    if (host === 'api.themoviedb.org') calls.tmdb++;
    const signals = init?.signal ? [deadline.signal, init.signal] : [deadline.signal];
    return (dependencies.fetch ?? fetch)(input, { ...init, signal: AbortSignal.any(signals) });
  };
  const boundedSleep = async (ms: number) => {
    checkDeadline();
    if (dependencies.sleep) await dependencies.sleep(ms); else await delay(ms, undefined, { signal: deadline.signal });
    checkDeadline();
  };
  try {
    db = open();
    run = store!.read(requestId);
    checkSnapshot(run);
    const existingId = run?.result_id ?? run?.ranking?.result_id;
    if (hasResult(db, existingId)) return { status: 'ok' as const, replayed: true, saved_count: 0, batch: readRecommendationBatch(db, existingId!), request_id: requestId };
    const recovering = run !== null;
    if (options.saveOnly && !recovering) throw new GenerationError('saved_result_unavailable', 409);
    if (recovering && !(['saving', 'save_failed'].includes(run!.stage) && run!.candidates && run!.ranking)) throw new GenerationError('generation_interrupted', 409);
    try { await (dependencies.backup ?? backupForRecommendationWrite)(db); }
    catch { throw new GenerationError('backup_failed'); }
    checkDeadline();
    migrateDatabase(db);
    if (!run) {
      run = { request_id: requestId, started_at: new Date().toISOString(), stage: 'starting', calls, preferences };
      store!.write(run);
      run.stage = 'candidates'; store!.write(run);
      const candidates = await generateCandidates(db, { live: true, preferences, ...config, openaiFetch: boundedFetch, tmdbFetch: boundedFetch, sleep: boundedSleep });
      run.technical_usage = { candidates: candidates.mode === 'live' ? candidates.statistics : null };
      checkDeadline();
      if (candidates.mode !== 'live' || candidates.status !== 'ok') throw new GenerationError('candidates_failed', 502);
      if (!candidates.candidates.length) throw new GenerationError('no_candidates', 422);
      run.candidates = candidates; run.stage = 'ranking'; store!.write(run);
      const ranking = await rankRecommendations(db, candidates, { live: true, preferences, save: false, apiKey: config.apiKey, model: config.model, fetch: boundedFetch });
      checkDeadline();
      run.technical_usage = { ...run.technical_usage, ranking: ranking.statistics };
      if (ranking.status !== 'ok' || !ranking.recommendations.length || !ranking.result_id) throw new GenerationError('ranking_failed', 502);
      run.ranking = ranking; run.result_id = ranking.result_id; run.stage = 'saving';
      store!.write(run); // Persist the validated output BEFORE its SQL write, for a free retry.
    }
    checkDeadline(); savePhase = true;
    const saved = recordRecommendations(db, run.candidates, { result: run.ranking }, { dryRun: false });
    if (!saved.saved_count && !saved.already_saved_count) throw new GenerationError('no_eligible_recommendations', 422);
    run.stage = 'saved'; run.code = undefined;
    // SQLite commit is authoritative. A failed final journal update is recoverable from the prepared file.
    try { store!.write(run); } catch { /* Replay finds result_id in SQLite; it never pays again. */ }
    return { status: 'ok' as const, replayed: recovering, saved_count: saved.saved_count,
      batch: readRecommendationBatch(db, run.ranking!.result_id!), request_id: requestId };
  } catch (error) {
    const failure = deadline.signal.aborted ? new GenerationError('generation_timeout', 504) : error instanceof GenerationError ? error :
      new GenerationError(savePhase ? 'save_failed' : run?.stage === 'ranking' ? 'ranking_failed' : 'generation_unavailable', run?.stage === 'ranking' ? 502 : 500);
    if (run) {
      run.stage = run.ranking && run.candidates && failure.code !== 'no_eligible_recommendations' ? 'save_failed' : 'failed'; run.code = failure.code;
      try { store!.write(run); } catch { /* The previous durable state still prevents another paid attempt. */ }
    }
    throw failure;
  } finally {
    clearTimeout(timer); db?.close(); release(); // No early Promise.race releasing a still-running operation.
  }
}
