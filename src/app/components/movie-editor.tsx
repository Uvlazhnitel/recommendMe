'use client';

import type { ReactNode, Ref } from 'react';
import type { MovieEditorModel } from '../use-movie-editor';
import { ratingDraft } from '../rating-draft';
import { MoviePoster } from './movie-poster';
import { RatingControl } from './rating-control';
import { Button, LoadingState } from './ui';

export function MovieEditor({ model: m, enhanced = false, collection = false, headingRef, feedback }: { model: MovieEditorModel; enhanced?: boolean; collection?: boolean; headingRef?: Ref<HTMLHeadingElement>; feedback?: ReactNode }) {
  const film = m.selected;
  if (m.selecting || m.pending === 'select') return <LoadingState>Загрузка фильма…</LoadingState>;
  if (!film) return <section className="selection-hint">{enhanced ? <><h2>Ваше впечатление о фильме</h2><p>Выберите фильм в результатах. Здесь появятся детали и шкала оценки.</p></> : <p>Выберите фильм, чтобы открыть детали и сохранить оценку.</p>}</section>;
  const draft = ratingDraft(m.score);
  const posterAndTitle = <div className="editor-film"><MoviePoster path={film.poster_path} title={film.title} fallbackTitle={collection} sizes={collection ? '(max-width: 767px) 100px, 180px' : enhanced ? '(max-width: 767px) 88px, (max-width: 1023px) 120px, 96px' : '(max-width: 600px) 80px, 120px'} />
    <div><p className="muted">{[film.year ?? 'Год неизвестен', ...(enhanced ? [film.runtime_minutes ? `${film.runtime_minutes} мин` : null] : [])].filter(Boolean).join(' · ')}</p>
      <h2 ref={headingRef} tabIndex={enhanced ? -1 : undefined}>{film.title}</h2>
      {collection && film.original_title && film.original_title !== film.title ? <p className="editor-original-title">{film.original_title}</p> : null}
      {enhanced && film.genres?.length ? <p className="editor-genres">{film.genres.map(genre => genre.name).join(' · ')}</p> : null}
      {collection && film.directors?.length ? <p className="muted">{film.directors.map(person => person.name).join(', ')}</p> : null}
      <p className="watch-status">{film.watched ? 'Уже просмотрен' : enhanced ? 'Не просмотрен' : 'Просмотр не отмечен'}</p>
      <p className="current-score">{enhanced ? <span>Сохранено: </span> : null}{film.rating_100 === null ? 'Без оценки' : <><strong>{film.rating_100}</strong><span> / 100</span></>}</p>
      <p className="muted">{film.rating_source === 'letterboxd' ? 'Оценка из Letterboxd' : film.rating_source === 'manual' ? 'Ваша оценка' : 'Оценка ещё не назначена'}</p>
    </div>
  </div>;
  const ratingFields = enhanced ? <RatingControl value={m.score} onChange={m.setScore} watched={film.watched} /> :
    <label>{film.watched ? 'Новая оценка' : <>Оценка просмотра <span className="muted">(необязательно)</span></>}<span className="input-with-suffix"><input name={film.watched ? 'edit-rating' : 'watch-rating'} type="number" min={0} max={100} step={1} required={film.watched} value={m.score} onChange={e => m.setScore(e.target.value)} /><span>/ 100</span></span></label>;
  return <section className={`movie-editor ${enhanced ? 'rate-editor' : ''}${collection ? ' library-editor' : ''}`} aria-label="Выбранный фильм" aria-busy={m.busy}>
    {posterAndTitle}
    {!enhanced && film.overview ? <p className="film-overview">{film.overview}</p> : null}
    <fieldset disabled={m.busy}>
      <legend className="sr-only">Просмотр и оценка {film.title}</legend>
      <form className="score-form" onSubmit={film.watched ? m.saveScore : m.watch}>
        {ratingFields}
        <label className="review-field">Впечатления о фильме <span className="muted">(необязательно)</span>
          <textarea name="review_text" rows={5} maxLength={2000} value={m.review ?? ''} onChange={e => m.setReview(e.target.value)}
            placeholder="Что понравилось, а что не подошло именно в этом фильме?" aria-describedby="review-help" />
        </label>
        <p className="field-help" id="review-help">{(m.review ?? '').length}/2000 · {film.watched ? 'Текст сохраняется отдельной кнопкой. Чтобы удалить, очистите поле и сохраните.' : 'Текст сохранится после подтверждения просмотра.'}</p>
        {film.watched ? <Button tone="quiet" type="button" onClick={m.saveReview}>{m.pending === 'review' ? 'Сохраняем впечатления…' : 'Сохранить впечатления'}</Button> : null}
        <div className="score-actions"><Button disabled={enhanced && (draft.invalid || (film.watched && draft.value === null))}>
          {m.pending === 'watch' ? 'Сохраняем просмотр…' : m.pending === 'rating' ? 'Сохраняем оценку…' : film.watched ? 'Сохранить оценку' : 'Подтвердить просмотр'}
        </Button>{film.watched ? <Button tone="quiet" type="button" onClick={() => m.edit(null)}>{m.pending === 'clear' ? 'Очищаем…' : 'Очистить оценку'}</Button> : null}</div>
      </form>
      {enhanced ? feedback : null}
      <p className="field-help">{film.watched ? 'Пустое поле не очищает сохранённую оценку. Для этого есть отдельная кнопка.' : 'Без оценки тоже можно подтвердить просмотр. Он сохранится в вашей истории.'}</p>
      <div className="rejection-controls">
        {enhanced ? <h3>{film.not_interested ? 'Скрыт из рекомендаций' : 'Не хотите видеть в рекомендациях?'}</h3> : null}
        <Button tone="quiet" type="button" disabled={film.tmdb_id === null} onClick={m.reject}>{m.pending === 'reject' ? 'Сохраняем…' : film.not_interested ? 'Снять «Неинтересно»' : 'Неинтересно'}</Button>
        <p className="field-help">{film.tmdb_id === null ? 'Нужен подтверждённый TMDB ID.' : film.not_interested ? 'Текущий запрет можно снять. История отклонения сохранится.' : 'Это отдельное решение: оценка и факт просмотра не изменятся.'}</p>
      </div>
    </fieldset>
    {enhanced && film.overview ? <div className="editor-overview"><h3>О фильме</h3><p>{film.overview}</p></div> : null}
    {collection && !film.overview ? <div className="editor-overview"><h3>О фильме</h3><p>Описание пока отсутствует. Просмотр и оценка сохранены в вашей библиотеке.</p></div> : null}
  </section>;
}
