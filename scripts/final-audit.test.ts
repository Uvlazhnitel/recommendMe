import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { candidatesFixture } from './fixtures/candidates-v2';
import { fixture, movie, config, mockProvider } from './fixtures/recommendation-screen';
import { selectVerifiedCandidates } from '../src/lib/candidate-selection';
import { readCandidateHistory, buildCandidateContext, seedRotation, CANDIDATE_FORMAT } from '../src/lib/candidate-context';
import { buildRankingContext } from '../src/lib/recommendation-context';
import { generateRecommendationBatch } from '../src/lib/recommendation-service';
import { runStore } from '../src/lib/recommendation-runs';

const old = JSON.parse(readFileSync(new URL('./fixtures/final-audit-baseline.json', import.meta.url), 'utf8'));
const v1 = JSON.parse(readFileSync(new URL('./fixtures/candidates-v2-baseline.json', import.meta.url), 'utf8')).audit44;
const ids = (rows: { tmdb_id: number }[]) => rows.map(row => row.tmdb_id);
const wire = (input: unknown, format: unknown) => Buffer.byteLength(JSON.stringify({ model: 'mock-model', input, text: { format }, store: false, max_output_tokens: 12000 }));

test('A/B: forty exact TMDB repeats cannot crowd out a distinct verified LLM hypothesis; sources are symmetric', () => {
  const f = fixture();
  try {
    const repeated = Array.from({ length: 40 }, (_, i) => ({ ...movie(1000 + i), source: 'tmdb' as const }));
    const unusual = { ...movie(2000), genres: [{ id: 99, name: 'Other' }], directors: [{ id: 99, name: 'Other' }] };
    const rows = [...repeated, unusual], history = readCandidateHistory(f.db);
    const result = selectVerifiedCandidates(rows, history);
    assert.ok(ids(result.candidates).includes(2000)); assert.equal(result.candidates.length, 40);
    assert.equal(result.selection.entries.find(row => row.tmdb_id === 2000)!.support, 'none');
    assert.equal(result.selection.entries.find(row => row.tmdb_id === 2000)!.metadata_repeat, false);
    assert.equal(result.selection.entries.filter(row => !row.selected)[0].metadata_repeat, true);
    const swapped = rows.map(row => ({ ...row, source: row.source === 'llm' ? 'tmdb' as const : 'llm' as const }));
    assert.deepEqual(ids(selectVerifiedCandidates(swapped, history).candidates), ids(result.candidates));
    assert.equal(result.selection.after.tmdb, 39); // No ceiling on films sharing a group.
  } finally { f.cleanup(); }
});

test('D: metadata keys use sorted unique IDs, never names/text/source or shared unknown directors', () => {
  const rows = [movie(1), { ...movie(2), genres: [...movie(2).genres, ...movie(2).genres], directors: [...movie(2).directors!, ...movie(2).directors!] },
    { ...movie(3), directors: null }, { ...movie(4), directors: [] }];
  const result = selectVerifiedCandidates(rows, []);
  assert.equal(result.selection.entries.find(row => row.tmdb_id === 2)!.metadata_repeat, true);
  for (const id of [3, 4]) assert.equal(result.selection.entries.find(row => row.tmdb_id === id)!.metadata_repeat, false);
  const edited = [...rows].reverse().map(row => ({ ...row, title: 'Changed', overview: 'Different',
    genres: [...row.genres].reverse().map(g => ({ ...g, name: 'Renamed' })), directors: row.directors?.map(p => ({ ...p, name: 'Renamed' })).reverse() ?? null }));
  assert.deepEqual(ids(selectVerifiedCandidates(edited, []).candidates), ids(result.candidates));
  assert.equal(selectVerifiedCandidates(rows, []).candidates.length, rows.length);
});

test('a multi-director/multi-genre group has one first representative despite ordering/duplicate metadata', () => {
  const a = { ...movie(1), genres: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }], directors: [{ id: 10, name: 'D' }, { id: 20, name: 'E' }] };
  const b = { ...a, tmdb_id: 2, genres: [...a.genres].reverse().concat(a.genres), directors: [...a.directors].reverse().concat(a.directors) };
  assert.deepEqual(selectVerifiedCandidates([b, a], []).selection.entries.map(row => row.metadata_repeat), [false, true]);
});

