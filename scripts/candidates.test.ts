import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { test } from 'node:test';
import { migrateDatabase } from '../src/lib/migrations';
import { buildTasteContext } from '../src/lib/taste-context';
import { buildCandidateContext, blockedReason, readCandidateHistory, CANDIDATE_LIMITS } from '../src/lib/candidate-context';
import { generateCandidates, parseCandidateProposals } from '../src/lib/candidates';
import { createTmdbClient, TmdbError } from '../src/lib/tmdb';

const identity = (id: number, title = `Film ${id}`, year = 2000) => ({ id, title, original_title: title, release_date: `${year}-01-01` });
const detail = (id: number, title = `Film ${id}`, patch: Record<string, unknown> = {}) => ({ ...identity(id,title), overview: 'A verified plot.',
  runtime: 100, genres: [{ id: 1, name: 'Drama' }], vote_count: 0, popularity: 0,
  credits: { crew: [{ id: 10, name: 'Director', job: 'Director' }], cast: [] }, ...patch });
function response(body: unknown, patch: Record<string, unknown> = {}) {
  return Response.json({ status: 'completed', model: 'configured-model', usage: { input_tokens: 50, output_tokens: 20 },
    output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(body) }] }], ...patch });
}
function fixture(profile = true) {
  const dir = mkdtempSync(join(tmpdir(), 'candidates-')), path = join(dir,'movies.sqlite');
  const db = new Database(path); db.pragma('foreign_keys=ON'); migrateDatabase(db);
  const movie = db.prepare(`INSERT INTO movies(id,title,release_year,tmdb_id,media_type,runtime_minutes,overview,genres_json,directors_json)
    VALUES(?,?,?,?,'movie',100,'A verified plot.','[{"id":1,"name":"Drama"},{"id":2,"name":"Thriller"}]','[{"id":10,"name":"Director"}]')`);
  const personal = db.prepare('INSERT INTO user_movies(user_id,movie_id,watched,rating_100,not_interested) VALUES(\'ilya\',?,?,?,?)');
  for (const [id,title,year,tmdb,watched,rating,hidden] of [
    [1,'Favourite',2000,101,1,100,0], [2,'Disliked',2000,102,1,0,0], [3,'Unrated',2000,103,1,null,0],
    [4,'Watched Fallback',2000,null,1,null,0], [5,'Uncertain',null,null,1,null,0],
    [6,'Hidden',2000,106,0,null,1], [7,'Hidden Fallback',2000,null,0,null,1],
  ] as const) { movie.run(id,title,year,tmdb); personal.run(id,watched,rating,hidden); }
  if (profile) saveProfile(db);
  return { db, dir, path, cleanup() { db.close(); rmSync(dir,{recursive:true,force:true}); } };
}
function saveProfile(db: Database.Database) {
  const context = buildTasteContext(db, 'ilya');
  const profile = { strong_preferences: [{ summary: 'Positive preference', explanation: 'Evidence supports this observation.', kind: 'observation', uncertainty: 'Limited evidence.', evidence: [{ movie_id: 1, rating_100: 100 }] }],
    negative_patterns: [{ summary: 'Negative pattern', explanation: 'A low rating suggests caution.', kind: 'hypothesis', uncertainty: 'Uncertain cause.', evidence: [{ movie_id: 2, rating_100: 0 }] }],
    contrasts: [{ higher: { movie_id: 1, rating_100: 100 }, lower: { movie_id: 2, rating_100: 0 }, similarity: 'Shared director.', possible_difference: 'A tentative explanation.', uncertainty: 'Unproven cause.' }],
    uncertainties: [{ description: 'Small sample.', evidence: [] }], profile_version: 1, generated_at: new Date().toISOString(), ratings_count: context.snapshot.length,
    ratings_snapshot: context.snapshot, context_fingerprint: context.fingerprint, prompt_version: 1, schema_version: 1, contrast_pairs_count: context.context.contrast_pairs.length,
    requested_model: 'configured-model', model: 'configured-model', response_id: null, usage: null };
  db.prepare('INSERT INTO taste_profile(user_id,profile_json) VALUES(\'ilya\',?)').run(JSON.stringify(profile));
}
function harness(proposals = [{ title: 'Film 20', year: 2000 }], handler?: (url: URL) => Response | Promise<Response>) {
  const calls: URL[] = [], bodies: Record<string, unknown>[] = [], waits: number[] = []; let clock = 0;
  const defaults = (url: URL): Response => {
    if (url.pathname.endsWith('/recommendations')) return Response.json({ results: [identity(20),identity(21)] });
    if (url.pathname.includes('/search/')) {
      const title = url.searchParams.get('query')!; const id = Number(title.replace('Film ',''));
      return Response.json({ total_pages: 1, results: Number.isSafeInteger(id) ? [identity(id,title)] : [] });
    }
    return Response.json(detail(Number(url.pathname.split('/').at(-1))));
  };
  return { calls, bodies, waits, defaults, options: { live: true, apiKey: 'mock-openai-key', model: 'configured-model', tmdbKey: 'mock-tmdb-key',
    openaiFetch: (async (_input, init) => { bodies.push(JSON.parse(String(init?.body))); return response({ candidates: proposals }); }) as typeof fetch,
    tmdbFetch: (async input => { const url = new URL(String(input)); calls.push(url); return (handler ?? defaults)(url); }) as typeof fetch,
    sleep: async (ms: number) => { waits.push(ms); clock += ms; }, now: () => clock } };
}
function snapshot(db: Database.Database) { return ['movies','user_movies','taste_profile','recommendations'].map(name => db.prepare(`SELECT * FROM ${name} ORDER BY 1`).all()); }

