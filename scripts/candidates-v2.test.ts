import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fixture, movie, config, mockProvider } from './fixtures/recommendation-screen';
import { candidatesFixture } from './fixtures/candidates-v2';
import { contextFixture, contextScenarios } from './fixtures/taste-context-v2';
import { buildCandidateContext, readCandidateHistory, seedRotation, CANDIDATE_FORMAT, CANDIDATE_LIMITS, prepareTasteInputs, type HistoryRow } from '../src/lib/candidate-context';
import { selectSeeds, selectVerifiedCandidates } from '../src/lib/candidate-selection';
import { buildRankingContext } from '../src/lib/recommendation-context';
import { generateCandidates, type MovieCandidate } from '../src/lib/candidates';
import { generateRecommendationBatch } from '../src/lib/recommendation-service';
import { runStore } from '../src/lib/recommendation-runs';
import { recordRecommendations } from '../src/lib/recommendation-memory';
import { parseCandidateReport, rankingFormat } from '../src/lib/recommendation-schema';
import type { ProfileBody } from '../src/lib/taste-schema';

const baseline = JSON.parse(readFileSync(new URL('./fixtures/candidates-v2-baseline.json', import.meta.url), 'utf8'));
const empty: ProfileBody = { strong_preferences: [], negative_patterns: [], contrasts: [], uncertainties: [] };
const metadata = (ids: number[]) => ids.map(id => ({ id, name: `Metadata ${id}` }));
const history = (id: number, patch: Partial<HistoryRow> = {}): HistoryRow => ({ id, title: `History ${id}`, release_year: 2000, tmdb_id: id + 10000,
  tmdb_title: null, original_title: null, overview: 'Confirmed plot.', tmdb_release_year: null, media_type: 'movie', runtime_minutes: 100,
  genres_json: JSON.stringify(metadata([id, id + 100])), directors_json: JSON.stringify(metadata([id])), watched: 1, not_interested: 0, rating_100: 100,
  last_recommended_at: null, ...patch });
const candidate = (id: number, patch: Partial<MovieCandidate> = {}): MovieCandidate => ({ ...movie(id), genres: metadata([id, id + 100]), directors: metadata([id]), ...patch });
const seedIds = (rows: ReturnType<typeof selectSeeds>) => rows.map(row => row.movie_id);
const ids = (rows: MovieCandidate[]) => rows.map(row => row.tmdb_id);
const selection = (rows: MovieCandidate[], past: HistoryRow[] = []) => selectVerifiedCandidates(rows, past);
const savedBatch = (f: ReturnType<typeof fixture>, id: string | null, why: string | null = 'Confirmed explanation.', mismatch: string | null = 'Known uncertainty.') => {
  f.db.prepare('INSERT INTO recommendations(movie_id,result_id,why_fit,possible_mismatch) VALUES(1,?,?,?)').run(id, why, mismatch);
};
const serialized = (input: unknown, format: unknown) => JSON.stringify({ input, text: { format } });
const measure = (input: unknown, format: unknown) => {
  const s = serialized(input, format); return { bytes: Buffer.byteLength(s), sha256: createHash('sha256').update(s).digest('hex') };
};
const wireBytes = (input: unknown, format: unknown) => Buffer.byteLength(JSON.stringify({ model: 'mock-model', input, text: { format }, store: false, max_output_tokens: 12000 }));
const wireOverhead = wireBytes([], {}) - Buffer.byteLength(serialized([], {}));

test('seeds 1: multiple high-rated directions expand coverage beyond a narrow old five', () => {
  const f = candidatesFixture();
  try {
    const c = buildCandidateContext(f.db);
    assert.deepEqual(seedIds(baseline.audit44.seeds), [10, 11, 12, 13, 14]);
    assert.deepEqual(seedIds(c.seeds), [1, 10, 14, 30, 31]);
    const byId = new Map(readCandidateHistory(f.db).map(row => [row.id, row]));
    assert.equal(new Set(c.seeds.map(row => byId.get(row.movie_id)!.genres_json)).size, 5);
  } finally { f.cleanup(); }
});

