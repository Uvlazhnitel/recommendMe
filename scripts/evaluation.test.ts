import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { fixture, movie, choice, config, mockProvider, report } from './fixtures/recommendation-screen';
import { stageEvaluation, ALGORITHM_ID } from '../src/lib/evaluation-metadata';
import { evaluationReport, evaluationPeriod, formatEvaluationReport } from '../src/lib/evaluation-report';
import { recordRecommendations } from '../src/lib/recommendation-memory';
import { confirmMovieWatch } from '../src/lib/movie-watch';
import { updateLibraryRating } from '../src/lib/library';
import { updateMovieReview } from '../src/lib/movie-review';
import { parseUsage } from '../src/lib/openai';
import { migrateDatabase } from '../src/lib/migrations';
import { generateRecommendationBatch } from '../src/lib/recommendation-service';
import { runStore } from '../src/lib/recommendation-runs';
import { backupDatabase, restoreBackup, verifyBackup } from './container-db.mjs';

const profile = { profile_version: 1, profile_prompt_version: 1, profile_schema_version: 1 };
const usage = { input_tokens: 100, output_tokens: 20, total_tokens: 120, input_tokens_details: { cached_tokens: 40, other_tokens: 3 }, output_tokens_details: { reasoning_tokens: 5 } };
function metadata(algorithm = ALGORITHM_ID, p = 1) {
  return { ...stageEvaluation([{ role: 'system', content: 'Synthetic prompt' }], {}, { ...profile, profile_version: p }), algorithm_id: algorithm, usage, model: 'synthetic-model' };
}
function save(f: ReturnType<typeof fixture>, ids = [201], version: string | null = ALGORITHM_ID, now = Date.parse('2020-01-01'), key = randomUUID()) {
  const candidates = { ...report(ids), ...(version ? { evaluation: metadata(version) } : {}) };
  const result = { mode: 'live', status: 'ok', result_id: key, generated_at: new Date(now).toISOString(), recommendations: ids.map(choice), ...(version ? { evaluation: metadata(version, 2) } : {}) };
  const saved = recordRecommendations(f.db, 'ilya', candidates, { result }, { dryRun: false, now });
  return { candidates, result, saved, key };
}
const count = (f: ReturnType<typeof fixture>, table: string) => (f.db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n;

test('1/3: frozen algorithm/release and distinct stage profiles/models survive report-time release changes', () => {
  const f = fixture(), previous = process.env.APP_GIT_SHA;
  try {
    process.env.APP_GIT_SHA = 'a'.repeat(40); const saved = save(f);
    process.env.APP_GIT_SHA = 'b'.repeat(40);
    const row = f.db.prepare('SELECT metadata_json FROM recommendation_evaluation WHERE result_id=?').get(saved.key) as { metadata_json: string };
    const stored = JSON.parse(row.metadata_json);
    assert.equal(stored.algorithm_id, ALGORITHM_ID); assert.equal(stored.candidates.git_sha, 'a'.repeat(40));
    assert.equal(stored.candidates.profile_version, 1); assert.equal(stored.ranking.profile_version, 2);
    assert.equal(stored.candidates.prompt_sha256.length, 64); assert.equal(stored.ranking.format_sha256.length, 64);
    assert.deepEqual(evaluationReport(f.db, 'ilya').algorithms[0].profile_versions, [1, 2]);
  } finally { if (previous === undefined) delete process.env.APP_GIT_SHA; else process.env.APP_GIT_SHA = previous; f.cleanup(); }
});

for (const version of [3, 4, 5, 6]) test(`2/3/16: historical rows after explicit schema ${version}→8 preparation remain unknown and readonly`, () => {
  const f = fixture(version);
  try {
    f.db.exec(version >= 4 ? "INSERT INTO recommendations(user_id,movie_id,result_id,why_fit,possible_mismatch) VALUES('ilya',1,'legacy:test','Fit','Risk')" : "INSERT INTO recommendations(user_id,movie_id,why_fit,possible_mismatch) VALUES('ilya',1,'Fit','Risk')");
    const before = readFileSync(f.path); f.db.pragma('query_only=ON');
    const r = evaluationReport(f.db, 'ilya'); assert.equal(r.total.observed, 0); assert.equal(r.total.hit_rate_80.percent, null); assert.equal(r.total.status, 'insufficient_data');
    if (version >= 4) { assert.equal(r.algorithms[0].algorithm_id, 'unknown'); assert.equal(r.total.tokens.input_tokens.known_tokens, null); }
    else assert.equal(r.unidentified_recommendations, 1);
    assert.deepEqual(readFileSync(f.path), before); assert.equal(f.db.pragma('user_version', { simple: true }), 8);
  } finally { f.cleanup(); }
});

test('4: replay keeps one immutable metadata row, old results never acquire current metadata', () => {
  const f = fixture();
  try {
    const s = save(f), before = f.db.prepare('SELECT * FROM recommendation_evaluation').all();
    const replay = recordRecommendations(f.db, 'ilya', s.candidates, { result: { ...s.result, evaluation: metadata('different') } }, { dryRun: false });
    assert.equal(replay.status, 'already_saved'); assert.deepEqual(f.db.prepare('SELECT * FROM recommendation_evaluation').all(), before);
    f.db.exec('DELETE FROM recommendation_evaluation');
    recordRecommendations(f.db, 'ilya', s.candidates, { result: s.result }, { dryRun: false });
    assert.equal(count(f, 'recommendation_evaluation'), 0); assert.equal(evaluationReport(f.db, 'ilya').algorithms[0].algorithm_id, 'unknown');
  } finally { f.cleanup(); }
});

test('5: evaluation write failure rolls back recommendations and newly added movies atomically', () => {
  const f = fixture();
  try {
    f.db.exec("CREATE TRIGGER fail_eval BEFORE INSERT ON recommendation_evaluation BEGIN SELECT RAISE(ABORT,'Synthetic failure'); END");
    assert.throws(() => save(f), /Synthetic failure/);
    assert.equal(count(f, 'recommendations'), 0); assert.equal(count(f, 'recommendation_evaluation'), 0); assert.equal(count(f, 'movies'), 3);
  } finally { f.cleanup(); }
});

test('6/7: actual usage details are preserved; missing fields remain unknown and subsets are not added twice', () => {
  const f = fixture();
  try {
    assert.equal(parseUsage(undefined), null); assert.deepEqual(parseUsage({}), { input_tokens: null, output_tokens: null });
    assert.deepEqual(parseUsage(usage), usage); assert.throws(() => parseUsage({ input_tokens: -1 }));
    save(f); let r = evaluationReport(f.db, 'ilya').total.tokens;
    assert.equal(r.input_tokens.known_tokens, 200); assert.equal(r.output_tokens.known_tokens, 40);
    assert.equal(r.cached_input_tokens.known_tokens, 80); assert.equal(r.reasoning_tokens.known_tokens, 10); assert.equal(r.total_tokens.known_tokens, 240);
    const raw = JSON.parse((f.db.prepare('SELECT metadata_json FROM recommendation_evaluation').get() as { metadata_json: string }).metadata_json);
    raw.ranking.usage = null; f.db.prepare('UPDATE recommendation_evaluation SET metadata_json=?').run(JSON.stringify(raw));
    r = evaluationReport(f.db, 'ilya').total.tokens;
    assert.equal(r.input_tokens.known_tokens, 100); assert.equal(r.input_tokens.known_stages, 1); assert.equal(r.input_tokens.complete_batches, 0); assert.equal(r.input_tokens.mean_per_complete_batch, null);
  } finally { f.cleanup(); }
});

test('9/10/12/15/17: post-watch scores 0/NULL/70/80/100 yield hand-checkable metrics; edits and clears use current ratings', async () => {
  const f = fixture();
  try {
    save(f, [201, 202, 203, 204, 205]);
    for (const [i, rating] of [0, null, 70, 80, 100].entries()) await confirmMovieWatch(f.db, 'ilya', { movie_id: 4 + i, watched: true, rating_100: rating });
    let r = evaluationReport(f.db, 'ilya').total;
    assert.equal(r.observed, 4); assert.equal(r.unobserved, 1); assert.deepEqual(r.hit_rate_80, { numerator: 2, denominator: 4, percent: 50 });
    assert.equal(r.mean_rating, 62.5); assert.equal(r.median_rating, 75); assert.deepEqual([r.high, r.middle, r.low], [2, 1, 1]);
    await updateLibraryRating(f.db, 'ilya', 4, 90); r = evaluationReport(f.db, 'ilya').total; assert.equal(r.hit_rate_80.numerator, 3);
    await updateLibraryRating(f.db, 'ilya', 4, null); r = evaluationReport(f.db, 'ilya').total; assert.equal(r.observed, 3); assert.equal(r.unobserved, 2);
    await updateLibraryRating(f.db, 'ilya', 5, 0); assert.equal(evaluationReport(f.db, 'ilya').total.observed, 4);
  } finally { f.cleanup(); }
});

test('11/13/19: old watches/ratings and review edits never manufacture a post-recommendation result', async () => {
  const f = fixture();
  try {
    f.db.exec("INSERT INTO recommendations(user_id,movie_id,result_id,why_fit,possible_mismatch) VALUES('ilya',1,'legacy:prior','Fit','Risk'),('ilya',3,'legacy:unrated','Fit','Risk')");
    await updateMovieReview(f.db, 'ilya', 1, 'An observation'); await updateLibraryRating(f.db, 'ilya', 1, 90); await updateLibraryRating(f.db, 'ilya', 3, 80);
    await confirmMovieWatch(f.db, 'ilya', { movie_id: 1, watched: true });
    assert.equal(count(f, 'recommendation_outcomes'), 0); assert.equal(evaluationReport(f.db, 'ilya').total.observed, 0);
    // Imports/direct SQL do not create evidence of event order.
    f.db.exec('UPDATE user_movies SET rating_100=100');
    f.db.transaction(() => {
      const film = f.db.prepare('INSERT INTO movies(id,title) VALUES(?,?)');
      const rating = f.db.prepare("INSERT INTO user_movies(user_id,movie_id,watched,rating_100,rating_source) VALUES('ilya',?,1,100,'letterboxd')");
      for (let id = 1000; id < 1519; id++) { film.run(id, `Imported synthetic ${id}`); rating.run(id); }
    })();
    assert.equal(evaluationReport(f.db, 'ilya').total.observed, 0); assert.equal(count(f, 'recommendation_outcomes'), 0);
  } finally { f.cleanup(); }
});

test('14: last saved recommendation wins once even with identical timestamps; period filtering never reassigns it', async () => {
  const f = fixture();
  try {
    const a = save(f, [201], 'older');
    const b = save(f, [201], 'newer', Date.parse('2021-01-01'));
    f.db.exec("UPDATE recommendations SET recommended_at='2020-01-01T00:00:00.000Z'");
    f.db.prepare('UPDATE recommendation_evaluation SET saved_at=? WHERE result_id=?').run('2020-01-01T00:00:00.000Z', a.key);
    f.db.prepare('UPDATE recommendation_evaluation SET saved_at=? WHERE result_id=?').run('2021-01-01T00:00:00.000Z', b.key);
    await confirmMovieWatch(f.db, 'ilya', { movie_id: 4, watched: true }); await updateLibraryRating(f.db, 'ilya', 4, 85);
    const r = evaluationReport(f.db, 'ilya'); assert.equal(r.total.recommendations, 2); assert.equal(r.total.observed, 1);
    assert.equal(r.algorithms.find(g => g.algorithm_id === 'older')!.observed, 0); assert.equal(r.algorithms.find(g => g.algorithm_id === 'newer')!.observed, 1);
    assert.equal(evaluationReport(f.db, 'ilya', { to: '2020-12-31' }).total.observed, 0);
    const event = f.db.prepare('SELECT * FROM recommendation_outcomes').all();
    await updateMovieReview(f.db, 'ilya', 4, 'Changed'); await confirmMovieWatch(f.db, 'ilya', { movie_id: 4, watched: true });
    assert.deepEqual(f.db.prepare('SELECT * FROM recommendation_outcomes').all(), event);
  } finally { f.cleanup(); }
});

test('15/16/18: unwatched is unknown; empty and multi-version reports have only real groups', () => {
  const f = fixture();
  try {
    assert.deepEqual(evaluationReport(f.db, 'ilya').algorithms, []); assert.equal(evaluationReport(f.db, 'ilya').total.status, 'insufficient_data');
    save(f, [201], 'one'); save(f, [202], 'two'); save(f, [203], null);
    const r = evaluationReport(f.db, 'ilya'); assert.deepEqual(r.algorithms.map(g => g.algorithm_id), ['one', 'two', 'unknown']);
    assert.equal(r.total.observed, 0); assert.equal(r.total.low, 0); assert.equal(r.total.unobserved, 3);
    assert.match(formatEvaluationReport(r), /Недостаточно наблюдаемых/);
  } finally { f.cleanup(); }
});

test('8/20: two mocked calls with real usage, concurrent lock, failed save, recovery and replay do not duplicate costs or metadata', async () => {
  const f = fixture(), h = mockProvider([201, 202]), key = randomUUID();
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const r = await h.fetch(input, init);
    if (String(input).includes('api.openai.com')) { const b = await r.json(); b.usage = usage;
      b.model = JSON.parse(String(init?.body)).text.format.name === 'movie_candidates' ? 'actual-candidates' : 'actual-ranking'; return Response.json(b); }
    return r;
  };
  try {
    f.db.exec("CREATE TRIGGER fail_eval BEFORE INSERT ON recommendation_evaluation BEGIN SELECT RAISE(ABORT,'Synthetic failure'); END");
    const deps = { open: f.open, config, fetch, sleep: async () => {} };
    const release = runStore(f.path, 'ilya').acquire(randomUUID());
    await assert.rejects(() => generateRecommendationBatch('ilya', key, deps), /generation_busy/); release(); assert.equal(h.bodies.length, 0);
    await assert.rejects(() => generateRecommendationBatch('ilya', key, deps), /save_failed/);
    assert.equal(count(f, 'recommendations'), 0); assert.equal(count(f, 'recommendation_evaluation'), 0); assert.equal(h.bodies.length, 2);
    const prepared = runStore(f.path, 'ilya').read(key)!.ranking;
    const stages = runStore(f.path, 'ilya').read(key)!;
    assert.equal(stages.candidates?.mode, 'live');
    if (stages.candidates?.mode === 'live') {
      assert.deepEqual(Object.keys(stages.candidates.evaluation).sort(), ['algorithm_id', 'candidate_selection', 'git_sha', 'profile_version', 'profile_prompt_version', 'profile_schema_version', 'prompt_sha256', 'format_sha256', 'model', 'usage'].sort());
    }
    f.db.exec('DROP TRIGGER fail_eval'); await generateRecommendationBatch('ilya', key, deps, { saveOnly: true });
    await generateRecommendationBatch('ilya', key, deps, { saveOnly: true });
    assert.equal(h.bodies.length, 2); assert.equal(count(f, 'recommendation_evaluation'), 1);
    assert.deepEqual(runStore(f.path, 'ilya').read(key)!.ranking, prepared);
    assert.equal(evaluationReport(f.db, 'ilya').total.tokens.input_tokens.known_tokens, 200);
    const stored = JSON.parse((f.db.prepare('SELECT metadata_json FROM recommendation_evaluation').get() as { metadata_json: string }).metadata_json);
    assert.equal(stored.candidates.model, 'actual-candidates'); assert.equal(stored.ranking.model, 'actual-ranking'); assert.equal(stored.totals.total_tokens, 240);
    console.log('EVALUATION_MOCK_CALLS', JSON.stringify({ openai: h.bodies.length, tmdb: h.calls.filter(c => c.startsWith('api.themoviedb.org')).length }));
  } finally { f.cleanup(); }
});

