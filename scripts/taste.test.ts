import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { migrateDatabase } from '../src/lib/migrations';
import { buildTasteContext, MAX_INPUT_BYTES, type TasteContext } from '../src/lib/taste-context';
import { validateProfile, type ProfileBody } from '../src/lib/taste-schema';
import { requestTasteProfile } from '../src/lib/openai-taste';
import { generateTasteProfile, readTasteProfile, displayTasteProfile, acquireTasteLock } from '../src/lib/taste-profile';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'taste-'));
  const path = join(directory, 'movies.sqlite'); const db = new Database(path); db.pragma('foreign_keys=ON'); migrateDatabase(db);
  const insertMovie = db.prepare('INSERT INTO movies (id,title,release_year,tmdb_id,overview,genres_json,directors_json,runtime_minutes) VALUES (?,?,2000,?,?,?,?,100)');
  const insertHistory = db.prepare('INSERT INTO user_movies (user_id,movie_id,watched,rating_100) VALUES (\'ilya\',?,1,?)');
  for (const [id, name, rating, tmdb] of [[1,'Low',0,101],[2,'High',100,102],[3,'Middle',70,103],[4,'Unknown',90,null],[5,'Unrated',null,104]] as const) {
    insertMovie.run(id,name,tmdb,tmdb === null ? null : 'A confirmed plot description.',tmdb === null ? null : '[{"id":1,"name":"Drama"},{"id":2,"name":"Thriller"}]',tmdb === null ? null : '[{"id":10,"name":"Director"}]');
    insertHistory.run(id,rating);
  }
  let run = 0;
  return { db, path, directory, backup: () => join(directory, `backup-${run++}.sqlite`),
    cleanup() { db.close(); rmSync(directory, { recursive: true, force: true }); } };
}
function body(context: TasteContext): ProfileBody {
  const higher = context.snapshot.find(row => row.rating_100 >= 80)!;
  const lower = context.snapshot.find(row => row.rating_100 <= 60)!;
  return { strong_preferences: [{ summary: 'Positive pattern', explanation: 'The supplied evidence supports a cautious preference.', kind: 'observation', uncertainty: 'Other explanations remain possible.', evidence: [higher] }],
    negative_patterns: [{ summary: 'Negative pattern', explanation: 'The supplied low rating is a counterexample.', kind: 'hypothesis', uncertainty: 'The cause cannot be inferred from the rating alone.', evidence: [lower] }],
    contrasts: context.context.contrast_pairs.length ? [{ higher, lower, similarity: 'Confirmed shared director and genres.', possible_difference: 'A hypothesis requiring more evidence.', uncertainty: 'Ratings alone do not establish cause.' }] : [],
    uncertainties: [{ description: 'Missing metadata limits some conclusions.', evidence: [] }] };
}
function response(value: unknown, overrides: Record<string, unknown> = {}) {
  return Response.json({ id: 'resp_mock', status: 'completed', model: 'returned-model', usage: { input_tokens: 1000, output_tokens: 400 },
    output: [{ type: 'reasoning', summary: [] }, { type: 'message', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(value) }] }], ...overrides });
}
function live(f: ReturnType<typeof fixture>, options: Record<string, unknown> = {}) {
  return { live: true, apiKey: 'synthetic-key-for-mocks', model: 'configured-model', backupPath: f.backup(), ...options };
}
const snapshotData = (db: Database.Database) => ['movies','user_movies','recommendations'].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all());

test('context includes all rating groups and zero, excludes NULL, and retains works without TMDB', () => {
  const f = fixture();
  try {
    const context = buildTasteContext(f.db, 'ilya');
    assert.deepEqual(context.summary.groups, { high: 2, medium: 1, low: 1 });
    assert.deepEqual(context.context.ratings.map(row => [row.movie_id,row.rating_100]), [[1,0],[2,100],[3,70],[4,90]]);
    assert.equal(context.summary.with_tmdb_metadata, 3); assert.equal(context.summary.without_tmdb_metadata, 1);
    assert.ok(!context.context.detailed_examples.some(row => row.movie_id === 4));
    assert.equal(context.input[0].role, 'system'); assert.equal(context.input[1].role, 'user');
    assert.ok(context.inputBytes <= MAX_INPUT_BYTES);
    assert.deepEqual(buildTasteContext(f.db, 'ilya'), context);
    const hash = context.fingerprint;
    f.db.exec('UPDATE user_movies SET rating_100=10 WHERE movie_id=1');
    assert.notEqual(buildTasteContext(f.db, 'ilya').fingerprint, hash);
  } finally { f.cleanup(); }
});

