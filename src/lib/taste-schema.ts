export const PROMPT_VERSION = 1;
export const PROFILE_SCHEMA_VERSION = 1;
export type Evidence = { movie_id: number; rating_100: number };
export type Pattern = { summary: string; explanation: string; kind: 'observation' | 'hypothesis'; uncertainty: string; evidence: Evidence[] };
export type Contrast = { higher: Evidence; lower: Evidence; similarity: string; possible_difference: string; uncertainty: string };
export type ProfileBody = { strong_preferences: Pattern[]; negative_patterns: Pattern[]; contrasts: Contrast[];
  uncertainties: { description: string; evidence: Evidence[] }[] };

export type Schema = { type: string; properties?: Record<string, Schema>; required?: string[]; additionalProperties?: boolean;
  items?: Schema; enum?: string[]; minimum?: number; maximum?: number; minLength?: number; maxLength?: number; minItems?: number; maxItems?: number };
const text = (maxLength: number): Schema => ({ type: 'string', minLength: 1, maxLength });
const object = (properties: Record<string, Schema>): Schema => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const list = (items: Schema, minItems: number, maxItems: number): Schema => ({ type: 'array', items, minItems, maxItems });
const evidence = object({ movie_id: { type: 'integer', minimum: 1 }, rating_100: { type: 'integer', minimum: 0, maximum: 100 } });
const pattern = object({ summary: text(200), explanation: text(1000), kind: { type: 'string', enum: ['observation', 'hypothesis'] },
  uncertainty: text(600), evidence: list(evidence, 1, 10) });
export const PROFILE_SCHEMA = object({
  strong_preferences: list(pattern, 0, 8), negative_patterns: list(pattern, 0, 8),
  contrasts: list(object({ higher: evidence, lower: evidence, similarity: text(600), possible_difference: text(1000), uncertainty: text(600) }), 0, 12),
  uncertainties: list(object({ description: text(1000), evidence: list(evidence, 0, 10) }), 1, 12),
});
export const PROFILE_FORMAT = { type: 'json_schema', name: 'personal_movie_taste', strict: true, schema: PROFILE_SCHEMA };

// Validate the same small schema sent to OpenAI; no dependency or second divergent contract.
export function validateShape(value: unknown, schema: Schema): void {
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Profile contains an invalid object.');
    const record = value as Record<string, unknown>;
    if (Object.keys(record).length !== schema.required!.length || schema.required!.some(key => !Object.hasOwn(record, key)) ||
      Object.keys(record).some(key => !Object.hasOwn(schema.properties!, key))) throw new Error('Profile contains missing or unexpected fields.');
    for (const [key, child] of Object.entries(schema.properties!)) validateShape(record[key], child);
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length < schema.minItems! || value.length > schema.maxItems!) throw new Error('Profile contains an invalid list.');
    for (const item of value) validateShape(item, schema.items!);
  } else if (schema.type === 'string') {
    if (typeof value !== 'string' || !value.trim() || [...value].length < (schema.minLength ?? 1) || [...value].length > (schema.maxLength ?? Infinity) ||
      (schema.enum && !schema.enum.includes(value)) || /https?:\/\/|www\./i.test(value)) throw new Error('Profile contains invalid text or external links.');
  } else if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < schema.minimum! || value > (schema.maximum ?? Infinity)) {
    throw new Error('Profile contains an invalid integer.');
  }
}
export function validateProfile(value: unknown, snapshot: Evidence[], hasInputContrasts: boolean, allowHistorical = false): ProfileBody {
  validateShape(value, PROFILE_SCHEMA);
  const body = value as ProfileBody;
  const ratings = new Map(snapshot.map(row => [row.movie_id, row.rating_100]));
  const check = (refs: Evidence[]) => {
    const seen = new Set<number>();
    for (const ref of refs) {
      if (!ratings.has(ref.movie_id) || ratings.get(ref.movie_id) !== ref.rating_100 || seen.has(ref.movie_id)) {
        throw new Error('Profile evidence contains an unknown ID, incorrect rating, or duplicate.');
      }
      seen.add(ref.movie_id);
    }
  };
  for (const pattern of [...body.strong_preferences, ...body.negative_patterns]) check(pattern.evidence);
  for (const uncertainty of body.uncertainties) check(uncertainty.evidence);
  if (snapshot.some(row => row.rating_100 >= 80) && !body.strong_preferences.length) throw new Error('Profile is missing positive patterns.');
  if (snapshot.some(row => row.rating_100 <= 60) && !body.negative_patterns.length) throw new Error('Profile is missing negative patterns.');
  if (body.strong_preferences.some(pattern => !pattern.evidence.some(ref => ref.rating_100 >= 80)) ||
    body.negative_patterns.some(pattern => !pattern.evidence.some(ref => ref.rating_100 <= 60))) throw new Error('Profile patterns lack evidence from the corresponding rating group.');
  const pairs = new Set<string>();
  for (const pair of body.contrasts) {
    check([pair.higher, pair.lower]);
    if (pair.higher.rating_100 - pair.lower.rating_100 < 20) throw new Error('Profile contrast must have a rating gap of at least 20.');
    const key = [pair.higher.movie_id, pair.lower.movie_id].sort((a, b) => a - b).join(':');
    if (pairs.has(key)) throw new Error('Duplicate profile contrast.');
    pairs.add(key);
  }
  if (hasInputContrasts && !body.contrasts.length) throw new Error('Profile is missing contrasts.');
  if (!allowHistorical && !body.strong_preferences.length && !body.negative_patterns.length && !body.contrasts.length) throw new Error('Profile has no substantive observations.');
  return body;
}
