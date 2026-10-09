/**
 * Upload checks for the photo commands. The client never sends object keys: an upload is
 * `{ sha256, ext, fileName }`, its keys are derived here, and the stored objects are HEADed (unauthenticated,
 * on the public bucket URL) to confirm they exist and to read their type, size and oriented pixel size.
 * The HEADs run in a command's `prepare` step, before begin_change, so they never hold the global lock.
 */
import { SHA256, TYPES, cleanFileName } from '../media/types.js';
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
 * The keys of an upload: originals/<sha>.<ext>, plus display/ and thumbs/ for images.
 * → { objectKey, displayKey | null, thumbKey | null, type (the TYPES entry) }.
 * Throws TypeError for an ext outside TYPES; validateUpload rules that out.
 */
export function keysFor({ sha256, ext }) {
  const type = TYPES.get(ext);
  if (!type) throw new TypeError(`Not an accepted file type: ${ext}.`);
  return {
    objectKey: `originals/${sha256}.${type.ext}`,
    displayKey: type.image ? `display/${sha256}.webp` : null,
    thumbKey: type.image ? `thumbs/${sha256}.webp` : null,
    type
  };
}

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
 * `start(signal)`, rejected with a TimeoutError (and `signal` aborted) when it takes longer than `ms`.
 * A synchronous throw from `start` becomes a rejection.
 */
function withTimeout(start, ms) {
  const controller = new AbortController();
  let timer;
  const timedOut = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      const error = new DOMException('The upload check timed out.', 'TimeoutError');
      controller.abort(error);
      reject(error);
    }, ms);
  });
  const started = new Promise((resolve) => resolve(start(controller.signal)));
  return Promise.race([started, timedOut]).finally(() => clearTimeout(timer));
}

/**
 * Runs `run(task)` for every task, at most `limit` at a time. Rejects with the first failure, after which no
 * further task starts.
 */
async function runLimited(tasks, limit, run) {
  let next = 0;
  let failed = false;
  async function worker() {
    while (!failed && next < tasks.length) {
      try {
        await run(tasks[next++]);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
}

/**
 * HEADs each upload's original and, for images, its display image: in parallel, at most 8 at a time, each with
 * a 5 s timeout, before any transaction opens. → [{ contentType, byteSize, width, height }] in input order.
 * `uploads` are validated uploads; a null entry is skipped and gives null, so indices can follow the caller's
 * list. `contentType` and `byteSize` come from the original's response; `width` and `height` from its
 * x-amz-meta-* headers (both null unless both are present, and always null for PDFs).
 * Throws ApiError 400 missing_upload { index, field } when an object is absent (404/403), 400 invalid when the
 * stored content type doesn't match ext, and 503 busy on a timeout, a network error or a storage error status.
 * `index` is the upload's position in `uploads`, and `field` the `field` option ('upload' by default).
 * An ApiError thrown by `headObject` passes through unchanged. A 503 is logged with `log`, once per call.
 */
export async function headUploads(uploads, headObject, { field = 'upload', log = console.error } = {}) {
  const found = uploads.map(() => null);
  const tasks = [];
  uploads.forEach((upload, index) => {
    if (upload === null || upload === undefined) return;
    const { objectKey, displayKey, type } = keysFor(upload);
    tasks.push({ index, key: objectKey, type, original: true });
    if (displayKey) tasks.push({ index, key: displayKey, type, original: false });
  });

  // HEADs already in flight may fail too once one has; the response is one 503, so one log line.
  let logged = false;
  const unavailable = (key, reason) => {
    if (!logged) {
      logged = true;
      log('upload check failed', key, reason);
    }
    return busy();
  };

  async function check({ index, key, type, original }) {
    let head;
    try {
      head = await withTimeout((signal) => headObject(key, { signal }), HEAD_TIMEOUT_MS);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw unavailable(key, error?.message ?? error);
    }
    if (head.status === 404 || head.status === 403) throw new ApiError(400, 'missing_upload', { index, field });
    if (!(head.status >= 200 && head.status < 300)) throw unavailable(key, `status ${head.status}`);
    if (!original) return;
    if (mediaType(head.contentType) !== type.contentType) {
      throw new ApiError(400, 'invalid', {
        field: `${field}.ext`, index, message: `The stored file is not of type ${type.ext}.`
      });
    }
    const sized = type.image && head.width != null && head.height != null;
    found[index] = {
      contentType: type.contentType,
      byteSize: head.contentLength,
      width: sized ? head.width : null,
      height: sized ? head.height : null
    };
  }

  await runLimited(tasks, MAX_PARALLEL_HEADS, check);
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
 * anonymous listing); a network error or timeout rejects.
 */
export function publicHead(baseUrl, fetchImpl = fetch) {
  return async (key, { signal } = {}) => {
    const timeout = AbortSignal.timeout(HEAD_TIMEOUT_MS);
    const response = await fetchImpl(`${baseUrl}/${key}`, {
      method: 'HEAD',
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
