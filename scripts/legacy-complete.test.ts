import {readFileSync, readdirSync, mkdtempSync, rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {fixture,mockProvider,config} from './fixtures/recommendation-screen';
import {importFatherList} from './father-import.mjs';
import {decideIdentity,storeIdentityDecisions,applyIdentityDecisions,type IdentityCandidate} from '../src/lib/legacy-identity';
import {historicalEvidence,currentEvidence} from '../src/lib/historical-evidence';
import {generateTasteProfile,readTasteProfile} from '../src/lib/taste-profile';
import {buildTasteContext} from '../src/lib/taste-context';
import {generateRecommendationBatch,recommendationState} from '../src/lib/recommendation-service';
import {prepareTasteInputs,readCandidateHistory} from '../src/lib/candidate-context';
import {selectSeeds} from '../src/lib/candidate-selection';
import {updateLibraryRating,readLibrary,readLibraryMovie} from '../src/lib/library';
import {confirmMovieWatch} from '../src/lib/movie-watch';
import {evaluationReport} from '../src/lib/evaluation-report';
import {setWatchlist} from '../src/lib/watchlist';
import {backupDatabase,restoreBackup} from './container-db.mjs';
import Database from 'better-sqlite3';
const noBackup={backup:async()=>{}};
function document(duplicate=false){const names=['Favourite','Low','Unrated',...(duplicate?['Favourite']:[])];const sentiments=['liked','disliked','mixed',...(duplicate?['disliked']:[])];const library=names.map((title,i)=>({id:`l${i+1}`,title,year:2000,media_type:'film',watched:true,planned_to_watch:i===0||(duplicate&&i===3),watchlist:i===0||(duplicate&&i===3),sentiment:sentiments[i],personal_rating_100:null,tmdb_id:null,source_ids:[`o${i+1}`]}));const occurrences=library.map((r,i)=>({id:r.source_ids[0],library_id:r.id,raw:i===0?'👍😭':i===1?'👎':'👍👎',external_ratings:i===0?[{raw:'9.1',kind:'external',source:null}]:[],note:'Audio comment is not a movie rating'}));return Buffer.from(JSON.stringify({schema_version:2,status:'prepared_not_imported',sources:[{name:'synthetic',sha256:'a'.repeat(64)}],library,occurrences,ambiguous_identity_ids:[],stats:{unique_library_entries:library.length,source_occurrences:occurrences.length,watched:library.length,watchlist:duplicate?2:1,liked:1,disliked:duplicate?2:1,mixed:1,unknown_sentiment:0,series:0,ambiguous_identity:0}}));}
const candidate=(title='Favourite',id=101):IdentityCandidate=>({tmdb_id:id,media_type:'movie',title,original_title:title,year:2000,runtime:100,overview:'Confirmed story',genres:[{id:1,name:'Drama'}],directors:[{id:10,name:'Director'}],origin:'local',verified:true});
async function prepared(f:ReturnType<typeof fixture>,duplicate=false){const bytes=document(duplicate);const result=await importFatherList(f.db,'valeriy',bytes,{write:true,backup:async()=>{}});const records=JSON.parse(bytes.toString()).library as {id:string;title:string;year:number;media_type:'film'}[];const decisions=records.map(r=>decideIdentity(r,[candidate(r.title,r.title==='Favourite'?101:r.title==='Low'?102:103)]));storeIdentityDecisions(f.db,'valeriy','father-list-v2',result.validation.sha256,decisions);const applied=applyIdentityDecisions(f.db,'valeriy','father-list-v2');return {bytes,result,applied};}
function profileResponse(){return Response.json({status:'completed',model:'mock-model',usage:{input_tokens:40,output_tokens:30},output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({strong_preferences:[],negative_patterns:[],contrasts:[],uncertainties:[{description:'Limited historical observations.',evidence:[]}],historical_patterns:[{kind:'positive',summary:'Historical positive',explanation:'Observed liking.',uncertainty:'Cause unknown.',evidence:[{movie_id:1,kind:'historical',sentiment:'liked'}]},{kind:'negative',summary:'Historical negative',explanation:'Observed dislike.',uncertainty:'Cause unknown.',evidence:[{movie_id:2,kind:'historical',sentiment:'disliked'}]}]})}]}]});}
test('identity requires exact year/type, unique details; separates remake, TV, short and missing',()=>{const input={id:'s',title:'Favourite',year:2000,media_type:'film' as const};assert.equal(decideIdentity(input,[candidate()]).status,'confirmed');assert.equal(decideIdentity(input,[candidate(),candidate('Favourite',999)]).status,'ambiguous');assert.equal(decideIdentity(input,[{...candidate(),year:1999}]).status,'ambiguous');assert.equal(decideIdentity(input,[{...candidate(),media_type:'tv'}]).status,'ambiguous');assert.equal(decideIdentity(input,[]).status,'not_found');assert.equal(decideIdentity({...input,year:null},[candidate()]).status,'ambiguous');assert.equal(decideIdentity(input,[candidate()],false).status,'ambiguous');assert.equal(decideIdentity(input,[{...candidate(),runtime:40}]).selected?.runtime,40);});
test('catalog duplicates merge once, opposite historical marks become mixed; import is idempotent',async()=>{const f=fixture();try{const p=await prepared(f,true);assert.equal(p.applied.unique_works,3);assert.equal(readLibrary(f.db,'valeriy').total,3);assert.equal(historicalEvidence(f.db,'valeriy').find(e=>e.movie_id===1)?.sentiment,'mixed');assert.equal((await importFatherList(f.db,'valeriy',p.bytes,{write:true,backup:async()=>{throw Error('must skip')}})).written,0);assert.equal((f.db.prepare("SELECT count(*) n FROM legacy_movie_marks WHERE user_id='valeriy' AND movie_id=1").get() as {n:number}).n,2);assert.equal(evaluationReport(f.db,'valeriy').total.observed,0);}finally{f.cleanup();}});
test('historical-only profile and two-stage generation use typed current evidence; 0/clear never revive it',async()=>{const f=fixture();try{const p=await prepared(f);const ilya=f.db.prepare("SELECT profile_json FROM taste_profile WHERE user_id='ilya'").get();assert.equal(currentEvidence(f.db,'valeriy').length,3);const context=buildTasteContext(f.db,'valeriy');assert.equal(context.snapshot.length,0);assert.equal(context.historicalSnapshot.length,3);let profileCalls=0;
 await generateTasteProfile(f.db,'valeriy',{live:true,...config(),backupPath:join(f.dir,'before-profile.sqlite'),fetch:async()=>{profileCalls++;return profileResponse();}});assert.equal(profileCalls,1);assert.equal(readTasteProfile(f.db,'valeriy')?.schema_version,2);assert.equal(readTasteProfile(f.db,'valeriy')?.ratings_count,0);
 const personal=prepareTasteInputs(f.db,'valeriy');assert.equal(selectSeeds(readCandidateHistory(f.db,'valeriy'),personal.profile).length,1);const provider=mockProvider([201,202],(url,init)=>{if(url.hostname==='api.openai.com'){const body=JSON.parse(String(init?.body));if(body.text.format.name==='personal_movie_ranking')return Response.json({status:'completed',model:'mock-model',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({recommendations:[{tmdb_id:201,why_fit:'Historical liking supports this hypothesis.',possible_mismatch:'Cause of liking remains unknown.',evidence:[{movie_id:1,kind:'historical',sentiment:'liked'}]}]})}]}]});}});
 const id=randomUUID();const result=await generateRecommendationBatch('valeriy',id,{open:f.open,config,fetch:provider.fetch});assert.equal(result.status,'ok');assert.equal(JSON.parse((f.db.prepare("SELECT metadata_json FROM recommendation_evaluation WHERE user_id='valeriy'").get() as {metadata_json:string}).metadata_json).algorithm_id,'recommendme-2.0-historical-v1');assert.equal(provider.calls.filter(x=>x.startsWith('api.openai.com')).length,2);assert.equal(evaluationReport(f.db,'valeriy').total.observed,0);
 for(const value of [0,75,null]){await updateLibraryRating(f.db,'valeriy',1,value,noBackup);assert.ok(!historicalEvidence(f.db,'valeriy').some(e=>e.movie_id===1));assert.notEqual(prepareTasteInputs(f.db,'valeriy').profileRefresh.status,'current');await importFatherList(f.db,'valeriy',p.bytes,{write:true,backup:async()=>{throw Error('must skip')}});}
 assert.equal(readLibraryMovie(f.db,'valeriy',1).legacy_marks?.[0].superseded,true);assert.equal(readLibraryMovie(f.db,'valeriy',1).external_ratings?.[0].source,null);
 assert.deepEqual(f.db.prepare("SELECT profile_json FROM taste_profile WHERE user_id='ilya'").get(),ilya);assert.equal(recommendationState('valeriy',{open:f.open,config}).generation.state,'saved');
 const recommended=result.batch!.movies[0];await confirmMovieWatch(f.db,'valeriy',{movie_id:recommended.movie_id,watched:true,rating_100:0},noBackup);assert.equal(evaluationReport(f.db,'valeriy').total.mean_rating,0);assert.equal(evaluationReport(f.db,'ilya').total.observed,0);
 }finally{f.cleanup();}});
