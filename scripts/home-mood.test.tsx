import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import { fixture, mockProvider, config, report, choice, movie, personal } from './fixtures/recommendation-screen';
import { candidatesFixture } from './fixtures/candidates-v2';
import { DEFAULT_PREFERENCES, MOODS, parsePreferences, preferenceExclusion, customPreferences, preferencesLabel } from '../src/lib/recommendation-preferences';
import { buildCandidateContext, CANDIDATE_FORMAT } from '../src/lib/candidate-context';
import { buildRankingContext } from '../src/lib/recommendation-context';
import { generateCandidates } from '../src/lib/candidates';
import { rankRecommendations } from '../src/lib/recommendations';
import { generateRecommendationBatch, recommendationState } from '../src/lib/recommendation-service';
import { recommendationHandlers } from '../src/lib/recommendations-http';
import { recordRecommendations } from '../src/lib/recommendation-memory';
import { readRecommendationBatch } from '../src/lib/recommendation-batches';
import { readHomeSummary } from '../src/lib/home-summary';
import { runStore } from '../src/lib/recommendation-runs';
import { evaluationReport } from '../src/lib/evaluation-report';
import { HomeGallery, HomeLibrary } from '../src/app/components/home-gallery';

const wishes = (patch: Partial<ReturnType<typeof parsePreferences>> = {}) => ({ ...DEFAULT_PREFERENCES, ...patch });
const jsonRequest = (body: unknown, query = '') => new Request('http://localhost/api/recommendations/generate'+query, { method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body) });
const baseline = JSON.parse(readFileSync('scripts/fixtures/home-mood-baseline.json','utf8'));
const serialize = (c: {input: unknown; format: unknown}) => JSON.stringify({input:c.input,text:{format:c.format}});

