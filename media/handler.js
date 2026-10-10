/**
 * The media Function's router: presigned upload slots, processing uploads into originals, display images and
 * thumbnails, avatar crops, and the hourly sweep of abandoned uploads. See the photos design, "Function `media`".
 */
import { randomUUID } from 'node:crypto';
import { AuthError, requireEditor } from '../api/auth.js';
import { ApiError, CORS_HEADERS, errorJson, invalid, json, preflight, readJson } from '../api/http.js';
import { CropError, avatarKeyFor } from './crop.js';
import { BusyError } from './jobQueue.js';
import {
  IMMUTABLE, ImagingError, MAX_UPLOAD_BYTES, UUID, cleanFileName, declaredType, inlineDisposition, keysFor
} from './types.js';

// Defined in types.js, which the backfill script shares; re-exported for existing importers.
export { IMMUTABLE };
/** The schedule trigger declared in neon.ts that POSTs to /sweep. */
export const SWEEP_TRIGGER = 'sweep-incoming';

const INCOMING_MAX_AGE_MS = 60 * 60 * 1000;
const ORIGINAL_KEY = /^originals\/([0-9a-f]{64})\.[a-z0-9]+$/;
const BUSY_MESSAGE = 'Busy processing photos. Try again in a moment.';
const FILE_NAME_MESSAGE = 'The file name must be 1 to 255 characters, with no / \\ or control characters.';

const noContent = () => new Response(null, { status: 204, headers: { ...CORS_HEADERS, 'cache-control': 'no-store' } });

/** The incoming/ key of the upload `raw` (a path segment). Throws 400 invalid (field id) unless it is a UUID. */
function incomingKey(raw) {
  if (!UUID.test(raw)) throw invalid('id', 'Not an upload id.');
  return `incoming/${raw}`;
}

/** The body's fileName, trimmed. Throws 400 invalid (field fileName) unless cleanFileName accepts it. */
function fileNameOf(body) {
  const name = cleanFileName(body.fileName);
  if (name === null) throw invalid('fileName', FILE_NAME_MESSAGE);
  return name;
}

const extOf = (key) => /\.([A-Za-z0-9]+)$/.exec(key)?.[1].toLowerCase() ?? null;

/** An existing media row (from db.mediaBySha) as the `media` /process returns. */
const mediaFromRow = (row) => ({
  mediaId: Number(row.id),
  sha256: row.sha256,
  ext: extOf(row.object_key),
  objectKey: row.object_key,
  displayKey: row.display_key,
  thumbKey: row.thumb_key,
  contentType: row.content_type,
  byteSize: Number(row.byte_size),
  width: row.width,
  height: row.height,
  fileName: row.file_name,
  caption: row.caption,
  date: row.date
});

/** The response for an error we answer deliberately (unlogged), or null for anything unexpected. */
function deliberateResponse(error) {
  if (error instanceof AuthError) return errorJson({ status: error.status, code: error.code });
  if (error instanceof ApiError) return errorJson(error);
  if (error instanceof ImagingError) return errorJson(new ApiError(error.status, error.code));
  if (error instanceof CropError) return errorJson(invalid(error.field, error.message));
  if (error instanceof BusyError) return errorJson(new ApiError(503, 'busy', { message: BUSY_MESSAGE }));
  return null;
}

/**
 * The media Function's router: (request) → Response.
 *
 * @param storage  (media/storage.js createStorage) { presignPut, get, exists, putOnce, remove, listOlderThan }
 * @param db  (media/db.js createMediaDb) { lookupEditor(email), mediaBySha(sha256) → media row | null }
 * @param authenticate  (request) → { email, name } | null; throws AuthError(401) for a bad token
 * @param imaging  media/imaging.js (injected so tests can spy on it)
 * @param queue  (media/jobQueue.js createJobQueue) { run(job) }; image jobs, and their downloads, run inside it
 * @param parseTrigger  parseTriggerDelivery from @neon/functions/triggers: (request) → { ok, invocation | error }
 * Every route but /health, preflight and /sweep requires an editor, checked before the input is validated.
 * Deliberate errors are answered unlogged; anything else is logged and a 500 internal.
 */