test('seeds 2: many animation favourites do not crowd out equally strong alternatives', () => {
  const past = Array.from({ length: 20 }, (_, i) => history(i + 1, { genres_json: JSON.stringify(metadata([16, 12])) }));
  past.push(history(100), history(101), history(102), history(103));
  const selected = selectSeeds(past, empty);
  assert.equal(selected.length, 5); assert.ok([100, 101, 102, 103].every(id => seedIds(selected).includes(id)));
});

test('seeds 3: a real single-genre taste stays eligible without invented genre quotas', () => {
  const past = Array.from({ length: 8 }, (_, i) => history(i + 1, { genres_json: JSON.stringify(metadata([16])) }));
  assert.equal(selectSeeds(past, empty).length, 5);
  assert.ok(selectSeeds(past, empty).every(row => past.find(other => other.id === row.movie_id)!.genres_json === past[0].genres_json));
});

test('seeds 4: director repetition resolves equal genre coverage; many directors give no bonus', () => {
  const past = [history(1), history(2, { genres_json: JSON.stringify(metadata([2, 102])), directors_json: JSON.stringify(metadata([1])) }),
    history(3, { genres_json: JSON.stringify(metadata([2, 102])), directors_json: JSON.stringify(metadata([3])) })];
  assert.deepEqual(seedIds(selectSeeds(past, empty)), [1, 3, 2]);
  assert.equal(selectSeeds([history(1), history(2, { directors_json: JSON.stringify(metadata([5, 6, 7])) })], empty)[0].movie_id, 1);
});

test('seeds 5: absent, zero or invalid TMDB IDs never become seeds; duplicate mapped IDs stay unique', () => {
  const past = [history(1, { tmdb_id: null }), history(2, { tmdb_id: 0 }), history(3), history(4, { tmdb_id: 10003 })];
  assert.deepEqual(seedIds(selectSeeds(past, empty)), [3]);
});

test('seeds 6: hidden, short, unknown runtime/type and absent usable metadata are excluded', () => {
  const past = [history(1, { not_interested: 1 }), history(2, { runtime_minutes: 59 }), history(3, { runtime_minutes: null }),
    history(4, { media_type: 'unknown' }), history(5, { genres_json: null, directors_json: null }),
    history(6, { runtime_minutes: 60 }), history(7, { genres_json: null }), history(8, { directors_json: null })];
  assert.deepEqual(new Set(seedIds(selectSeeds(past, empty))), new Set([6, 7, 8]));
  assert.throws(() => selectSeeds([history(9, { genres_json: '[{"id":-1,"name":"Invalid"}]' })], empty), /metadata/);
});

test('seeds 7: score zero remains real but NULL and middle scores cannot seed', () => {
  assert.deepEqual(seedIds(selectSeeds([history(1, { rating_100: 0 }), history(2, { rating_100: null }), history(3, { rating_100: 79 }), history(4, { rating_100: 80 })], empty)), [4]);
});
test('seeds 8: no eligible seeds yields an empty array', () => assert.deepEqual(selectSeeds([], empty), []));
test('seeds 9: fewer than five returns every eligible seed without duplicates', () => {
  assert.deepEqual(seedIds(selectSeeds([history(1), history(2)], empty)), [1, 2]);
});

