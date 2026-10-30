import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, report, choice } from './fixtures/recommendation-screen';
import { recordRecommendations } from '../src/lib/recommendation-memory';
import { readRecommendationBatch } from '../src/lib/recommendation-batches';
import { buildRankingContext } from '../src/lib/recommendation-context';
import { readLibrary, readLibraryMovie } from '../src/lib/library';
import { readHomeSummary } from '../src/lib/home-summary';
import { createTmdbClient } from '../src/lib/tmdb';
import { explanationHash, russianExplanation, russianGenres, saveRussianMovie, translateExplanation } from '../src/lib/russian-presentation';
import { backupDatabase, restoreBackup } from './container-db.mjs';

const ru = { why_fit: 'Сходство с высоко оценёнными фильмами подтверждается камерным сюжетом.', possible_mismatch: 'Темп может показаться медленным; информации о финале недостаточно.' };
const snapshot = (db: Database.Database) => JSON.stringify(['movies','user_movies','recommendations','taste_profile','recommendation_evaluation','recommendation_outcomes'].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
function setup() {
  const f = fixture();
  const result = { mode: 'live', status: 'ok', recommendations: [choice(201)] };
  recordRecommendations(f.db, 'ilya', report([201]), { result }, { dryRun: false });
  f.db.exec("INSERT INTO recommendations(user_id,movie_id,recommended_at,why_fit,possible_mismatch,result_id) SELECT 'valeriy',movie_id,recommended_at,why_fit,possible_mismatch,result_id FROM recommendations WHERE user_id='ilya'");
  const rows = f.db.prepare('SELECT id,user_id,movie_id,why_fit,possible_mismatch FROM recommendations ORDER BY id').all() as { id: number; user_id: 'ilya' | 'valeriy'; movie_id: number; why_fit: string; possible_mismatch: string }[];
  return { ...f, rows };
}
function provider(body: unknown = ru) {
  let calls = 0;
  return { get calls() { return calls; }, apiKey: 'mock', model: 'mock', fetch: (async () => {
    calls++;
    return Response.json({ status: 'completed', model: 'mock', usage: { input_tokens: 10, output_tokens: 20 },
      output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(body) }] }] });
  }) as typeof fetch };
}

test('Russian display overlays preserve canonical data, ranking inputs, IDs and both personal histories', async () => {
  const f = setup(); try {
    const original = snapshot(f.db);
    const before = buildRankingContext(f.db, 'ilya', report([201]).candidates).input;
    const api = provider();
    await translateExplanation(f.db, 'ilya', f.rows[0].id, api);
    saveRussianMovie(f.db, 201, { title: 'Русское название', overview: 'Русское описание.' });
    const batch = readRecommendationBatch(f.db, 'ilya')!;
    assert.equal(batch.movies[0].title, 'Русское название');
    assert.equal(batch.movies[0].why_fit, ru.why_fit);
    assert.deepEqual(batch.movies.map(row => row.tmdb_id), [201]);
    assert.match(readRecommendationBatch(f.db, 'valeriy')!.movies[0].why_fit, /ещё не подготовлено/);
    assert.equal(readLibraryMovie(f.db, 'ilya', f.rows[0].movie_id).overview, 'Русское описание.');
    f.db.prepare("INSERT INTO user_movies(user_id,movie_id,watched,rating_100) VALUES('valeriy',?,1,0)").run(f.rows[0].movie_id);
    assert.equal(readLibrary(f.db, 'valeriy', new URLSearchParams('q=русское')).items[0].title, 'Русское название');
    assert.equal(readLibrary(f.db, 'ilya', new URLSearchParams('q=русское')).items.length, 0);
    f.db.prepare("DELETE FROM user_movies WHERE user_id='valeriy'").run();
    assert.deepEqual(buildRankingContext(f.db, 'ilya', report([201]).candidates).input, before);
    assert.equal(snapshot(f.db), original);
    assert.match(before[0].content, /why_fit and possible_mismatch in natural Russian/);
  } finally { f.cleanup(); }
});

