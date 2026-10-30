import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { test } from 'node:test';
import { migrateDatabase } from '../src/lib/migrations';
import { buildTasteContext } from '../src/lib/taste-context';
import { buildRankingContext } from '../src/lib/recommendation-context';
import { parseCandidateReport, validateRanking } from '../src/lib/recommendation-schema';
import { rankRecommendations } from '../src/lib/recommendations';
import { generateCandidates, type MovieCandidate } from '../src/lib/candidates';

const movie = (id=201, patch: Record<string,unknown>={}): MovieCandidate => ({tmdb_id:id,media_type:'movie',title:`Candidate ${id}`,original_title:null,year:2000,
  overview:'A confirmed story about a difficult choice.',genres:[{id:1,name:'Drama'}],runtime:100,directors:[{id:10,name:'Director'}],vote_count:0,popularity:0,source:'llm',...patch});
const report = (candidates:unknown[]=[movie()],patch:Record<string,unknown>={}) => ({mode:'live',status:'ok',candidates,...patch});
const recommendation = (id=201,patch:Record<string,unknown>={}) => ({tmdb_id:id,why_fit:'The confirmed premise offers a cautious parallel to your highly rated example.',
  possible_mismatch:'The supplied metadata does not establish pacing; this remains uncertain.',evidence:[{movie_id:1,rating_100:100}],...patch});
const response = (recommendations:unknown[]=[recommendation()],patch:Record<string,unknown>={}) => Response.json({status:'completed',model:'returned-model',usage:{input_tokens:500,output_tokens:150},
  output:[{type:'reasoning',summary:[]},{type:'message',status:'completed',content:[{type:'output_text',text:JSON.stringify({recommendations})}]}],...patch});
function fixture(profile=true) {
  const dir=mkdtempSync(join(tmpdir(),'ranking-')),path=join(dir,'movies.sqlite'),db=new Database(path);db.pragma('foreign_keys=ON');migrateDatabase(db);
  const add=db.prepare(`INSERT INTO movies(id,title,release_year,tmdb_id,media_type,runtime_minutes,overview,genres_json,directors_json)
    VALUES(?,?,?,?,'movie',100,'A confirmed plot.','[{"id":1,"name":"Drama"},{"id":2,"name":"Thriller"}]','[{"id":10,"name":"Director"}]')`);
  const personal=db.prepare('INSERT INTO user_movies(user_id,movie_id,watched,rating_100,not_interested) VALUES(\'ilya\',?,?,?,?)');
  for(const [id,title,year,tmdb,watched,rating,hidden] of [
    [1,'Favourite',2000,101,1,100,0],[2,'Disliked',2000,102,1,0,0],[3,'Unrated',2000,103,1,null,0],
    [4,'Watched Without ID',2000,null,1,null,0],[5,'Uncertain History',null,null,1,null,0],
    [6,'Hidden',2000,106,0,null,1],[7,'Hidden Without ID',2000,null,0,null,1],
    [8,'Rated Without ID',2000,null,1,90,0],[9,'Unseen Library Movie',2000,109,0,null,0],
  ] as const){add.run(id,title,year,tmdb);personal.run(id,watched,rating,hidden);}
  db.prepare('INSERT INTO recommendations(user_id,movie_id) VALUES(\'ilya\',1)').run();
  if(profile)saveProfile(db);
  return {db,path,dir,cleanup(){db.close();rmSync(dir,{recursive:true,force:true});}};
}
function saveProfile(db:Database.Database){
  const context=buildTasteContext(db, 'ilya');
  db.prepare('INSERT INTO taste_profile(user_id,profile_json) VALUES(\'ilya\',?)').run(JSON.stringify({
    strong_preferences:[{summary:'Positive preference',explanation:'A real high rating supports this cautious observation.',kind:'observation',uncertainty:'Limited evidence.',evidence:[{movie_id:1,rating_100:100},{movie_id:8,rating_100:90}]}],
    negative_patterns:[{summary:'Negative pattern',explanation:'The real zero rating is a counterexample.',kind:'hypothesis',uncertainty:'The cause is unproven.',evidence:[{movie_id:2,rating_100:0}]}],
    contrasts:[{higher:{movie_id:1,rating_100:100},lower:{movie_id:2,rating_100:0},similarity:'Shared director and genres.',possible_difference:'An uncertain difference.',uncertainty:'No confirmed cause.'}],
    uncertainties:[{description:'Some works lack metadata.',evidence:[]}],profile_version:1,generated_at:new Date().toISOString(),ratings_count:context.snapshot.length,
    ratings_snapshot:context.snapshot,context_fingerprint:context.fingerprint,prompt_version:1,schema_version:1,contrast_pairs_count:context.context.contrast_pairs.length,
    requested_model:'configured-model',model:'configured-model',response_id:null,usage:null,
  }));
}
function harness(handler?: (init:RequestInit)=>Response|Promise<Response>){
  const requests:{url:string;body:Record<string,unknown>}[]=[];
  return {requests,options:{live:true,apiKey:'mock-ranking-key',model:'configured-model',fetch:(async(input,init)=>{
    requests.push({url:String(input),body:JSON.parse(String(init?.body))});return handler?handler(init!):response();
  }) as typeof fetch}};
}
const snapshot=(db:Database.Database)=>['movies','user_movies','taste_profile','recommendations'].map(name=>db.prepare(`SELECT * FROM ${name} ORDER BY 1`).all());

