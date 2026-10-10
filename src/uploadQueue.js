/**
 * The upload queue behind the Add photos sheet: one small state machine per file, with no DOM.
 *
 *   queued → uploading (progress) → processing → ready (media) | failed (error, retryable)
 *
 * Each file gets an upload slot from the `media` Function, is PUT straight to object storage, then processed.
 * A failed file can be retried from where it stopped: the upload again (reusing its slot while it's fresh) or the
 * processing again (uploading the file again if the Function says the upload is gone). A `busy` answer (the
 * Function's image queue is full) is retried once by itself, after about 3 seconds, before the file fails.
 */

/** Upload slots expire after 15 minutes; one older than this is replaced rather than reused. */
const SLOT_REUSE_MS = 14 * 60 * 1000;

/** Rejections of the file itself, which retrying won't change. Everything else may be retried. */
const PERMANENT_CODES = new Set([
  'invalid', 'unsupported_type', 'heic_unsupported', 'unreadable', 'too_large', 'empty', 'too_many_pixels'
]);

const ACTIVE_STATES = new Set(['queued', 'uploading', 'processing']);

/** How long to wait before the one automatic retry of a call the media Function answered 503 `busy`. */
export const BUSY_RETRY_MS = 3000;

const isRetryable = (error) => !PERMANENT_CODES.has(error?.code);
const isGone = (error) => error?.status === 404;
const isBusy = (error) => error?.code === 'busy';