test('examples balance groups, rating buckets and metadata diversity; contrast pairs use confirmed similarities', () => {
  const f = fixture();
  try {
    for (let id=10;id<110;id++) {
      const rating = id<45 ? (id%2 ? 80 : 100) : id<80 ? (id%2 ? 0 : 60) : 70;
      f.db.prepare('INSERT INTO movies (id,title,release_year,tmdb_id,overview,genres_json,directors_json) VALUES (?,?,2000,?,?,?,?)').run(id,`Film ${id}`,id+1000,'Plot',JSON.stringify([{name:`Genre ${id%5}`}]),JSON.stringify([{id:id%7+1,name:`Director ${id%7}`} ]));
      f.db.prepare('INSERT INTO user_movies (user_id,movie_id,watched,rating_100) VALUES (\'ilya\',?,1,?)').run(id,rating);
    }
    const context = buildTasteContext(f.db, 'ilya');
    assert.deepEqual(context.summary.example_groups, {high:20,medium:20,low:20});
    const ratings = new Map(context.snapshot.map(row=>[row.movie_id,row.rating_100]));
    for (const group of ['high','low'] as const) {
      const chosen = context.context.detailed_examples.filter(row => group==='high' ? ratings.get(row.movie_id)!>=80 : ratings.get(row.movie_id)!<=60);
      assert.equal(new Set(chosen.map(row=>ratings.get(row.movie_id))).size,2);
      assert.ok(new Set(chosen.flatMap(row=>row.directors.map(person=>person.id))).size>1);
    }
    const uses = new Map<number,number>();
    assert.ok(context.context.contrast_pairs.length>0 && context.context.contrast_pairs.length<=12);
    for (const pair of context.context.contrast_pairs) {
      assert.ok(pair.higher.rating_100-pair.lower.rating_100>=20);
      assert.ok(pair.shared_directors.length>0 || pair.shared_genres.length>=2);
      for (const ref of [pair.higher,pair.lower]) uses.set(ref.movie_id,(uses.get(ref.movie_id)??0)+1);
    }
    assert.ok([...uses.values()].every(count=>count<=2));
  } finally { f.cleanup(); }
});

test('byte budget shrinks descriptions then examples without losing mandatory ratings; overflow and empty history fail', () => {
  const f = fixture();
  try {
    f.db.prepare('UPDATE movies SET overview=? WHERE tmdb_id IS NOT NULL').run('я'.repeat(2000));
    const full = buildTasteContext(f.db, 'ilya');
    const shorter = buildTasteContext(f.db, 'ilya',full.inputBytes-300);
    assert.deepEqual(shorter.context.ratings,full.context.ratings); assert.ok(shorter.summary.overview_limit<600);
    let small: TasteContext | null = null;
    for (let cap=full.inputBytes-1000;cap>1000;cap-=300) {
      try { const candidate = buildTasteContext(f.db, 'ilya',cap); if(candidate.summary.detailed_examples<full.summary.detailed_examples){small=candidate;break;} } catch { break; }
    }
    assert.ok(small); assert.deepEqual(small.context.ratings,full.context.ratings);
    assert.throws(()=>buildTasteContext(f.db, 'ilya',10),/no ratings were dropped/);
    f.db.exec('UPDATE user_movies SET rating_100=NULL');
    assert.throws(()=>buildTasteContext(f.db, 'ilya'),/No rated works/);
  } finally { f.cleanup(); }
});

