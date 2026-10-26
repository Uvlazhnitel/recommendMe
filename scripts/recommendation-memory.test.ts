import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { test } from 'node:test';
import { migrateDatabase } from '../src/lib/migrations';
import { buildTasteContext } from '../src/lib/taste-context';
import { prepareTasteInputs, readCandidateHistory, blockedReason } from '../src/lib/candidate-context';
import { recordRecommendations, recommendationHistory, rejectRecommendation } from '../src/lib/recommendation-memory';
import { recentlyRecommended, RECOMMENDATION_REPEAT_MS } from '../src/lib/recommendation-policy';
import { rankRecommendations } from '../src/lib/recommendations';
import { generateCandidates } from '../src/lib/candidates';
import type { MovieCandidate } from '../src/lib/candidates';

const candidate = (id=201):MovieCandidate=>({tmdb_id:id,media_type:'movie',title:`Candidate ${id}`,original_title:null,year:2000,overview:'Verified story.',
  genres:[{id:1,name:'Drama'}],runtime:100,directors:[{id:10,name:'Director'}],vote_count:0,popularity:0,source:'llm'});
const report=(ids=[201])=>({mode:'live',status:'ok',candidates:ids.map(candidate)});
const choice=(tmdb_id=201)=>({tmdb_id,why_fit:'A verified parallel to a real high personal rating.',possible_mismatch:'Pacing remains uncertain from the available data.',evidence:[{movie_id:1,rating_100:100}]});
const result=(ids=[201],result_id='saved-result')=>({mode:'live',status:'ok',result_id,generated_at:new Date(Date.now()-1000).toISOString(),recommendations:ids.map(choice)});
function fixture(version=4){
  const dir=mkdtempSync(join(tmpdir(),'recommendation-memory-')),path=join(dir,'movies.sqlite'),db=new Database(path);db.pragma('foreign_keys=ON');
  if(version===3){for(const file of ['001_initial','002_letterboxd_rating_date','003_tmdb_metadata'])db.exec(readFileSync(`migrations/${file}.sql`,'utf8'));db.pragma('user_version=3');}else migrateDatabase(db);
  db.exec(`INSERT INTO movies(id,title,release_year,tmdb_id,media_type,runtime_minutes,overview,genres_json,directors_json) VALUES
    (1,'Favourite',2000,101,'movie',100,'Known description','[{"id":1,"name":"Drama"}]','[{"id":10,"name":"Director"}]'),
    (2,'Low',2000,102,'movie',100,'Known description','[{"id":1,"name":"Drama"}]','[{"id":10,"name":"Director"}]'),
    (3,'Unrated',2000,103,'movie',100,'Known description','[{"id":1,"name":"Drama"}]','[{"id":10,"name":"Director"}]');
    INSERT INTO user_movies(movie_id,watched,rating_100) VALUES(1,1,100),(2,1,0),(3,1,NULL);`);
  const context=buildTasteContext(db);
  db.prepare('INSERT INTO taste_profile(profile_json) VALUES(?)').run(JSON.stringify({
    strong_preferences:[{summary:'Positive',explanation:'High evidence.',kind:'observation',uncertainty:'Limited sample.',evidence:[{movie_id:1,rating_100:100}]}],
    negative_patterns:[{summary:'Negative',explanation:'Low evidence.',kind:'hypothesis',uncertainty:'Uncertain cause.',evidence:[{movie_id:2,rating_100:0}]}],
    contrasts:[{higher:{movie_id:1,rating_100:100},lower:{movie_id:2,rating_100:0},similarity:'Shared director.',possible_difference:'Unconfirmed.',uncertainty:'Limited.'}],
    uncertainties:[{description:'Sample size.',evidence:[]}],profile_version:1,generated_at:new Date().toISOString(),ratings_count:2,ratings_snapshot:context.snapshot,
    context_fingerprint:context.fingerprint,prompt_version:1,schema_version:1,contrast_pairs_count:1,requested_model:'mock-model',model:'mock-model',response_id:null,usage:null}));
  let sequence=0;
  return {db,dir,path,backup:()=>join(dir,`backup-${sequence++}.sqlite`),cleanup(){db.close();rmSync(dir,{recursive:true,force:true});}};
}
function mock(ids=[201],handler?:()=>void){
  let calls=0;
  return {get calls(){return calls;},options:{live:true,apiKey:'mock-memory-key',model:'mock-model',fetch:(async()=>{
    calls++;handler?.();return Response.json({status:'completed',model:'mock-model',usage:{input_tokens:50,output_tokens:40},output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({recommendations:ids.map(choice)})}]}]});
  }) as typeof fetch}};
}
const count=(db:Database.Database,table='recommendations')=>(db.prepare(`SELECT count(*) n FROM ${table}`).get() as {n:number}).n;
const personal=(db:Database.Database)=>db.prepare('SELECT * FROM user_movies ORDER BY movie_id').all();
const snapshot=(db:Database.Database)=>['movies','user_movies','recommendations','taste_profile'].map(table=>db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all());

