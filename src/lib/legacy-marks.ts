import type Database from 'better-sqlite3';
import { personalScope, type UserId } from './profiles';
export type LegacySentiment = 'liked' | 'disliked' | 'mixed';
export function legacyMarks(db:Database.Database,userId:UserId){
 personalScope(db,userId);
 if((db.pragma('user_version',{simple:true}) as number)<9)return [];
 return db.prepare(`SELECT l.movie_id,l.sentiment,l.numeric_override,l.identity_confirmed,u.rating_100
 FROM legacy_movie_marks l JOIN user_movies u ON u.user_id=l.user_id AND u.movie_id=l.movie_id
 WHERE l.user_id=? ORDER BY l.movie_id,l.source_key,l.source_id`).all(userId) as {movie_id:number;sentiment:LegacySentiment|null;numeric_override:number;identity_confirmed:number;rating_100:number|null}[];
}
export function activeLegacyMarks(db:Database.Database,userId:UserId){
 return legacyMarks(db,userId).filter(r=>!r.numeric_override&&r.rating_100===null&&r.sentiment!==null);
}

export function legacyMovieInfo(db:Database.Database,userId:UserId,movieId:number){
 const marks=legacyMarks(db,userId).filter(r=>r.movie_id===movieId);
 if(!marks.length)return {};
 const rows=db.prepare(`SELECT l.source_id,s.document_json FROM legacy_movie_marks l JOIN legacy_import_sources s ON s.user_id=l.user_id AND s.source_key=l.source_key WHERE l.user_id=? AND l.movie_id=?`).all(userId,movieId) as {source_id:string;document_json:string}[];
 const external:{raw:string;source:string|null}[]=[];
 for(const r of rows){const doc=JSON.parse(r.document_json);const entry=doc.library.find((x:{id:string})=>x.id===r.source_id);if(!entry)continue;for(const o of doc.occurrences){if(!entry.source_ids.includes(o.id))continue;for(const rating of o.external_ratings??[]){if(typeof rating.raw!=='string'&&typeof rating.raw!=='number')continue;external.push({raw:String(rating.raw).slice(0,200),source:typeof rating.source==='string'&&!/^(unknown|неизвестно)$/i.test(rating.source)?rating.source.slice(0,200):null});}}}
 const sentiments=new Set(marks.flatMap(r=>r.sentiment?[r.sentiment]:[]));const sentiment:LegacySentiment|null=sentiments.has('mixed')||sentiments.size>1?'mixed':sentiments.size?[...sentiments][0]:null;
 return {legacy_unconfirmed:marks.some(r=>!r.identity_confirmed),legacy_marks:[{sentiment,superseded:marks.some(r=>!!r.numeric_override)}],external_ratings:[...new Map(external.map(r=>[JSON.stringify(r),r])).values()]};
}
