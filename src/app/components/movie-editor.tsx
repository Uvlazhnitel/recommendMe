'use client';

import type { useWorkbench } from '../use-workbench';
import { MoviePoster } from './movie-poster';
import { Button, LoadingState } from './ui';

export function MovieEditor({ model: m }: { model: ReturnType<typeof useWorkbench> }) {
  const film = m.selected;
  if (m.selecting) return <LoadingState>Загрузка фильма…</LoadingState>;
  if (!film) return <section className="selection-hint"><p>Выберите фильм, чтобы открыть детали и сохранить оценку.</p></section>;
  return <section className="movie-editor" aria-label="Выбранный фильм">
    <div className="editor-film"><MoviePoster path={film.poster_path} title={film.title} sizes="(max-width: 600px) 80px, 120px" />
      <div><p className="muted">{film.year ?? 'Год неизвестен'}</p><h2>{film.title}</h2>
        <p>{film.watched ? 'Уже просмотрен' : 'Просмотр не отмечен'}</p>
        <p className="current-score">{film.rating_100 === null ? 'Без оценки' : <><strong>{film.rating_100}</strong><span> / 100</span></>}</p>
        <p className="muted">{film.rating_source === 'letterboxd' ? 'Оценка из Letterboxd' : film.rating_source === 'manual' ? 'Ваша оценка' : 'Оценка ещё не назначена'}</p>
      </div>
    </div>
    {film.overview ? <p className="film-overview">{film.overview}</p> : null}
    <fieldset disabled={m.busy}>
      <legend className="sr-only">Просмотр и оценка {film.title}</legend>
      {film.watched ? <form className="score-form" onSubmit={m.saveScore}>
        <label>Новая оценка <span className="input-with-suffix"><input name="edit-rating" type="number" min={0} max={100} step={1} required value={m.score} onChange={e => m.setScore(e.target.value)} /><span>/ 100</span></span></label>
        <Button>Сохранить оценку</Button><Button tone="quiet" type="button" onClick={() => m.edit(null)}>Очистить оценку</Button>
      </form> : <form className="score-form" onSubmit={m.watch}>
        <label>Оценка просмотра <span className="muted">(необязательно)</span><span className="input-with-suffix"><input name="watch-rating" type="number" min={0} max={100} step={1} value={m.score} onChange={e => m.setScore(e.target.value)} /><span>/ 100</span></span></label>
        <Button>Подтвердить просмотр</Button>
      </form>}
      <p className="field-help">{film.watched ? 'Очистка оценки сохраняет факт просмотра.' : 'Можно сохранить просмотр без оценки. Ноль — настоящая оценка.'}</p>
      <div className="rejection-controls"><Button tone="quiet" type="button" disabled={film.tmdb_id === null} onClick={m.reject}>{film.not_interested ? 'Снять «Неинтересно»' : 'Неинтересно'}</Button>
        <p className="field-help">{film.tmdb_id === null ? 'Нужен подтверждённый TMDB ID.' : film.not_interested ? 'Фильм скрыт из будущих рекомендаций. Оценка сохранена.' : 'Скрыть из рекомендаций, сохранив просмотр и оценку.'}</p>
      </div>
    </fieldset>
  </section>;
}
