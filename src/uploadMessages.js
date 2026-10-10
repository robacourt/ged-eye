/**
 * The words shown for an upload that failed, shared by everything that runs the upload queue (the Add photos sheet,
 * Change avatar's "Upload new"). Plain text, with no DOM.
 */
import { NOT_AN_EDITOR_MESSAGE } from './changeMessages.js';

const TYPE_AND_SIZE = 'PDFs and images only, up to 50 MB.';

/** What a card says for each refusal of the file itself, which retrying can't change. */
export const REFUSALS = new Map([
  ['unsupported_type', TYPE_AND_SIZE],
  ['too_large', TYPE_AND_SIZE],
  ['heic_unsupported', "This HEIC file couldn't be read. Export it as JPEG and try again."],
  ['unreadable', "This file couldn't be read."],
  ['empty', 'This file is empty.'],
  ['too_many_pixels', 'This image is too large to process. Make it smaller than 100 megapixels and try again.']
]);

/**
 * The words for an upload queue item's error (an ApiError from mediaApi.js, or `missing_upload` from saving).
 * → plain text.
 */
export function uploadErrorMessage(error) {
  const code = error?.code;
  if (REFUSALS.has(code)) return REFUSALS.get(code);
  if (code === 'invalid') return error.message && error.message !== code ? error.message : "This file can't be uploaded.";
  if (code === 'missing_upload') return 'This upload has gone missing. Retry to upload it again.';
  if (code === 'busy') return 'The server is busy. Retry in a moment.';
  if (error?.status === 401) return "You're signed out. Sign in again, then retry.";
  if (error?.status === 403 && code !== 'upload_failed') return NOT_AN_EDITOR_MESSAGE;
  if (code === 'network') return 'Upload failed. Check your connection, then retry.';
  return 'Upload failed.';
}