test('legacy journal usage recovers only an unambiguous saved result; version stays unknown', () => {
  const f = fixture();
  try {
    const s = save(f, [201], null); f.db.exec('DELETE FROM recommendation_evaluation');
    const candidates = { mode: 'live', status: 'ok', candidates: [movie()], statistics: { model: 'legacy-model', usage: { input_tokens: 10, output_tokens: 2 } } };
    const ranking = { ...s.result, statistics: { model: 'legacy-model', usage: { input_tokens: 20, output_tokens: 3 } } };
    const run = { user_id: 'ilya' as const, request_id: randomUUID(), started_at: new Date().toISOString(), stage: 'saved' as const, candidates, ranking };
    // A journal may predate current TypeScript report fields.
    runStore(f.path, 'ilya').write(run as unknown as Parameters<ReturnType<typeof runStore>['write']>[0]);
    let r = evaluationReport(f.db, 'ilya'); assert.equal(r.algorithms[0].algorithm_id, 'unknown'); assert.equal(r.total.tokens.input_tokens.known_tokens, 30);
    runStore(f.path, 'ilya').write({ ...run, request_id: randomUUID() } as unknown as Parameters<ReturnType<typeof runStore>['write']>[0]);
    r = evaluationReport(f.db, 'ilya'); assert.equal(r.total.tokens.input_tokens.known_tokens, null);
  } finally { f.cleanup(); }
});

