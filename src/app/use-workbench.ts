'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, json, message, scoreValue, type Match } from './workbench-api';

export type SearchFilm = { id: number; title: string; original_title: string | null; year: number | null; poster_path: string | null };
export type Film = { movie_id: number; tmdb_id: number | null; title: string; year: number | null; watched: boolean;
  rating_100: number | null; rating_source: string; not_interested: boolean; original_rating_stars: number | null; poster_path: string | null; overview?: string | null; runtime?: number | null };
type Library = { items: Film[]; page: number; total: number; total_pages: number };
export function useWorkbench(mode: 'rate' | 'library', initialMovieId?: number) {
  const [query, setQuery] = useState(''), [year, setYear] = useState('');
  const [results, setResults] = useState<SearchFilm[] | null>(null), [more, setMore] = useState(false);
  const [searching, setSearching] = useState(false), [searchError, setSearchError] = useState('');
  const [libraryQuery, setLibraryQuery] = useState(''), [rated, setRated] = useState('all');
  const [library, setLibrary] = useState<Library | null>(null), [libraryBusy, setLibraryBusy] = useState(true), [libraryError, setLibraryError] = useState('');
  const [selected, setSelected] = useState<Film | null>(null), [selecting, setSelecting] = useState(initialMovieId !== undefined), [score, setScore] = useState('');
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null), [matches, setMatches] = useState<Match[]>([]);
  const searchRun = useRef(0), libraryRun = useRef(0), detailRun = useRef(0), actionLock = useRef(false);
  const filters = useRef({ q: '', rated: 'all' });

  useEffect(() => {
    if (mode !== 'rate' || initialMovieId === undefined) return;
    const run = ++detailRun.current, controller = new AbortController();
    api<Film>(`/api/library/${initialMovieId}`, { signal: controller.signal }).then(film => {
      if (run === detailRun.current && !controller.signal.aborted) {
        setSelected(film); setScore(film.rating_100 === null ? '' : String(film.rating_100));
      }
    }).catch(error => { if (!controller.signal.aborted && run === detailRun.current) setNotice({ error: true, text: message(error) }); })
      .finally(() => { if (!controller.signal.aborted && run === detailRun.current) setSelecting(false); });
    return () => controller.abort();
  }, [mode, initialMovieId]);

  useEffect(() => {
    if (mode !== 'library') return;
    const run = ++libraryRun.current, controller = new AbortController();
    api<Library>('/api/library', { signal: controller.signal }).then(value => {
      if (run === libraryRun.current && !controller.signal.aborted) setLibrary(value);
    }).catch(error => { if (run === libraryRun.current && !controller.signal.aborted) setLibraryError(message(error)); })
      .finally(() => { if (run === libraryRun.current && !controller.signal.aborted) setLibraryBusy(false); });
    return () => controller.abort();
  }, [mode]);

  async function loadLibrary(page = 1) {
    const run = ++libraryRun.current;
    setLibraryBusy(true); setLibraryError('');
    try {
      const value = await api<Library>(`/api/library?${new URLSearchParams({ ...filters.current, page: String(page) })}`);
      if (run === libraryRun.current) setLibrary(value);
    } catch (error) { if (run === libraryRun.current) setLibraryError(message(error)); throw error; }
    finally { if (run === libraryRun.current) setLibraryBusy(false); }
  }
  function refreshLibrary(page: number) { void loadLibrary(page).catch(() => {}); }
  async function choose(movieId: number) {
    if (actionLock.current) return;
    const run = ++detailRun.current;
    setSelecting(true); setSelected(null); setNotice(null); setMatches([]);
    try {
      const film = await api<Film>(`/api/library/${movieId}`);
      if (run === detailRun.current) { setSelected(film); setScore(film.rating_100 === null ? '' : String(film.rating_100)); }
    } catch (error) { if (run === detailRun.current) setNotice({ error: true, text: message(error) }); }
    finally { if (run === detailRun.current) setSelecting(false); }
  }
  async function action(operation: () => Promise<{ movieId: number; text: string }>) {
    if (actionLock.current) return;
    actionLock.current = true; ++detailRun.current; setSelecting(false); setBusy(true); setNotice(null); setMatches([]);
    let completed = false;
    try {
      const result = await operation(); completed = true;
      const film = await api<Film>(`/api/library/${result.movieId}`);
      setSelected(film); setScore(film.rating_100 === null ? '' : String(film.rating_100));
      if (mode === 'library') await loadLibrary(library?.page ?? 1);
      setNotice({ error: false, text: result.text });
    } catch (error) {
      setNotice({ error: true, text: completed ? 'Операция выполнена, но экран не обновился. Обновите библиотеку.' : message(error) });
      if (error instanceof ApiError && Array.isArray(error.matches)) setMatches(error.matches);
    } finally { actionLock.current = false; setBusy(false); }
  }
  function invalidateSearch() { searchRun.current++; setSearching(false); setResults(null); setSearchError(''); setNotice(null); setMatches([]); }
  async function search(event: FormEvent) {
    event.preventDefault(); const run = ++searchRun.current;
    if (!query.trim()) { setSearchError('Введите название фильма.'); setResults(null); return; }
    setSearching(true); setSearchError(''); setResults(null);
    try {
      const params = new URLSearchParams({ q: query.trim() }); if (year) params.set('year', year);
      const found = await api<{ results: SearchFilm[]; has_more: boolean }>(`/api/movies/search?${params}`);
      if (run === searchRun.current) { setResults(found.results); setMore(found.has_more); }
    } catch (error) { if (run === searchRun.current) setSearchError(message(error)); }
    finally { if (run === searchRun.current) setSearching(false); }
  }
  function add(film: SearchFilm) {
    void action(async () => {
      const result = await api<{ movie_id: number; status: string }>('/api/movies', json({ tmdb_id: film.id }));
      return { movieId: result.movie_id, text: result.status === 'created' ? 'Фильм добавлен в каталог. Просмотр ещё не отмечен.' : 'Фильм уже есть в каталоге; используется существующая запись.' };
    });
  }
  function watch(event: FormEvent) {
    event.preventDefault(); if (!selected) return;
    let rating; try { rating = scoreValue(score, true); } catch (error) { setNotice({ error: true, text: message(error) }); return; }
    const movieId = selected.movie_id;
    void action(async () => {
      await api(`/api/movies/${movieId}/watch`, json(rating === undefined ? {} : { rating_100: rating }));
      return { movieId, text: 'Просмотр сохранён.' };
    });
  }
  function edit(value: number | null) {
    if (!selected) return; const movieId = selected.movie_id;
    void action(async () => {
      await api(`/api/library/${movieId}/rating`, json({ rating_100: value }, 'PATCH'));
      return { movieId, text: value === null ? 'Оценка очищена. Фильм остаётся просмотренным.' : 'Оценка сохранена.' };
    });
  }
  function saveScore(event: FormEvent) {
    event.preventDefault();
    try { edit(scoreValue(score)!); } catch (error) { setNotice({ error: true, text: message(error) }); }
  }
  function reject() {
    if (!selected || selected.tmdb_id === null) return;
    const film = selected;
    void action(async () => {
      await api(`/api/recommendations/reject${film.not_interested ? '/undo' : ''}`, json({ tmdb_id: film.tmdb_id }));
      return { movieId: film.movie_id, text: film.not_interested ? 'Текущий запрет снят; история отклонений сохранена.' : 'Фильм отмечен «Неинтересно». Оценка и просмотр сохранены.' };
    });
  }

  return { query, setQuery, year, setYear, results, more, searching, searchError, libraryQuery, setLibraryQuery, rated, setRated,
    library, libraryBusy, libraryError, selected, selecting, score, setScore, busy, notice, matches,
    search, add, watch, saveScore, edit, reject, choose, refreshLibrary, invalidateSearch,
    filterLibrary() { filters.current = { q: libraryQuery, rated }; refreshLibrary(1); } };
}
