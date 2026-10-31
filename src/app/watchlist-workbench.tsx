'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useWatchlist } from './use-watchlist';
import { useWorkbench } from './use-workbench';
import { MoviePoster } from './components/movie-poster';
import { Button, EmptyState, ErrorState, LoadingState, PageHeader } from './components/ui';

export function WatchlistWorkbench() {
  const list = useWatchlist(), search = useWorkbench('rate');
  const [adding, setAdding] = useState(false);
  return <div className="watchlist-page">
    <PageHeader title="Посмотреть позже" description="Ваш постоянный список — сохраняется при смене подборки." />
    <Button type="button" aria-expanded={adding} onClick={() => setAdding(value => !value)}>{adding ? 'Закрыть поиск' : '+ Добавить фильм'}</Button>
    {adding ? <section className="watchlist-search" aria-label="Добавить фильм в список">
      <form onSubmit={search.search} className="watchlist-search-form"><label>Название на русском или английском<input autoFocus maxLength={200} value={search.query} onChange={event => { search.setQuery(event.target.value); search.invalidateSearch(); }} /></label><Button disabled={search.searching}>Найти</Button></form>
      {search.searching ? <LoadingState>Ищем фильмы…</LoadingState> : null}
      {search.searchError ? <ErrorState>{search.searchError}</ErrorState> : null}
      {search.results?.length === 0 ? <p role="status">Фильмы не найдены. Попробуйте другое название.</p> : null}
      <ul className="watchlist-results">{search.results?.map(film => {
        const saved = list.items.some(item => item.tmdb_id === film.id);
        return <li key={film.id}><MoviePoster path={film.poster_path} title={film.title} sizes="64px" /><div><strong>{film.title}</strong>{film.original_title && film.original_title !== film.title ? <p>{film.original_title}</p> : null}<p>{film.year ?? 'Год неизвестен'}</p></div>
          <Button tone="quiet" disabled={list.loading || list.pending || saved} onClick={() => void list.save(null, true, film.id)}>{saved ? '✓ В списке' : '+ В список'}</Button></li>;
      })}</ul>
      {search.more && search.results?.length ? <p className="field-help">Показана первая страница TMDB. Уточните название, если нужного фильма нет.</p> : null}
    </section> : null}
    {list.error ? <ErrorState>{list.error}<Button tone="quiet" disabled={list.pending} onClick={() => void list.refresh()}>Обновить список</Button></ErrorState> : null}
    {list.matches.length ? <section aria-label="Возможные совпадения"><h2>Похожие записи в каталоге</h2><p>Новый фильм не добавлен. Записи не объединены. Проверьте существующий вариант:</p><ul>{list.matches.map(film => <li key={film.movie_id}><Link className="text-link" href={`/library?movie_id=${film.movie_id}`}>{film.title} · {film.year ?? 'Год неизвестен'}</Link><Button tone="quiet" disabled={list.pending} onClick={() => void list.save(film.movie_id, true)}>+ В список</Button></li>)}</ul></section> : null}
    {list.loading ? <LoadingState>Загрузка списка…</LoadingState> : !list.items.length && !list.error ? <EmptyState title="Пока ничего не отложено"><p>Добавьте фильм из рекомендаций или найдите его по названию.</p></EmptyState> : null}
    <ul className="watchlist-grid">{list.items.map(film => <li key={film.movie_id}><article className="watchlist-card" aria-label={film.title}>
      <Link href={`/library?movie_id=${film.movie_id}`}><MoviePoster path={film.poster_path} title={film.title} sizes="(max-width: 767px) 44vw, 200px" /><h2>{film.title}</h2></Link>
      {film.original_title && film.original_title !== film.title ? <p className="muted">{film.original_title}</p> : null}<p>{film.year ?? 'Год неизвестен'}</p>
      <p>{film.watched ? 'Уже просмотрен' : 'Не просмотрен'}{film.rating_100 !== null ? ` · ${film.rating_100}/100` : ''}</p>
      <Button tone="quiet" disabled={list.pending} onClick={() => void list.save(film.movie_id, false)}>Убрать из списка</Button>
    </article></li>)}</ul>
  </div>;
}
