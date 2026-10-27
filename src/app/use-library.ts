'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, message } from './workbench-api';
import type { Film } from './use-movie-editor';
import { libraryReadUrl, libraryUrl, type LibraryState } from './library-state';

export type LibraryPageData = { items: Film[]; total: number; page: number; limit: number; total_pages: number };
export function useLibrary(state: LibraryState, invalid: boolean, movieId: number | undefined, replace: (url: string) => void) {
  const [data, setData] = useState<LibraryPageData | null>(null), [loadedKey, setLoadedKey] = useState(''), [error, setError] = useState('');
  const [total, setTotal] = useState<number | null>(null), [totalError, setTotalError] = useState(false);
  const [revision, setRevision] = useState(0), [totalRevision, setTotalRevision] = useState(0), [updated, setUpdated] = useState(false);
  const run = useRef(0), clampAfterWrite = useRef(false);
  const view = useRef({ state, movieId, replace });
  useEffect(() => { view.current = { state, movieId, replace }; }, [state, movieId, replace]);
  const readUrl = libraryReadUrl(state);
  const requestKey = `${readUrl}:${revision}`;
  useEffect(() => {
    if (invalid) return;
    const controller = new AbortController(), id = ++run.current;
    api<LibraryPageData>(readUrl, { signal: controller.signal }).then(value => {
      if (controller.signal.aborted || id !== run.current) return;
      if (clampAfterWrite.current && value.page > Math.max(1, value.total_pages)) {
        const latest = view.current;
        latest.replace(libraryUrl({ ...latest.state, page: Math.max(1, value.total_pages) }, latest.movieId));
      }
      clampAfterWrite.current = false;
      setData(value); setError('');
    }).catch(cause => { if (!controller.signal.aborted && id === run.current) setError(message(cause)); })
      .finally(() => { if (!controller.signal.aborted && id === run.current) setLoadedKey(requestKey); });
    return () => controller.abort();
  }, [readUrl, invalid, requestKey]);
  useEffect(() => {
    const controller = new AbortController();
    api<LibraryPageData>('/api/library?limit=1', { signal: controller.signal }).then(value => {
      if (!controller.signal.aborted) { setTotal(value.total); setTotalError(false); }
    }).catch(() => { if (!controller.signal.aborted) setTotalError(true); });
    return () => controller.abort();
  }, [totalRevision]);
  const afterSave = useCallback(() => { clampAfterWrite.current = true; setUpdated(true); setRevision(value => value + 1); }, []);
  const refresh = useCallback(() => { setRevision(value => value + 1); setTotalRevision(value => value + 1); }, []);
  return { data, loading: !invalid && loadedKey !== requestKey, error, total, totalError, updated, afterSave, refresh };
}