test('migration 6→7 is explicit, repeatable, preserves data and backup/restore includes both evaluation tables', async () => {
  const f = fixture(6);
  try {
    const before = f.db.prepare('SELECT * FROM user_movies').all();
    migrateDatabase(f.db); const bytes = readFileSync(f.path); migrateDatabase(f.db); assert.deepEqual(readFileSync(f.path), bytes);
    assert.deepEqual(f.db.prepare('SELECT * FROM user_movies').all(), before);
    save(f); await confirmMovieWatch(f.db, 'ilya', { movie_id: 4, watched: true, rating_100: 80 });
    const snapshot = await backupDatabase(f.path, join(f.dir, 'backups'));
    assert.equal(verifyBackup(snapshot).counts.recommendation_evaluation, 1); assert.equal(verifyBackup(snapshot).counts.recommendation_outcomes, 1);
    f.db.close(); renameSync(f.path, join(f.dir, 'original.sqlite'));
    const target = join(f.dir, 'restored', 'movies.sqlite');
    restoreBackup(snapshot, target, { relocateFrom: verifyBackup(snapshot).canonical_database });
    const db = new Database(target, { readonly: true });
    try { assert.equal(evaluationReport(db, 'ilya').total.observed, 1); } finally { db.close(); }
  } finally { f.cleanup(); }
});

