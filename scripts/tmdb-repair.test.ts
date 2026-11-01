import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { migrateDatabase } from '../src/lib/migrations';
import { createLetterboxdReader, extractLetterboxdIdentity, letterboxdUrl, LetterboxdError } from '../src/lib/letterboxd-identity';
import { applyRepair, previewRepair, type RepairApi } from '../src/lib/tmdb-repair';
import { parseDetails } from '../src/lib/tmdb';

function fixture() {
  const db = new Database(':memory:'); db.pragma('foreign_keys=ON'); migrateDatabase(db);
  db.exec(`INSERT INTO movies(id,title,release_year,letterboxd_uri) VALUES(1,'Red Dragon',2002,'https://boxd.it/red'),(2,'Rose',2026,'https://boxd.it/rose');
    INSERT INTO user_movies(user_id,movie_id,watched,rating_100,watchlist,review_text) VALUES('ilya',1,1,0,1,'Впечатления'),('valeriy',1,1,NULL,0,'Другой профиль');`);
  const api: RepairApi = {
    search: async () => { throw Error('Не должен искать при прямом ID'); },
    details: async id => parseDetails({ id, title: id === 9533 ? 'Red Dragon' : 'Rose', original_title: id === 9533 ? 'Red Dragon' : 'Rose',
      release_date: id === 9533 ? '2002-01-01' : '2026-01-01', runtime: 100, poster_path: '/poster.jpg',
      credits: { cast: [{ id: 1, name: 'Actor', order: 0 }], crew: [{ id: 2, name: 'Director', job: 'Director' }] } }),
    presentation: async id => ({ title: id === 9533 ? 'Красный дракон' : 'Роза', overview: 'Описание' }),
  };
  const page = async (url: string) => `<body data-tmdb-type="movie" data-tmdb-id="${url.endsWith('red') ? 9533 : 1176962}">`;
  return { db, api, page };
}
const html = (body: string, status = 200, headers: Record<string,string> = {}) => new Response(body, { status, headers: { 'content-type': 'text/html', ...headers } });

