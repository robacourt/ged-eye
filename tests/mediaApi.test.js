import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/auth.js', () => ({
  getToken: vi.fn(async () => 'jwt-1'),
  setRole: vi.fn()
}));

const { ApiError } = await import('../src/editApi.js');
const { requestUpload, uploadFile, processUpload, discardUpload, renderAvatar } = await import('../src/mediaApi.js');

const respond = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: body === undefined ? async () => { throw new SyntaxError('Unexpected end of JSON input'); } : async () => body
});

const UPLOAD_ID = '6f1c2a54-0c5b-4f4e-9d0e-2d6f0b1d7a11';

describe('mediaApi requests', () => {
  let fetchMock;

  beforeEach(() => {
    vi.stubEnv('VITE_API_URL', 'https://api.test');
    vi.stubEnv('VITE_MEDIA_API_URL', 'https://media-fn.test');
    fetchMock = vi.fn(async () => respond(200, {}));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const call = (n = 0) => {
    const [url, init] = fetchMock.mock.calls[n];
    return { url, method: init.method, headers: init.headers, body: init.body === undefined ? undefined : JSON.parse(init.body) };
  };

  describe('requestUpload', () => {
    it('asks the media Function for an upload slot and returns it', async () => {
      const slot = { uploadId: UPLOAD_ID, url: 'https://storage.test/incoming/x?sig=1', headers: { 'Content-Type': 'image/jpeg' } };
      fetchMock.mockResolvedValue(respond(200, slot));
      const result = await requestUpload({ fileName: 'rose.jpg', contentType: 'image/jpeg', byteSize: 1234, extra: 'ignored' });
      expect(result).toEqual(slot);
      expect(call()).toEqual({
        url: 'https://media-fn.test/uploads',
        method: 'POST',
        headers: { authorization: 'Bearer jwt-1', 'content-type': 'application/json' },
        body: { fileName: 'rose.jpg', contentType: 'image/jpeg', byteSize: 1234 }
      });
    });

    it('maps the Function\'s errors', async () => {
      fetchMock.mockResolvedValue(respond(413, { error: 'too_large' }));
      const error = await requestUpload({ fileName: 'big.jpg', contentType: 'image/jpeg', byteSize: 99999999 }).catch(e => e);
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ status: 413, code: 'too_large' });
    });

    it('fails when VITE_MEDIA_API_URL is not configured, without a request', async () => {
      vi.stubEnv('VITE_MEDIA_API_URL', '');
      await expect(requestUpload({ fileName: 'a.jpg', contentType: 'image/jpeg', byteSize: 1 })).rejects.toThrow('VITE_MEDIA_API_URL is not configured');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('processUpload', () => {
    it('processes the upload and returns the media', async () => {
      const media = { mediaId: null, sha256: 'ab'.repeat(32), ext: 'jpg', objectKey: `originals/${'ab'.repeat(32)}.jpg`, displayKey: 'display/x.webp', thumbKey: 'thumbs/x.webp' };
      fetchMock.mockResolvedValue(respond(200, { media }));
      expect(await processUpload(UPLOAD_ID, 'rose.jpg')).toEqual(media);
      expect(call()).toMatchObject({ url: `https://media-fn.test/uploads/${UPLOAD_ID}/process`, method: 'POST', body: { fileName: 'rose.jpg' } });
    });

    it('rejects with not_found once the upload was already processed, so the caller can upload again', async () => {
      fetchMock.mockResolvedValue(respond(404, { error: 'not_found' }));
      await expect(processUpload(UPLOAD_ID, 'rose.jpg')).rejects.toMatchObject({ status: 404, code: 'not_found' });
    });

    it('rejects with the Function\'s reason for an unusable file', async () => {
      fetchMock.mockResolvedValue(respond(422, { error: 'heic_unsupported', message: 'Convert HEIC photos to JPEG first.' }));
      await expect(processUpload(UPLOAD_ID, 'IMG_1.heic')).rejects.toMatchObject({ status: 422, code: 'heic_unsupported', message: 'Convert HEIC photos to JPEG first.' });
    });
  });

  describe('discardUpload', () => {
    it('deletes the incoming upload', async () => {
      fetchMock.mockResolvedValue(respond(204));
      await expect(discardUpload(UPLOAD_ID)).resolves.toBeUndefined();
      expect(call()).toMatchObject({ url: `https://media-fn.test/uploads/${UPLOAD_ID}`, method: 'DELETE', body: undefined });
    });

    it('swallows and logs failures, since a leftover object is swept within the hour', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      fetchMock.mockResolvedValueOnce(respond(500, { error: 'internal' }));
      await expect(discardUpload(UPLOAD_ID)).resolves.toBeUndefined();
      fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
      await expect(discardUpload(UPLOAD_ID)).resolves.toBeUndefined();
      vi.stubEnv('VITE_MEDIA_API_URL', '');
      await expect(discardUpload(UPLOAD_ID)).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(3);
    });
  });

  describe('renderAvatar', () => {
    it('renders the crop and returns the avatar key', async () => {
      const crop = { x: 0.1, y: 0.2, w: 0.5, h: 0.5 };
      const objectKey = `originals/${'cd'.repeat(32)}.jpg`;
      fetchMock.mockResolvedValue(respond(200, { avatarKey: `avatars/${'cd'.repeat(32)}-0123456789ab.webp` }));
      expect(await renderAvatar(objectKey, crop)).toBe(`avatars/${'cd'.repeat(32)}-0123456789ab.webp`);
      expect(call()).toMatchObject({ url: 'https://media-fn.test/avatars', method: 'POST', body: { objectKey, crop } });
    });

    it('rejects with a busy Function so the caller can retry', async () => {
      fetchMock.mockResolvedValue(respond(503, { error: 'busy' }));
      await expect(renderAvatar('originals/x.jpg', { x: 0, y: 0, w: 1, h: 1 })).rejects.toMatchObject({ status: 503, code: 'busy' });
    });
  });
});

/** Stands in for XMLHttpRequest: records what was set up and lets a test drive the events. */
class FakeXHR {
  static instances = [];

  constructor() {
    this.headers = {};
    this.listeners = {};
    this.upload = { listeners: {}, addEventListener: (type, fn) => (this.upload.listeners[type] ??= []).push(fn) };
    this.status = 0;
    this.aborted = false;
    FakeXHR.instances.push(this);
  }

  open(method, url) {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name, value) {
    this.headers[name] = value;
  }

  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }

  send(body) {
    this.body = body;
  }

  abort() {
    this.aborted = true;
    this.emit('abort');
  }

  emit(type) {
    for (const fn of this.listeners[type] ?? []) fn({ type });
  }

  progress(loaded, total, lengthComputable = true) {
    for (const fn of this.upload.listeners.progress ?? []) fn({ type: 'progress', loaded, total, lengthComputable });
  }

  finish(status) {
    this.status = status;
    this.emit('load');
  }
}

describe('uploadFile', () => {
  const slot = { uploadId: UPLOAD_ID, url: 'https://storage.test/incoming/x?X-Amz-Signature=abc', headers: { 'Content-Type': 'image/jpeg' } };
  const file = new File(['pixels'], 'rose.jpg', { type: 'image/jpeg' });
  const xhr = () => FakeXHR.instances.at(-1);

  beforeEach(() => {
    FakeXHR.instances = [];
    vi.stubGlobal('XMLHttpRequest', FakeXHR);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('PUTs the file to the slot with exactly the slot\'s headers', async () => {
    const done = uploadFile(slot, file);
    expect(FakeXHR.instances).toHaveLength(1);
    expect(xhr().method).toBe('PUT');
    expect(xhr().url).toBe(slot.url);
    expect(xhr().headers).toEqual({ 'Content-Type': 'image/jpeg' });
    expect(xhr().body).toBe(file);
    xhr().finish(200);
    await expect(done).resolves.toBeUndefined();
  });

  it('accepts any 2xx', async () => {
    const done = uploadFile(slot, file);
    xhr().finish(204);
    await expect(done).resolves.toBeUndefined();
  });

  it('reports progress as a fraction from 0 to 1, ending at 1', async () => {
    const onProgress = vi.fn();
    const done = uploadFile(slot, file, { onProgress });
    xhr().progress(0, 100);
    xhr().progress(25, 100);
    xhr().progress(60, 100, false);
    xhr().progress(100, 100);
    xhr().finish(200);
    await done;
    expect(onProgress.mock.calls.map(([fraction]) => fraction)).toEqual([0, 0.25, 1, 1]);
  });

  it('works without an onProgress callback or options', async () => {
    const done = uploadFile(slot, file);
    xhr().progress(50, 100);
    xhr().finish(200);
    await expect(done).resolves.toBeUndefined();
  });

  it('rejects with upload_failed and the status for a non-2xx; 403 means the slot expired or was used', async () => {
    const expired = uploadFile(slot, file);
    xhr().finish(403);
    const error = await expired.catch(e => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 403, code: 'upload_failed' });
    const failed = uploadFile(slot, file);
    xhr().finish(500);
    await expect(failed).rejects.toMatchObject({ status: 500, code: 'upload_failed' });
  });

  it('rejects with network on a network failure', async () => {
    const done = uploadFile(slot, file);
    xhr().emit('error');
    await expect(done).rejects.toMatchObject({ name: 'ApiError', status: 0, code: 'network' });
  });

  it('aborts the request when the signal fires, rejecting with aborted', async () => {
    const controller = new AbortController();
    const done = uploadFile(slot, file, { signal: controller.signal });
    expect(xhr().aborted).toBe(false);
    controller.abort();
    expect(xhr().aborted).toBe(true);
    const error = await done.catch(e => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 0, code: 'aborted' });
  });

  it('rejects with aborted without a request when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(uploadFile(slot, file, { signal: controller.signal })).rejects.toMatchObject({ status: 0, code: 'aborted' });
    expect(FakeXHR.instances).toHaveLength(0);
  });

  it('ignores a signal that fires after the upload finished', async () => {
    const controller = new AbortController();
    const done = uploadFile(slot, file, { signal: controller.signal });
    xhr().finish(200);
    await done;
    controller.abort();
    expect(xhr().aborted).toBe(false);
  });

  it('settles once: a late error after an abort changes nothing', async () => {
    const controller = new AbortController();
    const done = uploadFile(slot, file, { signal: controller.signal });
    controller.abort();
    xhr().emit('error');
    await expect(done).rejects.toMatchObject({ code: 'aborted' });
  });
});