test('profile validation rejects fabricated IDs/ratings, duplicates, missing groups, weak contrasts, extra fields and links', () => {
  const f = fixture();
  try {
    const context = buildTasteContext(f.db, 'ilya'); const valid = body(context);
    assert.deepEqual(validateProfile(valid,context.snapshot,true),valid);
    const corruptions: ((value: ProfileBody)=>void)[] = [
      p=>{p.strong_preferences[0].evidence[0]={movie_id:99999,rating_100:100};},
      p=>{p.strong_preferences[0].evidence[0].rating_100=99;},
      p=>{p.strong_preferences[0].evidence.push(p.strong_preferences[0].evidence[0]);},
      p=>{p.strong_preferences=[];}, p=>{p.negative_patterns=[];}, p=>{p.contrasts=[];},
      p=>{p.contrasts[0].lower=p.contrasts[0].higher;}, p=>{p.contrasts.push(p.contrasts[0]);},
      p=>{p.strong_preferences[0].summary=' ';}, p=>{p.uncertainties[0].description='https://example.com/movie';},
      p=>{p.negative_patterns[0].evidence=p.strong_preferences[0].evidence;},
    ];
    for(const corrupt of corruptions){const copy=structuredClone(valid);corrupt(copy);assert.throws(()=>validateProfile(copy,context.snapshot,true));}
    assert.throws(()=>validateProfile({...valid,ratings_count:999},context.snapshot,true));
    assert.throws(()=>validateProfile({},context.snapshot,true));
    const weak=structuredClone(valid);weak.contrasts[0].lower={movie_id:4,rating_100:90};
    assert.throws(()=>validateProfile(weak,context.snapshot,true),/gap/);
  } finally { f.cleanup(); }
});

test('Responses request uses configured model, strict schema, no store and one capped request; parses usage', async () => {
  const f=fixture();
  try {
    const context=buildTasteContext(f.db, 'ilya');let calls=0;
    const mock:typeof fetch=async(input,init)=>{
      calls++;assert.equal(String(input),'https://api.openai.com/v1/responses');assert.equal(init?.method,'POST');
      const request=JSON.parse(init!.body as string);
      assert.equal(request.model,'configured-model');assert.equal(request.store,false);assert.equal(request.max_output_tokens,12000);
      assert.equal(request.text.format.type,'json_schema');assert.equal(request.text.format.strict,true);assert.equal(request.text.format.schema.additionalProperties,false);
      assert.equal((init!.headers as Record<string,string>).Authorization,'Bearer synthetic-key-for-mocks');
      assert.equal(request.input[1].role,'user');return response(body(context));
    };
    const result=await requestTasteProfile(context,{...live(f),fetch:mock});
    assert.equal(calls,1);assert.equal(result.model,'returned-model');assert.deepEqual(result.usage,{input_tokens:1000,output_tokens:400});
    const missingUsage=await requestTasteProfile(context,{...live(f),fetch:async()=>response(body(context),{usage:null})});assert.equal(missingUsage.usage,null);
  } finally { f.cleanup(); }
});

test('incomplete/refusal/empty/invalid response and API failures never retry or expose credentials', async () => {
  const f=fixture();
  try {
    const context=buildTasteContext(f.db, 'ilya');
    const factories= [
      ()=>response(body(context),{status:'incomplete'}),
      ()=>response(body(context),{output:[{type:'message',content:[{type:'refusal',refusal:'No'}]}]}),
      ()=>response(body(context),{output:[]}),
      ()=>response(body(context),{output:[{type:'message',content:[{type:'output_text',text:'{bad'}]}]}),
      ()=>new Response('{bad',{status:200}),()=>Response.json({error:'private-body'},{status:429}),
    ];
    for(const factory of factories){let calls=0;await assert.rejects(()=>requestTasteProfile(context,{...live(f),fetch:async()=>{calls++;return factory();}}));assert.equal(calls,1);}
    let calls=0;
    await assert.rejects(()=>requestTasteProfile(context,{...live(f),fetch:async()=>{calls++;throw new Error('OpenAI synthetic-key-for-mocks private context');}}),
      error=>error instanceof Error && !error.message.includes('synthetic-key-for-mocks') && !error.message.includes('private context'));
    assert.equal(calls,1);
    const aborting:typeof fetch=async(_input,init)=>new Promise((_resolve,reject)=>init!.signal!.addEventListener('abort',()=>reject(new Error('Aborted')),{once:true}));
    await assert.rejects(()=>requestTasteProfile(context,{...live(f),fetch:aborting,timeoutMs:2}),/may already have been billed/);
  } finally { f.cleanup(); }
});