test('successful cache survives reopen and skips duplicate charges; changed source invalidates translation', async () => {
  const f = setup(); try {
    const api = provider(); const row = f.rows[0];
    assert.equal(await translateExplanation(f.db, 'ilya', row.id, api), 'translated');
    assert.equal(await translateExplanation(f.db, 'ilya', row.id, api), 'skipped'); assert.equal(api.calls, 1);
    const reopened = f.open({ readonly: true });
    try { assert.equal(russianExplanation(reopened, 'ilya', row).why_fit, ru.why_fit); } finally { reopened.close(); }
    f.db.prepare('UPDATE recommendations SET why_fit=? WHERE id=?').run('A different English explanation.', row.id);
    const changed = { ...row, why_fit: 'A different English explanation.' };
    assert.notEqual(explanationHash(changed), explanationHash(row));
    assert.notEqual(russianExplanation(f.db, 'ilya', changed).why_fit, ru.why_fit);
    assert.equal(await translateExplanation(f.db, 'ilya', row.id, api), 'translated'); assert.equal(api.calls, 2);
    const usage = f.db.prepare('SELECT usage_json FROM ru_recommendation_text WHERE recommendation_id=?').get(row.id) as { usage_json: string };
    assert.equal(JSON.parse(usage.usage_json).length, 2);
    await assert.rejects(translateExplanation(f.db, 'valeriy', row.id, api)); assert.equal(api.calls, 2);
  } finally { f.cleanup(); }
});

test('invalid translation and uncertain network failures never overwrite source and need explicit retry', async () => {
  const f = setup(); try {
    const original = snapshot(f.db), row = f.rows[0]; const invalid = provider({ why_fit: 'English only', possible_mismatch: 'English risk' });
    await assert.rejects(translateExplanation(f.db, 'ilya', row.id, invalid), /некорректный/);
    assert.equal(await translateExplanation(f.db, 'ilya', row.id, invalid), 'skipped'); assert.equal(invalid.calls, 1);
    let attempted = 0;
    await assert.rejects(translateExplanation(f.db, 'ilya', row.id, { apiKey: 'mock', model: 'mock', retryFailed: true,
      fetch: (async () => { attempted++; throw Error('private transport failure'); }) as typeof fetch }));
    assert.equal(attempted, 1); const good = provider();
    assert.equal(await translateExplanation(f.db, 'ilya', row.id, good), 'skipped');
    assert.equal(await translateExplanation(f.db, 'ilya', row.id, { ...good, retryFailed: true }), 'translated');
    assert.equal(snapshot(f.db), original);
  } finally { f.cleanup(); }
});

test('pending attempt after crash is skipped until explicit offline retry; Russian originals need no API', async () => {
  const f = setup(); try {
    const row = f.rows[0];
    f.db.prepare(`INSERT INTO ru_recommendation_text(recommendation_id,user_id,movie_id,source_hash,status,updated_at) VALUES(?,'ilya',?,?,'pending','now')`).run(row.id, row.movie_id, explanationHash(row));
    const api = provider(); assert.equal(await translateExplanation(f.db, 'ilya', row.id, api), 'skipped'); assert.equal(api.calls, 0);
    assert.equal(await translateExplanation(f.db, 'ilya', row.id, { ...api, retryFailed: true }), 'translated');
    f.db.prepare('UPDATE recommendations SET why_fit=?,possible_mismatch=? WHERE id=?').run(ru.why_fit, ru.possible_mismatch, row.id);
    assert.equal(await translateExplanation(f.db, 'ilya', row.id, {}), 'translated');
  } finally { f.cleanup(); }
});

test('TMDB presentation is ru-RU, validates identity, handles missing description and preserves canonical en-US requests', async () => {
  const urls: URL[] = [];
  const client = createTmdbClient('mock', { sleep: async () => {}, fetch: (async input => {
    const url = new URL(String(input)); urls.push(url);
    return Response.json({ id: 201, title: 'Русское название', original_title: 'Original', overview: '', total_pages: 1, results: [] });
  }) as typeof fetch });
  assert.deepEqual(await client.presentation(201), { title: 'Русское название', overview: null });
  await client.searchInteractive('фильм'); await client.search('Original', 2000);
  assert.deepEqual(urls.map(url => url.searchParams.get('language')), ['ru-RU', 'ru-RU', 'en-US']);
  const wrong = createTmdbClient('mock', { fetch: (async () => Response.json({ id: 999, title: 'Чужой фильм' })) as typeof fetch });
  await assert.rejects(wrong.presentation(201));
  assert.deepEqual(russianGenres([{ id: 18, name: 'Drama' }, { id: 878, name: 'Science Fiction' }]).map(row => row.name), ['Драма','Фантастика']);
});

test('favorites use Russian title without changing selection; missing Russian overview has a Russian placeholder', () => {
  const f = fixture(); try {
    saveRussianMovie(f.db, 101, { title: 'Любимый фильм', overview: null });
    assert.equal(readHomeSummary(f.db, 'ilya').favorites[0].title, 'Любимый фильм');
    assert.match(readLibraryMovie(f.db, 'ilya', 1).overview!, /Описание на русском/);
  } finally { f.cleanup(); }
});

