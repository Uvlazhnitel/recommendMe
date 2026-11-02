import assert from 'node:assert/strict';

// Called by the existing isolated production runner: synthetic SQLite and provider mocks only.
export async function navigationAcceptance({ page, base, http, check, screenshot, until }) {
  const nav = page.getByRole('navigation', { name: 'Основная навигация' });
  const tab = name => nav.getByRole('link', { name, exact: true });
  const rating = () => page.getByRole('spinbutton', { name: 'Точное число' });
  const current = () => nav.locator('[aria-current="page"]').innerText();
  const go = path => page.goto(base + path);
  let accept = true, dialogs = 0;
  page.removeAllListeners('dialog');
  page.on('dialog', dialog => { dialogs++; void (accept ? dialog.accept() : dialog.dismiss()); });
  const profile = await page.request.get(base + '/api/profile').then(response => response.json());
  if (profile.active.user_id !== 'ilya') {
    await page.getByRole('button', { name: 'Сменить профиль: Валерий' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Илья', exact: true }).click();
    await page.getByRole('button', { name: 'Сменить профиль: Илья' }).waitFor();
  }
  const paidBefore = await http.get(base + '/api/recommendations').then(r => r.json());
  // Keep a known watched film in the watchlist for both desktop and mobile checks.
  await http.patch(base + '/api/library/1/watchlist', { data: { watchlist: true } });
  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await go('/watchlist');
    const card = page.locator('#watchlist-movie-1'); await card.waitFor();
    await card.scrollIntoViewIfNeeded();
    const y = await page.evaluate(() => scrollY);
    await card.click(); await rating().waitFor();
    assert.equal(new URL(page.url()).pathname, '/watchlist');
    assert.equal(new URL(page.url()).searchParams.get('movie_id'), '1');
    assert.equal(await current(), 'Посмотреть позже');
    await screenshot(`navigation-watchlist-detail-${width}`);
    await page.getByRole('button', { name: '← К списку', exact: true }).click();
    await card.waitFor();
    await until(async () => Math.abs(await page.evaluate(() => scrollY) - y) < 4, 'watchlist scroll restored');
    await until(async () => await card.evaluate(el => document.activeElement === el), 'watchlist focus restored');
    await page.goForward(); await rating().waitFor(); assert.equal(await current(), 'Посмотреть позже');
    await page.goBack(); await card.waitFor();
    await card.click(); await rating().waitFor();
    await tab('Библиотека').click(); await page.locator('.library-results[aria-busy="false"]').waitFor();
    await tab('Посмотреть позже').click(); await card.waitFor();
    assert.equal(new URL(page.url()).search, '', 'tab reentry returns to the list');
  }
  check('navigation: watchlist details/back/forward, source tab, scroll/focus and list reentry at 375/1440');

  await go('/watchlist?movie_id=1'); await rating().waitFor();
  const original = await rating().inputValue();
  await rating().fill(original === '0' ? '1' : '0');
  const draft = await rating().inputValue();
  accept = false; let before = dialogs;
  await tab('Библиотека').click();
  assert.equal(dialogs, before + 1); assert.equal(await rating().inputValue(), draft);
  before = dialogs; await page.getByRole('button', { name: '← К списку', exact: true }).click();
  assert.equal(dialogs, before + 1); assert.equal(await rating().inputValue(), draft);
  // Establish a same-document predecessor, then reject browser Back and Forward.
  accept = true; await tab('Посмотреть позже').click(); await page.locator('#watchlist-movie-1').click(); await rating().waitFor();
  await rating().fill(original === '0' ? '1' : '0');
  accept = false; before = dialogs;
  await page.evaluate(() => history.back());
  await until(() => dialogs === before + 1, 'browser Back warning');
  await until(() => new URL(page.url()).searchParams.get('movie_id') === '1', 'cancelled Back restores URL');
  assert.equal(await rating().inputValue(), draft);
  accept = true; await page.evaluate(() => history.back()); await page.locator('#watchlist-movie-1').waitFor();
  await page.goForward(); await rating().waitFor(); assert.equal(await rating().inputValue(), original);
  await rating().fill(original === '0' ? '1' : '0');
  accept = false; before = dialogs;
  await page.evaluate(() => window.location.reload());
  assert.equal(dialogs, before + 1); assert.equal(await rating().inputValue(), draft);
  accept = true; await page.reload(); await rating().waitFor(); assert.equal(await rating().inputValue(), original);
  await tab('Библиотека').click(); await page.locator('.library-results[aria-busy="false"]').waitFor();
  await page.goBack(); await rating().waitFor(); await rating().fill(original === '0' ? '1' : '0');
  accept = false; before = dialogs; await page.evaluate(() => history.forward());
  await until(() => dialogs === before + 1, 'browser Forward warning');
  await until(() => new URL(page.url()).pathname === '/watchlist', 'cancelled Forward retains URL');
  assert.equal(await rating().inputValue(), draft);
  accept = true; await page.goForward(); await page.locator('.library-results[aria-busy="false"]').waitFor();
  await page.goBack(); await rating().waitFor();
  check('navigation: cancelling tab/back/browser Back/Forward/reload retains the draft; confirmed leave discards it');

  const review = page.locator('#library-review');
  await review.fill('Navigation unsaved review');
  await rating().fill('0');
  await page.getByRole('button', { name: 'Сохранить оценку', exact: true }).click();
  await page.getByRole('status').filter({ hasText: /Оценка (сохранена|не изменилась)/ }).waitFor();
  assert.equal(await review.inputValue(), 'Navigation unsaved review');
  accept = false; before = dialogs; await tab('Библиотека').click(); assert.equal(dialogs, before + 1);
  await page.getByRole('button', { name: 'Сохранить впечатления', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Впечатления сохранены.' }).waitFor();
  before = dialogs; await tab('Библиотека').click(); await page.locator('.library-results[aria-busy="false"]').waitFor();
  assert.equal(dialogs, before, 'saved fields do not warn'); accept = true;
  check('navigation: saving zero retains a review draft; saving both clears the warning');

  await go('/watchlist?movie_id=1'); await rating().waitFor();
  await page.route('**/api/library/1/rating', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"synthetic_failure"}' }));
  await rating().fill('17'); await page.getByRole('button', { name: 'Сохранить оценку', exact: true }).click();
  await page.locator('.film-feedback [role="alert"]').waitFor();
  accept = false; before = dialogs; await tab('Библиотека').click();
  assert.equal(dialogs, before + 1); assert.equal(await rating().inputValue(), '17');
  await page.unroute('**/api/library/1/rating'); accept = true;
  await tab('Библиотека').click(); await page.locator('.library-results[aria-busy="false"]').waitFor();
  check('navigation: failed rating save preserves draft and the leave warning');

  await go('/library?sort=rating_desc&page=2'); await page.locator('.library-results[aria-busy="false"]').waitFor();
  await page.locator('.library-card').first().click(); await rating().waitFor();
  await tab('Посмотреть позже').click(); await page.locator('.watchlist-page').waitFor();
  await tab('Библиотека').click(); await page.locator('.library-results[aria-busy="false"]').waitFor();
  assert.equal(new URL(page.url()).search, '?sort=rating_desc&page=2');
  await page.locator('.library-card').first().click(); await rating().waitFor();
  await page.reload(); await rating().waitFor();
  await page.getByRole('button', { name: '← К моей библиотеке', exact: true }).click();
  await page.locator('.library-results[aria-busy="false"]').waitFor();
  assert.equal(new URL(page.url()).search, '?sort=rating_desc&page=2');

  await go('/library?movie_id=1&from=home'); await rating().waitFor();
  assert.equal(await current(), 'Рекомендации');
  await page.getByRole('button', { name: '← К рекомендациям', exact: true }).click(); await page.waitForURL(base + '/');
  await go('/rate?movie_id=1&from=home'); await rating().waitFor(); assert.equal(await current(), 'Рекомендации');
  await page.getByRole('button', { name: '← К рекомендациям', exact: true }).click(); await page.waitForURL(base + '/');
  check('navigation: library filters/page survive tab changes and reload; direct home-origin links return home');

  await go('/rate');
  const query = page.getByRole('textbox', { name: 'Название фильма', exact: true });
  await query.fill('variants'); await page.getByRole('button', { name: 'Найти фильм', exact: true }).click();
  await page.locator('#rate-result-990001').waitFor();
  let searches = 0;
  const track = request => { if (new URL(request.url()).pathname === '/api/movies/search') searches++; };
  page.on('request', track);
  await tab('Посмотреть позже').click(); await page.locator('.watchlist-page').waitFor();
  await tab('Оценить фильм').click(); await page.locator('#rate-result-990001').waitFor();
  assert.equal(await query.inputValue(), 'variants'); assert.equal(searches, 0);
  await page.locator('#rate-result-990001').click(); await rating().waitFor();
  const localId = Number(new URL(page.url()).searchParams.get('movie_id'));
  assert.ok(localId > 0 && localId !== 990001, 'details use the local catalog ID');
  await page.getByRole('button', { name: '← К результатам', exact: true }).click();
  await page.locator('#rate-result-990001').waitFor(); assert.equal(searches, 0);
  page.off('request', track);
  check('navigation: search/results survive tab changes and detail return without repeated TMDB search');

  await go('/watchlist?movie_id=1'); await rating().waitFor();
  await page.getByRole('button', { name: 'Убрать из «Посмотреть позже»', exact: true }).click();
  await page.getByRole('button', { name: 'Посмотреть позже', exact: true }).waitFor();
  await page.getByRole('button', { name: '← К списку', exact: true }).click(); await page.locator('.watchlist-page').waitFor();
  await until(async () => await page.locator('#watchlist-movie-1').count() === 0, 'removed film disappears');
  await until(async () => await page.evaluate(() => document.activeElement?.id === 'watchlist-heading'), 'removed card falls back to list heading');
  const paidAfter = await http.get(base + '/api/recommendations').then(r => r.json());
  assert.equal(paidAfter.batch?.result_id, paidBefore.batch?.result_id);
  check('navigation: removing the open watchlist film returns to the list and focuses its heading');

  const fallback = await page.context().newPage();
  fallback.removeAllListeners('dialog');
  let fallbackDialogs = 0;
  fallback.on('dialog', dialog => { fallbackDialogs++; void dialog.dismiss(); });
  await fallback.addInitScript(() => Object.defineProperty(window, 'navigation', { value: undefined, configurable: true }));
  await fallback.goto(base + '/library'); await fallback.locator('.library-results[aria-busy="false"]').waitFor();
  await fallback.locator('.library-card').first().click();
  const fallbackRating = fallback.getByRole('spinbutton', { name: 'Точное число' }); await fallbackRating.waitFor();
  const fallbackDraft = await fallbackRating.inputValue() === '0' ? '1' : '0';
  await fallbackRating.fill(fallbackDraft);
  await fallback.locator('.film-saved-status .current-score').waitFor();
  assert.equal(await fallback.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented;
  }), true, 'legacy editor registers the dirty guard before traversal');
  await fallback.evaluate(() => history.back());
  await until(() => fallbackDialogs === 1, 'legacy popstate warning');
  await until(() => new URL(fallback.url()).searchParams.has('movie_id'), 'legacy popstate restores URL');
  assert.equal(await fallbackRating.inputValue(), fallbackDraft);
  await fallback.close();
  check('navigation: browser Back cancellation also works without the Navigation API');
}