test('two sources use saved profile, merge IDs, retain obscure metadata and leave a read-only DB unchanged', async () => {
  const f = fixture(), h = harness(); const before = readFileSync(f.path); f.db.pragma('query_only=ON');
  try {
    const result = await generateCandidates(f.db, 'ilya',h.options); assert.equal(result.mode,'live'); if (result.mode !== 'live') return;
    assert.equal(result.status,'ok'); assert.deepEqual(result.candidates.map(row => [row.tmdb_id,row.source]),[[20,'both'],[21,'tmdb']]);
    assert.equal(result.candidates[0].vote_count,0); assert.equal(result.statistics.openai_requests,1);
    assert.deepEqual(result.statistics.usage,{input_tokens:50,output_tokens:20}); assert.equal(h.bodies.length,1);
    const request = h.bodies[0]; assert.equal(request.store,false); assert.equal(request.model,'configured-model'); assert.equal(request.max_output_tokens,12000);
    const input = request.input as { content: string }[]; assert.match(input[1].content,/Positive preference/);
    assert.equal(h.calls.filter(url => url.pathname === '/3/movie/20').length,1);
    assert.ok(h.calls.every(url => url.searchParams.get('language') === 'en-US')); assert.ok(h.waits.every(ms => ms >= 250));
    assert.deepEqual(readFileSync(f.path),before);
  } finally { f.cleanup(); }
});

test('context carries every changed/new/cleared rating, zero, no-ID evidence and deterministic examples', () => {
  const f = fixture();
  try {
    f.db.exec('UPDATE user_movies SET rating_100=NULL WHERE movie_id=1; UPDATE user_movies SET rating_100=80 WHERE movie_id=2; UPDATE user_movies SET rating_100=0 WHERE movie_id=4');
    const first = buildCandidateContext(f.db, 'ilya'), second = buildCandidateContext(f.db, 'ilya');
    assert.deepEqual(first,second); assert.equal(first.summary.profile_status,'stale');
    assert.deepEqual(first.context.rating_changes.map(row => [row.movie_id,row.previous_rating_100,row.rating_100]),[[1,100,null],[2,0,80],[4,null,0]]);
    assert.match(first.input[0].content,/Current ratings override/); assert.ok(first.warnings.length);
    f.db.exec('UPDATE user_movies SET rating_100=NULL'); assert.equal(buildCandidateContext(f.db, 'ilya').summary.ratings_count,0);
  } finally { f.cleanup(); }
});

