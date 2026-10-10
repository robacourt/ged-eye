/**
 * Upload checks for the photo commands. The client never sends object keys: an upload is
 * `{ sha256, ext, fileName }`, its keys are derived here, and the stored objects are HEADed (unauthenticated,
 * on the public bucket URL) to confirm they exist and to read their type, size and oriented pixel size.
 * The HEADs run in a command's `prepare` step, before begin_change, so they never hold the global lock.
 */
import { SHA256, TYPES, cleanFileName, keysFor } from '../media/types.js';
import { ApiError, invalid, isObject } from './http.js';

const BUCKET = 'ged-eye-media';
const HEAD_TIMEOUT_MS = 5000;
const MAX_PARALLEL_HEADS = 8;

const UPLOAD_KEYS = ['sha256', 'ext', 'fileName'];
const BUSY_MESSAGE = "Couldn't check the uploaded files — please try again.";
const POSITIVE_INT = /^[1-9][0-9]{0,8}$/;
const SIZE = /^[0-9]{1,15}$/;

const busy = () => new ApiError(503, 'busy', { message: BUSY_MESSAGE });

/**
 * Validates `upload: { sha256, ext, fileName }` from a command's params, where `field` names it (for example
 * 'photos.0.upload'). → { sha256, ext, fileName (trimmed) }.
 * Throws ApiError 400 invalid with `field`, or `<field>.<key>` for a bad or unknown key.
 */
export function validateUpload(upload, field) {
  if (!isObject(upload)) throw invalid(field, `${field} must be an object with sha256, ext and fileName.`);
  for (const key of Object.keys(upload)) {
    if (!UPLOAD_KEYS.includes(key)) throw invalid(`${field}.${key}`, `${key} can't be set here.`);
  }
  const { sha256, ext, fileName } = upload;
  if (typeof sha256 !== 'string' || !SHA256.test(sha256)) {
    throw invalid(`${field}.sha256`, 'sha256 must be 64 lower-case hex digits.');
  }
  if (typeof ext !== 'string' || !TYPES.has(ext)) {
    throw invalid(`${field}.ext`, `ext must be one of ${[...TYPES.keys()].join(', ')}.`);
  }
  const name = cleanFileName(fileName);
  if (name === null) {
    throw invalid(`${field}.fileName`, 'fileName must be 1–255 characters, with no / or \\ or control characters.');
  }
  return { sha256, ext, fileName: name };
}

/** `type` without parameters, in lower case: 'Image/JPEG; x=y' → 'image/jpeg'. */
const mediaType = (type) => (typeof type === 'string' ? type.split(';')[0].trim().toLowerCase() : null);

/**
 * `start(signal)`, rejected with `signal`'s reason as soon as `signal` aborts: after `ms` (a TimeoutError) or
 * when `outer` aborts. `start` isn't called if `outer` has already aborted, and a synchronous throw from it
 * becomes a rejection. Its timer is cleared however it ends.
 */