test('migration 3→4 preserves existing rows; legacy history is readable and the new key is unique',()=>{
  const f=fixture(3);
  try{f.db.exec('INSERT INTO recommendations(movie_id) VALUES(1)');const old=recommendationHistory(f.db);assert.equal(old.length,1);
    const before=personal(f.db);assert.equal(migrateDatabase(f.db),4);assert.deepEqual(personal(f.db),before);assert.deepEqual(recommendationHistory(f.db),old);
    assert.equal((f.db.prepare('SELECT result_id FROM recommendations').get() as {result_id:null}).result_id,null);
    f.db.exec("INSERT INTO recommendations(movie_id,result_id) VALUES(1,'one')");assert.throws(()=>f.db.exec("INSERT INTO recommendations(movie_id,result_id) VALUES(1,'one')"));
    const stable=f.db.serialize();migrateDatabase(f.db);assert.deepEqual(f.db.serialize(),stable);
  }finally{f.cleanup();}
});

test('explicit live save records five or fewer real IDs and metadata without personal changes',async()=>{
  for(const ids of [[201,202,203,204,205],[201,202]]){const f=fixture(3),h=mock(ids),before=personal(f.db),backup=f.backup();
    try{const ranked=await rankRecommendations(f.db,report(ids),{...h.options,save:true,backupPath:backup});assert.equal(ranked.status,'ok');assert.equal(ranked.save?.saved_count,ids.length);assert.equal(h.calls,1);
      assert.equal(count(f.db),ids.length);assert.deepEqual(personal(f.db),before);assert.ok(ranked.result_id);assert.ok(ranked.generated_at);
      const rows=f.db.prepare('SELECT tmdb_id,letterboxd_uri,media_type,tmdb_title,runtime_minutes,tmdb_attempted_at FROM movies WHERE tmdb_id>=201 ORDER BY tmdb_id').all() as Record<string,unknown>[];
      assert.deepEqual(rows.map(row=>row.tmdb_id),ids);assert.ok(rows.every(row=>row.letterboxd_uri===null&&row.media_type==='movie'&&row.runtime_minutes===100&&row.tmdb_attempted_at===null));
      const copy=new Database(backup,{readonly:true});try{assert.equal(copy.pragma('user_version',{simple:true}),3);assert.equal(count(copy),0);}finally{copy.close();}
    }finally{f.cleanup();}}
});

test('dry-run and live without save remain read-only; bad save flags fail before any request',async()=>{
  const f=fixture(3),h=mock(),before=readFileSync(f.path);f.db.pragma('query_only=ON');
  try{await rankRecommendations(f.db,report(),{});const ranked=await rankRecommendations(f.db,report(),h.options);assert.equal(ranked.status,'ok');assert.equal(ranked.save,null);
    await assert.rejects(()=>rankRecommendations(f.db,report(),{save:true}),/requires explicit/);assert.equal(h.calls,1);assert.deepEqual(readFileSync(f.path),before);
    assert.equal(f.db.pragma('user_version',{simple:true}),3);
  }finally{f.cleanup();}
});

