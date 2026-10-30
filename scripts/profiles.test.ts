import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { migrateDatabase } from '../src/lib/migrations';
import { PROFILES, ProfileError } from '../src/lib/profiles';
import { chooseProfile, getProfile, profileRoute, PROFILE_COOKIE } from '../src/lib/profile-http';
import { fixture, mockProvider, config } from './fixtures/recommendation-screen';
import { profileRequest } from './fixtures/profile-request';
import { readLibrary, readLibraryMovie, updateLibraryRating } from '../src/lib/library';
import { updateMovieReview } from '../src/lib/movie-review';
import { confirmMovieWatch } from '../src/lib/movie-watch';
import { readHomeSummary } from '../src/lib/home-summary';
import { generateRecommendationBatch, recommendationState } from '../src/lib/recommendation-service';
import { setRecommendationRejection } from '../src/lib/recommendation-http';
import { readCandidateHistory, seedRotation, prepareTasteInputs } from '../src/lib/candidate-context';
import { buildRankingContext } from '../src/lib/recommendation-context';
import { evaluationReport } from '../src/lib/evaluation-report';
import { runStore } from '../src/lib/recommendation-runs';
import { backupDatabase, restoreBackup, verifyBackup } from './container-db.mjs';

function legacy(){const dir=mkdtempSync(join(tmpdir(),'profiles-legacy-')),path=join(dir,'movies.sqlite'),db=new Database(path);db.pragma('foreign_keys=ON');for(const p of ['001_initial','002_letterboxd_rating_date','003_tmdb_metadata','004_recommendation_memory','005_movie_backdrop','006_movie_reviews','007_evaluation'])db.exec(readFileSync('migrations/'+p+'.sql','utf8'));db.pragma('user_version=7');
 db.exec(`INSERT INTO movies(id,title) VALUES(1,'Legacy'),(2,'Unrated');INSERT INTO user_movies(movie_id,watched,rating_100,review_text,created_at,updated_at) VALUES(1,1,0,'  Exact\nreview 🎬  ','2001','2002'),(2,1,NULL,NULL,'2003','2004');INSERT INTO taste_profile(id,profile_json,created_at,updated_at) VALUES(1,'{"saved":"unchanged"}','2005','2006');INSERT INTO recommendations(id,movie_id,result_id,why_fit,possible_mismatch,recommended_at) VALUES(17,1,'legacy:one','exact reason','exact risk','2007'),(18,2,NULL,NULL,NULL,'2008');INSERT INTO recommendation_evaluation(result_id,saved_at,metadata_json) VALUES('legacy:one','2009','{"algorithm_id":"unknown"}');INSERT INTO recommendation_outcomes(movie_id,recommendation_id,watch_recorded_at,first_rating_recorded_at) VALUES(1,17,'2010','2011');`);
 return {db,dir,path,cleanup(){db.close();rmSync(dir,{recursive:true,force:true});}};}
const tables=['user_movies','taste_profile','recommendations','recommendation_evaluation','recommendation_outcomes'];
const snapshot=(db:Database.Database)=>Object.fromEntries(tables.map(t=>[t,db.prepare('SELECT * FROM '+t+' ORDER BY rowid').all() as Record<string,unknown>[]]));
const noBackup={backup:async()=>{}};
function valeriy(f:ReturnType<typeof fixture>){f.db.exec(`INSERT INTO user_movies(user_id,movie_id,watched,rating_100,review_text) VALUES('valeriy',1,1,100,'VALERIY_ONLY'),('valeriy',2,1,0,NULL);UPDATE user_movies SET review_text='ILYA_ONLY' WHERE user_id='ilya' AND movie_id=1;`);const own=JSON.parse((f.db.prepare("SELECT profile_json FROM taste_profile WHERE user_id='ilya'").get() as {profile_json:string}).profile_json);own.strong_preferences[0].summary='VALERIY_PROFILE';f.db.prepare("INSERT INTO taste_profile(user_id,profile_json) VALUES('valeriy',?)").run(JSON.stringify(own));}

