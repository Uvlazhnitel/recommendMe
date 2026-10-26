// Server-side MVP policy, measured in elapsed UTC milliseconds.
export const RECOMMENDATION_REPEAT_DAYS = 30;
export const RECOMMENDATION_REPEAT_MS = RECOMMENDATION_REPEAT_DAYS * 24 * 60 * 60 * 1000;
export function recentlyRecommended(date: string | null, now = Date.now()) {
  return date !== null && Date.parse(date) > now - RECOMMENDATION_REPEAT_MS;
}
