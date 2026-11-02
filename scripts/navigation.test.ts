import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeTab, detailUrl, listUrl, readSession, writeSession, savedPosition, rememberPosition, tabUrl } from '../src/app/navigation-state';
import { applyBrowserProfile } from '../src/app/profile-requests';

test('details retain their source tab; home is the only supported origin override', () => {
  assert.equal(activeTab('/watchlist', new URLSearchParams('movie_id=3')), '/watchlist');
  for (const tab of ['/library', '/rate']) {
    assert.equal(activeTab(tab, new URLSearchParams('movie_id=3&from=home')), '/');
    assert.equal(activeTab(tab, new URLSearchParams('movie_id=3&from=https://evil.test')), tab);
    assert.equal(activeTab(tab, new URLSearchParams('movie_id=3&from=home&from=home')), tab);
    assert.equal(activeTab(tab, new URLSearchParams('from=home')), tab);
  }
  assert.equal(listUrl('/library?q=film&sort=rating_desc&page=8&movie_id=3'), '/library?q=film&sort=rating_desc&page=8');
  assert.equal(listUrl('/library?movie_id=3&from=home'), '/');
  assert.equal(listUrl('/watchlist?movie_id=3'), '/watchlist');
  assert.equal(listUrl('https://evil.test/library'), null);
  assert.equal(listUrl('javascript:alert(1)'), null);
  assert.equal(listUrl('/access'), null);
  assert.equal(detailUrl('/watchlist', 3), '/watchlist?movie_id=3');
  assert.equal(detailUrl('/rate', 3, true), '/rate?movie_id=3&from=home');
});

test('session navigation is scoped to the profile and rejects unsafe stored destinations', t => {
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, 'window', { value: { scrollY: 480 }, configurable: true });
  Object.defineProperty(globalThis, 'sessionStorage', { value: {
    get length() { return storage.size; }, key: (i: number) => [...storage.keys()][i] ?? null,
    getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key),
  }, configurable: true });
  t.after(() => { Reflect.deleteProperty(globalThis, 'window'); Reflect.deleteProperty(globalThis, 'sessionStorage'); });
  applyBrowserProfile({ user_id: 'ilya', selection_id: 'first' });
  writeSession('tab:/library', '/library?q=film&page=8');
  assert.equal(tabUrl('/library'), '/library?q=film&page=8');
  for (const value of ['https://evil.test/library', 'javascript:alert(1)', '/watchlist', '/library?movie_id=3', 3, null]) {
    writeSession('tab:/library', value); assert.equal(tabUrl('/library'), '/library');
  }
  rememberPosition('/watchlist', 3); rememberPosition('/watchlist');
  assert.deepEqual(savedPosition('/watchlist'), { y: 480, id: 3 });
  writeSession('position:/watchlist', { y: -1 }); assert.equal(savedPosition('/watchlist'), null);
  writeSession('rate-search', { query: 'film' });
  window.recommendmeProfile = undefined; // Simulate reinitialization after a document reload.
  applyBrowserProfile({ user_id: 'ilya', selection_id: 'first' });
  assert.deepEqual(readSession('rate-search', null), { query: 'film' });
  applyBrowserProfile({ user_id: 'valeriy', selection_id: 'second' });
  assert.equal(readSession('rate-search', null), null); assert.equal(storage.size, 0);
});

test('disabled session storage does not prevent navigation', () => {
  assert.equal(readSession('missing', 'fallback'), 'fallback');
  assert.doesNotThrow(() => writeSession('missing', {}));
  assert.equal(tabUrl('/watchlist'), '/watchlist');
});