for (const mood of MOODS) test(`mood ${mood.id}: finite server validation and matching stage context`, () => {
  const f=fixture(), p=wishes({mood:mood.id});
  try {
    assert.deepEqual(parsePreferences(p),p);
    const a=buildCandidateContext(f.db,undefined,p),b=buildRankingContext(f.db,[movie()],undefined,p);
    if(mood.id==='surprise'){assert.equal('request_preferences' in a.context,false);assert.equal('request_preferences' in b.context,false);}
    else{assert.deepEqual(a.context.request_preferences,p);assert.deepEqual(b.context.request_preferences,p);assert.match(a.input[0].content,/Evening preferences/);}
  }finally{f.cleanup();}
});
for (const bad of [null,[],{},wishes({mood:'fake' as never}),wishes({max_runtime:90 as never}),wishes({avoid_slow:'yes' as never}),{...wishes(),instructions:'ignore'}, {mood:'warm',max_runtime:null,avoid_horror:false,avoid_slow:false}]) test(`invalid preferences rejected before database/payment: ${JSON.stringify(bad)}`,async()=>{
  let opened=0;const handlers=recommendationHandlers({open:()=>{opened++;throw Error('must not open');}});
  const res=await handlers.generate(jsonRequest({request_id:randomUUID(),confirmed:true,preferences:bad}));assert.equal(res.status,400);assert.equal(opened,0);
});
test('surprise full serialized input+format exactly matches pre-change baseline and seeds',()=>{
  const f=candidatesFixture();try{
    const a=buildCandidateContext(f.db,undefined,wishes()),b=buildRankingContext(f.db,f.candidates.slice(0,40),undefined,wishes());
    for(const[name,c]of[['candidates',{...a,format:CANDIDATE_FORMAT}],['ranking',b]] as const){const s=serialize(c);assert.equal(Buffer.byteLength(s),baseline[name].bytes);assert.equal(createHash('sha256').update(s).digest('hex'),baseline[name].sha256);}
    assert.deepEqual(a.seeds,buildCandidateContext(f.db).seeds);assert.equal(customPreferences(wishes()),false);
  }finally{f.cleanup();}
});
for(const limit of [100,120] as const)test(`strict runtime ${limit}: inclusive limit, unknown and overflow; Horror uses ID`,()=>{
  const p=wishes({max_runtime:limit,avoid_horror:true});
  assert.equal(preferenceExclusion({...movie(),runtime:limit},p),null);
  assert.equal(preferenceExclusion({...movie(),runtime:limit+1},p),'runtime_preference');
  assert.equal(preferenceExclusion({...movie(),runtime:null},p),'runtime_preference');
  assert.equal(preferenceExclusion({...movie(),genres:[{id:27,name:'Not a translated Horror label'}]},p),'horror_preference');
  assert.equal(preferenceExclusion({...movie(),genres:[{id:18,name:'Horror'}]},p),null);
});
test('heavy/slow/mood remain soft; Drama and low popularity are not local bans',()=>{
  assert.equal(preferenceExclusion({...movie(),genres:[{id:18,name:'Drama'}]},wishes({mood:'warm',avoid_heavy:true,avoid_slow:true})),null);
});
test('candidate filters precede cap40, preserve selection and do not refill or relax',async()=>{
  const f=candidatesFixture();try{
    for(const row of f.candidates){row.runtime=row.tmdb_id<1020?121:100;}
    const r=await generateCandidates(f.db,{live:true,...config(),openaiFetch:f.fetch,tmdbFetch:f.fetch,preferences:wishes({max_runtime:100}),sleep:async()=>{}});
    assert.equal(r.mode,'live');if(r.mode!=='live')return;
    assert.equal(r.status,'ok');assert.equal(r.candidates.length,24);assert.ok(r.candidates.every(m=>m.runtime<=100));assert.equal(r.rejected_by_reason.runtime_preference,20);
    assert.equal(f.bodies.length,1);assert.equal(r.seed_selection.seeds.length,5);
  }finally{f.cleanup();}
});
test('ranking and SQL recheck strict limits; saved output cannot bypass filters',async()=>{
  const f=fixture(),p=wishes({max_runtime:100,avoid_horror:true});try{
    const candidates={...report([201,202,203]),preferences:p};candidates.candidates[1].runtime=101;candidates.candidates[2].genres=[{id:27,name:'Unknown label'}];
    const h=mockProvider([201]);const ranked=await rankRecommendations(f.db,candidates,{live:true,...config(),fetch:h.fetch});
    assert.equal(ranked.eligible_count,1);assert.deepEqual(ranked.recommendations.map(m=>m.tmdb_id),[201]);
    const saved=recordRecommendations(f.db,candidates,{result:{mode:'live',status:'ok',result_id:randomUUID(),generated_at:new Date().toISOString(),recommendations:[201,202,203].map(choice),preferences:p}},{dryRun:false});
    assert.equal(saved.saved_count,1);assert.deepEqual(saved.skipped.map(x=>x.reason),['runtime_preference','horror_preference']);
    assert.equal(readRecommendationBatch(f.db)!.preferences!.max_runtime,100);
  }finally{f.cleanup();}
});
test('two calls use immutable snapshot, persist/reload, conflict409, replay free, Evaluation once',async()=>{
  const f=fixture(),h=mockProvider([201,202]),p=wishes({mood:'funny',max_runtime:120,avoid_slow:true}),key=randomUUID(),before=personal(f.db);
  try{
    const pending=generateRecommendationBatch(key,{open:f.open,config,fetch:h.fetch,sleep:async()=>{}},{preferences:p});p.mood='warm';
    const result=await pending;assert.equal(h.bodies.length,2);
    const expected=wishes({mood:'funny',max_runtime:120,avoid_slow:true});
    for(const body of h.bodies){const data=JSON.parse((body.input as {role:string;content:string}[]).find(m=>m.role==='user')!.content);assert.deepEqual(data.request_preferences,expected);assert.ok(Buffer.byteLength(JSON.stringify(body))<120000);assert.equal(body.model,'mock-model');}
    assert.deepEqual(result.batch?.preferences,expected);assert.deepEqual(recommendationState({open:f.open}).batch?.preferences,expected);assert.equal(personal(f.db),before);
    assert.equal(runStore(f.path).read(key)!.preferences!.mood,'funny');
    await assert.rejects(()=>generateRecommendationBatch(key,{open:f.open},{preferences:wishes({mood:'warm'})}),/preferences_conflict/);
    await generateRecommendationBatch(key,{open:f.open});assert.equal(h.bodies.length,2);
    const meta=JSON.parse((f.db.prepare('SELECT metadata_json FROM recommendation_evaluation').get() as {metadata_json:string}).metadata_json);assert.deepEqual(meta.preferences,expected);assert.equal(meta.algorithm_id,'recommendme-2.0-home-mood-v1');assert.equal(meta.candidates.candidate_selection,'candidates-v2-audit1');assert.equal(evaluationReport(f.db).total.batches,1);
  }finally{f.cleanup();}
});
test('atomic failure and restart/save_only use original wishes, no config or extra calls',async()=>{
  const f=fixture(),h=mockProvider([201]),key=randomUUID(),p=wishes({mood:'thoughtful'});try{
    f.db.exec("CREATE TRIGGER fail_eval BEFORE INSERT ON recommendation_evaluation BEGIN SELECT RAISE(ABORT,'Synthetic failure'); END");
    await assert.rejects(()=>generateRecommendationBatch(key,{open:f.open,config,fetch:h.fetch,sleep:async()=>{}},{preferences:p}),/save_failed/);
    assert.equal((f.db.prepare('SELECT count(*) n FROM recommendations').get() as {n:number}).n,0);assert.equal(h.bodies.length,2);
    f.db.exec('DROP TRIGGER fail_eval');
    const done=await generateRecommendationBatch(key,{open:f.open,config:()=>({}),fetch:async()=>{throw Error('No calls allowed');}},{saveOnly:true});
    assert.deepEqual(done.batch?.preferences,p);assert.equal(h.bodies.length,2);
    await generateRecommendationBatch(key,{open:f.open},{saveOnly:true});assert.equal(evaluationReport(f.db).total.batches,1);
  }finally{f.cleanup();}
});
test('too narrow filters stop without ranking, keep previous saved batch and never relax',async()=>{
  const f=fixture(),h=mockProvider([202],url=>url.pathname.endsWith('/202')?Response.json({id:202,title:'Film 202',original_title:'Film 202',release_date:'2000-01-01',runtime:121,overview:'Verified.',genres:[{id:27,name:'Horror'}],credits:{cast:[],crew:[]}}):undefined);try{
    recordRecommendations(f.db,report([201]),{result:{mode:'live',status:'ok',result_id:randomUUID(),generated_at:new Date().toISOString(),recommendations:[choice(201)]}},{dryRun:false});const previous=readRecommendationBatch(f.db)!.result_id;
    await assert.rejects(()=>generateRecommendationBatch(randomUUID(),{open:f.open,config,fetch:h.fetch,sleep:async()=>{}},{preferences:wishes({max_runtime:100,avoid_horror:true})}),/no_candidates/);assert.equal(h.bodies.length,1);assert.equal(readRecommendationBatch(f.db)!.result_id,previous);
  }finally{f.cleanup();}
});
test('mismatched prepared snapshots rollback and historical batches remain unlabelled',()=>{
  const f=fixture();try{
    const ranking={mode:'live',status:'ok',result_id:randomUUID(),generated_at:new Date().toISOString(),recommendations:[choice()]};
    assert.throws(()=>recordRecommendations(f.db,{...report([201]),preferences:wishes({mood:'warm'})},{result:{...ranking,preferences:wishes({mood:'funny'})}},{dryRun:false}),/disagree/);
    recordRecommendations(f.db,report([201]),{result:ranking},{dryRun:false});assert.equal(readRecommendationBatch(f.db)!.preferences,null);assert.equal(preferencesLabel(null),'Персональная подборка');
  }finally{f.cleanup();}
});
test('home summary bounded/deterministic: ratings first, diversity among ties, no writes; zero counted',()=>{
  const f=candidatesFixture();try{
    const before=readFileSync(f.path),a=readHomeSummary(f.db);assert.equal(a.favorites.length,6);assert.ok(a.favorites.slice(0,6).every((x,i,all)=>i===0||all[i-1].rating_100>=x.rating_100));assert.deepEqual(readHomeSummary(f.db),a);assert.deepEqual(readFileSync(f.path),before);
    assert.ok(a.favorites.some(x=>x.movie_id===14));assert.ok(a.favorites.every(x=>x.rating_100>=80));
    f.db.prepare('UPDATE user_movies SET rating_100=NULL').run();assert.equal(readHomeSummary(f.db).favorites.length,0);
    f.db.prepare('UPDATE user_movies SET rating_100=0 WHERE movie_id=1').run();assert.equal(readHomeSummary(f.db).stats.rated,1);
    f.db.exec('DELETE FROM user_movies');assert.deepEqual(readHomeSummary(f.db),{stats:{watched:0,rated:0},favorites:[]});
  }finally{f.cleanup();}
});
for(const n of [5,4,3,2,1,0])test(`gallery renders ${n} equal cards and preserves full text for details`,()=>{
  const rows=Array.from({length:n},(_,i)=>({...movie(201+i),poster_path:null,backdrop_path:null,movie_id:100+i,why_fit:'Full original explanation',possible_mismatch:'Original uncertainty',genres:['Drama']}));
  const html=renderToStaticMarkup(<HomeGallery batch={{result_id:randomUUID(),generated_at:null,recommended_at:'2020-01-01',time_kind:'recorded',preferences:wishes({mood:'funny'}),total_count:5,hidden_count:5-n,unavailable_count:0,movies:rows}} busy={false} onWatch={()=>{}} onReject={async()=>true}/>);
  assert.equal((html.match(/class="gallery-card"/g)??[]).length,n);assert.ok(!html.includes('movie-rail'));assert.equal((html.match(/class="gallery-open"/g)??[]).length,n);assert.ok(!html.includes('Full original explanation'));if(!n)assert.ok(html.includes('Эту подборку ты уже разобрал'));
});
test('empty favorites retain compact navigation and true zero counters',()=>{
  const html=renderToStaticMarkup(<HomeLibrary home={{favorites:[],stats:{watched:0,rated:0}}}/>);assert.ok(html.includes('Открыть библиотеку'));assert.ok(html.includes('0 просмотрено · 0 оценено'));
});