test('five ranked choices preserve LLM order, resolve evidence in SQLite, use one request and never write the DB',async()=>{
  const f=fixture(),ids=[205,202,201,204,203],h=harness(()=>response(ids.map(id=>recommendation(id))));const before=readFileSync(f.path);f.db.pragma('query_only=ON');
  try{
    const result=await rankRecommendations(f.db, 'ilya',report(ids.map(id=>movie(id))),h.options);
    assert.equal(result.status,'ok');assert.deepEqual(result.recommendations.map(row=>row.tmdb_id),ids);assert.equal(result.statistics.openai_requests,1);assert.equal(result.statistics.tmdb_requests,0);
    assert.equal(result.recommendations[0].title,'Candidate 205');assert.deepEqual(result.recommendations[0].evidence,[{movie_id:1,rating_100:100,title:'Favourite',year:2000}]);
    assert.deepEqual(result.statistics.usage,{input_tokens:500,output_tokens:150});assert.equal(result.statistics.model,'returned-model');assert.equal(h.requests.length,1);
    const req=h.requests[0];assert.equal(req.url,'https://api.openai.com/v1/responses');assert.equal(req.body.model,'configured-model');assert.equal(req.body.store,false);assert.equal(req.body.max_output_tokens,12000);
    const format=(req.body.text as {format:{schema:{properties:{recommendations:{items:{properties:{tmdb_id:{enum:number[]}}}}}}}}).format;
    assert.deepEqual(format.schema.properties.recommendations.items.properties.tmdb_id.enum,ids);
    assert.ok(!JSON.stringify(result).includes('mock-ranking-key'));assert.deepEqual(readFileSync(f.path),before);
  }finally{f.cleanup();}
});

test('one or fewer-than-five valid choices succeed without padding and partial candidate reports warn',async()=>{
  const f=fixture(),h=harness();
  try{const result=await rankRecommendations(f.db, 'ilya',report([movie()],{status:'partial'}),h.options);assert.equal(result.status,'ok');assert.equal(result.recommendations.length,1);assert.ok(result.warnings.some(row=>row.includes('partial')));}
  finally{f.cleanup();}
});

test('foreign and duplicate output IDs are discarded, first valid occurrence wins and order is preserved',async()=>{
  const f=fixture(),h=harness(()=>response([recommendation(999),recommendation(201,{why_fit:''}),recommendation(201),recommendation(201),recommendation(202)]));
  try{const result=await rankRecommendations(f.db, 'ilya',report([movie(201),movie(202)]),h.options);assert.equal(result.status,'ok');assert.deepEqual(result.recommendations.map(row=>row.tmdb_id),[201,202]);
    assert.deepEqual(result.diagnostics.map(row=>row.reason),['outside_candidate_set','invalid_explanation','duplicate_recommendation']);
  }finally{f.cleanup();}
});

