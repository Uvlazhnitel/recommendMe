import {createHash} from 'node:crypto';
import type Database from 'better-sqlite3';
import {requireProfileSchema,type UserId} from './profiles';
import {normalizeTitle,TmdbError,type RepairWork,type RepairHit,type TmdbClient} from './tmdb';
import {extractLetterboxdEvidence,LetterboxdError,type LetterboxdEvidence} from './letterboxd-identity';
import {validateRepairDetails} from './tmdb-repair';
import {saveRussianMovie} from './russian-presentation';

type RecordRow={id:number;title:string;release_year:number|null;tmdb_id:number|null;media_type:string;letterboxd_uri:string|null;[key:string]:unknown};
type Personal={user_id:UserId;movie_id:number;watched:number;rating_100:number|null;review_text:string|null;rating_source:string;watchlist:number;not_interested:number;[key:string]:unknown};
export type RepairReview={movieId:number;fingerprint:string;sourceTitle:string;urls:string[];facts:string;query?:string;aliases?:string[];imdb?:string;year?:number;hit?:RepairHit;ownerConfirmed?:boolean};
export type SourceEvidence={review?:RepairReview;letterboxd?:LetterboxdEvidence;uri?:string;raw:string[];names:string[];year:number|null;type:'movie'|'tv';runtime:number[];approximateRuntime?:number[];sourceChecksums:Record<string,string>;findHits:RepairHit[]};
export type AllRepairItem={movieId:number;title:string;users:UserId[];fingerprint:string;targetId:number;targetFingerprint:string;status:'ready'|'unresolved'|'error';reason:string;source:SourceEvidence;work?:RepairWork;candidates?:RepairWork[];merge?:MergeAction[];review?:RepairReview};
export type AllRepairReport={version:2;schema:number;stopped:boolean;items:AllRepairItem[]};
export type AllRepairApi=Pick<TmdbClient,'repairFind'|'repairSearch'|'repairWork'>;
export type MergeAction={user:UserId;action:'move'|'combine'|'conflict';reason?:string};
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const normalized=(value:string)=>normalizeTitle(value.replace(/№\s*/g,' номер ')).replace(/ё/g,'е').replace(/(^| )икс(?= |$)/g,'$1x').replace(/(^| )к(?= ?\d)/g,'$1k').replace(/(^| )восемь(?= |$)/g,(_,space:string)=>space+'8').replace(/(^| )тринадцать(?= |$)/g,(_,space:string)=>space+'13').replace(/^007 /,'');
const row=(db:Database.Database,id:number)=>db.prepare('SELECT * FROM movies WHERE id=?').get(id) as RecordRow|undefined;
const personals=(db:Database.Database,id:number)=>db.prepare('SELECT * FROM user_movies WHERE movie_id=? ORDER BY user_id').all(id) as Personal[];
export function repairFingerprint(db:Database.Database,id:number){return digest({movie:row(db,id),users:personals(db,id),marks:db.prepare('SELECT * FROM legacy_movie_marks WHERE movie_id=? ORDER BY user_id,source_key,source_id').all(id),history:db.prepare('SELECT * FROM personal_rating_history WHERE movie_id=? ORDER BY user_id').all(id)});}
export function repairSource(db:Database.Database,movie:RecordRow):SourceEvidence {
 const source:SourceEvidence={raw:[],names:[movie.title],year:movie.release_year,type:movie.media_type==='tv'?'tv':'movie',runtime:[],approximateRuntime:[],sourceChecksums:{},findHits:[]};
 const records=db.prepare(`SELECT l.source_id,s.user_id,s.source_key,s.sha256,s.document_json FROM legacy_movie_marks l JOIN legacy_import_sources s ON s.user_id=l.user_id AND s.source_key=l.source_key WHERE l.movie_id=? ORDER BY l.user_id,l.source_id`).all(movie.id) as {source_id:string;user_id:string;source_key:string;sha256:string;document_json:string}[];
 for(const record of records){
  if(createHash('sha256').update(record.document_json).digest('hex')!==record.sha256)throw Error('Неверная контрольная сумма исходного импорта.');
  source.sourceChecksums[record.user_id+':'+record.source_key]=record.sha256;
  const document=JSON.parse(record.document_json),entry=document.library.find((x:{id:string})=>x.id===record.source_id);
  if(!entry)throw Error('Исходная запись импорта отсутствует.');
  if(entry.media_type==='series')source.type='tv';
  for(const occurrence of document.occurrences.filter((x:{id:string})=>entry.source_ids.includes(x.id))){
   if(typeof occurrence.raw==='string'){
    source.raw.push(occurrence.raw);
    for(const match of occurrence.raw.matchAll(/(\d+)\s*ч(?:ас(?:а|ов)?)?\s*(\d(?:[ \t]*\d)?)\s*мин/g))source.runtime.push(Number(match[1])*60+Number(match[2].replace(/\s/g,'')));
    for(const match of occurrence.raw.matchAll(/(\d+)\s*час(?:а|ов)?(?![а-я])/g))source.approximateRuntime!.push(Number(match[1])*60);
    for(const match of occurrence.raw.matchAll(/(\d+)[ \t]*ч[ \t]*(\d{1,2})(?=[ \t]*(?:\n|$))/g))source.runtime.push(Number(match[1])*60+Number(match[2]));
    const shorthand=/(?:^|\n)([1-4])\.([0-5]\d)(?:\n|$)/.exec(occurrence.raw);if(shorthand)source.runtime.push(Number(shorthand[1])*60+Number(shorthand[2]));
    const english=/^([A-Z][A-Za-z0-9 .:'&-]{3,70})/.exec(occurrence.raw);if(english)source.names.push(english[1].trim());
   }
  }
 }
 return source;
}
export function workProof(source:SourceEvidence,work:RepairWork):string|null {
 const same=(a:RepairHit)=>a.type===work.type&&a.id===work.id&&(!['episode','season'].includes(a.type)||(a.showId===work.showId&&a.season===work.season&&(a.type!=='episode'||a.episode===work.episode)));
 const review=source.review;
 if(review&&review.sourceTitle===source.names[0]&&review.imdb&&work.imdb===review.imdb&&(review.hit===undefined||same(review.hit))&&(source.year===null?(review.year!==undefined&&work.years.includes(review.year)):work.years.includes(source.year)))return 'reviewed_primary_evidence';
 if(source.letterboxd?.imdb.length===1&&(work.imdb===source.letterboxd.imdb[0]||source.findHits.some(same)))return 'external_imdb';
 const titleMatch=source.names.some(name=>work.titles.some(title=>normalized(title)===normalized(name)));
 const directors=work.details.directors??[];
 const directorMatch=source.letterboxd?.directors.some(name=>directors.some(person=>normalized(person.name)===normalized(name)))??false;
 const runtimeMatch=work.details.runtime!==null&&[...source.runtime,...(source.letterboxd?.runtime?[source.letterboxd.runtime]:[])].some(n=>Math.abs(n-work.details.runtime!)<=5)||work.details.runtime!==null&&(source.approximateRuntime??[]).some(n=>Math.abs(n-work.details.runtime!)<=15);
 const direct=source.letterboxd?.tmdb.some(same)??false;
 if(direct&&titleMatch&&directorMatch)return 'direct_title_director';
 if(titleMatch&&((source.runtime.length===0&&!source.approximateRuntime?.length)||runtimeMatch)&&source.year!==null&&work.years.includes(source.year)&&((source.type==='tv')===(work.type!=='movie')))return 'official_title_release_year';
 if(titleMatch&&source.year===null&&runtimeMatch)return 'official_title_source_runtime';
 return null;
}
export function mergeActions(db:Database.Database,oldId:number,targetId:number):MergeAction[]{
 if(oldId===targetId)return [];
 const target=personals(db,targetId);
 return personals(db,oldId).map(old=>{
  const conflict=(reason:string):MergeAction=>({user:old.user_id,action:'conflict',reason});
  if(db.prepare('SELECT 1 FROM recommendations WHERE user_id=? AND movie_id=? UNION SELECT 1 FROM recommendation_outcomes WHERE user_id=? AND movie_id=? LIMIT 1').get(old.user_id,oldId,old.user_id,oldId))return conflict('historical_recommendation_or_outcome');
  const other=target.find(x=>x.user_id===old.user_id);if(!other)return {user:old.user_id,action:'move'};
  const assigned=(id:number)=>!!db.prepare('SELECT 1 FROM personal_rating_history WHERE user_id=? AND movie_id=? UNION SELECT 1 FROM legacy_movie_marks WHERE user_id=? AND movie_id=? AND numeric_override=1 LIMIT 1').get(old.user_id,id,old.user_id,id);
  if((old.rating_100===null&&other.rating_100!==null&&assigned(oldId))||(other.rating_100===null&&old.rating_100!==null&&assigned(targetId)))return conflict('cleared_rating');
  for(const field of ['watchlist','not_interested'])if(old[field]!==other[field])return conflict('conflicting_'+field);
  for(const field of ['rating_100','review_text','watched_at','original_rating_stars','letterboxd_date','letterboxd_rating_date'])if(old[field]!==null&&other[field]!==null&&old[field]!==other[field])return conflict('conflicting_'+field);
  if(old.rating_100!==null&&other.rating_100!==null&&old.rating_source!==other.rating_source)return conflict('conflicting_rating_source');
  return {user:old.user_id,action:'combine'};
 });
}
export async function previewAllRepair(db:Database.Database,api:AllRepairApi,readPage:(url:string)=>Promise<string>,onProgress?:(report:AllRepairReport)=>void,reviews:RepairReview[]=[]){
 requireProfileSchema(db);if(db.pragma('user_version',{simple:true})!==11)throw Error('Нужна существующая схема11; миграция автоматически не выполняется.');
 const movies=db.prepare(`SELECT DISTINCT m.* FROM movies m JOIN user_movies u ON u.movie_id=m.id WHERE m.tmdb_id IS NULL AND NOT(m.media_type='tv' AND m.tmdb_enrichment_status='matched' AND m.metadata_updated_at IS NOT NULL) ORDER BY m.id`).all() as RecordRow[];
 const report:AllRepairReport={version:2,schema:11,stopped:false,items:[]};
 const owners=new Map((db.prepare('SELECT id,tmdb_id FROM movies WHERE tmdb_id IS NOT NULL').all() as {id:number;tmdb_id:number}[]).map(x=>[x.tmdb_id,x.id]));
 for(const movie of movies){
  const source=repairSource(db,movie);
  const item:AllRepairItem={movieId:movie.id,title:movie.title,users:personals(db,movie.id).map(p=>p.user_id),fingerprint:repairFingerprint(db,movie.id),targetId:movie.id,targetFingerprint:repairFingerprint(db,movie.id),status:'unresolved',reason:'Недостаточно проверенных сведений.',source};
  const observed=new Map<string,RepairWork>();
  try {
   const candidates=new Map<string,RepairWork>();
   const add=async(hit:RepairHit)=>{const key=hit.type+':'+hit.id;if(candidates.has(key))return;try{const work=await api.repairWork(hit);if(work.id!==hit.id||work.type!==hit.type)throw Error('Кеш или TMDB вернул другую идентичность.');observed.set(key,work);if(workProof(source,work))candidates.set(key,work);}catch(error){if(!(error instanceof TmdbError&&error.status===404))throw error;}};
   if(movie.letterboxd_uri){
    source.uri=movie.letterboxd_uri;source.letterboxd=extractLetterboxdEvidence(await readPage(movie.letterboxd_uri));
    source.names.push(...source.letterboxd.names);
    if(source.letterboxd.tmdb.length===1&&source.letterboxd.tmdb[0].type==='tv')source.type='tv';
    if(source.letterboxd.imdb.length===1){source.findHits=await api.repairFind(source.letterboxd.imdb[0]);for(const hit of source.findHits)await add(hit);}
    if(!candidates.size)for(const hit of source.letterboxd.tmdb)await add(hit);
   }
   const review=reviews.find(r=>r.movieId===movie.id);
   if(review){
    if(review.fingerprint!==item.fingerprint||review.sourceTitle!==movie.title||!review.facts?.trim()||!Array.isArray(review.urls)||!review.urls.length||review.urls.some(value=>{try{const u=new URL(value);return u.protocol!=='https:'||!!u.username||!!u.password;}catch{return true;}}))throw Error('Некорректные проверенные уточнения.');
    item.review=review;source.review=review;source.names.push(...(review.aliases??[]));
    if(review.imdb){source.findHits=await api.repairFind(review.imdb);for(const hit of source.findHits)await add(hit);}
    if(review.hit){if(review.hit.type!=='movie')source.type='tv';await add(review.hit);}
   }
   if(!candidates.size){
    let complete=true;
    for(const year of source.year===null?[null]:[source.year,null]){
     const query=source.review?.query??source.names.find(name=>/^[A-Za-z]/.test(name)&&!movie.letterboxd_uri)??movie.title;
     const found=await api.repairSearch(query,year,source.type);complete=complete&&found.complete;
     const hits=found.candidates.filter(hit=>source.year===null||year===null||hit.year===source.year);
     if(hits.length>40){complete=false;break;}
     for(const hit of hits)await add({id:hit.id,type:source.type});
     if(candidates.size||source.year===null)break;
    }
    if(!complete)throw Error('Поиск неполный; нужна адресная проверка.');
   }
   if(candidates.size!==1){item.reason=candidates.size?'Несколько подтверждённых кандидатов; нужны дополнительные сведения.':'Нет единственного кандидата с подтверждёнными исходными сведениями.';}
   else {
    const work=[...candidates.values()][0];if(work.type==='season')work.presentation={...work.presentation,title:movie.title};item.work=work;item.status='ready';item.reason=workProof(source,work)!;
    if(work.type==='movie'){
     item.targetId=owners.get(work.id)??movie.id;owners.set(work.id,item.targetId);
     item.targetFingerprint=repairFingerprint(db,item.targetId);item.merge=mergeActions(db,movie.id,item.targetId);
    }
   }
  }catch(error){item.status=error instanceof TmdbError||error instanceof LetterboxdError?'error':'unresolved';item.reason=error instanceof Error?error.message:'Ошибка проверки.';if((error instanceof TmdbError||error instanceof LetterboxdError)&&error.stop)report.stopped=true;}
  if(item.status!=='ready')item.candidates=[...observed.values()];
  report.items.push(item);onProgress?.(report);if(report.stopped)break;
 }
 return report;
}

export function validateRepairWork(work:RepairWork){
 if(!work||!['movie','tv','episode','season'].includes(work.type)||!Number.isSafeInteger(work.id)||work.id<1)throw Error('Некорректная идентичность отчёта.');
 const details=validateRepairDetails(work.details);
 if(details.id!==work.id||!Array.isArray(work.titles)||work.titles.length>1000||work.titles.some(s=>typeof s!=='string'||s.length>2000)||!Array.isArray(work.years)||work.years.some(y=>!Number.isInteger(y)||y<0||y>9999))throw Error('Некорректные подтверждающие метаданные.');
 if(work.imdb!==null&&!/^tt\d+$/.test(work.imdb))throw Error('Некорректный IMDb ID.');
 if(work.type==='season'&&(!Number.isSafeInteger(work.showId)||work.showId!<1||!Number.isSafeInteger(work.season)||work.season!<0))throw Error('Некорректный адрес сезона.');
 if(work.type==='episode'&&(!Number.isSafeInteger(work.showId)||work.showId!<1||!Number.isSafeInteger(work.season)||work.season!<0||!Number.isSafeInteger(work.episode)||work.episode!<1))throw Error('Некорректный адрес эпизода.');
 const p=work.presentation;if(!p||typeof p.title!=='string'||!p.title.trim()||p.title.length>1000||(p.overview!==null&&(typeof p.overview!=='string'||p.overview.length>20000)))throw Error('Некорректное русское представление.');
 return {...work,details};
}
function alreadyApplied(movie:RecordRow,work:RepairWork,targetId:number){
 return movie.tmdb_enrichment_status==='matched'&&movie.original_title===work.details.original_title&&movie.poster_path===work.details.poster_path&&movie.runtime_minutes===work.details.runtime&&
  (work.type==='movie'?movie.media_type==='movie'&&(movie.tmdb_id===work.id||(movie.id!==targetId&&movie.tmdb_id===null)):movie.media_type==='tv'&&movie.tmdb_id===null);
}
function movePersonal(db:Database.Database,oldId:number,targetId:number,action:MergeAction){
 const old=personals(db,oldId).find(p=>p.user_id===action.user)!;const target=personals(db,targetId).find(p=>p.user_id===action.user);
 const overridden=!!db.prepare('SELECT 1 FROM personal_rating_history WHERE user_id=? AND movie_id IN (?,?) UNION SELECT 1 FROM legacy_movie_marks WHERE user_id=? AND movie_id IN (?,?) AND numeric_override=1 LIMIT 1').get(action.user,oldId,targetId,action.user,oldId,targetId);
 if(!target){
  const columns=Object.keys(old);db.prepare(`INSERT INTO user_movies(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`).run(...columns.map(key=>key==='movie_id'?targetId:old[key]));
 }else{
  const values:Personal={...target,watched:Number(!!(old.watched||target.watched))};
  for(const field of ['rating_100','review_text','watched_at','original_rating_stars','letterboxd_date','letterboxd_rating_date'])if(values[field]===null)values[field]=old[field];
  if(target.rating_100===null&&old.rating_100!==null)values.rating_source=old.rating_source;
  const fields=['watched','rating_100','rating_source','review_text','watched_at','original_rating_stars','letterboxd_date','letterboxd_rating_date'];
  db.prepare(`UPDATE user_movies SET ${fields.map(k=>k+'=?').join(',')},updated_at=? WHERE user_id=? AND movie_id=?`).run(...fields.map(k=>values[k]),target.updated_at,action.user,targetId);
  // The existing update trigger may touch updated_at; preserve its original value.
  db.prepare('UPDATE user_movies SET updated_at=? WHERE user_id=? AND movie_id=?').run(target.updated_at,action.user,targetId);
 }
 db.prepare('UPDATE legacy_movie_marks SET movie_id=? WHERE user_id=? AND movie_id=?').run(targetId,action.user,oldId);
 db.prepare('UPDATE legacy_identity_decisions SET applied_movie_id=? WHERE user_id=? AND applied_movie_id=?').run(targetId,action.user,oldId);
 if(overridden){db.prepare('INSERT OR IGNORE INTO personal_rating_history(user_id,movie_id) VALUES(?,?)').run(action.user,targetId);db.prepare('UPDATE legacy_movie_marks SET numeric_override=1 WHERE user_id=? AND movie_id=?').run(action.user,targetId);}
 db.prepare('DELETE FROM user_movies WHERE user_id=? AND movie_id=?').run(action.user,oldId);
}
export async function applyAllRepair(db:Database.Database,report:AllRepairReport,backup:()=>Promise<unknown>){
 requireProfileSchema(db);if(report.version!==2||report.schema!==11||db.pragma('user_version',{simple:true})!==11||!Array.isArray(report.items))throw Error('Неподдерживаемый отчёт.');
 const ready=report.items.filter(i=>i.status==='ready');
 const validate=()=>{
  const seen=new Set<number>();
  return ready.flatMap(item=>{
   if(seen.has(item.movieId)||!Number.isSafeInteger(item.movieId)||!Number.isSafeInteger(item.targetId)||!item.work)throw Error('Повторная или некорректная запись отчёта.');seen.add(item.movieId);
   const work=validateRepairWork(item.work),movie=row(db,item.movieId);if(!movie)throw Error('Исходная запись удалена.');
   if(item.review&&(item.review.fingerprint!==item.fingerprint||item.review.sourceTitle!==movie.title||digest(item.review)!==digest(item.source.review)||!item.review.urls?.length||!item.review.facts?.trim()))throw Error('Некорректное проверенное уточнение.');
   if(item.source.uri&&item.source.uri!==movie.letterboxd_uri)throw Error('Изменилась исходная ссылка.');
   if(!workProof(item.source,work))throw Error('Идентичность не подтверждена.');
   if(alreadyApplied(movie,work,item.targetId))return [];
   const actualSource=repairSource(db,movie);
   if(digest(actualSource.sourceChecksums)!==digest(item.source.sourceChecksums)||actualSource.year!==item.source.year||actualSource.names[0]!==item.source.names[0])throw Error('Исходный документ изменился.');
   if(repairFingerprint(db,item.movieId)!==item.fingerprint||repairFingerprint(db,item.targetId)!==item.targetFingerprint)throw Error('Данные фильма или профиля изменились после предпросмотра.');
   if(work.type==='movie'){
    const owner=db.prepare('SELECT id FROM movies WHERE tmdb_id=?').get(work.id) as {id:number}|undefined;
    if(owner&&owner.id!==item.targetId)throw Error('Изменился владелец TMDB ID.');
    if(!owner&&item.targetId!==item.movieId&&!ready.some(other=>other.movieId===item.targetId&&other.targetId===item.targetId&&other.work?.type==='movie'&&other.work.id===work.id))throw Error('Неподтверждённая целевая запись объединения.');
    if(!row(db,item.targetId))throw Error('Целевая запись отсутствует.');
    if(digest(mergeActions(db,item.movieId,item.targetId))!==digest(item.merge??[]))throw Error('Изменилось решение об объединении.');
   }else if(item.targetId!==item.movieId)throw Error('Объединение телевизионных записей не поддерживается.');
   return [{item,work}];
  });
 };
 if(!validate().length)return {applied:0,merged:0,conflicts:0,withoutPoster:0};
 await backup();
 return db.transaction(()=>{
  const pending=validate(),now=new Date().toISOString(),json=(value:unknown)=>value===null?null:JSON.stringify(value);
  for(const {item,work:w} of pending){
   const d=w.details;
   const credits=w.type==='movie'&&item.targetId!==item.movieId?{...d.credits,catalog_alias:{movie_id:item.targetId,tmdb_id:w.id}}:d.credits;
   db.prepare(`UPDATE movies SET tmdb_id=?,tmdb_title=?,original_title=?,tmdb_release_year=?,original_language=?,overview=?,genres_json=?,runtime_minutes=?,poster_path=?,backdrop_path=?,tmdb_vote_average=?,tmdb_vote_count=?,tmdb_popularity=?,directors_json=?,credits_json=?,metadata_updated_at=?,media_type=?,tmdb_enrichment_status='matched',tmdb_attempted_at=? WHERE id=?`).run(
    w.type==='movie'&&item.targetId===item.movieId?w.id:null,w.type==='movie'?d.title:w.presentation.title,d.original_title,d.year,d.original_language,w.type==='movie'?d.overview:w.presentation.overview,json(d.genres),d.runtime,d.poster_path,d.backdrop_path,d.vote_average,d.vote_count,d.popularity,json(d.directors),json(credits),now,w.type==='movie'?'movie':'tv',now,item.movieId);
   if(w.type==='movie')saveRussianMovie(db,w.id,w.presentation);
  }
  let merged=0,conflicts=0;
  for(const {item,work} of pending){
   const marks=db.prepare(`SELECT l.*,s.sha256,d.decision_json FROM legacy_movie_marks l JOIN legacy_import_sources s ON s.user_id=l.user_id AND s.source_key=l.source_key LEFT JOIN legacy_identity_decisions d ON d.user_id=l.user_id AND d.source_key=l.source_key AND d.source_id=l.source_id WHERE l.movie_id=?`).all(item.movieId) as {user_id:UserId;source_key:string;source_id:string;sha256:string;decision_json:string|null}[];
   for(const action of item.merge??[])if(action.action==='conflict')conflicts++;else{movePersonal(db,item.movieId,item.targetId,action);merged++;}
   for(const mark of marks){
    const target=(item.merge??[]).find(a=>a.user===mark.user_id)?.action==='conflict'?item.movieId:item.targetId;
    const d=work.details;
    const selected={tmdb_id:work.id,media_type:work.type==='movie'?'movie':'tv',title:d.title,original_title:d.original_title,year:d.year,runtime:d.runtime,overview:work.type==='movie'?d.overview:work.presentation.overview,genres:d.genres,directors:d.directors,poster_path:d.poster_path,backdrop_path:d.backdrop_path,origin:'tmdb',verified:true,aliases:work.titles};
    const decision={source_id:mark.source_id,status:'confirmed',reason:item.reason,candidates:[selected],selected,repair_evidence:item.source,previous_decision:mark.decision_json?JSON.parse(mark.decision_json):null};
    db.prepare(`INSERT INTO legacy_identity_decisions(user_id,source_key,source_id,source_sha256,status,candidates_json,decision_json,applied_movie_id) VALUES(?,?,?,?,'confirmed',?,?,?) ON CONFLICT(user_id,source_key,source_id) DO UPDATE SET source_sha256=excluded.source_sha256,status=excluded.status,candidates_json=excluded.candidates_json,decision_json=excluded.decision_json,applied_movie_id=excluded.applied_movie_id`).run(mark.user_id,mark.source_key,mark.source_id,mark.sha256,JSON.stringify([selected]),JSON.stringify(decision),target);
    db.prepare('UPDATE legacy_movie_marks SET identity_confirmed=1 WHERE user_id=? AND source_key=? AND source_id=?').run(mark.user_id,mark.source_key,mark.source_id);
   }
  }
  if((db.pragma('foreign_key_check') as unknown[]).length||db.pragma('integrity_check',{simple:true})!=='ok')throw Error('Проверка целостности не пройдена.');
  return {applied:pending.length,merged,conflicts,withoutPoster:pending.filter(p=>!p.work.details.poster_path).length};
 }).immediate();
}