test('extracts attributes and direct links, refuses conflicts, TV and malformed IDs remain explicit', () => {
  assert.deepEqual(extractLetterboxdIdentity('<body data-tmdb-id="9533" data-tmdb-type="movie"><a href="https://www.themoviedb.org/movie/9533">'), { type: 'movie', id: 9533 });
  assert.deepEqual(extractLetterboxdIdentity("<body data-tmdb-type='movie' data-tmdb-id=''><a href='https://www.themoviedb.org/tv/12'>"), { type: 'tv', id: 12 });
  assert.equal(extractLetterboxdIdentity('<html>Без ссылки</html>'), null);
  assert.deepEqual(extractLetterboxdIdentity(`<script>if (width < 768) { var a=1; a=2; } var fake='<a href="https://www.themoviedb.org/movie/2">';</script><!-- <a href="https://www.themoviedb.org/movie/3"> --><body data-tmdb-type="movie" data-tmdb-id="9533">`), { type: 'movie', id: 9533 });
  for (const value of ['<body data-tmdb-type="movie" data-tmdb-id="0">', '<body data-tmdb-id="4">', '<a href="https://www.themoviedb.org/movie/1"><a href="https://www.themoviedb.org/movie/2">', '<body data-tmdb-id="1" data-tmdb-id="2" data-tmdb-type="movie">']) assert.throws(() => extractLetterboxdIdentity(value));
});
test('only HTTPS trusted hosts; validates each redirect before fetching; limits redirects and rate', async () => {
  for (const url of ['http://letterboxd.com/film/a', 'https://letterboxd.com.evil.test/', 'https://user@boxd.it/a', 'https://boxd.it:444/a']) assert.throws(() => letterboxdUrl(url));
  let calls = 0;
  const denied = createLetterboxdReader({ fetch: async () => { calls++; return html('', 302, { location: 'https://127.0.0.1/' }); }, sleep: async () => {} });
  await assert.rejects(denied('https://boxd.it/a')); assert.equal(calls, 1);
  const waits: number[] = []; calls = 0;
  const good = createLetterboxdReader({ fetch: async () => ++calls === 1 ? html('', 302, { location: 'https://letterboxd.com/film/a/' }) : html('<body>ok'), now: () => 0, sleep: async n => { waits.push(n); } });
  assert.equal(await good('https://boxd.it/a'), '<body>ok'); assert.deepEqual(waits, [1000]);
  const loop = createLetterboxdReader({ fetch: async () => html('', 302, { location: '/loop' }), sleep: async () => {} });
  await assert.rejects(loop('https://boxd.it/a'), /Слишком много/);
});
test('blocks access restrictions and challenge pages; enforces streamed size, type and timeout', async () => {
  for (const response of [html('',403),html('',429),html('<title>Just a moment</title>')]) {
    await assert.rejects(createLetterboxdReader({ fetch: async () => response })('https://boxd.it/a'), (error: unknown) => error instanceof LetterboxdError && error.stop);
  }
  await assert.rejects(createLetterboxdReader({ fetch: async () => html('x'.repeat(2*1024*1024+1)) })('https://boxd.it/a'), /2 МБ/);
  await assert.rejects(createLetterboxdReader({ fetch: async () => new Response('{}') })('https://boxd.it/a'), /не HTML/);
  await assert.rejects(createLetterboxdReader({ timeoutMs: 5, fetch: async (_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(Error('aborted')))) })('https://boxd.it/a'), /таймаут/);
});
test('direct IDs repair ambiguous names in-place, preserve both profiles and source; repeat is no-op', async () => {
  const { db, api, page } = fixture();
  const before = db.prepare('SELECT * FROM user_movies ORDER BY user_id,movie_id').all();
  const source = db.prepare('SELECT id,title,release_year,letterboxd_uri FROM movies ORDER BY id').all();
  const report = await previewRepair(db, api, page);
  assert.deepEqual(report.items.map(i => i.details?.id), [9533,1176962]);
  assert.equal((db.prepare('SELECT count(*) n FROM movies WHERE tmdb_id IS NOT NULL').get() as { n: number }).n, 0);
  let backups = 0;
  assert.deepEqual(await applyRepair(db, JSON.parse(JSON.stringify(report)), async () => { backups++; }), { applied: 2, withoutPoster: 0 });
  assert.deepEqual(db.prepare('SELECT * FROM user_movies ORDER BY user_id,movie_id').all(), before);
  assert.deepEqual(db.prepare('SELECT id,title,release_year,letterboxd_uri FROM movies ORDER BY id').all(), source);
  assert.equal((db.prepare('SELECT count(*) n FROM ru_movie_metadata').get() as { n: number }).n, 2);
  assert.deepEqual(await applyRepair(db, report, async () => { backups++; }), { applied: 0, withoutPoster: 0 }); assert.equal(backups,1);
  assert.equal((await previewRepair(db,api,page)).items.length,0); db.close();
});
test('TV, mismatching details, conflicting identities and occupied IDs are never applied', async () => {
  for (const kind of ['tv','year','title','occupied','conflict']) {
    const { db, api, page } = fixture();
    if (kind==='occupied') db.exec("INSERT INTO movies(title,tmdb_id) VALUES('Other',9533)");
    if (kind==='year' || kind==='title') { const original=api.details; api.details=async id => ({...await original(id),...(kind==='year'?{year:2001}:{title:'Different',original_title:'Different'})}); }
    const report=await previewRepair(db,api,kind==='tv'?async()=>'<body data-tmdb-type="tv" data-tmdb-id="9533">':kind==='conflict'?async()=>'<a href="https://www.themoviedb.org/movie/1"><a href="https://www.themoviedb.org/movie/2">':page);
    assert.notEqual(report.items[0].status,'ready',kind); db.close();
  }
});
test('fallback only when no link, one exact match and complete search; metadata may have no poster', async () => {
  const {db,api}=fixture();
  api.search=async (title,year)=>({complete:true,candidates:[{id:title==='Red Dragon'?9533:1176962,title,original_title:title,year}]});
  const original=api.details; api.details=async id=>({...await original(id),poster_path:null});
  const report=await previewRepair(db,api,async()=>'<html>no link</html>');
  assert.deepEqual(await applyRepair(db,report,async()=>{}),{applied:2,withoutPoster:2}); db.close();
  for (const complete of [true,false]) {
    const {db,api}=fixture(); api.search=async(title,year)=>({complete,candidates:[1,2].map(id=>({id,title,original_title:title,year}))});
    assert.equal((await previewRepair(db,api,async()=>'<html>no link</html>')).items.filter(i=>i.status==='ready').length,0);db.close();
  }
});
test('source changes, stale source after backup, duplicate report IDs and backup failures abort without writes', async () => {
  for (const kind of ['source','afterBackup','duplicate','occupied','backup']) {
    const {db,api,page}=fixture(), report=await previewRepair(db,api,page);
    if(kind==='source') db.exec("UPDATE movies SET title='Changed' WHERE id=1");
    if(kind==='duplicate') report.items.push(report.items[0]);
    if(kind==='occupied') db.exec("INSERT INTO movies(title,tmdb_id) VALUES('Other',9533)");
    await assert.rejects(applyRepair(db,report,async()=>{ if(kind==='afterBackup') db.exec("UPDATE movies SET poster_path='/other' WHERE id=1"); if(kind==='backup') throw Error('backup failed'); }));
    assert.equal((db.prepare('SELECT count(*) n FROM movies WHERE id IN (1,2) AND tmdb_id IS NOT NULL').get() as { n: number }).n,0);db.close();
  }
});
test('transaction rolls back all metadata and Russian cache on later failure', async () => {
  const {db,api,page}=fixture(),report=await previewRepair(db,api,page);
  db.exec("CREATE TRIGGER fail_second BEFORE UPDATE ON movies WHEN NEW.id=2 BEGIN SELECT RAISE(ABORT,'injected'); END");
  await assert.rejects(applyRepair(db,report,async()=>{}),/injected/);
  assert.equal((db.prepare('SELECT count(*) n FROM movies WHERE tmdb_id IS NOT NULL').get() as { n: number }).n,0);
  assert.equal((db.prepare('SELECT count(*) n FROM ru_movie_metadata').get() as { n: number }).n,0); db.close();
});
test('site blocking stops whole traversal and records progress; ordinary errors do not invent candidates', async () => {
  const {db,api}=fixture();let calls=0,progress=0;
  const report=await previewRepair(db,api,async()=>{calls++;throw new LetterboxdError('blocked',true);},()=>progress++);
  assert.equal(report.stopped,true);assert.equal(calls,1);assert.equal(progress,1);assert.equal(report.items[0].status,'error');db.close();
});

