/**
 * The media Function's object storage: the ged-eye-media bucket through the S3 API.
 * Every call has a deadline, so a hung request can't hold the one-at-a-time job queue (jobQueue.js) for ever.
 */
import {
  DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { MAX_UPLOAD_BYTES } from './types.js';
import { ImagingError } from './imaging.js';

/** The bucket on every branch (storage branches with the database). */
export const BUCKET = 'ged-eye-media';
const PRESIGN_SECONDS = 900;
const ATTEMPTS = 3; // putOnce: the first try and two retries, as uploadMedia.js's withRetry
/** Milliseconds allowed per call: `transfer` for a GET or PUT (up to 50 MB), `quick` for a HEAD, DELETE or LIST page. */
export const TIMEOUTS = Object.freeze({ transfer: 60_000, quick: 10_000 });

const httpStatus = (error) => error?.$metadata?.httpStatusCode;
const isNotFound = (error) => httpStatus(error) === 404 || error?.name === 'NoSuchKey' || error?.name === 'NotFound';
/** Worth another try: no HTTP status (a network error or timeout), a 5xx, 408 or 429. */
function isTransient(error) {
  const status = httpStatus(error);
  return status === undefined || status >= 500 || status === 408 || status === 429;
}

/**
 * `promise`, or a rejection with `signal`'s reason once it aborts, after `onAbort` (which releases what `promise`
 * is waiting on). For a response body, which keeps arriving after `send` has resolved.
 */
function untilAborted(signal, promise, onAbort) {
  let listener;
  const aborted = new Promise((_, reject) => {
    listener = () => {
      onAbort();
      reject(signal.reason);
    };
  });
  if (signal.aborted) listener();
  else signal.addEventListener('abort', listener, { once: true });
  return Promise.race([promise, aborted]).finally(() => signal.removeEventListener('abort', listener));
}

/**
 * The bucket's operations. `client` defaults to the S3 client configured by the injected AWS_* env vars, with
 * checksums only where S3 requires them: otherwise a presigned PUT would carry the CRC32 of an empty body.
 * `timeouts` and `retryDelay(attempt)` (ms before retry `attempt`) are injectable for tests.
 * → { presignPut, get, exists, putOnce, remove, listOlderThan }
 */
export function createStorage({
  client = new S3Client({ forcePathStyle: true, requestChecksumCalculation: 'WHEN_REQUIRED' }),
  bucket = BUCKET,
  timeouts = TIMEOUTS,
  retryDelay = (attempt) => 500 * 2 ** attempt
} = {}) {
  const send = (command, ms) => client.send(command, { abortSignal: AbortSignal.timeout(ms) });

  async function withRetry(operation) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await operation();
      } catch (error) {
        if (attempt >= ATTEMPTS || !isTransient(error)) throw error;
        await new Promise((resolve) => setTimeout(resolve, retryDelay(attempt)));
      }
    }
  }

  /** A URL for one PUT of `key`, valid for 15 minutes, whose Content-Type and Content-Length are signed. */
  function presignPut(key, contentType, contentLength) {
    const command = new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType, ContentLength: contentLength });
    return getSignedUrl(client, command, {
      expiresIn: PRESIGN_SECONDS,
      signableHeaders: new Set(['content-type', 'content-length'])
    });
  }

  /**
   * The object's bytes as a Buffer, or null when there is no such object. Throws ImagingError('too_large', 413)
   * when it is over MAX_UPLOAD_BYTES, before reading the body; anything else (including a timeout) is rethrown.
   */
  async function get(key) {
    const signal = AbortSignal.timeout(timeouts.transfer);
    let response;
    try {
      response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: signal });
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
    const body = response.Body;
    if (response.ContentLength > MAX_UPLOAD_BYTES) {
      body?.destroy?.();
      throw new ImagingError('too_large', 413);
    }
    if (!body) return Buffer.alloc(0);
    const bytes = await untilAborted(signal, body.transformToByteArray(), () => body.destroy?.());
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  /** Is there an object at `key`? A HEAD: true, false on 404, and throws on anything else. */
  async function exists(key) {
    try {
      await send(new HeadObjectCommand({ Bucket: bucket, Key: key }), timeouts.quick);
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  /**
   * Writes `body` to `key` unless an object is already there, so an immutable key never changes content.
   * The HEAD and the PUT are each retried twice on a transient error. → 'exists' | 'uploaded'
   */
  async function putOnce(key, body, { contentType, cacheControl, contentDisposition, metadata } = {}) {
    if (await withRetry(() => exists(key))) return 'exists';
    await withRetry(() => send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: cacheControl,
      ContentDisposition: contentDisposition,
      Metadata: metadata
    }), timeouts.transfer));
    return 'uploaded';
  }

  /** Deletes `key`; an object that is already gone is fine. */
  async function remove(key) {
    try {
      await send(new DeleteObjectCommand({ Bucket: bucket, Key: key }), timeouts.quick);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  /** → the keys under `prefix` last modified before `cutoff` (a Date), from every page of the listing. */
  async function listOlderThan(prefix, cutoff) {
    const keys = [];
    let token;
    do {
      const page = await send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }), timeouts.quick);
      for (const object of page.Contents ?? []) if (object.LastModified < cutoff) keys.push(object.Key);
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return keys;
  }

  return { presignPut, get, exists, putOnce, remove, listOlderThan };
}
