/**
 * Client for the `media` Function (media/handler.js): upload slots, processing and avatar crops, plus the direct
 * upload to object storage. Calls go through editApi's authenticated fetch, so tokens, retries and errors
 * (ApiError, with the server's `{ error: code }`) behave as they do for the `api` Function.
 */
import { ApiError, mediaClient } from './editApi.js';

const uploadPath = (uploadId) => `/uploads/${encodeURIComponent(uploadId)}`;

// Processing a large photo, or rendering a crop, can wait behind another job in the Function's one-at-a-time queue.
const IMAGE_JOB_TIMEOUT_MS = 120_000;

/**
 * Asks for a presigned slot to upload one file to.
 * → `{ uploadId, url, headers }`: PUT the file to `url` with exactly `headers` (see uploadFile).
 * Rejects with ApiError (`too_large`, `unsupported_type`, `invalid`, ...).
 */
export const requestUpload = ({ fileName, contentType, byteSize }) =>
  mediaClient.authedFetch('/uploads', { method: 'POST', body: { fileName, contentType, byteSize } });

/**
 * PUTs `file` to a presigned slot with XMLHttpRequest, because fetch can't report upload progress.
 * `onProgress(fraction)` gets 0..1 as bytes go out. `signal` aborts the upload.
 * Sets only `slot.headers` (the URL signs its content type and length, so nothing else may be added).
 * Resolves with nothing when storage accepts the file. Rejects with ApiError(0, 'network') on a network failure,
 * ApiError(0, 'aborted') on abort, and ApiError(status, 'upload_failed') on a non-2xx (403 means the slot
 * expired or was already used).
 */
export function uploadFile(slot, file, { onProgress, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ApiError(0, 'aborted', { message: 'The upload was cancelled.' }));
      return;
    }
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const finish = (settle, value) => {
      signal?.removeEventListener('abort', abort);
      settle(value);
    };

    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable && event.total > 0) onProgress?.(Math.min(1, event.loaded / event.total));
    });
    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(1);
        finish(resolve);
      } else {
        const message = xhr.status === 403
          ? 'The upload link expired or was already used. Try again.'
          : `Storage rejected the upload (${xhr.status}).`;
        finish(reject, new ApiError(xhr.status, 'upload_failed', { message }));
      }
    });
    xhr.addEventListener('error', () => {
      finish(reject, new ApiError(0, 'network', { message: "Couldn't upload the file. Check your connection." }));
    });
    xhr.addEventListener('abort', () => {
      finish(reject, new ApiError(0, 'aborted', { message: 'The upload was cancelled.' }));
    });

    signal?.addEventListener('abort', abort, { once: true });
    try {
      xhr.open('PUT', slot.url);
      for (const [name, value] of Object.entries(slot.headers ?? {})) xhr.setRequestHeader(name, value);
      xhr.send(file);
    } catch {
      finish(reject, new ApiError(0, 'network', { message: "Couldn't upload the file. Check your connection." }));
    }
  });
}

/**
 * Checks, dedupes and processes an uploaded file.
 * → `{ mediaId | null, sha256, ext, objectKey, displayKey, thumbKey, contentType, byteSize, width, height,
 * fileName, caption, date }`; `mediaId`, `caption` and `date` are set when the tree already has this file.
 * Rejects with ApiError: `not_found` when the upload was already processed or swept (upload the file again),
 * `heic_unsupported`, `unsupported_type`, `too_large`, `busy` (retry later), ...
 */
export const processUpload = async (uploadId, fileName) =>
  (await mediaClient.authedFetch(`${uploadPath(uploadId)}/process`, {
    method: 'POST',
    body: { fileName },
    timeoutMs: IMAGE_JOB_TIMEOUT_MS
  })).media;

/**
 * Deletes an upload that won't be processed (cancelled, or its card removed). Never rejects: a failure is
 * logged, because the Function sweeps leftover uploads within the hour anyway.
 */
export async function discardUpload(uploadId) {
  try {
    await mediaClient.authedFetch(uploadPath(uploadId), { method: 'DELETE' });
  } catch (error) {
    console.warn('Could not discard upload', uploadId, error?.code ?? error?.message);
  }
}

/**
 * Renders `crop` ({ x, y, w, h }, fractions of the oriented image) of the original at `objectKey` as an avatar.
 * → the avatar's key. Rejects with ApiError (`invalid`, `not_found`, `busy`, ...).
 */
export const renderAvatar = async (objectKey, crop) =>
  (await mediaClient.authedFetch('/avatars', {
    method: 'POST',
    body: { objectKey, crop },
    timeoutMs: IMAGE_JOB_TIMEOUT_MS
  })).avatarKey;
