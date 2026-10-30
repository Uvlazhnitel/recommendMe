import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, renameSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), require = createRequire(import.meta.url);
const Database = require('better-sqlite3'), args = process.argv.slice(2);
function option(name, fallback) { const i = args.indexOf(name); if (i < 0) return fallback; if (!args[i+1] || args[i+1].startsWith('--')) throw Error(`Missing ${name} value`); return args[i+1]; }
if (args.some((arg,i) => i%2 === 0 && !['--port','--output','--playwright-path'].includes(arg))) throw Error('Options: --port, --output, --playwright-path.');
const port = Number(option('--port', '45152'));
assert.ok(Number.isInteger(port) && port > 1024 && port <= 65535, 'Use a test port from 1025 to 65535.');
const output = resolve(option('--output') ?? mkdtempSync(join(tmpdir(), 'recommendme-phase4-evidence-')));
const outputRelative = relative(root, output);
assert.ok(outputRelative === '..' || outputRelative.startsWith('..'+sep) || isAbsolute(outputRelative), 'Screenshots/output must be outside the repository.');
mkdirSync(output, { recursive: true });
let playwright;
try { playwright = require(option('--playwright-path', 'playwright')); }
catch { throw Error('Playwright is not installed locally. Pass --playwright-path pointing to an existing installation; no packages were installed.'); }
assert.ok(existsSync(join(root, '.next/BUILD_ID')), 'Run npm run build before test:ux.');
const hash = value => createHash('sha256').update(value).digest('hex');
function contrast(a,b) {
  const luminance=color=>{const text=color.trim(),rgb=text.startsWith('#')?[0,2,4].map(i=>parseInt(text.slice(1+i,3+i),16)):(text.match(/[\d.]+/g)??[]).slice(0,3).map(Number);
    return rgb.map(value=>{const x=value/255;return x<=.04045?x/12.92:((x+.055)/1.055)**2.4;}).reduce((sum,x,i)=>sum+x*[.2126,.7152,.0722][i],0);};
  const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);
}

