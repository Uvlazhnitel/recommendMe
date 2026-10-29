'use client';

import { useRef, useState, type KeyboardEvent } from 'react';
import Link from 'next/link';
import type { RecommendationBatch, RecommendationMovie } from '@/lib/recommendation-batches';
import type { readHomeSummary } from '@/lib/home-summary';
import { Icon } from './icons';
import { MoviePoster } from './movie-poster';
import { Button, EmptyState } from './ui';

export function trapDialogFocus(event: KeyboardEvent<HTMLDialogElement>) {
  if (event.key !== 'Tab') return;
  const buttons = event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled)');
  const first = buttons[0], last = buttons[buttons.length - 1], active = document.activeElement;
  if (event.shiftKey && (active === first || !Array.from(buttons).includes(active as HTMLElement))) { event.preventDefault(); last?.focus(); }
  else if (!event.shiftKey && active === last) { event.preventDefault(); first?.focus(); }
}
export function HomeGallery({ batch, busy, onWatch, onReject, error = '' }: {
  batch: RecommendationBatch | null; busy: boolean; error?: string;
  onWatch: (movie: RecommendationMovie) => void; onReject: (movie: RecommendationMovie) => Promise<boolean>;
}) {
  const dialog = useRef<HTMLDialogElement>(null), trigger = useRef<HTMLButtonElement | null>(null);
  const [selected, setSelected] = useState<RecommendationMovie | null>(null);
  const movies = batch?.movies ?? [];
  function open(movie: RecommendationMovie, button: HTMLButtonElement) {
    trigger.current = button; setSelected(movie); dialog.current?.showModal();
  }
  function close() { dialog.current?.close(); }
  return <section className="home-results" aria-label="Фильмы подборки" aria-busy={busy}>
    {batch && batch.total_count < 5 && movies.length > 0 ? <p className="home-short-batch">Подборка получилась короче пяти фильмов. Строгие ограничения не ослаблялись.</p> : null}
    {movies.length ? <ul className="recommendation-grid">{movies.map(movie => <li key={movie.tmdb_id}>
      <article className="gallery-card" aria-label={`Рекомендация: ${movie.title}`}>
        <button className="gallery-open" type="button" onClick={e => open(movie, e.currentTarget)} aria-label={`Подробнее: ${movie.title}`}>
          <MoviePoster path={movie.poster_path} title={movie.title} sizes="(max-width: 359px) 90vw, (max-width: 767px) 45vw, (max-width: 1279px) 30vw, 18vw" />
          <span className="gallery-copy"><span className="gallery-title">{movie.title}</span><span className="gallery-meta">{movie.year} · {movie.runtime} мин</span>
            <span className="gallery-details"><span className="gallery-details-desktop">Почему этот фильм</span><span className="gallery-details-mobile">Подробнее</span> <Icon name="arrow-up-right" /></span>
          </span>
        </button>
      </article>
    </li>)}</ul> : <EmptyState title={batch ? 'Эту подборку ты уже разобрал' : 'Найдём кино для твоего вечера'}>
      <p>{batch ? 'Можно выбрать другое настроение и найти что-то новое' : 'Нажми «Новая подборка», выбери настроение и пожелания. Здесь появятся персональные рекомендации.'}</p>
    </EmptyState>}
    <dialog ref={dialog} className="movie-explanation" aria-labelledby="explanation-title" onKeyDown={trapDialogFocus} onClose={() => {
      if (trigger.current?.isConnected) trigger.current.focus();
      else document.getElementById('home-results-title')?.focus();
    }}>
      {selected ? <><div className="explanation-heading"><div><p className="gallery-meta">{selected.year} · {selected.runtime} мин</p><h2 id="explanation-title">{selected.title}</h2></div><Button tone="quiet" aria-label="Закрыть объяснение" onClick={close}><Icon name="close" /></Button></div>
        <p className="gallery-genres">{selected.genres.join(' · ')}</p>
        <section><h3>Почему мне понравится</h3><p>{selected.why_fit}</p></section>
        <section className="possible-mismatch"><h3>Что может не подойти</h3><p>{selected.possible_mismatch}</p></section>
        {error ? <p className="explanation-error" role="alert">{error}</p> : null}
        <div className="movie-actions"><Button tone="light" disabled={busy} onClick={() => { close(); onWatch(selected); }}>Посмотрел</Button>
          <Button tone="quiet" disabled={busy} onClick={async () => { if (await onReject(selected)) close(); }}>Неинтересно</Button></div></> : null}
    </dialog>
  </section>;
}
export function HomeLibrary({ home }: { home: ReturnType<typeof readHomeSummary> }) {
  return <><section className="home-favorites" aria-labelledby="favorites-title"><div className="home-section-heading"><div><h2 id="favorites-title">Из любимого</h2></div><Link href="/library" className="text-link">В библиотеку <Icon name="arrow-up-right" /></Link></div>
    {home.favorites.length ? <ul className="favorites-grid">{home.favorites.slice(0, 4).map(movie => <li key={movie.movie_id}><Link href={`/library?movie_id=${movie.movie_id}`} className="favorite-card" aria-label={`Открыть ${movie.title}, ${movie.rating_100} из 100`}>
      <MoviePoster path={movie.poster_path} title={movie.title} sizes="(max-width: 767px) 48px, 72px" /><span className="favorite-copy"><span className="favorite-title">{movie.title}</span><span className="favorite-meta">{movie.year ?? 'Год неизвестен'}</span><strong>{movie.rating_100}/100</strong></span>
    </Link></li>)}</ul> : <p className="home-small-empty">Здесь появятся просмотренные фильмы с твоими высокими оценками. <Link href="/library" className="text-link">Открыть библиотеку</Link></p>}</section>
    <footer className="home-stats" aria-label="Статистика библиотеки">{home.stats.watched} просмотрено · {home.stats.rated} оценено</footer></>;
}
