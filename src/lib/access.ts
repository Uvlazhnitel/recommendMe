import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { JsonInputError, readJsonBody, requestOrigin } from './http-json';

export const ACCESS_SECONDS = 90 * 24 * 60 * 60;
export class AccessError extends JsonInputError {}

function configuration() {
  if (process.env.ACCESS_MODE === 'local') return null;
  const secret = process.env.ACCESS_LINK_SECRET;
  const rawOrigins = process.env.ACCESS_ALLOWED_ORIGINS?.split(',').map(value => value.trim());
  if ((process.env.ACCESS_MODE && process.env.ACCESS_MODE !== 'link') ||
      !secret || !/^[A-Za-z0-9_-]{43}$/.test(secret) || !rawOrigins?.length) {
    throw new AccessError('access_unavailable', 503);
  }
  const origins = rawOrigins.map(value => {
    try {
      const url = new URL(value);
      if (url.origin !== value || (url.protocol !== 'https:' &&
          !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)))) throw Error();
      return url.origin;
    } catch { throw new AccessError('access_unavailable', 503); }
  });
  return { secret, origins };
}

function audience(request: Request, origins: string[]) {
  const origin = requestOrigin(request);
  if (!origins.includes(origin)) throw new AccessError('access_required', 401);
  return origin;
}
function signature(payload: string, secret: string) {
  return createHmac('sha256', secret).update(`recommendme-access-v1.${payload}`).digest('base64url');
}
function equal(left: string, right: string) {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Called before opening SQLite or contacting a provider. No cookie grants access. */
export function requireAccess(request: Request, now = Math.floor(Date.now() / 1000)) {
  const config = configuration();
  if (!config) return;
  const origin = audience(request, config.origins);
  const header = request.headers.get('authorization') ?? '';
  if (!/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(header) || header.length > 2048) {
    throw new AccessError('access_required', 401);
  }
  const [payload, mac] = header.slice(7).split('.');
  if (!equal(signature(payload, config.secret), mac)) throw new AccessError('access_required', 401);
  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (session.v !== 1 || session.aud !== origin || !Number.isSafeInteger(session.iat) ||
        !Number.isSafeInteger(session.exp) || session.exp !== session.iat + ACCESS_SECONDS ||
        session.iat > now + 60 || session.exp <= now || typeof session.nonce !== 'string') throw Error();
  } catch { throw new AccessError('access_required', 401); }
}

export function accessError(error: unknown) {
  const known = error instanceof JsonInputError;
  return Response.json({ error: known ? error.code : 'invalid_request' }, {
    status: known ? error.status : 400,
    headers: { 'Cache-Control': 'no-store', 'Vary': 'Authorization' },
  });
}
export function accessStatus(request: Request) {
  try {
    requireAccess(request);
    return Response.json({ status: 'ok' }, { headers: { 'Cache-Control': 'no-store', 'Vary': 'Authorization' } });
  } catch (error) { return accessError(error); }
}
export async function exchangeAccess(request: Request) {
  try {
    const config = configuration();
    if (!config) throw new AccessError('access_link_disabled', 400);
    const origin = audience(request, config.origins);
    const body = await readJsonBody(request, 256);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 ||
        !('key' in body) || typeof body.key !== 'string' || !equal(body.key, config.secret)) {
      throw new AccessError('access_required', 401);
    }
    const iat = Math.floor(Date.now() / 1000), exp = iat + ACCESS_SECONDS;
    const payload = Buffer.from(JSON.stringify({ v: 1, aud: origin, iat, exp, nonce: randomUUID() })).toString('base64url');
    return Response.json({ token: `${payload}.${signature(payload, config.secret)}`, expires_at: exp }, {
      headers: { 'Cache-Control': 'no-store', 'Vary': 'Authorization', 'Referrer-Policy': 'no-referrer' },
    });
  } catch (error) { return accessError(error); }
}
