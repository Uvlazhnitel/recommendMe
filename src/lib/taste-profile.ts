import {historicalEvidence,validateHistoricalProfile,type HistoricalEvidence,type HistoricalPattern} from './historical-evidence';
import { personalScope, type UserId } from './profiles';
import { readReviewTexts, reviewSnapshot, type ReviewSnapshot } from './review-context';
import { openSync, closeSync, writeFileSync, unlinkSync, fstatSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { buildTasteContext, type TasteContext } from './taste-context';
import { PROFILE_SCHEMA_VERSION, PROMPT_VERSION, validateProfile, type Evidence, type ProfileBody } from './taste-schema';
import { parseUsage, requestTasteProfile, requireOpenAIConfig, type Usage } from './openai-taste';

export type StoredProfile = ProfileBody & { profile_version: number; generated_at: string; ratings_count: number; ratings_snapshot: Evidence[]; reviews_snapshot?: ReviewSnapshot; historical_snapshot?:HistoricalEvidence[]; historical_patterns?:HistoricalPattern[];
  context_fingerprint: string; prompt_version: number; schema_version: number; contrast_pairs_count: number;
  requested_model: string; model: string; response_id: string | null; usage: Usage | null };
const bodyFields = ['strong_preferences', 'negative_patterns', 'contrasts', 'uncertainties'] as const;
const metadataFields = ['profile_version', 'generated_at', 'ratings_count', 'ratings_snapshot', 'context_fingerprint', 'prompt_version', 'schema_version',
  'contrast_pairs_count', 'requested_model', 'model', 'response_id', 'usage'];
function rawProfile(database: Database.Database, userId: UserId): string | null {
  personalScope(database, userId);
  return (database.prepare('SELECT profile_json FROM taste_profile WHERE user_id=@userId').get({userId}) as { profile_json: string } | undefined)?.profile_json ?? null;
}
function positiveInteger(value: unknown) { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0; }
export function parseStoredProfile(raw: string): StoredProfile {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('Saved taste profile is invalid JSON; use --live --force to replace it.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid saved taste profile.');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).filter(key => !['reviews_snapshot','historical_snapshot','historical_patterns'].includes(key)).length !== bodyFields.length + metadataFields.length || [...bodyFields, ...metadataFields].some(key => !Object.hasOwn(record, key))) throw new Error('Invalid saved profile fields.');
  if (!positiveInteger(record.profile_version) || !(Number.isSafeInteger(record.ratings_count)&&Number(record.ratings_count)>=0) || !positiveInteger(record.prompt_version) || ![PROFILE_SCHEMA_VERSION,2].includes(Number(record.schema_version)) ||
    typeof record.generated_at !== 'string' || !Number.isFinite(Date.parse(record.generated_at)) || new Date(record.generated_at).toISOString() !== record.generated_at ||
    typeof record.context_fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(record.context_fingerprint) ||
    !Number.isSafeInteger(record.contrast_pairs_count) || (record.contrast_pairs_count as number) < 0 || (record.contrast_pairs_count as number) > 12 ||
    typeof record.requested_model !== 'string' || !record.requested_model.trim() || typeof record.model !== 'string' || !record.model.trim() ||
    (record.response_id !== null && typeof record.response_id !== 'string') || !Array.isArray(record.ratings_snapshot)) throw new Error('Invalid saved profile metadata.');
  if (record.reviews_snapshot !== undefined && (!Array.isArray(record.reviews_snapshot) ||
    record.reviews_snapshot.some(row => !row || Object.keys(row).length !== 2 || !positiveInteger(row.movie_id) || typeof row.hash !== 'string' || !/^[a-f0-9]{64}$/.test(row.hash)) ||
    new Set(record.reviews_snapshot.map(row => row.movie_id)).size !== record.reviews_snapshot.length)) throw new Error('Invalid saved reviews snapshot.');
  const snapshot = record.ratings_snapshot as Evidence[];
  if (snapshot.length !== record.ratings_count || new Set(snapshot.map(row => row?.movie_id)).size !== snapshot.length || snapshot.some(row => !row || Object.keys(row).length !== 2 ||
    !positiveInteger(row.movie_id) || !Number.isSafeInteger(row.rating_100) || row.rating_100 < 0 || row.rating_100 > 100)) throw new Error('Invalid saved ratings snapshot.');
  const numericBody=Object.fromEntries(bodyFields.map(key=>[key,record[key]]));
  if(record.schema_version===2){
    if(!Array.isArray(record.historical_snapshot)||record.historical_snapshot.some(e=>!e||Object.keys(e).length!==3||!positiveInteger(e.movie_id)||e.kind!=='historical'||!['liked','disliked','mixed'].includes(e.sentiment))||new Set(record.historical_snapshot.map(e=>e.movie_id)).size!==record.historical_snapshot.length)throw Error('Invalid historical snapshot');
    validateHistoricalProfile({...numericBody,historical_patterns:record.historical_patterns},snapshot,record.historical_snapshot as HistoricalEvidence[],Number(record.contrast_pairs_count)>0);
  }else {if(record.historical_snapshot!==undefined||record.historical_patterns!==undefined||!snapshot.length)throw Error('Invalid legacy profile');validateProfile(numericBody,snapshot,Number(record.contrast_pairs_count)>0);}
  parseUsage(record.usage);
  return value as StoredProfile;
}
export function readTasteProfile(database: Database.Database, userId: UserId): StoredProfile | null {
  personalScope(database, userId);
  const raw = rawProfile(database, userId); return raw === null ? null : parseStoredProfile(raw);
}
export function acquireTasteLock(database: Database.Database, userId: UserId) {
  personalScope(database, userId);
  const path = `${resolve(database.name)}.taste.lock`;
  let fd: number;
  try { fd = openSync(path, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`Taste generation is locked: ${path}. Check the owner PID in that file; only remove a stale lock after verifying the process has exited.`);
    throw new Error('Cannot create the taste generation lock.');
  }
  try { writeFileSync(fd, JSON.stringify({ user_id: userId, pid: process.pid, created_at: new Date().toISOString() })); }
  catch { closeSync(fd); unlinkSync(path); throw new Error('Cannot write taste generation lock.'); }
  const owned = fstatSync(fd);
  return () => {
    try { const current = statSync(path); if (current.ino === owned.ino && current.dev === owned.dev) unlinkSync(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    finally { closeSync(fd); }
  };
}
function cacheStatus(saved: StoredProfile | null, context: TasteContext) {
  return saved === null ? 'missing' : saved.context_fingerprint === context.fingerprint && saved.prompt_version === PROMPT_VERSION ? 'current' : 'stale';
}
function savedOrNull(database: Database.Database, userId: UserId, force: boolean) {
  personalScope(database, userId);
  try { return readTasteProfile(database, userId); }
  catch (error) { if (!force) throw error; return null; }
}
type Options = { live?: boolean; force?: boolean; apiKey?: string; model?: string; backupPath?: string; fetch?: typeof fetch; timeoutMs?: number };
export async function generateTasteProfile(database: Database.Database, userId: UserId, options: Options = {}) {
  personalScope(database, userId);
  if (options.force && !options.live) throw new Error('--force requires --live.');
  let saved = savedOrNull(database, userId, Boolean(options.force));
  const ratedCount = (database.prepare('SELECT count(*) n FROM user_movies WHERE user_id=@userId AND rating_100 IS NOT NULL').get({userId}) as { n: number }).n;
  if (ratedCount === 0 && !historicalEvidence(database,userId).length && saved && !options.force) {
    return { mode: options.live ? 'cached' : 'dry-run', cache: 'stale', profile_version: saved.profile_version,
      ratings_count: options.live ? saved.ratings_count : 0, notice: 'No currently rated works. Previous profile retained; no API call made.' };
  }
  let context = buildTasteContext(database, userId);
  if (!options.live) return { mode: 'dry-run', ...context.summary, cache: cacheStatus(saved, context) };
  if (saved && !options.force) return { mode: 'cached', cache: cacheStatus(saved, context), profile_version: saved.profile_version,
    ratings_count: saved.ratings_count, notice: 'No API call made. Regeneration requires --live --force.' };
  requireOpenAIConfig(options.apiKey, options.model);
  if (!options.backupPath) throw new Error('A SQLite backup path is required for live generation.');
  const release = acquireTasteLock(database, userId);
  try {
    // A different process may have completed while we were preparing the first snapshot.
    context = buildTasteContext(database, userId); saved = savedOrNull(database, userId, Boolean(options.force));
    if (saved && !options.force) return { mode: 'cached', cache: cacheStatus(saved, context), profile_version: saved.profile_version,
      ratings_count: saved.ratings_count, notice: 'No API call made. Regeneration requires --live --force.' };
    const priorRaw = rawProfile(database, userId);
    await database.backup(options.backupPath);
    const result = await requestTasteProfile(context, options);
    const body = context.historicalSnapshot.length?validateHistoricalProfile(result.body,context.snapshot,context.historicalSnapshot,context.context.contrast_pairs.length>0):validateProfile(result.body, context.snapshot, context.context.contrast_pairs.length > 0);
    const profile = database.transaction(() => {
      if (buildTasteContext(database, userId).fingerprint !== context.fingerprint || JSON.stringify(reviewSnapshot(readReviewTexts(database, userId))) !== JSON.stringify(context.reviewsSnapshot)) throw new Error('Ratings, reviews or analysis context changed during generation. Previous profile retained; no automatic retry.');
      if (rawProfile(database, userId) !== priorRaw) throw new Error('Saved profile changed during generation. Previous profile retained.');
      let version = saved?.profile_version ?? 0;
      if (!saved && priorRaw) {
        try { const previous = JSON.parse(priorRaw) as Record<string, unknown>; if (previous && positiveInteger(previous.profile_version)) version = previous.profile_version as number; }
        catch { /* A corrupted profile has no trustworthy version. */ }
      }
      if (!Number.isSafeInteger(version + 1)) throw new Error('Profile version overflow.');
      const profile: StoredProfile = { ...body, profile_version: version + 1, generated_at: new Date().toISOString(), ratings_count: context.snapshot.length,
        ratings_snapshot: context.snapshot, reviews_snapshot: context.reviewsSnapshot, context_fingerprint: context.fingerprint, prompt_version: PROMPT_VERSION, schema_version: context.historicalSnapshot.length?2:PROFILE_SCHEMA_VERSION, ...(context.historicalSnapshot.length?{historical_snapshot:context.historicalSnapshot}:{}),
        contrast_pairs_count: context.context.contrast_pairs.length, requested_model: options.model!.trim(), model: result.model,
        response_id: result.response_id, usage: result.usage };
      database.prepare('INSERT INTO taste_profile (user_id,profile_json) VALUES (@userId,?) ON CONFLICT(user_id) DO UPDATE SET profile_json=excluded.profile_json').run({userId}, JSON.stringify(profile));
      return profile;
    }).immediate();
    return { mode: 'generated', profile_version: profile.profile_version, ratings_count: profile.ratings_count, model: profile.model, usage: profile.usage };
  } finally { release(); }
}
export function displayTasteProfile(database: Database.Database, userId: UserId) {
  personalScope(database, userId);
  const saved = readTasteProfile(database, userId);
  if (!saved) return 'No saved taste profile. Generate one explicitly with taste:generate -- --live.';
  const current = database.prepare('SELECT m.id,m.title,m.release_year,u.rating_100 FROM movies m LEFT JOIN user_movies u ON u.movie_id=m.id AND u.user_id=@userId').all({userId}) as
    { id: number; title: string; release_year: number | null; rating_100: number | null }[];
  const byId = new Map(current.map(row => [row.id, row]));
  const snapshot = current.filter(row => row.rating_100 !== null).map(row => ({ movie_id: row.id, rating_100: row.rating_100! })).sort((a, b) => a.movie_id - b.movie_id);
  let cache = 'stale';
  if (snapshot.length) cache = cacheStatus(saved, buildTasteContext(database, userId));
  const lines = [`Taste profile v${saved.profile_version} (${cache}), ${saved.generated_at}`, `Model: ${saved.model}; rated works at generation: ${saved.ratings_count}`];
  const ref = (evidence: Evidence) => {
    const movie = byId.get(evidence.movie_id);
    const name = movie ? `${movie.title} (${movie.release_year ?? 'unknown year'})` : `Unavailable local movie #${evidence.movie_id}`;
    const changed = movie?.rating_100 !== evidence.rating_100 ? `; current: ${movie?.rating_100 ?? 'unrated/unavailable'}` : '';
    return `${name} [#${evidence.movie_id}, at generation: ${evidence.rating_100}/100${changed}]`;
  };
  for (const [name, patterns] of [['Strong preferences', saved.strong_preferences], ['Negative patterns', saved.negative_patterns]] as const) {
    lines.push(`\n${name}`);
    for (const pattern of patterns) lines.push(`${pattern.summary} (${pattern.kind})`, pattern.explanation, `Uncertainty: ${pattern.uncertainty}`, ...pattern.evidence.map(ref));
  }
  lines.push('\nContrasts');
  for (const pair of saved.contrasts) lines.push(`${ref(pair.higher)} vs ${ref(pair.lower)}`, `Similarity: ${pair.similarity}`, `Possible difference: ${pair.possible_difference}`, `Uncertainty: ${pair.uncertainty}`);
  lines.push('\nUncertainties');
  for (const uncertainty of saved.uncertainties) lines.push(uncertainty.description, ...uncertainty.evidence.map(ref));
  if(saved.historical_patterns){const active=new Map(historicalEvidence(database,userId).map(e=>[e.movie_id,e.sentiment]));lines.push('\nHistorical observations');for(const p of saved.historical_patterns)lines.push(p.summary,p.explanation,`Uncertainty: ${p.uncertainty}`,...p.evidence.map(e=>`${byId.get(e.movie_id)?.title??'Unavailable'} [#${e.movie_id}, historical: ${e.sentiment}${active.get(e.movie_id)===e.sentiment?'':'; replaced or unavailable'}]`));}
  return lines.join('\n');
}
