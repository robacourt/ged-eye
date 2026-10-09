// @vitest-environment node
import { afterEach, describe, it, expect, vi } from 'vitest';
import { ApiError } from '../api/http.js';
import { headKey, headObjectFromEnv, headUploads, keysFor, publicHead, validateUpload } from '../api/uploads.js';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const JPG = { sha256: SHA_A, ext: 'jpg', fileName: 'wedding.jpg' };
const PDF = { sha256: SHA_B, ext: 'pdf', fileName: 'will.pdf' };

/** The ApiError a promise rejects with, as { status, code, ...extra }. */
async function failure(promise) {
  try {
    await promise;
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return { status: error.status, code: error.code, ...error.extra };
  }
  throw new Error('expected a rejection');
}

/** The ApiError a call throws, as { status, code, ...extra }. */
function thrown(call) {
  try {
    call();
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return { status: error.status, code: error.code, ...error.extra };
  }
  throw new Error('expected the call to throw');
}

/** A HEAD result as publicHead gives it: a stored original with its size, or a derivative. */
function stored(key) {
  if (key.startsWith('originals/') && key.endsWith('.jpg')) {
    return { status: 200, contentType: 'image/jpeg', contentLength: 12345, width: 4000, height: 3000 };
  }
  if (key.startsWith('originals/') && key.endsWith('.pdf')) {
    return { status: 200, contentType: 'application/pdf', contentLength: 999, width: null, height: null };
  }
  return { status: 200, contentType: 'image/webp', contentLength: 100, width: null, height: null };
}

/** A fake headObject answering from `stored`, with `overrides` (key → result) taking precedence. */
function fakeHead(overrides = {}) {
  return vi.fn(async (key) => overrides[key] ?? stored(key));
}

/** Lets pending promise callbacks run. */
async function flush() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

describe('keysFor', () => {
  it('derives the original, display and thumbnail keys of an image', () => {
    expect(keysFor({ sha256: SHA_A, ext: 'jpg' })).toEqual({
      objectKey: `originals/${SHA_A}.jpg`,
      displayKey: `display/${SHA_A}.webp`,
      thumbKey: `thumbs/${SHA_A}.webp`,
      type: { ext: 'jpg', contentType: 'image/jpeg', image: true }
    });
  });

  it('gives a PDF no display image or thumbnail', () => {
    expect(keysFor({ sha256: SHA_B, ext: 'pdf' })).toEqual({
      objectKey: `originals/${SHA_B}.pdf`,
      displayKey: null,
      thumbKey: null,
      type: { ext: 'pdf', contentType: 'application/pdf', image: false }
    });
  });

  it('throws for an extension that is not one of the accepted types', () => {
    expect(() => keysFor({ sha256: SHA_A, ext: 'heic' })).toThrow(TypeError);
  });

  it('throws for anything but a sha256, so a key can never point outside its folder', () => {
    for (const sha256 of ['../../other/x?', `${SHA_A}/../x`, 'A'.repeat(64), 'a'.repeat(63), undefined, null, 7]) {
      expect(() => keysFor({ sha256, ext: 'jpg' })).toThrow(TypeError);
    }
  });
});

describe('validateUpload', () => {
  const field = (call) => {
    const result = thrown(call);
    expect(result).toMatchObject({ status: 400, code: 'invalid' });
    expect(typeof result.message).toBe('string');
    return result.field;
  };

  it('returns the upload with its file name trimmed', () => {
    expect(validateUpload({ sha256: SHA_A, ext: 'tif', fileName: '  scan 1.tif ' }, 'upload'))
      .toEqual({ sha256: SHA_A, ext: 'tif', fileName: 'scan 1.tif' });
    for (const ext of ['jpg', 'png', 'webp', 'gif', 'tif', 'avif', 'pdf']) {
      expect(validateUpload({ ...JPG, ext }, 'upload').ext).toBe(ext);
    }
  });

  it('refuses anything but an object, naming the field', () => {
    for (const value of [undefined, null, 'x', 7, [JPG]]) expect(field(() => validateUpload(value, 'photos.2.upload'))).toBe('photos.2.upload');
  });

  it('refuses unknown keys', () => {
    expect(field(() => validateUpload({ ...JPG, objectKey: `originals/${SHA_A}.jpg` }, 'upload'))).toBe('upload.objectKey');
  });

  it('requires sha256 to be 64 lower-case hex digits', () => {
    for (const sha256 of [undefined, null, 7, 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), `${'a'.repeat(63)}\n`]) {
      expect(field(() => validateUpload({ ...JPG, sha256 }, 'photo.upload'))).toBe('photo.upload.sha256');
    }
  });

  it('requires ext to be one of the accepted types', () => {
    for (const ext of [undefined, null, 'jpeg', 'JPG', 'heic', 'bmp', 'constructor', '', ['jpg']]) {
      expect(field(() => validateUpload({ ...JPG, ext }, 'upload'))).toBe('upload.ext');
    }
  });

  it('requires a usable file name', () => {
    for (const fileName of [undefined, null, 7, '', '   ', 'a/b.jpg', 'a\\b.jpg', 'a\u0000.jpg', 'x'.repeat(256), '\uD800.jpg']) {
      expect(field(() => validateUpload({ ...JPG, fileName }, 'upload'))).toBe('upload.fileName');
    }
  });
});

