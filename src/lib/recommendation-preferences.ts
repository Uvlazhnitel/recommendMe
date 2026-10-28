// Shared finite inputs, not free-form instructions. Safe to import in the browser.
export const MOODS = [
  { id: 'warm', title: 'Лёгкое и душевное', description: 'Тёплое кино, которое не выматывает', symbol: '☀' },
  { id: 'funny', title: 'Хочу посмеяться', description: 'Юмор, который попадёт в твой вкус', symbol: '☺' },
  { id: 'outstanding', title: 'Что-то выдающееся', description: 'Особенно сильное личное впечатление', symbol: '✦' },
  { id: 'thoughtful', title: 'Есть над чем подумать', description: 'Идеи и истории с послевкусием', symbol: '◈' },
  { id: 'engaging', title: 'Чтобы захватило', description: 'Интрига, напряжение, приключение', symbol: '↗' },
  { id: 'surprise', title: 'Удиви меня', description: 'Доверься своему вкусу без ограничений', symbol: '✧' },
] as const;
export type RecommendationPreferences = {
  mood: typeof MOODS[number]['id']; max_runtime: null | 100 | 120;
  avoid_horror: boolean; avoid_heavy: boolean; avoid_slow: boolean;
};
export const DEFAULT_PREFERENCES: Readonly<RecommendationPreferences> = Object.freeze({
  mood: 'surprise', max_runtime: null, avoid_horror: false, avoid_heavy: false, avoid_slow: false,
});
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export function parsePreferences(value: unknown): RecommendationPreferences {
  if (value === undefined) return { ...DEFAULT_PREFERENCES };
  if (!object(value) || Object.keys(value).length !== 5 || Object.keys(value).some(k => !Object.hasOwn(DEFAULT_PREFERENCES, k)) ||
    !MOODS.some(m => m.id === value.mood) || ![null, 100, 120].includes(value.max_runtime as null | number) ||
    ['avoid_horror', 'avoid_heavy', 'avoid_slow'].some(k => typeof value[k] !== 'boolean')) throw Error('Invalid recommendation preferences.');
  return { mood: value.mood as RecommendationPreferences['mood'], max_runtime: value.max_runtime as RecommendationPreferences['max_runtime'],
    avoid_horror: value.avoid_horror as boolean, avoid_heavy: value.avoid_heavy as boolean, avoid_slow: value.avoid_slow as boolean };
}
export const samePreferences = (a: RecommendationPreferences, b: RecommendationPreferences) => JSON.stringify(parsePreferences(a)) === JSON.stringify(parsePreferences(b));
export const customPreferences = (p: RecommendationPreferences) => !samePreferences(p, DEFAULT_PREFERENCES);
export function preferencesLabel(p: RecommendationPreferences | null) {
  if (!p) return 'Персональная подборка';
  return [MOODS.find(m => m.id === p.mood)!.title, p.max_runtime ? `До ${p.max_runtime === 120 ? '2 часов' : '100 минут'}` : '',
    p.avoid_horror ? 'Без ужасов' : '', p.avoid_heavy ? 'Без тяжёлых тем' : '', p.avoid_slow ? 'Без медленного кино' : ''].filter(Boolean).join(' · ');
}
const intent: Record<RecommendationPreferences['mood'], string> = {
  warm: 'Warm, comforting, light and humane; not necessarily romantic comedy. Avoid emotionally exhausting choices for this evening.',
  funny: 'Humour suited to this person, including satire, absurdism or dramedy. Comedy genre alone does not prove that they will find it funny.',
  outstanding: 'Especially strong personal relevance, story, artistry and originality. Comedy can qualify. Popularity, awards or TMDB ratings are not proof; do not certify an objective masterpiece.',
  thoughtful: 'Ideas, moral questions, unusual concepts or layered stories with an aftertaste; not limited to science fiction or heavy drama.',
  engaging: 'An absorbing story, intrigue, suspense, adventure or surprises; not limited to action or thrillers.',
  surprise: 'General personal recommendations without an extra mood restriction.',
};
export function preferenceGuidance(p: RecommendationPreferences) {
  if (!customPreferences(p)) return '';
  return '\nEvening preferences: ' + intent[p.mood] +
    ' Apply request_preferences together with personal evidence, never as a lasting change to taste. Runtime and confirmed Horror genre exclusions are strict. Other wishes are soft: do not infer pace, emotional heaviness, humour quality or mood from genre alone, or invent such facts from a synopsis. State uncertainty in possible_mismatch and prefer fewer well-supported choices. Never silently relax strict limits.';
}
export function preferenceExclusion(movie: { runtime: number | null; genres: { id: number; name?: string }[] }, p: RecommendationPreferences) {
  if (p.max_runtime !== null && (!Number.isSafeInteger(movie.runtime) || movie.runtime! < 60 || movie.runtime! > p.max_runtime)) return 'runtime_preference';
  if (p.avoid_horror && movie.genres.some(g => g.id === 27)) return 'horror_preference';
  return null;
}
/** Old reports have no snapshot. New stage reports must agree before saving. */
export function reportPreferences(candidate: unknown, ranking: unknown): RecommendationPreferences | null {
  const a = object(candidate) ? candidate.preferences : undefined, b = object(ranking) ? ranking.preferences : undefined;
  if (a === undefined && b === undefined) return null;
  if (a === undefined || b === undefined || !samePreferences(parsePreferences(a), parsePreferences(b))) throw Error('Preference snapshots disagree.');
  return parsePreferences(a);
}