test('generation saves singleton technical metadata, leaves history unchanged, and reuses current/stale cache without config', async () => {
  const f=fixture();
  try {
    const before=snapshotData(f.db),context=buildTasteContext(f.db, 'ilya');let calls=0;
    const result=await generateTasteProfile(f.db, 'ilya',{...live(f),fetch:async()=>{calls++;return response(body(context));}});
    assert.equal(result.mode,'generated');assert.equal(calls,1);assert.deepEqual(snapshotData(f.db),before);
    const saved=readTasteProfile(f.db, 'ilya')!;assert.equal(saved.profile_version,1);assert.equal(saved.ratings_count,4);
    assert.equal(saved.requested_model,'configured-model');assert.equal(saved.model,'returned-model');assert.equal(saved.context_fingerprint,context.fingerprint);
    assert.deepEqual(saved.ratings_snapshot,context.snapshot);assert.deepEqual(saved.usage,{input_tokens:1000,output_tokens:400});
    assert.ok(!existsSync(f.path+'.taste.lock'));
    const original=f.db.prepare('SELECT * FROM taste_profile').get();
    const cached=await generateTasteProfile(f.db, 'ilya',{live:true});assert.equal(cached.mode,'cached');assert.equal(cached.cache,'current');
    f.db.exec('UPDATE user_movies SET rating_100=10 WHERE movie_id=1');
    const stale=await generateTasteProfile(f.db, 'ilya',{live:true});assert.equal(stale.mode,'cached');assert.equal(stale.cache,'stale');
    assert.deepEqual(f.db.prepare('SELECT * FROM taste_profile').get(),original);
    assert.match(displayTasteProfile(f.db, 'ilya'),/current: 10/);assert.match(displayTasteProfile(f.db, 'ilya'),/High \(2000\)/);
  } finally { f.cleanup(); }
});

test('--force replaces atomically, increments version, preserves created_at and readable backup', async () => {
  const f=fixture();
  try {
    let context=buildTasteContext(f.db, 'ilya');
    await generateTasteProfile(f.db, 'ilya',{...live(f),fetch:async()=>response(body(context))});
    const old=f.db.prepare('SELECT * FROM taste_profile').get() as {created_at:string};
    f.db.exec('UPDATE user_movies SET rating_100=10 WHERE movie_id=1');context=buildTasteContext(f.db, 'ilya');
    const options=live(f,{force:true});
    const result=await generateTasteProfile(f.db, 'ilya',{...options,fetch:async()=>response(body(context))});
    assert.equal(result.mode,'generated');assert.equal(readTasteProfile(f.db, 'ilya')!.profile_version,2);
    assert.equal((f.db.prepare('SELECT created_at FROM taste_profile').get() as {created_at:string}).created_at,old.created_at);
    assert.equal((f.db.prepare('SELECT count(*) n FROM taste_profile').get() as {n:number}).n,1);
    const backup=new Database(options.backupPath,{readonly:true});
    try {assert.equal(JSON.parse((backup.prepare('SELECT profile_json FROM taste_profile').get() as {profile_json:string}).profile_json).profile_version,1);}
    finally{backup.close();}
  } finally {f.cleanup();}
});