test('profiles migration7→8 preserves every old value/ID, empty Valeriy, idempotence and exact rollback',()=>{
 const f=legacy();try{const old=snapshot(f.db);assert.equal(migrateDatabase(f.db),10);assert.deepEqual(f.db.prepare('SELECT * FROM profiles ORDER BY id').all(),PROFILES.map(p=>({id:p.id,name:p.name})));
  for(const t of tables){const rows=f.db.prepare('SELECT * FROM '+t+" WHERE user_id=\'ilya\' ORDER BY rowid").all() as Record<string,unknown>[];assert.deepEqual(rows.map(({user_id:_,...r})=>{if(t==='user_movies')delete r.watchlist;return r;}),old[t].map(r=>{const copy={...r};if(t==='taste_profile')delete copy.id;return copy;}));assert.equal((f.db.prepare('SELECT count(*) n FROM '+t+" WHERE user_id='valeriy'").get() as {n:number}).n,0);}
  const once=f.db.serialize();migrateDatabase(f.db);assert.deepEqual(f.db.serialize(),once);assert.deepEqual(f.db.pragma('foreign_key_check'),[]);
  assert.throws(()=>f.db.exec("INSERT INTO recommendation_outcomes(user_id,movie_id,recommendation_id) VALUES('valeriy',1,17)"),/FOREIGN KEY/);
 }finally{f.cleanup();}
 const bad=legacy();try{bad.db.exec('DELETE FROM recommendation_outcomes;INSERT INTO recommendation_outcomes(movie_id,recommendation_id) VALUES(2,17)');const before=bad.db.serialize();assert.throws(()=>migrateDatabase(bad.db),/FOREIGN KEY/);assert.deepEqual(bad.db.serialize(),before);assert.equal(bad.db.pragma('user_version',{simple:true}),7);assert.equal(bad.db.pragma('foreign_keys',{simple:true}),1);}finally{bad.cleanup();}
});
test('same movie has independent 0/NULL, reviews, watches, favorite state and exact owner triggers',async()=>{
 const f=fixture();try{const original=snapshot(f.db);assert.equal(readLibrary(f.db,'valeriy').total,0);assert.deepEqual(readHomeSummary(f.db,'valeriy'),{stats:{watched:0,rated:0},favorites:[]});assert.equal(readLibraryMovie(f.db,'valeriy',1).watched,false);
  await confirmMovieWatch(f.db,'valeriy',{movie_id:1,watched:true,rating_100:0,review_text:'Father exact'},noBackup);assert.equal(readLibraryMovie(f.db,'valeriy',1).rating_100,0);assert.equal(readLibraryMovie(f.db,'ilya',1).rating_100,100);
  await updateMovieReview(f.db,'valeriy',1,'changed',noBackup);await updateLibraryRating(f.db,'valeriy',1,null,noBackup);assert.equal(readLibraryMovie(f.db,'valeriy',1).rating_100,null);assert.equal(readLibraryMovie(f.db,'valeriy',1).review_text,'changed');
  await setRecommendationRejection(f.db,'valeriy',102,false,noBackup);assert.equal(readCandidateHistory(f.db,'ilya').find(r=>r.id===2)!.not_interested,0);assert.equal(readCandidateHistory(f.db,'valeriy').find(r=>r.id===2)!.not_interested,1);await setRecommendationRejection(f.db,'valeriy',102,true,noBackup);
  for(const t of tables)assert.deepEqual(f.db.prepare('SELECT * FROM '+t+" WHERE user_id=\'ilya\' ORDER BY rowid").all(),original[t]);assert.deepEqual(f.db.pragma('foreign_key_check'),[]);
 }finally{f.cleanup();}
});
test('profile HTTP has no default, rejects unknown/stale/ABA before operations, cookie and Origin preserved',async()=>{
 let operations=0;const route=profileRoute((_req,_owner)=>{operations++;return Response.json({ok:true});});
 assert.equal((await route(new Request('http://localhost/api/library'))).status,428);
 assert.equal((await route(profileRequest('http://localhost/api/library',{},'valeriy'))).status,200);
 assert.equal((await route(profileRequest('http://localhost/api/library',{headers:{'X-Profile-ID':'bad'}}))).status,400);
 assert.equal((await route(profileRequest('http://localhost/api/library',{headers:{'X-Profile-Selection':randomUUID()}}))).status,409);assert.equal(operations,1);
 const choose=()=>chooseProfile(new Request('https://localhost/api/profile',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({user_id:'ilya'})}));const a=await choose(),b=await choose();assert.equal(a.status,200);assert.match(a.headers.get('set-cookie')!,/HttpOnly; SameSite=Strict; Secure/);assert.notEqual((await a.json()).active.selection_id,(await b.json()).active.selection_id);
 assert.equal((await getProfile(new Request('http://localhost'))).status,200);assert.equal((await (getProfile(new Request('http://localhost'))).json()).active,null);
 const bad=await chooseProfile(new Request('http://localhost/api/profile',{method:'POST',headers:{Origin:'null','Content-Type':'application/json'},body:'{"user_id":"ilya"}'}));assert.equal(bad.status,403);
});
test('personal operations reject schema7 without backups, migrations or API calls',async()=>{
 const f=legacy();try{const before=f.db.serialize();let calls=0;await assert.rejects(confirmMovieWatch(f.db,'ilya',{movie_id:1,watched:true},{backup:async()=>{calls++;}}),ProfileError);assert.throws(()=>readLibrary(f.db,'ilya'),ProfileError);assert.equal(calls,0);assert.deepEqual(f.db.serialize(),before);}finally{f.cleanup();}
});
test('two independent complete pipelines: exact two calls each, no context leakage, owner replay and outcomes',async()=>{
 const f=fixture(),a=mockProvider(),b=mockProvider(),id=randomUUID();valeriy(f);
 try{const first=await generateRecommendationBatch('ilya',id,{open:f.open,config,fetch:a.fetch});assert.equal(a.bodies.length,2);assert.ok(JSON.stringify(a.bodies).includes('ILYA_ONLY'));assert.ok(!JSON.stringify(a.bodies).includes('VALERIY_ONLY'));assert.equal(seedRotation(f.db,'ilya'),1);assert.equal(seedRotation(f.db,'valeriy'),0);
  for(const saveOnly of [false,true])await assert.rejects(generateRecommendationBatch('valeriy',id,{open:f.open,config,fetch:b.fetch},{saveOnly}),/profile_mismatch/);assert.equal(b.bodies.length,0);
  await generateRecommendationBatch('ilya',id,{open:f.open,config:()=>({}),fetch:async()=>{throw Error('must be free');}});assert.equal(a.bodies.length,2);
  const second=await generateRecommendationBatch('valeriy',randomUUID(),{open:f.open,config,fetch:b.fetch});assert.equal(b.bodies.length,2);assert.ok(JSON.stringify(b.bodies).includes('VALERIY_ONLY'));assert.ok(!JSON.stringify(b.bodies).includes('ILYA_ONLY'));
  assert.notEqual(first.batch!.result_id,second.batch!.result_id);const movie=second.batch!.movies[0];await confirmMovieWatch(f.db,'valeriy',{movie_id:movie.movie_id,watched:true,rating_100:0},noBackup);
  assert.equal(evaluationReport(f.db,'valeriy').total.observed,1);assert.equal(evaluationReport(f.db,'valeriy').total.mean_rating,0);assert.equal(evaluationReport(f.db,'ilya').total.observed,0);
  await updateLibraryRating(f.db,'valeriy',movie.movie_id,null,noBackup);assert.equal(evaluationReport(f.db,'valeriy').total.observed,0);assert.equal(evaluationReport(f.db,'ilya').total.batches,1);
  assert.equal(readLibraryMovie(f.db,'ilya',movie.movie_id).watched,false);assert.equal(recommendationState('ilya',{open:f.open,config}).batch!.movies.length,2);assert.equal(recommendationState('valeriy',{open:f.open,config}).batch!.movies.length,1);
 }finally{f.cleanup();}
});
test('common lock reveals no foreign ID/stage, legacy flat journals are Ilya-only, backup restores both namespaces',async()=>{
 const f=fixture();valeriy(f);try{const id=randomUUID(),release=runStore(f.path,'ilya').acquire(id);try{const v=recommendationState('valeriy',{open:f.open,config});assert.equal(v.generation.state,'busy_other');assert.equal(v.generation.request_id,null);assert.equal(v.generation.stage,null);}finally{release();}
  const root=join(f.dir,'.recommendation-runs',createHash('sha256').update(realpathSync(f.path)).digest('hex').slice(0,24));mkdirSync(root,{recursive:true});const legacyId=randomUUID();writeFileSync(join(root,legacyId+'.json'),JSON.stringify({request_id:legacyId,stage:'failed',started_at:new Date().toISOString()}));assert.equal(runStore(f.path,'ilya').read(legacyId)!.user_id,'ilya');assert.equal(runStore(f.path,'valeriy').read(legacyId),null);assert.ok(runStore(f.path,'valeriy').foreignRequest(legacyId));
  for(const user_id of ['ilya','valeriy'] as const)runStore(f.path,user_id).write({user_id,request_id:randomUUID(),started_at:new Date().toISOString(),stage:'failed'});
  const backup=await backupDatabase(f.path,join(f.dir,'snapshots'));assert.equal(verifyBackup(backup).counts.profiles,2);const target=join(f.dir,'separate','movies.sqlite');restoreBackup(backup,target,{relocateFrom:realpathSync(f.path)});const db=new Database(target,{readonly:true});try{assert.deepEqual(snapshot(db),snapshot(f.db));assert.equal(runStore(target,'valeriy').list().length,1);assert.equal(runStore(target,'ilya').list().length,2);}finally{db.close();}
 }finally{f.cleanup();}
});
test('CLI requires explicit user before opening a nonexistent database',()=>{const dir=mkdtempSync(join(tmpdir(),'profile-cli-'));try{for(const script of ['taste-show','taste-status','evaluation-report','candidates-generate']){const r=spawnSync(process.execPath,['--import','tsx','scripts/'+script+'.ts'],{env:{...process.env,DATABASE_PATH:join(dir,'absent/movies.sqlite')},encoding:'utf8'});assert.equal(r.status,1);assert.match(r.stderr,/invalid_profile/);}}finally{rmSync(dir,{recursive:true,force:true});}});