test('all invalid output or malformed root fails without fallback, padding or another request',async()=>{
  const f=fixture();
  try{for(const body of [[],[recommendation(999)],[recommendation(201,{predicted_rating:99})]]){
    const h=harness(()=>response(body));const result=await rankRecommendations(f.db, 'ilya',report(),h.options);assert.equal(result.status,'error');assert.equal(result.recommendations.length,0);assert.equal(h.requests.length,1);
  }
  for(const value of [{},[],{recommendations:[recommendation()],extra:true},{recommendations:Array(6).fill(recommendation())}])assert.throws(()=>validateRanking(value,[movie()],[{movie_id:1,rating_100:100}]));
  }finally{f.cleanup();}
});

test('input excludes watched NULL ratings, no-ID aliases, uncertain years, hidden, TV and invalid runtimes before API',async()=>{
  const f=fixture(),h=harness();
  f.db.exec("UPDATE movies SET original_title='Original Watched' WHERE id=4");
  const input=[movie(103,{title:'Unrated'}),movie(301,{title:'Original Watched'}),movie(302,{title:'Uncertain History'}),movie(106,{title:'Hidden'}),
    movie(303,{title:'Hidden Without ID'}),movie(304,{media_type:'tv'}),movie(305,{runtime:59}),movie(306,{runtime:null}),movie(307,{overview:' '}),movie()];
  try{const result=await rankRecommendations(f.db, 'ilya',report(input),h.options);assert.equal(result.status,'ok');assert.equal(result.eligible_count,1);assert.equal(result.recommendations.length,1);
    assert.deepEqual(result.diagnostics.map(row=>row.reason).sort(),['watched','watched_without_tmdb_id','uncertain_history_match','not_interested','not_interested','not_movie','short_film','unknown_runtime','invalid_candidate_metadata'].sort());
    const data=JSON.parse((h.requests[0].body.input as {content:string}[])[1].content);assert.deepEqual(data.candidates.map((row:{tmdb_id:number})=>row.tmdb_id),[201]);
  }finally{f.cleanup();}
});

test('malformed candidate reports, missing movie marker, duplicate IDs and more than 40 inputs stop before API',async()=>{
  const f=fixture(),h=harness();const legacy={...movie()} as Record<string,unknown>;delete legacy.media_type;
  try{for(const value of [report([legacy]),report([movie(),movie()]),report(Array.from({length:41},(_,i)=>movie(i+300))),report([],{mode:'dry-run'}),report([],{status:'error'}),{},[]]){
    await assert.rejects(()=>rankRecommendations(f.db, 'ilya',value,h.options));
  }assert.equal(h.requests.length,0);
    const bad=[movie(301,{runtime:60.5}),movie(302,{vote_count:-1}),movie(303,{popularity:Infinity}),movie(304,{genres:[{id:0,name:'Drama'}]}),movie(305,{source:['llm']}),movie(306,{year:'2000'}),movie(307,{tmdb_id:1.5}),movie(308,{directors:[{id:1,name:' '}]})];
    assert.equal(parseCandidateReport(report(bad)).candidates.length,0);
    const empty=await rankRecommendations(f.db, 'ilya',report([movie(201,{runtime:59})]),h.options);assert.equal(empty.status,'error');assert.equal(empty.statistics.openai_requests,0);
  }finally{f.cleanup();}
});

test('current evidence includes zero and no-ID ratings, excludes NULL, and carries all new/changed/cleared ratings',()=>{
  const f=fixture();
  try{f.db.exec('UPDATE user_movies SET rating_100=NULL WHERE movie_id=1; UPDATE user_movies SET rating_100=60 WHERE movie_id=8; UPDATE user_movies SET rating_100=80 WHERE movie_id=3');
    const context=buildRankingContext(f.db, 'ilya',[movie()]);assert.equal(context.summary.profile_status,'stale');
    assert.deepEqual(context.context.rating_changes.map(row=>[row.movie_id,row.previous_rating_100,row.rating_100]),[[1,100,null],[3,null,80],[8,90,60]]);
    assert.ok(context.snapshot.some(row=>row.movie_id===2&&row.rating_100===0));assert.ok(context.snapshot.some(row=>row.movie_id===8&&row.rating_100===60));assert.ok(!context.snapshot.some(row=>row.movie_id===1));
    assert.match(context.input[0].content,/cleared ratings are no longer/);assert.match(context.input[0].content,/untrusted DATA/);assert.match(context.input[0].content,/counterexamples/);
  }finally{f.cleanup();}
});