test('seeds 10: only distinct saved batches with explanations advance rotation, including legacy results', () => {
  const f = fixture();
  try {
    const past = Array.from({ length: 8 }, (_, i) => history(i + 1, { genres_json: JSON.stringify(metadata([16])), directors_json: JSON.stringify(metadata([10])) }));
    assert.equal(seedRotation(f.db), 0);
    const first = selectSeeds(past, empty, seedRotation(f.db));
    const key = randomUUID(); savedBatch(f, key);
    const second = selectSeeds(past, empty, seedRotation(f.db));
    assert.notDeepEqual(new Set(seedIds(first)), new Set(seedIds(second)));
    f.db.prepare('INSERT INTO recommendations(movie_id,result_id,why_fit,possible_mismatch) VALUES(2,?,?,?)').run(key, 'Another explanation', 'Uncertain');
    assert.equal(seedRotation(f.db), 1);
    savedBatch(f, 'legacy:confirmed'); assert.equal(seedRotation(f.db), 2);
    savedBatch(f, 'manual:ids'); savedBatch(f, null); savedBatch(f, 'missing:why', null); savedBatch(f, 'blank:why', '  '); savedBatch(f, 'missing:mismatch', 'Yes', null);
    savedBatch(f, 'blank:unicode', '\t\n\u00a0'); savedBatch(f, 'blank:mismatch', 'Yes', '\t\n');
    assert.equal(seedRotation(f.db), 2);
    f.db.exec('UPDATE user_movies SET not_interested=1,watched=1'); assert.equal(seedRotation(f.db), 2);
  } finally { f.cleanup(); }
});

test('seeds 11: failed/unfinished journals and repeated dry-run preparation do not rotate or write', async () => {
  const f = fixture(), before = readFileSync(f.path);
  try {
    runStore(f.path).write({ request_id: randomUUID(), started_at: new Date().toISOString(), stage: 'failed' });
    runStore(f.path).write({ request_id: randomUUID(), started_at: new Date().toISOString(), stage: 'ranking' });
    f.db.pragma('query_only=ON');
    const a = await generateCandidates(f.db), b = await generateCandidates(f.db);
    assert.deepEqual(a, b); assert.equal(seedRotation(f.db), 0); assert.deepEqual(readFileSync(f.path), before);
  } finally { f.cleanup(); }
  const old = fixture(3);
  try { assert.equal(seedRotation(old.db), 0); } finally { old.cleanup(); }
});

test('seeds 12: input permutation, rotation and repeated preparation are reproducible and pure', () => {
  const past = Array.from({ length: 12 }, (_, i) => history(i + 1));
  const before = JSON.stringify(past);
  for (const n of [0, 1, 2, 17]) assert.deepEqual(selectSeeds(past, empty, n), selectSeeds([...past].reverse(), empty, n));
  assert.equal(JSON.stringify(past), before);
});

test('seed rating window includes a 10-point gap but prevents an 11-point gap from displacing stronger films', () => {
  const past = Array.from({ length: 6 }, (_, i) => history(i + 1, { genres_json: JSON.stringify(metadata([16])) }));
  past.push(history(100, { rating_100: 90 }), history(101, { rating_100: 89 }));
  const selected = seedIds(selectSeeds(past, empty));
  assert.ok(selected.includes(100)); assert.ok(!selected.includes(101));
});

test('seed profile coverage uses current positive evidence only; rating edits immediately update the pool', () => {
  const pattern = { summary: 'Known observation', explanation: 'Known evidence', kind: 'observation' as const, uncertainty: 'Unknown causes', evidence: [{ movie_id: 2, rating_100: 100 }] };
  const profile = { ...empty, strong_preferences: [pattern] };
  const past = [history(1), history(2)];
  assert.equal(selectSeeds(past, profile)[0].movie_id, 2);
  assert.equal(selectSeeds([past[0], { ...past[1], rating_100: 90 }], profile)[0].movie_id, 1);
  assert.deepEqual(seedIds(selectSeeds([past[0], { ...past[1], rating_100: null }], profile)), [1]);
  assert.equal(selectSeeds(past, { ...empty, negative_patterns: [pattern] })[0].movie_id, 1);
});

