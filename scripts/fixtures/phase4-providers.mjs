// Loaded only by the acceptance runner's isolated child process, never by application code.
import { readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd(), folder = join(root, 'src/app/preview/recommendations/assets');
const sources = JSON.parse(readFileSync(join(folder, 'sources.json'), 'utf8'));
const names = ['blade-runner','her','grand-budapest','arrival','perfect-days'];
const original = globalThis.fetch;
const settings = () => JSON.parse(readFileSync(process.env.PHASE4_CONTROL, 'utf8'));
const identity = movie => ({ id: movie.tmdb_id, title: movie.title, original_title: movie.title,
  release_date: `${movie.year}-01-01`, poster_path: movie.poster_path ?? null });
const synthetic = (id, title, year = 2000) => ({ tmdb_id: id, title, year, runtime: 100, genres: [{ id: 18, name: 'Drama' }] });
const extras = [synthetic(990001,'QA Similar Film',2019),synthetic(990002,'QA Similar Film',2020),synthetic(990003,'QA New Film'),synthetic(990004,'Legacy Duplicate'),synthetic(990005,'Новый русский фильм'),synthetic(990006,'New English Film')];
function available(control) {
  return control.round === 1 ? sources : Array.from({ length: 5 }, (_, index) => synthetic(900000 + control.round * 100 + index, `QA Feature ${control.round}-${index}`));
}
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (['localhost','127.0.0.1','[::1]'].includes(url.hostname)) return original(input, init);
  const control = settings();
  if (url.hostname === 'image.tmdb.org') {
    const index = sources.findIndex(movie => url.pathname.endsWith(movie.poster_path) || url.pathname.endsWith(movie.backdrop_path));
    if (index < 0) return new Response('', { status: 404 });
    const backdrop = url.pathname.endsWith(sources[index].backdrop_path);
    return new Response(readFileSync(join(folder, `${names[index]}-${backdrop ? 'backdrop' : 'poster'}.jpg`)), { headers: { 'Content-Type': 'image/jpeg' } });
  }
  if (!['api.openai.com','api.themoviedb.org'].includes(url.hostname)) throw new Error('Acceptance test blocked external network.');
  appendFileSync(process.env.PHASE4_CALLS, JSON.stringify({ provider: url.hostname, path: url.pathname }) + '\n');
  if (url.hostname === 'api.openai.com') {
    if (new Headers(init?.headers).get('Authorization') !== 'Bearer phase4-mock-openai') throw new Error('Acceptance refuses non-mock credentials.');
    if (control.delay) await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, control.delay);
      init?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('Mock request aborted')); }, { once: true });
    });
    if (control.mode === 'openai_error') return Response.json({ error: { message: 'Synthetic provider failure' } }, { status: 503 });
    const body = JSON.parse(init.body), ranking = body.text.format.name === 'personal_movie_ranking';
    const context = JSON.parse(body.input.find(item => item.role === 'user').content);
    const candidates = control.mode === 'no_candidates' ? [] : available(control).map(movie => ({ title: movie.title, year: movie.year }));
    const recommendations = (context.candidates ?? []).slice(0, 5).map(movie => ({ tmdb_id: movie.tmdb_id,
      why_fit: 'Это синтетическое объяснение для проверки интерфейса. Высокая оценка любимого фильма даёт повод рассмотреть эмоциональные ставки и ясный выбор героев. Это гипотеза: общего жанра недостаточно, чтобы установить предпочтение. '.repeat(2),
      possible_mismatch: 'Размеренный темп может отличаться от низко оценённого примера. Это синтетическое предположение, а причина вашей оценки неизвестна.',
      evidence: (context.current_evidence ?? []).slice(0,2).map(({movie_id,rating_100}) => ({movie_id,rating_100})),
    }));
    const value = body.text.format.name === 'russian_explanation' ? {
      why_fit: 'Этот фильм может понравиться благодаря камерному сюжету и ясному выбору героев. Это предположение на основе сохранённых оценок.',
      possible_mismatch: 'Размеренный темп может не подойти. Информации для уверенного вывода недостаточно.',
    } : ranking ? { recommendations } : { candidates };
    return Response.json({ status: control.mode === 'incomplete' ? 'incomplete' : 'completed', model: 'phase4-mock-model',
      usage: { input_tokens: 50, output_tokens: 25 }, output: [{ type: 'message', content: control.mode === 'refusal' ? [{ type: 'refusal', refusal: 'Synthetic refusal' }] :
        [{ type: 'output_text', text: control.mode === 'invalid' ? '{bad-json' : JSON.stringify(value) }] }] });
  }
  if (new URL(url).searchParams.get('api_key') !== 'phase4-mock-tmdb') throw new Error('Acceptance refuses non-mock credentials.');
  if (url.pathname.endsWith('/recommendations')) return Response.json({ results: [] });
  if (url.pathname.endsWith('/search/movie')) {
    const q = (url.searchParams.get('query') ?? '').toLowerCase();
    if (q === 'error') return Response.json({}, { status: 503 });
    let results = q === 'empty' ? [] : q === 'variants' ? extras.slice(0, 2) : q === 'extra' ? [extras[2]] : q === 'duplicate' ? [extras[3]] :
      [...available(control), ...sources, ...extras].filter(movie => movie.title.toLowerCase() === q);
    const year = url.searchParams.get('year'); if (year) results = results.filter(movie => String(movie.year) === year);
    return Response.json({ total_pages: 1, results: results.map(identity) });
  }
  const id = Number(url.pathname.split('/').at(-1)), movie = [...available(control), ...sources, ...extras].find(movie => movie.tmdb_id === id);
  if (!movie) return Response.json({}, { status: 404 });
  const localized = url.searchParams.get('language') === 'ru-RU';
  const russianTitles = {335984:'Бегущий по лезвию 2049',152601:'Она',120467:'Отель «Гранд Будапешт»',329865:'Прибытие',976893:'Идеальные дни'};
  return Response.json({ ...identity(movie), ...(localized && russianTitles[id] ? { title: russianTitles[id] } : {}), runtime: movie.runtime, genres: movie.genres, backdrop_path: movie.backdrop_path ?? null,
    overview: localized ? 'Синтетическое описание для проверки интерфейса: история о выборе, памяти и человеческой близости.' : 'Synthetic acceptance metadata. No live TMDB request was made. A story about choices, memory and human connection.',
    credits: { cast: [], crew: [{ id: 800001, name: 'QA Director', job: 'Director' }] }, vote_count: 10, popularity: 1 });
};