test('historical profile rejects cross-polarity counterexamples before saving, without retry',async()=>{
 const cases=[['positive',['liked','disliked']],['positive',['liked','mixed']],['negative',['disliked','liked']],['negative',['disliked','mixed']],['mixed',['liked','disliked']],['mixed',['mixed','liked']]] as const;
 for(const [kind,sentiments]of cases){
  const f=fixture();try{
   await prepared(f);const payload=await profileResponse().json();const body=JSON.parse(payload.output[0].content[0].text);
   const evidence=historicalEvidence(f.db,'valeriy');
   body.historical_patterns.push({kind,summary:'A pattern with a counterexample.',explanation:'Different source sentiments remain different.',uncertainty:'Causes are unknown.',evidence:sentiments.map(sentiment=>evidence.find(e=>e.sentiment===sentiment)!)});
   payload.output[0].content[0].text=JSON.stringify(body);
   const before=f.db.serialize();let calls=0;
   await assert.rejects(generateTasteProfile(f.db,'valeriy',{live:true,...config(),backupPath:join(f.dir,'before-profile.sqlite'),fetch:async()=>{calls++;return Response.json(payload);}}),/Historical pattern (has wrong polarity|cannot turn mixed or opposing feedback into one pole)/,kind+': '+sentiments.join('/'));
   assert.equal(calls,1);assert.equal(readTasteProfile(f.db,'valeriy'),null);assert.deepEqual(f.db.serialize(),before);
   assert.ok(!readdirSync(f.dir).some(name=>name.endsWith('.lock')));
  }finally{f.cleanup();}
 }
});
test('separate positive, negative and literal mixed historical patterns save without numeric ratings',async()=>{
 const f=fixture();try{
  await prepared(f);const payload=await profileResponse().json();const body=JSON.parse(payload.output[0].content[0].text);
  body.historical_patterns.push({kind:'mixed',summary:'An explicitly mixed source observation.',explanation:'This work was marked mixed.',uncertainty:'A mixed mark does not reveal its cause.',evidence:[historicalEvidence(f.db,'valeriy').find(e=>e.sentiment==='mixed')!]});
  payload.output[0].content[0].text=JSON.stringify(body);
  const ilya=f.db.prepare("SELECT * FROM taste_profile WHERE user_id='ilya'").all();let calls=0;
  await generateTasteProfile(f.db,'valeriy',{live:true,...config(),backupPath:join(f.dir,'before-profile.sqlite'),fetch:async()=>{calls++;return Response.json(payload);}});
  const saved=readTasteProfile(f.db,'valeriy')!;assert.equal(saved.schema_version,2);assert.equal(saved.ratings_count,0);assert.deepEqual(saved.ratings_snapshot,[]);assert.deepEqual(saved.historical_patterns,body.historical_patterns);
  assert.equal((f.db.prepare("SELECT count(*) n FROM user_movies WHERE user_id='valeriy' AND rating_100 IS NOT NULL").get() as {n:number}).n,0);
  assert.deepEqual(f.db.prepare("SELECT * FROM taste_profile WHERE user_id='ilya'").all(),ilya);assert.equal(calls,1);
 }finally{f.cleanup();}
});
test('watchlist is independent, owner-specific and survives backup/restore with source decisions',async()=>{const f=fixture();try{await prepared(f);await setWatchlist(f.db,'valeriy',3,true,async()=>{});assert.equal(readLibrary(f.db,'valeriy',new URLSearchParams('watchlist=true')).total,2);assert.equal(readLibrary(f.db,'ilya',new URLSearchParams('watchlist=true')).total,0);await setWatchlist(f.db,'valeriy',3,false,async()=>{});assert.equal(readLibraryMovie(f.db,'valeriy',3).watched,true);const backup=await backupDatabase(f.path,join(f.dir,'backups'));const target=join(f.dir,'restore','movies.sqlite');restoreBackup(backup,target,{relocateFrom:await import('node:fs').then(fs=>fs.realpathSync(f.path))});const restored=new Database(target,{readonly:true});try{for(const t of ['legacy_identity_decisions','personal_rating_history','legacy_movie_marks'])assert.deepEqual(restored.prepare('SELECT * FROM '+t+' ORDER BY 1,2').all(),f.db.prepare('SELECT * FROM '+t+' ORDER BY 1,2').all());}finally{restored.close();}}finally{f.cleanup();}});

