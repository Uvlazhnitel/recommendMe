import type { HistoryRow } from './candidate-context';
import type { MovieCandidate } from './candidates';
import type { ProfileBody } from './taste-schema';
import { examplePool, type ExampleSample } from './taste-examples';

const emptyProfile: ProfileBody = { strong_preferences: [], negative_patterns: [], contrasts: [], uncertainties: [] };
const intersects = (a: number[], b: number[]) => a.some(id => b.includes(id));
const directors = (row: MovieCandidate) => row.directors?.map(person => person.id) ?? [];
const overlap = (a: number[], b: number[]) => [...new Set(a)].filter(id => b.includes(id)).length / (new Set([...a, ...b]).size || 1);
const compare = (a: number[], b: number[]) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
};

/** Ratings define the eligible window; rotation only resolves equal coverage/diversity. */
export function selectSeeds(history: HistoryRow[], profile: ProfileBody, rotation = 0) {
  const byId = new Map(history.map(row => [row.id, row]));
  const pool = examplePool(history, { ...emptyProfile, strong_preferences: profile.strong_preferences }, new Map()).filter(sample => {
    const row = byId.get(sample.example.movie_id)!;
    return row.rating_100! >= 80 && !row.not_interested && Number.isSafeInteger(row.tmdb_id) && row.tmdb_id! > 0 &&
      row.media_type === 'movie' && (row.runtime_minutes ?? 0) >= 60 && (sample.genre_ids.length || sample.example.directors.length);
  }).sort((a, b) => b.example.rating_100 - a.example.rating_100 || a.example.movie_id - b.example.movie_id);
  const offset = pool.length ? rotation % pool.length : 0;
  const order = new Map([...pool.slice(offset), ...pool.slice(0, offset)].map((row, index) => [row, index]));
  const selected: ExampleSample[] = [], usedTmdb = new Set<number>(), patterns = new Set<number>();
  while (selected.length < 5) {
    const available = pool.filter(row => !usedTmdb.has(byId.get(row.example.movie_id)!.tmdb_id!));
    if (!available.length) break;
    const bestRating = Math.max(...available.map(row => row.example.rating_100));
    const key = (row: ExampleSample) => [
      -row.patterns.filter(id => !patterns.has(id)).length,
      Math.max(0, ...selected.map(other => overlap(row.genre_ids, other.genre_ids))),
      selected.filter(other => intersects(row.example.directors.map(p => p.id), other.example.directors.map(p => p.id))).length,
      order.get(row)!,
    ];
    const row = available.filter(row => row.example.rating_100 >= bestRating - 10).sort((a, b) => compare(key(a), key(b)))[0];
    selected.push(row); usedTmdb.add(byId.get(row.example.movie_id)!.tmdb_id!);
    row.patterns.forEach(id => patterns.add(id));
  }
  return selected.map(sample => {
    const row = byId.get(sample.example.movie_id)!;
    return { movie_id: row.id, tmdb_id: row.tmdb_id!, title: row.title, year: row.release_year };
  });
}

type Support = 'none' | 'single' | 'independent';
function support(candidate: MovieCandidate, history: ExampleSample[]): Support {
  const ds = directors(candidate), gs = candidate.genres.map(genre => genre.id);
  const directorLinks = history.filter(row => intersects(ds, row.example.directors.map(p => p.id)));
  const genreLinks = history.filter(row => row.genre_ids.filter(id => gs.includes(id)).length >= 2);
  // Two different films with confirmed, disjoint directors. Repetition of one
  // director or one genre cluster never accumulates an unbounded taste score.
  const independent = directorLinks.some(a => genreLinks.some(b => a.example.movie_id !== b.example.movie_id &&
    b.example.directors.length > 0 && !intersects(a.example.directors.map(p => p.id), b.example.directors.map(p => p.id))));
  return independent ? 'independent' : directorLinks.length || genreLinks.length ? 'single' : 'none';
}
const supportOrder: Record<Support, number> = { none: 0, single: 1, independent: 2 };
const sourceCounts = (rows: MovieCandidate[]) => ({ llm: rows.filter(row => row.source === 'llm').length,
  tmdb: rows.filter(row => row.source === 'tmdb').length, both: rows.filter(row => row.source === 'both').length });

/** Already verified, unique IDs only. This chooses a pool, not the final ranking. */
export function selectVerifiedCandidates(candidates: MovieCandidate[], history: HistoryRow[]) {
  const evidence = examplePool(history, emptyProfile, new Map());
  const high = evidence.filter(row => row.example.rating_100 >= 80), low = evidence.filter(row => row.example.rating_100 <= 60);
  const facts = new Map(candidates.map(row => [row, { support: support(row, high), counterexample: support(row, low) !== 'none' }]));
  const selected: MovieCandidate[] = [];
  const redundancy = (row: MovieCandidate) => ({
    director_repeats: selected.filter(other => intersects(directors(row), directors(other))).length,
    max_genre_overlap: Math.max(0, ...selected.map(other => overlap(row.genres.map(g => g.id), other.genres.map(g => g.id)))),
  });
  const describe = (row: MovieCandidate) => ({ tmdb_id: row.tmdb_id, ...facts.get(row)!, director_data: directors(row).length > 0,
    ...redundancy(row), both_sources: row.source === 'both' });
  const entries: (ReturnType<typeof describe> & { selected: boolean; position: number | null })[] = [];
  while (selected.length < 40 && selected.length < candidates.length) {
    const key = (row: MovieCandidate) => {
      const d = redundancy(row);
      return [-supportOrder[facts.get(row)!.support], -Number(directors(row).length > 0), d.director_repeats,
        d.max_genre_overlap, -Number(row.source === 'both'), row.tmdb_id];
    };
    const row = candidates.filter(row => !selected.includes(row)).sort((a, b) => compare(key(a), key(b)))[0];
    entries.push({ ...describe(row), selected: true, position: selected.length + 1 }); selected.push(row);
  }
  for (const row of [...candidates].sort((a, b) => a.tmdb_id - b.tmdb_id)) {
    if (!selected.includes(row)) entries.push({ ...describe(row), selected: false, position: null });
  }
  return { candidates: selected, selection: { version: 2, criteria: ['support', 'director_data', 'director_repeats', 'max_genre_overlap', 'both_sources', 'tmdb_id'],
    before: sourceCounts(candidates), after: sourceCounts(selected), excluded_count: candidates.length - selected.length, entries } };
}