test('context shrinks optional data without dropping profile or rating deltas; mandatory overflow fails', () => {
  const f = fixture();
  try {
    f.db.exec('UPDATE user_movies SET rating_100=50 WHERE movie_id=1');
    const full = buildCandidateContext(f.db, 'ilya'); const trimmed = buildCandidateContext(f.db, 'ilya',full.summary.input_bytes-100);
    assert.ok(trimmed.summary.input_bytes < full.summary.input_bytes); assert.deepEqual(trimmed.context.profile,full.context.profile);
    assert.deepEqual(trimmed.context.rating_changes,full.context.rating_changes); assert.throws(()=>buildCandidateContext(f.db, 'ilya',100),/exceed/);
  } finally { f.cleanup(); }
});

test('missing/corrupt profiles stop before APIs; dry-run is read-only and does not require credentials', async () => {
  const f = fixture(false); let calls = 0;
  const forbidden: typeof fetch = async () => { calls++; throw new Error('Unexpected network'); };
  try {
    await assert.rejects(()=>generateCandidates(f.db, 'ilya',{live:true,openaiFetch:forbidden,tmdbFetch:forbidden}),/No saved taste profile/);
    f.db.exec("INSERT INTO taste_profile(user_id,profile_json) VALUES('ilya','{}')");
    await assert.rejects(()=>generateCandidates(f.db, 'ilya',{openaiFetch:forbidden}),/Invalid saved/);
    f.db.exec('DELETE FROM taste_profile'); saveProfile(f.db); const before = readFileSync(f.path); f.db.pragma('query_only=ON');
    const preview = await generateCandidates(f.db, 'ilya',{openaiFetch:forbidden,tmdbFetch:forbidden}); assert.equal(preview.mode,'dry-run');
    assert.equal(calls,0); assert.deepEqual(readFileSync(f.path),before);
    const cli = spawnSync(process.execPath,['--import','tsx','scripts/candidates-generate.ts','--user','ilya'],{cwd:resolve('.'),env:{...process.env,DATABASE_PATH:f.path,OPENAI_API_KEY:'',OPENAI_MODEL:'',TMDB_API_KEY:''},encoding:'utf8'});
    assert.equal(cli.status,0,cli.stderr); assert.equal(JSON.parse(cli.stdout).mode,'dry-run');
    const bad = spawnSync(process.execPath,['--import','tsx','scripts/candidates-generate.ts','--user','ilya','--dry-run','--live'],{encoding:'utf8'});
    assert.equal(bad.status,1); assert.match(bad.stderr,/mutually exclusive/);
  } finally { f.cleanup(); }
});

test('watched NULL/zero, no-ID titles and aliases, unknown-year ambiguity and hidden films are excluded', async () => {
  const f = fixture();
  const names = ['Unrated','Watched Fallback','Uncertain','Hidden','Hidden Fallback'];
  const proposals = names.map(title=>({title,year:2000}));
  const h = harness(proposals,url => {
    if (url.pathname.endsWith('/recommendations')) return Response.json({results:[]});
    const title = url.searchParams.get('query');
    if (title) return Response.json({total_pages:1,results:[identity(title==='Unrated'?103:title==='Hidden'?106:20+names.indexOf(title),title)]});
    throw new Error('Filtered candidates must not need details');
  });
  try {
    const result = await generateCandidates(f.db, 'ilya',h.options); if(result.mode!=='live')return;
    assert.equal(result.candidates.length,0); assert.equal(result.status,'ok'); assert.equal(result.statistics.details_checked,0);
    assert.deepEqual(result.diagnostics.map(row=>row.reason),['watched','watched_without_tmdb_id','uncertain_history_match','not_interested','not_interested']);
    f.db.exec("UPDATE movies SET tmdb_title='Alias' WHERE id=4");
    assert.equal(blockedReason({id:999,title:'Alias',original_title:null,year:2000},readCandidateHistory(f.db, 'ilya')),'watched_without_tmdb_id');
    assert.equal(blockedReason({id:101,title:'Other',original_title:null,year:1999},readCandidateHistory(f.db, 'ilya')),'watched');
    assert.equal(blockedReason({id:999,title:'Watched Fallback',original_title:null,year:2001},readCandidateHistory(f.db, 'ilya')),null);
  } finally { f.cleanup(); }
});

