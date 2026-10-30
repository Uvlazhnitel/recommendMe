import {loadEnvConfig} from '@next/env';
import {parseArgs} from 'node:util';
import {readFileSync,writeFileSync,existsSync,mkdirSync,renameSync,appendFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import Database from 'better-sqlite3';
import {createTmdbClient,normalizeTitle} from '../src/lib/tmdb';
import {decideIdentity,storeIdentityDecisions,applyIdentityDecisions,type IdentityInput,type IdentityCandidate,type IdentityDecision} from '../src/lib/legacy-identity';
import {backupDatabase} from './container-db.mjs';
async function main(){
 const {values:v}=parseArgs({options:{user:{type:'string'},database:{type:'string'},output:{type:'string'},cache:{type:'string'},live:{type:'boolean'},write:{type:'boolean'},apply:{type:'boolean'},offline:{type:'boolean'},'max-requests':{type:'string'}},strict:true});
 if(v.user!=='valeriy'||!v.database||!v.output)throw Error('Require --user valeriy --database COPY --output PRIVATE_REPORT');
 if((v.write||v.apply)&&!v.offline)throw Error('Explicit --offline required for writes');
 if(v.apply&&!v.write)throw Error('--apply requires --write');
 const path=resolve(v.database);const db=new Database(path,{readonly:!v.write,fileMustExist:true});db.pragma('foreign_keys=ON');
 try{
 const source=db.prepare("SELECT sha256,document_json FROM legacy_import_sources WHERE user_id='valeriy' AND source_key='father-list-v2'").get() as {sha256:string;document_json:string}|undefined;
 if(!source)throw Error('Import prepared source first');
 if(createHash('sha256').update(source.document_json).digest('hex')!==source.sha256)throw Error('Source checksum mismatch');
 const inputs=JSON.parse(source.document_json).library as IdentityInput[];
 const rows=db.prepare("SELECT * FROM movies WHERE tmdb_id IS NOT NULL AND tmdb_enrichment_status='matched' AND metadata_updated_at IS NOT NULL").all() as Record<string,unknown>[];
 const local:IdentityCandidate[]=rows.map(r=>({tmdb_id:Number(r.tmdb_id),media_type:r.media_type as 'movie',title:String(r.tmdb_title??r.title),original_title:(r.original_title??r.title) as string,year:(r.tmdb_release_year??r.release_year) as number|null,runtime:r.runtime_minutes as number|null,overview:r.overview as string|null,genres:JSON.parse(String(r.genres_json??'null')),directors:JSON.parse(String(r.directors_json??'null')),poster_path:r.poster_path as string|null,backdrop_path:r.backdrop_path as string|null,origin:'local',verified:true}));
 mkdirSync(dirname(resolve(v.output)),{recursive:true,mode:0o700});
 loadEnvConfig(process.cwd());const limit=Number(v['max-requests']??2000);if(!Number.isSafeInteger(limit)||limit<1)throw Error('Invalid request limit');
 const client=v.live&&process.env.TMDB_API_KEY?createTmdbClient(process.env.TMDB_API_KEY,{maxRequests:limit,fetch:async(input,init)=>{const url=new URL(input instanceof Request?input.url:String(input));appendFileSync(resolve(v.output!)+'.requests.jsonl',JSON.stringify({time:new Date().toISOString(),host:url.hostname,path:url.pathname})+'\n',{mode:0o600});return fetch(input,init);}}):null;
 const cachePath=resolve(v.cache??v.output+'.cache.json');const cache:Record<string,unknown>=existsSync(cachePath)?JSON.parse(readFileSync(cachePath,'utf8')):{};
 const saveCache=()=>{mkdirSync(dirname(cachePath),{recursive:true,mode:0o700});writeFileSync(cachePath+'.tmp',JSON.stringify(cache),{mode:0o600});renameSync(cachePath+'.tmp',cachePath);};
 const cached=async<T>(key:string,fn:()=>Promise<T>):Promise<T>=>{if(Object.hasOwn(cache,key))return cache[key] as T;const value=await fn();cache[key]=value;saveCache();return value;};
 const decisions:IdentityDecision[]=[];let unavailable=!client;let errors=0;
 for(const input of inputs){
  const type=input.media_type==='series'?'tv':'movie';const same=(title:string|null)=>title!==null&&normalizeTitle(title)===normalizeTitle(input.title);
  const candidates=local.filter(c=>c.media_type===type&&c.year===input.year&&(same(c.title)||same(c.original_title)));
  let decision=decideIdentity(input,candidates);
  if(decision.status!=='confirmed'&&client&&!unavailable){let complete=true;
   try{for(const language of ['ru-RU','en-US']){const search=await cached(`search:v1:${type}:${language}:${input.title}:${input.year}`,()=>client.identitySearch(input.title,input.year,type,language));complete=complete&&search.complete;
    for(const hit of search.candidates){candidates.push({tmdb_id:hit.id,media_type:type,title:hit.title,original_title:hit.original_title,year:hit.year,runtime:null,overview:null,genres:null,directors:null,origin:'tmdb',verified:false});if(hit.year!==input.year||input.year===null||!([hit.title,hit.original_title].some(same)))continue;
     const d=await cached(`details:v1:${type}:${language}:${hit.id}`,()=>client.identityDetails(hit.id,type,language));
     candidates.push({tmdb_id:d.id,media_type:type,title:d.title,original_title:d.original_title,year:d.year,runtime:d.runtime,overview:d.overview,genres:d.genres,directors:d.directors,poster_path:d.poster_path,backdrop_path:d.backdrop_path,origin:'tmdb',verified:true});
    }
   }}catch{errors++;complete=false;if(client.stats.requests>=limit)unavailable=true;}
   decision=decideIdentity(input,candidates,complete);
  }
  decisions.push(decision);
 }
 let applied:null|ReturnType<typeof applyIdentityDecisions>=null;
 if(v.write){await backupDatabase(path,resolve(dirname(path),'matching-backups'));db.transaction(()=>{storeIdentityDecisions(db,'valeriy','father-list-v2',source.sha256,decisions);if(v.apply)applied=applyIdentityDecisions(db,'valeriy','father-list-v2');}).immediate();}
 const summary={processed:inputs.length,confirmed_records:decisions.filter(d=>d.status==='confirmed').length,unique_confirmed_works:new Set(decisions.flatMap(d=>d.selected?[d.selected.media_type+':'+d.selected.tmdb_id]:[])).size,ambiguous:decisions.filter(d=>d.status==='ambiguous').length,not_found:decisions.filter(d=>d.status==='not_found').length,tmdb_requests:client?.stats.requests??0,tmdb_failed_requests:client?.stats.failedRequests??0,tmdb_available:!!client,errors,applied};
 mkdirSync(dirname(resolve(v.output)),{recursive:true,mode:0o700});writeFileSync(resolve(v.output),JSON.stringify({user_id:'valeriy',source_sha256:source.sha256,summary,decisions},null,2),{mode:0o600});console.log(JSON.stringify(summary));
 }finally{db.close();}
}
main().catch(error=>{const message=error instanceof Error?error.message:'unknown';console.error('Matching failed: '+(/https?:/i.test(message)?'network error':message.slice(0,300)));process.exitCode=1;});
