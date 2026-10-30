'use client';
import { profileFetch } from './profile-requests';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { RecommendationBatch } from '@/lib/recommendation-batches';
import type { recommendationState } from '@/lib/recommendation-service';
import { HomeGallery, HomeLibrary } from './components/home-gallery';
import { DEFAULT_PREFERENCES, parsePreferences, preferencesLabel, type RecommendationPreferences } from '@/lib/recommendation-preferences';
import type { RecommendationMovie } from '@/lib/recommendation-batches';
import { Button, LoadingState } from './components/ui';
import { Icon } from './components/icons';
import { NewSelectionDialog } from './components/new-selection-dialog';
import { api, json } from './workbench-api';

type State = ReturnType<typeof recommendationState>;
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try { response = await profileFetch(url, { ...init, cache: 'no-store' }); }
  catch { throw new Error('Ответ сервера не получен. Состояние можно проверить обновлением; новый платный запрос автоматически не отправляется.'); }
  let body;
  try { body = await response.json(); } catch { throw new Error('Не удалось прочитать ответ приложения. Новый платный запрос автоматически не отправляется.'); }
  if (!response.ok) throw new Error(typeof body.message === 'string' ? body.message : 'Не удалось выполнить операцию. Предыдущая подборка сохранена.');
  return body as T;
}
export default function RecommendationScreen() {
  const router = useRouter();
  const [step, setStep] = useState<'preferences' | 'confirmation'>('preferences');
  const [preferences, setPreferences] = useState<RecommendationPreferences>({ ...DEFAULT_PREFERENCES });
  const [confirmation, setConfirmation] = useState<RecommendationPreferences>({ ...DEFAULT_PREFERENCES });
  function changePreferences(patch: Partial<RecommendationPreferences>) { setPreferences(current => ({ ...current, ...patch })); }
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
  const remoteRunning = (data?.generation.state === 'running' || data?.generation.state === 'busy_other');
  useEffect(() => {
    if (!remoteRunning && !generating) return;
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 2500);
    return () => clearInterval(timer);
  }, [remoteRunning, generating, refresh]);
  const busy = generating || Boolean(remoteRunning), blocked = data?.generation.state === 'interrupted';
  const canGenerate = data?.readiness.can_generate && !blocked && !data.generation.recoverable_save;
  async function start(requestId: string, saveOnly = false, snapshot = confirmation) {
    if (lock.current || busy) return;
    lock.current = true; setGenerating(true); setError(''); setNotice(''); setUndoId(null);
    try {
      const value = await request<{ batch: RecommendationBatch | null }>(`/api/recommendations/generate${saveOnly ? '?save_only=1' : ''}`, json({ request_id: requestId, confirmed: true, ...(!saveOnly ? { preferences: snapshot } : {}) }));
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
  function configure() {
    if (lock.current || busy || !canGenerate) return;
    setStep('preferences');
    dialog.current?.showModal();
    dialog.current?.querySelector('.selection-dialog-content')?.scrollTo({ top: 0 });
  }
  async function reject(tmdbId: number, undo = false) {
    if (lock.current || busy) return false;
    lock.current = true; setActing(true); setError('');
    try {
      await api(`/api/recommendations/reject${undo ? '/undo' : ''}`, json({ tmdb_id: tmdbId }));
      if (mounted.current) { setUndoId(undo ? null : tmdbId); setNotice(undo ? 'Текущий запрет снят. История отклонения сохранена.' : 'Фильм скрыт'); }
      await refresh();
      return true;
    } catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : 'Не удалось изменить отклонение.'); return false; }
    finally { lock.current = false; if (mounted.current) setActing(false); }
  }
  function watch(movie: RecommendationMovie) {
    const local = data?.batch?.movies.find(row => row.tmdb_id === movie.tmdb_id);
    if (local && !lock.current && !busy) router.push(`/rate?movie_id=${local.movie_id}`);
  }
  const readinessMessage = data?.readiness.reason === 'configuration_missing' ? 'Для подбора нужно настроить OpenAI, модель и TMDB на сервере.' :
    data?.readiness.reason === 'ratings_missing' ? 'Для подбора нужны текущие оценки фильмов.' :
    data?.readiness.reason === 'profile_unavailable' ? 'Сохранённый профиль вкуса пока недоступен. Персональные рекомендации пока недоступны.' : '';
  const remaining = data?.batch?.movies.length ?? 0;
  return <div className="home-v2">
    <header className="home-v2-heading"><div><h1 id="home-results-title" tabIndex={-1}>{data?.batch ? 'Твоя подборка' : 'Что посмотрим?'}</h1>
      <p className="home-batch-label" aria-live="polite">{data?.batch ? `${preferencesLabel(data.batch.preferences ?? null)} · ${remaining} ${remaining === 1 ? 'фильм' : remaining > 1 && remaining < 5 ? 'фильма' : 'фильмов'}` : 'Персональное кино под твой вкус и настроение'}</p></div>
      <Button id="new-selection" disabled={!canGenerate || busy || acting} onClick={configure}><Icon name="plus" />Новая подборка</Button>
    </header>
    {initialLoading ? <LoadingState>Загрузка сохранённой подборки…</LoadingState> : null}
    {error ? <div className="error-state" role="alert">{error}</div> : null}
    {busy ? <div className="selection-loading home-generation-progress"><LoadingState>Подбираем следующую подборку…</LoadingState><div className="progress-track"><span /></div></div> : null}
    {readinessMessage ? <p className="readiness-notice">{readinessMessage}</p> : null}
    {!error && data?.generation.state === 'failed' ? <p className="readiness-notice" role="status">Последняя попытка подбора завершилась ошибкой. Предыдущая подборка сохранена. Новый платный запуск требует отдельного подтверждения.</p> : null}
    {blocked ? <p className="readiness-notice" role="status">Предыдущий подбор не завершился. Нужно проверить процесс сервера и оставшуюся блокировку; автоматического повтора не будет.</p> : null}
    {data?.generation.recoverable_save && data.generation.request_id ? <Button tone="light" disabled={busy || acting} onClick={() => { void start(data.generation.request_id!, true); }}>Повторить сохранение без AI</Button> : null}
    {error && !busy ? <Button tone="quiet" disabled={acting} onClick={() => { setError(''); void refresh(); }}>Проверить состояние</Button> : null}
    {notice ? <div className="recommendation-notice" role="status"><p>{notice}</p>{undoId !== null ? <Button tone="quiet" disabled={acting || busy} onClick={() => { void reject(undoId, true); }}>Отменить</Button> : null}</div> : null}
    {!initialLoading ? <HomeGallery batch={data?.batch ?? null} error={error} busy={busy || acting} onWatch={watch} onReject={movie => reject(movie.tmdb_id)} /> : null}
    {data?.readiness.profile_refresh?.status === 'refresh_recommended' ? <details className="home-about"><summary>О подборке</summary><p>Профиль вкуса стоит обновить. Новые оценки и выбранные впечатления учитываются в подборе; автоматического пересчёта нет.</p></details> : null}
    <NewSelectionDialog busy={busy || acting} dialog={dialog} step={step} preferences={preferences} confirmation={confirmation} onChange={changePreferences}
      onContinue={() => { if (lock.current || busy || acting) return; setConfirmation(parsePreferences(preferences)); setStep('confirmation'); }} onBack={() => setStep('preferences')}
      onConfirm={() => { dialog.current?.close(); void start(crypto.randomUUID()); }} />
    {data?.home ? <HomeLibrary home={data.home} /> : null}
  </div>;
}