test('nonexistent, wrong-year, ambiguous and incomplete search proposals are rejected', async () => {
  const f = fixture();
  const names = ['Missing','Wrong year','Ambiguous','Incomplete'];
  const h = harness(names.map(title=>({title,year:2000})),url => {
    if(url.pathname.endsWith('/recommendations'))return Response.json({results:[]});
    const title = url.searchParams.get('query')!;
    return Response.json({total_pages:title==='Incomplete'?6:1,results:title==='Missing'?[]:title==='Wrong year'?[identity(20,title,2001)]:title==='Ambiguous'?[identity(20,title),identity(21,title)]:[identity(20,title)]});
  });
  try { const result=await generateCandidates(f.db, 'ilya',h.options);if(result.mode!=='live')return;
    assert.equal(result.status,'ok');assert.equal(result.candidates.length,0);
    assert.deepEqual(result.diagnostics.map(row=>row.reason),['not_found','year_mismatch','ambiguous','incomplete_search']);
    assert.equal(h.calls.filter(url=>url.searchParams.get('query')==='Incomplete').length,5);
  } finally { f.cleanup(); }
});

test('pagination checks all pages and deduplicates; original title matching is allowed', async () => {
  const f=fixture();
  const h=harness([{title:'Original',year:2000}],url=>url.pathname.endsWith('/recommendations')?Response.json({results:[]}):url.pathname.includes('/search/')?
    Response.json({total_pages:2,results:[{...identity(20,'English'),original_title:'Original'}]}):Response.json(detail(20,'English',{original_title:'Original'})));
  try { const result=await generateCandidates(f.db, 'ilya',h.options);if(result.mode!=='live')return; assert.deepEqual(result.candidates.map(row=>row.tmdb_id),[20]);
    assert.equal(h.calls.filter(url=>url.pathname.includes('/search/')).length,2);
  }finally{f.cleanup();}
});

test('TV, short/unknown runtime, insufficient metadata and changed details identity never enter results', async () => {
  const f=fixture();
  const patches:Record<string,unknown>[]=[{media_type:'tv'},{runtime:59},{runtime:null},{overview:null},{genres:[]},{title:'Different',original_title:'Different'},{release_date:'2001-01-01'},{runtime:60,credits:null,vote_count:null,popularity:null}];
  const h=harness(patches.map((_,i)=>({title:`Film ${20+i}`,year:2000})),url=>{
    if(url.pathname.endsWith('/recommendations'))return Response.json({results:[]});
    if(url.pathname.includes('/search/')){const title=url.searchParams.get('query')!;return Response.json({total_pages:1,results:[identity(Number(title.slice(5)),title)]});}
    const id=Number(url.pathname.split('/').at(-1));return Response.json(detail(id,`Film ${id}`,patches[id-20]));
  });
  try {const result=await generateCandidates(f.db, 'ilya',h.options);if(result.mode!=='live')return;
    assert.deepEqual(result.candidates.map(row=>row.tmdb_id),[27]);assert.equal(result.candidates[0].directors,null);
    assert.equal(result.rejected_by_reason.short_film,1);assert.equal(result.rejected_by_reason.unknown_runtime,1);
    assert.equal(result.rejected_by_reason.not_movie,1);assert.equal(result.rejected_by_reason.details_identity_mismatch,2);
    assert.equal(result.rejected_by_reason.insufficient_metadata,2);
  }finally{f.cleanup();}
});