test('API failure writes no rows or migration; backup failure prevents a paid request',async()=>{
  const f=fixture(3),before=snapshot(f.db),h=mock();
  try{const failed=await rankRecommendations(f.db,report(),{...h.options,save:true,backupPath:f.backup(),fetch:async()=>Response.json({},{status:500})});
    assert.equal(failed.status,'error');assert.equal(failed.save,null);assert.deepEqual(snapshot(f.db),before);assert.equal(f.db.pragma('user_version',{simple:true}),3);
    await assert.rejects(()=>rankRecommendations(f.db,report(),{...h.options,save:true,backupPath:join(f.dir,'missing','backup.sqlite')}));assert.equal(h.calls,0);assert.deepEqual(snapshot(f.db),before);
  }finally{f.cleanup();}
});

test('re-saving the same result is a no-op even after ratings change; conflicting identities are rejected',()=>{
  const f=fixture(),saved=result([201,202]);
  try{assert.equal(recordRecommendations(f.db,report([201,202]),{result:saved},{dryRun:false}).saved_count,2);const before=f.db.prepare('SELECT * FROM recommendations').all();
    f.db.exec('UPDATE user_movies SET rating_100=90 WHERE movie_id=1');
    const replay=recordRecommendations(f.db,report([201,202]),{result:saved},{dryRun:false});assert.equal(replay.saved_count,0);assert.equal(replay.already_saved_count,2);assert.deepEqual(f.db.prepare('SELECT * FROM recommendations').all(),before);
    assert.throws(()=>recordRecommendations(f.db,report([201]),{result:{...saved,recommendations:[choice(201)]}},{dryRun:false}),/conflicts/);
  }finally{f.cleanup();}
});

test('a partially saved batch is processed once; later unblocking never adds leftover rows',()=>{
  const f=fixture();
  try{f.db.exec("INSERT INTO movies(tmdb_id,title) VALUES(201,'Candidate 201'); INSERT INTO user_movies(movie_id,not_interested) VALUES(last_insert_rowid(),1)");
    const a=recordRecommendations(f.db,report([201,202]),{tmdbIds:[201,202]},{dryRun:false});assert.equal(a.saved_count,1);assert.equal(a.skipped[0].reason,'not_interested');
    rejectRecommendation(f.db,201,true);const b=recordRecommendations(f.db,report([201,202]),{tmdbIds:[202,201]},{dryRun:false});assert.equal(b.saved_count,0);assert.equal(b.already_saved_count,1);assert.equal(count(f.db),1);
  }finally{f.cleanup();}
});

test('SQL error rolls back new movies and rows; valid paid result and usage survive for offline retry',async()=>{
  const f=fixture(),h=mock([201,202]);f.db.exec("CREATE TRIGGER fail_save BEFORE INSERT ON recommendations WHEN (SELECT tmdb_id FROM movies WHERE id=NEW.movie_id)=202 BEGIN SELECT RAISE(ABORT,'forced save failure'); END");const before=snapshot(f.db);
  try{const paid=await rankRecommendations(f.db,report([201,202]),{...h.options,save:true,backupPath:f.backup()});
    assert.equal(paid.status,'ok');assert.equal(paid.save?.status,'error');assert.equal(paid.recommendations.length,2);assert.ok(paid.result_id);assert.deepEqual(paid.statistics.usage,{input_tokens:50,output_tokens:40});assert.equal(h.calls,1);assert.deepEqual(snapshot(f.db),before);
    f.db.exec('DROP TRIGGER fail_save');const retry=recordRecommendations(f.db,report([201,202]),{result:JSON.parse(JSON.stringify(paid))},{dryRun:false});assert.equal(retry.saved_count,2);assert.equal(h.calls,1);
  }finally{f.cleanup();}
});