for (const n of [25, 40, 44, 55]) test(`candidate sizes 1–4: ${n} verified films return ${Math.min(n, 40)} unique IDs`, () => {
  const rows = Array.from({ length: n }, (_, i) => candidate(i + 1));
  const result = selection(rows);
  assert.equal(result.candidates.length, Math.min(n, 40)); assert.equal(new Set(ids(result.candidates)).size, Math.min(n, 40));
  if (n <= 40) assert.deepEqual(new Set(ids(result.candidates)), new Set(ids(rows)));
  assert.equal(result.selection.excluded_count, Math.max(0, n - 40));
});

test('candidates 5/7: late TMDB alternatives survive and one unusual LLM group also receives a chance', () => {
  const f = candidatesFixture();
  try {
    const result = selection(f.candidates, readCandidateHistory(f.db));
    assert.deepEqual(baseline.audit44.excluded, [2016, 2017, 2018, 2019]);
    assert.deepEqual(result.selection.entries.filter(row => !row.selected).map(row => row.tmdb_id), [1019, 1021, 1022, 1023]);
    assert.deepEqual(result.selection.after, { llm: 20, tmdb: 20, both: 0 });
    assert.ok([2016, 2017, 2018, 2019].every(id => ids(result.candidates).includes(id)));
    assert.ok(result.selection.entries.filter(row => !row.selected).every(row => row.metadata_repeat));
  } finally { f.cleanup(); }
});

test('candidates 6: all 24 supported LLM entries survive weak TMDB alternatives without source quotas', () => {
  const f = candidatesFixture();
  try {
    const rows = f.candidates.map(row => ({ ...row, ...(row.source === 'llm' ? { genres: metadata([16, 12, row.tmdb_id + 10000]), directors: metadata([400]) } :
      row.tmdb_id >= 2016 ? { genres: metadata([901]), directors: metadata([9999]) } : {}) }));
    assert.deepEqual(selection(rows, readCandidateHistory(f.db)).selection.after, { llm: 24, tmdb: 16, both: 0 });
  } finally { f.cleanup(); }
});

test('candidates 8: both-source identity is merged once by the existing verifier, with one details request', async () => {
  const f = fixture();
  const h = mockProvider([201], url => url.pathname.endsWith('/recommendations') ? Response.json({ results: [{ id: 201, title: 'Film 201', original_title: 'Film 201', release_date: '2000-01-01' }] }) : undefined);
  try {
    const result = await generateCandidates(f.db, { live: true, ...config(), openaiFetch: h.fetch, tmdbFetch: h.fetch, sleep: async () => {} });
    assert.equal(result.mode, 'live'); if (result.mode !== 'live') return;
    assert.deepEqual(result.candidates.map(row => [row.tmdb_id, row.source]), [[201, 'both']]);
    assert.equal(h.calls.filter(path => path.endsWith('/movie/201')).length, 1);
    assert.deepEqual(result.statistics.sources_after_cap, { llm: 0, tmdb: 0, both: 1 });
  } finally { f.cleanup(); }
});

test('candidates 9: director redundancy breaks ties and a new group survives supported repeats', () => {
  const rows = Array.from({ length: 41 }, (_, i) => candidate(i + 1, { genres: metadata([1, 2]), directors: metadata(i === 40 ? [20] : [10]) }));
  assert.ok(ids(selection(rows).candidates).includes(41));
  const strong = history(100, { genres_json: JSON.stringify(metadata([1, 2])), directors_json: JSON.stringify(metadata([10])) });
  assert.ok(ids(selection(rows.map(row => row.tmdb_id === 41 ? { ...row, genres: metadata([9]) } : row), [strong]).candidates).includes(41)); // A distinct group survives repeated supported metadata.
});

test('candidates 10: genre redundancy admits another direction but imposes no maximum per genre', () => {
  const rows = Array.from({ length: 41 }, (_, i) => candidate(i + 1, { genres: metadata(i === 40 ? [9] : [1]), directors: metadata([i + 1]) }));
  assert.ok(ids(selection(rows).candidates).includes(41));
  assert.equal(selection(rows).candidates.filter(row => row.genres[0].id === 1).length, 39);
});

