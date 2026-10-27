import { parseRateSelection } from './rating-draft';

export const librarySorts = {
  added_desc: 'Недавно добавленные', added_asc: 'Ранее добавленные',
  rating_desc: 'Высокая оценка → низкая', rating_asc: 'Низкая оценка → высокая',
} as const;
export type LibraryState = { q: string; rated: 'all' | 'true' | 'false'; year: string; sort: keyof typeof librarySorts; page: number };
export const defaultLibraryState: LibraryState = { q: '', rated: 'all', year: '', sort: 'added_desc', page: 1 };
export function parseLibraryState(params: URLSearchParams): { state: LibraryState; movieId?: number; error?: string } {
  const state = { ...defaultLibraryState };
  const invalid = () => ({ state, error: 'Некорректные параметры библиотеки. Сбросьте фильтры или исправьте ссылку.' });
  for (const key of ['q','rated','year','sort','page','movie_id']) if (params.getAll(key).length > 1) return invalid();
  const q = params.get('q')?.trim() ?? '', rated = params.get('rated') ?? 'all', sort = params.get('sort') ?? 'added_desc';
  const year = params.get('year') ?? '', page = params.get('page') ?? '1';
  if ([...q].length > 200 || !['all','true','false'].includes(rated) || !Object.hasOwn(librarySorts, sort) ||
    (params.has('year') && (!/^[1-9]\d{0,3}$/.test(year) || Number(year) > 9999)) || !/^[1-9]\d*$/.test(page) ||
    !Number.isSafeInteger(Number(page)) || !Number.isSafeInteger((Number(page) - 1) * 25)) return invalid();
  Object.assign(state, { q, rated, sort, year, page: Number(page) });
  const selection = parseRateSelection(params.has('movie_id') ? params.get('movie_id')! : undefined);
  if (selection.error) return { state, error: 'Некорректный ID фильма. Вернитесь к библиотеке.' };
  return { state, movieId: selection.movieId };
}
export function libraryParams(state: LibraryState) {
  const params = new URLSearchParams();
  if (state.q) params.set('q', state.q);
  if (state.rated !== 'all') params.set('rated', state.rated);
  if (state.year) params.set('year', state.year);
  if (state.sort !== 'added_desc') params.set('sort', state.sort);
  if (state.page !== 1) params.set('page', String(state.page));
  return params;
}
export function libraryUrl(state: LibraryState, movieId?: number) {
  const params = libraryParams(state); if (movieId !== undefined) params.set('movie_id', String(movieId));
  return `/library${params.size ? `?${params}` : ''}`;
}
export function libraryReadUrl(state: LibraryState) {
  const params = libraryParams(state); params.set('limit', '25');
  return `/api/library?${params}`;
}
export function libraryScore(value: number | null) { return value === null ? 'Без оценки' : `${value}/100`; }