for (const kind of ['empty', 'historical', 'versions', 'observed']) test(`CLI offline/read-only smoke: ${kind}`, async () => {
  const f = fixture(kind === 'historical' ? 6 : 7);
  try {
    if (kind === 'historical') f.db.exec("INSERT INTO recommendations(user_id,movie_id,result_id,why_fit,possible_mismatch) VALUES('ilya',1,'legacy:old','Fit','Risk')");
    if (kind === 'versions' || kind === 'observed') { save(f, [201], 'one'); save(f, [202], 'two'); }
    if (kind === 'observed') await confirmMovieWatch(f.db, 'ilya', { movie_id: 4, watched: true, rating_100: 90 });
    const before = readFileSync(f.path);
    for (const json of [false, true]) {
      const r = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/evaluation-report.ts','--user','ilya', ...(json ? ['--json'] : [])], { env: { ...process.env, DATABASE_PATH: f.path, OPENAI_API_KEY: '', TMDB_API_KEY: '' }, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr); if (json) assert.equal(JSON.parse(r.stdout).total.observed, kind === 'observed' ? 1 : 0); else assert.match(r.stdout, /recommendMe Evaluation/);
    }
    assert.deepEqual(readFileSync(f.path), before);
    if (kind === 'observed') console.log('SYNTHETIC_EVALUATION_EXAMPLE\n' + formatEvaluationReport(evaluationReport(f.db, 'ilya')));
  } finally { f.cleanup(); }
});