test('manual numeric conflicts stop duplicate mapping and SQL failure rolls back all remaps',async()=>{
 const f=fixture();try{const bytes=document();const report=await importFatherList(f.db,'valeriy',bytes,{write:true,backup:async()=>{}});const inputs=JSON.parse(bytes.toString()).library as {id:string;title:string;year:number;media_type:'film'}[];storeIdentityDecisions(f.db,'valeriy','father-list-v2',report.validation.sha256,inputs.map(r=>decideIdentity(r,[candidate(r.title,r.title==='Favourite'?101:r.title==='Low'?102:103)])));
 f.db.exec("CREATE TRIGGER fail_remap BEFORE UPDATE OF movie_id ON legacy_movie_marks WHEN NEW.source_id='l2' BEGIN SELECT RAISE(ABORT,'qa rollback'); END");const before=f.db.serialize();assert.throws(()=>applyIdentityDecisions(f.db,'valeriy','father-list-v2'));assert.deepEqual(f.db.serialize(),before);f.db.exec('DROP TRIGGER fail_remap');
 f.db.exec("INSERT INTO user_movies(user_id,movie_id,watched,rating_100) VALUES('valeriy',1,1,90);UPDATE user_movies SET rating_100=0 WHERE user_id='valeriy' AND movie_id=(SELECT movie_id FROM legacy_movie_marks WHERE source_id='l1')");const done=applyIdentityDecisions(f.db,'valeriy','father-list-v2');assert.equal(done.conflicts.length,1);assert.equal(readLibraryMovie(f.db,'valeriy',1).rating_100,90);assert.deepEqual(f.db.pragma('foreign_key_check'),[]);
 }finally{f.cleanup();}
});

