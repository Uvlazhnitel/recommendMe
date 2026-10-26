export class JsonInputError extends Error {
  constructor(public readonly code: string) { super(code); }
}
/** Bounded JSON body reader shared by the catalog and watch endpoints. */
export async function readJsonBody(request: Request): Promise<unknown> {
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
