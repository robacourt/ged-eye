import { describe, it, expect, vi } from 'vitest';
import { ApiError } from '../src/editApi.js';
import { createUploadQueue } from '../src/uploadQueue.js';

const MINUTE = 60_000;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets every pending promise callback run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const jpeg = (name = 'a.jpg', bytes = 'jpeg bytes') => new File([bytes], name, { type: 'image/jpeg' });

const mediaFor = (fileName, sha256 = `sha-${fileName}`) => ({
  mediaId: null,
  sha256,
  ext: 'jpg',
  objectKey: `originals/${sha256}.jpg`,
  displayKey: `display/${sha256}.webp`,
  thumbKey: `thumbs/${sha256}.webp`,
  contentType: 'image/jpeg',
  byteSize: 10,
  width: 400,
  height: 300,
  fileName,
  caption: null,
  date: null
});

/** Fake mediaApi functions that succeed at once. Tests override them per case. */
function fakeApi() {
  let slots = 0;
  return {
    requestUpload: vi.fn(async ({ contentType }) => {
      slots += 1;
      return {
        uploadId: `up-${slots}`,
        url: `https://storage.test/incoming/up-${slots}?signature`,
        headers: { 'Content-Type': contentType }
      };
    }),
    uploadFile: vi.fn(async (slot, file, { onProgress }) => {
      onProgress(0.5);
      onProgress(1);
    }),
    processUpload: vi.fn(async (uploadId, fileName) => mediaFor(fileName)),
    discardUpload: vi.fn(async () => {})
  };
}

/** Makes `fn` return a promise the test settles, per call. → the calls, each `{ args, resolve, reject }`. */
function hold(fn) {
  const calls = [];
  fn.mockImplementation((...args) => {
    const { promise, resolve, reject } = deferred();
    calls.push({ args, resolve, reject });
    return promise;
  });
  return calls;
}

/** hold() for uploadFile, whose uploads also reject with ApiError(0, 'aborted') when their signal aborts. */
function holdUploads(api) {
  const calls = [];
  api.uploadFile.mockImplementation((slot, file, options) => {
    const { promise, resolve, reject } = deferred();
    options.signal?.addEventListener('abort', () => reject(new ApiError(0, 'aborted')), { once: true });
    calls.push({ slot, file, options, resolve, reject });
    return promise;
  });
  return calls;
}

/** A queue on fake functions. `changes` holds each onChange call's states. */
function setup({ concurrency, now } = {}) {
  const api = fakeApi();
  const changes = [];
  const queue = createUploadQueue({
    api,
    concurrency,
    now,
    onChange: (items) => changes.push(items.map(({ state }) => state))
  });
  return { api, queue, changes };
}

const states = (items) => items.map((item) => item.state);
const withoutRepeats = (list) => list.filter((value, i) => i === 0 || value !== list[i - 1]);
const uploadIds = (mockFn, argIndex) => mockFn.mock.calls.map((args) => {
  const value = args[argIndex];
  return typeof value === 'string' ? value : value.uploadId;
});