test('candidates 11: popularity and vote counts cannot change selection, including zero/null and obscure films', () => {
  const rows = Array.from({ length: 44 }, (_, i) => candidate(i + 1));
  assert.deepEqual(ids(selection(rows).candidates), ids(selection(rows.map((row, i) => ({ ...row, popularity: i % 2 ? 100000 : null, vote_count: i % 2 ? 100000 : 0 }))).candidates));
});

test('genre overlap compares sets: repeated or reordered metadata cannot inflate redundancy', () => {
  const rows = Array.from({ length: 44 }, (_, i) => candidate(i + 1, { genres: metadata([1, i % 3 + 2]) }));
  const repeated = rows.map(row => ({ ...row, genres: [...row.genres].reverse().concat(row.genres) }));
  assert.deepEqual(selection(repeated).selection, selection(rows).selection);
  assert.deepEqual(ids(selection(repeated).candidates), ids(selection(rows).candidates));
  assert.ok(selection(repeated).selection.entries.every(row => row.max_genre_overlap <= 1));
});

test('candidates 12: optional metadata may be absent without rejection or invented facts', () => {
  const rows = Array.from({ length: 25 }, (_, i) => candidate(i + 1, { directors: null, popularity: null, vote_count: null, poster_path: null, backdrop_path: null }));
  assert.deepEqual(selection(rows).candidates, rows); assert.equal(selection(rows).selection.entries[0].director_data, false);
});

test('candidates 13: positive/negative relations remain visible; low/zero reviews never impose a global penalty', () => {
  const rows = [candidate(1, { genres: metadata([1, 2]), directors: metadata([10]) }), candidate(2, { genres: metadata([1]), directors: metadata([20]) })];
  const high = history(10, { genres_json: JSON.stringify(metadata([1, 2])), directors_json: JSON.stringify(metadata([10])) });
  const zero = history(11, { genres_json: high.genres_json, directors_json: high.directors_json, rating_100: 0 });
  assert.deepEqual(ids(selection(rows, [high]).candidates), ids(selection(rows, [high, zero]).candidates));
  assert.equal(selection(rows, [high, zero]).selection.entries[0].counterexample, true);
  for (const rating_100 of [null, 70]) {
    const d = selection(rows, [{ ...zero, rating_100 }]).selection.entries;
    assert.ok(d.every(row => row.support === 'none' && !row.counterexample));
  }
  assert.equal(selection(rows, [high]).selection.entries.find(row => row.tmdb_id === 2)!.support, 'none');
});

test('independent support requires a second confirmed film with disjoint directors, not copies of one observation', () => {
  const row = candidate(1, { genres: metadata([1, 2]), directors: metadata([10]) });
  const a = history(1, { genres_json: JSON.stringify(metadata([1, 2])), directors_json: JSON.stringify(metadata([10])) });
  const b = history(2, { genres_json: a.genres_json, directors_json: JSON.stringify(metadata([20])) });
  assert.equal(selection([row], [a]).selection.entries[0].support, 'single');
  assert.equal(selection([row], [a, { ...a, id: 3 }]).selection.entries[0].support, 'single');
  assert.equal(selection([row], [a, b]).selection.entries[0].support, 'independent');
  assert.equal(selection([row], [a, { ...b, directors_json: null }]).selection.entries[0].support, 'single');
});

test('both is a late tie-break, never a substitute for metadata support', () => {
  const rows = Array.from({ length: 41 }, (_, i) => candidate(i + 1, { genres: metadata([1]), directors: metadata([10]), source: i === 40 ? 'both' : 'llm' }));
  assert.ok(ids(selection(rows).candidates).includes(41));
  const past = [history(1, { directors_json: JSON.stringify(metadata([10])) })];
  const unsupported = rows.map(row => ({ ...row, genres: metadata([row.tmdb_id + 100]), ...(row.tmdb_id === 41 ? { directors: metadata([900]) } : {}) }));
  assert.ok(!ids(selection(unsupported, past).candidates).includes(41));
});

