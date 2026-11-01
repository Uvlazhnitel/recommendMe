'use client';

import Image from 'next/image';
import { useState, type ReactNode, type Ref } from 'react';
import { tmdbImage } from '@/lib/movie-images';
import type { Film, MovieEditorModel } from '../use-movie-editor';
import { ratingDraft } from '../rating-draft';
import { Icon } from './icons';
import { MoviePoster } from './movie-poster';
import { RatingControl } from './rating-control';
import { Button } from './ui';

export function LibraryFilmPage({ model: m, film, headingRef, feedback }: {
  model: MovieEditorModel; film: Film; headingRef?: Ref<HTMLHeadingElement>; feedback?: ReactNode;
}) {
  const [failedBackdrop, setFailedBackdrop] = useState<string | null>(null);
  const [feedbackAt, setFeedbackAt] = useState<'rating' | 'review' | 'watchlist' | 'reject'>('rating');
  const source = tmdbImage(film.backdrop_path, 'w1280'), hasBackdrop = source !== null && source !== failedBackdrop;
  const draft = ratingDraft(m.score), changed = draft.invalid || draft.value !== film.rating_100;
  const duration = film.runtime_minutes ? [Math.floor(film.runtime_minutes / 60) ? `${Math.floor(film.runtime_minutes / 60)} ч` : '', film.runtime_minutes % 60 ? `${film.runtime_minutes % 60} мин` : ''].filter(Boolean).join(' ') : null;
  const notice = (place: typeof feedbackAt) => place === feedbackAt ? <div className="film-feedback" aria-live="polite">{feedback}</div> : null;
  return <section className="movie-editor rate-editor library-editor library-film-page" aria-label="Выбранный фильм" aria-busy={m.busy}>
    <header className={`film-header${hasBackdrop ? ' has-backdrop' : ''}`}>
      {hasBackdrop ? <div className="film-backdrop"><Image src={source} alt={`Кадр из фильма «${film.title}»`} fill sizes="(min-width: 1280px) 1200px, 100vw" preload onError={() => setFailedBackdrop(source)} /></div> : null}
      <div className="editor-film library-film-identity">
        <MoviePoster path={film.poster_path} title={film.title} fallbackTitle sizes="(max-width: 767px) 96px, 180px" />
        <div className="library-film-identity-copy">
          <h2 ref={headingRef} tabIndex={-1}>{film.title}</h2>
          {film.subtitle ? <p className="movie-subtitle">{film.subtitle}</p> : null}
          {film.subtitle === undefined && film.original_title && film.original_title !== film.title ? <p className="editor-original-title">{film.original_title}</p> : null}
          <p className="film-metadata">{[film.year ?? 'Год неизвестен', duration, film.genres?.map(genre => genre.name).join(' · ')].filter(Boolean).join(' · ')}</p>
          {film.directors?.length ? <p className="film-directors">Режиссёр: {film.directors.map(person => person.name).join(', ')}</p> : null}
          {film.tmdb_id !== null ? <a className="film-source text-link" href={`https://www.themoviedb.org/movie/${film.tmdb_id}`} target="_blank" rel="noopener noreferrer">Открыть в TMDB <Icon name="arrow-up-right" /></a> : null}
          {film.legacy_marks?.map((mark, index) => <p className="film-legacy muted" key={index}>Отметка из старого списка: {mark.sentiment === 'liked' ? 'понравилось' : mark.sentiment === 'disliked' ? 'не понравилось' : mark.sentiment === 'mixed' ? 'смешанно' : 'отношение неизвестно'}{mark.superseded ? ' · заменена личной оценкой' : ''}</p>)}
          {film.legacy_unconfirmed ? <details className="film-legacy"><summary>Об источнике</summary><p>Название и год сохранены из старого списка. Совпадение с каталогом пока не подтверждено.</p></details> : null}
          {film.external_ratings?.map((rating, index) => <p className="film-legacy muted" key={index}>Внешний рейтинг: {rating.raw} · {rating.source ?? 'Источник неизвестен'}</p>)}
        </div>
      </div>
    </header>
    <div className="film-content">
      <section className="editor-overview film-overview"><h3>О фильме</h3><p>{film.overview || 'Описание пока отсутствует.'}</p></section>
      <aside className="film-rating-column" aria-label="Просмотр и оценка">
        <fieldset className="film-rating-panel" disabled={m.busy}>
          <legend className="sr-only">Просмотр и оценка {film.title}</legend>
          <form className="score-form" onSubmit={event => { setFeedbackAt('rating'); if (film.watched) m.saveScore(event); else m.watch(event); }}>
            <RatingControl value={m.score} onChange={m.setScore} watched={film.watched} summary={<div className="film-saved-status">
              <p className="watch-status">{film.watched ? 'Уже просмотрен' : 'Не просмотрен'}{film.rating_source === 'letterboxd' ? ' · Оценка из Letterboxd' : film.rating_source === 'manual' ? ' · Ваша оценка' : ''}</p>
              {changed ? <p className="current-score">Сохранено: {film.rating_100 === null ? 'Без оценки' : `${film.rating_100} / 100`} · Есть несохранённые изменения</p> : null}
            </div>} />
            <div className="score-actions"><Button disabled={draft.invalid || (film.watched && draft.value === null)}>{m.pending === 'watch' ? 'Сохраняем просмотр…' : m.pending === 'rating' ? 'Сохраняем оценку…' : film.watched ? 'Сохранить оценку' : 'Подтвердить просмотр'}</Button>
              {film.watched ? <Button tone="quiet" type="button" onClick={() => { setFeedbackAt('rating'); m.edit(null); }}>{m.pending === 'clear' ? 'Очищаем…' : 'Очистить оценку'}</Button> : null}</div>
          </form>
          {notice('rating')}
          {!film.watched ? <p className="field-help">Без оценки тоже можно подтвердить просмотр. Он сохранится в вашей истории.</p> : null}
        </fieldset>
        {film.watchlist !== undefined ? <Button className="film-watchlist" tone="quiet" type="button" disabled={m.busy} onClick={() => { setFeedbackAt('watchlist'); m.toggleWatchlist(); }}><Icon name={film.watchlist ? 'check' : 'bookmark'} />{film.watchlist ? 'Убрать из «Посмотреть позже»' : 'Посмотреть позже'}</Button> : null}
        {notice('watchlist')}
      </aside>
      <fieldset className="film-review-panel" disabled={m.busy}>
        <legend className="sr-only">Впечатления о фильме {film.title}</legend>
        <label className="review-field" htmlFor="library-review">Впечатления о фильме<span className="muted">Необязательно</span></label>
        <textarea id="library-review" name="review_text" rows={5} maxLength={2000} value={m.review ?? ''} onChange={event => m.setReview(event.target.value)} placeholder="Что понравилось, а что не подошло именно в этом фильме?" aria-describedby="library-review-help" />
        <p className="film-review-count">{(m.review ?? '').length} / 2000</p>
        <p className="field-help" id="library-review-help">{film.watched ? 'Сохраняются отдельно от оценки. Чтобы удалить, очистите поле и сохраните.' : 'Текст сохранится после подтверждения просмотра.'}</p>
        {film.watched ? <Button tone="quiet" type="button" onClick={() => { setFeedbackAt('review'); m.saveReview(); }}>{m.pending === 'review' ? 'Сохраняем впечатления…' : 'Сохранить впечатления'}</Button> : null}
        {notice('review')}
      </fieldset>
    </div>
    <fieldset className="film-recommendation-controls" disabled={m.busy}>
      <legend className="sr-only">Управление рекомендациями</legend>
      <h3>{film.not_interested ? 'Скрыт из рекомендаций' : 'Рекомендации'}</h3>
      <Button tone="quiet" type="button" disabled={film.tmdb_id === null} onClick={() => { setFeedbackAt('reject'); m.reject(); }}>{m.pending === 'reject' ? 'Сохраняем…' : film.not_interested ? 'Снять «Неинтересно»' : 'Неинтересно'}</Button>
      <p className="field-help">{film.tmdb_id === null ? 'Нужен подтверждённый идентификатор TMDB.' : film.not_interested ? 'Текущий запрет можно снять. История отклонения сохранится.' : 'Оценка и просмотр не изменятся.'}</p>
      {notice('reject')}
    </fieldset>
  </section>;
}
