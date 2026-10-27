'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, json, message, scoreValue, type Match } from './workbench-api';

export type Film = { movie_id: number; tmdb_id: number | null; title: string; year: number | null; watched: boolean;
  rating_100: number | null; rating_source: string; not_interested: boolean; original_rating_stars: number | null; poster_path: string | null;
  original_title?: string | null; tmdb_title?: string | null; directors?: { id: number; name: string }[] | null; overview?: string | null; runtime_minutes?: number | null; genres?: { id: number; name: string }[] | null };
type Operation = 'select' | 'watch' | 'rating' | 'clear' | 'reject';

// One controller for local selection and explicit writes on both rating screens.
export function useMovieEditor(initialMovieId?: number, onSaved?: () => void) {
  const [selected, setSelected] = useState<Film | null>(null), [selecting, setSelecting] = useState(initialMovieId !== undefined), [score, setScore] = useState('');
  const [pending, setPending] = useState<Operation | null>(null), [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null), [matches, setMatches] = useState<Match[]>([]);
  const [recoveryMovieId, setRecoveryMovieId] = useState<number | null>(null), [watchConfirmed, setWatchConfirmed] = useState(false);
  const [addingId, setAddingId] = useState<number | null>(null);
  const [loadedInitialId, setLoadedInitialId] = useState<number | undefined>();
  const [initialSelection, setInitialSelection] = useState(initialMovieId);
  // Closing and reopening the same ID is a new read, not a completed old selection.
  if (initialSelection !== initialMovieId) {
    setInitialSelection(initialMovieId); setLoadedInitialId(undefined);
  }
  const detailRun = useRef(0), actionLock = useRef(false), alive = useRef(false);
  const detailAbort = useRef<AbortController | null>(null), saved = useRef(onSaved);
  const busy = pending !== null;
  useEffect(() => { saved.current = onSaved; }, [onSaved]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; detailAbort.current?.abort(); }; }, []);
  useEffect(() => {
    if (initialMovieId === undefined) return;
    const run = ++detailRun.current, controller = new AbortController(); detailAbort.current = controller;
    api<Film>(`/api/library/${initialMovieId}`, { signal: controller.signal }).then(film => {
      if (run === detailRun.current && !controller.signal.aborted) {
        setSelected(film); setScore(film.rating_100 === null ? '' : String(film.rating_100)); setNotice(null); setMatches([]); setRecoveryMovieId(null);
      }
    }).catch(error => { if (!controller.signal.aborted && run === detailRun.current) { setSelected(null); setNotice({ error: true, text: message(error) }); setRecoveryMovieId(initialMovieId); } })
      .finally(() => { if (!controller.signal.aborted && run === detailRun.current) { setSelecting(false); setLoadedInitialId(initialMovieId); } });
    return () => controller.abort();
  }, [initialMovieId]);
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
      const result = await operation(); completedId = result.movieId; saved.current?.();
      if (!alive.current) return false;
      if (kind === 'watch') setWatchConfirmed(true);
      const controller = new AbortController(); detailAbort.current = controller;
      const film = await api<Film>(`/api/library/${result.movieId}`, { signal: controller.signal });
      if (!alive.current) return false;
      setSelected(film); setScore(film.rating_100 === null ? '' : String(film.rating_100));
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
  function cancelDetails() { ++detailRun.current; detailAbort.current?.abort(); setLoadedInitialId(initialMovieId); setSelecting(false); setRecoveryMovieId(null); }
  function clearFeedback() { setNotice(null); setMatches([]); }
  const initialLoading = initialMovieId !== undefined && initialMovieId !== loadedInitialId;
  return { selected: initialLoading ? null : selected, selecting: selecting || initialLoading, score, setScore, busy, pending, notice, matches, recoveryMovieId, watchConfirmed, addingId, setAddingId,
    choose, action, watch, saveScore, edit, reject, cancelDetails, clearFeedback, setNotice, isLocked: () => actionLock.current };
}
export type MovieEditorModel = ReturnType<typeof useMovieEditor>;
