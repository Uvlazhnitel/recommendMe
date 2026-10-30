import type Database from 'better-sqlite3';
import {personalScope,ProfileError,type UserId} from './profiles';
import {backupForRecommendationWrite} from './recommendation-memory';
export async function setWatchlist(db:Database.Database,user:UserId,movieId:number,value:boolean,backup:(db:Database.Database)=>Promise<unknown>=backupForRecommendationWrite){
 personalScope(db,user);if((db.pragma('user_version',{simple:true}) as number)<9)throw new ProfileError('schema_upgrade_required',503);
 if(!Number.isSafeInteger(movieId)||movieId<1||typeof value!=='boolean')throw Error('Invalid watchlist input');
 if(!db.prepare('SELECT 1 FROM movies WHERE id=?').get(movieId))throw Error('Unknown movie');
 const before=db.prepare('SELECT watchlist FROM user_movies WHERE user_id=? AND movie_id=?').get(user,movieId) as {watchlist:number}|undefined;
 if((before?.watchlist??0)===Number(value))return {status:'unchanged',watchlist:value};
 await backup(db);
 return db.transaction(()=>{db.prepare('INSERT INTO user_movies(user_id,movie_id,watchlist) VALUES(?,?,?) ON CONFLICT(user_id,movie_id) DO UPDATE SET watchlist=excluded.watchlist').run(user,movieId,Number(value));return {status:'updated',watchlist:value};}).immediate();
}
