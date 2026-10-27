'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Button, EmptyState, ErrorState, LoadingState, PageHeader } from './components/ui';
import { MoviePoster } from './components/movie-poster';
import { MovieEditor } from './components/movie-editor';
import { Icon } from './components/icons';
import { useMovieEditor } from './use-movie-editor';
import { useLibrary } from './use-library';
import { defaultLibraryState, libraryScore, librarySorts, libraryUrl, parseLibraryState, type LibraryState } from './library-state';

const positionKey = (url: string) => `recommendMe:library:${url}`;
function remember(url: string, id?: number) {
  try { sessionStorage.setItem(positionKey(url), JSON.stringify({ y: window.scrollY, id })); } catch { /* Browsing still works when storage is disabled. */ }
}
function remembered(url: string): { y: number; id?: number } | null {
  try { const value = JSON.parse(sessionStorage.getItem(positionKey(url)) ?? 'null');
    return value && Number.isFinite(value.y) && value.y >= 0 ? value : null;
  } catch { return null; }
}
export function LibraryWorkbench() {
  const router = useRouter(), params = useSearchParams(), raw = params.toString();
  const parsed = useMemo(() => parseLibraryState(new URLSearchParams(raw)), [raw]);
  const { state, movieId, error: parameterError } = parsed, baseUrl = libraryUrl(state);
  const collection = useLibrary(state, Boolean(parameterError), movieId, url => router.replace(url, { scroll: false }));
  const editor = useMovieEditor(parameterError ? undefined : movieId, collection.afterSave);
  const heading = useRef<HTMLHeadingElement>(null), results = useRef<HTMLHeadingElement>(null);
  const intent = useRef<'results' | 'restore' | null>(null), previousMovie = useRef(movieId);
  const [lastSelected, setLastSelected] = useState<number | undefined>();
  const selectedId = editor.selected?.movie_id;

  useEffect(() => {
    if (previousMovie.current !== undefined && movieId === undefined) intent.current = 'restore';
    previousMovie.current = movieId;
    if (movieId !== undefined) return;
    if (collection.loading || parameterError) return;
    const saved = remembered(baseUrl), target = intent.current;
    const frame = requestAnimationFrame(() => {
      if (target === 'results') {
        results.current?.focus({ preventScroll: true }); results.current?.scrollIntoView({ block: 'start', behavior: 'instant' });
      } else if (saved) {
        setLastSelected(saved.id);
        const card = saved.id ? document.getElementById(`library-movie-${saved.id}`) : null;
        (card ?? results.current)?.focus({ preventScroll: true }); window.scrollTo({ top: saved.y, behavior: 'instant' });
      }
      intent.current = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [baseUrl, movieId, collection.loading, parameterError]);
  useEffect(() => {
    if (movieId === undefined || editor.selecting || selectedId === undefined) return;
    heading.current?.focus({ preventScroll: true }); window.scrollTo({ top: 0, behavior: 'instant' });
  }, [movieId, editor.selecting, selectedId]);

  function navigate(next: LibraryState) {
    remember(baseUrl, lastSelected); intent.current = 'results'; router.push(libraryUrl(next), { scroll: false });
  }
  function open(id: number) {
    remember(baseUrl, id); setLastSelected(id); router.push(libraryUrl(state, id), { scroll: false });
  }
  function back() { intent.current = 'restore'; router.push(baseUrl, { scroll: false }); }
  const feedback = <>
    {editor.notice ? editor.notice.error ? <ErrorState>{editor.notice.text}</ErrorState> : <p className="success-state" role="status">{editor.notice.text}</p> : null}
    {editor.recoveryMovieId !== null ? <Button tone="quiet" type="button" disabled={editor.busy || editor.selecting} onClick={() => { void editor.choose(editor.recoveryMovieId!); collection.refresh(); }}>Перечитать фильм</Button> : null}
  </>;
  const data = collection.data, active = Boolean(state.q || state.year || state.rated !== 'all' || state.sort !== 'added_desc');
  return <div className="library-workbench">
    <div hidden={movieId !== undefined}>
      <div className="library-heading"><PageHeader title="Моя библиотека" description="Фильмы заканчиваются. Впечатления остаются." /><p className="library-total">{collection.totalError ? <button type="button" onClick={collection.refresh}>Повторить чтение количества</button> : collection.total === null ? 'Читаем коллекцию…' : <><strong>{collection.total}</strong><span>просмотрено</span></>}</p></div>
      <LibraryToolbar key={baseUrl} state={state} navigate={navigate} />
      {parameterError ? <ErrorState>{parameterError}<Link className="library-reset" href="/library">Вернуться к библиотеке без фильтров</Link></ErrorState> : <>
        {active ? <div className="library-active-filters"><span>{[state.q && `«${state.q}»`, state.year, state.rated === 'true' ? 'С оценкой' : state.rated === 'false' ? 'Без оценки' : null, state.sort !== 'added_desc' && librarySorts[state.sort]].filter(Boolean).join(' · ')}</span><Button tone="quiet" type="button" onClick={() => navigate({ ...defaultLibraryState })}>Сбросить</Button></div> : null}
        <section className="library-results" aria-label="Коллекция просмотренного" aria-busy={collection.loading}>
          <div className="library-results-bar"><h2 ref={results} tabIndex={-1}>{collection.loading ? 'Загрузка коллекции…' : data ? `Найдено: ${data.total}` : 'Ваша коллекция'}</h2><Button tone="quiet" type="button" disabled={collection.loading} onClick={collection.refresh}>Обновить</Button></div>
          {collection.updated ? <p className="library-update-note" role="status">Список обновлён с учётом фильтров и сортировки. Оценка могла изменить положение фильма.</p> : null}
          {collection.loading ? <><LoadingState>Читаем вашу библиотеку…</LoadingState><div className="library-grid library-skeleton" aria-hidden="true">{Array.from({ length: 12 }, (_, i) => <div key={i}><span /><i /><i /></div>)}</div></> : collection.error ? <ErrorState>{collection.error}<Button tone="quiet" type="button" onClick={collection.refresh}>Повторить чтение</Button></ErrorState> : data ? <>
            {!data.items.length ? <EmptyState title={data.total > 0 ? 'Такой страницы нет' : !active ? 'Здесь будет ваша история кино' : state.rated === 'false' && !state.q && !state.year ? 'Все найденные фильмы уже оценены' : 'Ничего не найдено'}>
              <p>{data.total > 0 ? 'Откройте доступную страницу коллекции.' : !active ? 'Найдите фильм и подтвердите просмотр. Он появится в вашей библиотеке.' : 'Попробуйте другое название или измените фильтры.'}</p>
              {data.total > 0 ? <Button type="button" onClick={() => navigate({ ...state, page: data.total_pages })}>К последней странице</Button> : active ? <Button tone="quiet" type="button" onClick={() => navigate({ ...defaultLibraryState })}>Сбросить фильтры</Button> : <Link className="button button-primary" href="/rate">Оценить фильм</Link>}
            </EmptyState> : <ul className="library-grid">{data.items.map(film => <li key={film.movie_id}>
              <Link id={`library-movie-${film.movie_id}`} className={`library-card${lastSelected === film.movie_id ? ' was-selected' : ''}`} href={libraryUrl(state, film.movie_id)} scroll={false} onClick={event => { if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.button === 0) { event.preventDefault(); open(film.movie_id); } }} aria-label={`Открыть ${film.title}, ${film.year ?? 'год неизвестен'}, ${libraryScore(film.rating_100)}`}>
                <MoviePoster path={film.poster_path} title={film.title} fallbackTitle sizes="(max-width: 767px) 44vw, (max-width: 1023px) 22vw, (max-width: 1439px) 18vw, 240px" />
                <span className="library-card-copy"><span className="library-card-title">{film.title}</span><span className="library-card-bottom"><span className="library-card-year">{film.year ?? 'Год неизвестен'}</span><span className={`library-card-score${film.rating_100 === null ? ' is-unrated' : ''}`}>{film.rating_100 === null ? 'Без оценки' : <><strong>{film.rating_100}</strong><small>/100</small></>}</span></span></span>
              </Link></li>)}</ul>}
            {data.total_pages > 0 ? <nav className="library-pagination" aria-label="Страницы библиотеки"><Button tone="quiet" type="button" disabled={data.page <= 1} onClick={() => navigate({ ...state, page: data.page - 1 })}>Назад</Button><span aria-current="page">{data.page} <span className="muted">из {data.total_pages}</span></span><Button tone="quiet" type="button" disabled={data.page >= data.total_pages} onClick={() => navigate({ ...state, page: data.page + 1 })}>Далее</Button></nav> : null}
          </> : null}
        </section>
      </>}
    </div>
    {movieId !== undefined ? <div className="library-details"><Button className="library-back" tone="quiet" type="button" disabled={editor.busy} onClick={back}>← К моей библиотеке</Button>
      <MovieEditor model={editor} enhanced collection headingRef={heading} feedback={feedback} />
      {!editor.selected ? feedback : null}
    </div> : null}
  </div>;
}

export function LibraryToolbar({ state, navigate }: { state: LibraryState; navigate: (state: LibraryState) => void }) {
  const [q, setQ] = useState(state.q), [year, setYear] = useState(state.year), [error, setError] = useState('');
  function submit(event: FormEvent) {
    event.preventDefault();
    const candidate = { ...state, q: q.trim(), year, page: 1 };
    const checked = parseLibraryState(new URLSearchParams(libraryUrl(candidate).split('?')[1]));
    if (checked.error) { setError('Введите название до 200 символов и целый год от 1 до 9999.'); return; }
    setError(''); navigate(candidate);
  }
  return <div className="library-toolbar">
    <form className="library-search-form" onSubmit={submit} aria-label="Поиск в личной библиотеке">
      <div className="library-query"><label htmlFor="library-query">Название фильма</label><span className="library-query-field"><Icon name="film" /><input id="library-query" name="library-query" placeholder="Найти в своей коллекции" maxLength={200} value={q} onChange={event => setQ(event.target.value)} />{q ? <button type="button" aria-label="Очистить поиск" onClick={() => { setQ(''); setError(''); navigate({ ...state, q: '', page: 1 }); }}>×</button> : null}</span></div>
      <label className="library-year">Год<input name="library-year" inputMode="numeric" placeholder="Любой" value={year} maxLength={4} onChange={event => setYear(event.target.value)} /></label>
      <Button>Найти</Button>
    </form>
    {error ? <ErrorState>{error}</ErrorState> : null}
    <div className="library-filter-row"><div className="library-rated" role="group" aria-label="Наличие оценки">{(['all','true','false'] as const).map((rated, i) => <button key={rated} type="button" aria-pressed={state.rated === rated} onClick={() => navigate({ ...state, rated, page: 1 })}>{['Все фильмы','С оценкой','Без оценки'][i]}</button>)}</div>
      <label className="library-sort"><span className="sr-only">Сортировка библиотеки</span><select name="library-sort" value={state.sort} onChange={event => navigate({ ...state, sort: event.target.value as LibraryState['sort'], page: 1 })}>{Object.entries(librarySorts).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    </div>
  </div>;
}