test('candidate schema rejects malformed/excessive output; OpenAI failure/refusal/incomplete never fall back or retry',async()=>{
  for(const value of [{}, {candidates:[{title:'A',year:2000,id:1}]},{candidates:[{title:' ',year:2000}]},{candidates:[{title:'A',year:2000.5}]},{candidates:Array(31).fill({title:'A',year:2000})}])assert.throws(()=>parseCandidateProposals(value));
  const f=fixture();
  try{for(const bad of [()=>response({candidates:[]},{status:'incomplete'}),()=>response({}, {output:[{type:'message',content:[{type:'refusal'}]}]}),()=>Response.json({}, {status:500}),()=>response({candidates:[{title:'A',year:'2000'}]}),()=>{throw new Error('mock-openai-key private');}]){
    const h=harness();let requests=0;
    const result=await generateCandidates(f.db, 'ilya',{...h.options,openaiFetch:async()=>{requests++;return bad();}});if(result.mode!=='live')return;
    assert.equal(result.status,'error');assert.equal(requests,1);assert.equal(h.calls.length,0);assert.equal(result.candidates.length,0);
    assert.ok(!JSON.stringify(result).includes('mock-openai-key'));
  }}finally{f.cleanup();}
});

test('OpenAI timeout has one attempt and no TMDB calls',async()=>{
  const f=fixture(),h=harness();let calls=0;
  try{const result=await generateCandidates(f.db, 'ilya',{...h.options,openaiTimeoutMs:2,openaiFetch:async(_input,init)=>new Promise((_resolve,reject)=>{calls++;init?.signal?.addEventListener('abort',()=>reject(new Error('abort')));})});
    if(result.mode!=='live')return;assert.equal(calls,1);assert.equal(result.status,'error');assert.match(result.errors[0],/timed out/);assert.equal(h.calls.length,0);
  }finally{f.cleanup();}
});

test('TMDB retries 429/5xx sequentially, auth stops, and technical partial results are explicit',async()=>{
  const f=fixture();let n=0;
  const h=harness([{title:'Film 20',year:2000},{title:'Film 22',year:2000}],url=>{
    if(url.pathname.endsWith('/recommendations'))return Response.json({results:[]});
    if(url.pathname==='/3/movie/22')return Response.json({}, {status:401});
    if(url.pathname==='/3/movie/20'&&n++<2)return Response.json({}, {status:n===1?429:503,headers:{'Retry-After':'1'}});
    return h.defaults(url);
  });
  try{const result=await generateCandidates(f.db, 'ilya',h.options);if(result.mode!=='live')return;
    assert.equal(result.status,'partial');assert.deepEqual(result.candidates.map(row=>row.tmdb_id),[20]);
    assert.equal(h.calls.filter(url=>url.pathname==='/3/movie/20').length,3);assert.equal(h.calls.filter(url=>url.pathname==='/3/movie/22').length,1);
    assert.ok(h.waits.includes(1000)&&h.waits.includes(2000));assert.ok(result.errors.length);
  }finally{f.cleanup();}
});

test('request budget counts retries and cannot be exceeded; raw candidate/result bounds are enforced',async()=>{
  let calls=0;
  const api=createTmdbClient('test',{maxRequests:2,fetch:async()=>{calls++;return Response.json({}, {status:503});},sleep:async()=>{}});
  await assert.rejects(()=>api.details(1),error=>error instanceof TmdbError&&error.stop&&/budget/.test(error.message));assert.equal(calls,2);
  const f=fixture();
  // Add seeds with varied directors; no more than five endpoints and 25 supplemental IDs.
  for(let id=8;id<=14;id++){
    f.db.prepare("INSERT INTO movies(id,title,release_year,tmdb_id,media_type,runtime_minutes,genres_json,directors_json) VALUES(?,?,2000,?,'movie',90,'[]',?)").run(id,`Seed ${id}`,100+id,JSON.stringify([{id,name:`Director ${id}`}])) ;
    f.db.prepare('INSERT INTO user_movies(user_id,movie_id,watched,rating_100) VALUES(\'ilya\',?,1,100)').run(id);
  }
  const h=harness(Array.from({length:30},(_,i)=>({title:`Film ${1000+i}`,year:2000})),url=>{
    if(url.pathname.endsWith('/recommendations')){const seed=Number(url.pathname.split('/').at(-2));return Response.json({results:Array.from({length:20},(_,i)=>identity(seed*100+i))});}
    return h.defaults(url);
  });
  try{const result=await generateCandidates(f.db, 'ilya',h.options);if(result.mode!=='live')return;
    assert.equal(result.candidates.length,40);assert.equal(result.statistics.verified_before_cap,55);
    assert.equal(result.statistics.details_checked,55);assert.equal(h.calls.filter(url=>url.pathname.endsWith('/recommendations')).length,5);
    assert.ok(result.statistics.tmdb_requests<=CANDIDATE_LIMITS.tmdb_requests);assert.equal(h.bodies.length,1);
    const seeds=buildCandidateContext(f.db, 'ilya').seeds;assert.equal(new Set(seeds.map(row=>row.tmdb_id)).size,5);
  }finally{f.cleanup();}
});

