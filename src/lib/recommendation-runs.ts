import { userId as validUserId, type UserId } from './profiles';
import type { RecommendationPreferences } from './recommendation-preferences';
// Local HTTP orchestration journal. Private output, never a model prompt/profile or a task queue.
import { closeSync, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isRequestId } from './recommendation-batches';
import type { generateCandidates } from './candidates';
import type { rankRecommendations } from './recommendations';

// PID namespaces commonly reuse the server PID after a container restart.
// A lock predating this process cannot belong to it, even if kill(pid, 0) succeeds.
const processStartedAt = Date.now() - process.uptime() * 1000;

export type RunStage = 'starting' | 'candidates' | 'ranking' | 'saving' | 'saved' | 'failed' | 'save_failed';
export type StoredRun = {
  user_id: UserId;
  preferences?: RecommendationPreferences; request_id: string; started_at: string; stage: RunStage; code?: string; result_id?: string;
  candidates?: Awaited<ReturnType<typeof generateCandidates>>;
  ranking?: Awaited<ReturnType<typeof rankRecommendations>>;
  technical_usage?: { candidates?: unknown; ranking?: unknown };
  calls?: { openai: number; tmdb: number };
};
export class GenerationError extends Error {
  constructor(public readonly code: string, public readonly status = 500) { super(code); }
}
function locations(databasePath: string) {
  const canonical = realpathSync(/*turbopackIgnore: true*/ databasePath);
  const databaseKey = createHash('sha256').update(canonical).digest('hex').slice(0, 24);
  return { canonical, lock: `${canonical}.recommendations.lock`, folder: join(dirname(canonical), '.recommendation-runs', databaseKey) };
}
// These are private runtime files next to DATABASE_PATH, never bundled assets.
export function runStore(databasePath: string, userId: UserId) {
  validUserId(userId);
  const legacy = locations(databasePath);
  const paths = { ...legacy, folder: join(legacy.folder, userId) };
  const read = (file: string): StoredRun | null => {
    try {
      const value: unknown = JSON.parse(readFileSync(/*turbopackIgnore: true*/ file, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GenerationError('generation_state_unavailable');
      return value as StoredRun;
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new GenerationError('generation_state_unavailable'); }
  };
  return {
    list(): StoredRun[] {
      const names = [...new Set([paths.folder, ...(userId === 'ilya' ? [legacy.folder] : [])].flatMap(folder => existsSync(folder) ? readdirSync(folder) : []))];
      return names.filter(name => name.endsWith('.json') && isRequestId(name.slice(0,-5))).sort()
        .flatMap(name => { const value = this.read(name.slice(0,-5)); return value ? [value] : []; });
    },
    read(id: string) {
      if (!isRequestId(id)) throw new GenerationError('invalid_request', 400);
      const current = read(join(paths.folder, `${id}.json`));
      const run = current ?? (userId === 'ilya' ? read(join(legacy.folder, `${id}.json`)) : null);
      if (run && (current ? run.user_id !== userId : run.user_id !== undefined && run.user_id !== 'ilya')) throw new GenerationError('profile_mismatch',409);
      if (run) run.user_id = userId;
      if (run && (run.request_id !== id || !['starting', 'candidates', 'ranking', 'saving', 'saved', 'failed', 'save_failed'].includes(run.stage) ||
        typeof run.started_at !== 'string' || !Number.isFinite(Date.parse(run.started_at)))) throw new GenerationError('generation_state_unavailable');
      return run;
    },
    write(run: StoredRun) {
      if (run.user_id !== userId) throw new GenerationError('profile_mismatch',409);
      if (!isRequestId(run.request_id)) throw new GenerationError('invalid_request', 400);
      mkdirSync(paths.folder, { recursive: true, mode: 0o700 });
      function atomic(file: string, value: unknown) {
        const temporary = `${file}.${randomUUID()}.tmp`;
        try {
          const fd = openSync(/*turbopackIgnore: true*/ temporary, 'wx', 0o600);
          try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
          renameSync(/*turbopackIgnore: true*/ temporary, file);
          const folder = openSync(/*turbopackIgnore: true*/ paths.folder, 'r');
          try { fsyncSync(folder); } finally { closeSync(folder); }
        }
        finally { if (existsSync(temporary)) unlinkSync(temporary); }
      }
      atomic(join(paths.folder, `${run.request_id}.json`), run);
      atomic(join(paths.folder, 'latest.json'), { request_id: run.request_id, user_id: userId });
    },
    latest() {
      const pointer = read(join(paths.folder, 'latest.json')) ?? (userId === 'ilya' ? read(join(legacy.folder, 'latest.json')) : null);
      if (pointer?.user_id !== undefined && pointer.user_id !== userId) throw new GenerationError('profile_mismatch',409);
      if (pointer && !isRequestId(pointer.request_id)) throw new GenerationError('generation_state_unavailable');
      return pointer ? this.read(pointer.request_id) : null;
    },
    foreignRequest(id: string) {
      if (!isRequestId(id)) throw new GenerationError('invalid_request',400);
      return existsSync(join(legacy.folder,userId === 'ilya' ? 'valeriy' : 'ilya',`${id}.json`)) || (userId !== 'ilya' && existsSync(join(legacy.folder,`${id}.json`)));
    },
    lockOwner(): UserId | null {
      try { const value = JSON.parse(readFileSync(paths.lock,'utf8')); return validUserId(value.user_id ?? 'ilya'); } catch { return null; }
    },
    locked() { return existsSync(/*turbopackIgnore: true*/ paths.lock); },
    activeRequestId() {
      if (this.lockOwner() !== userId) return null;
      try {
        const owner = JSON.parse(readFileSync(/*turbopackIgnore: true*/ paths.lock, 'utf8'));
        return isRequestId(owner.request_id) ? owner.request_id : null;
      } catch { return null; }
    },
    ownerAlive() {
      if (!existsSync(/*turbopackIgnore: true*/ paths.lock)) return false;
      try {
        const owner = JSON.parse(readFileSync(/*turbopackIgnore: true*/ paths.lock, 'utf8'));
        if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) return false;
        if (owner.pid === process.pid && typeof owner.started_at === 'string' &&
          Date.parse(owner.started_at) < processStartedAt) return false;
        try { process.kill(owner.pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
      } catch { return false; }
    },
    acquire(id: string) {
      let fd: number;
      try { fd = openSync(/*turbopackIgnore: true*/ paths.lock, 'wx', 0o600); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new GenerationError('generation_busy', 409); throw new GenerationError('generation_state_unavailable'); }
      try { writeFileSync(fd, JSON.stringify({ user_id: userId, request_id: id, pid: process.pid, started_at: new Date().toISOString() })); }
      catch { closeSync(fd); unlinkSync(paths.lock); throw new GenerationError('generation_state_unavailable'); }
      const owned = fstatSync(fd);
      return () => {
        try { const current = statSync(/*turbopackIgnore: true*/ paths.lock); if (current.ino === owned.ino && current.dev === owned.dev) unlinkSync(paths.lock); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        finally { closeSync(fd); }
      };
    },
  };
}