test('source sentiments, not emoji or external numbers, determine historical evidence',async()=>{
 const f=fixture();try{const original=JSON.parse(document().toString());original.library[1].sentiment=null;original.occurrences[1].raw='👎 only a complaint about dubbing';original.stats.disliked=0;original.stats.unknown_sentiment=1;const bytes=Buffer.from(JSON.stringify(original));const report=await importFatherList(f.db,'valeriy',bytes,{write:true,backup:async()=>{}});
 storeIdentityDecisions(f.db,'valeriy','father-list-v2',report.validation.sha256,original.library.map((r:{id:string;title:string;year:number;media_type:'film'})=>decideIdentity(r,[candidate(r.title,r.title==='Favourite'?101:r.title==='Low'?102:103)])));applyIdentityDecisions(f.db,'valeriy','father-list-v2');
 assert.equal(historicalEvidence(f.db,'valeriy').find(e=>e.movie_id===1)?.sentiment,'liked');assert.ok(!historicalEvidence(f.db,'valeriy').some(e=>e.movie_id===2));assert.equal(historicalEvidence(f.db,'valeriy').find(e=>e.movie_id===3)?.sentiment,'mixed');assert.equal(currentEvidence(f.db,'valeriy').filter(e=>!('kind' in e)).length,0);
 }finally{f.cleanup();}
});