test('exclusions are read again before output; unknown metadata is not invented and history is preserved',async()=>{
  const f=fixture(),before=snapshot(f.db);
  const h=harness([{title:'Film 20',year:2000}],url=>{
    if(url.pathname.endsWith('/recommendations'))return Response.json({results:[]});
    if(url.pathname==='/3/movie/20'){
      f.db.exec("INSERT INTO movies(id,title,release_year,tmdb_id) VALUES(20,'Film 20',2000,20); INSERT INTO user_movies(user_id,movie_id,watched) VALUES('ilya',20,1)");
      return Response.json(detail(20));
    }
    return h.defaults(url);
  });
  try{const result=await generateCandidates(f.db, 'ilya',h.options);if(result.mode!=='live')return;assert.equal(result.candidates.length,0);assert.equal(result.rejected_by_reason.watched,1);
    assert.deepEqual(snapshot(f.db).map(rows=>rows.filter(row=>(row as {id?:number;movie_id?:number}).id!==20&&(row as {movie_id?:number}).movie_id!==20)),before);
  }finally{f.cleanup();}
});

test('missing integration settings fail before the paid request',async()=>{
  const f=fixture(),h=harness();
  try{for(const patch of [{apiKey:''},{model:''},{tmdbKey:''}])await assert.rejects(()=>generateCandidates(f.db, 'ilya',{...h.options,...patch}),/not configured/);
    assert.equal(h.bodies.length,0);assert.equal(h.calls.length,0);
  }finally{f.cleanup();}
});

test('generator stops exactly at 120 HTTP attempts, reports budget exhaustion and makes no extra calls',async()=>{
  const f=fixture();
  const h=harness(Array.from({length:30},(_,i)=>({title:`Film ${1000+i}`,year:2000})),url=>
    url.pathname.endsWith('/recommendations')?Response.json({results:[]}):Response.json({total_pages:6,results:[]}));
  try{const result=await generateCandidates(f.db, 'ilya',h.options);if(result.mode!=='live')return;
    assert.equal(result.status,'error');assert.equal(result.statistics.tmdb_requests,120);assert.equal(h.calls.length,120);
    assert.ok(result.errors.some(message=>message.includes('budget')));assert.equal(h.bodies.length,1);
  }finally{f.cleanup();}
});

test('duplicate title hypotheses use one lookup; mismatched source identity is not merged',async()=>{
  const f=fixture();
  const h=harness([{title:'Film 20',year:2000},{title:'FILM—20',year:2000}],url=>
    url.pathname.endsWith('/recommendations')?Response.json({results:[identity(20,'Wrong title')]}):h.defaults(url));
  try{const result=await generateCandidates(f.db, 'ilya',h.options);if(result.mode!=='live')return;
    assert.equal(result.candidates.length,1);assert.equal(result.candidates[0].source,'llm');assert.equal(result.rejected_by_reason.duplicate,1);
    assert.equal(result.rejected_by_reason.details_identity_mismatch,1);assert.equal(h.calls.filter(url=>url.pathname.includes('/search/')).length,1);
  }finally{f.cleanup();}
});