test('period validation rejects invalid dates and includes the final UTC day', () => {
  assert.throws(() => evaluationPeriod({ from: '' }));
  assert.throws(() => evaluationPeriod({ from: '2026-02-30' })); assert.throws(() => evaluationPeriod({ from: '2026-02-02', to: '2026-02-01' }));
  const p = evaluationPeriod({ from: '2026-01-01', to: '2026-01-01' }); assert.equal(p.to - p.from, 86400000);
});

for (const partial of [false, true]) test(`successful mocked generation with ${partial ? 'partial' : 'absent'} usage does not invent zero totals`, async () => {
  const f = fixture(), h = mockProvider([201]);
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const response = await h.fetch(input, init);
    if (!String(input).includes('api.openai.com')) return response;
    const body = await response.json(); if (partial) body.usage = { input_tokens: 30 }; else delete body.usage;
    return Response.json(body);
  };
  try {
    await generateRecommendationBatch('ilya', randomUUID(), { open: f.open, config, fetch, sleep: async () => {} });
    const r = evaluationReport(f.db, 'ilya').total.tokens;
    assert.equal(r.input_tokens.known_tokens, partial ? 60 : null); assert.equal(r.output_tokens.known_tokens, null);
    assert.equal(r.total_tokens.known_tokens, null); assert.equal(r.cached_input_tokens.known_tokens, null);
    const stored = JSON.parse((f.db.prepare('SELECT metadata_json FROM recommendation_evaluation').get() as { metadata_json: string }).metadata_json);
    assert.equal(stored.totals.total_tokens, null); assert.equal(h.bodies.length, 2);
  } finally { f.cleanup(); }
});

