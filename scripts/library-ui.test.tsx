import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { libraryFixture } from './fixtures/library';
import { libraryParams, libraryReadUrl, libraryScore, libraryUrl, parseLibraryState, defaultLibraryState } from '../src/app/library-state';
import { readLibrary, readLibraryMovie, updateLibraryRating } from '../src/lib/library';
import { MoviePoster } from '../src/app/components/movie-poster';
import { MovieEditor } from '../src/app/components/movie-editor';
import type { MovieEditorModel } from '../src/app/use-movie-editor';
import { buildCandidateContext } from '../src/lib/candidate-context';
import { buildRankingContext } from '../src/lib/recommendation-context';
import { movie } from './fixtures/recommendation-screen';

const parse = (query: string) => parseLibraryState(new URLSearchParams(query));
test('library URL round trips applied filters and selection without leaking selection into API queries', () => {
  const state = { ...defaultLibraryState, q: 'Кино %_', rated: 'false' as const, year: '2019', sort: 'rating_asc' as const, page: 8 };
  const url = libraryUrl(state, 830), result = parse(url.split('?')[1]);
  assert.deepEqual(result, { state, movieId: 830 });
  assert.equal(libraryReadUrl(state).includes('movie_id'), false);
  assert.equal(new URLSearchParams(libraryReadUrl(state).split('?')[1]).get('limit'), '25');
  assert.equal(libraryUrl(defaultLibraryState), '/library');
});
test('malformed, duplicate and unsafe library URL values fail before a library request', () => {
  for (const query of ['q=a&q=b','rated=0','sort=popularity','year=0','year=2020.5','year=','page=0','page=01','page=9007199254740992','movie_id=0','movie_id=1&movie_id=2',`q=${'я'.repeat(201)}`]) assert.ok(parse(query).error,query);
  assert.equal(parse('q=КИНО&year=9999&page=2').error,undefined);
  assert.equal(libraryScore(0),'0/100'); assert.equal(libraryScore(null),'Без оценки');
});
test('830 watched fixtures are paginated server-side, with stable combined filters and every sort', () => {
  const f=libraryFixture();
  try {
    const all=readLibrary(f.db,new URLSearchParams('limit=25')); assert.equal(all.total,830); assert.equal(all.items.length,25); assert.equal(all.total_pages,34);
    const ids=new Set<number>(); for(let page=1;page<=34;page++) for(const item of readLibrary(f.db,new URLSearchParams(`page=${page}&limit=25`)).items) { assert.ok(!ids.has(item.movie_id)); ids.add(item.movie_id); }
    assert.equal(ids.size,830);
    for(const sort of ['added_desc','added_asc','rating_desc','rating_asc'] as const) {
      const state={...defaultLibraryState,q:'Кинокадр',rated:'true' as const,year:'2002',sort,page:1};
      const result=readLibrary(f.db,libraryParams(state)); assert.ok(result.items.length); assert.ok(result.items.every(item=>item.year===2002 && item.rating_100!==null));
      const sorted=readLibrary(f.db,new URLSearchParams(`sort=${sort}&limit=100`)); assert.equal(new Set(sorted.items.map(x=>x.movie_id)).size,100);
      if(sort==='rating_asc') assert.equal(sorted.items[0].rating_100,0);
    }
    const rated=readLibrary(f.db,new URLSearchParams('rated=true')), unrated=readLibrary(f.db,new URLSearchParams('rated=false'));
    assert.equal(rated.total+unrated.total,830); assert.ok(unrated.items.every(item=>item.rating_100===null));
    assert.equal(readLibrary(f.db,new URLSearchParams('q=кино%20abc%20100%25_')).items[0].movie_id,10);
    assert.equal(readLibrary(f.db,new URLSearchParams('q=original%20test')).items[0].movie_id,10);
    assert.equal(readLibrary(f.db,new URLSearchParams('page=999')).items.length,0);
  } finally {f.cleanup();}
});
test('library rating sequence refreshes membership and leaves all Letterboxd fields, profile and history intact', async () => {
  const f=libraryFixture();
  try {
    const before=f.db.prepare('SELECT * FROM user_movies WHERE movie_id=1').get() as Record<string,unknown>;
    const profile=JSON.stringify(f.db.prepare('SELECT * FROM taste_profile').all());
    const history=JSON.stringify(f.db.prepare('SELECT * FROM recommendations').all());
    for(const rating of [90,75,0,null,85,null,null]) {
      const previous=readLibraryMovie(f.db,1), result=await updateLibraryRating(f.db,1,rating);
      assert.equal(result.status,previous.rating_100===rating?'unchanged':'updated');
      const current=readLibraryMovie(f.db,1); assert.equal(current.rating_100,rating); assert.equal(current.watched,true);
      const filtered=readLibrary(f.db,new URLSearchParams(`q=Favourite&rated=${rating===null?'false':'true'}`)); assert.equal(filtered.total,1);
    }
    const after=f.db.prepare('SELECT * FROM user_movies WHERE movie_id=1').get() as Record<string,unknown>;
    for(const key of ['watched','watched_at','original_rating_stars','letterboxd_date','letterboxd_rating_date','not_interested','created_at']) assert.equal(after[key],before[key],key);
    assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM taste_profile').all()),profile); assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM recommendations').all()),history);
    assert.equal(readLibraryMovie(f.db,7).tmdb_id,null);
    const candidateContext=buildCandidateContext(f.db).context, rankingContext=buildRankingContext(f.db,[movie(999001)]).context;
    for(const context of [candidateContext,rankingContext]) assert.equal(context.rating_changes.find(item=>item.movie_id===1)?.rating_100,null);
    assert.ok(!rankingContext.current_evidence.some(item=>item.movie_id===1));
    assert.ok(rankingContext.current_evidence.some(item=>item.movie_id===2 && item.rating_100===0));
    const reopened=f.open({readonly:true}); assert.equal(readLibraryMovie(reopened,1).rating_100,null); reopened.close();
  } finally {f.cleanup();}
});
test('collection fallback includes the title without changing the existing poster fallback', () => {
  const title='Фильм без постера';
  const collection=renderToStaticMarkup(<MoviePoster title={title} fallbackTitle />), regular=renderToStaticMarkup(<MoviePoster title={title} />);
  assert.match(collection,/<strong>Фильм без постера<\/strong>/); assert.doesNotMatch(regular,/<strong>/);
});
test('collection details reuse the rating control, distinguish zero and render available original metadata', () => {
  const model={ selected:{movie_id:1,tmdb_id:null,title:'Название',original_title:'Original Title',year:null,watched:true,rating_100:0,rating_source:'letterboxd',poster_path:null,genres:null},
    score:'0',setScore(){},selecting:false,pending:null,busy:false } as unknown as MovieEditorModel;
  const html=renderToStaticMarkup(<MovieEditor model={model} enhanced collection />);
  assert.match(html,/Original Title/); assert.match(html,/aria-valuetext="0 из 100"/); assert.match(html,/Оценка из Letterboxd/); assert.match(html,/Описание пока отсутствует/); assert.match(html,/Очистить оценку/);
});

test('clearing a nonempty query is a separate button and never changes the search input label', async () => {
  const { LibraryToolbar } = await import('../src/app/library-workbench');
  const html = renderToStaticMarkup(<LibraryToolbar state={{...defaultLibraryState,q:'Her'}} navigate={()=>{}} />);
  assert.match(html,/<label for="library-query">Название фильма<\/label>/);
  assert.match(html,/id="library-query"/); assert.match(html,/aria-label="Очистить поиск"/);
  assert.doesNotMatch(html,/<label for="library-query">[^<]*<button/);
});