test('fabricated, wrong-rating, duplicate, NULL and untransmitted evidence is rejected; zero is valid',async()=>{
  const f=fixture();
  try{const refs=[[],[{movie_id:1,rating_100:99}],[{movie_id:999,rating_100:100}],[{movie_id:1,rating_100:100},{movie_id:1,rating_100:100}],[{movie_id:3,rating_100:0}], [{movie_id:1,rating_100:'100'}]];
    for(const evidence of refs){const h=harness(()=>response([recommendation(201,{evidence})]));const result=await rankRecommendations(f.db, 'ilya',report(),h.options);assert.equal(result.status,'error');assert.equal(result.recommendations.length,0);}
    const h=harness(()=>response([recommendation(201,{evidence:[{movie_id:2,rating_100:0}]})]));
    const good=await rankRecommendations(f.db, 'ilya',report(),h.options);assert.equal(good.status,'ok');assert.equal(good.recommendations[0].evidence[0].rating_100,0);
    const context=buildRankingContext(f.db, 'ilya',[movie()]);const checked=validateRanking({recommendations:[recommendation(201,{evidence:[{movie_id:9,rating_100:80}]})]},[movie()],context.snapshot);assert.equal(checked.recommendations.length,0);
  }finally{f.cleanup();}
});

test('empty, oversized, wrong-type explanations and extra output fields are rejected',()=>{
  for(const patch of [{why_fit:''},{why_fit:'   '},{possible_mismatch:''},{why_fit:'x'.repeat(1001)},{possible_mismatch:'x'.repeat(601)},{why_fit:123},{possible_mismatch:null},{confidence_score:0.99},{tmdb_id:-1},{tmdb_id:201.5}]){
    const checked=validateRanking({recommendations:[recommendation(201,patch)]},[movie()],[{movie_id:1,rating_100:100}]);assert.equal(checked.recommendations.length,0);
  }
});

test('new watched/hidden states are checked immediately before return, including no-ID NULL-rated watches',async()=>{
  for(const mode of ['watched','hidden','fallback'] as const){const f=fixture();const h=harness(()=>{
    if(mode==='fallback')f.db.exec("INSERT INTO movies(title,release_year) VALUES('Candidate 201',2000); INSERT INTO user_movies(user_id,movie_id,watched) VALUES('ilya',last_insert_rowid(),1)");
    else f.db.prepare(`UPDATE user_movies SET ${mode==='watched'?'watched':'not_interested'}=1 WHERE movie_id=9`).run();
    return response([recommendation(mode==='fallback'?201:109)]);
  });
  try{const result=await rankRecommendations(f.db, 'ilya',report([movie(mode==='fallback'?201:109)]),h.options);assert.equal(result.status,'error');assert.equal(result.recommendations.length,0);
    assert.equal(result.diagnostics.at(-1)?.stage,'final');assert.equal(result.diagnostics.at(-1)?.reason,mode==='fallback'?'watched_without_tmdb_id':mode==='watched'?'watched':'not_interested');
  }finally{f.cleanup();}}
});

test('changed or cleared evidence rejects only affected recommendations; unchanged evidence keeps a smaller list',async()=>{
  for(const rating of [null,99]){const f=fixture(),h=harness(()=>{f.db.prepare('UPDATE user_movies SET rating_100=? WHERE movie_id=1').run(rating);return response([recommendation(201),recommendation(202,{evidence:[{movie_id:2,rating_100:0}]})]);});
    try{const result=await rankRecommendations(f.db, 'ilya',report([movie(),movie(202)]),h.options);assert.equal(result.status,'ok');assert.deepEqual(result.recommendations.map(row=>row.tmdb_id),[202]);assert.equal(result.diagnostics[0].reason,'evidence_changed');}
    finally{f.cleanup();}}
});