test('verified snapshot/restore includes both caches and original rows', async () => {
  const f = setup(); try {
    saveRussianMovie(f.db, 201, { title: 'Название', overview: 'Описание' });
    await translateExplanation(f.db, 'ilya', f.rows[0].id, provider());
    const snapshotPath = await backupDatabase(f.path, join(f.dir, 'backups'));
    const target = join(f.dir, 'restored', 'movies.sqlite');
    restoreBackup(snapshotPath, target, { relocateFrom: realpathSync(f.path) });
    const restored = new Database(target, { readonly: true });
    try {
      assert.equal(snapshot(restored), snapshot(f.db));
      for (const table of ['ru_movie_metadata','ru_recommendation_text']) assert.deepEqual(restored.prepare(`SELECT * FROM ${table}`).all(), f.db.prepare(`SELECT * FROM ${table}`).all());
    } finally { restored.close(); }
    assert.ok(readFileSync(join(snapshotPath, 'manifest.json'), 'utf8').includes('ru_recommendation_text'));
  } finally { f.cleanup(); }
});


test('CLI previews without writes, translates both profiles once, creates verified backup and resumes after restart', () => {
  const f = setup(); try {
    const original = snapshot(f.db), preload = join(f.dir, 'providers.mjs'), calls = join(f.dir, 'calls.jsonl');
    writeFileSync(calls, '');
    writeFileSync(preload, `import {appendFileSync} from 'node:fs';
      globalThis.fetch = async (input, init) => {
        const url = new URL(String(input));
        appendFileSync(process.env.RU_TEST_CALLS, JSON.stringify({host:url.hostname})+'\\n');
        if(url.hostname==='api.themoviedb.org') return Response.json({id:Number(url.pathname.split('/').at(-1)),title:'Русское название',overview:'Русское описание.'});
        if(url.hostname!=='api.openai.com') throw Error('External network forbidden');
        return Response.json({status:'completed',model:'mock',usage:{input_tokens:10,output_tokens:20},output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(${JSON.stringify(ru)})}]}]});
      };`);
    const run = (user: string, write = false) => execFileSync(process.execPath, ['--import', 'tsx', 'scripts/localize-ru.ts', '--user', user, ...(write ? ['--write','--offline'] : [])], {
      cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, DATABASE_PATH: f.path, BACKUP_DIR: join(f.dir, 'backups'), OPENAI_API_KEY: 'mock', OPENAI_MODEL: 'mock', TMDB_API_KEY: 'mock',
        NODE_OPTIONS: '--import ' + pathToFileURL(preload).href, RU_TEST_CALLS: calls },
    });
    assert.match(run('ilya'), /предпросмотр/); assert.equal(readFileSync(calls,'utf8'), ''); assert.equal(snapshot(f.db), original);
    assert.match(run('ilya', true), /Проверенная резервная копия/);
    assert.match(run('valeriy', true), /Проверенная резервная копия/);
    const beforeCalls = readFileSync(calls,'utf8');
    assert.match(run('ilya', true), /Новых текстов для перевода нет/);
    assert.equal(readFileSync(calls,'utf8'), beforeCalls);
    assert.equal((beforeCalls.match(/api.openai.com/g) ?? []).length, 2);
    assert.equal(snapshot(f.db), original);
    for(const user of ['ilya','valeriy'] as const) assert.equal(readRecommendationBatch(f.db,user)!.movies[0].why_fit, ru.why_fit);
  } finally { f.cleanup(); }
});

test('concurrent default translation uses one API call and source edits during translation prevent stale writes', async () => {
  const f = setup(); try {
    const api = provider(), row = f.rows[0];
    const results = await Promise.all([translateExplanation(f.db,'ilya',row.id,api),translateExplanation(f.db,'ilya',row.id,api)]);
    assert.deepEqual(results.sort(),['skipped','translated']); assert.equal(api.calls,1);
    f.db.prepare('UPDATE recommendations SET why_fit=? WHERE id=?').run('An updated explanation.',row.id);
    await assert.rejects(translateExplanation(f.db,'ilya',row.id,{apiKey:'mock',model:'mock',fetch:(async()=>{
      f.db.prepare('UPDATE recommendations SET why_fit=? WHERE id=?').run('A second update.',row.id);
      return api.fetch('https://api.openai.com');
    }) as typeof fetch}), /изменилось/);
    assert.equal((f.db.prepare('SELECT status FROM ru_recommendation_text WHERE recommendation_id=?').get(row.id) as {status:string}).status,'failed');
    assert.equal(readRecommendationBatch(f.db,'ilya')!.movies[0].why_fit,'Русское объяснение ещё не подготовлено.');
  } finally { f.cleanup(); }
});