describe('createUploadQueue', () => {
  it('takes a file through queued, uploading, processing and ready, calling onChange on each change', async () => {
    const api = fakeApi();
    const seen = [];
    const queue = createUploadQueue({
      api,
      onChange: (items) => seen.push(items.map(({ state, progress }) => ({ state, progress })))
    });
    const file = jpeg('rose.jpg');

    const [item] = queue.add([file]);
    expect(item).toMatchObject({ file, media: null, error: null, retryable: false, duplicateOf: null });
    expect(item.id).toBeDefined();
    await queue.allSettled();

    expect(item).toMatchObject({
      state: 'ready', progress: 1, media: mediaFor('rose.jpg'), error: null, retryable: false, duplicateOf: null
    });
    expect(withoutRepeats(seen.map(([{ state }]) => state))).toEqual(['queued', 'uploading', 'processing', 'ready']);
    expect(seen).toContainEqual([{ state: 'uploading', progress: 0.5 }]);
    expect(queue.items()).toEqual([item]);

    expect(api.requestUpload).toHaveBeenCalledWith({ fileName: 'rose.jpg', contentType: 'image/jpeg', byteSize: file.size });
    const slot = await api.requestUpload.mock.results[0].value;
    expect(api.uploadFile).toHaveBeenCalledWith(slot, file, {
      onProgress: expect.any(Function),
      signal: expect.any(AbortSignal)
    });
    expect(api.processUpload).toHaveBeenCalledWith('up-1', 'rose.jpg');
    expect(api.discardUpload).not.toHaveBeenCalled();
  });

  it('gives each item its own id, and keeps them in the order added', () => {
    const { queue } = setup();
    const first = queue.add([jpeg('1.jpg'), jpeg('2.jpg')]);
    const second = queue.add([jpeg('3.jpg')]);
    const items = [...first, ...second];
    expect(new Set(items.map((item) => item.id)).size).toBe(3);
    expect(queue.items()).toEqual(items);
    expect(queue.items().map((item) => item.file.name)).toEqual(['1.jpg', '2.jpg', '3.jpg']);
  });

  it('uploads or processes at most two files at once', async () => {
    const { api, queue, changes } = setup();
    const uploads = holdUploads(api);
    const processing = hold(api.processUpload);
    const items = queue.add([jpeg('1.jpg'), jpeg('2.jpg'), jpeg('3.jpg'), jpeg('4.jpg')]);
    await flush();
    expect(states(items)).toEqual(['uploading', 'uploading', 'queued', 'queued']);
    expect(uploads).toHaveLength(2);

    uploads[0].resolve();
    await flush();
    expect(states(items)).toEqual(['processing', 'uploading', 'queued', 'queued']);

    processing[0].resolve(mediaFor('1.jpg'));
    await flush();
    expect(states(items)).toEqual(['ready', 'uploading', 'uploading', 'queued']);

    uploads[1].reject(new ApiError(0, 'network'));
    await flush();
    expect(states(items)).toEqual(['ready', 'failed', 'uploading', 'uploading']);

    uploads[2].resolve();
    uploads[3].resolve();
    await flush();
    processing[1].resolve(mediaFor('3.jpg'));
    processing[2].resolve(mediaFor('4.jpg'));
    await queue.allSettled();
    expect(states(items)).toEqual(['ready', 'failed', 'ready', 'ready']);

    const active = (list) => list.filter((state) => state === 'uploading' || state === 'processing').length;
    expect(Math.max(...changes.map(active))).toBe(2);
  });

  it('takes another limit', async () => {
    const { api, queue } = setup({ concurrency: 1 });
    const uploads = holdUploads(api);
    const items = queue.add([jpeg('1.jpg'), jpeg('2.jpg')]);
    await flush();
    expect(states(items)).toEqual(['uploading', 'queued']);
    uploads[0].resolve();
    await flush();
    expect(states(items)).toEqual(['ready', 'uploading']);
  });

  describe('failures', () => {
    it.each(['unsupported_type', 'heic_unsupported', 'unreadable', 'too_large', 'empty', 'too_many_pixels'])(
      'fails for good when processing rejects the file (%s)',
      async (code) => {
        const { api, queue } = setup();
        const error = new ApiError(code === 'too_large' ? 413 : 400, code);
        api.processUpload.mockRejectedValueOnce(error);
        const [item] = queue.add([jpeg()]);
        await queue.allSettled();
        expect(item).toMatchObject({ state: 'failed', error, retryable: false, media: null });

        expect(queue.retry(item)).toBe(false);
        await flush();
        expect(item.state).toBe('failed');
        expect(api.processUpload).toHaveBeenCalledTimes(1);
      }
    );

    it.each([
      ['an invalid file name', new ApiError(400, 'invalid', { field: 'fileName' })],
      ['a file that is too large', new ApiError(413, 'too_large')],
      ['a type that is not allowed', new ApiError(400, 'unsupported_type')]
    ])('fails for good when the slot is refused for %s', async (_, error) => {
      const { api, queue } = setup();
      api.requestUpload.mockRejectedValueOnce(error);
      const [item] = queue.add([jpeg()]);
      await queue.allSettled();
      expect(item).toMatchObject({ state: 'failed', error, retryable: false });
      expect(api.uploadFile).not.toHaveBeenCalled();
    });

    it.each([
      ['a network failure asking for a slot', 'requestUpload', new ApiError(0, 'network')],
      ['a network failure during the upload', 'uploadFile', new ApiError(0, 'network')],
      ['storage failing the upload', 'uploadFile', new ApiError(500, 'upload_failed')],
      ['storage refusing an expired slot', 'uploadFile', new ApiError(403, 'upload_failed')],
      ['a busy media Function', 'processUpload', new ApiError(503, 'busy')],
      ['a server error while processing', 'processUpload', new ApiError(500, 'internal')],
      ['a network failure while processing', 'processUpload', new ApiError(0, 'network')],
      ['being signed out', 'requestUpload', new ApiError(401, 'unauthenticated')]
    ])('can be retried after %s', async (_, fn, error) => {
      const { api, queue } = setup();
      api[fn].mockRejectedValueOnce(error);
      const [item] = queue.add([jpeg()]);
      await queue.allSettled();
      expect(item).toMatchObject({ state: 'failed', error, retryable: true, media: null });

      expect(queue.retry(item)).toBe(true);
      expect(item).toMatchObject({ error: null, retryable: false });
      await queue.allSettled();
      expect(item).toMatchObject({ state: 'ready', error: null, retryable: false, media: mediaFor('a.jpg') });
    });

    it('does nothing when asked to retry an item that has not failed', async () => {
      const { api, queue } = setup();
      const [item] = queue.add([jpeg()]);
      await queue.allSettled();
      expect(queue.retry(item)).toBe(false);
      expect(queue.retry({ id: 'not ours' })).toBe(false);
      await flush();
      expect(item.state).toBe('ready');
      expect(api.processUpload).toHaveBeenCalledTimes(1);
    });
  });

  describe('retrying a failed upload', () => {
    it('reuses the upload slot while it is under 14 minutes old', async () => {
      let time = 1_000_000;
      const { api, queue } = setup({ now: () => time });
      api.uploadFile.mockRejectedValueOnce(new ApiError(0, 'network'));
      const [item] = queue.add([jpeg()]);
      await queue.allSettled();

      time += 14 * MINUTE - 1;
      queue.retry(item);
      await queue.allSettled();
      expect(item.state).toBe('ready');
      expect(api.requestUpload).toHaveBeenCalledTimes(1);
      expect(api.uploadFile).toHaveBeenCalledTimes(2);
      expect(api.uploadFile.mock.calls[1][0]).toBe(api.uploadFile.mock.calls[0][0]);
      expect(api.processUpload).toHaveBeenCalledWith('up-1', 'a.jpg');
    });

    it('asks for a new slot once the old one is 14 minutes old', async () => {
      let time = 1_000_000;
      const { api, queue } = setup({ now: () => time });
      api.uploadFile.mockRejectedValueOnce(new ApiError(0, 'network'));
      const [item] = queue.add([jpeg()]);
      await queue.allSettled();

      time += 14 * MINUTE;
      queue.retry(item);
      await queue.allSettled();
      expect(item.state).toBe('ready');
      expect(api.requestUpload).toHaveBeenCalledTimes(2);
      expect(uploadIds(api.uploadFile, 0)).toEqual(['up-1', 'up-2']);
      expect(uploadIds(api.processUpload, 0)).toEqual(['up-2']);
    });

    it('always asks for a new slot after storage refuses the old one (403)', async () => {
      const time = 1_000_000;
      const { api, queue } = setup({ now: () => time });
      api.uploadFile.mockRejectedValueOnce(new ApiError(403, 'upload_failed'));
      const [item] = queue.add([jpeg()]);
      await queue.allSettled();

      queue.retry(item);
      await queue.allSettled();
      expect(item.state).toBe('ready');
      expect(uploadIds(api.uploadFile, 0)).toEqual(['up-1', 'up-2']);
      expect(uploadIds(api.processUpload, 0)).toEqual(['up-2']);
    });

    it('asks for a slot again when asking for one failed', async () => {
      const { api, queue } = setup();
      api.requestUpload.mockRejectedValueOnce(new ApiError(0, 'network'));
      const [item] = queue.add([jpeg()]);
      await queue.allSettled();

      queue.retry(item);
      await queue.allSettled();
      expect(item.state).toBe('ready');
      expect(api.requestUpload).toHaveBeenCalledTimes(2);
      expect(api.uploadFile).toHaveBeenCalledTimes(1);
    });
  });

  describe('retrying after processing failed', () => {
    it('processes the uploaded file again without uploading it again', async () => {
      const { api, queue, changes } = setup();
      api.processUpload.mockRejectedValueOnce(new ApiError(503, 'busy'));
      const [item] = queue.add([jpeg()]);
      await queue.allSettled();
      changes.length = 0;

      queue.retry(item);
      await queue.allSettled();
      expect(item.state).toBe('ready');
      expect(api.requestUpload).toHaveBeenCalledTimes(1);
      expect(api.uploadFile).toHaveBeenCalledTimes(1);
      expect(uploadIds(api.processUpload, 0)).toEqual(['up-1', 'up-1']);
      expect(withoutRepeats(changes.map(([state]) => state))).toEqual(['queued', 'processing', 'ready']);
    });

    it('uploads the file again with a new slot when the upload is gone (404)', async () => {
      const { api, queue, changes } = setup();
      api.processUpload
        .mockRejectedValueOnce(new ApiError(503, 'busy'))
        .mockRejectedValueOnce(new ApiError(404, 'not_found'));
      const [item] = queue.add([jpeg()]);
      await queue.allSettled();
      changes.length = 0;

      queue.retry(item);
      await queue.allSettled();
      expect(item).toMatchObject({ state: 'ready', media: mediaFor('a.jpg') });
      expect(api.requestUpload).toHaveBeenCalledTimes(2);
      expect(uploadIds(api.uploadFile, 0)).toEqual(['up-1', 'up-2']);
      expect(uploadIds(api.processUpload, 0)).toEqual(['up-1', 'up-1', 'up-2']);
      expect(withoutRepeats(changes.map(([state]) => state)))
        .toEqual(['queued', 'processing', 'uploading', 'processing', 'ready']);
      expect(api.discardUpload).not.toHaveBeenCalled();
    });

    it('fails, retryably, when a file it has just uploaded is already gone, instead of looping', async () => {
      const { api, queue } = setup();
      api.processUpload.mockRejectedValue(new ApiError(404, 'not_found'));
      const [item] = queue.add([jpeg()]);
      await queue.allSettled();
      expect(item).toMatchObject({ state: 'failed', retryable: true });
      expect(item.error.code).toBe('not_found');
      expect(api.uploadFile).toHaveBeenCalledTimes(1);

      queue.retry(item);
      await queue.allSettled();
      expect(item.state).toBe('failed');
      expect(uploadIds(api.processUpload, 0)).toEqual(['up-1', 'up-1', 'up-2']);
      expect(api.uploadFile).toHaveBeenCalledTimes(2);
    });
  });

  describe('markFailed', () => {
    it('fails a ready file so that Retry processes it again, uploading it again on 404', async () => {
      const { api, queue } = setup();
      const [item] = queue.add([jpeg()]);
      await queue.allSettled();

      const error = new ApiError(409, 'missing_upload');
      queue.markFailed(item, error);
      expect(item).toMatchObject({ state: 'failed', error, retryable: true, media: null });
      expect(queue.hasActive()).toBe(false);

      api.processUpload.mockRejectedValueOnce(new ApiError(404, 'not_found'));
      queue.retry(item);
      await queue.allSettled();
      expect(item).toMatchObject({ state: 'ready', error: null, media: mediaFor('a.jpg') });
      expect(uploadIds(api.processUpload, 0)).toEqual(['up-1', 'up-1', 'up-2']);
    });

    it('ignores items that are not ready', async () => {
      const { api, queue } = setup();
      api.processUpload.mockRejectedValueOnce(new ApiError(400, 'unreadable'));
      const [item] = queue.add([jpeg()]);
      await queue.allSettled();
      queue.markFailed(item, new ApiError(409, 'missing_upload'));
      expect(item).toMatchObject({ state: 'failed', retryable: false });
      expect(item.error.code).toBe('unreadable');
    });
  });

  describe('cancel', () => {
    it('aborts uploads, discards uploaded files not yet processed, and empties the queue', async () => {
      const { api, queue, changes } = setup();
      const uploads = holdUploads(api);
      const processing = hold(api.processUpload);
      const items = queue.add([jpeg('1.jpg'), jpeg('2.jpg'), jpeg('3.jpg')]);
      await flush();
      uploads[1].resolve();
      await flush();
      expect(states(items)).toEqual(['uploading', 'processing', 'queued']);

      queue.cancel();
      expect(uploads[0].options.signal.aborted).toBe(true);
      expect(api.discardUpload.mock.calls).toEqual([['up-2']]);
      expect(queue.items()).toEqual([]);
      expect(changes.at(-1)).toEqual([]);
      expect(queue.hasActive()).toBe(false);
      await expect(queue.allSettled()).resolves.toEqual([]);

      const calls = changes.length;
      processing[0].resolve(mediaFor('2.jpg'));
      await flush();
      expect(changes).toHaveLength(calls);
      expect(queue.items()).toEqual([]);
      expect(api.requestUpload).toHaveBeenCalledTimes(2);
    });

    it('discards the uploads of failed files that were never processed, and nothing else', async () => {
      const { api, queue } = setup();
      api.uploadFile.mockImplementation(async (slot, file) => {
        if (file.name === 'offline.jpg') throw new ApiError(0, 'network');
      });
      api.processUpload.mockImplementation(async (uploadId, fileName) => {
        if (fileName === 'busy.jpg') throw new ApiError(503, 'busy');
        if (fileName === 'bad.jpg') throw new ApiError(400, 'unreadable');
        return mediaFor(fileName);
      });
      const items = queue.add([jpeg('ok.jpg'), jpeg('busy.jpg'), jpeg('bad.jpg'), jpeg('offline.jpg')]);
      await queue.allSettled();
      expect(states(items)).toEqual(['ready', 'failed', 'failed', 'failed']);

      queue.cancel();
      const busyUpload = api.processUpload.mock.calls.find(([, fileName]) => fileName === 'busy.jpg')[0];
      expect(api.discardUpload.mock.calls).toEqual([[busyUpload]]);
      expect(queue.items()).toEqual([]);
    });

    it('leaves the queue ready for more files', async () => {
      const { queue } = setup();
      queue.add([jpeg('1.jpg')]);
      queue.cancel();
      const [item] = queue.add([jpeg('2.jpg')]);
      await queue.allSettled();
      expect(item.state).toBe('ready');
      expect(queue.items()).toEqual([item]);
    });
  });

  describe('remove', () => {
    it('aborts an upload and starts the next file', async () => {
      const { api, queue } = setup({ concurrency: 1 });
      const uploads = holdUploads(api);
      const [first, second] = queue.add([jpeg('1.jpg'), jpeg('2.jpg')]);
      await flush();

      queue.remove(first);
      expect(uploads[0].options.signal.aborted).toBe(true);
      expect(queue.items()).toEqual([second]);
      await flush();
      expect(second.state).toBe('uploading');
      expect(uploads).toHaveLength(2);
      expect(api.discardUpload).not.toHaveBeenCalled();
    });

    it('drops a queued file before it starts', async () => {
      const { api, queue } = setup({ concurrency: 1 });
      const [first, second] = queue.add([jpeg('1.jpg'), jpeg('2.jpg')]);
      queue.remove(second);
      await queue.allSettled();
      expect(first.state).toBe('ready');
      expect(queue.items()).toEqual([first]);
      expect(api.requestUpload).toHaveBeenCalledTimes(1);
    });

    it('discards the upload of a file being processed, and ignores the result', async () => {
      const { api, queue, changes } = setup();
      const processing = hold(api.processUpload);
      const [item] = queue.add([jpeg()]);
      await flush();
      expect(item.state).toBe('processing');

      queue.remove(item);
      expect(api.discardUpload.mock.calls).toEqual([['up-1']]);
      expect(queue.items()).toEqual([]);
      expect(queue.hasActive()).toBe(false);

      const calls = changes.length;
      processing[0].resolve(mediaFor('a.jpg'));
      await flush();
      expect(changes).toHaveLength(calls);
      expect(queue.items()).toEqual([]);
    });

    it('discards the upload of a file whose processing failed', async () => {
      const { api, queue } = setup();
      api.processUpload.mockRejectedValueOnce(new ApiError(503, 'busy'));
      const [item] = queue.add([jpeg()]);
      await queue.allSettled();
      queue.remove(item);
      expect(api.discardUpload.mock.calls).toEqual([['up-1']]);
    });

    it('leaves a processed file alone', async () => {
      const { api, queue, changes } = setup();
      const [item] = queue.add([jpeg()]);
      await queue.allSettled();
      queue.remove(item);
      expect(api.discardUpload).not.toHaveBeenCalled();
      expect(queue.items()).toEqual([]);
      expect(changes.at(-1)).toEqual([]);
    });
  });

  describe('duplicates', () => {
    const sameAsA = (uploadId, fileName) => mediaFor(fileName, fileName === 'b.jpg' ? 'sha-b' : 'sha-a');

    it('marks a later file with the same content as a duplicate of the earlier one', async () => {
      const { api, queue } = setup();
      api.processUpload.mockImplementation(async (uploadId, fileName) => sameAsA(uploadId, fileName));
      const [first, copy, other] = queue.add([jpeg('a.jpg'), jpeg('copy of a.jpg'), jpeg('b.jpg')]);
      await queue.allSettled();

      expect(first).toMatchObject({ state: 'ready', media: mediaFor('a.jpg', 'sha-a'), duplicateOf: null });
      expect(copy).toMatchObject({ state: 'ready', media: null });
      expect(copy.duplicateOf).toBe(first);
      expect(other).toMatchObject({ state: 'ready', media: mediaFor('b.jpg', 'sha-b'), duplicateOf: null });
    });

    it('keeps the earlier file as the original when the later one finishes first', async () => {
      const { api, queue } = setup();
      const processing = hold(api.processUpload);
      const [first, copy] = queue.add([jpeg('a.jpg'), jpeg('copy of a.jpg')]);
      await flush();
      expect(processing).toHaveLength(2);

      processing[1].resolve(mediaFor('copy of a.jpg', 'sha-a'));
      await flush();
      expect(copy).toMatchObject({ state: 'ready', media: mediaFor('copy of a.jpg', 'sha-a'), duplicateOf: null });

      processing[0].resolve(mediaFor('a.jpg', 'sha-a'));
      await flush();
      expect(first).toMatchObject({ state: 'ready', media: mediaFor('a.jpg', 'sha-a'), duplicateOf: null });
      expect(copy).toMatchObject({ state: 'ready', media: null });
      expect(copy.duplicateOf).toBe(first);
    });

    it('gives a duplicate its own media back when the original is removed', async () => {
      const { api, queue, changes } = setup();
      api.processUpload.mockImplementation(async (uploadId, fileName) => sameAsA(uploadId, fileName));
      const [first, copy] = queue.add([jpeg('a.jpg'), jpeg('copy of a.jpg')]);
      await queue.allSettled();

      queue.remove(first);
      expect(copy).toMatchObject({ state: 'ready', media: mediaFor('copy of a.jpg', 'sha-a'), duplicateOf: null });
      expect(changes.at(-1)).toEqual(['ready']);
    });

    it('promotes a duplicate when the original is marked failed', async () => {
      const { api, queue } = setup();
      api.processUpload.mockImplementation(async (uploadId, fileName) => sameAsA(uploadId, fileName));
      const [first, copy] = queue.add([jpeg('a.jpg'), jpeg('copy of a.jpg')]);
      await queue.allSettled();

      queue.markFailed(first, new ApiError(409, 'missing_upload'));
      expect(copy).toMatchObject({ media: mediaFor('copy of a.jpg', 'sha-a'), duplicateOf: null });
    });
  });

  describe('hasActive and allSettled', () => {
    it('are idle with nothing added', async () => {
      const { queue } = setup();
      expect(queue.hasActive()).toBe(false);
      await expect(queue.allSettled()).resolves.toEqual([]);
    });

    it('stay active until every file is ready or failed', async () => {
      const { api, queue } = setup();
      const uploads = holdUploads(api);
      const items = queue.add([jpeg('1.jpg'), jpeg('2.jpg')]);
      expect(queue.hasActive()).toBe(true);
      let settled = null;
      queue.allSettled().then((list) => { settled = list; });

      await flush();
      uploads[0].resolve();
      await flush();
      expect(items[0].state).toBe('ready');
      expect(queue.hasActive()).toBe(true);
      expect(settled).toBe(null);

      uploads[1].reject(new ApiError(0, 'network'));
      await flush();
      expect(queue.hasActive()).toBe(false);
      expect(settled).toEqual(items);

      queue.retry(items[1]);
      expect(queue.hasActive()).toBe(true);
    });
  });
});
