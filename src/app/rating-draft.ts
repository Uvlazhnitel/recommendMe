import { scoreValue } from './workbench-api';

export function ratingDraft(text: string) {
  try { return { value: scoreValue(text, true) ?? null, invalid: false }; }
  catch { return { value: null, invalid: true }; }
}
export function parseRateSelection(value: string | string[] | undefined) {
  if (value === undefined) return {};
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value))) return { movieId: Number(value) };
  return { error: 'Некорректная ссылка на фильм. Найдите его по названию ниже.' };
}
