import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import Database from 'better-sqlite3';
import { validateFatherList } from './father-list-validate.mjs';
import { backupDatabase } from './container-db.mjs';
const sourceKey='father-list-v2';
export function planFatherImport(db, owner, bytes) {
 if(owner!=='valeriy')throw Error('Import requires --user valeriy');
 const validation=validateFatherList(bytes);
 if(![9,10].includes(db.pragma('user_version',{simple:true})))throw Error('Explicit offline schema 9 migration required');
 const source=db.prepare('SELECT sha256 FROM legacy_import_sources WHERE user_id=? AND source_key=?').get(owner,sourceKey);
 const data=JSON.parse(bytes.toString('utf8'));
 const changed=source && source.sha256!==validation.sha256;
 const entries=data.library.map(row=>({source_id:row.id,action:changed?'conflict':source?'skip':'add',identity:'unconfirmed'}));
 return {validation,entries,summary:{processed:entries.length,add:entries.filter(r=>r.action==='add').length,skip:entries.filter(r=>r.action==='skip').length,conflict:entries.filter(r=>r.action==='conflict').length,ambiguous:validation.counts.ambiguous_identity,unconfirmed:entries.length}};
}
/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} owner
 * @param {Buffer} bytes
 * @param {{write?:boolean,backup?:(db:import('better-sqlite3').Database)=>Promise<unknown>}} options
 */
export async function importFatherList(db,owner,bytes,{write=false,backup}={}){
 const plan=planFatherImport(db,owner,bytes);
 if(!write||!plan.summary.add)return {...plan,written:0};
 if(!backup)throw Error('Verified offline backup required before import');
 await backup(db);
 return db.transaction(()=>{
  const current=planFatherImport(db,owner,bytes);
  if(current.summary.add!==plan.summary.add)throw Error('Import state changed; inspect and retry explicitly');
  const data=JSON.parse(bytes.toString('utf8'));
  db.prepare('INSERT INTO legacy_import_sources(user_id,source_key,sha256,document_json) VALUES(?,?,?,?)').run(owner,sourceKey,plan.validation.sha256,bytes.toString('utf8'));
  const movie=db.prepare('INSERT INTO movies(title,release_year,media_type) VALUES(?,?,?)');
  const personal=db.prepare('INSERT INTO user_movies(user_id,movie_id,watched,watchlist) VALUES(?,?,?,?)');
  const mark=db.prepare('INSERT INTO legacy_movie_marks(user_id,source_key,source_id,movie_id,sentiment) VALUES(?,?,?,?,?)');
  for(const row of data.library){
   const id=Number(movie.run(row.title,row.year,row.media_type==='series'?'tv':'unknown').lastInsertRowid);
   personal.run(owner,id,Number(row.watched),Number(row.planned_to_watch||row.watchlist));
   mark.run(owner,sourceKey,row.id,id,row.sentiment);
  }
  return {...plan,written:data.library.length};
 }).immediate();
}
async function main(){
 const {values}=parseArgs({options:{user:{type:'string'},input:{type:'string'},write:{type:'boolean'},offline:{type:'boolean'},database:{type:'string'},'backup-dir':{type:'string'}},strict:true});
 if(values.user!=='valeriy'||!values.input||!values.database)throw Error('Require --user valeriy --input FILE --database EXPLICIT_PATH; preview by default');
 if(values.write&&!values.offline)throw Error('Stop writers and supply --offline for explicit import');
 const bytes=readFileSync(resolve(values.input));validateFatherList(bytes);
 const path=resolve(values.database);const db=new Database(path,{readonly:!values.write,fileMustExist:true});db.pragma('foreign_keys=ON');
 try{const result=await importFatherList(db,values.user,bytes,{write:values.write,backup:()=>backupDatabase(path,resolve(values['backup-dir']??join(dirname(path),'import-backups')))});console.log(JSON.stringify(result,null,2));}finally{db.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(e=>{console.error(e.message);process.exitCode=1});
