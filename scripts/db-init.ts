import { loadEnvConfig } from '@next/env';
import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { openDatabase } from '../src/lib/db';
import { migrateDatabase, SCHEMA_VERSION } from '../src/lib/migrations';
import { backupDatabase } from './container-db.mjs';
async function main(){
  const {values}=parseArgs({options:{offline:{type:'boolean'}},strict:true});
  if(!values.offline)throw Error('Stop application writers and explicitly supply --offline.');
  loadEnvConfig(process.cwd(),process.env.NODE_ENV!=='production');
  const path=resolve(process.env.DATABASE_PATH??'data/movies.sqlite');
  if(existsSync(path)){const db=openDatabase({readonly:true});let version:number;try{version=db.pragma('user_version',{simple:true}) as number;if(version>SCHEMA_VERSION)throw Error('Unsupported database schema version');if(version===0&&(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get() as {n:number}).n)throw Error('Uninitialized nonempty database requires manual inspection');}finally{db.close();}if(version>0)await backupDatabase(path,process.env.BACKUP_DIR??join(dirname(path),'backups'));}
  const db=openDatabase({create:true});try{console.log(`SQLite schema ready (version ${migrateDatabase(db)}).`);}finally{db.close();}
}
main().catch(error=>{console.error(error instanceof Error?error.message:'Initialization failed');process.exitCode=1;});
