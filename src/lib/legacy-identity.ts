import type Database from 'better-sqlite3';
import { normalizeTitle } from './tmdb';
import { personalScope, type UserId } from './profiles';
export type IdentityInput={id:string;title:string;year:number|null;media_type:'film'|'series'};
export type IdentityCandidate={tmdb_id:number;media_type:'movie'|'tv';title:string;original_title:string|null;year:number|null;runtime:number|null;
 overview:string|null;genres:{id:number;name:string}[]|null;directors:{id:number;name:string}[]|null;poster_path?:string|null;backdrop_path?:string|null;origin:'local'|'tmdb';verified:boolean;aliases?:string[]};
export type IdentityDecision={source_id:string;status:'confirmed'|'ambiguous'|'not_found';reason:string;candidates:IdentityCandidate[];selected:IdentityCandidate|null};
export function decideIdentity(input:IdentityInput,candidates:IdentityCandidate[],complete=true):IdentityDecision{
 const type=input.media_type==='series'?'tv':'movie';
 const byIdentity=new Map<string,IdentityCandidate>();
 const contradictory=new Set<string>();
 for(const c of candidates){
  const key=`${c.media_type}:${c.tmdb_id}`,prior=byIdentity.get(key);
  if(prior?.verified&&c.verified&&(prior.year!==c.year||normalizeTitle(prior.title)!==normalizeTitle(c.title)||normalizeTitle(prior.original_title??'')!==normalizeTitle(c.original_title??'')))contradictory.add(key);
  if(!prior||(!prior.verified&&c.verified))byIdentity.set(key,c);
 }
 const unique=[...byIdentity.values()];
 const exact=unique.filter(c=>!contradictory.has(`${c.media_type}:${c.tmdb_id}`)&&c.verified&&c.media_type===type&&input.year!==null&&c.year===input.year&&[c.title,c.original_title].some(t=>t!==null&&normalizeTitle(t)===normalizeTitle(input.title)));
 const status=complete&&exact.length===1?'confirmed':unique.length?'ambiguous':'not_found';
 return {source_id:input.id,status,reason:status==='confirmed'?'unique_exact_title_year_type_details':!complete?'incomplete_search':input.year===null?'source_year_unknown':exact.length>1?'multiple_verified_matches':'no_unique_verified_match',candidates:unique,selected:status==='confirmed'?exact[0]:null};
}
function schema(db:Database.Database,user:UserId){personalScope(db,user);if((db.pragma('user_version',{simple:true}) as number)<10)throw Error('Explicit schema 10 migration required');}
export function storeIdentityDecisions(db:Database.Database,user:UserId,sourceKey:string,sha:string,decisions:IdentityDecision[]){
 schema(db,user);return db.transaction(()=>{const source=db.prepare('SELECT sha256,document_json FROM legacy_import_sources WHERE user_id=? AND source_key=?').get(user,sourceKey) as {sha256:string;document_json:string}|undefined;if(source?.sha256!==sha)throw Error('Source checksum mismatch');
 const insert=db.prepare(`INSERT INTO legacy_identity_decisions(user_id,source_key,source_id,source_sha256,status,candidates_json,decision_json) VALUES(?,?,?,?,?,?,?) ON CONFLICT(user_id,source_key,source_id) DO UPDATE SET status=excluded.status,candidates_json=excluded.candidates_json,decision_json=excluded.decision_json WHERE legacy_identity_decisions.applied_movie_id IS NULL`);
 const originals=JSON.parse(source!.document_json).library as IdentityInput[];
 for(const d of decisions){const input=originals.find(r=>r.id===d.source_id);if(!input)throw Error('Unknown source identity');if(d.status==='confirmed'){const checked=decideIdentity(input,d.candidates);if(checked.status!=='confirmed'||checked.selected?.tmdb_id!==d.selected?.tmdb_id||checked.selected?.media_type!==d.selected?.media_type)throw Error('Identity decision contradicts source');}
 if(d.status==='confirmed'&&(!d.selected||!d.selected.verified))throw Error('Unverified identity');insert.run(user,sourceKey,d.source_id,sha,d.status,JSON.stringify(d.candidates),JSON.stringify(d));}
 }).immediate();
}
/** Caller supplies a verified backup before this offline operation. Never records watches/outcomes. */
export function applyIdentityDecisions(db:Database.Database,user:UserId,sourceKey:string){
 schema(db,user);const applied:number[]=[];const conflicts:{source_id:string;reason:string}[]=[];
 const decisions=db.prepare("SELECT source_id,decision_json FROM legacy_identity_decisions WHERE user_id=? AND source_key=? AND status='confirmed' AND applied_movie_id IS NULL ORDER BY source_id").all(user,sourceKey) as {source_id:string;decision_json:string}[];
 // One transaction per decision so genuine conflicts can remain unresolved; unexpected SQL errors abort the entire batch.
 return db.transaction(()=>{
 for(const item of decisions){const decision=JSON.parse(item.decision_json) as IdentityDecision;const c=decision.selected!;
  const old=db.prepare('SELECT m.*,u.* FROM legacy_movie_marks l JOIN user_movies u ON u.user_id=l.user_id AND u.movie_id=l.movie_id JOIN movies m ON m.id=l.movie_id WHERE l.user_id=? AND l.source_key=? AND l.source_id=?').get(user,sourceKey,item.source_id) as Record<string,unknown>|undefined;
  if(!old||!c?.verified)throw Error('Invalid prepared identity');
  const oldId=Number(old.movie_id);
  const known=c.media_type==='movie'?db.prepare('SELECT id FROM movies WHERE tmdb_id=?').get(c.tmdb_id) as {id:number}|undefined:db.prepare(`SELECT d.applied_movie_id id FROM legacy_identity_decisions d WHERE d.applied_movie_id IS NOT NULL AND json_extract(d.decision_json,'$.selected.media_type')='tv' AND json_extract(d.decision_json,'$.selected.tmdb_id')=? LIMIT 1`).get(c.tmdb_id) as {id:number}|undefined;
  const targetId=known?.id??oldId;
  const target=db.prepare('SELECT * FROM user_movies WHERE user_id=? AND movie_id=?').get(user,targetId) as Record<string,unknown>|undefined;
  if(targetId!==oldId&&target){
   const assigned=(id:number)=>Boolean(db.prepare('SELECT 1 FROM personal_rating_history WHERE user_id=? AND movie_id=? UNION SELECT 1 FROM legacy_movie_marks WHERE user_id=? AND movie_id=? AND numeric_override=1 LIMIT 1').get(user,id,user,id));
   if((target.rating_100===null&&old.rating_100!==null&&assigned(targetId))||(old.rating_100===null&&target.rating_100!==null&&assigned(oldId))){conflicts.push({source_id:item.source_id,reason:'cleared_personal_rating'});continue;}
   if(Number(target.watchlist)!==Number(old.watchlist)){conflicts.push({source_id:item.source_id,reason:'conflicting_watchlist'});continue;}
   const fields=['rating_100','review_text','watched_at','original_rating_stars','letterboxd_date','letterboxd_rating_date'];
   if(fields.some(k=>old[k]!==null&&target[k]!==null&&old[k]!==target[k])){conflicts.push({source_id:item.source_id,reason:'conflicting_personal_values'});continue;}
   // A manual watchlist edit cannot be reconstructed as a preference of another duplicate.
   const source=db.prepare('SELECT document_json FROM legacy_import_sources WHERE user_id=? AND source_key=?').get(user,sourceKey) as {document_json:string};
   const original=(JSON.parse(source.document_json).library as {id:string;planned_to_watch:boolean;watchlist:boolean}[]).find(r=>r.id===item.source_id)!;
   if(Number(old.watchlist)!==Number(original.planned_to_watch||original.watchlist)){conflicts.push({source_id:item.source_id,reason:'manual_watchlist_edit'});continue;}
  }
  if(!known){db.prepare(`UPDATE movies SET tmdb_id=?,media_type=?,tmdb_title=?,original_title=?,tmdb_release_year=?,runtime_minutes=?,overview=?,genres_json=?,directors_json=?,poster_path=?,backdrop_path=?,metadata_updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),tmdb_enrichment_status='matched' WHERE id=?`).run(c.media_type==='movie'?c.tmdb_id:null,c.media_type,c.title,c.original_title,c.year,c.runtime,c.overview,c.genres===null?null:JSON.stringify(c.genres),c.directors===null?null:JSON.stringify(c.directors),c.poster_path??null,c.backdrop_path??null,oldId);}
  if(targetId!==oldId){
   if(!target){const columns=['user_id','movie_id','watched','rating_100','original_rating_stars','rating_source','not_interested','watched_at','letterboxd_date','created_at','updated_at','letterboxd_rating_date','review_text','watchlist'];db.prepare(`INSERT INTO user_movies(${columns.join(',')}) SELECT user_id,?,${columns.slice(2).join(',')} FROM user_movies WHERE user_id=? AND movie_id=?`).run(targetId,user,oldId);}
   else {const rating=target.rating_100??old.rating_100;db.prepare(`UPDATE user_movies SET watched=?,watchlist=?,not_interested=?,rating_100=?,rating_source=?,review_text=?,watched_at=?,original_rating_stars=?,letterboxd_date=?,letterboxd_rating_date=? WHERE user_id=? AND movie_id=?`).run(Number(Boolean(target.watched||old.watched)),Number(target.watchlist),Number(Boolean(target.not_interested||old.not_interested)),rating,rating!==null?(target.rating_100!==null?target.rating_source:old.rating_source):target.rating_source,target.review_text??old.review_text,target.watched_at??old.watched_at,target.original_rating_stars??old.original_rating_stars,target.letterboxd_date??old.letterboxd_date,target.letterboxd_rating_date??old.letterboxd_rating_date,user,targetId);}
   const overridden=db.prepare('SELECT 1 FROM personal_rating_history WHERE user_id=? AND movie_id IN (?,?) UNION SELECT 1 FROM legacy_movie_marks WHERE user_id=? AND movie_id IN (?,?) AND numeric_override=1 LIMIT 1').get(user,oldId,targetId,user,oldId,targetId);
   if(overridden)db.prepare('INSERT OR IGNORE INTO personal_rating_history VALUES(?,?)').run(user,targetId);
   db.prepare('UPDATE legacy_movie_marks SET movie_id=? WHERE user_id=? AND movie_id=?').run(targetId,user,oldId);
   if(overridden)db.prepare('UPDATE legacy_movie_marks SET numeric_override=1 WHERE user_id=? AND movie_id=?').run(user,targetId);
   // Retain obsolete local history rows if recommendation/outcome records still reference them.
   const referenced=db.prepare('SELECT 1 FROM recommendations WHERE user_id=? AND movie_id=? UNION SELECT 1 FROM recommendation_outcomes WHERE user_id=? AND movie_id=? LIMIT 1').get(user,oldId,user,oldId);
   if(!referenced){db.prepare('DELETE FROM personal_rating_history WHERE user_id=? AND movie_id=?').run(user,oldId);db.prepare('DELETE FROM user_movies WHERE user_id=? AND movie_id=?').run(user,oldId);}
  }
  db.prepare('UPDATE legacy_movie_marks SET identity_confirmed=1 WHERE user_id=? AND source_key=? AND source_id=?').run(user,sourceKey,item.source_id);
  db.prepare('UPDATE legacy_identity_decisions SET applied_movie_id=? WHERE user_id=? AND source_key=? AND source_id=?').run(targetId,user,sourceKey,item.source_id);applied.push(targetId);
 }
 if((db.pragma('foreign_key_check') as unknown[]).length)throw Error('Foreign key violation');return {applied:applied.length,unique_works:new Set(applied).size,conflicts};
 }).immediate();
}