test('existing movie metadata, Letterboxd fields and personal ratings remain intact',()=>{
  const f=fixture();
  try{f.db.exec("INSERT INTO movies(tmdb_id,title,release_year,letterboxd_uri,overview) VALUES(201,'Original local title',1999,'https://letterboxd.com/film/private/','Keep me'); INSERT INTO user_movies(movie_id,watched,rating_100,original_rating_stars,rating_source) VALUES(last_insert_rowid(),0,0,0,'manual')");
    const metadata=f.db.prepare('SELECT * FROM movies WHERE tmdb_id=201').get(),history=personal(f.db);
    const saved=recordRecommendations(f.db,report(),{tmdbIds:[201]},{dryRun:false});assert.equal(saved.saved_count,1);assert.deepEqual(f.db.prepare('SELECT * FROM movies WHERE tmdb_id=201').get(),metadata);assert.deepEqual(personal(f.db),history);
    assert.equal(count(f.db,'movies'),4);
  }finally{f.cleanup();}
});

test('30-day boundary is strict; the latest show controls eligibility and rejection history is not a global block',()=>{
  const f=fixture(),now=Date.now();
  try{recordRecommendations(f.db,report(),{tmdbIds:[201]},{dryRun:false,now});const identity={id:201,title:'Candidate 201',original_title:null,year:2000};
    assert.equal(blockedReason(identity,readCandidateHistory(f.db),now+RECOMMENDATION_REPEAT_MS-1),'recently_recommended');
    assert.equal(blockedReason(identity,readCandidateHistory(f.db),now+RECOMMENDATION_REPEAT_MS),null);
    assert.equal(recentlyRecommended(new Date(now).toISOString(),now+RECOMMENDATION_REPEAT_MS),false);
    f.db.prepare('UPDATE recommendations SET rejected=1,recommended_at=?').run(new Date(now-RECOMMENDATION_REPEAT_MS).toISOString());assert.equal(blockedReason(identity,readCandidateHistory(f.db),now),null);
    f.db.prepare('INSERT INTO recommendations(movie_id,recommended_at) SELECT id,? FROM movies WHERE tmdb_id=201').run(new Date(now-1000).toISOString());assert.equal(blockedReason(identity,readCandidateHistory(f.db),now),'recently_recommended');
  }finally{f.cleanup();}
});

test('recent films are filtered before paid ranking and smaller lists explain the reduction',async()=>{
  const f=fixture();
  try{recordRecommendations(f.db,report(),{tmdbIds:[201]},{dryRun:false});const h=mock();const empty=await rankRecommendations(f.db,report(),h.options);assert.equal(empty.status,'error');assert.equal(h.calls,0);assert.equal(empty.diagnostics[0].reason,'recently_recommended');
    const other=mock([202]);const small=await rankRecommendations(f.db,report([201,202]),other.options);assert.equal(small.recommendations.length,1);assert.equal(other.calls,1);assert.ok(small.warnings.some(row=>row.includes('30 days')));
  }finally{f.cleanup();}
});

test('candidate generation also filters recent IDs before requesting details',async()=>{
  const f=fixture();let details=0;
  try{recordRecommendations(f.db,report(),{tmdbIds:[201]},{dryRun:false});
    const generated=await generateCandidates(f.db,{live:true,apiKey:'mock',model:'mock',tmdbKey:'mock',sleep:async()=>{},
      openaiFetch:async()=>Response.json({status:'completed',model:'mock',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({candidates:[{title:'Candidate 201',year:2000}]})}]}]}),
      tmdbFetch:async(input)=>{const url=new URL(String(input));if(url.pathname.endsWith('/recommendations'))return Response.json({results:[]});if(url.pathname.includes('/search/'))return Response.json({total_pages:1,results:[{id:201,title:'Candidate 201',release_date:'2000-01-01'}]});details++;throw new Error('Unexpected details request');}});
    if(generated.mode!=='live')return;assert.equal(generated.candidates.length,0);assert.equal(generated.rejected_by_reason.recently_recommended,1);assert.equal(details,0);
  }finally{f.cleanup();}
});

