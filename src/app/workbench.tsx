'use client';

import { useWorkbench } from './use-workbench';
import { MovieEditor } from './components/movie-editor';
import { MoviePoster } from './components/movie-poster';
import { Button, EmptyState, ErrorState, LoadingState } from './components/ui';

export default function Workbench({ mode }: { mode: 'rate' | 'library' }) {
  const m = useWorkbench(mode);
  return <div className="workbench">
    <div className="workbench-results">
      {mode === 'rate' ? <section aria-label="Поиск фильмов">
        <form className="search-form" onSubmit={m.search}>
          <label className="query-field">Название фильма<input name="tmdb-query" placeholder="Например, Perfect Days" maxLength={200} value={m.query} onChange={e => { m.setQuery(e.target.value); m.invalidateSearch(); }} /></label>
          <label className="year-field">Год <span className="muted">(необязательно)</span><input name="tmdb-year" type="number" min={1} max={9999} step={1} placeholder="2023" value={m.year} onChange={e => { m.setYear(e.target.value); m.invalidateSearch(); }} /></label>
          <Button disabled={m.searching || m.busy}>Найти в TMDB</Button>
        </form>
        {m.searching ? <LoadingState>Поиск…</LoadingState> : null}
        {m.searchError ? <ErrorState>{m.searchError}</ErrorState> : null}
        {m.results?.length === 0 ? <EmptyState title="Фильмы не найдены"><p>Попробуйте другое название или уточните год.</p></EmptyState> : null}
        {m.results && m.results.length > 1 ? <p className="results-caption">Выберите нужный фильм по названию и году.</p> : null}
        <ul className="film-list">{m.results?.map(film => <li key={film.id}>
          <MoviePoster path={film.poster_path} title={film.title} sizes="72px" />
          <div className="film-list-copy"><h2>{film.title}</h2><p className="muted">{film.year ?? 'Год неизвестен'}{film.original_title && film.original_title !== film.title ? ` · ${film.original_title}` : ''}</p></div>
          <Button tone="quiet" type="button" disabled={m.busy} onClick={() => m.add(film)} aria-label={`Выбрать и добавить ${film.title} (${film.year ?? '?'})`}>Выбрать</Button>
        </li>)}</ul>
        {m.results && m.more ? <p className="field-help">Показана первая страница. Уточните название или год.</p> : null}
        {m.results === null && !m.searching && !m.searchError ? <div className="search-intro"><h2>Начните с названия</h2><p>Выберите фильм в результатах, затем отметьте просмотр. Добавление в каталог само по себе не меняет вашу историю.</p></div> : null}
      </section> : <section aria-label="Библиотека просмотренного">
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
      </section>}
    </div>
    <div className="workbench-detail">
      <MovieEditor model={m} />
      {m.busy ? <LoadingState>Сохранение…</LoadingState> : null}
      {m.notice ? m.notice.error ? <ErrorState>{m.notice.text}</ErrorState> : <p className="success-state" role="status">{m.notice.text}</p> : null}
      {m.matches.length ? <div className="duplicate-matches"><h3>Похожие записи в вашей истории</h3><ul>{m.matches.map(film => <li key={film.movie_id}>Локальный ID {film.movie_id}: {film.title} ({film.year ?? '?'})</li>)}</ul></div> : null}
    </div>
  </div>;
}
