/** Response helpers, CORS policy, API errors and size-limited body reading for the api Function. */

export const MAX_BODY_BYTES = 1024 * 1024;

// Bearer tokens, never cookies, so any origin may call the API.
export const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, if-none-match'
};

/**
 * An error with a response: `{ error: code, ...extra }` sent with `status`.
 * For example `new ApiError(400, 'invalid', { field, message })` or
 * `new ApiError(409, 'conflict', { reason, blocking })`.
 */
export class ApiError extends Error {
  constructor(status, code, extra = {}) {
    super(extra.message ?? code);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const invalid = (field, message) => new ApiError(400, 'invalid', { field, message });

/** A JSON response with CORS headers; `headers` may override the default `cache-control: no-store`. */
export function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }
  });
}

export function errorJson(error) {
  return json(error.status, { error: error.code, ...error.extra });
}

export function notModified(headers) {
  return new Response(null, { status: 304, headers: { ...CORS_HEADERS, ...headers } });
}

export function preflight() {
  return new Response(null, { status: 204, headers: { ...CORS_HEADERS, 'access-control-max-age': '86400' } });
}

const tooLarge = () => new ApiError(413, 'too_large');

async function readBytes(request, limit) {
  const declared = request.headers.get('content-length');
  if (declared !== null && Number(declared) > limit) throw tooLarge();
  if (!request.body) return new Uint8Array(0);

  // Count while streaming, since Content-Length may be absent (chunked) or wrong.
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Reads a JSON object body of at most `limit` bytes. An empty body reads as `{}`.
 * Throws ApiError 413 `too_large`, or 400 `invalid` (field `body`) for anything but a JSON object.
 */
export async function readJson(request, limit = MAX_BODY_BYTES) {
  const text = new TextDecoder().decode(await readBytes(request, limit));
  if (text.trim() === '') return {};
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw invalid('body', 'The request body must be JSON.');
  }
  if (!isObject(body)) throw invalid('body', 'The request body must be a JSON object.');
  return body;
}

export function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