test('failed regeneration or SQL save leaves previous profile intact and releases lock', async () => {
  const f=fixture();
  try {
    const context=buildTasteContext(f.db, 'ilya');await generateTasteProfile(f.db, 'ilya',{...live(f),fetch:async()=>response(body(context))});
    const old=f.db.prepare('SELECT * FROM taste_profile').get();
    for(const mock of [async()=>response({}),async()=>Response.json({error:'failure'},{status:500})]) {
      await assert.rejects(()=>generateTasteProfile(f.db, 'ilya',{...live(f,{force:true}),fetch:mock}));
      assert.deepEqual(f.db.prepare('SELECT * FROM taste_profile').get(),old);assert.ok(!existsSync(f.path+'.taste.lock'));
    }
    f.db.exec("CREATE TRIGGER reject_profile BEFORE UPDATE ON taste_profile BEGIN SELECT RAISE(ABORT,'forced save failure'); END");
    await assert.rejects(()=>generateTasteProfile(f.db, 'ilya',{...live(f,{force:true}),fetch:async()=>response(body(context))}),/forced save failure/);
    assert.deepEqual(f.db.prepare('SELECT * FROM taste_profile').get(),old);assert.ok(!existsSync(f.path+'.taste.lock'));
  } finally {f.cleanup();}
});

test('backup failure prevents API call and lock is released', async () => {
  const f=fixture();let calls=0;
  try {
    await assert.rejects(()=>generateTasteProfile(f.db, 'ilya',{...live(f),backupPath:join(f.directory,'missing','backup.sqlite'),fetch:async()=>{calls++;return response({});}}));
    assert.equal(calls,0);assert.equal(readTasteProfile(f.db, 'ilya'),null);assert.ok(!existsSync(f.path+'.taste.lock'));
  } finally {f.cleanup();}
});

test('concurrent live generation is excluded and stale locks require explicit verification', async () => {
  const f=fixture();
  try {
    const context=buildTasteContext(f.db, 'ilya');let finish:(value:Response)=>void=()=>{};let started:()=>void=()=>{};
    const start=new Promise<void>(resolve=>{started=resolve;});let calls=0;
    const first=generateTasteProfile(f.db, 'ilya',{...live(f),fetch:async()=>{calls++;started();return new Promise<Response>(resolve=>{finish=resolve;});}});
    await start;
    await assert.rejects(()=>generateTasteProfile(f.db, 'ilya',{...live(f),fetch:async()=>{calls++;return response(body(context));}}),/owner PID/);
    finish(response(body(context)));await first;assert.equal(calls,1);assert.ok(!existsSync(f.path+'.taste.lock'));
    writeFileSync(f.path+'.taste.lock',JSON.stringify({pid:99999999}));
    assert.throws(()=>acquireTasteLock(f.db, 'ilya'),/stale lock/);
  } finally {f.cleanup();}
});

test('ratings/context or saved-profile change during API call prevents overwriting old profile', async () => {
  for(const change of ['ratings','metadata','profile']) {
    const f=fixture();
    try {
      const context=buildTasteContext(f.db, 'ilya');await generateTasteProfile(f.db, 'ilya',{...live(f),fetch:async()=>response(body(context))});
      const old=f.db.prepare('SELECT * FROM taste_profile').get();
      await assert.rejects(()=>generateTasteProfile(f.db, 'ilya',{...live(f,{force:true}),fetch:async()=>{
        if(change==='ratings')f.db.exec('UPDATE user_movies SET rating_100=20 WHERE movie_id=1');
        else if(change==='metadata')f.db.exec("UPDATE movies SET overview='New description' WHERE id=1");
        else f.db.prepare('UPDATE taste_profile SET profile_json=?').run(JSON.stringify({...readTasteProfile(f.db, 'ilya'),profile_version:99}));
        return response(body(context));
      }}),/changed during generation/);
      if(change!=='profile')assert.deepEqual(f.db.prepare('SELECT * FROM taste_profile').get(),old);
      else assert.equal(readTasteProfile(f.db, 'ilya')!.profile_version,99);
      assert.ok(!existsSync(f.path+'.taste.lock'));
    } finally {f.cleanup();}
  }
});

