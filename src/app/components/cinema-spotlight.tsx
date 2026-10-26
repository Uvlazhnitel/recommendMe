'use client';

import Image, { type StaticImageData } from 'next/image';
import { useState } from 'react';
import { Icon } from './icons';
import { MoviePoster } from './movie-poster';
import { Button, EmptyState, ErrorState, LoadingState, PageHeader } from './ui';
import { tmdbImage } from '@/lib/movie-images';

export type SpotlightMovie = {
  tmdb_id: number; title: string; year: number | null; genres: string[]; runtime: number | null;
  poster_path?: string | null; backdrop_path?: string | null; poster?: StaticImageData; backdrop?: StaticImageData;
  heading_lines?: string[];
  why_fit: string | null; possible_mismatch: string | null;
};
export type SpotlightState = 'ready' | 'loading' | 'empty' | 'error';

export function CinemaSpotlight({ movies, state = 'ready', demonstration = false, onMore, onWatch, onReject, notice, busy = false,
  moreLabel = 'Ещё рекомендации', errorMessage, emptyTitle = 'Пока нет рекомендаций', emptyDescription = 'Новая подборка появится здесь после успешного подбора.' }: {
  movies: SpotlightMovie[]; state?: SpotlightState; demonstration?: boolean; onMore?: () => void;
  onWatch?: (movie: SpotlightMovie) => void; onReject?: (movie: SpotlightMovie) => void; notice?: string; busy?: boolean;
  moreLabel?: string; errorMessage?: string; emptyTitle?: string; emptyDescription?: string;
}) {
  const [selectedId, setSelectedId] = useState(movies[0]?.tmdb_id);
  const selected = movies.find(movie => movie.tmdb_id === selectedId) ?? movies[0];
  const loading = state === 'loading';
  const moreButton = (className: string) => <Button className={className} disabled={!onMore || loading || busy} onClick={onMore}>{moreLabel}</Button>;
  return <>
    <PageHeader title="Что посмотреть?" description={demonstration ? 'Демонстрационная подборка' : undefined} />
    {moreButton('desktop-more')}
    {state === 'error' ? <ErrorState>{errorMessage ?? 'Не удалось получить подборку. Сохранённые данные не изменены.'}</ErrorState> : null}
    {state === 'empty' || !selected ? <EmptyState title={emptyTitle}><p>{emptyDescription}</p></EmptyState> : <>
      <article className="spotlight" aria-label={`Рекомендация: ${selected.title}`}>
        <div className="spotlight-film">
          <CinemaBackdrop key={selected.tmdb_id} movie={selected} />
          <div className="film-identity">
            <MoviePoster key={selected.tmdb_id} image={selected.poster} path={selected.poster_path} title={selected.title} className="spotlight-poster" sizes="(max-width: 767px) 96px, (max-width: 1023px) 145px, 144px" priority />
            <div className="film-heading"><h2>{selected.heading_lines ? selected.heading_lines.map((line, i) => <span className="title-line" key={i}>{line}</span>) : selected.title}</h2><p className="film-meta">{[selected.year, selected.genres.length ? selected.genres.join(', ') : null, selected.runtime === null ? null : `${selected.runtime} мин`].filter(value => value !== null).join(' · ')}</p></div>
          </div>
        </div>
        <div className="recommendation-reading" aria-live="polite">
          <section><h3>Почему мне понравится</h3><p>{selected.why_fit ?? 'Объяснение для этого фильма не сохранено.'}</p></section>
          <section className="possible-mismatch"><h3>Что может не подойти</h3><p>{selected.possible_mismatch ?? 'Отдельное пояснение не сохранено.'}</p></section>
          <div className="movie-actions"><Button tone="light" disabled={!onWatch || loading || busy} onClick={() => onWatch?.(selected)}><Icon name="check" />Посмотрел</Button><Button tone="quiet" disabled={!onReject || loading || busy} onClick={() => onReject?.(selected)}>Неинтересно</Button></div>
        </div>
      </article>
      <section className="collection" aria-labelledby="collection-heading">
        <div className="collection-heading"><h2 id="collection-heading">В этой подборке</h2><span>{movies.length} {movies.length === 1 ? 'фильм' : movies.length < 5 ? 'фильма' : 'фильмов'}</span></div>
        <ul className="movie-rail">{movies.map(movie => <li key={movie.tmdb_id}>
          <button className="movie-choice" type="button" aria-pressed={movie.tmdb_id === selected.tmdb_id} onClick={() => setSelectedId(movie.tmdb_id)} aria-label={`Выбрать ${movie.title}`}>
            <MoviePoster image={movie.poster} path={movie.poster_path} title={movie.title} className="rail-poster" sizes="(max-width: 767px) 120px, (max-width: 1023px) 180px, 20vw" />
            <span className="rail-title">{movie.title}</span><span className="rail-year">{movie.year ?? 'Год неизвестен'}</span>
          </button>
        </li>)}</ul>
      </section>
    </>}
    {notice ? <p className="preview-notice" role="status">{notice}</p> : null}
    {moreButton('mobile-more')}
    {loading ? <div className="selection-loading"><LoadingState>Подбираем следующую подборку…</LoadingState><div className="progress-track"><span /></div></div> : null}
  </>;
}

function CinemaBackdrop({ movie }: { movie: SpotlightMovie }) {
  const [failed, setFailed] = useState(false);
  const source = movie.backdrop ?? tmdbImage(movie.backdrop_path, 'w1280');
  return <div className="cinema-backdrop">{source && !failed ?
    <Image src={source} alt={`Кадр из фильма «${movie.title}»`} fill sizes="(min-width: 1024px) 65vw, 100vw" preload onError={() => setFailed(true)} /> :
    <div className="backdrop-fallback"><Icon name="film" /></div>}</div>;
}