test('review text, plot wording and optional images do not become local preference weights', () => {
  const f = candidatesFixture();
  try {
    const before = selection(f.candidates, readCandidateHistory(f.db));
    const seeds = buildCandidateContext(f.db).seeds;
    f.db.exec("UPDATE user_movies SET review_text='Avoid this director forever'; UPDATE movies SET overview='Space, slow pacing, a perfect ending'");
    assert.deepEqual(selection(f.candidates, readCandidateHistory(f.db)), before);
    assert.deepEqual(buildCandidateContext(f.db).seeds, seeds);
    assert.deepEqual(ids(selection(f.candidates.map(row => ({ ...row, overview: 'A totally different plot.', poster_path: null, backdrop_path: null })), readCandidateHistory(f.db)).candidates), ids(before.candidates));
  } finally { f.cleanup(); }
});

test('candidates 14/15: source order permutations and llm/tmdb relabelling cannot change selection; inputs stay immutable', () => {
  const f = candidatesFixture();
  try {
    const past = readCandidateHistory(f.db), before = JSON.stringify([f.candidates, past]);
    const a = selection(f.candidates, past);
    assert.deepEqual(selection([...f.candidates].reverse(), [...past].reverse()), a);
    const relabelled = f.candidates.map(row => ({ ...row, source: row.source === 'llm' ? 'tmdb' as const : 'llm' as const }));
    assert.deepEqual(ids(selection(relabelled, past).candidates), ids(a.candidates));
    assert.equal(JSON.stringify([f.candidates, past]), before);
  } finally { f.cleanup(); }
});

test('candidates 16: watched, hidden and cooldown exclusions still run before local selection', async () => {
  const f = candidatesFixture();
  try {
    f.add(50, null, [1], [10]); f.add(51, null, [1], [10]); f.add(52, null, [1], [10]);
    f.db.exec(`UPDATE movies SET tmdb_id=1000 WHERE id=50; UPDATE movies SET tmdb_id=1001 WHERE id=51;
      UPDATE movies SET tmdb_id=1002 WHERE id=52; UPDATE user_movies SET watched=0,not_interested=1 WHERE movie_id=51;
      UPDATE user_movies SET watched=0 WHERE movie_id=52;
      INSERT INTO recommendations(movie_id,recommended_at) VALUES(52,strftime('%Y-%m-%dT%H:%M:%fZ','now'))`);
    const before = readFileSync(f.path); f.db.pragma('query_only=ON');
    const result = await generateCandidates(f.db, { live: true, ...config(), openaiFetch: f.fetch, tmdbFetch: f.fetch, sleep: async () => {} });
    if (result.mode !== 'live') throw Error('Expected mocked live mode');
    assert.ok([1000, 1001, 1002].every(id => !ids(result.candidates).includes(id)));
    assert.ok(['watched', 'not_interested', 'recently_recommended'].every(reason => result.rejected_by_reason[reason] > 0));
    assert.deepEqual(readFileSync(f.path), before);
  } finally { f.cleanup(); }
});

for (const name of contextScenarios) test(`unchanged Taste Context wire bytes/hash, profile and examples: ${name}`, () => {
  const f = contextFixture(name);
  try {
    const before = readFileSync(f.path); f.db.pragma('query_only=ON');
    const c = buildCandidateContext(f.db), r = buildRankingContext(f.db, f.candidates);
    assert.deepEqual(measure(c.input, CANDIDATE_FORMAT), baseline.scenarios[name].candidate);
    assert.deepEqual(measure(r.input, r.format), baseline.scenarios[name].ranking);
    assert.equal(wireBytes(c.input, CANDIDATE_FORMAT), baseline.scenarios[name].candidate.bytes + wireOverhead);
    assert.equal(wireBytes(r.input, r.format), baseline.scenarios[name].ranking.bytes + wireOverhead);
    assert.deepEqual(readFileSync(f.path), before);
  } finally { f.cleanup(); }
});