test('dry-run and show are read-only without credentials; CLI rejects accidental paid modes', async () => {
  const f=fixture();
  try {
    const before=readFileSync(f.path);const result=await generateTasteProfile(f.db, 'ilya');
    assert.equal(result.mode,'dry-run');assert.deepEqual(readFileSync(f.path),before);assert.match(displayTasteProfile(f.db, 'ilya'),/No saved taste profile/);
    const run=(script:string,args:string[]=[])=>spawnSync(process.execPath,['--import',createRequire(import.meta.url).resolve('tsx'),resolve(script),'--user','ilya',...args],
      {cwd:f.directory,env:{...process.env,DATABASE_PATH:f.path,OPENAI_API_KEY:'',OPENAI_MODEL:''},encoding:'utf8'});
    for(const args of [[],['--dry-run']]){const cli=run('scripts/taste-generate.ts',args);assert.equal(cli.status,0,cli.stderr);assert.equal(JSON.parse(cli.stdout).ratings_count,4);}
    assert.equal(run('scripts/taste-show.ts').status,0);
    for(const args of [['--dry-run','--live'],['--force'],['--live'],['--unknown']])assert.equal(run('scripts/taste-generate.ts',args).status,1);
    assert.deepEqual(readFileSync(f.path),before);assert.equal(readTasteProfile(f.db, 'ilya'),null);
  } finally{f.cleanup();}
});


test('cache survives clearing all ratings and prompt-version changes without implicit API calls', async () => {
  const f=fixture();
  try {
    const context=buildTasteContext(f.db, 'ilya');await generateTasteProfile(f.db, 'ilya',{...live(f),fetch:async()=>response(body(context))});
    const old=f.db.prepare('SELECT * FROM taste_profile').get();
    f.db.prepare('UPDATE taste_profile SET profile_json=?').run(JSON.stringify({...readTasteProfile(f.db, 'ilya'),prompt_version:99}));
    assert.equal((await generateTasteProfile(f.db, 'ilya',{live:true})).cache,'stale');
    f.db.prepare('UPDATE taste_profile SET profile_json=?').run((old as {profile_json:string}).profile_json);
    f.db.exec('UPDATE user_movies SET rating_100=NULL');
    const cached=await generateTasteProfile(f.db, 'ilya',{live:true});assert.equal(cached.mode,'cached');assert.equal(cached.cache,'stale');
    const preview=await generateTasteProfile(f.db, 'ilya');assert.equal(preview.mode,'dry-run');assert.equal(preview.ratings_count,0);
    assert.match(displayTasteProfile(f.db, 'ilya'),/unrated/);
  } finally {f.cleanup();}
});

test('invalid cached profile requires force; failure preserves it and successful replacement preserves version sequence', async () => {
  const f=fixture();
  try {
    const context=buildTasteContext(f.db, 'ilya');
    f.db.prepare('INSERT INTO taste_profile (user_id,profile_json) VALUES (\'ilya\',?)').run(JSON.stringify({profile_version:7,unexpected:'broken'}));
    const before=f.db.prepare('SELECT * FROM taste_profile').get();
    await assert.rejects(()=>generateTasteProfile(f.db, 'ilya',{live:true}),/Invalid saved/);
    await assert.rejects(()=>generateTasteProfile(f.db, 'ilya',{...live(f,{force:true}),fetch:async()=>response({})}));
    assert.deepEqual(f.db.prepare('SELECT * FROM taste_profile').get(),before);
    const result=await generateTasteProfile(f.db, 'ilya',{...live(f,{force:true}),fetch:async()=>response(body(context))});
    assert.equal(result.profile_version,8);assert.equal(readTasteProfile(f.db, 'ilya')!.profile_version,8);
  } finally {f.cleanup();}
});

test('missing explicit model/key and oversized context fail before any OpenAI request', async () => {
  const f=fixture();let calls=0;
  try {
    const context=buildTasteContext(f.db, 'ilya');
    const mock:typeof fetch=async()=>{calls++;return response(body(context));};
    await assert.rejects(()=>requestTasteProfile(context,{apiKey:'synthetic-key-for-mocks',fetch:mock}),/OPENAI_MODEL/);
    await assert.rejects(()=>requestTasteProfile(context,{model:'configured-model',fetch:mock}),/OPENAI_API_KEY/);
    const large={...context,input:[{role:'user',content:'x'.repeat(MAX_INPUT_BYTES)}]};
    await assert.rejects(()=>requestTasteProfile(large,{...live(f),fetch:mock}),/byte limit/);
    assert.equal(calls,0);
  } finally{f.cleanup();}
});