test('related examples retain middle evidence and diverse fallback without repeating equivalent metadata',()=>{
  const f=fixture();
  try{
    // Mid ratings are not in high/low examples, so all are eligible as related evidence.
    for(const [id,director,genres] of [[20,10,[1]],[21,20,[1,2]],[22,20,[1]],[23,10,[1,2]],[24,99,[9]]] as const){
      f.db.prepare("INSERT INTO movies(id,title,tmdb_id,media_type,runtime_minutes,genres_json,directors_json) VALUES(?,?,?,'movie',100,?,?)").run(id,`Related ${id}`,1000+id,JSON.stringify(genres.map(id=>({id,name:`Genre ${id}`}))),JSON.stringify([{id:director,name:`Director ${director}`}])) ;
      f.db.prepare('INSERT INTO user_movies(user_id,movie_id,watched,rating_100) VALUES(\'ilya\',?,1,70)').run(id);
    }
    const candidates=[movie(201,{genres:[{id:1,name:'Drama'},{id:2,name:'Thriller'}]})];const a=buildRankingContext(f.db, 'ilya',candidates),b=buildRankingContext(f.db, 'ilya',candidates);
    assert.deepEqual(a,b);assert.ok(a.context.related_examples.some(row=>row.movie_id===24));
    assert.ok(a.context.related_examples.some(row=>row.rating_100===70));
    assert.ok(a.context.related_examples.length<5);
    const ids=[...a.context.examples,...a.context.related_examples].map(row=>row.movie_id);assert.equal(new Set(ids).size,ids.length);
  }finally{f.cleanup();}
});

test('budget shortens descriptions while preserving profile/deltas and all candidate IDs',()=>{
  const f=fixture();
  try{f.db.exec('UPDATE user_movies SET rating_100=90 WHERE movie_id=1');
    const candidates=Array.from({length:40},(_,i)=>movie(300+i,{overview:'😀'.repeat(1200)}));
    const full=buildRankingContext(f.db, 'ilya',candidates);assert.ok(full.summary.input_bytes<=200000);assert.ok(full.summary.candidate_overview_limit<1200);
    const reduced=buildRankingContext(f.db, 'ilya',candidates,20000);assert.ok(reduced.summary.input_bytes<=20000);assert.deepEqual(reduced.context.profile,full.context.profile);
    assert.deepEqual(reduced.context.rating_changes,full.context.rating_changes);assert.deepEqual(reduced.context.candidates.map(row=>row.tmdb_id),candidates.map(row=>row.tmdb_id));
    assert.throws(()=>buildRankingContext(f.db, 'ilya',candidates,100),/exceed/);
  }finally{f.cleanup();}
});

test('missing/corrupt profile or absence of current evidence fails before any paid request',async()=>{
  const f=fixture(false),h=harness();
  try{await assert.rejects(()=>rankRecommendations(f.db, 'ilya',report(),h.options),/No saved taste profile/);
    f.db.exec("INSERT INTO taste_profile(user_id,profile_json) VALUES('ilya','{}')");await assert.rejects(()=>rankRecommendations(f.db, 'ilya',report(),h.options),/Invalid saved/);
    f.db.exec('DELETE FROM taste_profile');saveProfile(f.db);f.db.exec('UPDATE user_movies SET rating_100=NULL');
    await assert.rejects(()=>rankRecommendations(f.db, 'ilya',report(),h.options),/No current rated evidence/);assert.equal(h.requests.length,0);
  }finally{f.cleanup();}
});

test('dry-run is read-only, defaults to dry-run without credentials, and CLI rejects malformed files/flags',async()=>{
  const f=fixture(),h=harness(),input=join(f.dir,'candidates.json');writeFileSync(input,JSON.stringify(report()));const before=readFileSync(f.path);f.db.pragma('query_only=ON');
  try{const preview=await rankRecommendations(f.db, 'ilya',report(),{fetch:h.options.fetch});assert.equal(preview.mode,'dry-run');assert.equal(preview.status,'ok');assert.equal(h.requests.length,0);assert.equal(preview.statistics.openai_requests,0);
    const run=(args:string[])=>spawnSync(process.execPath,['--import','tsx','scripts/recommendations-rank.ts','--user','ilya',...args],{cwd:resolve('.'),env:{...process.env,DATABASE_PATH:f.path,OPENAI_API_KEY:'',OPENAI_MODEL:'',TMDB_API_KEY:''},encoding:'utf8'});
    const success=run(['--input',input]);assert.equal(success.status,0,success.stderr);assert.equal(JSON.parse(success.stdout).mode,'dry-run');
    for(const args of [[],['--input',input,'--dry-run','--live'],['--input',input,'--force'],['--input',join(f.dir,'missing.json')]])assert.equal(run(args).status,1);
    writeFileSync(input,'{invalid-json');const invalid=run(['--input',input]);assert.equal(invalid.status,1);assert.match(invalid.stderr,/invalid JSON/);
    assert.deepEqual(readFileSync(f.path),before);
  }finally{f.cleanup();}
});

