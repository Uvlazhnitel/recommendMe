import { profileFetch } from './profile-requests';
export type Match = { movie_id: number; title: string; year: number | null };
const errors: Record<string, string> = {
  invalid_watchlist: 'Не удалось изменить список: некорректные данные.', watchlist_unavailable: 'Список не изменён. Проверьте связь и повторите попытку.',
  invalid_search: 'Введите название (до 200 символов) и корректный год.', tmdb_unavailable: 'TMDB недоступен. Повторите поиск позже.',
  movie_not_found: 'Фильм не найден.', possible_duplicate: 'Возможно, фильм уже есть в старой истории. Автоматическое объединение не выполнено.',
  invalid_tmdb_id: 'Некорректный идентификатор TMDB.', invalid_movie_id: 'Некорректный локальный идентификатор.',
  invalid_review: 'Впечатления должны содержать не более 2000 символов.',
  review_unavailable: 'Впечатления не сохранены. Текст остался в поле; попробуйте ещё раз.',
  request_too_large: 'Слишком большой запрос. Сократите текст.',
  invalid_watch: 'Проверьте данные просмотра и оценку 0–100.', invalid_rating: 'Оценка должна быть целым числом от 0 до 100.',
  rating_already_exists: 'Оценка уже существует. Обновите данные фильма перед редактированием.', movie_not_watched: 'Сначала подтвердите просмотр фильма.',
  invalid_library_query: 'Проверьте параметры поиска библиотеки.', forbidden_origin: 'Запрос отклонён: откройте приложение по тому же адресу.',
  catalog_unavailable: 'Не удалось добавить фильм. Проверьте доступность базы и резервного копирования.',
  watch_unavailable: 'Просмотр не сохранён. Проверьте доступность базы и резервного копирования.',
  library_unavailable: 'Операция с библиотекой не выполнена. Проверьте базу и резервное копирование.',
  rejection_unavailable: 'Отклонение не изменено. Проверьте базу и резервное копирование.',
};
export class ApiError extends Error {
  constructor(public readonly code: string, public readonly matches?: Match[]) { super(errors[code] ?? 'Сервис не смог выполнить операцию.'); }
}
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try { response = await profileFetch(path, { cache: 'no-store', ...init }); }
  catch { throw new Error('Нет связи с приложением. Попробуйте ещё раз.'); }
  let body;
  try { body = await response.json(); } catch { throw new Error('Приложение вернуло некорректный ответ.'); }
  if (!response.ok) throw new ApiError(typeof body?.error === 'string' ? body.error : body?.status === 'possible_duplicate' ? 'possible_duplicate' : '', body?.matches);
  return body as T;
}
export const json = (body: unknown, method = 'POST'): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
export function scoreValue(text: string, optional = false) {
  if (!text.trim()) { if (optional) return undefined; throw new Error('Введите оценку или нажмите «Очистить оценку».'); }
  const value = Number(text);
  if (!Number.isInteger(value) || value < 0 || value > 100) throw new Error('Оценка должна быть целым числом от 0 до 100.');
  return value;
}
export const message = (error: unknown) => error instanceof Error ? error.message : 'Не удалось выполнить операцию.';