test('evidence changed during ranking is rejected without saving or a second payment',async()=>{
 const f=fixture();try{await prepared(f);await generateTasteProfile(f.db,'valeriy',{live:true,...config(),backupPath:join(f.dir,'before-profile.sqlite'),fetch:async()=>profileResponse()});
 const provider=mockProvider([201],(url,init)=>{if(url.hostname==='api.openai.com'&&JSON.parse(String(init?.body)).text.format.name==='personal_movie_ranking'){
 f.db.exec("UPDATE user_movies SET rating_100=0 WHERE user_id='valeriy' AND movie_id=1");return Response.json({status:'completed',model:'mock-model',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({recommendations:[{tmdb_id:201,why_fit:'Historical hypothesis.',possible_mismatch:'Unknown cause.',evidence:[{movie_id:1,kind:'historical',sentiment:'liked'}]}]})}]}]});}});
 await assert.rejects(generateRecommendationBatch('valeriy',randomUUID(),{open:f.open,config,fetch:provider.fetch}),/ranking_failed/);assert.equal(provider.calls.filter(c=>c.startsWith('api.openai.com')).length,2);assert.equal(evaluationReport(f.db,'valeriy').total.recommendations,0);
 }finally{f.cleanup();}
});

test('watchlist HTTP requires owner and Origin; preserves other profiles and rejects invalid input',async()=>{
 const {watchlistHandler}=await import('../src/lib/watchlist-http');const {profileRequest}=await import('./fixtures/profile-request');
 const f=fixture();try{const handler=watchlistHandler({open:f.open,backup:async()=>{}});const context={params:Promise.resolve({id:'1'})};
 const request=(user:'ilya'|'valeriy',body:unknown,origin?:string)=>profileRequest('http://localhost/api/library/1/watchlist',{method:'PATCH',headers:{'Content-Type':'application/json',...(origin?{Origin:origin}:{})},body:JSON.stringify(body)},user);
 assert.equal((await handler(new Request('http://localhost/api/library/1/watchlist',{method:'PATCH'}),context)).status,428);
 assert.equal((await handler(request('valeriy',{watchlist:true},'https://evil.test'),context)).status,403);assert.equal((await handler(request('valeriy',{watchlist:1}),context)).status,400);
 assert.equal(readLibraryMovie(f.db,'valeriy',1).watchlist,false);assert.equal((await handler(request('valeriy',{watchlist:true}),context)).status,200);assert.equal(readLibraryMovie(f.db,'valeriy',1).watchlist,true);assert.equal(readLibraryMovie(f.db,'valeriy',1).watched,false);assert.equal(readLibraryMovie(f.db,'ilya',1).watchlist,false);assert.equal(evaluationReport(f.db,'valeriy').total.observed,0);
 }finally{f.cleanup();}
});

test('saved evidence cannot combine historical sentiment with a fabricated numeric score',async()=>{
 const {recordRecommendations}=await import('../src/lib/recommendation-memory');const {movie}=await import('./fixtures/recommendation-screen');const f=fixture();try{await prepared(f);const report={user_id:'valeriy',mode:'live',status:'ok',candidates:[movie(201)]};const result={user_id:'valeriy',mode:'live',status:'ok',result_id:randomUUID(),generated_at:new Date().toISOString(),recommendations:[{tmdb_id:201,why_fit:'Historical link.',possible_mismatch:'Uncertain.',evidence:[{movie_id:1,kind:'historical',sentiment:'liked',rating_100:80}]}]};assert.throws(()=>recordRecommendations(f.db,'valeriy',report,{result}),/evidence kind/);assert.equal(evaluationReport(f.db,'valeriy').total.recommendations,0);}finally{f.cleanup();}
});

test('confirmed TV and short works remain history but never become movie seeds',async()=>{
 const f=fixture();try{await prepared(f);f.db.exec("UPDATE movies SET runtime_minutes=40 WHERE id=1;UPDATE movies SET media_type='tv',tmdb_id=NULL WHERE id=2");assert.equal(selectSeeds(readCandidateHistory(f.db,'valeriy'),{strong_preferences:[],negative_patterns:[],contrasts:[],uncertainties:[]}).length,0);assert.equal(readLibraryMovie(f.db,'valeriy',1).watched,true);assert.equal(historicalEvidence(f.db,'valeriy').find(e=>e.movie_id===1)?.sentiment,'liked');}finally{f.cleanup();}
});


