import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture, mockProvider, config, personal, report, choice } from './fixtures/recommendation-screen';
import { generateRecommendationBatch, recommendationState } from '../src/lib/recommendation-service';
import { readRecommendationBatch } from '../src/lib/recommendation-batches';
import { runStore, GenerationError } from '../src/lib/recommendation-runs';
import { recommendationHandlers } from '../src/lib/recommendations-http';
import { recordRecommendations, rejectRecommendation } from '../src/lib/recommendation-memory';
import { blockedReason, readCandidateHistory } from '../src/lib/candidate-context';
import { parseCandidateReport } from '../src/lib/recommendation-schema';
import { migrateDatabase, SCHEMA_VERSION } from '../src/lib/migrations';
const ranking = (id: string = randomUUID(), ids = [201,202]) => ({ mode: 'live', status: 'ok', result_id: id, generated_at: new Date(Date.now()-10).toISOString(), recommendations: ids.map(choice) });
const errorCode = (code: string) => (error: unknown) => error instanceof GenerationError && error.code === code;
const noSleep = async () => {};
const count = (f: ReturnType<typeof fixture>) => (f.db.prepare('SELECT count(*) n FROM recommendations').get() as { n: number }).n;

test('schemas 3–6 read without migration or writes; migration preserves rows and nullable images', () => {
  for (const version of [3,4,5,6]) {
    const f = fixture(version);
    try {
      const before = readFileSync(f.path), p = personal(f.db);
      assert.equal(recommendationState({ open: f.open, config }).batch, null);
      assert.deepEqual(readFileSync(f.path), before);
      migrateDatabase(f.db); assert.equal(f.db.pragma('user_version',{simple:true}),SCHEMA_VERSION); assert.equal(personal(f.db),p);
      assert.deepEqual(f.db.prepare('SELECT backdrop_path FROM movies').all(), Array(3).fill({backdrop_path:null}));
    } finally { f.cleanup(); }
  }
});
test('latest complete group preserves insertion order, excludes manual/incomplete and never falls back when exhausted', () => {
  const f = fixture();
  try {
    const old = ranking(); recordRecommendations(f.db,report(),{result:old},{dryRun:false});
    const latest = ranking(randomUUID(),[204,203]); recordRecommendations(f.db,report([204,203]),{result:latest},{dryRun:false});
    recordRecommendations(f.db,report([205]),{tmdbIds:[205]},{dryRun:false});
    f.db.prepare('INSERT INTO recommendations(movie_id,result_id,why_fit) VALUES(?,?,?)').run(1,randomUUID(),'incomplete');
    f.db.prepare('INSERT INTO recommendations(movie_id,result_id,why_fit,possible_mismatch) VALUES(?,?,?,?)').run(1,'arbitrary-operation','Some text','Some risk');
    let batch = readRecommendationBatch(f.db)!; assert.equal(batch.result_id,latest.result_id); assert.deepEqual(batch.movies.map(row=>row.tmdb_id),[204,203]);
    assert.equal(batch.time_kind,'generated'); assert.equal(batch.generated_at,latest.generated_at);
    f.db.exec('INSERT INTO user_movies(movie_id,watched) SELECT id,1 FROM movies WHERE tmdb_id IN(203,204)');
    batch = readRecommendationBatch(f.db)!; assert.equal(batch.result_id,latest.result_id); assert.equal(batch.movies.length,0); assert.equal(batch.hidden_count,2);
  } finally { f.cleanup(); }
});
test('legacy complete groups use recorded time; cooldown does not hide saved films, undo restores historical rejection', () => {
  const f = fixture();
  try {
    const result = ranking('legacy:verified'); recordRecommendations(f.db,report(),{result},{dryRun:false});
    let batch = readRecommendationBatch(f.db)!; assert.equal(batch.generated_at,null); assert.equal(batch.time_kind,'recorded'); assert.equal(batch.movies.length,2);
    assert.equal(blockedReason({id:201,title:'Film 201',original_title:null,year:2000},readCandidateHistory(f.db)),'recently_recommended');
    rejectRecommendation(f.db,201); assert.equal(readRecommendationBatch(f.db)!.movies.length,1);
    rejectRecommendation(f.db,201,true); assert.equal(readRecommendationBatch(f.db)!.movies.length,2);
    f.db.exec('UPDATE movies SET runtime_minutes=30 WHERE tmdb_id=202'); batch = readRecommendationBatch(f.db)!; assert.equal(batch.unavailable_count,1);
  } finally { f.cleanup(); }
});
test('optional images survive validation and saving; existing originals and images are never overwritten', () => {
  const f = fixture();
  try {
    const old = report(); delete old.candidates[0].poster_path; delete old.candidates[0].backdrop_path;
    assert.equal(parseCandidateReport(old).candidates.length,2);
    const malicious = report(); malicious.candidates[0].backdrop_path='https://invalid.test/x.jpg'; assert.equal(parseCandidateReport(malicious).candidates.length,1);
    f.db.exec("INSERT INTO movies(tmdb_id,title,poster_path,letterboxd_uri) VALUES(201,'Original title','/old.jpg','https://letterboxd.test/original')");
    const before = personal(f.db); recordRecommendations(f.db,report(),{result:ranking()},{dryRun:false});
    assert.deepEqual(f.db.prepare('SELECT title,poster_path,backdrop_path,letterboxd_uri FROM movies WHERE tmdb_id=201').get(),{title:'Original title',poster_path:'/old.jpg',backdrop_path:'/backdrop.jpg',letterboxd_uri:'https://letterboxd.test/original'});
    assert.equal(personal(f.db),before); assert.deepEqual(f.db.prepare('SELECT poster_path,backdrop_path FROM movies WHERE tmdb_id=202').get(),{poster_path:'/poster.jpg',backdrop_path:'/backdrop.jpg'});
  } finally { f.cleanup(); }
});
test('one cycle performs candidates then ranking, stores short batch, replays after process restart without API', async () => {
  const f = fixture(3), h = mockProvider(), id = randomUUID(), before = personal(f.db);
  try {
    const result = await generateRecommendationBatch(id,{open:f.open,config,fetch:h.fetch,sleep:noSleep});
    assert.equal(result.saved_count,2); assert.equal(result.batch!.movies.length,2); assert.equal(h.bodies.length,2);
    assert.equal((h.bodies[0].text as {format:{name:string}}).format.name,'movie_candidates');
    assert.equal((h.bodies[1].text as {format:{name:string}}).format.name,'personal_movie_ranking');
    for (const body of h.bodies) { assert.equal(body.store,false); assert.equal(body.max_output_tokens,12000); assert.ok(!JSON.stringify(body.input).includes('/backdrop.jpg')); }
    assert.equal(personal(f.db),before); assert.equal(f.db.pragma('user_version',{simple:true}),SCHEMA_VERSION);
    const replay = await generateRecommendationBatch(id,{open:f.open,config:()=>({}),fetch:async()=>{throw Error('No network');}}); assert.equal(replay.replayed,true); assert.equal(count(f),2);
    const child = spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',`import {generateRecommendationBatch} from './src/lib/recommendation-service.ts'; const r=await generateRecommendationBatch('${id}'); console.log(r.replayed);`],{cwd:resolve('.'),env:{...process.env,DATABASE_PATH:f.path,OPENAI_API_KEY:'',OPENAI_MODEL:'',TMDB_API_KEY:''},encoding:'utf8'});
    assert.equal(child.status,0,child.stderr); assert.equal(child.stdout.trim(),'true');
    const journal = runStore(f.path).read(id)!; assert.equal(journal.stage,'saved'); assert.deepEqual(journal.calls,{openai:2,tmdb:5});
    assert.ok(!JSON.stringify(journal).includes('strong_preferences')); assert.ok(!JSON.stringify(journal).includes('mock-openai'));
    const folder = join(f.dir,'.recommendation-runs',readdirSync(join(f.dir,'.recommendation-runs'))[0]); assert.equal(statSync(join(folder,`${id}.json`)).mode & 0o777,0o600);
  } finally { f.cleanup(); }
});
test('preflight config/profile/ratings and backup failure stop before paid requests', async () => {
  const f = fixture(); let calls = 0; const deps = {open:f.open,config,fetch:async()=>{calls++;throw Error('Forbidden');}};
  try {
    await assert.rejects(generateRecommendationBatch(randomUUID(),{...deps,config:()=>({})}),errorCode('configuration_missing'));
    await assert.rejects(generateRecommendationBatch(randomUUID(),{...deps,backup:async()=>{throw Error('secret path');}}),errorCode('backup_failed'));
    f.db.exec('UPDATE user_movies SET rating_100=NULL'); await assert.rejects(generateRecommendationBatch(randomUUID(),deps),errorCode('ratings_missing'));
    f.db.exec('DELETE FROM taste_profile'); await assert.rejects(generateRecommendationBatch(randomUUID(),deps),errorCode('profile_unavailable'));
    assert.equal(calls,0); assert.equal(count(f),0);
  } finally { f.cleanup(); }
});
test('technical partial candidate result stops before ranking and retains previous batch', async () => {
  const f = fixture(), h = mockProvider([201,202],url=>url.pathname==='/3/movie/202'?Response.json({}, {status:401}):undefined);
  try {
    recordRecommendations(f.db,report([203]),{result:ranking(randomUUID(),[203])},{dryRun:false});
    const previous = readRecommendationBatch(f.db), id = randomUUID();
    await assert.rejects(generateRecommendationBatch(id,{open:f.open,config,fetch:h.fetch,sleep:noSleep}),errorCode('candidates_failed'));
    assert.equal(h.bodies.length,1); assert.deepEqual(readRecommendationBatch(f.db),previous); assert.equal(count(f),1);
    await assert.rejects(generateRecommendationBatch(id,{open:f.open,config,fetch:h.fetch,sleep:noSleep}),errorCode('generation_failed_before')); assert.equal(h.bodies.length,1);
  } finally { f.cleanup(); }
});
test('candidate API refusal/incomplete, empty results and ranking errors never save or retry', async () => {
  for (const mode of ['refusal','incomplete','empty','ranking'] as const) {
    const f = fixture(); let paid = 0;
    const h = mockProvider(mode==='empty'?[]:[201],(url)=>{
      if(url.hostname!=='api.openai.com')return;
      paid++;
      if(mode==='refusal'||(mode==='ranking'&&paid===2)) return Response.json({status:'completed',model:'mock-model',output:[{type:'message',content:[{type:'refusal',refusal:'No'}]}]});
      if(mode==='incomplete')return Response.json({status:'incomplete',model:'mock-model',output:[]});
    });
    try { await assert.rejects(generateRecommendationBatch(randomUUID(),{open:f.open,config,fetch:h.fetch,sleep:noSleep})); assert.equal(count(f),0); assert.equal(paid,mode==='ranking'?2:1); }
    finally { f.cleanup(); }
  }
});
test('SQL failure rolls back images and movies; free save retry with no config, fresh backup and fresh evidence', async () => {
  const f = fixture(), h = mockProvider(), id = randomUUID(); let backups = 0;
  const backup = async (db: typeof f.db) => { backups++; await db.backup(join(f.dir,`b${backups}.sqlite`)); };
  try {
    f.db.exec("CREATE TRIGGER fail_save BEFORE INSERT ON recommendations WHEN (SELECT tmdb_id FROM movies WHERE id=NEW.movie_id)=202 BEGIN SELECT RAISE(ABORT,'private SQL path'); END");
    await assert.rejects(generateRecommendationBatch(id,{open:f.open,config,fetch:h.fetch,sleep:noSleep,backup}),errorCode('save_failed'));
    assert.equal(count(f),0); assert.equal(f.db.prepare('SELECT id FROM movies WHERE tmdb_id=201').get(),undefined);
    assert.equal(recommendationState({open:f.open,config}).generation.recoverable_save,true);
    f.db.exec('DROP TRIGGER fail_save');
    const saved = await generateRecommendationBatch(id,{open:f.open,config:()=>({}),fetch:async()=>{throw Error('No network');},backup},{saveOnly:true});
    assert.equal(saved.saved_count,2); assert.equal(backups,2); assert.equal(h.bodies.length,2);
  } finally { f.cleanup(); }
});
test('save-only missing journal never pays; stale evidence on recovery cannot be saved', async () => {
  const f = fixture(), h = mockProvider(), id = randomUUID();
  try {
    await assert.rejects(generateRecommendationBatch(id,{open:f.open,config,fetch:h.fetch},{saveOnly:true}),errorCode('saved_result_unavailable')); assert.equal(h.calls.length,0);
    f.db.exec("CREATE TRIGGER fail_save BEFORE INSERT ON recommendations BEGIN SELECT RAISE(ABORT,'failed'); END");
    await assert.rejects(generateRecommendationBatch(id,{open:f.open,config,fetch:h.fetch,sleep:noSleep}));
    f.db.exec('DROP TRIGGER fail_save; UPDATE user_movies SET rating_100=0 WHERE movie_id=1');
    await assert.rejects(generateRecommendationBatch(id,{open:f.open,config,fetch:h.fetch},{saveOnly:true}),errorCode('no_eligible_recommendations'));
    assert.equal(count(f),0); assert.equal(h.bodies.length,2);
  } finally { f.cleanup(); }
});
test('exclusive lock across processes, same-ID conflict and interrupted journal prevent payment', async () => {
  const f = fixture(), id = randomUUID(), store = runStore(f.path), release = store.acquire(id), h = mockProvider();
  try {
    store.write({request_id:randomUUID(),stage:'saved',started_at:new Date().toISOString()});
    assert.equal(recommendationState({open:f.open,config}).generation.request_id,id);
    assert.equal(recommendationState({open:f.open,config}).generation.stage,'starting');
    const child = spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',`import {runStore} from './src/lib/recommendation-runs.ts'; try {runStore(${JSON.stringify(f.path)}).acquire('${randomUUID()}');process.exit(9)} catch(e) {console.log(e.code)}`],{cwd:resolve('.'),encoding:'utf8'});
    assert.equal(child.status,0,child.stderr); assert.equal(child.stdout.trim(),'generation_busy');
    await assert.rejects(generateRecommendationBatch(id,{open:f.open,config,fetch:h.fetch}),errorCode('generation_busy'));
    assert.equal(h.calls.length,0);
  } finally { release(); }
  try {
    store.write({request_id:id,stage:'ranking',started_at:new Date().toISOString()});
    await assert.rejects(generateRecommendationBatch(id,{open:f.open,config,fetch:h.fetch}),errorCode('generation_interrupted')); assert.equal(h.calls.length,0);
    writeFileSync(`${f.path}.recommendations.lock`,JSON.stringify({pid:99999999,request_id:id}));
    assert.equal(recommendationState({open:f.open,config}).generation.state,'interrupted'); assert.ok(statSync(`${f.path}.recommendations.lock`));
  } finally { f.cleanup(); }
});
test('a stale lock with a reused container PID is interrupted and is never removed or resumed', async () => {
  const f = fixture(), id = randomUUID(), h = mockProvider();
  try {
    // A rapid restart can reuse a PID less than one second after the old lock.
    const beforeProcessStart = new Date(Date.now() - process.uptime() * 1000 - 100).toISOString();
    writeFileSync(`${f.path}.recommendations.lock`, JSON.stringify({ pid: process.pid, request_id: id, started_at: beforeProcessStart }));
    assert.equal(runStore(f.path).ownerAlive(), false);
    assert.equal(recommendationState({ open: f.open, config }).generation.state, 'interrupted');
    await assert.rejects(generateRecommendationBatch(id, { open: f.open, config, fetch: h.fetch }), errorCode('generation_busy'));
    assert.equal(h.calls.length, 0);
    assert.ok(statSync(`${f.path}.recommendations.lock`));
  } finally { f.cleanup(); }
});
test('deadline aborts fetch but keeps lock until network settles, then never retries the failed request', async () => {
  const f = fixture(), id = randomUUID(); let aborted = false, lockedWhileSettling = false, calls = 0;
  try {
    await assert.rejects(generateRecommendationBatch(id,{open:f.open,config,timeoutMs:250,fetch:async(_input,init)=>{
      calls++; await new Promise<void>(resolve=>init!.signal!.addEventListener('abort',()=>{aborted=true;setTimeout(()=>{lockedWhileSettling=runStore(f.path).locked();resolve();},20)},{once:true})); throw Error('Aborted');
    }}),errorCode('generation_timeout'));
    assert.equal(aborted,true); assert.equal(lockedWhileSettling,true); assert.equal(runStore(f.path).locked(),false); assert.equal(calls,1);
    await assert.rejects(generateRecommendationBatch(id,{open:f.open,config}),errorCode('generation_failed_before'));
  } finally { f.cleanup(); }
});
test('HTTP strict JSON, Origin, bounded body and safe errors occur before opening SQLite; GET never networks', async () => {
  let opens = 0;
  const handlers = recommendationHandlers({open:()=>{opens++;throw Error('secret /path key');}});
  const req = (body:unknown, headers:Record<string,string>={})=>new Request('http://localhost/api/recommendations/generate',{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
  for(const body of [{},{request_id:randomUUID(),confirmed:false},{request_id:'bad',confirmed:true},{request_id:randomUUID(),confirmed:true,extra:1}]) assert.equal((await handlers.generate(req(body))).status,400);
  assert.equal((await handlers.generate(req({request_id:randomUUID(),confirmed:true},{origin:'null'}))).status,403);
  assert.equal((await handlers.get(new Request('http://localhost/api/recommendations',{headers:{origin:'https://evil.test'}}))).status,403);
  assert.equal((await handlers.generate(req({request_id:'x'.repeat(1100),confirmed:true}))).status,400); assert.equal(opens,0);
  const response = await handlers.get(); assert.equal(response.status,503); assert.equal(response.headers.get('cache-control'),'no-store'); assert.ok(!(await response.text()).includes('/path'));
  const f=fixture(3);try { const before=readFileSync(f.path); const h=recommendationHandlers({open:f.open,config,fetch:async()=>{throw Error('No network');}}); assert.equal((await h.get()).status,200); assert.deepEqual(readFileSync(f.path),before); } finally { f.cleanup(); }
});
test('HTTP disconnect does not cancel already confirmed generation; GET and repeated request do not pay again', async () => {
  const f = fixture(), h=mockProvider(), id=randomUUID(), controller=new AbortController(); let started!:()=>void;
  const gate = new Promise<void>(resolve=>{started=resolve;});
  const provider:typeof fetch=async(input,init)=>{started();await delay(25);return h.fetch(input,init);};
  try {
    const handlers=recommendationHandlers({open:f.open,config,fetch:provider,sleep:noSleep});
    const make=()=>new Request('http://localhost/api/recommendations/generate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({request_id:id,confirmed:true}),signal:controller.signal});
    const job=handlers.generate(make()); await gate; controller.abort();
    assert.equal((await handlers.generate(new Request('http://localhost/api/recommendations/generate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({request_id:id,confirmed:true})}))).status,409);
    assert.equal((await job).status,201); assert.equal(count(f),2); assert.equal(h.bodies.length,2);
    const response=await handlers.get(); assert.equal(response.status,200); assert.equal(h.bodies.length,2);
  } finally { f.cleanup(); }
});

test('damaged private journal blocks generation controls but preserves the previous readable SQL batch', async () => {
  const f=fixture(), id=randomUUID();
  try {
    recordRecommendations(f.db,report(),{result:ranking()},{dryRun:false});
    runStore(f.path).write({request_id:id,stage:'ranking',started_at:new Date().toISOString()});
    const folder=join(f.dir,'.recommendation-runs',readdirSync(join(f.dir,'.recommendation-runs'))[0]);
    writeFileSync(join(folder,'latest.json'),'{damaged');
    const response=await recommendationHandlers({open:f.open,config}).get(); assert.equal(response.status,200);
    const state=await response.json(); assert.equal(state.batch.movies.length,2); assert.equal(state.generation.state,'interrupted');
    assert.equal(state.generation.recoverable_save,false);
  } finally { f.cleanup(); }
});
