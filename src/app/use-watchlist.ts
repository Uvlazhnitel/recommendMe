'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Film } from './use-movie-editor';
import type { LibraryPageData } from './use-library';
import { api, ApiError, json, message, type Match } from './workbench-api';

// The existing personal library API is the only source of watchlist membership.
export function useWatchlist() {
  const [items, setItems] = useState<Film[]>([]), [loading, setLoading] = useState(true);
  const [error, setError] = useState(''), [pending, setPending] = useState(false);
  const [matches, setMatches] = useState<Match[]>([]);
  const lock = useRef(false), alive = useRef(false), sequence = useRef(0);
  const readAbort = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    const run = ++sequence.current, controller = new AbortController();
    readAbort.current?.abort(); readAbort.current = controller;
    try {
      const films: Film[] = [];
      for (let page = 1; ; page++) {
        const result = await api<LibraryPageData>(`/api/library?watchlist=true&limit=100&page=${page}`, { signal: controller.signal });
        films.push(...result.items);
        if (page >= result.total_pages) break;
      }
      if (alive.current && !controller.signal.aborted && sequence.current === run) { setItems(films); setError(''); }
    } catch (cause) { if (alive.current && !controller.signal.aborted && sequence.current === run) setError(message(cause)); }
    finally { if (alive.current && !controller.signal.aborted && sequence.current === run) setLoading(false); }
  }, []);
  useEffect(() => {
    alive.current = true; const initial = setTimeout(() => { void refresh(); }, 0);
    const focus = () => { if (document.visibilityState === 'visible' && !lock.current) void refresh(); };
    window.addEventListener('focus', focus); document.addEventListener('visibilitychange', focus);
    return () => { alive.current = false; clearTimeout(initial); readAbort.current?.abort(); window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', focus); };
  }, [refresh]);
  async function save(movieId: number | null, value: boolean, tmdbId?: number) {
    if (lock.current) return;
    lock.current = true; setPending(true); setError(''); setMatches([]);
    sequence.current++; readAbort.current?.abort();
    try {
      const id = movieId ?? (await api<{ movie_id: number }>('/api/movies', json({ tmdb_id: tmdbId }))).movie_id;
      await api(`/api/library/${id}/watchlist`, json({ watchlist: value }, 'PATCH'));
      if (alive.current) await refresh();
    } catch (cause) {
      if (alive.current) { setError(message(cause)); if (cause instanceof ApiError) setMatches(cause.matches ?? []); }
    } finally { lock.current = false; if (alive.current) { setPending(false); setLoading(false); } }
  }
  return { items, loading, error, pending, matches, refresh, save };
}
