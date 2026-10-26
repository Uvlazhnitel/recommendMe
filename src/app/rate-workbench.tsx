'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { useWorkbench } from './use-workbench';
import { MovieEditor } from './components/movie-editor';
import { MoviePoster } from './components/movie-poster';
import { Icon } from './components/icons';
import { Button, EmptyState, ErrorState, LoadingState } from './components/ui';

type Model = ReturnType<typeof useWorkbench>;
export function RateWorkbench({ model: m, initialMovieId, initialMovieError }: { model: Model; initialMovieId?: number; initialMovieError?: string }) {
  const [editing, setEditing] = useState(initialMovieId !== undefined);
  const [linkErrorDismissed, setLinkErrorDismissed] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null), detail = useRef<HTMLDivElement>(null), resultsHeading = useRef<HTMLHeadingElement>(null), queryInput = useRef<HTMLInputElement>(null);
  const selection = m.selected?.movie_id;
  useEffect(() => {
    if (!editing || selection === undefined) return;
    heading.current?.focus({ preventScroll: true });
    if (window.matchMedia('(max-width: 1023px)').matches) detail.current?.scrollIntoView({ block: 'start', behavior: 'instant' });
  }, [editing, selection]);
  useEffect(() => {
    if (!editing && m.results !== null) resultsHeading.current?.focus({ preventScroll: true });
  }, [editing, m.results]);
  function back() {
    setEditing(false);
    requestAnimationFrame(() => {
      const selectedButton = m.selected?.tmdb_id ? document.getElementById(`rate-result-${m.selected.tmdb_id}`) : null;
      (selectedButton ?? queryInput.current)?.focus();
    });
  }
  const operationText = m.pending === 'watch' ? 'Сохраняем просмотр…' : m.pending === 'rating' ? 'Сохраняем оценку…' : m.pending === 'clear' ? 'Очищаем оценку…' : m.pending === 'reject' ? 'Сохраняем решение…' : null;
  const noticeInDetail = editing || m.selected !== null;
  const feedback = <>
    {operationText ? <LoadingState>{operationText}</LoadingState> : null}
    {noticeInDetail ? <OperationNotice model={m} onReload={() => { if (m.recoveryMovieId !== null) void m.choose(m.recoveryMovieId); }} /> : null}
    {(m.watchConfirmed || (initialMovieId !== undefined && m.selected?.watched)) && !m.busy ? <Link className="rate-return" href="/">Вернуться к рекомендациям →</Link> : null}
  </>;
  return <div className={`rate-workbench ${editing ? 'is-editing' : ''}`}>
    {initialMovieError && !linkErrorDismissed ? <ErrorState>{initialMovieError}</ErrorState> : null}
    <form className="rate-search" onSubmit={event => { setEditing(false); setLinkErrorDismissed(true); void m.search(event); }} aria-label="Поиск фильмов в TMDB">
      <label className="rate-query">Название фильма<span className="rate-query-input"><Icon name="film" /><input ref={queryInput} name="tmdb-query" placeholder="Какой фильм вы посмотрели?" maxLength={200} disabled={m.busy} value={m.query} onChange={e => { m.setQuery(e.target.value); m.invalidateSearch(); }} /></span></label>
      <label className="rate-year">Год <span className="muted">необязательно</span><input name="tmdb-year" inputMode="numeric" type="number" min={1} max={9999} step={1} placeholder="Любой" disabled={m.busy} value={m.year} onChange={e => { m.setYear(e.target.value); m.invalidateSearch(); }} /></label>
      <Button disabled={m.searching || m.busy}>{m.searching ? 'Ищем…' : 'Найти фильм'}</Button>
    </form>
    <div className="rate-layout">
      <section className="rate-results" aria-label="Результаты поиска" aria-busy={m.searching || m.pending === 'select'}>
        {m.searching ? <LoadingState>Ищем в TMDB…</LoadingState> : null}
        {m.searchError ? <ErrorState>{m.searchError}</ErrorState> : null}
        {m.results === null && !m.searching && !m.searchError ? <div className="rate-intro"><Icon name="film" /><h2>Фильм закончился.<br />Впечатление осталось.</h2><p>Найдите его по названию и сохраните свою оценку. Или просто отметьте просмотр — к оценке можно вернуться позже.</p></div> : null}
        {m.results !== null ? <h2 ref={resultsHeading} tabIndex={-1} className="rate-results-heading">{m.results.length ? `Найдено: ${m.results.length}` : 'Результаты поиска'}{m.results.length ? <span>Выберите нужный фильм по названию и году</span> : null}</h2> : null}
        {m.results?.length === 0 ? <EmptyState title="Фильм не найден"><p>Попробуйте другое название или уберите год.</p></EmptyState> : null}
        <ul className="rate-result-list">{m.results?.map(film => {
          const selected = m.selected?.tmdb_id === film.id;
          return <li key={film.id}><button id={`rate-result-${film.id}`} className={`rate-result ${selected ? 'selected' : ''}`} type="button" aria-pressed={selected} disabled={m.busy || m.selecting}
            onClick={async () => { if (await m.add(film)) setEditing(true); }} aria-label={`Выбрать ${film.title} (${film.year ?? 'год неизвестен'})`}>
            <MoviePoster path={film.poster_path} title={film.title} sizes="(max-width: 767px) 64px, 80px" />
            <span className="rate-result-copy"><span className="rate-result-title">{film.title}</span><span className="rate-result-year">{film.year ?? 'Год неизвестен'}</span>
              {film.original_title && film.original_title !== film.title ? <span className="rate-original-title">{film.original_title}</span> : null}</span>
            <span className="rate-select-label">{m.addingId === film.id ? 'Загрузка…' : selected ? 'Выбран' : 'Выбрать'}</span>
          </button></li>;
        })}</ul>
        {m.more && m.results?.length ? <p className="field-help">Показана первая страница TMDB. Уточните название или год, если нужного фильма нет.</p> : null}
        {!noticeInDetail ? <OperationNotice model={m} onReload={() => { setEditing(true); if (m.recoveryMovieId !== null) void m.choose(m.recoveryMovieId); }} /> : null}
      </section>
      <div ref={detail} className="rate-detail">
        {editing ? <Button className="rate-back" tone="quiet" type="button" disabled={m.busy || m.selecting} onClick={back}>← {m.results === null ? 'К поиску' : 'К результатам'}</Button> : null}
        <MovieEditor model={m} enhanced headingRef={heading} feedback={feedback} />
        {!m.selected ? feedback : null}
      </div>
    </div>
  </div>;
}
function OperationNotice({ model: m, onReload }: { model: Model; onReload: () => void }) {
  return <>
    {m.notice ? m.notice.error ? <ErrorState>{m.notice.text}</ErrorState> : <p className="success-state" role="status">{m.notice.text}</p> : null}
    {m.matches.length ? <section className="rate-duplicates" aria-label="Возможные совпадения"><h3>Похожие записи в вашей истории</h3><p>Новая запись не добавлена. Эти фильмы не связаны автоматически.</p><ul>{m.matches.map(film => <li key={film.movie_id}><strong>{film.title}</strong><span>{film.year ?? 'Год неизвестен'} · Локальный ID {film.movie_id}</span></li>)}</ul></section> : null}
    {m.recoveryMovieId !== null ? <Button tone="quiet" type="button" disabled={m.busy || m.selecting} onClick={onReload}>Перечитать фильм</Button> : null}
  </>;
}
