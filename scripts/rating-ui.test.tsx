import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { RatingControl } from '../src/app/components/rating-control';
import { ratingDraft, parseRateSelection } from '../src/app/rating-draft';
import { ApiError } from '../src/app/workbench-api';

test('rating draft distinguishes blank and zero, and never clamps or rounds invalid input', () => {
  for (const text of ['', '   ']) assert.deepEqual(ratingDraft(text), { value: null, invalid: false });
  for (const value of [0,1,40,85,99,100]) assert.deepEqual(ratingDraft(String(value)), { value, invalid: false });
  for (const text of ['-1','101','0.5','NaN','Infinity','text']) assert.deepEqual(ratingDraft(text), { value: null, invalid: true });
});
test('rate links reject malformed, repeated and unsafe local IDs while accepting no selection', () => {
  assert.deepEqual(parseRateSelection(undefined), {});
  for (const value of ['1','830',String(Number.MAX_SAFE_INTEGER)]) assert.deepEqual(parseRateSelection(value), { movieId: Number(value) });
  for (const value of ['', '0','-1','1.5','Infinity','01','9007199254740992',['1'],['1','2']]) {
    const result = parseRateSelection(value); assert.ok(result.error); assert.equal(result.movieId,undefined);
  }
});
test('unrated control communicates absence without assigning the native slider position as a score', () => {
  const html = renderToStaticMarkup(<RatingControl value="" onChange={() => { throw Error('Render cannot change the draft'); }} watched={false} />);
  assert.match(html,/Без оценки/); assert.match(html,/aria-valuetext="Без оценки\./); assert.match(html,/name="watch-rating"/);
  assert.match(html,/value=""/); assert.doesNotMatch(html,/<strong>50<\/strong>/);
  assert.match(html,/type="range" min="0" max="100" step="1"/);
});
test('zero and boundaries are rendered as real selected ratings with an exact numeric field', () => {
  for (const value of [0,85,100]) {
    const html = renderToStaticMarkup(<RatingControl value={String(value)} onChange={() => {}} watched />);
    assert.match(html,new RegExp(`<strong>${value}</strong>`)); assert.match(html,new RegExp(`aria-valuetext="${value} из 100"`));
    assert.match(html,/name="edit-rating"/); assert.match(html,/inputMode="numeric"/); assert.doesNotMatch(html,/aria-valuetext="Без оценки/);
  }
});
test('invalid draft exposes validation and API errors retain their machine code without raw server data', () => {
  const html = renderToStaticMarkup(<RatingControl value="101" onChange={() => {}} watched />);
  assert.match(html,/aria-invalid="true"/); assert.match(html,/Введите целое число от 0 до 100/);
  const error = new ApiError('rating_already_exists'); assert.equal(error.code,'rating_already_exists'); assert.match(error.message,/Обновите данные/);
  assert.doesNotMatch(new ApiError('/private/SQLite failure').message,/private/);
});

test('save feedback stays beside the selected editor when the results view is active', async () => {
  const { RateWorkbench } = await import('../src/app/rate-workbench');
  // The same state occurs after returning to mobile results and then widening the window.
  const model = { query: '', year: '', results: [], more: false, searching: false, searchError: '', pending: null,
    busy: false, selecting: false, score: '85', setScore() {}, addingId: null, recoveryMovieId: null, watchConfirmed: false, matches: [],
    notice: { error: false, text: 'Оценка не изменилась.' }, selected: { movie_id: 1, tmdb_id: 10, title: 'Fixture', year: 2000,
      watched: true, rating_100: 85, rating_source: 'manual', not_interested: false, poster_path: null },
  } as unknown as Parameters<typeof RateWorkbench>[0]['model'];
  const html = renderToStaticMarkup(<RateWorkbench model={model} />);
  assert.match(html, /class="rate-detail"/);
  assert.ok(html.indexOf('Оценка не изменилась.') > html.indexOf('class="rate-detail"'));
  assert.equal(html.split('Оценка не изменилась.').length - 1,1);
});
