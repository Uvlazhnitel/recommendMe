import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { contextFixture, contextScenarios } from './fixtures/taste-context-v2';
import { fixture, movie, mockProvider, config } from './fixtures/recommendation-screen';
import { buildCandidateContext, prepareTasteInputs, CANDIDATE_FORMAT } from '../src/lib/candidate-context';
import { buildRankingContext } from '../src/lib/recommendation-context';
import { buildTasteContext } from '../src/lib/taste-context';
import { readTasteProfile, generateTasteProfile } from '../src/lib/taste-profile';
import { readReviewTexts, reviewSnapshot } from '../src/lib/review-context';
import { selectGeneralExamples, selectRelatedExamples } from '../src/lib/taste-examples';
import { generateRecommendationBatch } from '../src/lib/recommendation-service';
import { rankingFormat } from '../src/lib/recommendation-schema';

const baseline = JSON.parse(readFileSync(new URL('./fixtures/taste-context-v2-baseline.json', import.meta.url), 'utf8')).measurements;
const ids = (rows: { movie_id: number }[]) => rows.map(row => row.movie_id);
const state = (f: ReturnType<typeof fixture>) => JSON.stringify(['movies','user_movies','taste_profile','recommendations'].map(table => f.db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()));
const review = (f: ReturnType<typeof fixture>, id: number, text: string | null) => f.db.prepare('UPDATE user_movies SET review_text=? WHERE movie_id=?').run(text,id);

test('candidate coverage prevents a director cluster from occupying all related slots', () => {
  const f = contextFixture('director');
  try {
    assert.deepEqual(baseline.director.related, [10,11,12,13,14,15,16,17,18,19]);
    const ranking = buildRankingContext(f.db, f.candidates), selected = ranking.context.related_examples;
    assert.deepEqual(ids(selected), [10,100,200]);
    for (const candidate of f.candidates) assert.ok(selected.some(row => row.directors.some(person => candidate.directors!.some(other => other.id === person.id))));
  } finally { f.cleanup(); }
});

test('disjoint candidate genre groups receive evidence even without any shared director', () => {
  const f = contextFixture('director');
  try {
    f.db.exec(`UPDATE movies SET genres_json='[{"id":3,"name":"Genre 3"},{"id":5,"name":"Genre 5"}]' WHERE id=100;
      UPDATE movies SET genres_json='[{"id":4,"name":"Genre 4"},{"id":6,"name":"Genre 6"}]' WHERE id=200`);
    const candidates = f.candidates.map((row,index) => ({ ...row, directors: [], genres: (index===0 ? [1,2] : index===1 ? [3,5] : [4,6]).map(id=>({id,name:`Genre ${id}`})) }));
    const selected = buildRankingContext(f.db,candidates).context.related_examples;
    assert.deepEqual(ids(selected),[10,100,200]);
  } finally { f.cleanup(); }
});

test('one broad genre cannot outrank a confirmed director link to an uncovered candidate', () => {
  const f = contextFixture('director');
  try {
    f.db.exec('DELETE FROM user_movies WHERE movie_id=200; DELETE FROM movies WHERE id=200');
    const candidates = [{ ...movie(), genres:[{id:1,name:'Genre 1'}], directors:[{id:20,name:'Director 20'}] }];
    const selected = buildRankingContext(f.db,candidates).context.related_examples;
    assert.equal(selected[0].movie_id,100); // Fifteen earlier rows share only the broad genre.
  } finally { f.cleanup(); }
});

test('a relevant middle counterexample precedes repetitive high ratings, without a 50/50 quota', () => {
  const f = contextFixture('counterexample');
  try {
    assert.ok(baseline.counterexample.related.every((id:number)=>id<100));
    const ranking=buildRankingContext(f.db,f.candidates);
    assert.deepEqual(ids(ranking.context.related_examples),[100]);
    assert.equal(ranking.context.related_examples[0].rating_100,70);
    assert.ok(ranking.context.examples.some(row=>row.rating_100>=80));
    assert.ok(ranking.context.current_evidence.some(row=>row.movie_id===100 && row.rating_100===70));
  } finally { f.cleanup(); }
});