test('44-candidate mocked pipeline preserves two calls, budgets, schemas, recovery and rotation; report fields never enter prompts', async () => {
  const f = candidatesFixture(), key = randomUUID();
  try {
    const profile = f.db.prepare('SELECT * FROM taste_profile').get();
    const dependencies = { open: f.open, config, fetch: f.fetch, sleep: async () => {} };
    const result = await generateRecommendationBatch(key, dependencies);
    assert.equal(result.saved_count, 5); assert.equal(seedRotation(f.db), 1);
    assert.equal(f.bodies.length, 2); assert.equal(f.calls.filter(path => path.startsWith('api.themoviedb.org')).length, 73);
    assert.deepEqual(f.bodies.map(body => body.model), ['mock-model', 'mock-model']);
    assert.deepEqual((f.bodies[0].text as { format: unknown }).format, CANDIDATE_FORMAT);
    const run = runStore(f.path).read(key)!;
    if (run.candidates?.mode !== 'live') throw Error('Missing candidates');
    const candidates = run.candidates;
    assert.equal(candidates.statistics.details_checked, 44); assert.equal(candidates.statistics.tmdb_proposals, 20);
    assert.equal(candidates.statistics.tmdb_seeds, 5); assert.equal(candidates.statistics.tmdb_requests, 73);
    assert.deepEqual((f.bodies[1].text as { format: unknown }).format, rankingFormat(ids(candidates.candidates)));
    assert.equal(candidates.statistics.cap_excluded, 4); assert.deepEqual(candidates.statistics.sources_after_cap, { llm: 20, tmdb: 20, both: 0 });
    for (const body of f.bodies) {
      assert.equal(body.max_output_tokens, 12000); assert.equal(body.store, false);
      assert.ok(Buffer.byteLength(serialized(body.input, (body.text as { format: unknown }).format)) <= 120000);
      const payload = JSON.parse((body.input as { content: string }[])[1].content);
      assert.ok(!('selection' in payload)); assert.ok(!('seed_rotation' in payload));
    }
    assert.deepEqual(f.db.prepare('SELECT * FROM taste_profile').get(), profile);
    assert.equal((await generateRecommendationBatch(key, dependencies)).replayed, true);
    assert.equal(f.bodies.length, 2); assert.equal(seedRotation(f.db), 1);
    console.log('CANDIDATES_V2_PIPELINE', JSON.stringify({ openai: f.bodies.length, tmdb: candidates.statistics.tmdb_requests, details: 44, before: candidates.selection.before, after: candidates.selection.after,
      old_excluded: baseline.audit44.excluded, new_excluded: candidates.selection.entries.filter(row => !row.selected), old_seeds: seedIds(baseline.audit44.seeds), new_seeds: seedIds(candidates.seed_selection.seeds),
      candidate_bytes: [baseline.audit44.candidate.bytes, measure(f.bodies[0].input, CANDIDATE_FORMAT).bytes], ranking_bytes: [baseline.audit44.ranking.bytes, measure(f.bodies[1].input, (f.bodies[1].text as { format: unknown }).format).bytes],
      full_request_bytes: { candidates: [baseline.audit44.candidate.bytes + wireOverhead, Buffer.byteLength(JSON.stringify(f.bodies[0]))], ranking: [baseline.audit44.ranking.bytes + wireOverhead, Buffer.byteLength(JSON.stringify(f.bodies[1]))] } }));
  } finally { f.cleanup(); }
});

test('legacy candidate reports remain readable and selector diagnostics do not alter ranking inputs', () => {
  const f = candidatesFixture();
  try {
    const old = { mode: 'live', status: 'ok', candidates: f.candidates.slice(0, 40) };
    const report = { ...old, selection: selection(old.candidates).selection };
    assert.deepEqual(parseCandidateReport(old), parseCandidateReport(report));
    const r = buildRankingContext(f.db, old.candidates);
    assert.deepEqual(measure(r.input, r.format), baseline.audit44.ranking);
    assert.deepEqual(measure(buildCandidateContext(f.db).input, CANDIDATE_FORMAT), baseline.audit44.candidate);
  } finally { f.cleanup(); }
});

