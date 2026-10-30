import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { ACCESS_SECONDS, accessStatus, exchangeAccess, requireAccess } from '../src/lib/access';
import { getProfile, chooseProfile, profileRoute } from '../src/lib/profile-http';
import { profileRequest } from './fixtures/profile-request';
import { accessFetch, clearAccess, saveAccess } from '../src/app/access-client';

const origin = 'https://homeserver.example:10000', privateOrigin = 'https://homeserver.example:12443';
function configure(t: TestContext) {
  const before = { ...process.env };
  t.after(() => { for (const key of ['ACCESS_MODE', 'ACCESS_LINK_SECRET', 'ACCESS_ALLOWED_ORIGINS']) {
    if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key];
  }});
  process.env.ACCESS_MODE = 'link';
  process.env.ACCESS_LINK_SECRET = randomBytes(32).toString('base64url');
  process.env.ACCESS_ALLOWED_ORIGINS = `${origin},${privateOrigin}`;
  return process.env.ACCESS_LINK_SECRET;
}
function exchange(key: string, target = origin, headers: Record<string, string> = {}) {
  return exchangeAccess(new Request(`${target}/api/access`, { method: 'POST', headers: {
    'Content-Type': 'application/json', Origin: target, ...headers,
  }, body: JSON.stringify({ key }) }));
}
async function session(key: string, target = origin) {
  const response = await exchange(key, target);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return (await response.json()).token as string;
}

test('link exchanges for a 90-day signed credential, bound to the exact origin and revoked on rotation', async t => {
  const key = configure(t), token = await session(key);
  const request = new Request(`${origin}/api/profile`, { headers: { Authorization: `Bearer ${token}` } });
  assert.doesNotThrow(() => requireAccess(request));
  const data = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
  assert.equal(data.exp - data.iat, ACCESS_SECONDS);
  assert.doesNotThrow(() => requireAccess(request, data.exp - 1));
  assert.throws(() => requireAccess(request, data.exp), { code: 'access_required' });
  assert.throws(() => requireAccess(new Request(`${privateOrigin}/api/profile`, { headers: request.headers })), { code: 'access_required' });
  assert.throws(() => requireAccess(new Request(request, { headers: { Authorization: `Bearer ${token.slice(0, -2)}aa` } })), { code: 'access_required' });
  process.env.ACCESS_LINK_SECRET = randomBytes(32).toString('base64url');
  assert.throws(() => requireAccess(request), { code: 'access_required' });
  assert.equal((await exchange(key)).status, 401);
});

test('missing config fails closed, local bypass is explicit, invalid and cross-origin exchanges fail', async t => {
  const key = configure(t);
  assert.equal((await exchange('wrong')).status, 401);
  assert.equal((await exchange(key, origin, { Origin: privateOrigin })).status, 403);
  assert.equal((await exchange(key, 'https://elsewhere.example')).status, 401);
  assert.equal((await exchange(key, origin, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await exchangeAccess(new Request(`${origin}/api/access`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, extra: true }) }))).status, 401);
  delete process.env.ACCESS_LINK_SECRET;
  assert.equal(getProfile(new Request(`${origin}/api/profile`)).status, 503);
  delete process.env.ACCESS_MODE;
  assert.equal(accessStatus(new Request(`${origin}/api/access`)).status, 503);
  process.env.ACCESS_MODE = 'local';
  assert.equal(getProfile(new Request('http://127.0.0.1/api/profile')).status, 200);
});

test('all personal handler boundaries reject before database, providers or profile parsing; both profiles work after entry', async t => {
  const key = configure(t), token = await session(key);
  let calls = 0;
  const guarded = profileRoute(async () => { calls++; return Response.json({ ok: true }); });
  for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
    const request = profileRequest(`${origin}/api/library`, { method });
    assert.equal((await guarded(request)).status, 401);
    assert.equal(calls, 0);
  }
  assert.equal(getProfile(new Request(`${origin}/api/profile`, { headers: { Cookie: 'recommendme_profile=garbage' } })).status, 401);
  assert.equal((await chooseProfile(new Request(`${origin}/api/profile`, { method: 'POST', body: 'invalid' }))).status, 401);
  for (const user of ['ilya', 'valeriy'] as const) {
    const request = profileRequest(`${origin}/api/library`, { headers: { Authorization: `Bearer ${token}` } }, user);
    assert.equal((await guarded(request)).status, 200);
    assert.equal(getProfile(request).status, 200);
  }
  assert.equal(calls, 2);
});

test('browser attaches credential only to local API, disables redirects, and never retries a rejected write', async t => {
  const events: string[] = [], store = new Map<string, string>();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { origin }, dispatchEvent(event: Event) { events.push(event.type); } } });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    setItem(k: string, v: string) { store.set(k, v); }, getItem(k: string) { return store.get(k) ?? null; }, removeItem(k: string) { store.delete(k); },
  } });
  t.after(() => { clearAccess(); Reflect.deleteProperty(globalThis, 'window'); Reflect.deleteProperty(globalThis, 'localStorage'); });
  saveAccess('session');
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls++;
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer session');
    assert.equal(init?.redirect, 'error');
    return Response.json({ error: 'access_required' }, { status: 401 });
  });
  for (const target of ['https://elsewhere.test/api/library', '//elsewhere.test/api/library', '/api/../outside', '/api/\\evil', '/api/library#fragment']) {
    await assert.rejects(accessFetch(target));
  }
  assert.equal(calls, 0);
  assert.equal((await accessFetch('/api/recommendations/generate', { method: 'POST' })).status, 401);
  assert.equal(calls, 1);
  assert.equal(store.size, 0);
  assert.deepEqual(events, ['recommendme-access-invalid']);
});