test('reject/undo is atomic and repeatable, preserves ratings, and keeps historical rejection',()=>{
  const f=fixture();
  try{recordRecommendations(f.db,report(),{tmdbIds:[201]},{dryRun:false});const before=personal(f.db);rejectRecommendation(f.db,201);
    const row=f.db.prepare('SELECT u.* FROM user_movies u JOIN movies m ON m.id=u.movie_id WHERE m.tmdb_id=201').get() as Record<string,unknown>;
    assert.equal(row.watched,0);assert.equal(row.rating_100,null);assert.equal(row.rating_source,'none');assert.equal(row.not_interested,1);assert.equal((recommendationHistory(f.db)[0] as {rejected:number}).rejected,1);
    const unchanged=snapshot(f.db);assert.deepEqual(rejectRecommendation(f.db,201),{tmdb_id:201,not_interested:true,personal_changes:0,history_changes:0});assert.deepEqual(snapshot(f.db),unchanged);
    rejectRecommendation(f.db,201,true);assert.equal((recommendationHistory(f.db)[0] as {not_interested:number}).not_interested,0);assert.equal((recommendationHistory(f.db)[0] as {rejected:number}).rejected,1);
    assert.deepEqual(personal(f.db).slice(0,3),before);
    for(const id of [101,102]){const original=f.db.prepare('SELECT rating_100,watched,original_rating_stars,rating_source FROM user_movies WHERE movie_id=?').get(id===101?1:2);rejectRecommendation(f.db,id);rejectRecommendation(f.db,id,true);
      assert.deepEqual(f.db.prepare('SELECT rating_100,watched,original_rating_stars,rating_source FROM user_movies WHERE movie_id=?').get(id===101?1:2),original);}
    assert.throws(()=>rejectRecommendation(f.db,999),/not in the local library/);
  }finally{f.cleanup();}
});

test('a permanent hidden flag survives the cooldown; undo still respects recent history',()=>{
  const f=fixture(),now=Date.now();
  try{recordRecommendations(f.db,report(),{tmdbIds:[201]},{dryRun:false,now});rejectRecommendation(f.db,201);const identity={id:201,title:'Candidate 201',original_title:null,year:2000};
    assert.equal(blockedReason(identity,readCandidateHistory(f.db),now+RECOMMENDATION_REPEAT_MS*10),'not_interested');rejectRecommendation(f.db,201,true);
    assert.equal(blockedReason(identity,readCandidateHistory(f.db),now),'recently_recommended');assert.equal(blockedReason(identity,readCandidateHistory(f.db),now+RECOMMENDATION_REPEAT_MS),null);
  }finally{f.cleanup();}
});

test('concurrent visibility changes are checked inside saving, even after a successful earlier preview',()=>{
  const f=fixture(),other=new Database(f.path);other.pragma('foreign_keys=ON');
  try{const preview=recordRecommendations(f.db,report(),{tmdbIds:[201]});assert.equal(preview.would_save_count,1);
    other.exec("INSERT INTO movies(tmdb_id,title) VALUES(201,'Candidate 201'); INSERT INTO user_movies(movie_id,watched) VALUES(last_insert_rowid(),1)");
    const blocked=recordRecommendations(f.db,report(),{tmdbIds:[201]},{dryRun:false});assert.equal(blocked.saved_count,0);assert.equal(blocked.skipped[0].reason,'watched');assert.equal(count(f.db),0);
    other.exec('UPDATE user_movies SET watched=0,not_interested=1 WHERE movie_id=(SELECT id FROM movies WHERE tmdb_id=201)');
    assert.equal(recordRecommendations(f.db,report(),{tmdbIds:[201]},{dryRun:false}).skipped[0].reason,'not_interested');
  }finally{other.close();f.cleanup();}
});

