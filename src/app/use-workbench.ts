'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { readSession, writeSession } from './navigation-state';
import { api, json, message } from './workbench-api';
import { useMovieEditor } from './use-movie-editor';
export type { Film } from './use-movie-editor';
export type SearchFilm = { id: number; title: string; subtitle?: string | null; original_title: string | null; year: number | null; poster_path: string | null };

export function useWorkbench(_mode: 'rate', initialMovieId?: number, sessionKey = 'rate-search') {
  const editor = useMovieEditor(initialMovieId);
  const [restored] = useState(() => {
    const saved = readSession<{ query: string; year: string; results: SearchFilm[] | null; more: boolean } | null>(sessionKey, null);
    return saved && typeof saved.query === 'string' && typeof saved.year === 'string' && (saved.results === null || (Array.isArray(saved.results) && saved.results.every(film => film && Number.isSafeInteger(film.id) && typeof film.title === 'string'))) ? saved : null;
  });
  const [query, setQuery] = useState(restored?.query ?? ''), [year, setYear] = useState(restored?.year ?? '');
  const [results, setResults] = useState<SearchFilm[] | null>(restored?.results ?? null), [more, setMore] = useState(restored?.more ?? false);
  useEffect(() => { writeSession(sessionKey, { query, year, results, more }); }, [sessionKey, query, year, results, more]);
  const [searching, setSearching] = useState(false), [searchError, setSearchError] = useState('');
  const searchRun = useRef(0), alive = useRef(false), searchAbort = useRef<AbortController | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; searchAbort.current?.abort(); }; }, []);
  function invalidateSearch() { searchRun.current++; searchAbort.current?.abort(); setSearching(false); setResults(null); setSearchError(''); editor.clearFeedback(); }
  async function search(event: FormEvent) {
    event.preventDefault(); if (editor.isLocked()) return;
    editor.cancelDetails();
    const run = ++searchRun.current, controller = new AbortController(); searchAbort.current?.abort(); searchAbort.current = controller;
    editor.clearFeedback();
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
  async function add(film: SearchFilm) {
    if (editor.isLocked()) return null;
    let movieId: number | null = null;
    editor.setAddingId(film.id);
    const success = await editor.action('select', async () => {
      const result = await api<{ movie_id: number; status: string }>('/api/movies', json({ tmdb_id: film.id }));
      movieId = result.movie_id;
      return { movieId: result.movie_id, text: result.status === 'created' ? 'Фильм добавлен в каталог. Просмотр ещё не отмечен.' : 'Фильм уже есть в каталоге; используется существующая запись.' };
    });
    return success ? movieId : null;
  }
  return { ...editor, query, setQuery, year, setYear, results, more, searching, searchError, search, add, invalidateSearch };
}
