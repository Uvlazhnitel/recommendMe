import type { ProfileBody, Evidence } from './taste-schema';
import type { MovieCandidate } from './candidates';

export type TasteExample = { movie_id: number; title: string; year: number | null; rating_100: number; overview: string | null;
  genres: string[]; directors: { id: number; name: string }[]; runtime_minutes: number | null };
export type ExampleSample = { example: TasteExample; genre_ids: number[]; patterns: number[]; reviewed: boolean };
type Source = { id: number; title: string; release_year: number | null; rating_100: number | null; tmdb_id: number | null;
  overview: string | null; genres_json: string | null; directors_json: string | null; runtime_minutes: number | null };
type Pair = { higher: Evidence; lower: Evidence };
type Candidate = Pick<MovieCandidate, 'tmdb_id' | 'genres' | 'directors'>;

/** Local facts only. Reviews affect the final tie-break, never taste weights. */
export function examplePool(rows: Source[], profile: ProfileBody, reviews: Map<number, string>): ExampleSample[] {
  const patterns = [...profile.strong_preferences, ...profile.negative_patterns, ...profile.uncertainties];
  return rows.flatMap(row => {
    if (row.rating_100 === null || row.tmdb_id === null) return [];
    const genres: unknown = JSON.parse(row.genres_json ?? '[]'), directors: unknown = JSON.parse(row.directors_json ?? '[]');
    const person = (value: unknown): value is { id: number; name: string } => Boolean(value) && typeof value === 'object' &&
      Number.isSafeInteger((value as { id: number }).id) && (value as { id: number }).id > 0 &&
      typeof (value as { name: string }).name === 'string' && Boolean((value as { name: string }).name.trim());
    const genre = (value: unknown): value is { id?: number; name: string } => Boolean(value) && typeof value === 'object' &&
      typeof (value as { name: string }).name === 'string' && Boolean((value as { name: string }).name.trim()) &&
      (!Object.hasOwn(value!, 'id') || person(value));
    if (!Array.isArray(genres) || !genres.every(genre) || !Array.isArray(directors) || !directors.every(person)) throw new Error('Invalid confirmed metadata in the local library.');
    if (!genres.length && !directors.length && !row.overview) return [];
    return [{ example: { movie_id: row.id, title: row.title, year: row.release_year, rating_100: row.rating_100, overview: row.overview,
      genres: [...new Set(genres.map(row => row.name))].sort(), directors: directors.map(({ id, name }) => ({ id, name })).sort((a, b) => a.id - b.id), runtime_minutes: row.runtime_minutes },
      genre_ids: [...new Set(genres.flatMap(row => row.id === undefined ? [] : [row.id]))], reviewed: reviews.has(row.id),
      patterns: patterns.flatMap((pattern, index) => pattern.evidence.some(ref => ref.movie_id === row.id && ref.rating_100 === row.rating_100) ? [index] : []) }];
  });
}
const intersects = <T>(left: T[], right: T[]) => left.some(value => right.includes(value));
const contrary = (a: TasteExample, b: TasteExample) => (a.rating_100 >= 80) !== (b.rating_100 >= 80) && Math.abs(a.rating_100 - b.rating_100) >= 20;
const genreKeys = (row: ExampleSample) => row.genre_ids.length ? row.genre_ids.map(id => `id:${id}`) : row.example.genres.map(name => `name:${name}`);
function diversity(sample: ExampleSample, selected: ExampleSample[], pairs: Pair[]) {
  const ids = new Set(selected.map(row => row.example.movie_id)), patterns = new Set(selected.flatMap(row => row.patterns));
  const genres = new Set(selected.flatMap(genreKeys)), movie = sample.example, keys = genreKeys(sample);
  const newPatterns = sample.patterns.filter(id => !patterns.has(id)).length;
  const contrasts = pairs.filter(pair => (pair.higher.movie_id === movie.movie_id && ids.has(pair.lower.movie_id)) ||
    (pair.lower.movie_id === movie.movie_id && ids.has(pair.higher.movie_id))).length;
  const newGenres = keys.filter(name => !genres.has(name)).length;
  const directorRepeats = selected.filter(row => intersects(row.example.directors.map(person => person.id), movie.directors.map(person => person.id))).length;
  const genreOverlap = Math.max(0, ...selected.map(row => {
    const other = genreKeys(row), intersection = keys.filter(name => other.includes(name)).length;
    return intersection / (new Set([...keys, ...other]).size || 1);
  }));
  const scoreCount = selected.filter(row => row.example.rating_100 === movie.rating_100).length;
  return { scoreCount, newPatterns, contrasts, newGenres, directorRepeats, genreOverlap };
}
function generalKey(sample: ExampleSample, selected: ExampleSample[], pairs: Pair[]) {
  const d = diversity(sample, selected, pairs);
  return [d.scoreCount, -d.newPatterns, -d.contrasts, -d.newGenres, d.directorRepeats, d.genreOverlap, -Number(sample.reviewed), sample.example.movie_id];
}
function compare(a: number[], b: number[]) {
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return a[index] - b[index];
  return 0;
}
function best(pool: ExampleSample[], key: (sample: ExampleSample) => number[]) {
  return pool.map(sample => ({ sample, key: key(sample) })).sort((a, b) => compare(a.key, b.key))[0]?.sample;
}
export function selectGeneralExamples(pool: ExampleSample[], pairs: Pair[], perGroup = 10): TasteExample[] {
  const selected: ExampleSample[] = [];
  for (let slot = 0; slot < perGroup; slot++) for (const high of [true, false]) {
    const group = pool.filter(row => high ? row.example.rating_100 >= 80 : row.example.rating_100 <= 60);
    const available = group.filter(row => !selected.includes(row));
    const sample = best(available, row => generalKey(row, selected, pairs));
    if (sample) selected.push(sample);
  }
  return selected.map(row => row.example);
}
/** Link strength describes metadata retrieval, never predicted enjoyment. */
function link(sample: ExampleSample, candidate: Candidate) {
  const director = intersects(sample.example.directors.map(person => person.id), candidate.directors?.map(person => person.id) ?? []);
  const genres = sample.genre_ids.filter(id => candidate.genres.some(genre => genre.id === id)).length;
  return director ? (genres ? 3 : 2) : genres >= 2 ? 1 : 0;
}
export function selectRelatedExamples(pool: ExampleSample[], candidates: Candidate[], base: TasteExample[], pairs: Pair[], limit = 10): TasteExample[] {
  const baseIds = new Set(base.map(row => row.movie_id)), selected = pool.filter(row => baseIds.has(row.example.movie_id));
  const result: ExampleSample[] = [], links = new Map(pool.map(row => [row, candidates.map(candidate => link(row, candidate))]));
  while (result.length < limit) {
    const available = pool.filter(row => !selected.includes(row));
    if (!available.length) break;
    const linked = candidates.map((_, index) => selected.filter(row => links.get(row)![index] > 0));
    const contrasted = linked.map(rows => rows.some((a, index) => rows.slice(index + 1).some(b => contrary(a.example, b.example))));
    const gain = (row: ExampleSample) => links.get(row)!.filter((strength, index) => strength && !linked[index].length).length;
    const contrasts = (row: ExampleSample) => links.get(row)!.filter((strength, index) => strength && !contrasted[index] && linked[index].some(other => contrary(row.example, other.example))).length;
    let sample = best(available, row => {
      const d = diversity(row, selected, pairs);
      return [-gain(row), -contrasts(row), -Math.max(0, ...links.get(row)!), d.directorRepeats, d.genreOverlap, -Number(row.reviewed), row.example.movie_id];
    })!;
    if (!gain(sample) && !contrasts(sample)) {
      // A fallback must add a new side of the record, not fill ten slots with
      // identical genre/rating examples just because their directors differ.
      const informative = available.filter(row => {
        const d = diversity(row, selected, pairs);
        return d.newPatterns || d.newGenres || d.contrasts || !d.scoreCount || (row.example.genres.length > 0 && d.genreOverlap < 1);
      });
      const fallback = best(informative, row => generalKey(row, selected, pairs));
      if (!fallback) break;
      sample = fallback;
    }
    selected.push(sample); result.push(sample);
  }
  return result.map(row => row.example);
}
