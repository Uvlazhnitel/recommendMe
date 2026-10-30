import {profileRoute} from './profile-http';
import {openDatabase} from './db';
import {readJsonBody} from './http-json';
import {personalScope,ProfileError} from './profiles';
import {setWatchlist} from './watchlist';
export function watchlistHandler(dependencies:{open?:typeof openDatabase;backup?:Parameters<typeof setWatchlist>[4]}={}){
 return profileRoute(async(request,user,context:{params:Promise<{id:string}>})=>{
 const {id}=await context.params;const body=await readJsonBody(request);
 if(!/^[1-9]\d*$/.test(id)||!Number.isSafeInteger(Number(id))||!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length!==1||!('watchlist' in body)||typeof body.watchlist!=='boolean')return Response.json({error:'invalid_watchlist'},{status:400});
 const db=(dependencies.open??openDatabase)();try{personalScope(db,user);if((db.pragma('user_version',{simple:true}) as number)<9)throw new ProfileError('schema_upgrade_required',503);if(!db.prepare('SELECT 1 FROM movies WHERE id=?').get(Number(id)))return Response.json({error:'movie_not_found'},{status:404});return Response.json(await setWatchlist(db,user,Number(id),body.watchlist,dependencies.backup));}catch(error){if(error instanceof ProfileError)throw error;return Response.json({error:'watchlist_unavailable'},{status:503});}finally{db.close();}
 });
}