test('a score present before the observed watch is never relabelled as a subsequent rating, including zero', async () => {
  const f = fixture();
  try {
    save(f); f.db.exec("INSERT INTO user_movies(user_id,movie_id,watched,rating_100,rating_source) VALUES('ilya',4,0,0,'manual')");
    await confirmMovieWatch(f.db, 'ilya', { movie_id: 4, watched: true });
    assert.equal(count(f, 'recommendation_outcomes'), 0); assert.equal(evaluationReport(f.db, 'ilya').total.observed, 0);
    await updateLibraryRating(f.db, 'ilya', 4, 90); assert.equal(evaluationReport(f.db, 'ilya').total.observed, 0);
  } finally { f.cleanup(); }
});

test('known technical usage on a failed ranking stays in the journal, outside successful batch totals', async () => {
  const f = fixture(), key = randomUUID();
  const h = mockProvider([201], (url, init) => url.hostname === 'api.openai.com' && JSON.parse(String(init?.body)).text.format.name === 'personal_movie_ranking'
    ? Response.json({ status: 'completed', model: 'actual-model', usage, output: [{ type: 'message', content: [{ type: 'output_text', text: '{"recommendations":[]}' }] }] }) : undefined);
  try {
    await assert.rejects(() => generateRecommendationBatch('ilya', key, { open: f.open, config, fetch: h.fetch, sleep: async () => {} }), /ranking_failed/);
    const run = runStore(f.path, 'ilya').read(key)!;
    assert.equal(run.stage, 'failed'); assert.equal((run.technical_usage?.ranking as { usage: typeof usage }).usage.input_tokens, 100);
    assert.equal(evaluationReport(f.db, 'ilya').total.batches, 0); assert.equal(evaluationReport(f.db, 'ilya').total.tokens.input_tokens.known_tokens, null);
    assert.equal(count(f, 'recommendation_evaluation'), 0);
  } finally { f.cleanup(); }
});

test('manual and unidentified rows are separate from AI quality; dry-run creates no metadata', () => {
  const f = fixture();
  try {
    const preview = recordRecommendations(f.db, 'ilya', report(), { tmdbIds: [201] }); assert.equal(preview.status, 'preview');
    assert.equal(count(f, 'recommendation_evaluation'), 0);
    recordRecommendations(f.db, 'ilya', report(), { tmdbIds: [201] }, { dryRun: false });
    f.db.exec('INSERT INTO recommendations(user_id,movie_id) VALUES(\'ilya\',1)');
    const r = evaluationReport(f.db, 'ilya'); assert.equal(r.total.recommendations, 0); assert.equal(r.manual_recommendations, 1); assert.equal(r.unidentified_recommendations, 1);
  } finally { f.cleanup(); }
});

test('absent/malformed release SHA is unknown, without guessing from the local branch', () => {
  const previous = process.env.APP_GIT_SHA;
  try {
    for (const value of ['', '64a888f', 'not-a-sha']) { process.env.APP_GIT_SHA = value; assert.equal(stageEvaluation([], {}, profile).git_sha, 'unknown'); }
  } finally { if (previous === undefined) delete process.env.APP_GIT_SHA; else process.env.APP_GIT_SHA = previous; }
});