export function createMediaHandler({ storage, db, authenticate, imaging, queue, parseTrigger, now = () => new Date(), log = console.error }) {
  async function requireEditorOf(request) {
    const user = await authenticate(request);
    try {
      return await requireEditor(user, (email) => db.lookupEditor(email));
    } catch (error) {
      if (error instanceof AuthError && error.status === 403) throw new ApiError(403, 'not_an_editor', { email: user.email });
      throw error;
    }
  }

  /** Deletes an upload we are done with. A failure is only logged: the hourly sweep deletes it anyway. */
  async function discard(key) {
    try {
      await storage.remove(key);
    } catch (error) {
      log('could not delete', key, error);
    }
  }

  async function createUpload({ request }) {
    await requireEditorOf(request);
    const body = await readJson(request);
    fileNameOf(body);
    let contentType;
    try {
      contentType = declaredType(body.contentType);
    } catch (error) {
      if (error.code && error.status) throw new ApiError(error.status, error.code);
      throw error;
    }
    const { byteSize } = body;
    if (!Number.isSafeInteger(byteSize) || byteSize < 0) throw invalid('byteSize', 'byteSize must be the file size in bytes.');
    // The same codes /process gives for the same file.
    if (byteSize === 0) throw new ApiError(400, 'empty');
    if (byteSize > MAX_UPLOAD_BYTES) throw new ApiError(413, 'too_large');
    const uploadId = randomUUID();
    const url = await storage.presignPut(`incoming/${uploadId}`, contentType, byteSize);
    // Only Content-Type: browsers set Content-Length themselves.
    return json(200, { uploadId, url, headers: { 'Content-Type': contentType } });
  }

  /** Stores a processed upload's original, display image and thumbnail, each only if absent. */
  async function store(processed, fileName) {
    const { sha256, type, original, display, thumb, width, height } = processed;
    const { objectKey, displayKey, thumbKey } = keysFor({ sha256, ext: type.ext });
    const puts = [storage.putOnce(objectKey, original.body, {
      contentType: type.contentType,
      cacheControl: IMMUTABLE,
      contentDisposition: inlineDisposition(fileName),
      // The oriented size, which api reads back from the original's x-amz-meta-* headers.
      metadata: type.image ? { width: String(width), height: String(height) } : undefined
    })];
    if (type.image) {
      puts.push(storage.putOnce(displayKey, display, { contentType: 'image/webp', cacheControl: IMMUTABLE }));
      puts.push(storage.putOnce(thumbKey, thumb, { contentType: 'image/webp', cacheControl: IMMUTABLE }));
    }
    // Settle every write before failing, so none is still holding its buffer once the next job starts.
    const failed = (await Promise.allSettled(puts)).find((result) => result.status === 'rejected');
    if (failed) throw failed.reason;
  }

  /**
   * The queued job of /process: download, check, dedupe, process, store, then delete the upload. A permanent
   * rejection (ImagingError) deletes it too; a transient failure leaves it, so a retry can run again.
   */
  async function processIncoming(key, fileName) {
    try {
      const buffer = await storage.get(key);
      if (buffer === null) throw new ApiError(404, 'not_found');
      const { sha256 } = imaging.inspect(buffer);
      const existing = await db.mediaBySha(sha256);
      if (existing) {
        await discard(key);
        return mediaFromRow(existing);
      }
      const processed = await imaging.processFile(buffer);
      await store(processed, fileName);
      await discard(key);
      const { type, original, width, height } = processed;
      const { objectKey, displayKey, thumbKey } = keysFor({ sha256: processed.sha256, ext: type.ext });
      return {
        mediaId: null,
        sha256,
        ext: type.ext,
        objectKey,
        displayKey,
        thumbKey,
        contentType: type.contentType,
        byteSize: original.body.length,
        width,
        height,
        fileName,
        caption: null,
        date: null
      };
    } catch (error) {
      if (error instanceof ImagingError && error.permanent) await discard(key);
      throw error;
    }
  }

  async function processUpload({ request, params: [raw] }) {
    await requireEditorOf(request);
    const key = incomingKey(raw);
    const fileName = fileNameOf(await readJson(request));
    const media = await queue.run(() => processIncoming(key, fileName));
    return json(200, { media });
  }

  async function deleteUpload({ request, params: [raw] }) {
    await requireEditorOf(request);
    await storage.remove(incomingKey(raw));
    return noContent();
  }

  /** The queued job of /avatars: renders `crop` of the image at `objectKey` and stores it at `avatarKey`. */
  async function renderAvatarJob(objectKey, crop, avatarKey) {
    const buffer = await storage.get(objectKey);
    if (buffer === null) throw new ApiError(404, 'not_found');
    if (!imaging.inspect(buffer).type.image) throw invalid('objectKey', 'Only images can be avatars.');
    const avatar = await imaging.renderAvatar(buffer, crop);
    await storage.putOnce(avatarKey, avatar, { contentType: 'image/webp', cacheControl: IMMUTABLE });
  }

  async function createAvatar({ request }) {
    await requireEditorOf(request);
    const { objectKey, crop } = await readJson(request);
    const match = typeof objectKey === 'string' ? ORIGINAL_KEY.exec(objectKey) : null;
    if (!match) throw invalid('objectKey', 'objectKey must be an original: originals/<sha256>.<ext>.');
    const avatarKey = avatarKeyFor(match[1], crop); // CropError for a bad crop
    // Idempotent: the key is a function of the original and the crop, so an existing one is this very avatar.
    if (!(await storage.exists(avatarKey))) await queue.run(() => renderAvatarJob(objectKey, crop, avatarKey));
    return json(200, { avatarKey });
  }

  async function sweep({ request }) {
    // The proxy strips client x-neon-* headers, but the body can be forged, so the name check is only a sanity
    // check. A forged sweep is harmless: it only deletes abandoned uploads.
    const delivery = await parseTrigger(request);
    if (!delivery.ok) throw new ApiError(delivery.error === 'invalid_body' ? 400 : 401, delivery.error);
    const { invocation } = delivery;
    if (invocation.type !== 'schedule' || invocation.trigger.name !== SWEEP_TRIGGER) {
      throw new ApiError(400, 'unknown_trigger', { message: `Not the ${SWEEP_TRIGGER} trigger.` });
    }
    const keys = await storage.listOlderThan('incoming/', new Date(now().getTime() - INCOMING_MAX_AGE_MS));
    let deleted = 0;
    let failed = 0;
    // One failed delete doesn't stop the rest; next hour's sweep tries it again.
    for (const key of keys) {
      try {
        await storage.remove(key);
        deleted++;
      } catch (error) {
        failed++;
        log('sweep could not delete', key, error);
      }
    }
    return json(200, { deleted, failed });
  }

  const routes = [
    ['GET', /^\/health$/, async () => json(200, { ok: true })],
    ['POST', /^\/uploads$/, createUpload],
    ['POST', /^\/uploads\/([^/]+)\/process$/, processUpload],
    ['DELETE', /^\/uploads\/([^/]+)$/, deleteUpload],
    ['POST', /^\/avatars$/, createAvatar],
    ['POST', /^\/sweep$/, sweep]
  ];

  return async function handle(request) {
    if (request.method === 'OPTIONS') return preflight();
    const url = new URL(request.url);
    try {
      for (const [method, pattern, run] of routes) {
        if (method !== request.method) continue;
        const match = pattern.exec(url.pathname);
        if (match) return await run({ request, url, params: match.slice(1) });
      }
      return json(404, { error: 'not_found' });
    } catch (error) {
      const response = deliberateResponse(error);
      if (response) return response;
      log('request failed', request.method, url.pathname, error);
      return json(500, { error: 'internal' });
    }
  };
}
