// Read-only lookup for the one-time repair CLI. No history synchronization.
import { setTimeout as delay } from 'node:timers/promises';

export class LetterboxdError extends Error {
  constructor(message: string, public readonly stop = false) { super(message); }
}
export function letterboxdUrl(input: string) {
  const url = new URL(input);
  if (url.protocol !== 'https:' || !['boxd.it', 'letterboxd.com'].includes(url.hostname) || url.username || url.password || (url.port && url.port !== '443')) {
    throw new LetterboxdError('Недопустимый адрес Letterboxd.');
  }
  return url;
}
export type LetterboxdIdentity = { type: 'movie' | 'tv'; id: number };
export function extractLetterboxdIdentity(html: string): LetterboxdIdentity | null {
  const found = new Map<string, LetterboxdIdentity>();
  const add = (type: string, value: string) => {
    const id = Number(value);
    if (!['movie', 'tv'].includes(type) || !/^\d+$/.test(value) || !Number.isSafeInteger(id) || id < 1) throw new LetterboxdError('Некорректная идентичность на странице Letterboxd.');
    found.set(`${type}:${id}`, { type: type as 'movie' | 'tv', id });
  };
  const markup = html.replace(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  for (const tag of markup.match(/<[a-z][^>]*>/gi) ?? []) {
    const attrs = new Map<string, string>();
    for (const match of tag.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
      const key = match[1].toLowerCase(), value = match[2] ?? match[3] ?? match[4];
      if (['data-tmdb-id', 'data-tmdb-type', 'href'].includes(key) && attrs.has(key) && attrs.get(key) !== value) throw new LetterboxdError('Противоречивые атрибуты Letterboxd.');
      attrs.set(key, value);
    }
    if (attrs.get('data-tmdb-id')?.trim()) {
      if (!attrs.has('data-tmdb-id') || !attrs.has('data-tmdb-type')) throw new LetterboxdError('Неполная идентичность Letterboxd.');
      add(attrs.get('data-tmdb-type')!, attrs.get('data-tmdb-id')!);
    }
    const href = attrs.get('href');
    if (href) {
      const match = /^https:\/\/(?:www\.)?themoviedb\.org\/(movie|tv)\/(\d+)(?:[/?#-]|$)/i.exec(href);
      if (match) add(match[1].toLowerCase(), match[2]);
    }
  }
  if (found.size > 1) throw new LetterboxdError('Противоречивые TMDB ID на странице Letterboxd.');
  return [...found.values()][0] ?? null;
}
export function createLetterboxdReader(options: { fetch?: typeof fetch; sleep?: (ms: number) => Promise<unknown>; now?: () => number; timeoutMs?: number } = {}) {
  const request = options.fetch ?? fetch, sleep = options.sleep ?? delay, now = options.now ?? Date.now;
  let last: number | null = null;
  return async (source: string): Promise<string> => {
    let url = letterboxdUrl(source);
    for (let redirects = 0; redirects <= 5; redirects++) {
      if (last !== null) await sleep(Math.max(0, 1000 - (now() - last)));
      last = now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15000);
      try {
        const response = await request(url, { redirect: 'manual', signal: controller.signal, headers: { 'User-Agent': 'RecommendMe/1.0 (one-time movie identity verification)' } });
        if ([401, 403, 429, 503].includes(response.status)) throw new LetterboxdError('Letterboxd ограничил доступ; обход остановлен.', true);
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location');
          await response.body?.cancel();
          if (!location) throw new LetterboxdError('Redirect Letterboxd без адреса.');
          url = letterboxdUrl(new URL(location, url).href);
          continue;
        }
        if (!response.ok) throw new LetterboxdError(`Letterboxd HTTP ${response.status}.`);
        if (!response.headers.get('content-type')?.toLowerCase().includes('text/html')) throw new LetterboxdError('Letterboxd вернул не HTML.');
        if (Number(response.headers.get('content-length') ?? 0) > 2 * 1024 * 1024) { await response.body?.cancel(); throw new LetterboxdError('Страница Letterboxd превышает 2 МБ.'); }
        const reader = response.body?.getReader();
        if (!reader) throw new LetterboxdError('Пустой ответ Letterboxd.');
        const chunks: Uint8Array[] = []; let size = 0;
        try {
          while (true) {
            const { value, done } = await reader.read(); if (done) break;
            size += value.byteLength;
            if (size > 2 * 1024 * 1024) throw new LetterboxdError('Страница Letterboxd превышает 2 МБ.');
            chunks.push(value);
          }
        } finally { await reader.cancel(); }
        const html = Buffer.concat(chunks).toString('utf8');
        if (/cf-chl-|cf-turnstile|<title>\s*(?:Just a moment|Access denied)/i.test(html)) throw new LetterboxdError('Защита Letterboxd ограничила доступ; обход остановлен.', true);
        return html;
      } catch (error) {
        if (error instanceof LetterboxdError) throw error;
        throw new LetterboxdError('Не удалось прочитать Letterboxd (сеть или таймаут).');
      } finally { clearTimeout(timer); }
    }
    throw new LetterboxdError('Слишком много redirect Letterboxd.');
  };
}

export type LetterboxdEvidence = { imdb: string[]; tmdb: { type: 'movie'|'tv'; id: number }[]; names: string[]; directors: string[]; actors: string[]; runtime: number | null };
export function extractLetterboxdEvidence(html: string): LetterboxdEvidence {
  const evidence: LetterboxdEvidence = { imdb: [], tmdb: [], names: [], directors: [], actors: [], runtime: null };
  for (const match of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const raw=match[1].replace(/^\s*\/\*\s*<!\[CDATA\[\s*\*\//,'').replace(/\/\*\s*\]\]>\s*\*\/\s*$/,'');
      const value=JSON.parse(raw);
      if(value['@type']!=='Movie'&&value['@type']!=='TVSeries'&&value['@type']!=='TVEpisode')continue;
      for(const key of ['name','alternateName'])if(typeof value[key]==='string')evidence.names.push(value[key]);
      for(const [key,destination] of [['director','directors'],['actor','actors']] as const) {
        for(const person of Array.isArray(value[key])?value[key]:[])if(typeof person?.name==='string')evidence[destination].push(person.name);
      }
      const duration=typeof value.duration==='string'?/^PT(?:(\d+)H)?(?:(\d+)M)?$/.exec(value.duration):null;
      if(duration)evidence.runtime=Number(duration[1]??0)*60+Number(duration[2]??0);
    } catch { /* Only optional structured metadata; malformed blocks never prove identity. */ }
  }
  const markup=html.replace(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,'');
  for(const tag of markup.match(/<[a-z][^>]*>/gi)??[]) {
    const attrs=new Map<string,string>();for(const m of tag.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g))attrs.set(m[1].toLowerCase(),m[2]??m[3]??m[4]);
    const href=attrs.get('href')??'';
    const imdb=/^https?:\/\/(?:www\.)?imdb\.com\/title\/(tt\d+)(?:[/?#]|$)/i.exec(href);if(imdb)evidence.imdb.push(imdb[1]);
    const tmdb=/^https:\/\/(?:www\.)?themoviedb\.org\/(movie|tv)\/(\d+)(?:[/?#-]|$)/i.exec(href);
    if(tmdb)evidence.tmdb.push({type:tmdb[1].toLowerCase() as 'movie'|'tv',id:Number(tmdb[2])});
    const value=attrs.get('data-tmdb-id'),type=attrs.get('data-tmdb-type');
    if(value&&/^\d+$/.test(value)&&Number.isSafeInteger(Number(value))&&Number(value)>0&&(type==='movie'||type==='tv'))evidence.tmdb.push({type,id:Number(value)});
  }
  evidence.imdb=[...new Set(evidence.imdb)];evidence.tmdb=[...new Map(evidence.tmdb.map(x=>[x.type+':'+x.id,x])).values()];
  return evidence;
}
