'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, json, message, scoreValue, type Match } from './workbench-api';

export type SearchFilm = { id: number; title: string; original_title: string | null; year: number | null; poster_path: string | null };
export type Film = { movie_id: number; tmdb_id: number | null; title: string; year: number | null; watched: boolean;
  rating_100: number | null; rating_source: string; not_interested: boolean; original_rating_stars: number | null; poster_path: string | null;
  overview?: string | null; runtime_minutes?: number | null; genres?: { id: number; name: string }[] | null };
type Library = { items: Film[]; page: number; total: number; total_pages: number };
type Operation = 'select' | 'watch' | 'rating' | 'clear' | 'reject';
export function useWorkbench(mode: 'rate' | 'library', initialMovieId?: number) {
  const [query, setQuery] = useState(''), [year, setYear] = useState('');
  const [results, setResults] = useState<SearchFilm[] | null>(null), [more, setMore] = useState(false);
  const [searching, setSearching] = useState(false), [searchError, setSearchError] = useState('');
  const [libraryQuery, setLibraryQuery] = useState(''), [rated, setRated] = useState('all');
  const [library, setLibrary] = useState<Library | null>(null), [libraryBusy, setLibraryBusy] = useState(true), [libraryError, setLibraryError] = useState('');
  const [selected, setSelected] = useState<Film | null>(null), [selecting, setSelecting] = useState(initialMovieId !== undefined), [score, setScore] = useState('');
  const [pending, setPending] = useState<Operation | null>(null), [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null), [matches, setMatches] = useState<Match[]>([]);
  const [recoveryMovieId, setRecoveryMovieId] = useState<number | null>(null), [watchConfirmed, setWatchConfirmed] = useState(false);
  const [addingId, setAddingId] = useState<number | null>(null);
  const searchRun = useRef(0), libraryRun = useRef(0), detailRun = useRef(0), actionLock = useRef(false), alive = useRef(false);
  const searchAbort = useRef<AbortController | null>(null), detailAbort = useRef<AbortController | null>(null), libraryAbort = useRef<AbortController | null>(null);
  const filters = useRef({ q: '', rated: 'all' });
  const busy = pending !== null;

  useEffect(() => {
    alive.current = true;
    const reads = [searchAbort, detailAbort, libraryAbort];
    return () => { alive.current = false; reads.forEach(ref => ref.current?.abort()); };
  }, []);
  useEffect(() => {
    if (mode !== 'rate' || initialMovieId === undefined) return;
    const run = ++detailRun.current, controller = new AbortController(); detailAbort.current = controller;
    api<Film>(`/api/library/${initialMovieId}`, { signal: controller.signal }).then(film => {
      if (run === detailRun.current && !controller.signal.aborted) {
        setSelected(film); setScore(film.rating_100 === null ? '' : String(film.rating_100));
      }
    }).catch(error => { if (!controller.signal.aborted && run === detailRun.current) { setNotice({ error: true, text: message(error) }); setRecoveryMovieId(initialMovieId); } })
      .finally(() => { if (!controller.signal.aborted && run === detailRun.current) setSelecting(false); });
    return () => controller.abort();
  }, [mode, initialMovieId]);
  useEffect(() => {
    if (mode !== 'library') return;
    const run = ++libraryRun.current, controller = new AbortController(); libraryAbort.current = controller;
    api<Library>('/api/library', { signal: controller.signal }).then(value => {
      if (run === libraryRun.current && !controller.signal.aborted) setLibrary(value);
    }).catch(error => { if (run === libraryRun.current && !controller.signal.aborted) setLibraryError(message(error)); })
      .finally(() => { if (run === libraryRun.current && !controller.signal.aborted) setLibraryBusy(false); });
    return () => controller.abort();
  }, [mode]);

  async function loadLibrary(page = 1) {
    const run = ++libraryRun.current, controller = new AbortController(); libraryAbort.current?.abort(); libraryAbort.current = controller;
    setLibraryBusy(true); setLibraryError('');
    try {
      const value = await api<Library>(`/api/library?${new URLSearchParams({ ...filters.current, page: String(page) })}`, { signal: controller.signal });
      if (alive.current && run === libraryRun.current) setLibrary(value);
    } catch (error) { if (alive.current && !controller.signal.aborted && run === libraryRun.current) setLibraryError(message(error)); throw error; }
    finally { if (alive.current && run === libraryRun.current) setLibraryBusy(false); }
  }
  function refreshLibrary(page: number) { void loadLibrary(page).catch(() => {}); }
  async function choose(movieId: number) {
    if (actionLock.current) return;
    const run = ++detailRun.current, controller = new AbortController(); detailAbort.current?.abort(); detailAbort.current = controller;
    setSelecting(true); setSelected(null); setNotice(null); setMatches([]); setRecoveryMovieId(null); setWatchConfirmed(false);
    try {
      const film = await api<Film>(`/api/library/${movieId}`, { signal: controller.signal });
      if (alive.current && run === detailRun.current) { setSelected(film); setScore(film.rating_100 === null ? '' : String(film.rating_100)); }
    } catch (error) { if (alive.current && !controller.signal.aborted && run === detailRun.current) { setNotice({ error: true, text: message(error) }); setRecoveryMovieId(movieId); } }
    finally { if (alive.current && run === detailRun.current) setSelecting(false); }
  }
  async function action(kind: Operation, operation: () => Promise<{ movieId: number; text: string }>) {
    if (actionLock.current) return false;
    actionLock.current = true; ++detailRun.current; detailAbort.current?.abort();
    setSelecting(false); setPending(kind); setNotice(null); setMatches([]); setRecoveryMovieId(null);
    if (kind === 'select') { setSelected(null); setScore(''); setWatchConfirmed(false); }
    let completedId: number | null = null;
    try {
      const result = await operation(); completedId = result.movieId;
      if (!alive.current) return false;
      if (kind === 'watch') setWatchConfirmed(true);
      const controller = new AbortController(); detailAbort.current = controller;
      const film = await api<Film>(`/api/library/${result.movieId}`, { signal: controller.signal });
      if (!alive.current) return false;
      setSelected(film); setScore(film.rating_100 === null ? '' : String(film.rating_100));
      if (mode === 'library') await loadLibrary(library?.page ?? 1);
      if (alive.current) setNotice({ error: false, text: result.text });
      return true;
    } catch (error) {
      if (alive.current) {
        setNotice({ error: true, text: completedId !== null ? 'Операция выполнена, но данные на экране не обновились. Перечитайте фильм, не повторяя сохранение.' : message(error) });
        if (completedId !== null) setRecoveryMovieId(completedId);
        if (error instanceof ApiError) {
          if (Array.isArray(error.matches)) setMatches(error.matches);
          if (error.code === 'rating_already_exists' && selected) setRecoveryMovieId(selected.movie_id);
        }
      }
      return false;
    } finally { actionLock.current = false; if (alive.current) { setPending(null); setAddingId(null); } }
  }
  function invalidateSearch() { searchRun.current++; searchAbort.current?.abort(); setSearching(false); setResults(null); setSearchError(''); setNotice(null); setMatches([]); }
  async function search(event: FormEvent) {
    event.preventDefault(); if (actionLock.current) return;
    ++detailRun.current; detailAbort.current?.abort(); setSelecting(false); setRecoveryMovieId(null);
    const run = ++searchRun.current, controller = new AbortController(); searchAbort.current?.abort(); searchAbort.current = controller;
    setNotice(null); setMatches([]);
    if (!query.trim()) { setSearchError('Введите название фильма.'); setResults(null); return; }
    if (year && (!/^\d{1,4}$/.test(year) || Number(year) < 1)) { setSearchError('Год должен быть целым числом от 1 до 9999.'); return; }
    setSearching(true); setSearchError(''); setResults(null);
    try {
      const params = new URLSearchParams({ q: query.trim() }); if (year) params.set('year', year);
      const found = await api<{ results: SearchFilm[]; has_more: boolean }>(`/api/movies/search?${params}`, { signal: controller.signal });
      if (alive.current && run === searchRun.current) { setResults(found.results); setMore(found.has_more); }
    } catch (error) { if (alive.current && !controller.signal.aborted && run === searchRun.current) setSearchError(message(error)); }
    finally { if (alive.current && run === searchRun.current) setSearching(false); }
  }
  function add(film: SearchFilm) {
    if (actionLock.current) return Promise.resolve(false);
    setAddingId(film.id);
    return action('select', async () => {
      const result = await api<{ movie_id: number; status: string }>('/api/movies', json({ tmdb_id: film.id }));
      return { movieId: result.movie_id, text: result.status === 'created' ? 'Фильм добавлен в каталог. Просмотр ещё не отмечен.' : 'Фильм уже есть в каталоге; используется существующая запись.' };
    });
  }
  function watch(event: FormEvent) {
    event.preventDefault(); if (!selected) return;
    let rating; try { rating = scoreValue(score, true); } catch (error) { setNotice({ error: true, text: message(error) }); return; }
    const movieId = selected.movie_id;
    void action('watch', async () => {
      const result = await api<{ status: string }>(`/api/movies/${movieId}/watch`, json(rating === undefined ? {} : { rating_100: rating }));
      return { movieId, text: result.status === 'unchanged' ? 'Просмотр уже сохранён. Изменений нет.' : 'Просмотр сохранён.' };
    });
  }
  function edit(value: number | null) {
    if (!selected) return; const movieId = selected.movie_id;
    void action(value === null ? 'clear' : 'rating', async () => {
      const result = await api<{ status: string }>(`/api/library/${movieId}/rating`, json({ rating_100: value }, 'PATCH'));
      return { movieId, text: result.status === 'unchanged' ? 'Оценка не изменилась.' : value === null ? 'Оценка очищена. Фильм остаётся просмотренным.' : 'Оценка сохранена.' };
    });
  }
  function saveScore(event: FormEvent) {
    event.preventDefault();
    try { edit(scoreValue(score)!); } catch (error) { setNotice({ error: true, text: message(error) }); }
  }
  function reject() {
    if (!selected || selected.tmdb_id === null) return;
    const film = selected;
    void action('reject', async () => {
      await api(`/api/recommendations/reject${film.not_interested ? '/undo' : ''}`, json({ tmdb_id: film.tmdb_id }));
      return { movieId: film.movie_id, text: film.not_interested ? 'Текущий запрет снят; история отклонений сохранена.' : 'Фильм отмечен «Неинтересно». Оценка и просмотр сохранены.' };
    });
  }
  return { query, setQuery, year, setYear, results, more, searching, searchError, libraryQuery, setLibraryQuery, rated, setRated,
    library, libraryBusy, libraryError, selected, selecting, score, setScore, busy, pending, notice, matches, recoveryMovieId, watchConfirmed, addingId,
    search, add, watch, saveScore, edit, reject, choose, refreshLibrary, invalidateSearch,
    filterLibrary() { filters.current = { q: libraryQuery, rated }; refreshLibrary(1); } };
}