describe('headUploads', () => {
  it('HEADs each original and each image\'s display image, and reports the originals in input order', async () => {
    const head = fakeHead();
    const result = await headUploads([JPG, PDF], head);
    expect(result).toEqual([
      { contentType: 'image/jpeg', byteSize: 12345, width: 4000, height: 3000 },
      { contentType: 'application/pdf', byteSize: 999, width: null, height: null }
    ]);
    const keys = head.mock.calls.map(([key]) => key).sort();
    expect(keys).toEqual([`display/${SHA_A}.webp`, `originals/${SHA_A}.jpg`, `originals/${SHA_B}.pdf`]);
  });

  it('never HEADs a display image (or a thumbnail) for a PDF', async () => {
    const head = fakeHead();
    await headUploads([PDF], head);
    expect(head).toHaveBeenCalledTimes(1);
    expect(head.mock.calls[0][0]).toBe(`originals/${SHA_B}.pdf`);
  });

  it('passes each HEAD a signal', async () => {
    const head = fakeHead();
    await headUploads([JPG], head);
    for (const [, options] of head.mock.calls) expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it('runs at most 8 HEADs at a time, and runs them in parallel', async () => {
    let active = 0;
    let most = 0;
    const head = vi.fn(async (key) => {
      active += 1;
      most = Math.max(most, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return stored(key);
    });
    const uploads = Array.from({ length: 10 }, (_, i) => ({ ...JPG, sha256: i.toString(16).repeat(64) }));
    const result = await headUploads(uploads, head);
    expect(head).toHaveBeenCalledTimes(20);
    expect(most).toBe(8);
    expect(result).toHaveLength(10);
  });

  it('skips null entries, keeping the indices of the others', async () => {
    const head = fakeHead({ [`display/${SHA_A}.webp`]: { status: 404 } });
    expect(await failure(headUploads([null, JPG], head))).toEqual({ status: 400, code: 'missing_upload', index: 1, field: 'upload' });
    const ok = await headUploads([null, PDF, null], fakeHead());
    expect(ok).toEqual([null, { contentType: 'application/pdf', byteSize: 999, width: null, height: null }, null]);
  });

  it('does nothing for no uploads', async () => {
    const head = fakeHead();
    expect(await headUploads([], head)).toEqual([]);
    expect(head).not.toHaveBeenCalled();
  });

  it('gives missing_upload, with the index, when an image\'s display image is absent', async () => {
    const head = fakeHead({ [`display/${SHA_A}.webp`]: { status: 404, contentType: null, contentLength: null, width: null, height: null } });
    expect(await failure(headUploads([PDF, JPG], head))).toEqual({ status: 400, code: 'missing_upload', index: 1, field: 'upload' });
  });

  it('gives missing_upload when an original is absent, which the public bucket may answer with 403', async () => {
    for (const status of [403, 404]) {
      const head = fakeHead({ [`originals/${SHA_B}.pdf`]: { status } });
      expect(await failure(headUploads([PDF], head))).toEqual({ status: 400, code: 'missing_upload', index: 0, field: 'upload' });
    }
  });

  it('names the field it is given in missing_upload', async () => {
    const head = fakeHead({ [`originals/${SHA_A}.jpg`]: { status: 404 } });
    expect(await failure(headUploads([JPG], head, { field: 'photo.upload' })))
      .toEqual({ status: 400, code: 'missing_upload', index: 0, field: 'photo.upload' });
  });

  it('refuses an original whose stored content type does not match ext', async () => {
    const head = fakeHead({ [`originals/${SHA_A}.jpg`]: { ...stored(`originals/${SHA_A}.jpg`), contentType: 'application/pdf' } });
    expect(await failure(headUploads([PDF, JPG], head))).toMatchObject({ status: 400, code: 'invalid', field: 'upload.ext', index: 1 });
    const missingType = fakeHead({ [`originals/${SHA_A}.jpg`]: { ...stored(`originals/${SHA_A}.jpg`), contentType: null } });
    expect(await failure(headUploads([JPG], missingType))).toMatchObject({ status: 400, code: 'invalid', field: 'upload.ext', index: 0 });
  });

  it('accepts a content type with parameters or in another case', async () => {
    const head = fakeHead({ [`originals/${SHA_A}.jpg`]: { ...stored(`originals/${SHA_A}.jpg`), contentType: 'Image/JPEG; charset=binary' } });
    expect((await headUploads([JPG], head))[0].contentType).toBe('image/jpeg');
  });

  it('gives 503 busy, logged, when an original\'s size is missing or unreadable', async () => {
    for (const contentLength of [null, undefined, -1, 1.5, '12345']) {
      const log = vi.fn();
      const head = fakeHead({ [`originals/${SHA_A}.jpg`]: { ...stored(`originals/${SHA_A}.jpg`), contentLength } });
      expect(await failure(headUploads([JPG], head, { log }))).toMatchObject({ status: 503, code: 'busy' });
      expect(log).toHaveBeenCalledTimes(1);
    }
  });

  it('gives null width and height when the original lacks either x-amz-meta header', async () => {
    const original = stored(`originals/${SHA_A}.jpg`);
    for (const missing of [{ width: null }, { height: null }]) {
      const head = fakeHead({ [`originals/${SHA_A}.jpg`]: { ...original, ...missing } });
      expect((await headUploads([JPG], head))[0]).toEqual({ contentType: 'image/jpeg', byteSize: 12345, width: null, height: null });
    }
  });

  it('gives 503 busy, logged, when a HEAD takes more than 5 seconds, and aborts it', async () => {
    vi.useFakeTimers();
    const log = vi.fn();
    const signals = [];
    const head = vi.fn((key, { signal }) => {
      signals.push(signal);
      return new Promise(() => {});
    });
    let settled = false;
    const result = failure(headUploads([PDF], head, { log })).finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(4999);
    expect(settled).toBe(false);
    expect(signals[0].aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toEqual({ status: 503, code: 'busy', message: expect.any(String) });
    expect(signals[0].aborted).toBe(true);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('gives 503 busy, logged, on a network error or a storage error', async () => {
    const log = vi.fn();
    const network = vi.fn(async () => { throw new TypeError('fetch failed'); });
    expect(await failure(headUploads([JPG], network, { log }))).toEqual({ status: 503, code: 'busy', message: expect.any(String) });
    const throwsAtOnce = vi.fn(() => { throw new TypeError('fetch failed'); });
    expect(await failure(headUploads([PDF], throwsAtOnce, { log }))).toMatchObject({ status: 503, code: 'busy' });
    const storage = fakeHead({ [`originals/${SHA_B}.pdf`]: { status: 500 } });
    expect(await failure(headUploads([PDF], storage, { log }))).toMatchObject({ status: 503, code: 'busy' });
    expect(log).toHaveBeenCalledTimes(3);
  });

  it('passes an ApiError from headObject through unchanged, unlogged', async () => {
    const log = vi.fn();
    const internal = new ApiError(500, 'internal');
    const head = vi.fn(async () => { throw internal; });
    await expect(headUploads([PDF], head, { log })).rejects.toBe(internal);
    expect(log).not.toHaveBeenCalled();
  });

  it('aborts the HEADs still in flight as soon as one fails, logging once', async () => {
    vi.useFakeTimers();
    const log = vi.fn();
    const signals = new Map();
    const head = vi.fn((key, { signal }) => {
      signals.set(key, signal);
      if (key.includes(SHA_A)) return Promise.reject(new TypeError('fetch failed'));
      return new Promise(() => {}); // hangs until aborted
    });
    const uploads = [{ ...PDF, sha256: SHA_A }, PDF];
    expect(await failure(headUploads(uploads, head, { log }))).toMatchObject({ status: 503, code: 'busy' });
    expect(head).toHaveBeenCalledTimes(2);
    expect(signals.get(`originals/${SHA_B}.pdf`).aborted).toBe(true);
    await flush();
    expect(vi.getTimerCount()).toBe(0);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][1]).toBe(`originals/${SHA_A}.pdf`);
  });

  it('aborts the HEADs still in flight when one finds a missing upload, without logging', async () => {
    const log = vi.fn();
    const signals = [];
    const head = vi.fn((key, { signal }) => {
      signals.push(signal);
      return key.includes(SHA_A) ? Promise.resolve({ status: 404 }) : new Promise(() => {});
    });
    expect(await failure(headUploads([{ ...PDF, sha256: SHA_A }, PDF], head, { log })))
      .toEqual({ status: 400, code: 'missing_upload', index: 0, field: 'upload' });
    expect(signals.map((signal) => signal.aborted)).toEqual([true, true]);
    await flush();
    expect(log).not.toHaveBeenCalled();
  });

  it('leaves no timer behind after a successful check', async () => {
    vi.useFakeTimers();
    expect(await headUploads([JPG, PDF], fakeHead())).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts no more HEADs once one has failed', async () => {
    const head = vi.fn(async (key) => (key.startsWith('originals/0') ? { status: 404 } : stored(key)));
    const uploads = Array.from({ length: 10 }, (_, i) => ({ ...PDF, sha256: i.toString(16).repeat(64) }));
    expect(await failure(headUploads(uploads, head))).toMatchObject({ code: 'missing_upload', index: 0 });
    expect(head.mock.calls.length).toBeLessThanOrEqual(8);
  });
});

describe('headKey', () => {
  const AVATAR = /^avatars\/[0-9a-f]{64}-[0-9a-f]{12}\.webp$/;
  const avatarKey = `avatars/${SHA_A}-${'c'.repeat(12)}.webp`;
  const found = { status: 200, contentType: 'image/webp', contentLength: 100, width: null, height: null };

  it('returns the HEAD result of an object that exists', async () => {
    const head = vi.fn(async () => found);
    expect(await headKey(avatarKey, head, { field: 'avatarKey', pattern: AVATAR })).toBe(found);
    expect(head).toHaveBeenCalledWith(avatarKey, { signal: expect.any(AbortSignal) });
  });

  it('gives missing_upload with the field, and the index when given, for 404 or 403', async () => {
    for (const status of [403, 404]) {
      const head = vi.fn(async () => ({ status }));
      expect(await failure(headKey(avatarKey, head, { field: 'avatarKey' }))).toEqual({ status: 400, code: 'missing_upload', field: 'avatarKey' });
      expect(await failure(headKey(avatarKey, head, { field: 'photos.upload', index: 3 })))
        .toEqual({ status: 400, code: 'missing_upload', field: 'photos.upload', index: 3 });
    }
  });

  it('gives 503 busy, logged, on a storage error status or a network error', async () => {
    const log = vi.fn();
    expect(await failure(headKey(avatarKey, vi.fn(async () => ({ status: 500 })), { field: 'avatarKey', log })))
      .toEqual({ status: 503, code: 'busy', message: expect.any(String) });
    expect(await failure(headKey(avatarKey, vi.fn(async () => { throw new TypeError('fetch failed'); }), { field: 'avatarKey', log })))
      .toMatchObject({ status: 503, code: 'busy' });
    expect(await failure(headKey(avatarKey, vi.fn(async () => ({ status: 301 })), { field: 'avatarKey', log })))
      .toMatchObject({ status: 503, code: 'busy' });
    expect(log).toHaveBeenCalledTimes(3);
  });

  it('gives 503 busy after 5 seconds, aborting the HEAD and leaving no timer', async () => {
    vi.useFakeTimers();
    const log = vi.fn();
    let signal;
    const head = vi.fn((key, options) => {
      signal = options.signal;
      return new Promise(() => {});
    });
    const result = failure(headKey(avatarKey, head, { field: 'avatarKey', log }));
    await vi.advanceTimersByTimeAsync(4999);
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toMatchObject({ status: 503, code: 'busy' });
    expect(signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('stops at once when the caller\'s signal aborts, and never starts once it has', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let signal;
    const head = vi.fn((key, options) => {
      signal = options.signal;
      return new Promise(() => {});
    });
    const result = failure(headKey(avatarKey, head, { field: 'avatarKey', signal: controller.signal, log: vi.fn() }));
    controller.abort();
    expect(await result).toMatchObject({ status: 503, code: 'busy' });
    expect(signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    const unstarted = vi.fn();
    expect(await failure(headKey(avatarKey, unstarted, { field: 'avatarKey', signal: controller.signal, log: vi.fn() })))
      .toMatchObject({ status: 503, code: 'busy' });
    expect(unstarted).not.toHaveBeenCalled();
  });

  it('leaves no timer behind after a successful HEAD', async () => {
    vi.useFakeTimers();
    await headKey(avatarKey, vi.fn(async () => found), { field: 'avatarKey' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('refuses, without a HEAD, a key that does not match the pattern it is given', async () => {
    const head = vi.fn(async () => found);
    for (const key of [`avatars/${SHA_A}.webp`, `originals/${SHA_A}.jpg`, `avatars/../${SHA_A}-${'c'.repeat(12)}.webp`]) {
      await expect(headKey(key, head, { field: 'avatarKey', pattern: AVATAR })).rejects.toThrow(TypeError);
    }
    expect(head).not.toHaveBeenCalled();
  });

  it('passes an ApiError from headObject through unchanged, unlogged', async () => {
    const log = vi.fn();
    const internal = new ApiError(500, 'internal');
    await expect(headKey(avatarKey, vi.fn(async () => { throw internal; }), { field: 'avatarKey', log })).rejects.toBe(internal);
    expect(log).not.toHaveBeenCalled();
  });
});

describe('publicHead', () => {
  const response = (status, headers = {}) => new Response(null, { status, headers });

  it('HEADs the public URL of the key and reads the size and metadata', async () => {
    const fetchImpl = vi.fn(async () => response(200, {
      'content-type': 'image/jpeg', 'content-length': '12345', 'x-amz-meta-width': '4000', 'x-amz-meta-height': '3000'
    }));
    const head = publicHead('https://storage.example.test/ged-eye-media', fetchImpl);
    expect(await head(`originals/${SHA_A}.jpg`)).toEqual({
      status: 200, contentType: 'image/jpeg', contentLength: 12345, width: 4000, height: 3000
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`https://storage.example.test/ged-eye-media/originals/${SHA_A}.jpg`);
    expect(init.method).toBe('HEAD');
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('gives null for missing or unreadable headers', async () => {
    const fetchImpl = vi.fn(async () => response(200, { 'x-amz-meta-width': 'wide', 'x-amz-meta-height': '-3' }));
    expect(await publicHead('https://s.test/b', fetchImpl)('display/x.webp')).toEqual({
      status: 200, contentType: null, contentLength: null, width: null, height: null
    });
    const bare = vi.fn(async () => response(200, { 'content-type': 'application/pdf', 'content-length': '999' }));
    expect(await publicHead('https://s.test/b', bare)('originals/x.pdf')).toEqual({
      status: 200, contentType: 'application/pdf', contentLength: 999, width: null, height: null
    });
  });

  it('reports a missing object by its status rather than throwing', async () => {
    const fetchImpl = vi.fn(async () => response(404));
    expect((await publicHead('https://s.test/b', fetchImpl)('originals/x.pdf')).status).toBe(404);
  });

  it('rejects on a network error', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('fetch failed'); });
    await expect(publicHead('https://s.test/b', fetchImpl)('originals/x.pdf')).rejects.toThrow('fetch failed');
  });

  it('aborts the request when the caller\'s signal aborts', async () => {
    const fetchImpl = vi.fn(async () => response(200));
    const controller = new AbortController();
    await publicHead('https://s.test/b', fetchImpl)('originals/x.pdf', { signal: controller.signal });
    const { signal } = fetchImpl.mock.calls[0][1];
    expect(signal.aborted).toBe(false);
    controller.abort();
    expect(signal.aborted).toBe(true);
  });
});

describe('headObjectFromEnv', () => {
  it('HEADs objects in the ged-eye-media bucket at AWS_ENDPOINT_URL_S3', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 404 }));
    for (const endpoint of ['https://storage.example.test', 'https://storage.example.test/']) {
      const head = headObjectFromEnv({ AWS_ENDPOINT_URL_S3: endpoint }, { fetchImpl });
      await head('originals/x.pdf');
      expect(fetchImpl.mock.lastCall[0]).toBe('https://storage.example.test/ged-eye-media/originals/x.pdf');
    }
  });

  it('throws 500 internal on every call when AWS_ENDPOINT_URL_S3 is unset, logging it once', async () => {
    const log = vi.fn();
    const fetchImpl = vi.fn();
    for (const env of [{}, { AWS_ENDPOINT_URL_S3: '' }]) {
      log.mockClear();
      const head = headObjectFromEnv(env, { log, fetchImpl });
      await expect(head('originals/x.pdf')).rejects.toMatchObject({ status: 500, code: 'internal' });
      await expect(head('originals/y.pdf')).rejects.toBeInstanceOf(ApiError);
      expect(log).toHaveBeenCalledTimes(1);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