test('HTTP/JSON/refusal/incomplete/network failures and timeout never fabricate results or retry',async()=>{
  const f=fixture();
  try{const failures=[()=>Response.json({},{status:500}),()=>new Response('broken'),()=>response([],{status:'incomplete'}),()=>response([],{output:[{type:'message',content:[{type:'refusal'}]}]}),()=>{throw new Error('mock-ranking-key secret network failure');}];
    for(const fail of failures){const h=harness(fail);const result=await rankRecommendations(f.db, 'ilya',report(),h.options);assert.equal(result.status,'error');assert.equal(result.recommendations.length,0);assert.equal(h.requests.length,1);assert.ok(!JSON.stringify(result).includes('mock-ranking-key'));}
    const h=harness(init=>new Promise((_resolve,reject)=>init.signal?.addEventListener('abort',()=>reject(new Error('abort')))));
    const timed=await rankRecommendations(f.db, 'ilya',report(),{...h.options,timeoutMs:2});assert.equal(timed.status,'error');assert.match(timed.errors[0],/timed out/);assert.equal(h.requests.length,1);
  }finally{f.cleanup();}
});

test('all tables and timestamps survive success, validation failure and API error unchanged',async()=>{
  const f=fixture(),before=snapshot(f.db);f.db.pragma('query_only=ON');
  try{for(const handler of [()=>response(),()=>response([recommendation(999)]),()=>Response.json({},{status:503})]){
    const h=harness(handler);await rankRecommendations(f.db, 'ilya',report(),h.options);assert.deepEqual(snapshot(f.db),before);
  }}finally{f.cleanup();}
});

test('missing explicit model/key prevents API; existing 2.2 output can be replayed without a new search',async()=>{
  const f=fixture();
  try{const h=harness();for(const patch of [{apiKey:''},{model:''}])await assert.rejects(()=>rankRecommendations(f.db, 'ilya',report(),{...h.options,...patch}),/not configured/);assert.equal(h.requests.length,0);
    let tmdbCalls=0,candidateCalls=0;
    const generated=await generateCandidates(f.db, 'ilya',{live:true,apiKey:'mock-candidate-key',model:'configured-model',tmdbKey:'mock-tmdb-key',sleep:async()=>{},
      openaiFetch:async()=>{candidateCalls++;return response([],{output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({candidates:[{title:'Candidate 201',year:2000}]})}]}]});},
      tmdbFetch:async(input)=>{tmdbCalls++;const url=new URL(String(input));return url.pathname.endsWith('/recommendations')?Response.json({results:[]}):url.pathname.includes('/search/')?
        Response.json({total_pages:1,results:[{id:201,title:'Candidate 201',release_date:'2000-01-01'}]}):Response.json({id:201,title:'Candidate 201',release_date:'2000-01-01',runtime:100,overview:'Verified plot',genres:[{id:1,name:'Drama'}]});}});
    assert.equal(generated.mode,'live');if(generated.mode!=='live')return;assert.equal(generated.candidates[0].media_type,'movie');
    const before=tmdbCalls;
    for(let run=0;run<2;run++){const rank=await rankRecommendations(f.db, 'ilya',JSON.parse(JSON.stringify(generated)),h.options);assert.equal(rank.status,'ok');}
    assert.equal(tmdbCalls,before);assert.equal(candidateCalls,1);assert.equal(h.requests.length,2);
  }finally{f.cleanup();}
});