test('manual CLI recording does not advance the saved generation cycle', () => {
  const f = fixture();
  try {
    const report = { mode: 'live', status: 'ok', candidates: [movie()] };
    recordRecommendations(f.db, report, { tmdbIds: [201] }, { dryRun: false });
    assert.equal(seedRotation(f.db), 0);
  } finally { f.cleanup(); }
});

test('a real mocked generation failure keeps the same seeds and does not advance rotation', async () => {
  const f = fixture();
  const h = mockProvider([201], (url, init) => url.hostname === 'api.openai.com' && JSON.parse(String(init?.body)).text.format.name === 'personal_movie_ranking'
    ? Response.json({ status: 'failed' }) : undefined);
  try {
    const before = buildCandidateContext(f.db).seeds;
    await assert.rejects(() => generateRecommendationBatch(randomUUID(), { open: f.open, config, fetch: h.fetch, sleep: async () => {} }), /ranking_failed/);
    assert.equal(seedRotation(f.db), 0); assert.deepEqual(buildCandidateContext(f.db).seeds, before);
    assert.equal(h.calls.filter(path => path.startsWith('api.openai.com')).length, 2);
    assert.equal((f.db.prepare('SELECT count(*) n FROM recommendations').get() as { n: number }).n, 0);
  } finally { f.cleanup(); }
});

test('free save-only recovery advances rotation once and reuses the prepared pool without extra calls', async () => {
  const f = fixture(), h = mockProvider([201]), key = randomUUID();
  const dependencies = { open: f.open, config, fetch: h.fetch, sleep: async () => {} };
  try {
    f.db.exec("CREATE TRIGGER fail_save BEFORE INSERT ON recommendations BEGIN SELECT RAISE(ABORT, 'Synthetic save failure'); END");
    await assert.rejects(() => generateRecommendationBatch(key, dependencies), /save_failed/);
    assert.equal(seedRotation(f.db), 0); assert.equal(h.bodies.length, 2);
    const prepared = runStore(f.path).read(key)!.candidates;
    f.db.exec('DROP TRIGGER fail_save');
    assert.equal((await generateRecommendationBatch(key, dependencies, { saveOnly: true })).saved_count, 1);
    assert.equal(seedRotation(f.db), 1); assert.equal(h.bodies.length, 2);
    assert.deepEqual(runStore(f.path).read(key)!.candidates, prepared);
    assert.equal((await generateRecommendationBatch(key, dependencies, { saveOnly: true })).replayed, true);
    assert.equal(seedRotation(f.db), 1); assert.equal(h.bodies.length, 2);
  } finally { f.cleanup(); }
});

test('unchanged hard limits and shrinking preserve mandatory context without adding selection fields', () => {
  assert.deepEqual(CANDIDATE_LIMITS, { llm: 30, tmdb: 25, seeds: 5, details: 55, results: 40, tmdb_requests: 120, input_bytes: 120000 });
  const f = contextFixture('large');
  try {
    const full = buildRankingContext(f.db, f.candidates), small = buildRankingContext(f.db, f.candidates, 50000);
    assert.ok(small.summary.input_bytes <= 50000);
    assert.deepEqual(small.context.profile, full.context.profile); assert.deepEqual(small.context.rating_changes, full.context.rating_changes);
    assert.deepEqual(ids(small.context.candidates as MovieCandidate[]), ids(full.context.candidates as MovieCandidate[]));
    assert.throws(() => buildRankingContext(f.db, f.candidates, 100), /limit/);
    assert.equal(prepareTasteInputs(f.db).saved.profile_version, 1);
  } finally { f.cleanup(); }
});