test('unverified aliases cannot prove identity, independent of candidate order',()=>{
 const input={id:'x',title:'Source Name',year:2000,media_type:'film' as const};
 const search={...candidate('Source Name'),verified:false};const details=candidate('Different Work');
 for(const list of [[search,details],[details,search],[{...details,aliases:['Source Name']}]] ) assert.equal(decideIdentity(input,list).status,'ambiguous');
 assert.equal(decideIdentity(input,[candidate('Source Name')]).status,'confirmed');
 assert.equal(decideIdentity(input,[candidate('Source Name'),details]).status,'ambiguous');
});

for(const direction of ['target','source'] as const) for(const score of [0,50]) test(`cleared ${direction} rating conflicts with duplicate ${score}`,async()=>{
 const f=fixture();try{
 const bytes=document();const imported=await importFatherList(f.db,'valeriy',bytes,{write:true,backup:async()=>{}});
 const old=(f.db.prepare("SELECT movie_id FROM legacy_movie_marks WHERE source_id='l1'").get() as {movie_id:number}).movie_id;
 f.db.exec("INSERT INTO user_movies(user_id,movie_id,watched,watchlist) VALUES('valeriy',1,1,1)");
 const cleared=direction==='target'?1:old,other=direction==='target'?old:1;
 await updateLibraryRating(f.db,'valeriy',cleared,85,noBackup);await updateLibraryRating(f.db,'valeriy',cleared,null,noBackup);await updateLibraryRating(f.db,'valeriy',other,score,noBackup);
 storeIdentityDecisions(f.db,'valeriy','father-list-v2',imported.validation.sha256,[decideIdentity({id:'l1',title:'Favourite',year:2000,media_type:'film'},[candidate()])]);
 const before=f.db.serialize();const applied=applyIdentityDecisions(f.db,'valeriy','father-list-v2');assert.equal(applied.applied,0);assert.equal(applied.conflicts.length,1);assert.deepEqual(f.db.serialize(),before);
 assert.equal(applyIdentityDecisions(f.db,'valeriy','father-list-v2').applied,0);assert.equal((await importFatherList(f.db,'valeriy',bytes)).written,0);
 }finally{f.cleanup();}
});
for(const flag of [0,1]) test(`different watchlist flags conflict, destination ${flag}`,async()=>{
 const f=fixture();try{const data=JSON.parse(document().toString());data.library[0].watchlist=!flag;data.library[0].planned_to_watch=!flag;data.stats.watchlist=flag?0:1;const bytes=Buffer.from(JSON.stringify(data));
 const imported=await importFatherList(f.db,'valeriy',bytes,{write:true,backup:async()=>{}});
 f.db.prepare("INSERT INTO user_movies(user_id,movie_id,watched,watchlist) VALUES('valeriy',1,1,?)").run(flag);
 storeIdentityDecisions(f.db,'valeriy','father-list-v2',imported.validation.sha256,[decideIdentity({id:'l1',title:'Favourite',year:2000,media_type:'film'},[candidate()])]);const before=f.db.serialize();
 const result=applyIdentityDecisions(f.db,'valeriy','father-list-v2');assert.equal(result.applied,0);assert.equal(result.conflicts.length,1);assert.deepEqual(f.db.serialize(),before);
 }finally{f.cleanup();}
});
test('reject CLI preserves supported schemas and refuses incompatible schemas before backup',()=>{
 for(const version of [7,8,9,10])for(const user of ['ilya','valeriy']){
 const dir=mkdtempSync(join(tmpdir(),'reject-schema-'));const path=join(dir,'movies.sqlite');const db=new Database(path);
 try{for(const file of readdirSync('migrations').filter(x=>x.endsWith('.sql')).sort().slice(0,version))db.exec(readFileSync(join('migrations',file),'utf8'));db.pragma(`user_version=${version}`);db.exec("INSERT INTO movies(id,title,tmdb_id) VALUES(1,'Synthetic',101)");
 const before=db.serialize();for(const undo of [false,true]){const result=spawnSync(process.execPath,['--import','tsx','scripts/recommendations-reject.ts','--user',user,'--tmdb-id','101',...(undo?['--undo']:[])],{env:{...process.env,DATABASE_PATH:path,OPENAI_API_KEY:'',TMDB_API_KEY:''},encoding:'utf8'});
 assert.equal(result.status,version===7?1:0,result.stderr);assert.equal(db.pragma('user_version',{simple:true}),version);
 if(version===7){assert.deepEqual(db.serialize(),before);assert.ok(!readdirSync(dir).includes('backups'));}}
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
 }
});