async function withTimeout(start, ms, outer) {
  outer?.throwIfAborted();
  const timeout = new AbortController();
  const signal = outer ? AbortSignal.any([outer, timeout.signal]) : timeout.signal;
  const timer = setTimeout(() => timeout.abort(new DOMException('The upload check timed out.', 'TimeoutError')), ms);
  let onAbort;
  const aborted = new Promise((resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([start(signal), aborted]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

/**
 * HEADs one object: `headObject(key, { signal })`, with a 5 s timeout, stopped early if `signal` aborts.
 * → headObject's result ({ status, contentType, contentLength, width, height }) when the status is 2xx.
 * Throws ApiError 400 missing_upload { field, index? } for 404 or 403 (a bucket that refuses anonymous listing
 * answers 403 for a missing key), and 503 busy, logged with `log`, on a timeout, an abort, a network error or
 * any other status. An ApiError thrown by `headObject` passes through unchanged. When `pattern` is given,
 * throws TypeError, without a HEAD, unless `key` matches it.
 */
export async function headKey(key, headObject, { field = 'upload', index, log = console.error, pattern, signal } = {}) {
  if (pattern && !pattern.test(key)) throw new TypeError('The key does not match the pattern it must have.');
  let head;
  try {
    head = await withTimeout((combined) => headObject(key, { signal: combined }), HEAD_TIMEOUT_MS, signal);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    log('upload check failed', key, error?.message ?? error);
    throw busy();
  }
  if (head.status === 404 || head.status === 403) {
    throw new ApiError(400, 'missing_upload', index === undefined ? { field } : { index, field });
  }
  if (!(head.status >= 200 && head.status < 300)) {
    log('upload check failed', key, `status ${head.status}`);
    throw busy();
  }
  return head;
}

/**
 * Runs `run(task)` for every task, at most `limit` at a time. On the first failure it aborts `stop` and rejects
 * with that failure; no further task starts.
 */
async function runLimited(tasks, limit, run, stop) {
  let next = 0;
  async function worker() {
    while (!stop.signal.aborted && next < tasks.length) {
      try {
        await run(tasks[next++]);
      } catch (error) {
        stop.abort(new DOMException('Another upload check failed.', 'AbortError'));
        throw error;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
}

const isSize = (value) => Number.isSafeInteger(value) && value >= 0;

/**
 * HEADs each upload's original and, for images, its display image: in parallel, at most 8 at a time, each with
 * a 5 s timeout, before any transaction opens. → [{ contentType, byteSize, width, height }] in input order.
 * `uploads` are validated uploads; a null entry is skipped and gives null, so indices can follow the caller's
 * list. `contentType` and `byteSize` come from the original's response; `width` and `height` from its
 * x-amz-meta-* headers (both null unless both are present, and always null for PDFs).
 * Throws ApiError 400 missing_upload { index, field } when an object is absent (404/403), 400 invalid
 * { field: `<uploadField(index)>.ext`, index } when the stored content type doesn't match ext, and 503 busy on a
 * timeout, a network error, a storage error status or an original without a readable size. `index` is the
 * upload's position in `uploads`; `field` (the `field` option, 'upload' by default) names the list, and
 * `uploadField(index)` the upload itself, as validation names it (by default `field`; for example
 * (i) => `photos.${i}.upload`). An ApiError thrown by `headObject` passes through unchanged.
 * The first failure aborts every HEAD still in flight; a 503 is logged with `log`, at most once per call.
 */
export async function headUploads(uploads, headObject, { field = 'upload', uploadField = () => field, log = console.error } = {}) {
  const found = uploads.map(() => null);
  const tasks = [];
  uploads.forEach((upload, index) => {
    if (upload === null || upload === undefined) return;
    // media/types.js keysFor: the keys media stored the upload under. validateUpload has checked sha256 and ext.
    const { objectKey, displayKey, type } = keysFor(upload);
    tasks.push({ index, key: objectKey, type, original: true });
    if (displayKey) tasks.push({ index, key: displayKey, type, original: false });
  });

  // Once the call has failed, HEADs it aborts fail too; the response is one error, so at most one log line.
  const stop = new AbortController();
  let logged = false;
  const logOnce = (...args) => {
    if (logged || stop.signal.aborted) return;
    logged = true;
    log(...args);
  };

  async function check({ index, key, type, original }) {
    const head = await headKey(key, headObject, { field, index, log: logOnce, signal: stop.signal });
    if (!original) return;
    if (mediaType(head.contentType) !== type.contentType) {
      throw new ApiError(400, 'invalid', {
        field: `${uploadField(index)}.ext`, index, message: `The stored file is not of type ${type.ext}.`
      });
    }
    // media.byte_size is not null: an original without a readable size is storage misbehaving, not the client.
    if (!isSize(head.contentLength)) {
      logOnce('upload check failed', key, 'no readable content-length');
      throw busy();
    }
    const sized = type.image && head.width != null && head.height != null;
    found[index] = {
      contentType: type.contentType,
      byteSize: head.contentLength,
      width: sized ? head.width : null,
      height: sized ? head.height : null
    };
  }

  await runLimited(tasks, MAX_PARALLEL_HEADS, check, stop);
  return found;
}

/** A header as a whole number matching `pattern`, or null when it is missing or isn't one. */
function headerNumber(headers, name, pattern) {
  const value = headers.get(name);
  return value !== null && pattern.test(value) ? Number(value) : null;
}

/**
 * headObject(key, { signal }?) → { status, contentType, contentLength, width, height } from an unauthenticated
 * HEAD of the public URL `<baseUrl>/<key>`, with a 5 s timeout (and aborted early if `signal` aborts).
 * `width` and `height` are the x-amz-meta-width and -height headers as integers, and any missing or unreadable
 * header gives null. A missing object is reported by its status (404, or 403 from a bucket that refuses
 * anonymous listing); a network error, a redirect or a timeout rejects.
 */
export function publicHead(baseUrl, fetchImpl = fetch) {
  return async (key, { signal } = {}) => {
    const timeout = AbortSignal.timeout(HEAD_TIMEOUT_MS);
    const response = await fetchImpl(`${baseUrl}/${key}`, {
      method: 'HEAD',
      redirect: 'error', // a public object is answered directly; never follow a HEAD anywhere else
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout
    });
    const { headers } = response;
    return {
      status: response.status,
      contentType: headers.get('content-type'),
      contentLength: headerNumber(headers, 'content-length', SIZE),
      width: headerNumber(headers, 'x-amz-meta-width', POSITIVE_INT),
      height: headerNumber(headers, 'x-amz-meta-height', POSITIVE_INT)
    };
  };
}

/**
 * The headObject for the ged-eye-media bucket at `env.AWS_ENDPOINT_URL_S3` (see publicHead). When that is
 * unset, the headObject throws ApiError 500 internal on every call, and the problem is logged once.
 */
export function headObjectFromEnv(env, { log = console.error, fetchImpl = fetch } = {}) {
  const endpoint = env.AWS_ENDPOINT_URL_S3;
  if (endpoint) return publicHead(`${endpoint.replace(/\/+$/, '')}/${BUCKET}`, fetchImpl);
  let logged = false;
  return async () => {
    if (!logged) {
      logged = true;
      log('AWS_ENDPOINT_URL_S3 is not set, so uploads cannot be checked');
    }
    throw new ApiError(500, 'internal');
  };
}