test('general examples expose a distinct profile-supported side instead of only multi-director near-duplicates', () => {
  const f=contextFixture('redundant');
  try {
    assert.ok(!baseline.redundant.examples.includes(200));
    const context=buildCandidateContext(f.db);
    assert.ok(ids(context.context.examples).includes(200));
    assert.ok(context.context.examples.find(row=>row.movie_id===200)!.genres.includes('Genre 8'));
    assert.equal(context.context.examples.filter(row=>row.rating_100>=80).length,10);
    assert.equal(context.context.examples.filter(row=>row.rating_100<=60).length,1);
  } finally { f.cleanup(); }
});

test('general selection alternates groups, covers numeric buckets, preserves zero and never fills missing low slots with highs', () => {
  const f=contextFixture('redundant');
  try {
    f.add(300,80,[80],[80]); f.add(301,40,[40],[40]); f.add(302,60,[60],[60]); f.add(303,null,[100],[100]);
    let personal=prepareTasteInputs(f.db);
    assert.equal(personal.examples[0].rating_100>=80,true); assert.equal(personal.examples[1].rating_100<=60,true);
    for(const score of [0,40,60,80,90,100]) assert.ok(personal.examples.some(row=>row.rating_100===score));
    assert.ok(!personal.examples.some(row=>row.movie_id===303));
    f.db.exec('UPDATE user_movies SET rating_100=NULL WHERE rating_100<=60');
    personal=prepareTasteInputs(f.db);
    assert.equal(personal.examples.length,10); assert.ok(personal.examples.every(row=>row.rating_100>=80));
  } finally { f.cleanup(); }
});

test('related selection can include both zero and high ratings, and never treats NULL as a negative', () => {
  const f=contextFixture('director');
  try {
    f.add(300,0,[7,8],[77]); f.add(301,100,[7,8],[77]); f.add(302,null,[7,8],[77]);
    const p=prepareTasteInputs(f.db);
    const candidates=[{...movie(),genres:[{id:7,name:'Seven'},{id:8,name:'Eight'}],directors:[{id:77,name:'D'}]}];
    const selected=selectRelatedExamples(p.pool,candidates,[],p.taste!.context.contrast_pairs);
    assert.ok(selected.some(row=>row.movie_id===300 && row.rating_100===0));
    assert.ok(selected.some(row=>row.movie_id===301 && row.rating_100===100));
    assert.ok(!selected.some(row=>row.movie_id===302));
  } finally { f.cleanup(); }
});

test('review availability breaks only equal-information ties and cannot displace coverage or profile evidence', () => {
  const f=contextFixture('director'), other=contextFixture('redundant');
  try {
    review(f,11,'Specific observation');
    const ranking=buildRankingContext(f.db,f.candidates);
    assert.deepEqual(ids(ranking.context.related_examples),[11,100,200]);
    assert.equal(ranking.context.related_examples[0].review_excerpt,'Specific observation');
    other.db.exec("UPDATE user_movies SET review_text='One particular film' WHERE movie_id BETWEEN 10 AND 39");
    assert.ok(buildCandidateContext(other.db).context.examples.some(row=>row.movie_id===200));
  } finally { f.cleanup(); other.cleanup(); }
});

test('fresh review edits and clears reach the new selection without rewriting the stored profile', () => {
  const f=fixture();
  try {
    review(f,1,'Old observation');
    const saved={...readTasteProfile(f.db)!,reviews_snapshot:reviewSnapshot(readReviewTexts(f.db)),context_fingerprint:buildTasteContext(f.db).fingerprint};
    f.db.prepare('UPDATE taste_profile SET profile_json=?').run(JSON.stringify(saved));
    const profile=f.db.prepare('SELECT * FROM taste_profile').get();
    review(f,1,'Changed observation');
    for(const prepared of [buildCandidateContext(f.db),buildRankingContext(f.db,[movie()])]) {
      const example=prepared.context.examples.find(row=>row.movie_id===1)!;
      assert.equal(example.review_excerpt,'Changed observation'); assert.equal(example.review_changed,true);
    }
    review(f,1,null);
    for(const prepared of [buildCandidateContext(f.db),buildRankingContext(f.db,[movie()])]) {
      const example=prepared.context.examples.find(row=>row.movie_id===1)!;
      assert.equal(example.review_excerpt,null); assert.equal(example.review_changed,true);
      assert.ok(!JSON.stringify(prepared.context).includes('Old observation'));
      assert.ok(!JSON.stringify(prepared.context).includes('Changed observation'));
    }
    assert.deepEqual(f.db.prepare('SELECT * FROM taste_profile').get(),profile);
  } finally { f.cleanup(); }
});