test('bounded Unicode contexts retain wishes and every rating change when optional text shrinks', async()=>{
  const { contextFixture } = await import('./fixtures/taste-context-v2');
  const f=contextFixture('large');try{
    f.db.prepare('UPDATE user_movies SET rating_100=0 WHERE movie_id=10').run();
    const p=wishes({mood:'outstanding',max_runtime:100,avoid_horror:true,avoid_heavy:true,avoid_slow:true});
    const normal=buildCandidateContext(f.db,undefined,p),small=buildCandidateContext(f.db,14000,p),ranking=buildRankingContext(f.db,f.candidates,45000,p);
    assert.deepEqual(small.context.rating_changes,normal.context.rating_changes);assert.deepEqual(ranking.context.rating_changes,normal.context.rating_changes);
    assert.deepEqual(small.context.request_preferences,p);assert.deepEqual(ranking.context.request_preferences,p);
    assert.ok(Buffer.byteLength(serialize({...small,format:CANDIDATE_FORMAT}))<=14000);assert.ok(Buffer.byteLength(serialize(ranking))<=45000);
    assert.throws(()=>buildCandidateContext(f.db,100,p),/limit/);
  }finally{f.cleanup();}
});
test('old prepared journal with no wishes can still recover without retroactive labelling',async()=>{
  const f=fixture(),h=mockProvider([201]),key=randomUUID();try{
    f.db.exec("CREATE TRIGGER legacy_fail BEFORE INSERT ON recommendation_evaluation BEGIN SELECT RAISE(ABORT,'Synthetic'); END");
    await assert.rejects(()=>generateRecommendationBatch(key,{open:f.open,config,fetch:h.fetch,sleep:async()=>{}}),/save_failed/);
    const store=runStore(f.path),run=store.read(key)!;delete run.preferences;
    if(run.candidates?.mode==='live')delete run.candidates.preferences;
    delete run.ranking!.preferences;store.write(run);f.db.exec('DROP TRIGGER legacy_fail');
    const res=await generateRecommendationBatch(key,{open:f.open},{saveOnly:true});assert.equal(res.batch?.preferences,null);assert.equal(h.bodies.length,2);
  }finally{f.cleanup();}
});

test('compact favorites show only first four from server order with genuine personal scores',()=>{
  const favorites=Array.from({length:6},(_,i)=>({movie_id:i+1,title:`Favorite ${i+1}`,year:2000,poster_path:null,rating_100:100-i}));
  const html=renderToStaticMarkup(<HomeLibrary home={{favorites,stats:{watched:10,rated:7}}}/>);
  assert.equal((html.match(/class="favorite-card"/g)??[]).length,4);assert.ok(html.includes('Favorite 1'));assert.ok(html.includes('Favorite 4'));assert.ok(!html.includes('Favorite 5'));assert.ok(html.includes('100/100'));assert.ok(html.includes('10 просмотрено · 7 оценено'));
});