test('two independent simultaneous writers cannot record the same movie twice',async()=>{
  const f=fixture(),input=join(f.dir,'candidates.json'),worker=join(f.dir,'worker.ts');writeFileSync(input,JSON.stringify(report()));
  writeFileSync(worker,`import {createRequire} from 'node:module'; import {readFileSync} from 'node:fs'; import {recordRecommendations} from ${JSON.stringify(resolve('src/lib/recommendation-memory.ts'))};
    const require=createRequire(${JSON.stringify(resolve('package.json'))});const D=require('better-sqlite3');const db=new D(process.argv[2]);db.pragma('foreign_keys=ON');
    const result={mode:'live',status:'ok',result_id:process.argv[4],recommendations:[${JSON.stringify(choice())}]};
    try{console.log(JSON.stringify(recordRecommendations(db,JSON.parse(readFileSync(process.argv[3],'utf8')),{result},{dryRun:false})));}finally{db.close();}`);
  const run=(key:string)=>new Promise<{saved_count:number;status:string}>((accept,reject)=>{
    const child=spawn(process.execPath,['--import','tsx',worker,f.path,input,key],{cwd:resolve('.')});let out='',err='';child.stdout.on('data',v=>out+=v);child.stderr.on('data',v=>err+=v);
    child.on('error',reject);child.on('close',code=>code===0?accept(JSON.parse(out)):reject(new Error(err)));
  });
  try{const results=await Promise.all([run('first-run'),run('second-run')]);assert.equal(results.reduce((sum,row)=>sum+row.saved_count,0),1);assert.equal(count(f.db),1);assert.ok(results.some(row=>row.status==='skipped'));}
  finally{f.cleanup();}
});

test('history survives a new connection and does not depend on a candidate JSON file',()=>{
  const f=fixture();
  try{recordRecommendations(f.db,report(),{tmdbIds:[201]},{dryRun:false});const another=new Database(f.path,{readonly:true});
    try{const history=recommendationHistory(another) as Record<string,unknown>[];assert.equal(history[0].tmdb_id,201);assert.equal(history[0].title,'Candidate 201');assert.equal(history[0].why_fit,null);assert.equal(history[0].possible_mismatch,null);assert.equal(history[0].not_interested,0);}finally{another.close();}
  }finally{f.cleanup();}
});

test('refresh counts net rating changes, includes zero/clear, and reaches the 9/10 threshold without API',()=>{
  const f=fixture();
  try{assert.equal(prepareTasteInputs(f.db).profileRefresh.status,'current');
    for(let id=20;id<30;id++){f.db.prepare('INSERT INTO movies(id,title) VALUES(?,?)').run(id,`New ${id}`);f.db.prepare('INSERT INTO user_movies(movie_id,watched,rating_100) VALUES(?,1,?)').run(id,id===20?0:80);}
    let status=prepareTasteInputs(f.db).profileRefresh;assert.equal(status.status,'refresh_recommended');assert.equal(status.added,10);assert.equal(status.total_changes,10);
    f.db.exec('UPDATE user_movies SET rating_100=NULL WHERE movie_id=29');status=prepareTasteInputs(f.db).profileRefresh;assert.equal(status.status,'stale');assert.equal(status.added,9);
    f.db.exec('UPDATE user_movies SET rating_100=NULL WHERE movie_id=1');status=prepareTasteInputs(f.db).profileRefresh;assert.equal(status.status,'refresh_recommended');assert.equal(status.cleared,1);
    f.db.exec('UPDATE user_movies SET rating_100=40 WHERE movie_id=2');assert.equal(prepareTasteInputs(f.db).profileRefresh.changed,1);
    f.db.exec('UPDATE user_movies SET rating_100=0 WHERE movie_id=2; UPDATE user_movies SET rating_100=100 WHERE movie_id=1');assert.equal(prepareTasteInputs(f.db).profileRefresh.total_changes,9);
  }finally{f.cleanup();}
});

test('unrated watches and not_interested never become negative taste evidence or refresh changes',()=>{
  const f=fixture();
  try{const before=prepareTasteInputs(f.db);rejectRecommendation(f.db,103);rejectRecommendation(f.db,102);const after=prepareTasteInputs(f.db);
    assert.deepEqual(after.changes,before.changes);assert.deepEqual(after.profileRefresh,before.profileRefresh);assert.equal(after.taste?.fingerprint,before.taste?.fingerprint);
    assert.ok(after.rated.some(row=>row.id===2&&row.rating_100===0));assert.ok(!after.rated.some(row=>row.id===3));
  }finally{f.cleanup();}
});

