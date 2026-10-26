'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { RecommendationBatch } from '@/lib/recommendation-batches';
import type { recommendationState } from '@/lib/recommendation-service';
import { CinemaSpotlight, type SpotlightMovie } from './components/cinema-spotlight';
import { Button, LoadingState, PageHeader } from './components/ui';
import { api, json } from './workbench-api';

type State = ReturnType<typeof recommendationState>;
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try { response = await fetch(url, { ...init, cache: 'no-store' }); }
  catch { throw new Error('Ответ сервера не получен. Состояние можно проверить обновлением; новый платный запрос автоматически не отправляется.'); }
  let body;
  try { body = await response.json(); } catch { throw new Error('Не удалось прочитать ответ приложения. Новый платный запрос автоматически не отправляется.'); }
  if (!response.ok) throw new Error(typeof body.message === 'string' ? body.message : 'Не удалось выполнить операцию. Предыдущая подборка сохранена.');
  return body as T;
}
export default function RecommendationScreen() {
  const router = useRouter();
  const [data, setData] = useState<State | null>(null), [initialLoading, setInitialLoading] = useState(true);
  const [generating, setGenerating] = useState(false), [acting, setActing] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [undoId, setUndoId] = useState<number | null>(null);
  const lock = useRef(false), getSequence = useRef(0), mounted = useRef(false), dialog = useRef<HTMLDialogElement>(null);
  const refresh = useCallback(() => {
    const sequence = ++getSequence.current;
    return request<State>('/api/recommendations').then(value => {
      if (mounted.current && sequence === getSequence.current) setData(value);
    }).catch(failure => { if (mounted.current && sequence === getSequence.current) setError(failure instanceof Error ? failure.message : 'Не удалось загрузить подборку.'); })
      .finally(() => { if (mounted.current && sequence === getSequence.current) setInitialLoading(false); });
  }, []);
  useEffect(() => {
    mounted.current = true; void refresh();
    const visible = () => { if (document.visibilityState === 'visible') void refresh(); };
    window.addEventListener('focus', visible); document.addEventListener('visibilitychange', visible);
    return () => { mounted.current = false; window.removeEventListener('focus', visible); document.removeEventListener('visibilitychange', visible); };
  }, [refresh]);
  const remoteRunning = data?.generation.state === 'running';
  useEffect(() => {
    if (!remoteRunning && !generating) return;
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 2500);
    return () => clearInterval(timer);
  }, [remoteRunning, generating, refresh]);
  const busy = generating || Boolean(remoteRunning), blocked = data?.generation.state === 'interrupted';
  const canGenerate = data?.readiness.can_generate && !blocked && !data.generation.recoverable_save;
  async function start(requestId: string, saveOnly = false) {
    if (lock.current) return;
    lock.current = true; setGenerating(true); setError(''); setNotice(''); setUndoId(null);
    try {
      const value = await request<{ batch: RecommendationBatch | null }>(`/api/recommendations/generate${saveOnly ? '?save_only=1' : ''}`, json({ request_id: requestId, confirmed: true }));
      if (mounted.current) {
        setData(current => current ? { ...current, batch: value.batch } : current);
        setNotice(saveOnly ? 'Подборка сохранена. Новых запросов AI не было.' : 'Новая подборка сохранена.');
      }
    } catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : 'Подбор не завершён.'); }
    finally {
      await refresh();
      lock.current = false; if (mounted.current) setGenerating(false);
    }
  }
  function confirm() {
    if (lock.current || busy || !canGenerate) return;
    dialog.current?.showModal();
  }
  async function reject(tmdbId: number, undo = false) {
    if (lock.current || busy) return;
    lock.current = true; setActing(true); setError('');
    try {
      await api(`/api/recommendations/reject${undo ? '/undo' : ''}`, json({ tmdb_id: tmdbId }));
      if (mounted.current) { setUndoId(undo ? null : tmdbId); setNotice(undo ? 'Текущий запрет снят. История отклонения сохранена.' : 'Фильм скрыт из подборки. Просмотр и оценка не изменены.'); }
      await refresh();
    } catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : 'Не удалось изменить отклонение.'); }
    finally { lock.current = false; if (mounted.current) setActing(false); }
  }
  function watch(movie: SpotlightMovie) {
    const local = data?.batch?.movies.find(row => row.tmdb_id === movie.tmdb_id);
    if (local && !lock.current && !busy) router.push(`/rate?movie_id=${local.movie_id}`);
  }
  if (initialLoading) return <><PageHeader title="Что посмотреть?" /><LoadingState>Загрузка сохранённой подборки…</LoadingState></>;
  const readinessMessage = data?.readiness.reason === 'configuration_missing' ? 'Для подбора нужно настроить OpenAI, модель и TMDB на сервере.' :
    data?.readiness.reason === 'ratings_missing' ? 'Для подбора нужны текущие оценки фильмов.' :
    data?.readiness.reason === 'profile_unavailable' ? 'Сохранённый профиль вкуса пока недоступен. Подготовьте его отдельно через CLI.' : '';
  return <>
    <CinemaSpotlight movies={data?.batch?.movies ?? []} state={busy ? 'loading' : error ? 'error' : 'ready'} busy={acting}
      moreLabel={data?.batch ? 'Ещё рекомендации' : 'Подобрать фильмы'} onMore={canGenerate ? confirm : undefined}
      errorMessage={error} emptyTitle={data?.batch ? 'Вы посмотрели или скрыли фильмы этой подборки' : data ? 'Пока нет сохранённых подборок' : 'Подборка недоступна'}
      emptyDescription={data?.batch ? 'История сохранена. Можно явно запросить новую подборку.' : 'Нажмите «Подобрать фильмы», чтобы начать персональный подбор. Он использует платный OpenAI API.'}
      onWatch={watch} onReject={movie => { void reject(movie.tmdb_id); }} />
    {notice ? <div className="recommendation-notice" role="status"><p>{notice}</p>{undoId !== null ? <Button tone="quiet" disabled={acting || busy} onClick={() => { void reject(undoId, true); }}>Отменить</Button> : null}</div> : null}
    {readinessMessage ? <p className="readiness-notice">{readinessMessage}</p> : null}
    {!error && data?.generation.state === 'failed' ? <p className="readiness-notice" role="status">Последняя попытка подбора завершилась ошибкой. Предыдущая подборка сохранена. Новый платный запуск требует отдельного подтверждения.</p> : null}
    {blocked ? <p className="readiness-notice" role="status">Предыдущий подбор не завершился. Нужно проверить процесс сервера и оставшуюся блокировку; автоматического повтора не будет.</p> : null}
    {data?.generation.recoverable_save && data.generation.request_id ? <Button tone="light" disabled={busy || acting} onClick={() => { void start(data.generation.request_id!, true); }}>Повторить сохранение без AI</Button> : null}
    {data?.readiness.profile_refresh?.status === 'refresh_recommended' ? <p className="readiness-notice">Профиль вкуса стоит обновить. Новые оценки уже учитываются в подборе; автоматического пересчёта нет.</p> : null}
    {error && !busy ? <Button tone="quiet" disabled={acting} onClick={() => { setError(''); void refresh(); }}>Проверить состояние</Button> : null}
    <dialog ref={dialog} className="paid-confirmation" aria-labelledby="paid-heading" aria-describedby="paid-description">
      <h2 id="paid-heading">Начать персональный подбор?</h2>
      <p id="paid-description">Подбор использует платный OpenAI API — обычно два запроса. Стоимость зависит от модели и объёма данных. Автоматического повтора после ошибки не будет.</p>
      <div><Button tone="quiet" onClick={() => dialog.current?.close()}>Отмена</Button><Button onClick={() => { dialog.current?.close(); void start(crypto.randomUUID()); }}>Да, подобрать</Button></div>
    </dialog>
  </>;
}