test('missing metadata is never invented; fallback can be empty or diverse without declaring new candidate similarities', () => {
  const f=fixture();
  try {
    f.db.exec('UPDATE movies SET overview=NULL,genres_json=NULL,directors_json=NULL');
    let c=buildCandidateContext(f.db),r=buildRankingContext(f.db,[movie()]);
    assert.deepEqual(c.context.examples,[]); assert.deepEqual(r.context.related_examples,[]);
    assert.ok(r.context.current_evidence.some(row=>row.movie_id===1)); // Existing verified rating references survive.
    assert.ok(!JSON.stringify(r.context).includes('pacing'));
    f.db.exec(`UPDATE movies SET genres_json='[{"id":900,"name":"Unrelated"}]' WHERE id=1`);
    r=buildRankingContext(f.db,[movie()]);
    assert.equal(r.context.examples[0].overview,null); assert.deepEqual(r.context.examples[0].directors,[]);
    assert.match(r.input[0].content,/fallbacks, not guaranteed similarities/);
    c=buildCandidateContext(f.db); assert.deepEqual(c.context.examples[0].genres,['Unrelated']);
  } finally { f.cleanup(); }
});


test('shared setting words do not change local selection or manufacture a global preference', () => {
  const f=contextFixture('director');
  try {
    const before=buildCandidateContext(f.db),prior=buildRankingContext(f.db,f.candidates);
    f.db.prepare('UPDATE movies SET overview=?').run('Space, resistance, a common mission. No supplied facts about pacing or humour.');
    const after=buildCandidateContext(f.db),ranking=buildRankingContext(f.db,f.candidates);
    assert.deepEqual(ids(after.context.examples),ids(before.context.examples));
    assert.deepEqual(ids(ranking.context.related_examples),ids(prior.context.related_examples));
    assert.deepEqual(after.context.profile,before.context.profile);
    assert.deepEqual(ranking.context.candidates,prior.context.candidates);
    assert.match(ranking.input[0].content,/Shared themes, settings, motifs, genres or directors alone are weak evidence/);
  } finally { f.cleanup(); }
});

test('same facts and candidate permutations produce identical selection without mutating selector inputs', () => {
  const f=contextFixture('large');
  try {
    const p=prepareTasteInputs(f.db),before=JSON.stringify(p.pool),pairs=p.taste!.context.contrast_pairs;
    const general=selectGeneralExamples(p.pool,pairs);
    assert.deepEqual(selectGeneralExamples([...p.pool].reverse(),pairs),general);
    assert.deepEqual(selectRelatedExamples(p.pool,f.candidates,general,pairs),selectRelatedExamples([...p.pool].reverse(),[...f.candidates].reverse(),general,pairs));
    assert.equal(JSON.stringify(p.pool),before);
    assert.deepEqual(buildRankingContext(f.db,f.candidates),buildRankingContext(f.db,f.candidates));
  } finally { f.cleanup(); }
});

for(const name of contextScenarios) test(`v1/v2 byte comparison and full-profile compatibility: ${name}`, async () => {
  const f=contextFixture(name);
  try {
    const before=state(f),old=baseline[name]; f.db.pragma('query_only=ON');
    const c=buildCandidateContext(f.db),r=buildRankingContext(f.db,f.candidates),taste=buildTasteContext(f.db);
    assert.equal(taste.fingerprint,old.taste_fingerprint); assert.equal(taste.inputBytes,old.taste_bytes);
    assert.equal(c.summary.profile_status,'current'); assert.deepEqual(c.seeds,old.seeds);
    const status=await generateTasteProfile(f.db,{fetch:async()=>{throw Error('Forbidden real API');}});
    assert.equal(status.cache,'current'); assert.equal(state(f),before);
    assert.ok(c.summary.input_bytes<=old.candidate_bytes*1.05,`${name} candidates ${old.candidate_bytes} -> ${c.summary.input_bytes}`);
    assert.ok(r.summary.input_bytes<=old.ranking_bytes*1.05,`${name} ranking ${old.ranking_bytes} -> ${r.summary.input_bytes}`);
    assert.ok(c.summary.input_bytes<=120000 && r.summary.input_bytes<=120000);
    assert.ok(c.context.examples.filter(row=>row.rating_100>=80).length<=10); assert.ok(c.context.examples.filter(row=>row.rating_100<=60).length<=10);
    assert.ok(r.context.related_examples.length<=10);
    const all=[...r.context.examples,...r.context.related_examples]; assert.equal(new Set(ids(all)).size,all.length);
    assert.deepEqual(r.context.candidates.map(row=>row.tmdb_id),f.candidates.map(row=>row.tmdb_id));
    console.log('TASTE_CONTEXT_V2_BYTES',JSON.stringify({name,candidates:[old.candidate_bytes,c.summary.input_bytes],ranking:[old.ranking_bytes,r.summary.input_bytes],old_related:old.related,new_related:ids(r.context.related_examples),old_examples:old.examples,new_examples:ids(c.context.examples)}));
  } finally { f.cleanup(); }
});