test('record/history/status CLIs are read-only on schema 3; explicit writes and backup stay in a temporary directory',()=>{
  const f=fixture(3),input=join(f.dir,'candidates.json');writeFileSync(input,JSON.stringify(report()));
  const run=(file:string,args:string[]=[])=>spawnSync(process.execPath,['--import','tsx',`scripts/${file}.ts`,...args],{cwd:resolve('.'),env:{...process.env,DATABASE_PATH:f.path},encoding:'utf8'});
  try{const before=readFileSync(f.path);
    for(const [name,args] of [['recommendations-record',['--input',input,'--tmdb-ids','201']],['recommendations-history',[]],['taste-status',[]]] as [string,string[]][]){const child=run(name,args);assert.equal(child.status,0,child.stderr);}
    assert.deepEqual(readFileSync(f.path),before);assert.equal(f.db.pragma('user_version',{simple:true}),3);
    for(const args of [['--save'],['--input',input,'--tmdb-ids','201','--dry-run','--save'],['--input',input,'--tmdb-ids','201','--result',input]])assert.equal(run('recommendations-record',args).status,1);
    assert.equal(run('recommendations-rank',['--input',input,'--save']).status,1);
    const written=run('recommendations-record',['--input',input,'--tmdb-ids','201','--save']);assert.equal(written.status,0,written.stderr);assert.equal(JSON.parse(written.stdout).saved_count,1);
    assert.equal(run('recommendations-reject',['--tmdb-id','201']).status,0);assert.equal(run('recommendations-reject',['--tmdb-id','201','--undo']).status,0);
    assert.equal(count(f.db),1);
  }finally{f.cleanup();}
});

test('legacy saved results have stable keys and real explanations; invalid or failed results cannot be saved',()=>{
  const f=fixture(),legacy={mode:'live',status:'ok',recommendations:[{...choice(),title:'App title',year:2000,evidence:[{movie_id:1,rating_100:100,title:'Favourite',year:2000}]}]};
  try{const first=recordRecommendations(f.db,report(),{result:legacy},{dryRun:false});assert.equal(first.saved_count,1);assert.match(first.result_id!,/^legacy:/);
    assert.equal(recordRecommendations(f.db,report(),{result:legacy},{dryRun:false}).already_saved_count,1);assert.equal((recommendationHistory(f.db)[0] as {why_fit:string}).why_fit,choice().why_fit);
    for(const bad of [{...legacy,status:'error'}, {...legacy,mode:'dry-run'},{...legacy,recommendations:[]},{...result(),recommendations:[{...choice(),confidence_score:99}]}])assert.throws(()=>recordRecommendations(f.db,report(),{result:bad},{dryRun:false}));
    assert.throws(()=>recordRecommendations(f.db,report(),{tmdbIds:[999]},{dryRun:false}),/absent/);
  }finally{f.cleanup();}
});

test('reject transaction rolls back the personal flag when updating rejection history fails',()=>{
  const f=fixture();
  try{recordRecommendations(f.db,report(),{tmdbIds:[201]},{dryRun:false});
    f.db.exec("CREATE TRIGGER fail_reject BEFORE UPDATE OF rejected ON recommendations BEGIN SELECT RAISE(ABORT,'forced rejection failure'); END");const before=snapshot(f.db);
    assert.throws(()=>rejectRecommendation(f.db,201),/forced rejection/);assert.deepEqual(snapshot(f.db),before);
  }finally{f.cleanup();}
});

test('an unwritable connection fails before backup or paid save request',async()=>{
  const f=fixture(),h=mock();f.db.pragma('query_only=ON');
  try{await assert.rejects(()=>rankRecommendations(f.db,report(),{...h.options,save:true,backupPath:f.backup()}),/writable/);assert.equal(h.calls,0);}
  finally{f.cleanup();}
});
