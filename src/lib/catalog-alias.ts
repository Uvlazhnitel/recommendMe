import type Database from 'better-sqlite3';
// Only repair-written aliases to an existing, uniquely identified movie are usable.
export function repairedCatalogAlias(db:Database.Database,movieId:number):number|null {
 const row=db.prepare("SELECT credits_json FROM movies WHERE id=? AND media_type='movie' AND tmdb_id IS NULL AND tmdb_enrichment_status='matched'").get(movieId) as {credits_json:string|null}|undefined;
 if(!row?.credits_json)return null;
 try{const alias=JSON.parse(row.credits_json).catalog_alias;if(!alias||!Number.isSafeInteger(alias.movie_id)||!Number.isSafeInteger(alias.tmdb_id)||alias.movie_id===movieId||alias.movie_id<1||alias.tmdb_id<1)return null;
  return db.prepare("SELECT 1 FROM movies WHERE id=? AND tmdb_id=? AND media_type='movie'").get(alias.movie_id,alias.tmdb_id)?alias.movie_id:null;
 }catch{return null;}
}