test('CLI requires explicit database and offline report for apply before opening or changing data', () => {
  for (const args of [[],['--database','/nonexistent','--apply'],['--database','/nonexistent','--apply','--offline','--report','/nonexistent','--dry-run']]) {
    const result = spawnSync(process.execPath,['--import','tsx','scripts/tmdb-repair.ts',...args],{encoding:'utf8'});
    assert.equal(result.status,1);assert.doesNotMatch(result.stderr,/SQLITE_CANTOPEN/);
  }
});

test('fallback rejects details with a different ID, malformed serialized metadata fails before backup', async () => {
  const {db,api,page}=fixture();
  const report=await previewRepair(db,api,page);let backups=0;
  report.items[0].details!.runtime=-1;
  await assert.rejects(applyRepair(db,report,async()=>{backups++;})); assert.equal(backups,0);
  api.search=async(title,year)=>({complete:true,candidates:[{id:42,title,original_title:title,year}]});
  const originalDetails=api.details; api.details=async()=>originalDetails(9533);
  assert.equal((await previewRepair(db,api,async()=>'<html>no link</html>')).items.filter(i=>i.status==='ready').length,0);db.close();
});


test('CLI refuses an output report over the database or WAL without changing bytes', () => {
  const folder=mkdtempSync(join(tmpdir(),'repair-cli-')),file=join(folder,'movies.sqlite');
  try {
    writeFileSync(file,'existing database bytes');
    for(const report of [file,file+'-wal',file+'-shm']) {
      const result=spawnSync(process.execPath,['--import','tsx','scripts/tmdb-repair.ts','--database',file,'--report',report],{encoding:'utf8'});
      assert.equal(result.status,1);assert.match(result.stderr,/не может перезаписывать/);assert.equal(readFileSync(file,'utf8'),'existing database bytes');
    }
  } finally {rmSync(folder,{recursive:true,force:true});}
});