/** Resolves after `ms`, or as soon as `signal` aborts (clearing the timer). */
function pause(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Creates an upload queue.
 * @param api          `{ requestUpload, uploadFile, processUpload, discardUpload }`, as in src/mediaApi.js.
 * @param concurrency  How many files may be uploading or processing at once.
 * @param onChange     (items) → void, called after every change with the current items.
 * @param now          () → ms, the clock used to judge a slot's age.
 * → `{ add, retry, markFailed, remove, cancel, items, allSettled, hasActive }`.
 *
 * Items are live objects, updated in place: `{ id, file, state, progress, media, error, retryable, duplicateOf }`.
 * - `state` is 'queued', 'uploading', 'processing', 'ready' or 'failed'; `progress` is the upload's 0..1.
 * - `media` is processUpload's result once ready (see src/mediaApi.js).
 * - `error` is the ApiError a failed item stopped on, and `retryable` says whether `retry` can help. An item
 *   answered `busy` keeps its state and its place for BUSY_RETRY_MS, then tries that step once more; only a second
 *   `busy` fails it (retryably).
 * - `duplicateOf` is the earlier ready item with the same sha256. A duplicate is ready, with `media: null`.
 */
export function createUploadQueue({ api, concurrency = 2, onChange = () => {}, now = () => Date.now() }) {
  const limit = Math.max(1, concurrency);
  const entries = [];
  let running = 0;
  let nextId = 0;
  let waiters = [];

  const items = () => entries.map((entry) => entry.item);
  const hasActive = () => entries.some((entry) => ACTIVE_STATES.has(entry.item.state));
  const find = (item) => entries.find((entry) => entry.item === item);

  function notify() {
    const list = items();
    // A throwing UI callback mustn't fail an upload, or leave the queue half updated.
    try {
      onChange(list);
    } catch (error) {
      console.error('Upload queue onChange failed', error);
    }
    if (waiters.length && !hasActive()) {
      const settled = waiters;
      waiters = [];
      for (const resolve of settled) resolve(list);
    }
  }

  function update(entry, changes) {
    if (entry.removed) return;
    Object.assign(entry.item, changes);
    notify();
  }

  /** Among ready items with this sha, the first keeps its media and the rest become its duplicates. */
  function regroup(sha256) {
    if (!sha256) return;
    const group = entries.filter((entry) => entry.item.state === 'ready' && entry.media?.sha256 === sha256);
    group.forEach((entry, i) => Object.assign(entry.item, i === 0
      ? { media: entry.media, duplicateOf: null }
      : { media: null, duplicateOf: group[0].item }));
  }

  function becomeReady(entry, media) {
    entry.media = media;
    Object.assign(entry.item, { state: 'ready', progress: 1, media, error: null, retryable: false, duplicateOf: null });
    regroup(media?.sha256);
    notify();
  }

  function becomeFailed(entry, error, retryable) {
    const wasReady = entry.item.state === 'ready';
    Object.assign(entry.item, { state: 'failed', error, retryable, media: null, duplicateOf: null });
    if (wasReady) regroup(entry.media?.sha256);
    notify();
  }

  /** Gets a slot unless the entry has a fresh one, then PUTs the file to it. */
  async function upload(entry, signal) {
    const { file } = entry.item;
    update(entry, { state: 'uploading', progress: 0 });
    if (!entry.slot || now() - entry.slotAt >= SLOT_REUSE_MS) {
      const slotAt = now();
      const slot = await api.requestUpload({ fileName: file.name, contentType: file.type, byteSize: file.size });
      if (entry.removed) return;
      Object.assign(entry, { slot, slotAt });
    }
    const onProgress = (progress) => {
      if (entry.item.state === 'uploading' && progress !== entry.item.progress) update(entry, { progress });
    };
    try {
      await api.uploadFile(entry.slot, file, { onProgress, signal });
    } catch (error) {
      if (error?.status === 403) entry.slot = null; // expired, or already used
      throw error;
    }
    if (entry.removed) return;
    // A slot takes one upload: the next upload of this file asks for a new one.
    Object.assign(entry, { uploadId: entry.slot.uploadId, incoming: true, slot: null, next: 'process' });
  }

  /**
   * Runs one entry from where it stopped until it is ready, fails or is removed. A first `busy` is waited out
   * (BUSY_RETRY_MS, keeping the entry's place) and the step tried again; a second one fails the entry.
   */
  async function run(entry, signal) {
    let uploadedNow = false;
    let busyRetried = false;
    for (;;) {
      try {
        if (entry.next === 'upload') {
          await upload(entry, signal);
          if (entry.removed) return;
          uploadedNow = true;
        }
        update(entry, { state: 'processing', progress: 1 });
        let media;
        try {
          media = await api.processUpload(entry.uploadId, entry.item.file.name);
        } catch (error) {
          if (entry.removed) return;
          // The Function deletes the upload on success or on a permanent rejection; a 404 means it's gone.
          if (isGone(error) || !isRetryable(error)) entry.incoming = false;
          // Gone (processed already, or swept): upload it again, unless it was only just uploaded.
          if (isGone(error) && !uploadedNow) {
            entry.next = 'upload';
            continue;
          }
          throw error;
        }
        if (entry.removed) return;
        entry.incoming = false;
        // Free the place before onChange and allSettled hear of it, so a retry from them can start at once.
        release(entry);
        becomeReady(entry, media);
        return;
      } catch (error) {
        if (entry.removed) return;
        if (isBusy(error) && !busyRetried) {
          busyRetried = true;
          await pause(BUSY_RETRY_MS, signal);
          if (entry.removed) return;
          continue;
        }
        release(entry);
        becomeFailed(entry, error, isRetryable(error));
        return;
      }
    }
  }

  /** Frees an entry's place among the `concurrency` running ones, once. */
  function release(entry) {
    if (!entry.running) return;
    entry.running = false;
    running -= 1;
  }

  function start(entry) {
    const controller = new AbortController();
    Object.assign(entry, { running: true, controller });
    running += 1;
    run(entry, controller.signal)
      .catch((error) => console.error('Upload queue failed', error)) // run() handles its own errors; a backstop
      .finally(() => {
        release(entry);
        pump();
      });
  }

  function pump() {
    while (running < limit) {
      const entry = entries.find((candidate) => candidate.item.state === 'queued' && !candidate.running);
      if (!entry) return;
      start(entry);
    }
  }

  /**
   * Stops an entry's work, and deletes its upload if it was uploaded but not processed.
   * Its place is freed at once, but processUpload takes no signal: a request already sent runs on, so one extra
   * request can briefly overlap the next file's. That's harmless, because the Function runs image jobs one at a time.
   */
  function drop(entry) {
    entry.removed = true;
    release(entry);
    entry.controller?.abort();
    if (entry.incoming) {
      entry.incoming = false;
      api.discardUpload(entry.uploadId);
    }
  }

  return {
    /** Queues `files` (a FileList or an array of Files) and starts uploading. → the new items. */
    add(files) {
      const added = Array.from(files ?? [], (file) => {
        const item = {
          id: ++nextId, file, state: 'queued', progress: 0, media: null, error: null, retryable: false, duplicateOf: null
        };
        entries.push({
          item, next: 'upload', slot: null, slotAt: 0, uploadId: null, incoming: false, media: null,
          running: false, controller: null, removed: false
        });
        return item;
      });
      if (added.length) {
        notify();
        pump();
      }
      return added;
    },

    /**
     * Queues a failed, retryable item again, resuming where it stopped. → whether it was queued.
     * An upload reuses its slot while it's under 14 minutes old and storage didn't refuse it (403).
     * Processing runs again on the same upload, and uploads the file again with a new slot if that is gone (404).
     */
    retry(item) {
      const entry = find(item);
      if (!entry || item.state !== 'failed' || !item.retryable) return false;
      const progress = entry.next === 'process' ? 1 : 0;
      Object.assign(item, { state: 'queued', progress, error: null, retryable: false });
      notify();
      pump();
      return true;
    },

    /**
     * Fails a ready item with `error`, retryably, e.g. when saving reports `missing_upload`.
     * Retrying it processes the file again, uploading it again if the upload is gone.
     * → whether it applied (false for an item that isn't ready, or isn't in the queue).
     */
    markFailed(item, error) {
      const entry = find(item);
      if (!entry || item.state !== 'ready') return false;
      // A ready item was uploaded, so it already resumes at processing.
      becomeFailed(entry, error, true);
      return true;
    },

    /** Drops one item: aborts its upload, or deletes its upload if it was uploaded but not yet processed. */
    remove(item) {
      const entry = find(item);
      if (!entry) return;
      drop(entry);
      entries.splice(entries.indexOf(entry), 1);
      if (item.state === 'ready') regroup(entry.media?.sha256);
      notify();
      pump();
    },

    /** Drops every item, as remove() does for one, leaving the queue empty (and ready for more files). */
    cancel() {
      const dropped = entries.splice(0);
      for (const entry of dropped) drop(entry);
      notify();
    },

    /** → the current items, in the order they were added. */
    items,

    /** → a Promise of the items once none is queued, uploading or processing (at once if none is). */
    allSettled() {
      if (!hasActive()) return Promise.resolve(items());
      return new Promise((resolve) => waiters.push(resolve));
    },

    /** → whether any item is queued, uploading or processing. */
    hasActive
  };
}
