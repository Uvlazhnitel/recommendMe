export const TASTE_REFRESH_THRESHOLD = 10;
type Change = { previous_rating_100: number | null; rating_100: number | null };
export function describeTasteRefresh(changes: Change[], fingerprintMatches: boolean, reviews = { added: 0, changed: 0, cleared: 0, total_changes: 0 }) {
  const added = changes.filter(row => row.previous_rating_100 === null && row.rating_100 !== null).length;
  const cleared = changes.filter(row => row.previous_rating_100 !== null && row.rating_100 === null).length;
  const changed = changes.length - added - cleared;
  const total = changes.length + reviews.total_changes;
  const status = total >= TASTE_REFRESH_THRESHOLD ? 'refresh_recommended' : total || !fingerprintMatches ? 'stale' : 'current';
  return { status, added, changed, cleared, total_changes: changes.length, review_changes: reviews, total_feedback_changes: total, threshold: TASTE_REFRESH_THRESHOLD,
    refresh_recommended: status === 'refresh_recommended', refresh_command: 'npm run taste:generate -- --live --force',
    notice: status === 'refresh_recommended' ? 'Full taste profile refresh is recommended. Run the refresh command explicitly; no API call was made.' : 'No automatic profile regeneration.' };
}