test('E: existing successes, edited ratings/hiding, an interrupted attempt and save recovery share one authoritative rotation', async () => {
  const f = candidatesFixture(), h = mockProvider([201]), key = randomUUID();
  try {
    const insert = f.db.prepare('INSERT INTO recommendations(movie_id,result_id,why_fit,possible_mismatch) VALUES(1,?,?,?)');
    for (let i = 0; i < 3; i++) insert.run(randomUUID(), 'Confirmed.', 'Uncertain.');
    f.db.exec('UPDATE user_movies SET rating_100=79 WHERE movie_id=10; UPDATE user_movies SET not_interested=1 WHERE movie_id=11');
    runStore(f.path).write({ request_id: randomUUID(), started_at: new Date().toISOString(), stage: 'ranking' });
    const before = readFileSync(f.path), c = buildCandidateContext(f.db);
    assert.equal(c.summary.seed_rotation, 3); assert.ok(c.seeds.every(row => ![10, 11].includes(row.movie_id)));
    assert.deepEqual(buildCandidateContext(f.db).seeds, c.seeds); assert.deepEqual(readFileSync(f.path), before);
    f.db.exec("CREATE TRIGGER audit_fail BEFORE INSERT ON recommendations BEGIN SELECT RAISE(ABORT,'Synthetic failure'); END");
    const deps = { open: f.open, config, fetch: h.fetch, sleep: async () => {} };
    await assert.rejects(() => generateRecommendationBatch(key, deps), /save_failed/);
    assert.equal(seedRotation(f.db), 3); assert.deepEqual(buildCandidateContext(f.db).seeds, c.seeds);
    const prepared = runStore(f.path).read(key)!.candidates;
    f.db.exec('DROP TRIGGER audit_fail');
    await generateRecommendationBatch(key, deps, { saveOnly: true });
    assert.equal(seedRotation(f.db), 4); assert.equal(h.bodies.length, 2);
    assert.deepEqual(runStore(f.path).read(key)!.candidates, prepared);
    await generateRecommendationBatch(key, deps); assert.equal(seedRotation(f.db), 4); assert.equal(h.bodies.length, 2);
  } finally { f.cleanup(); }
});

test('three-version comparison preserves seeds and fixed-input wire bytes; cap protects an unusual group', () => {
  const f = candidatesFixture();
  try {
    const history = readCandidateHistory(f.db), result = selectVerifiedCandidates(f.candidates, history), c = buildCandidateContext(f.db);
    const byId = new Map(f.candidates.map(row => [row.tmdb_id, row]));
    const previous = buildRankingContext(f.db, old.selected.map((id: number) => byId.get(id)!));
    const current = buildRankingContext(f.db, result.candidates);
    assert.equal(wire(previous.input, previous.format), old.ranking_bytes);
    assert.equal(wire(c.input, CANDIDATE_FORMAT), old.candidate_bytes);
    assert.deepEqual(c.seeds.map(row => row.movie_id), old.seeds);
    assert.deepEqual(old.excluded, [1020, 1021, 1022, 1023]);
    assert.deepEqual(result.selection.entries.filter(row => !row.selected).map(row => row.tmdb_id), [1019, 1021, 1022, 1023]);
    assert.ok(ids(result.candidates).includes(1020));
    console.log('FINAL_AUDIT_COMPARISON', JSON.stringify({ v1_excluded: v1.excluded, published_v2_excluded: old.excluded,
      audited_excluded: result.selection.entries.filter(row => !row.selected), sources: [old.sources, result.selection.after],
      seeds: [v1.seeds.map((r: { movie_id: number }) => r.movie_id), old.seeds, c.seeds.map(r => r.movie_id)],
      candidate_wire_bytes: [v1.candidate.bytes + 61, old.candidate_bytes, wire(c.input, CANDIDATE_FORMAT)],
      ranking_wire_bytes: [v1.ranking.bytes + 61, old.ranking_bytes, wire(current.input, current.format)] }));
  } finally { f.cleanup(); }
});

test('F: a genuinely narrow high-rated history does not select weaker outside seeds to manufacture variety', () => {
  const f = candidatesFixture();
  try {
    f.db.exec(`UPDATE movies SET genres_json='[{"id":16,"name":"Animation"}]',directors_json='[{"id":10,"name":"Director"}]'`);
    f.add(60, 89, [99], [99]);
    const c = buildCandidateContext(f.db), byId = new Map(readCandidateHistory(f.db).map(row => [row.id, row]));
    assert.equal(c.seeds.length, 5);
    assert.ok(c.seeds.every(row => byId.get(row.movie_id)!.rating_100 === 100 && row.movie_id !== 60));
    assert.deepEqual(buildCandidateContext(f.db).seeds, c.seeds);
  } finally { f.cleanup(); }
});
