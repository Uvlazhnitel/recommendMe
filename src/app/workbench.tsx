'use client';

import { RateWorkbench } from './rate-workbench';
import { useWorkbench } from './use-workbench';
import { MovieEditor } from './components/movie-editor';
import { MoviePoster } from './components/movie-poster';
import { Button, EmptyState, ErrorState, LoadingState } from './components/ui';

export default function Workbench({ mode, initialMovieId, initialMovieError }: { mode: 'rate' | 'library'; initialMovieId?: number; initialMovieError?: string }) {
  const m = useWorkbench(mode, initialMovieId);
  if (mode === 'rate') return <RateWorkbench model={m} initialMovieId={initialMovieId} initialMovieError={initialMovieError} />;
  return <div className="workbench">
    <div className="workbench-results">
      <section aria-label="Библиотека просмотренного">
        <form className="search-form library-search" onSubmit={e => { e.preventDefault(); m.filterLibrary(); }}>
          <label className="query-field">Поиск в библиотеке<input name="library-query" placeholder="Название фильма" maxLength={200} value={m.libraryQuery} onChange={e => m.setLibraryQuery(e.target.value)} /></label>
          <label>Оценки<select value={m.rated} onChange={e => m.setRated(e.target.value)}><option value="all">Все просмотренные</option><option value="true">С оценкой</option><option value="false">Без оценки</option></select></label>
          <Button disabled={m.busy || m.libraryBusy}>Найти в библиотеке</Button>
        </form>
        {m.libraryBusy ? <LoadingState>Загрузка библиотеки…</LoadingState> : null}
        {m.libraryError ? <ErrorState>{m.libraryError}</ErrorState> : null}
        {m.library ? <>
          <div className="results-bar"><p className="results-caption">{m.library.total} фильмов · Страница {m.library.page} из {m.library.total_pages || 1}</p><Button tone="quiet" type="button" disabled={m.busy || m.libraryBusy} onClick={() => m.refreshLibrary(m.library?.page ?? 1)}>Обновить</Button></div>
          {!m.library.items.length ? <EmptyState title="Пока ничего не найдено"><p>Измените поиск или фильтр оценок.</p></EmptyState> : null}
          <ul className="film-list">{m.library.items.map(film => <li key={film.movie_id}>
            <MoviePoster path={film.poster_path} title={film.title} sizes="72px" />
            <div className="film-list-copy"><h2><button className="title-button" type="button" disabled={m.busy} onClick={() => { void m.choose(film.movie_id); }} aria-label={`Открыть ${film.title}`}>{film.title}</button></h2><p className="muted">{film.year ?? 'Год неизвестен'}</p></div>
            <span className={`list-score ${film.rating_100 === null ? 'unrated' : ''}`}>{film.rating_100 === null ? 'Без оценки' : <>{film.rating_100}<small>/100</small></>}</span>
          </li>)}</ul>
          <div className="pagination"><Button tone="quiet" type="button" disabled={m.busy || m.libraryBusy || m.library.page <= 1} onClick={() => m.refreshLibrary(m.library!.page - 1)}>Предыдущая</Button><Button tone="quiet" type="button" disabled={m.busy || m.libraryBusy || m.library.page >= m.library.total_pages} onClick={() => m.refreshLibrary(m.library!.page + 1)}>Следующая</Button></div>
        </> : null}
      </section>
    </div>
    <div className="workbench-detail">
      <MovieEditor model={m} />
      {m.busy ? <LoadingState>Сохранение…</LoadingState> : null}
      {m.notice ? m.notice.error ? <ErrorState>{m.notice.text}</ErrorState> : <p className="success-state" role="status">{m.notice.text}</p> : null}
      {m.recoveryMovieId !== null ? <Button tone="quiet" disabled={m.busy || m.selecting} onClick={() => { void m.choose(m.recoveryMovieId!); }}>Перечитать фильм</Button> : null}
      {m.matches.length ? <div className="duplicate-matches"><h3>Похожие записи в вашей истории</h3><ul>{m.matches.map(film => <li key={film.movie_id}>Локальный ID {film.movie_id}: {film.title} ({film.year ?? '?'})</li>)}</ul></div> : null}
    </div>
  </div>;
}