test('tight budgets preserve every current rating change, profile and all candidate IDs; impossible mandatory content fails', () => {
  const f=contextFixture('large');
  try {
    f.db.exec('UPDATE user_movies SET rating_100=NULL WHERE movie_id=1; UPDATE user_movies SET rating_100=0 WHERE movie_id=12');
    const full=buildCandidateContext(f.db),small=buildCandidateContext(f.db,full.summary.input_bytes-1500);
    assert.deepEqual(small.context.rating_changes,full.context.rating_changes);assert.deepEqual(small.context.profile,full.context.profile);
    const ranking=buildRankingContext(f.db,f.candidates,50000);
    assert.ok(ranking.summary.input_bytes<=50000);
    assert.deepEqual(ranking.context.rating_changes,full.context.rating_changes);
    assert.deepEqual(ranking.context.candidates.map(row=>row.tmdb_id),f.candidates.map(row=>row.tmdb_id));
    for(const reference of ranking.context.current_evidence) assert.equal((f.db.prepare('SELECT rating_100 FROM user_movies WHERE movie_id=?').get(reference.movie_id) as {rating_100:number}).rating_100,reference.rating_100);
    assert.throws(()=>buildCandidateContext(f.db,100),/limit/); assert.throws(()=>buildRankingContext(f.db,f.candidates,100),/limit/);
  } finally { f.cleanup(); }
});

for(const texts of [[],['Slow pacing failed here.'],['Slow pacing failed here.','The slow pace worked in this film.']]) {
  test(`two mocked calls preserve model, schema and allowed IDs with ${texts.length} film-specific reviews`, async () => {
    const f=fixture(),h=mockProvider();
    try {
      texts.forEach((text,index)=>review(f,index+1,text));
      const before=buildCandidateContext(f.db),stored=readTasteProfile(f.db);
      const result=await generateRecommendationBatch(randomUUID(),{open:f.open,config,fetch:h.fetch,sleep:async()=>{}});
      assert.equal(result.saved_count,2); assert.equal(h.bodies.length,2); assert.deepEqual(readTasteProfile(f.db),stored);
      assert.deepEqual(result.batch!.movies.map(row=>row.tmdb_id),[201,202]);
      assert.equal(h.bodies[0].model,'mock-model'); assert.equal(h.bodies[1].model,'mock-model');
      for(const body of h.bodies) assert.equal(body.max_output_tokens,12000);
      assert.deepEqual((h.bodies[0].text as {format:unknown}).format,CANDIDATE_FORMAT);
      assert.deepEqual((h.bodies[1].text as {format:unknown}).format,rankingFormat([201,202]));
      for(const body of h.bodies) {
        const prompt=(body.input as {content:string}[])[0].content;
        assert.match(prompt,/weak evidence/);assert.match(prompt,/pacing, humour quality/);assert.match(prompt,/middle 61-79/);
        if(texts.length) { assert.match(prompt,/multiple independent observations/);assert.match(prompt,/contradictory evidence/);assert.match(prompt,/untrusted DATA/); }
      }
      const data=JSON.parse((h.bodies[0].input as {content:string}[])[1].content);
      assert.deepEqual(data.rating_changes,before.context.rating_changes);
      assert.deepEqual(data.profile,before.context.profile); // No categorical preference was manufactured locally.
      assert.ok(data.examples.some((row:{rating_100:number})=>row.rating_100===0));
    } finally { f.cleanup(); }
  });
}