function protectedState() {
  const files = ['data/movies.sqlite','.env.local','data/import/ratings(6).csv','data/import/watched(6).csv'];
  const result = { files: Object.fromEntries(files.filter(file=>existsSync(join(root,file))).map(file=>[file,hash(readFileSync(join(root,file)))])) };
  if (existsSync(join(root,'data/movies.sqlite'))) {
    const db = new Database(join(root,'data/movies.sqlite'), { readonly: true, fileMustExist: true });
    try { Object.assign(result, { schema: db.pragma('user_version',{simple:true}), tables: Object.fromEntries(['movies','user_movies','taste_profile','recommendations'].map(table=>[table,hash(JSON.stringify(db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()))])), integrity: db.pragma('integrity_check'), fk: db.pragma('foreign_key_check') }); }
    finally { db.close(); }
  }
  return result;
}
const before = protectedState(), temp = mkdtempSync(join(tmpdir(),'recommendme-phase4-run-'));
const metadata = join(temp,'fixture.json'), controlPath = join(temp,'control.json'), callsPath = join(temp,'calls.jsonl');
const base = `http://127.0.0.1:${port}`, checks = [], errors = [], expectedNetworkErrors = [], measurements = [];
let child, browser, fixture, page;
const report = { status: 'running', base: `127.0.0.1:${port}`, real_openai_calls: 0, real_tmdb_calls: 0, checks, errors, expectedNetworkErrors, measurements };
function control(value) { writeFileSync(controlPath,JSON.stringify({round:1,mode:'ok',delay:0,...value}),{mode:0o600}); }
function calls(provider) { return existsSync(callsPath) ? readFileSync(callsPath,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)).filter(item=>!provider||item.provider===provider).length : 0; }
const openaiCalls = () => calls('api.openai.com');
function check(name) { checks.push(name); console.log(`PASS ${name}`); }
async function until(fn, description, timeout=20000) {
  const end = Date.now()+timeout; let last;
  while(Date.now()<end) { try { const value=await fn(); if(value)return value; } catch(error){last=error;} await new Promise(resolve=>setTimeout(resolve,100)); }
  throw Error(`Timed out: ${description}${last?` (${last.message})`:''}`);
}
function database(fn) { const db=new Database(fixture.path); db.pragma('foreign_keys=ON'); try{return fn(db);}finally{db.close();} }
async function stop() {
  const owned=child;child=undefined;if(!owned||owned.exitCode!==null)return;
  await new Promise(resolveExit=>{
    const timer=setTimeout(()=>{try{process.kill(-owned.pid,'SIGKILL');}catch{}resolveExit();},5000);
    owned.once('exit',()=>{clearTimeout(timer);resolveExit();});
    try{process.kill(-owned.pid,'SIGTERM');}catch(error){clearTimeout(timer);if(error.code!=='ESRCH')throw error;resolveExit();}
  });
}
async function start() {
  await new Promise((resolveReady,reject)=>{const server=createServer();server.once('error',()=>reject(Error(`Test port ${port} is occupied; no process was stopped.`)));server.listen(port,'127.0.0.1',()=>server.close(resolveReady));});
  const log=openSync(join(output,'server.log'),'a');
  child=spawn(process.execPath,[join(root,'node_modules/next/dist/bin/next'),'start','--hostname','127.0.0.1','--port',String(port)],{cwd:root,detached:true,stdio:['ignore',log,log],env:{...process.env,
    ACCESS_MODE:'local',DATABASE_PATH:fixture.path,OPENAI_API_KEY:'phase4-mock-openai',OPENAI_MODEL:'phase4-mock-model',TMDB_API_KEY:'phase4-mock-tmdb',NEXT_TELEMETRY_DISABLED:'1',
    PHASE4_CONTROL:controlPath,PHASE4_CALLS:callsPath,NODE_OPTIONS:`--import ${join(root,'scripts/fixtures/phase4-providers.mjs')}`}});closeSync(log);
  await until(async()=>{const r=await fetch(base+'/api/health');return r.ok;},'isolated production server');
}
const http = Object.fromEntries(['get','post','patch'].map(method=>[method,async (url, options={})=>{
  const current=await page.request.get(base+'/api/profile');
  const active=(await current.json()).active;
  assert.ok(active, 'Direct personal API request requires an active profile');
  return page.request[method](url,{...options,headers:{...options.headers,'X-Profile-ID':active.user_id,'X-Profile-Selection':active.selection_id}});
}]));
function fulfill(route, options) {
  const h=route.request().headers();
  return route.fulfill({...options,headers:{...options.headers,'X-Profile-ID':h['x-profile-id']??'','X-Profile-Selection':h['x-profile-selection']??''}});
}
async function chooseIlya(target) {
  await target.getByRole('heading',{name:'Кто будет смотреть?'}).waitFor();
  await target.getByRole('button',{name:'Илья',exact:true}).click();
  await target.getByRole('button',{name:'Сменить профиль: Илья'}).waitFor();
}
async function state() { const r=await http.get(base+'/api/recommendations');assert.equal(r.status(),200);return r.json(); }
// AppShell can prefetch routes after the access/profile checks. Each scenario
// waits for its own visible state instead of waiting for background network idle.
async function go(path) {
  await page.goto(base+path);
  if (new URL(base+path).pathname === '/') {
    await page.locator('.profile-chooser, .home-v2').first().waitFor();
    if (await page.locator('.home-v2').count()) await page.locator('.home-v2 .loading-state').waitFor({state:'hidden'});
  }
}
async function libraryReady() { await page.locator('.library-results[aria-busy="false"]').waitFor(); }
async function screenshot(name, fullPage=false) {
  await page.evaluate(()=>document.fonts.ready);
  if(['library-mobile','library-desktop'].includes(name))await page.evaluate(()=>window.scrollTo({top:0,behavior:'instant'}));
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await page.screenshot({path:join(output,name+'.png'),fullPage,animations:'disabled'});
}
const alerts = () => page.locator('main [role="alert"]');
const rating = () => page.getByRole('spinbutton',{name:'Точное число'});
async function saveRating(value) {
  await rating().fill(String(value));await page.getByRole('button',{name:'Сохранить оценку',exact:true}).click();
  await page.getByRole('status').filter({hasText:/Оценка (сохранена|не изменилась)/}).waitFor();assert.equal(await rating().inputValue(),String(value));
}
async function clearRating() { await page.getByRole('button',{name:'Очистить оценку',exact:true}).click();await page.getByRole('status').filter({hasText:/Оценка (очищена|не изменилась)/}).waitFor();assert.equal(await rating().inputValue(),''); }
async function openMovie(title) { await page.getByRole('button',{name:`Подробнее: ${title}`,exact:true}).click();await page.getByRole('dialog').waitFor(); }
async function configureOpen() { await page.getByRole('button',{name:'Новая подборка',exact:true}).click();await page.getByRole('button',{name:'Продолжить',exact:true}).waitFor();assert.equal(await page.locator('dialog[open]').count(),1); }
async function dialogOpen() { await configureOpen();await page.getByRole('button',{name:'Продолжить',exact:true}).click();await page.getByRole('button',{name:'Да, подобрать',exact:true}).waitFor();assert.equal(await page.locator('dialog[open]').count(),1); }
async function generate(settings, expected=201) {
  control(settings);await dialogOpen();const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/recommendations/generate'&&r.request().method()==='POST');
  await page.getByRole('button',{name:'Да, подобрать',exact:true}).click();const result=await response;assert.equal(result.status(),expected);
  if(expected===201){await page.getByRole('status').filter({hasText:'Новая подборка сохранена.'}).waitFor();await page.locator('.gallery-card').first().waitFor();}
  else await alerts().filter({hasText:/Не удалось|Нет подходящих|Подбор|Финальный|Время ожидания/}).first().waitFor();
  return result.json();
}
try {
  execFileSync(process.execPath,['--import','tsx',join(root,'scripts/fixtures/phase4-prepare.ts'),metadata],{cwd:root,stdio:'pipe'});
  fixture=JSON.parse(readFileSync(metadata,'utf8'));control({});writeFileSync(callsPath,'',{mode:0o600});await start();console.log(`QA production: ${base}; evidence: ${output}`);
  browser=await playwright.chromium.launch({channel:'chrome',headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:1000}});page=await context.newPage();
  page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error'){if(/Failed to load resource|net::ERR_/.test(message.text()))expectedNetworkErrors.push(message.text());else errors.push(message.text());}});
  const reads=[];page.on('request',request=>{if(request.method()==='GET'&&request.url().startsWith(base+'/api/'))reads.push(request.url());});
  const posts=[];page.on('request',request=>{if(request.method()==='POST'&&request.url().includes('/api/recommendations/generate'))posts.push(JSON.parse(request.postData()));});
  await go('/');await chooseIlya(page);assert.match(await page.title(),/recommendMe/);assert.equal(new URL(page.url()).origin,base);assert.equal(openaiCalls(),0);await screenshot('recommendations-empty');
  const pairs=await page.evaluate(()=>{const s=getComputedStyle(document.documentElement),b=getComputedStyle(document.querySelector('.button-primary'));
    return [[s.getPropertyValue('--color-text'),s.getPropertyValue('--color-bg')],[s.getPropertyValue('--color-muted'),s.getPropertyValue('--color-bg')],[s.getPropertyValue('--color-muted'),s.getPropertyValue('--color-surface')],[b.color,b.backgroundColor]];});
  const ratios=pairs.map(pair=>Number(contrast(...pair).toFixed(2)));assert.ok(ratios.every(ratio=>ratio>=4.5));measurements.push({kind:'text_contrast',ratios,threshold:4.5});
  assert.equal(await page.getByRole('link',{name:'Рекомендации',exact:true}).getAttribute('aria-current'),'page');

  await dialogOpen();await screenshot('generation-confirmation');
  assert.ok(await page.evaluate(()=>Boolean(document.activeElement.closest('dialog'))));
  for(const key of ['Tab','Tab','Shift+Tab']){await page.keyboard.press(key);const focus=await page.evaluate(()=>({inside:Boolean(document.activeElement.closest('dialog')),tag:document.activeElement.tagName,text:document.activeElement.textContent?.slice(0,50)}));assert.ok(focus.inside,JSON.stringify({key,...focus}));}
  await page.keyboard.press('Escape');assert.equal(await page.getByRole('dialog').isVisible(),false);assert.match(await page.evaluate(()=>document.activeElement.textContent),/Новая подборка/);assert.equal(openaiCalls(),0);check('empty → confirmation/Escape/focus restore: zero provider calls');
  for(const mood of ['Лёгкое и душевное','Хочу посмеяться','Что-то выдающееся','Есть над чем подумать','Чтобы захватило','Удиви меня']) {
    await configureOpen();await page.getByRole('radio',{name:new RegExp(mood)}).check();await page.getByRole('button',{name:'Продолжить',exact:true}).click();await page.getByRole('dialog').getByText(mood,{exact:false}).waitFor();await page.keyboard.press('Escape');
  }
  assert.equal(openaiCalls(),0);await configureOpen();await page.getByRole('radio',{name:/Хочу посмеяться/}).check();await page.getByRole('radio',{name:'До 2 часов',exact:true}).check();
  await page.getByRole('checkbox',{name:'Ужасов',exact:true}).check();await page.getByRole('button',{name:'Продолжить',exact:true}).click();await page.locator('.confirmation-wishes').filter({hasText:/Хочу посмеяться.*До 2 часов.*Без ужасов/}).waitFor();
  await page.getByRole('button',{name:'Назад',exact:true}).click();assert.ok(await page.getByRole('radio',{name:/Хочу посмеяться/}).isChecked());assert.ok(await page.getByRole('checkbox',{name:'Ужасов',exact:true}).isChecked());
  await page.keyboard.press('Escape');await configureOpen();assert.ok(await page.getByRole('radio',{name:'До 2 часов',exact:true}).isChecked());await page.getByRole('radio',{name:'Любая',exact:true}).check();await page.getByRole('checkbox',{name:'Ужасов',exact:true}).uncheck();
  await page.setViewportSize({width:375,height:600});assert.ok(await page.locator('.selection-dialog-content').evaluate(el=>el.scrollHeight>el.clientHeight));assert.ok((await page.getByRole('button',{name:'Продолжить',exact:true}).boundingBox()).y>=0);assert.ok(await page.getByRole('button',{name:'Продолжить',exact:true}).evaluate(el=>el.getBoundingClientRect().bottom<=innerHeight));
  for(const key of ['Tab','Shift+Tab','Shift+Tab','Tab']){await page.keyboard.press(key);assert.ok(await page.evaluate(()=>Boolean(document.activeElement.closest('.new-selection-dialog'))));}
  await page.setViewportSize({width:1440,height:900});await screenshot('new-selection-desktop');await page.keyboard.press('Escape');
  for(const width of [375,430]){await page.setViewportSize({width,height:932});await configureOpen();await screenshot(`new-selection-${width}`);await page.keyboard.press('Escape');}
  await page.setViewportSize({width:1440,height:900});assert.equal(openaiCalls(),0);check('two-step dialog: all moods free, draft/Back/Escape persist, low-screen scroll/sticky action/focus, no nested dialogs');
  await configureOpen();const idle=await state();await page.route('**/api/recommendations',route=>fulfill(route,{json:{...idle,generation:{...idle.generation,state:'running',recoverable_save:false}}}));await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await until(async()=>await page.getByRole('button',{name:'Продолжить',exact:true}).isDisabled(),'remote generation disables open form');assert.ok(await page.getByRole('radio',{name:/Хочу посмеяться/}).isDisabled());await page.keyboard.press('Escape');await page.unrouteAll({behavior:'wait'});await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await until(async()=>await page.getByRole('button',{name:'Новая подборка',exact:true}).isEnabled(),'remote generation state clears');assert.equal(openaiCalls(),0);check('generation on another device disables open settings without a paid retry');
  control({delay:1000});await dialogOpen();await page.getByRole('button',{name:'Да, подобрать',exact:true}).dblclick();
  await page.locator('.selection-loading').waitFor();const firstRequest=posts.at(-1);assert.ok(firstRequest?.request_id);
  const duplicate=await http.post(base+'/api/recommendations/generate',{data:firstRequest});assert.equal(duplicate.status(),409);
  await page.reload();await until(async()=> (await state()).generation.state==='saved','generation survives reload');await page.locator('.gallery-card').first().waitFor();
  assert.equal(openaiCalls(),2);let first=await state();assert.equal(first.batch.movies.length,5);const firstId=first.batch.result_id;
  assert.equal(first.batch.preferences.mood,'funny');assert.equal(first.batch.preferences.max_runtime,null);
  await configureOpen();assert.ok(await page.getByRole('radio',{name:/Удиви меня/}).isChecked());await page.getByRole('radio',{name:/Лёгкое и душевное/}).check();await page.keyboard.press('Escape');assert.match(await page.locator('.home-batch-label').innerText(),/Хочу посмеяться/);assert.equal(openaiCalls(),2);
  for(const width of [375,430,768,1024,1440]) {await page.setViewportSize({width,height:width>=768?900:812});await page.evaluate(()=>document.fonts.ready);await page.evaluate(()=>scrollTo(0,0));assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.equal(await page.locator('.gallery-card').count(),5);
    const cards=await page.locator('.gallery-card').evaluateAll(els=>els.map(el=>({x:el.getBoundingClientRect().x,y:el.getBoundingClientRect().y,bottom:el.getBoundingClientRect().bottom,width:el.getBoundingClientRect().width})));
    const columns=width>=1280?5:width>=768?3:2;assert.equal(cards.filter(c=>Math.abs(c.y-cards[0].y)<1).length,columns);
    measurements.push({kind:'home_gallery',width,columns,card_width:cards[0].width,first_row_bottom:Math.max(...cards.slice(0,columns).map(c=>c.bottom))});
    if(width===1440){assert.ok(cards.every(c=>Math.abs(c.y-cards[0].y)<1));assert.ok(cards.every(c=>c.bottom<=900));}
    if(width<768){const nav=await page.locator('.navigation').boundingBox();assert.ok(cards.slice(0,2).every(c=>c.bottom<=nav.y),'first row fully visible above navigation');}
    assert.equal(await page.locator('.gallery-card button').count(),5);assert.equal(await page.locator('.gallery-excerpt').count(),0);assert.equal(await page.locator('.favorite-card').count(),4);await screenshot(`home-5-${width}`,true);}
  for(const [width,columns] of [[320,1],[1280,5]]){await page.setViewportSize({width,height:900});assert.equal(await page.locator('.recommendation-grid').evaluate(el=>getComputedStyle(el).gridTemplateColumns.split(' ').length),columns);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}
  await page.setViewportSize({width:1440,height:1000});
  await openMovie(first.batch.movies[0].title);const originalText=first.batch.movies[0].why_fit;assert.equal(await page.locator('.movie-explanation section').first().locator('p').innerText(),originalText);
  for(const key of ['Tab','Tab','Tab','Tab','Shift+Tab']) {await page.keyboard.press(key);assert.ok(await page.evaluate(()=>Boolean(document.activeElement.closest('.movie-explanation'))));}
  await page.keyboard.press('Escape');assert.match(await page.evaluate(()=>document.activeElement.getAttribute('aria-label')),/Подробнее/);
  for (const movie of first.batch.movies) {
    assert.match(movie.title, /[А-Яа-яЁё]/u); assert.match(movie.why_fit, /[А-Яа-яЁё]/u); assert.match(movie.possible_mismatch, /[А-Яа-яЁё]/u);
    await openMovie(movie.title);
    assert.ok((await page.locator('.movie-explanation').innerText()).includes(movie.why_fit));
    assert.ok((await page.locator('.movie-explanation').innerText()).includes(movie.possible_mismatch));
    await page.keyboard.press('Escape');
  }
  check('all five cards render Russian TMDB titles, full explanations and risks from persistent cache');
  for(const width of [375,430]) {await page.setViewportSize({width,height:1000});await openMovie(first.batch.movies[0].title);assert.ok(await page.locator('.movie-explanation').evaluate(el=>el.scrollWidth<=el.clientWidth));await screenshot(`home-details-${width}`);await page.keyboard.press('Escape');assert.match(await page.evaluate(()=>document.activeElement.getAttribute('aria-label')),/Подробнее/);}
  await page.setViewportSize({width:1440,height:1000});
  check('gallery5 all widths, saved wishes distinct from draft, full explanations, modal Escape/focus');
  await screenshot('recommendations-desktop');
  const mobileCapture=await browser.newContext({viewport:{width:375,height:1000}}),mobilePage=await mobileCapture.newPage();
  await mobilePage.goto(base+'/');await chooseIlya(mobilePage);await mobilePage.evaluate(()=>document.fonts.ready);await mobilePage.screenshot({path:join(output,'recommendations-mobile.png')});await mobileCapture.close();await openMovie(first.batch.movies[1].title);await page.keyboard.press('Escape');assert.equal(openaiCalls(),2);
  const replay=await http.post(base+'/api/recommendations/generate',{data:firstRequest});assert.equal(replay.status(),200);assert.equal(openaiCalls(),2);check('two mocked OpenAI stages; double click/concurrent POST/reload/replay never pay again');
  const rejection=first.batch.movies[4];await openMovie(rejection.title);await page.getByRole('button',{name:'Неинтересно',exact:true}).click();
  await until(async()=> (await state()).batch.movies.length===4,'rejection removes active film');
  database(db=>{const row=db.prepare("SELECT watched,rating_100,not_interested FROM user_movies WHERE user_id='ilya' AND movie_id=?").get(rejection.movie_id);assert.deepEqual(row,{watched:0,rating_100:null,not_interested:1});});
  await page.getByRole('button',{name:'Отменить',exact:true}).click();await until(async()=> (await state()).batch.movies.length===5,'undo restores active film');
  database(db=>assert.equal(db.prepare("SELECT rejected FROM recommendations WHERE user_id='ilya' AND movie_id=?").get(rejection.movie_id).rejected,1));assert.equal(openaiCalls(),2);check('reject/undo keeps rating/view/history and does not generate');
  const watched=[];
  for(const [index,value] of [[0,90],[1,null],[2,0]]) {
    const movie=first.batch.movies[index];await go('/');await openMovie(movie.title);await page.getByRole('button',{name:'Посмотрел',exact:true}).click();
    await page.waitForURL(base+`/rate?movie_id=${movie.movie_id}`);await rating().waitFor();
    database(db=>assert.equal(db.prepare("SELECT watched FROM user_movies WHERE user_id='ilya' AND movie_id=?").get(movie.movie_id)?.watched??0,0));
    if(value!==null)await rating().fill(String(value));else assert.equal(await rating().inputValue(),'');
    if(index>0)await page.getByRole('textbox',{name:'Впечатления о фильме',exact:false}).fill(`Review with ${value===null?'NULL':'zero'} rating`);
    const beforeCount=database(db=>db.prepare("SELECT count(*) n FROM user_movies WHERE user_id='ilya' AND rating_100 IS NOT NULL").get().n);
    await page.getByRole('button',{name:'Подтвердить просмотр',exact:true}).click();await page.getByRole('status').filter({hasText:'Просмотр сохранён.'}).waitFor();
    database(db=>{assert.equal(db.prepare("SELECT watched FROM user_movies WHERE user_id='ilya' AND movie_id=?").get(movie.movie_id).watched,1);assert.equal(db.prepare("SELECT rating_100 FROM user_movies WHERE user_id='ilya' AND movie_id=?").get(movie.movie_id).rating_100,value);assert.equal(db.prepare("SELECT count(*) n FROM user_movies WHERE user_id='ilya' AND rating_100 IS NOT NULL").get().n,beforeCount+(value===null?0:1));});
    if(index>0)database(db=>assert.equal(db.prepare("SELECT review_text FROM user_movies WHERE user_id='ilya' AND movie_id=?").get(movie.movie_id).review_text,`Review with ${value===null?'NULL':'zero'} rating`));
    watched.push(movie);await page.getByRole('link',{name:'Вернуться к рекомендациям →',exact:true}).click();await page.waitForURL(base+'/');await until(async()=>!(await state()).batch.movies.some(row=>row.movie_id===movie.movie_id),'watched removed');
  }
  await go('/');assert.equal(await page.locator('.gallery-card').count(),2);await screenshot('home-2-1440',true);await page.setViewportSize({width:375,height:1000});await screenshot('home-2-375',true);await page.setViewportSize({width:1440,height:1000});
  assert.equal(openaiCalls(),2);check('recommendations → rate deep link → watched 90 / NULL / real 0 → active exclusions');
  await go(`/library?movie_id=${watched[0].movie_id}`);await rating().waitFor();await saveRating(40);await clearRating();
  await go('/library?movie_id=1');await rating().waitFor();await saveRating(90);await saveRating(40);await clearRating();
  check('library 90→40→NULL; snapshot rating cleared separately from a newly added/cleared rating');
  const readStart=reads.length;await go('/library');await libraryReady();assert.equal(await page.locator('.library-grid>li').count(),25);
  const initialReads=reads.slice(readStart);assert.equal(initialReads.filter(url=>new URL(url).pathname==='/api/library').length,2);assert.equal(initialReads.filter(url=>/\/api\/library\/\d+/.test(url)).length,0);
  measurements.push({kind:'library',initial_list_reads:2,detail_reads:0,page_size:25});await screenshot('library-desktop');
  const all=await (await http.get(base+'/api/library?limit=25')).json();const ids=new Set();for(let i=1;i<=all.total_pages;i++){const data=await(await http.get(base+`/api/library?page=${i}&limit=25`)).json();for(const item of data.items){assert.ok(!ids.has(item.movie_id));ids.add(item.movie_id);}}assert.equal(ids.size,all.total);
  await page.getByRole('textbox',{name:'Название фильма',exact:true}).fill('FAVOURITE');await page.getByRole('button',{name:'Найти',exact:true}).click();await page.waitForURL(/q=FAVOURITE/);await libraryReady();assert.equal(await page.locator('.library-card').count(),1);await page.getByRole('button',{name:'Очистить поиск',exact:true}).click();await until(()=>new URL(page.url()).searchParams.get('q')===null,'cleared local query');await libraryReady();
  await page.getByRole('textbox',{name:'Название фильма',exact:true}).fill('Кинокадр');await page.getByRole('button',{name:'Найти',exact:true}).click();await page.waitForURL(/q=/);await libraryReady();
  for(const sort of ['rating_asc','rating_desc','added_asc','added_desc']){await page.getByRole('combobox').selectOption(sort);await until(async()=>new URL(page.url()).searchParams.get('sort')===(sort==='added_desc'?null:sort),'sort URL');await libraryReady();}
  await page.getByRole('button',{name:'Без оценки',exact:true}).click();await page.waitForURL(/rated=false/);await libraryReady();await page.reload();await libraryReady();assert.match(page.url(),/rated=false/);
  await page.goBack();await page.goForward();await libraryReady();check('all records accessible by 25-item pages; Cyrillic search, four sorts, filters, URL/reload/Back/Forward');
  await go('/library?q=Кинокадр&sort=rating_desc&page=8');await libraryReady();
  await page.locator('.library-card').first().click();await rating().waitFor();await saveRating(100);
  await page.getByRole('button',{name:'← К моей библиотеке'}).click();await libraryReady();assert.equal(new URL(page.url()).searchParams.get('page'),'8');assert.equal(new URL(page.url()).searchParams.get('sort'),'rating_desc');
  const storedY=await page.evaluate(()=>JSON.parse(Object.entries(sessionStorage).find(([key])=>key.endsWith('page=8'))[1]).y);await until(async()=>Math.abs((await page.evaluate(()=>scrollY))-storedY)<5,'restored collection scroll');check('page 8/sort/search and actual saved scroll survive moving a rated film');
  let tail=await(await http.get(base+'/api/library?rated=false&limit=25')).json();const lastPage=tail.total_pages;
  tail=await(await http.get(base+`/api/library?rated=false&limit=25&page=${lastPage}`)).json();
  for(const film of tail.items.slice(0,-1))await http.patch(base+`/api/library/${film.movie_id}/rating`,{data:{rating_100:30}});
  await go(`/library?rated=false&page=${lastPage}`);await libraryReady();await page.locator('.library-card').first().click();await rating().waitFor();await saveRating(85);await page.getByRole('button',{name:'← К моей библиотеке'}).click();await libraryReady();assert.equal(new URL(page.url()).searchParams.get('page'),String(lastPage-1));check('rating removes last filtered page and corrects URL without dropping filters');
  await go('/library');await libraryReady();let releasePage,pageRequested=false;const pageGate=new Promise(resolve=>{releasePage=resolve;});
  await page.route('**/api/library?*',async route=>{if(new URL(route.request().url()).searchParams.get('page')==='2'){pageRequested=true;await pageGate;}await route.continue();});
  await page.getByRole('button',{name:'Далее',exact:true}).click();await until(()=>pageRequested,'delayed page request');await page.getByRole('button',{name:'С оценкой',exact:true}).click();await page.waitForURL(/rated=true/);await libraryReady();releasePage();await page.unrouteAll({behavior:'wait'});assert.equal(new URL(page.url()).searchParams.get('page'),null);assert.ok(!(await page.locator('.library-grid').innerText()).includes('Без оценки'));check('delayed page cannot overwrite a newer filter');
  // Error recovery after a real successful PATCH. Only the following GET is interrupted.
  await go(`/library?movie_id=${watched[0].movie_id}`);await rating().waitFor();let interrupt=false;
  await page.route(`**/api/library/${watched[0].movie_id}/rating`,async route=>{interrupt=true;await route.continue();});
  await page.route(`**/api/library/${watched[0].movie_id}`,async route=>{if(interrupt){interrupt=false;await route.abort('failed');}else await route.continue();});
  await rating().fill('85');await page.getByRole('button',{name:'Сохранить оценку',exact:true}).click();await alerts().filter({hasText:'Операция выполнена'}).waitFor();
  await page.unrouteAll({behavior:'wait'});await page.getByRole('button',{name:'Перечитать фильм'}).click();await until(async()=>await rating().inputValue()==='85','GET-only write recovery');check('successful PATCH + lost GET → explicit read recovery, saved 85 retained');
  // A reused detail controller must gate editing while a fresh read is pending.
  await page.getByRole('button',{name:'← К моей библиотеке'}).click();await libraryReady();
  await http.patch(base+`/api/library/${watched[0].movie_id}/rating`,{data:{rating_100:21}});
  let releaseDetail, detailRequested=false;const detailGate=new Promise(resolve=>{releaseDetail=resolve;});
  await page.route(`**/api/library/${watched[0].movie_id}`,async route=>{detailRequested=true;await detailGate;await route.continue();});
  await page.locator(`#library-movie-${watched[0].movie_id}`).click();await until(()=>detailRequested,'fresh detail request');
  const staleEditor=await page.getByRole('button',{name:'Сохранить оценку',exact:true}).isVisible();releaseDetail();await page.unrouteAll({behavior:'wait'});
  assert.equal(staleEditor,false,'Reopening the same movie must not expose an editable stale rating before GET completes');
  await until(async()=>await rating().inputValue()==='21','fresh grade after reopening');check('same-film return gates stale editor until fresh GET completes');
  await page.route(`**/api/library/${watched[0].movie_id}/rating`,route=>fulfill(route,{status:500,json:{error:'library_unavailable'}}));
  await rating().fill('55');await page.getByRole('button',{name:'Сохранить оценку',exact:true}).click();await alerts().first().waitFor();assert.equal(await rating().inputValue(),'55');database(db=>assert.equal(db.prepare("SELECT rating_100 FROM user_movies WHERE user_id='ilya' AND movie_id=?").get(watched[0].movie_id).rating_100,21));
  await page.unrouteAll({behavior:'wait'});await saveRating(85);check('failed rating preserves draft/server value and explicit retry succeeds');

  await go('/');const oldBatch=(await state()).batch.result_id;const paidBeforeFailure=openaiCalls();await generate({round:2,mode:'openai_error'},502);assert.equal(openaiCalls(),paidBeforeFailure+1);assert.equal((await state()).batch.result_id,oldBatch);await screenshot('generation-error');
  await page.getByRole('button',{name:'Проверить состояние'}).click();await until(async()=>await page.getByRole('button',{name:'Новая подборка',exact:true}).isEnabled(),'failed generation ready for explicit action');
  for(const mode of ['invalid','refusal','incomplete','no_candidates']){const n=openaiCalls();await generate({round:2,mode},mode==='no_candidates'?422:502);assert.equal(openaiCalls(),n+1);assert.equal((await state()).batch.result_id,oldBatch);await page.getByRole('button',{name:'Проверить состояние'}).click();}
  check('provider error, malformed/refused output and no candidates preserve previous batch without automatic retry');
  control({round:2,delay:600});const beforeNew=openaiCalls();await dialogOpen();const secondResponse=page.waitForResponse(r=>r.url()===base+'/api/recommendations/generate'&&r.request().method()==='POST');await page.getByRole('button',{name:'Да, подобрать'}).click();await page.locator('.selection-loading').waitFor();assert.ok(await page.locator('.recommendation-grid').isVisible());assert.equal((await secondResponse).status(),201);await page.getByRole('status').filter({hasText:'Новая подборка сохранена.'}).waitFor();assert.equal(openaiCalls(),beforeNew+2);
  const second=(await state()).batch;assert.notEqual(second.result_id,firstId);database(db=>assert.equal(db.prepare("SELECT count(*) n FROM recommendations WHERE user_id='ilya' AND result_id=?").get(firstId).n,5));check('second saved batch preserves first history and keeps previous screen during loading');
  // Fail only the final transaction, after providers and durable preparation succeeded.
  database(db=>db.exec("CREATE TRIGGER qa_fail_save BEFORE INSERT ON recommendations BEGIN SELECT RAISE(ABORT,'qa save failure'); END"));const countBefore=database(db=>db.prepare('SELECT count(*) n FROM movies').get().n);
  await generate({round:3},500);await page.getByRole('button',{name:'Повторить сохранение без нового подбора'}).waitFor();database(db=>{assert.equal(db.prepare('SELECT count(*) n FROM movies').get().n,countBefore);db.exec('DROP TRIGGER qa_fail_save');});
  const paidBeforeRecovery=openaiCalls();await page.getByRole('button',{name:'Повторить сохранение без нового подбора'}).click();await page.getByRole('status').filter({hasText:'Подборка сохранена. Новых запросов к модели не было.'}).waitFor();assert.equal(openaiCalls(),paidBeforeRecovery);assert.equal((await state()).batch.movies.length,5);check('SQL rollback + durable save_only=1 recovery without OpenAI/TMDB');
  // A backup path failure must happen before payment and leave the current batch untouched.
  const backups=join(fixture.dir,'backups'), held=join(fixture.dir,'backups-held');if(existsSync(backups))renameSync(backups,held);writeFileSync(backups,'qa blocks backup directory');
  const noPayment=openaiCalls(), stableBatch=(await state()).batch.result_id;
  try { await generate({round:4},500);assert.equal(openaiCalls(),noPayment);assert.equal((await state()).batch.result_id,stableBatch); }
  finally {rmSync(backups);if(existsSync(held))renameSync(held,backups);}
  await page.getByRole('button',{name:'Проверить состояние'}).click();check('backup failure stops before payment');
  // Browser timeout presentation; the real deadline/lock is exercised separately by node:test.
  await page.route('**/api/recommendations/generate',route=>fulfill(route,{status:504,json:{error:'generation_timeout',message:'Время ожидания подбора истекло. Автоматического повтора нет.'}}));
  const beforeTimeout=openaiCalls();await generate({round:4},504);assert.equal(openaiCalls(),beforeTimeout);await page.unrouteAll({behavior:'wait'});await page.getByRole('button',{name:'Проверить состояние'}).click();check('timeout UI preserves batch; no hidden retry (HTTP simulation; deadline covered by service test)');
  // Explicit catalog/search cases use the actual API and mock provider.
  await go('/rate');const query=page.getByPlaceholder('Какой фильм вы посмотрели?');
  await query.fill('variants');await page.getByRole('spinbutton',{name:'Год необязательно'}).fill('2020');await page.getByRole('button',{name:'Найти фильм',exact:true}).click();await page.locator('#rate-result-990002').waitFor();assert.equal(await page.locator('.rate-result').count(),1);
  await query.fill('variants');await page.getByRole('spinbutton',{name:'Год необязательно'}).fill('');await page.getByRole('button',{name:'Найти фильм',exact:true}).click();await page.locator('#rate-result-990001').waitFor();assert.equal(await page.locator('.rate-result').count(),2);
  await query.fill('duplicate');await page.getByRole('button',{name:'Найти фильм',exact:true}).click();await page.locator('#rate-result-990004').click();await page.locator('.rate-duplicates').waitFor();assert.match(await page.locator('.rate-duplicates').innerText(),/Legacy Duplicate/);
  await query.fill('empty');await page.getByRole('button',{name:'Найти фильм',exact:true}).click();await page.getByRole('heading',{name:'Фильм не найден',exact:true}).waitFor();
  await query.fill('error');await page.getByRole('button',{name:'Найти фильм',exact:true}).click();await alerts().first().waitFor();
  await query.fill('extra');await page.getByRole('button',{name:'Найти фильм',exact:true}).click();await page.locator('#rate-result-990003').click();await rating().waitFor();
  await rating().fill('100');await page.getByRole('button',{name:'Подтвердить просмотр',exact:true}).click();await page.getByRole('status').filter({hasText:'Просмотр сохранён.'}).waitFor();
  const savedExtra=database(db=>db.prepare("SELECT m.id,u.updated_at FROM movies m JOIN user_movies u ON u.movie_id=m.id AND u.user_id='ilya' WHERE tmdb_id=990003").get());
  await saveRating(100);database(db=>assert.equal(db.prepare("SELECT updated_at FROM user_movies WHERE user_id='ilya' AND movie_id=?").get(savedExtra.id).updated_at,savedExtra.updated_at));
  await screenshot('rate-desktop');check('title/year/versions, empty/error TMDB, possible_duplicate, watch 100 and unchanged timestamps');
  // Ten final differences from the snapshot: no automatic profile generation.
  database(db=>{for(let id=4;id<14;id++)db.prepare("UPDATE user_movies SET rating_100=100,rating_source='manual' WHERE user_id='ilya' AND movie_id=?").run(id);});
  const countAtRefresh=openaiCalls();assert.equal((await state()).readiness.profile_refresh.status,'refresh_recommended');await go('/');await page.getByText('О подборке',{exact:true}).click();await page.getByText('Профиль вкуса стоит обновить.',{exact:false}).waitFor();assert.equal(openaiCalls(),countAtRefresh);check('ten rating differences recommend refresh without regenerating profile');
  database(db=>{
    assert.deepEqual(db.prepare('SELECT * FROM taste_profile').get(),fixture.profile);assert.deepEqual(db.prepare('SELECT * FROM movies WHERE id=1').get(),fixture.importedMovie);
    const row=db.prepare("SELECT * FROM user_movies WHERE user_id='ilya' AND movie_id=1").get();for(const key of ['watched','watched_at','original_rating_stars','letterboxd_date','letterboxd_rating_date','not_interested','created_at'])assert.equal(row[key],fixture.imported[key],key);
    assert.equal(db.pragma('integrity_check',{simple:true}),'ok');assert.deepEqual(db.pragma('foreign_key_check'),[]);
  });check('synthetic Letterboxd/profile/history preserved; SQLite integrity/FK pass');
  // Same app and stored rows, at each width; no stateful production fixtures.
  for(const width of [375,430,768,1024,1440]){
    await page.setViewportSize({width,height:1000});await page.emulateMedia({reducedMotion:'reduce'});
    await go('/');await page.locator('.gallery-card').first().waitFor();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    if(width===375)await screenshot('recommendations-mobile-missing-images');
    await go(`/rate?movie_id=${watched[0].movie_id}`);await rating().waitFor();await page.getByRole('slider').focus();await page.keyboard.press('Home');assert.equal(await rating().inputValue(),'0');await page.keyboard.press('End');assert.equal(await rating().inputValue(),'100');await page.keyboard.press('ArrowLeft');assert.equal(await rating().inputValue(),'99');
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));if(width===375)await screenshot('rate-mobile');
    await go('/library');await libraryReady();assert.equal(await page.locator('.library-grid>li').count(),25);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    if(width===375)await screenshot('library-mobile');
    await go('/library?movie_id=11');await rating().waitFor();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));if(width===375)await screenshot('library-details-mobile');
    measurements.push({width,overflow:false,keyboard_slider:true,reduced_motion:true});
  }
  await page.setViewportSize({width:375,height:932});await go('/library?movie_id=11');await rating().waitFor();
  await page.addStyleTag({content:'.library-editor .editor-film h2 {font-size:38px} .editor-overview p {font-size:22px} .field-help {font-size:18px}'});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));check('enlarged long-title/detail text stays readable without horizontal overflow');
  const touch=await browser.newContext({viewport:{width:430,height:932},isMobile:true,hasTouch:true});const phone=await touch.newPage();
  await phone.goto(base+`/library?movie_id=${watched[0].movie_id}`);await chooseIlya(phone);await phone.goto(base+`/library?movie_id=${watched[0].movie_id}`);const slider=phone.getByRole('slider');await slider.waitFor();const box=await slider.boundingBox();await phone.touchscreen.tap(box.x+box.width*.5,box.y+box.height/2);assert.ok(Number(await phone.getByRole('spinbutton',{name:'Точное число'}).inputValue())>=45);await touch.close();check('five widths, long title/no poster, keyboard slider, reduced motion and touch draft');
  await page.route('**/api/library?*',route=>fulfill(route,{json:{items:[],total:0,page:1,limit:25,total_pages:0}}));await go('/library');await libraryReady();await page.getByRole('heading',{name:'Здесь будет ваша история кино',exact:true}).waitFor();await screenshot('library-empty');await page.unrouteAll({behavior:'wait'});check('empty library UI offers rating navigation (read-response simulation)');
  // Review regression: explicit writes, independent drafts and persistence on desktop/mobile.
  const reviewCallsBefore=openaiCalls();
  for(const width of [1440,375]) {
    await page.setViewportSize({width,height:1000});await go(`/library?movie_id=${watched[0].movie_id}`);await rating().waitFor();
    const review=page.getByRole('textbox',{name:'Впечатления о фильме',exact:false});
    const save=page.getByRole('button',{name:'Сохранить впечатления',exact:true});
    const text=`  Атмосфера и герои понравились.\nМедленный темп здесь иногда мешал. ${width} 🎬  `;
    await review.fill(text);await review.press('Enter');await review.fill(text);
    database(db=>assert.equal(db.prepare("SELECT review_text FROM user_movies WHERE user_id='ilya' AND movie_id=?").get(watched[0].movie_id).review_text,null));
    await save.click();await page.getByRole('status').filter({hasText:'Впечатления сохранены.'}).waitFor();
    assert.equal(await review.inputValue(),text);assert.equal(await rating().inputValue(),'85');
    await page.reload();await review.waitFor();assert.equal(await review.inputValue(),text);
    await review.fill(text+'Черновик');await saveRating(86);assert.equal(await review.inputValue(),text+'Черновик');
    database(db=>assert.equal(db.prepare("SELECT review_text FROM user_movies WHERE user_id='ilya' AND movie_id=?").get(watched[0].movie_id).review_text,text));
    await page.route(`**/api/library/${watched[0].movie_id}/review`,route=>fulfill(route,{status:500,json:{error:'review_unavailable'}}));
    await save.click();await alerts().first().waitFor();assert.equal(await review.inputValue(),text+'Черновик');
    await page.unrouteAll({behavior:'wait'});await save.click();await page.getByRole('status').filter({hasText:'Впечатления сохранены.'}).waitFor();
    assert.equal(await rating().inputValue(),'86');
    await review.scrollIntoViewIfNeeded();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    assert.equal(await page.locator('nextjs-portal').count(),0);
    await screenshot(width===1440?'review-desktop':'review-mobile');
    await review.fill('');await save.click();await page.getByRole('status').filter({hasText:'Впечатления удалены.'}).waitFor();
    await page.reload();await review.waitFor();assert.equal(await review.inputValue(),'');assert.equal(await rating().inputValue(),'86');
    await saveRating(85);
  }
  assert.equal(openaiCalls(),reviewCallsBefore);check('reviews desktop/mobile: explicit CRUD/reload, rating independence, API failure retains draft; zero AI calls');
  const beforeRestart=openaiCalls(), resultId=(await state()).batch.result_id;await stop();await start();await go('/');await page.locator('.gallery-card').first().waitFor();assert.equal((await state()).batch.result_id,resultId);assert.equal(openaiCalls(),beforeRestart);
  const preview=await http.get(base+'/preview/recommendations');const previewBody=await preview.text();assert.ok(preview.status()===404||(preview.status()===200&&previewBody.includes('404')&&!previewBody.includes('DemoRecommendations')), 'Production preview must render the not-found boundary');
  for(const path of ['/api/health','/api/library','/api/library/1','/api/recommendations']){const r=await http.get(base+path);assert.equal(r.status(),200);assert.equal(r.headers()['cache-control'],'no-store');}
  const bad=await http.patch(base+'/api/library/1/rating',{headers:{Origin:'null'},data:{rating_100:1}});assert.equal(bad.status(),403);assert.equal(database(db=>db.prepare("SELECT rating_100 FROM user_movies WHERE user_id='ilya' AND movie_id=1").get().rating_100),null);
  assert.equal((await http.get(base+'/api/library?year=bad')).status(),400);check('production restart, saved batch, no payment, Origin/no-store/invalid parameters/preview 404');
  await page.setViewportSize({width:1440,height:1000});await go('/');
  const homeState=await state(), freeBefore=openaiCalls();
  assert.ok(homeState.home.favorites.length>0);const favorite=homeState.home.favorites[0];await page.locator('.favorite-card').first().click();await page.waitForURL(base+`/library?movie_id=${favorite.movie_id}`);await rating().waitFor();await go('/');
  await openMovie(homeState.batch.movies[0].title);await page.route('**/api/recommendations/reject',route=>fulfill(route,{status:500,json:{error:'synthetic_failure'}}));await page.getByRole('button',{name:'Неинтересно',exact:true}).click();await page.locator('.movie-explanation [role="alert"]').waitFor();assert.equal(await page.locator('.gallery-card').count(),5);await page.unrouteAll({behavior:'wait'});await page.keyboard.press('Escape');
  check('favorites deep link; failed rejection retains modal/card and shows error');
  const galleryWidths=new Map();for(const width of [375,430,1440]){await page.setViewportSize({width,height:1000});galleryWidths.set(width,(await page.locator('.gallery-card').first().boundingBox()).width);}
  for(const movie of homeState.batch.movies) {
    await openMovie(movie.title);await page.getByRole('button',{name:'Неинтересно',exact:true}).click();await until(async()=>!(await state()).batch.movies.some(m=>m.tmdb_id===movie.tmdb_id),'gallery rejection persisted');await until(async()=>await page.locator('.gallery-card').count()===(await state()).batch.movies.length,'gallery compacted');
    const n=(await state()).batch.movies.length;if(n>0){for(const width of [375,430,1440]){await page.setViewportSize({width,height:1000});assert.ok(Math.abs((await page.locator('.gallery-card').first().boundingBox()).width-galleryWidths.get(width))<1,'remaining cards retain their width');}}if([4,3,2,1,0].includes(n)){
      for(const width of [375,430,1440]){await page.setViewportSize({width,height:1000});await screenshot(`home-${n}-${width}`,true);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}
    }
  }
  await page.getByRole('heading',{name:'Эту подборку ты уже разобрал',exact:true}).waitFor();assert.ok(await page.getByRole('heading',{name:'Из любимого',exact:true}).isVisible());assert.equal(await page.locator('.gallery-card').count(),0);await page.getByRole('button',{name:'Отменить',exact:true}).click();await until(async()=>await page.locator('.gallery-card').count()===1,'undo restores final film');assert.equal(openaiCalls(),freeBefore);
  check('gallery5→4→3→2→1→0 compact layout, empty completion, favorites persist, undo without generation');
  const realState=await state();await page.route('**/api/recommendations',route=>fulfill(route,{json:{...realState,batch:{...realState.batch,preferences:null}}}));await go('/');await until(async()=>/Персональная подборка/.test(await page.locator('.home-batch-label').innerText()),'historical label');await page.unrouteAll({behavior:'wait'});
  await page.route('**/api/recommendations',route=>fulfill(route,{json:{...realState,batch:null,home:{favorites:[],stats:{watched:0,rated:0}}}}));await go('/');await page.getByText('Открыть библиотеку',{exact:true}).waitFor();await screenshot('home-empty-library',true);await page.unrouteAll({behavior:'wait'});assert.equal(openaiCalls(),freeBefore);
  check('historical unlabelled batch and empty home library work without new APIs');
  // Profile isolation in two tabs sharing the same cookie, with a real in-flight mocked generation.
  await page.setViewportSize({width:1440,height:1000});await go('/');
  const secondTab=await context.newPage();await secondTab.goto(base+'/');
  await secondTab.getByRole('button',{name:'Сменить профиль: Илья'}).waitFor();
  await secondTab.reload();await secondTab.getByRole('button',{name:'Сменить профиль: Илья'}).waitFor();
  const countIlya=database(db=>db.prepare("SELECT count(*) n FROM recommendations WHERE user_id='ilya'").get().n);
  control({round:7,delay:1200});const paidBefore=openaiCalls();await dialogOpen();
  const requested=page.waitForRequest(r=>r.url()===base+'/api/recommendations/generate'&&r.method()==='POST');
  await page.getByRole('button',{name:'Да, подобрать'}).click();const generationRequest=JSON.parse((await requested).postData());
  await until(()=>openaiCalls()>paidBefore,'first mocked OpenAI call begins');
  await secondTab.getByRole('button',{name:'Сменить профиль: Илья'}).click();
  await secondTab.getByRole('dialog').getByRole('button',{name:'Валерий',exact:true}).click();
  await secondTab.getByRole('button',{name:'Сменить профиль: Валерий'}).waitFor();
  await page.getByRole('button',{name:'Сменить профиль: Валерий'}).waitFor();
  await until(()=>database(db=>db.prepare("SELECT count(*) n FROM recommendations WHERE user_id='ilya'").get().n)>countIlya,'in-flight generation saved for Ilya');
  assert.equal(openaiCalls(),paidBefore+2);
  assert.equal(database(db=>db.prepare("SELECT count(*) n FROM recommendations WHERE user_id='valeriy'").get().n),0);
  assert.equal((await state()).batch,null);
  for(const suffix of ['', '?save_only=1']){const denied=await http.post(base+'/api/recommendations/generate'+suffix,{data:generationRequest});assert.equal(denied.status(),409);}
  assert.equal(openaiCalls(),paidBefore+2);
  await page.setViewportSize({width:375,height:900});await go('/library');await libraryReady();await page.getByRole('heading',{name:'Здесь будет ваша история кино',exact:true}).waitFor();
  await go(`/rate?movie_id=${watched[0].movie_id}`);await rating().waitFor();await rating().fill('0');
  await page.getByRole('textbox',{name:'Впечатления о фильме',exact:false}).fill('Впечатление Валерия');
  await page.getByRole('button',{name:'Подтвердить просмотр',exact:true}).click();await page.getByRole('status').filter({hasText:'Просмотр сохранён.'}).waitFor();
  database(db=>{const rows=db.prepare('SELECT user_id,rating_100,review_text FROM user_movies WHERE movie_id=? ORDER BY user_id').all(watched[0].movie_id);assert.equal(rows.length,2);assert.equal(rows[1].rating_100,0);assert.equal(rows[1].review_text,'Впечатление Валерия');assert.notEqual(rows[0].rating_100,0);});
  await go(`/library?movie_id=${watched[0].movie_id}`);await rating().waitFor();await page.getByRole('textbox',{name:'Впечатления о фильме',exact:false}).fill('Несохранённый черновик');
  await secondTab.getByRole('button',{name:'Сменить профиль: Валерий'}).click();await secondTab.getByRole('dialog').getByRole('button',{name:'Илья',exact:true}).click();
  await page.getByRole('button',{name:'Сменить профиль: Илья'}).waitFor();await go(`/library?movie_id=${watched[0].movie_id}`);await rating().waitFor();
  assert.notEqual(await page.getByRole('textbox',{name:'Впечатления о фильме',exact:false}).inputValue(),'Несохранённый черновик');
  // A delayed personal read from the previous profile must not repopulate the new one.
  await secondTab.getByRole('button',{name:'Сменить профиль: Илья'}).click();await secondTab.getByRole('dialog').getByRole('button',{name:'Валерий',exact:true}).click();
  await page.getByRole('button',{name:'Сменить профиль: Валерий'}).waitFor();
  let releaseLate,seenLate;const lateGate=new Promise(resolve=>releaseLate=resolve),lateSeen=new Promise(resolve=>seenLate=resolve);
  await page.route('**/api/library?*',async route=>{seenLate();await lateGate;await route.continue().catch(()=>{});});
  await page.goto(base+'/library',{waitUntil:'domcontentloaded'});await lateSeen;
  await secondTab.getByRole('button',{name:'Сменить профиль: Валерий'}).click();await secondTab.getByRole('dialog').getByRole('button',{name:'Илья',exact:true}).click();
  await page.getByRole('button',{name:'Сменить профиль: Илья'}).waitFor();releaseLate();await page.unrouteAll({behavior:'wait'});
  assert.equal((await state()).batch!==null,true);assert.equal(openaiCalls(),paidBefore+2);
  await secondTab.close();check('two tabs: remembered profile, isolated libraries/zero/reviews, discarded draft, late read, in-flight Ilya generation and foreign replay');
  // Historical feedback UI: staged synthetic import, ordinary numeric controls only.
  const historicalCalls=openaiCalls();
  database(db=>{const library=[1,2].map(id=>({id:`ui-${id}`,source_ids:[`occ-${id}`]}));const doc={library,occurrences:library.map((r,i)=>({id:r.source_ids[0],library_id:r.id,raw:i?'👎':'👍😭',external_ratings:[{raw:'9.1',source:null}]}))};
    db.prepare("INSERT INTO legacy_import_sources(user_id,source_key,sha256,document_json) VALUES('valeriy','qa-ui',?,?)").run('a'.repeat(64),JSON.stringify(doc));
    for(const id of [1,2]){db.prepare("INSERT INTO user_movies(user_id,movie_id,watched) VALUES('valeriy',?,1)").run(id);db.prepare("INSERT INTO legacy_movie_marks(user_id,source_key,source_id,movie_id,sentiment,identity_confirmed) VALUES('valeriy','qa-ui',?,?,?,1)").run(`ui-${id}`,id,id===1?'liked':'disliked');}
  });
  await page.getByRole('button',{name:'Сменить профиль: Илья'}).click();await page.getByRole('dialog').getByRole('button',{name:'Валерий',exact:true}).click();await page.getByRole('button',{name:'Сменить профиль: Валерий'}).waitFor();
  for(const [index,width] of [1440,375].entries()){
    const id=index+1;await page.setViewportSize({width,height:1000});await go(`/library?movie_id=${id}`);await rating().waitFor();
    await page.getByText('Отметка из старого списка: '+(id===1?'понравилось':'не понравилось'),{exact:true}).waitFor();
    await page.getByText('Внешний рейтинг: 9.1 · Источник неизвестен',{exact:true}).waitFor();
    assert.equal(await rating().inputValue(),'');await saveRating(0);await page.getByText(/Отметка из старого списка:.*заменена личной оценкой/).waitFor();await saveRating(75);await clearRating();await page.getByText(/Отметка из старого списка:.*заменена личной оценкой/).waitFor();
    await page.getByRole('button',{name:'Добавить в «Посмотреть»',exact:true}).click();await page.getByRole('button',{name:'Убрать из «Посмотреть»',exact:true}).waitFor();
    database(db=>{const row=db.prepare("SELECT watched,rating_100,watchlist FROM user_movies WHERE user_id='valeriy' AND movie_id=?").get(id);assert.deepEqual(row,{watched:1,rating_100:null,watchlist:1});assert.equal(db.prepare("SELECT numeric_override FROM legacy_movie_marks WHERE user_id='valeriy' AND movie_id=?").get(id).numeric_override,1);});
    await screenshot(`legacy-editor-${width}`,true);await go('/library?watchlist=true');await libraryReady();assert.equal(await page.locator('.library-grid>li').count(),1);await go(`/library?movie_id=${id}`);await rating().waitFor();await page.getByRole('button',{name:'Убрать из «Посмотреть»',exact:true}).click();await page.getByRole('button',{name:'Добавить в «Посмотреть»',exact:true}).waitFor();
    assert.equal((await(await http.get(base+'/api/library?watchlist=true')).json()).total,0);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  }
  await go('/rate?movie_id=3');await rating().waitFor();await page.getByRole('button',{name:'Добавить в «Посмотреть»',exact:true}).click();await page.getByRole('button',{name:'Убрать из «Посмотреть»',exact:true}).waitFor();
  database(db=>assert.deepEqual(db.prepare("SELECT watched,rating_100,watchlist FROM user_movies WHERE user_id='valeriy' AND movie_id=3").get(),{watched:0,rating_100:null,watchlist:1}));
  await page.getByRole('button',{name:'Убрать из «Посмотреть»',exact:true}).click();await page.getByRole('button',{name:'Добавить в «Посмотреть»',exact:true}).waitFor();
  assert.equal(openaiCalls(),historicalCalls);check('historical marks desktop/mobile: external ratings labelled, 0/edit/clear supersedes history, independent watchlist; zero paid calls');
  assert.equal(errors.length,0,errors.join('\n'));report.mock_calls={openai:openaiCalls(),tmdb:calls('api.themoviedb.org')};report.status='passed';
} catch(error) {
  report.status='failed';report.failure=error.message;
  if(page)try{await screenshot('failure',true);}catch{}
  process.exitCode=1;console.error(error);
} finally {
  if(browser)await browser.close();await stop();
  if(fixture)rmSync(fixture.dir,{recursive:true,force:true});rmSync(temp,{recursive:true,force:true});
  try{assert.deepEqual(protectedState(),before);report.protected_data_unchanged=true;}catch(error){report.status='failed';report.protected_data_unchanged=false;process.exitCode=1;console.error(error);}
  writeFileSync(join(output,'results.json'),JSON.stringify(report,null,2));console.log(`Acceptance ${report.status}: ${checks.length} checks. Evidence: ${output}`);
}
