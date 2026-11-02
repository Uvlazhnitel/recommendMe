'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { parseRateSelection } from './rating-draft';
import { detailUrl, readSession, writeSession } from './navigation-state';
import { useListPosition } from './use-list-position';
import { useMovieEditor } from './use-movie-editor';
import { MovieEditor } from './components/movie-editor';
import { useAppNavigation } from './components/navigation-provider';
import { useWatchlist } from './use-watchlist';
import { useWorkbench } from './use-workbench';
import { MoviePoster } from './components/movie-poster';
import { Button, EmptyState, ErrorState, LoadingState, PageHeader } from './components/ui';

export function WatchlistWorkbench() {
  const list = useWatchlist(), search = useWorkbench('rate', undefined, 'watchlist-search');
  const params = useSearchParams(), navigation = useAppNavigation();
  const selection = params.getAll('movie_id');
  const parsed = parseRateSelection(selection.length === 1 ? selection[0] : selection.length ? selection : undefined);
  const selectedId = parsed.movieId;
  const editor = useMovieEditor(selectedId, () => { void list.refresh(); });
  const heading = useRef<HTMLHeadingElement>(null), previousSelection = useRef(selectedId);
  const refresh = list.refresh;
  useEffect(() => {
    if (previousSelection.current !== undefined && selectedId === undefined) void refresh();
    previousSelection.current = selectedId;
  }, [selectedId, refresh]);
  const [adding, setAdding] = useState(() => readSession<boolean>('watchlist-adding', false) === true);
  useEffect(() => { writeSession('watchlist-adding', adding); }, [adding]);
  useListPosition('/watchlist', selectedId === undefined && !list.loading && !parsed.error, 'watchlist-movie-', 'watchlist-heading');
  const loadedMovieId = editor.selected?.movie_id;
  useEffect(() => {
    if (selectedId === undefined || editor.selecting || loadedMovieId === undefined) return;
    heading.current?.focus({ preventScroll: true }); window.scrollTo({ top: 0, behavior: 'instant' });
  }, [selectedId, editor.selecting, loadedMovieId]);
  if (selectedId !== undefined || parsed.error) return <div className="library-details">
    <Button className="library-back" tone="quiet" type="button" disabled={editor.busy} onClick={() => navigation.back('/watchlist')}>← К списку</Button>
    {parsed.error ? <ErrorState>{parsed.error}</ErrorState> : <MovieEditor model={editor} enhanced collection headingRef={heading} feedback={editor.notice ? editor.notice.error ? <ErrorState>{editor.notice.text}</ErrorState> : <p role="status">{editor.notice.text}</p> : null} />}
    {!editor.selected && editor.notice ? <ErrorState>{editor.notice.text}</ErrorState> : null}
    {editor.recoveryMovieId !== null ? <Button tone="quiet" disabled={editor.busy || editor.selecting} onClick={() => void editor.choose(editor.recoveryMovieId!)}>Перечитать фильм</Button> : null}
  </div>;
  return <div className="watchlist-page">
    <PageHeader headingId="watchlist-heading" title="Посмотреть позже" description="Ваш постоянный список — сохраняется при смене подборки." />
    <Button type="button" aria-expanded={adding} onClick={() => setAdding(value => !value)}>{adding ? 'Закрыть поиск' : '+ Добавить фильм'}</Button>
    {adding ? <section className="watchlist-search" aria-label="Добавить фильм в список">
      <form onSubmit={search.search} className="watchlist-search-form"><label>Название на русском или английском<input autoFocus maxLength={200} value={search.query} onChange={event => { search.setQuery(event.target.value); search.invalidateSearch(); }} /></label><Button disabled={search.searching}>Найти</Button></form>
      {search.searching ? <LoadingState>Ищем фильмы…</LoadingState> : null}
      {search.searchError ? <ErrorState>{search.searchError}</ErrorState> : null}
      {search.results?.length === 0 ? <p role="status">Фильмы не найдены. Попробуйте другое название.</p> : null}
      <ul className="watchlist-results">{search.results?.map(film => {
        const saved = list.items.some(item => item.tmdb_id === film.id);
        return <li key={film.id}><MoviePoster path={film.poster_path} title={film.title} sizes="64px" /><div><strong>{film.title}</strong>{film.subtitle ? <span className="movie-subtitle">{film.subtitle}</span> : null}{film.subtitle === undefined && film.original_title && film.original_title !== film.title ? <p>{film.original_title}</p> : null}<p>{film.year ?? 'Год неизвестен'}</p></div>
          <Button tone="quiet" disabled={list.loading || list.pending || saved} onClick={() => void list.save(null, true, film.id)}>{saved ? '✓ В списке' : '+ В список'}</Button></li>;
      })}</ul>
      {search.more && search.results?.length ? <p className="field-help">Показана первая страница TMDB. Уточните название, если нужного фильма нет.</p> : null}
    </section> : null}
    {list.error ? <ErrorState>{list.error}<Button tone="quiet" disabled={list.pending} onClick={() => void list.refresh()}>Обновить список</Button></ErrorState> : null}
    {list.matches.length ? <section aria-label="Возможные совпадения"><h2>Похожие записи в каталоге</h2><p>Новый фильм не добавлен. Записи не объединены. Проверьте существующий вариант:</p><ul>{list.matches.map(film => <li key={film.movie_id}><Link className="text-link" href={detailUrl('/watchlist', film.movie_id)} scroll={false}>{film.title}{film.subtitle ? <span className="movie-subtitle">{film.subtitle}</span> : null} · {film.year ?? 'Год неизвестен'}</Link><Button tone="quiet" disabled={list.pending} onClick={() => void list.save(film.movie_id, true)}>+ В список</Button></li>)}</ul></section> : null}
    {list.loading ? <LoadingState>Загрузка списка…</LoadingState> : !list.items.length && !list.error ? <EmptyState title="Пока ничего не отложено"><p>Добавьте фильм из рекомендаций или найдите его по названию.</p></EmptyState> : null}
    <ul className="watchlist-grid">{list.items.map(film => <li key={film.movie_id}><article className="watchlist-card" aria-label={film.title}>
      <Link id={`watchlist-movie-${film.movie_id}`} href={detailUrl('/watchlist', film.movie_id)} scroll={false}><MoviePoster path={film.poster_path} title={film.title} sizes="(max-width: 767px) 44vw, 200px" /><h2>{film.title}</h2>{film.subtitle ? <span className="movie-subtitle">{film.subtitle}</span> : null}</Link>
      {film.subtitle === undefined && film.original_title && film.original_title !== film.title ? <p className="muted">{film.original_title}</p> : null}<p>{film.year ?? 'Год неизвестен'}</p>
      <p>{film.watched ? 'Уже просмотрен' : 'Не просмотрен'}{film.rating_100 !== null ? ` · ${film.rating_100}/100` : ''}</p>
      <Button tone="quiet" disabled={list.pending} onClick={() => void list.save(film.movie_id, false)}>Убрать из списка</Button>
    </article></li>)}</ul>
  </div>;
}
