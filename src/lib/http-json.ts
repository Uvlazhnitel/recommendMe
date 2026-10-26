export class JsonInputError extends Error {
  constructor(public readonly code: string, public readonly status = 400) { super(code); }
}
export function assertWriteOrigin(request: Request) {
  const origin = request.headers.get('origin');
  // NextURL normalizes loopback hostnames to localhost. Host retains the actual
  // HTTP authority used by the browser; forwarded host/proto headers are ignored.
  let target = new URL(request.url);
  const host = request.headers.get('host');
  if (host !== null) {
    if (!host || /[\s/\\?#@]/.test(host)) throw new JsonInputError('forbidden_origin', 403);
    try { target = new URL(`${target.protocol}//${host}`); }
    catch { throw new JsonInputError('forbidden_origin', 403); }
  }
  const site = request.headers.get('sec-fetch-site')?.toLowerCase();
  if (site === 'cross-site' || (origin !== null && (origin === 'null' || origin !== target.origin)) ||
    (origin === null && site !== undefined && site !== 'same-origin' && site !== 'none')) {
    throw new JsonInputError('forbidden_origin', 403);
  }
}
/** Shared write boundary: Origin validation and a bounded JSON body. */
export async function readJsonBody(request: Request): Promise<unknown> {
  assertWriteOrigin(request);
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new JsonInputError('expected_json');
  const reader = request.body?.getReader();
  if (!reader) throw new JsonInputError('invalid_json');
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 1024) { await reader.cancel(); throw new JsonInputError('request_too_large'); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { reader.releaseLock(); }
}
