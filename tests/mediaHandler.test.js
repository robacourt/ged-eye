// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import sharp from 'sharp';
import { parseTriggerDelivery } from '@neon/functions/triggers';
import { createMediaHandler } from '../media/handler.js';
import { createJobQueue } from '../media/jobQueue.js';
import * as imaging from '../media/imaging.js';
import { sha256Hex } from '../media/imaging.js';
import { avatarKeyFor } from '../media/crop.js';
import { IMMUTABLE, ImagingError, MAX_UPLOAD_BYTES, UUID, inlineDisposition } from '../media/types.js';
import { AuthError } from '../api/auth.js';

const NOW = new Date('2026-10-09T12:00:00.000Z');
const ID = '0b6f5a0e-4d1c-4f7e-9a51-2a3c4d5e6f70';
const OTHER_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const FILE_NAME = "Ian's photo.jpg";

const red = () => sharp({ create: { width: 400, height: 200, channels: 3, background: '#c33' } });
const gpsJpeg = await red().jpeg().withMetadata({ orientation: 6 })
  .withExif({ IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '51/1 30/1 0/1' } }).toBuffer();
const plainJpeg = await red().jpeg().withMetadata({ orientation: 6 }).toBuffer();
const pdf = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');
const GPS_SHA = sha256Hex(gpsJpeg);
const PLAIN_SHA = sha256Hex(plainJpeg);
const PDF_SHA = sha256Hex(pdf);

const EDITORS = { 'editor@example.test': { email: 'editor@example.test', name: 'Ed Editor', role: 'editor' } };
const TOKENS = {
  editor: { email: 'editor@example.test', name: 'Ed', sub: 'u2' },
  viewer: { email: 'viewer@example.test', name: 'Vi', sub: 'u4' }
};

// Stands in for api/auth.js, as in apiHandler.test.js: no header → null, a known token → its user, else AuthError(401).
async function fakeAuthenticate(request) {
  const header = request.headers.get('authorization');
  if (header === null) return null;
  const user = TOKENS[header.replace(/^Bearer /, '')];
  if (!user) throw new AuthError(401, 'unauthenticated', 'bad token');
  return user;
}

/** In-memory storage with media/storage.js's interface. `objects` maps key → { body, contentType, … }. */
function fakeStorage() {
  const objects = new Map();
  return {
    objects,
    presignPut: vi.fn(async (key) => `https://storage.test/ged-eye-media/${key}?X-Amz-Signature=fake`),
    get: vi.fn(async (key) => objects.get(key)?.body ?? null),
    exists: vi.fn(async (key) => objects.has(key)),
    putOnce: vi.fn(async (key, body, { contentType, cacheControl, contentDisposition, metadata } = {}) => {
      if (objects.has(key)) return 'exists';
      objects.set(key, { body, contentType, metadata, cacheControl, contentDisposition, lastModified: NOW });
      return 'uploaded';
    }),
    remove: vi.fn(async (key) => { objects.delete(key); }),
    listOlderThan: vi.fn(async (prefix, cutoff) => [...objects]
      .filter(([key, object]) => key.startsWith(prefix) && object.lastModified < cutoff)
      .map(([key]) => key))
  };
}

const scheduleDelivery = (name = 'sweep-incoming') => ({
  ok: true,
  invocation: {
    version: 1, invocationId: 'inv-1', type: 'schedule',
    trigger: { type: 'schedule', id: 'trigger-1', name },
    data: { scheduledAt: '2026-10-09T11:17:00Z' }
  }
});

function setup({ db: dbOverrides = {}, imaging: imagingOverrides = {}, queue = createJobQueue(), parseTrigger } = {}) {
  const storage = fakeStorage();
  const db = {
    lookupEditor: vi.fn(async (email) => EDITORS[email] ?? null),
    mediaBySha: vi.fn(async () => null),
    ...dbOverrides
  };
  const imagingImpl = {
    ...imaging,
    processFile: vi.fn(imaging.processFile),
    renderAvatar: vi.fn(imaging.renderAvatar),
    ...imagingOverrides
  };
  const log = vi.fn();
  const authenticate = vi.fn(fakeAuthenticate);
  const trigger = parseTrigger ?? vi.fn(async () => scheduleDelivery());
  const handler = createMediaHandler({
    storage, db, authenticate, imaging: imagingImpl, queue, parseTrigger: trigger, now: () => NOW, log
  });
  const request = (path, { method = 'GET', token, headers = {}, body } = {}) => {
    const init = { method, headers: { ...headers } };
    if (token) init.headers.authorization = `Bearer ${token}`;
    if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
    return handler(new Request(`https://media.test${path}`, init));
  };
  const stage = (key, body, lastModified = NOW) => storage.objects.set(key, { body, lastModified });
  return { storage, db, imaging: imagingImpl, log, authenticate, parseTrigger: trigger, handler, request, stage };
}

const uploadBody = (overrides = {}) => ({ fileName: FILE_NAME, contentType: 'image/jpeg', byteSize: 1234, ...overrides });
const processUpload = (request, id = ID, body = { fileName: FILE_NAME }) =>
  request(`/uploads/${id}/process`, { method: 'POST', token: 'editor', body });

describe('media handler: auth, health, preflight', () => {
  const EDITOR_ROUTES = [
    ['POST', '/uploads', uploadBody()],
    ['POST', `/uploads/${ID}/process`, { fileName: FILE_NAME }],
    ['DELETE', `/uploads/${ID}`, undefined],
    ['POST', '/avatars', { objectKey: `originals/${PLAIN_SHA}.jpg`, crop: { x: 0, y: 0.25, w: 1, h: 0.5 } }]
  ];

  it.each(EDITOR_ROUTES)('%s %s answers 401 without a token, and with a bad one', async (method, path, body) => {
    const { request, storage } = setup();
    for (const token of [undefined, 'forged']) {
      const res = await request(path, { method, token, body });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'unauthenticated' });
      expect(res.headers.get('www-authenticate')).toBe('Bearer');
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
    }
    expect(storage.presignPut).not.toHaveBeenCalled();
    expect(storage.get).not.toHaveBeenCalled();
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it.each(EDITOR_ROUTES)('%s %s answers 403 not_an_editor, with the email, for a signed-in non-editor', async (method, path, body) => {
    const { request, db } = setup();
    const res = await request(path, { method, token: 'viewer', body });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'not_an_editor', email: 'viewer@example.test' });
    expect(db.lookupEditor).toHaveBeenCalledWith('viewer@example.test');
  });

  it('authenticates before validating the input', async () => {
    const { request } = setup();
    expect((await request('/uploads', { method: 'POST', body: '{nope' })).status).toBe(401);
    expect((await request('/uploads/not-a-uuid/process', { method: 'POST', body: {} })).status).toBe(401);
  });

  it('answers health checks without authenticating', async () => {
    const { request, authenticate } = setup();
    const res = await request('/health', { token: 'forged' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(authenticate).not.toHaveBeenCalled();
  });

  it('answers a CORS preflight on any path without authenticating', async () => {
    const { request, authenticate } = setup();
    const res = await request('/uploads', { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-methods')).toContain('DELETE');
    expect(res.headers.get('access-control-allow-headers')).toContain('authorization');
    expect(authenticate).not.toHaveBeenCalled();
  });

  it('answers unknown routes with 404', async () => {
    const { request } = setup();
    expect((await request('/nope')).status).toBe(404);
    expect((await request('/uploads', { token: 'editor' })).status).toBe(404);
  });
});

describe('POST /uploads', () => {
  const create = (request, body) => request('/uploads', { method: 'POST', token: 'editor', body });

  it('returns a presigned PUT slot for incoming/<uploadId>, with the type to send', async () => {
    const { request, storage } = setup();
    const res = await create(request, uploadBody());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.uploadId).toMatch(UUID);
    expect(body).toEqual({
      uploadId: body.uploadId,
      url: `https://storage.test/ged-eye-media/incoming/${body.uploadId}?X-Amz-Signature=fake`,
      headers: { 'Content-Type': 'image/jpeg' }
    });
    expect(storage.presignPut).toHaveBeenCalledWith(`incoming/${body.uploadId}`, 'image/jpeg', 1234);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('gives every slot a fresh id', async () => {
    const { request } = setup();
    const a = await (await create(request, uploadBody())).json();
    const b = await (await create(request, uploadBody())).json();
    expect(a.uploadId).not.toBe(b.uploadId);
  });

  it("signs application/octet-stream when the browser doesn't know the type, and image/jpeg for image/jpg", async () => {
    const { request, storage } = setup();
    const unknown = await (await create(request, uploadBody({ contentType: '' }))).json();
    expect(unknown.headers).toEqual({ 'Content-Type': 'application/octet-stream' });
    expect(storage.presignPut).toHaveBeenLastCalledWith(`incoming/${unknown.uploadId}`, 'application/octet-stream', 1234);
    const jpg = await (await create(request, uploadBody({ contentType: 'image/jpg' }))).json();
    expect(jpg.headers).toEqual({ 'Content-Type': 'image/jpeg' });
  });

  it('signs the largest allowed size', async () => {
    const { request, storage } = setup();
    expect((await create(request, uploadBody({ byteSize: MAX_UPLOAD_BYTES }))).status).toBe(200);
    expect(storage.presignPut).toHaveBeenCalledWith(expect.any(String), 'image/jpeg', MAX_UPLOAD_BYTES);
  });

  it('refuses an empty file (400 empty) and one over 50 MB (413 too_large)', async () => {
    const { request, storage } = setup();
    const empty = await create(request, uploadBody({ byteSize: 0 }));
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({ error: 'empty' });
    const large = await create(request, uploadBody({ byteSize: MAX_UPLOAD_BYTES + 1 }));
    expect(large.status).toBe(413);
    expect(await large.json()).toEqual({ error: 'too_large' });
    expect(storage.presignPut).not.toHaveBeenCalled();
  });

  it.each([[1.5], [-1], ['1234'], [null], [undefined], [Number.NaN]])('refuses byteSize %s as invalid', async (byteSize) => {
    const { request, storage } = setup();
    const res = await create(request, uploadBody({ byteSize }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid', field: 'byteSize' });
    expect(storage.presignPut).not.toHaveBeenCalled();
  });

  it('refuses HEIC with heic_unsupported and other types with unsupported_type', async () => {
    const { request, storage } = setup();
    const heic = await create(request, uploadBody({ contentType: 'image/heic' }));
    expect(heic.status).toBe(400);
    expect(await heic.json()).toEqual({ error: 'heic_unsupported' });
    for (const contentType of ['text/html', undefined, 42]) {
      const res = await create(request, uploadBody({ contentType }));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'unsupported_type' });
    }
    expect(storage.presignPut).not.toHaveBeenCalled();
  });

  it.each([[''], ['   '], ['a/b.jpg'], ['a\\b.jpg'], ['a\u0000.jpg'], ['x'.repeat(256)], [undefined], [7]])(
    'refuses the file name %j as invalid', async (fileName) => {
      const { request, storage } = setup();
      const res = await create(request, uploadBody({ fileName }));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'invalid', field: 'fileName' });
      expect(storage.presignPut).not.toHaveBeenCalled();
    });

  it('refuses a body that is not a JSON object', async () => {
    const { request } = setup();
    const res = await request('/uploads', { method: 'POST', token: 'editor', body: '[1]' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid', field: 'body' });
  });
});

describe('POST /uploads/:id/process', () => {
  it('refuses an id that is not a UUID', async () => {
    const { request, storage } = setup();
    for (const id of ['abc', ID.toUpperCase(), `${ID}x`, '..%2Foriginals%2Fx']) {
      const res = await processUpload(request, id);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'invalid', field: 'id' });
    }
    expect(storage.get).not.toHaveBeenCalled();
  });

  it('refuses a bad file name', async () => {
    const { request, stage, storage } = setup();
    stage(`incoming/${ID}`, plainJpeg);
    const res = await processUpload(request, ID, { fileName: 'a/b.jpg' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid', field: 'fileName' });
    expect(storage.objects.has(`incoming/${ID}`)).toBe(true);
  });

  it('answers 404 not_found when the upload is missing or expired', async () => {
    const { request } = setup();
    const res = await processUpload(request);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });

  it('stores a JPEG with GPS re-encoded without it, writes the display image and thumbnail, and deletes the upload', async () => {
    const { request, stage, storage, db } = setup();
    stage(`incoming/${ID}`, gpsJpeg);
    const res = await processUpload(request);
    expect(res.status).toBe(200);
    const { media } = await res.json();

    const original = storage.objects.get(`originals/${GPS_SHA}.jpg`);
    expect(Buffer.compare(original.body, gpsJpeg)).not.toBe(0);
    const meta = await sharp(original.body).metadata();
    expect(meta.exif).toBeUndefined();
    expect([meta.width, meta.height]).toEqual([200, 400]);
    expect(original).toMatchObject({
      contentType: 'image/jpeg',
      cacheControl: 'public, max-age=31536000, immutable',
      contentDisposition: inlineDisposition(FILE_NAME),
      metadata: { width: '200', height: '400' }
    });

    const display = storage.objects.get(`display/${GPS_SHA}.webp`);
    expect(display).toMatchObject({ contentType: 'image/webp', cacheControl: IMMUTABLE });
    expect(await sharp(display.body).metadata()).toMatchObject({ format: 'webp', width: 200, height: 400 });
    const thumb = storage.objects.get(`thumbs/${GPS_SHA}.webp`);
    expect(thumb).toMatchObject({ contentType: 'image/webp', cacheControl: IMMUTABLE });
    expect(await sharp(thumb.body).metadata()).toMatchObject({ format: 'webp', width: 160, height: 320 });

    expect(storage.objects.has(`incoming/${ID}`)).toBe(false);
    expect(db.mediaBySha).toHaveBeenCalledWith(GPS_SHA);
    expect(media).toEqual({
      mediaId: null,
      sha256: GPS_SHA,
      ext: 'jpg',
      objectKey: `originals/${GPS_SHA}.jpg`,
      displayKey: `display/${GPS_SHA}.webp`,
      thumbKey: `thumbs/${GPS_SHA}.webp`,
      contentType: 'image/jpeg',
      byteSize: original.body.length,
      width: 200,
      height: 400,
      fileName: FILE_NAME,
      caption: null,
      date: null
    });
  });

  it('answers 404 when processing the same upload again, since it is gone', async () => {
    const { request, stage } = setup();
    stage(`incoming/${ID}`, gpsJpeg);
    expect((await processUpload(request)).status).toBe(200);
    expect((await processUpload(request)).status).toBe(404);
  });

  it('stores a JPEG without location byte for byte', async () => {
    const { request, stage, storage } = setup();
    stage(`incoming/${ID}`, plainJpeg);
    const { media } = await (await processUpload(request)).json();
    expect(storage.objects.get(`originals/${PLAIN_SHA}.jpg`).body.equals(plainJpeg)).toBe(true);
    expect(media).toMatchObject({ sha256: PLAIN_SHA, byteSize: plainJpeg.length, width: 200, height: 400 });
  });

  it('stores a PDF, sniffed whatever its name, with no derivatives or size metadata', async () => {
    const { request, stage, storage } = setup();
    stage(`incoming/${ID}`, pdf);
    const { media } = await (await processUpload(request, ID, { fileName: 'scan.jpg' })).json();
    const original = storage.objects.get(`originals/${PDF_SHA}.pdf`);
    expect(original.body.equals(pdf)).toBe(true);
    expect(original).toMatchObject({ contentType: 'application/pdf', contentDisposition: inlineDisposition('scan.jpg') });
    expect(original.metadata).toBeUndefined();
    expect([...storage.objects.keys()]).toEqual([`originals/${PDF_SHA}.pdf`]);
    expect(media).toEqual({
      mediaId: null, sha256: PDF_SHA, ext: 'pdf', objectKey: `originals/${PDF_SHA}.pdf`, displayKey: null, thumbKey: null,
      contentType: 'application/pdf', byteSize: pdf.length, width: null, height: null, fileName: 'scan.jpg',
      caption: null, date: null
    });
  });

  it('on a dedupe hit writes nothing, deletes the upload and returns the existing row', async () => {
    const row = {
      id: '42', sha256: GPS_SHA, object_key: `originals/${GPS_SHA}.jpeg`, display_key: null, thumb_key: `thumbs/${GPS_SHA}.webp`,
      content_type: 'image/jpeg', byte_size: '98765', width: 1200, height: 900, file_name: 'wedding.jpeg',
      caption: 'The wedding', date: 'JUN 1923'
    };
    const { request, stage, storage, imaging: imagingImpl } = setup({ db: { mediaBySha: vi.fn(async () => row) } });
    stage(`incoming/${ID}`, gpsJpeg);
    const res = await processUpload(request);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      media: {
        mediaId: 42, sha256: GPS_SHA, ext: 'jpeg', objectKey: `originals/${GPS_SHA}.jpeg`, displayKey: null,
        thumbKey: `thumbs/${GPS_SHA}.webp`, contentType: 'image/jpeg', byteSize: 98765, width: 1200, height: 900,
        fileName: 'wedding.jpeg', caption: 'The wedding', date: 'JUN 1923'
      }
    });
    expect(storage.putOnce).not.toHaveBeenCalled();
    expect(imagingImpl.processFile).not.toHaveBeenCalled();
    expect(storage.objects.size).toBe(0);
  });

  it.each([
    ['an unsupported file', Buffer.from('<html>hello</html>'), 400, 'unsupported_type'],
    ['a HEIC file', Buffer.from([0, 0, 0, 24, ...Buffer.from('ftypheic'), 0, 0, 0, 0, ...Buffer.from('mif1heic')]), 400, 'heic_unsupported'],
    ['an empty file', Buffer.alloc(0), 400, 'empty'],
    ['an unreadable JPEG', Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]), 400, 'unreadable']
  ])('refuses %s permanently and deletes the upload', async (_, bytes, status, code) => {
    const { request, stage, storage, log } = setup();
    stage(`incoming/${ID}`, bytes);
    const res = await processUpload(request);
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: code });
    expect(storage.objects.has(`incoming/${ID}`)).toBe(false);
    expect(storage.putOnce).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('refuses an upload over 50 MB (413) found while reading it, and deletes it', async () => {
    const { request, stage, storage } = setup();
    stage(`incoming/${ID}`, plainJpeg);
    storage.get.mockRejectedValueOnce(new ImagingError('too_large', 413));
    const res = await processUpload(request);
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'too_large' });
    expect(storage.objects.has(`incoming/${ID}`)).toBe(false);
  });

  it('still reports a permanent rejection when the upload cannot be deleted', async () => {
    const { request, stage, storage, log } = setup();
    stage(`incoming/${ID}`, Buffer.from('nope'));
    storage.remove.mockRejectedValueOnce(new Error('storage down'));
    const res = await processUpload(request);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'unsupported_type' });
    expect(log).toHaveBeenCalled();
  });

  it('still answers 200 with the media when the upload cannot be deleted after success, and logs it', async () => {
    const { request, stage, storage, log } = setup();
    stage(`incoming/${ID}`, plainJpeg);
    const failure = new Error('storage down');
    storage.remove.mockRejectedValueOnce(failure);
    const res = await processUpload(request);
    expect(res.status).toBe(200);
    expect((await res.json()).media).toMatchObject({ mediaId: null, sha256: PLAIN_SHA, objectKey: `originals/${PLAIN_SHA}.jpg` });
    expect(log).toHaveBeenCalledWith('could not delete', `incoming/${ID}`, failure);
    expect(storage.objects.has(`originals/${PLAIN_SHA}.jpg`)).toBe(true);
    expect(storage.objects.has(`incoming/${ID}`)).toBe(true); // left for the hourly sweep
  });

  it('keeps the upload after a transient failure (500), so a retry can succeed', async () => {
    const { request, stage, storage, log } = setup();
    stage(`incoming/${ID}`, gpsJpeg);
    storage.putOnce.mockRejectedValueOnce(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
    const res = await processUpload(request);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal' });
    expect(log).toHaveBeenCalledWith('request failed', 'POST', `/uploads/${ID}/process`, expect.any(Error));
    expect(storage.objects.has(`incoming/${ID}`)).toBe(true);

    const retry = await processUpload(request);
    expect(retry.status).toBe(200);
    expect(storage.objects.has(`originals/${GPS_SHA}.jpg`)).toBe(true);
    expect(storage.objects.has(`incoming/${ID}`)).toBe(false);
  });

  it('answers 500, not a hang, when a storage call times out, and the queue carries on', async () => {
    const { request, stage, storage, log } = setup();
    stage(`incoming/${ID}`, plainJpeg);
    storage.get.mockRejectedValueOnce(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    const res = await processUpload(request);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal' });
    expect(log).toHaveBeenCalledWith('request failed', 'POST', `/uploads/${ID}/process`, expect.objectContaining({ name: 'TimeoutError' }));
    expect(storage.objects.has(`incoming/${ID}`)).toBe(true);
    expect((await processUpload(request)).status).toBe(200);
  });

  it('never overwrites an object that already exists', async () => {
    const { request, stage, storage } = setup();
    const earlier = Buffer.from('written by an earlier run');
    stage(`originals/${PLAIN_SHA}.jpg`, earlier);
    stage(`incoming/${ID}`, plainJpeg);
    expect((await processUpload(request)).status).toBe(200);
    expect(storage.objects.get(`originals/${PLAIN_SHA}.jpg`).body).toBe(earlier);
    expect(storage.objects.has(`display/${PLAIN_SHA}.webp`)).toBe(true);
  });

  it('answers 503 busy once four jobs are waiting, and runs the waiting ones afterwards', async () => {
    const queue = createJobQueue();
    vi.spyOn(queue, 'run');
    const { request, stage, storage } = setup({ queue });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const get = storage.get.getMockImplementation();
    storage.get.mockImplementation(async (key) => { await gate; return get(key); });
    const ids = Array.from({ length: 5 }, () => crypto.randomUUID());
    ids.forEach((id) => stage(`incoming/${id}`, plainJpeg));

    // One job running (blocked in its download), then four waiting.
    const running = [processUpload(request, ids[0])];
    await vi.waitFor(() => expect(storage.get).toHaveBeenCalledTimes(1));
    running.push(...ids.slice(1).map((id) => processUpload(request, id)));
    await vi.waitFor(() => expect(queue.run).toHaveBeenCalledTimes(5));
    const busy = await processUpload(request, OTHER_ID);
    expect(busy.status).toBe(503);
    expect(await busy.json()).toEqual({ error: 'busy', message: 'Busy processing photos. Try again in a moment.' });

    release();
    expect((await Promise.all(running)).map((res) => res.status)).toEqual([200, 200, 200, 200, 200]);
  });

  it('downloads inside the queued job, so waiting requests hold no file', async () => {
    const queue = createJobQueue();
    const { request, stage, storage } = setup({ queue });
    stage(`incoming/${ID}`, plainJpeg);
    let release;
    const blocker = queue.run(() => new Promise((resolve) => { release = resolve; }));
    const pending = processUpload(request);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(storage.get).not.toHaveBeenCalled();
    release();
    await blocker;
    expect((await pending).status).toBe(200);
    expect(storage.get).toHaveBeenCalledWith(`incoming/${ID}`);
  });
});

describe('DELETE /uploads/:id', () => {
  it('deletes the upload and answers 204', async () => {
    const { request, stage, storage } = setup();
    stage(`incoming/${ID}`, plainJpeg);
    const res = await request(`/uploads/${ID}`, { method: 'DELETE', token: 'editor' });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(storage.objects.has(`incoming/${ID}`)).toBe(false);
    expect(storage.remove).toHaveBeenCalledWith(`incoming/${ID}`);
  });

  it('answers 204 when the upload was already gone', async () => {
    const { request } = setup();
    expect((await request(`/uploads/${ID}`, { method: 'DELETE', token: 'editor' })).status).toBe(204);
  });

  it('refuses an id that is not a UUID', async () => {
    const { request, storage } = setup();
    const res = await request('/uploads/abc', { method: 'DELETE', token: 'editor' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid', field: 'id' });
    expect(storage.remove).not.toHaveBeenCalled();
  });
});

describe('POST /avatars', () => {
  const CROP = { x: 0, y: 0.25, w: 1, h: 0.5 };
  const PLAIN_KEY = `originals/${PLAIN_SHA}.jpg`;
  const avatar = (request, body) => request('/avatars', { method: 'POST', token: 'editor', body });

  it('renders the crop once, stores it, and returns its key; a second identical call reuses it', async () => {
    const { request, stage, storage, imaging: imagingImpl } = setup();
    stage(PLAIN_KEY, plainJpeg);
    const expected = avatarKeyFor(PLAIN_SHA, CROP);

    const res = await avatar(request, { objectKey: PLAIN_KEY, crop: CROP });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ avatarKey: expected });
    const stored = storage.objects.get(expected);
    expect(stored).toMatchObject({ contentType: 'image/webp', cacheControl: IMMUTABLE });
    const meta = await sharp(stored.body).metadata();
    expect(meta).toMatchObject({ format: 'webp', width: 400, height: 400 });
    expect(meta.exif).toBeUndefined();

    const again = await avatar(request, { objectKey: PLAIN_KEY, crop: { ...CROP } });
    expect(await again.json()).toEqual({ avatarKey: expected });
    expect(imagingImpl.renderAvatar).toHaveBeenCalledTimes(1);
    expect(storage.putOnce).toHaveBeenCalledTimes(1);
  });

  it.each([
    [undefined], [''], ['originals/abc.jpg'], [`display/${PLAIN_SHA}.webp`], [`originals/${PLAIN_SHA.toUpperCase()}.jpg`],
    [`originals/${PLAIN_SHA}`], [`originals/${PLAIN_SHA}.jpg/../x`], [`incoming/${ID}`], [42]
  ])('refuses the object key %j as invalid', async (objectKey) => {
    const { request, storage } = setup();
    const res = await avatar(request, { objectKey, crop: CROP });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid', field: 'objectKey' });
    expect(storage.get).not.toHaveBeenCalled();
  });

  it.each([
    [undefined, 'crop'], ['square', 'crop'], [{ x: 0, y: 0, w: 1 }, 'crop.h'], [{ ...CROP, x: 'a' }, 'crop.x'],
    [{ ...CROP, w: 0 }, 'crop.w'], [{ ...CROP, x: 0.5 }, 'crop.w']
  ])('refuses the crop %j as invalid (field %s)', async (crop, field) => {
    const { request, storage } = setup();
    const res = await avatar(request, { objectKey: PLAIN_KEY, crop });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid', field });
    expect(storage.get).not.toHaveBeenCalled();
  });

  it('refuses a crop that is not square in pixels', async () => {
    const { request, stage } = setup();
    stage(PLAIN_KEY, plainJpeg);
    const res = await avatar(request, { objectKey: PLAIN_KEY, crop: { x: 0, y: 0, w: 1, h: 1 } });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid', field: 'crop' });
  });

  it('answers 404 for an unknown original', async () => {
    const { request } = setup();
    const res = await avatar(request, { objectKey: PLAIN_KEY, crop: CROP });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });

  it('refuses a PDF', async () => {
    const { request, stage, imaging: imagingImpl } = setup();
    stage(`originals/${PDF_SHA}.pdf`, pdf);
    const res = await avatar(request, { objectKey: `originals/${PDF_SHA}.pdf`, crop: CROP });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid', field: 'objectKey', message: 'Only images can be avatars.' });
    expect(imagingImpl.renderAvatar).not.toHaveBeenCalled();
  });

  it('keeps the original when its avatar fails (an avatar never deletes anything)', async () => {
    const { request, stage, storage } = setup();
    stage(`originals/${PLAIN_SHA}.jpg`, Buffer.from('not an image'));
    const res = await avatar(request, { objectKey: PLAIN_KEY, crop: CROP });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'unsupported_type' });
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it('answers a RangeError from the crop maths (a server bug) with a logged 500, not a 400', async () => {
    const renderAvatar = vi.fn(async () => { throw new RangeError('The image width and height must be positive whole numbers'); });
    const { request, stage, log } = setup({ imaging: { renderAvatar } });
    stage(PLAIN_KEY, plainJpeg);
    const res = await avatar(request, { objectKey: PLAIN_KEY, crop: CROP });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal' });
    expect(log).toHaveBeenCalledWith('request failed', 'POST', '/avatars', expect.any(RangeError));
  });

  it('renders through the queue, so a full queue answers 503 busy', async () => {
    const { request, stage } = setup({ queue: createJobQueue({ maxWaiting: 0 }) });
    stage(PLAIN_KEY, plainJpeg);
    const res = await avatar(request, { objectKey: PLAIN_KEY, crop: CROP });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'busy' });
  });
});

describe('POST /sweep', () => {
  const sweep = (request, init = {}) => request('/sweep', { method: 'POST', body: {}, ...init });

  it('deletes only incoming/ objects more than an hour old, without a user token', async () => {
    const { request, stage, storage, authenticate, parseTrigger } = setup();
    const hoursAgo = (hours) => new Date(NOW.getTime() - hours * 3_600_000);
    stage(`incoming/${ID}`, plainJpeg, hoursAgo(2));
    stage(`incoming/${OTHER_ID}`, plainJpeg, hoursAgo(0.5));
    stage(`originals/${PLAIN_SHA}.jpg`, plainJpeg, hoursAgo(2));
    const res = await sweep(request);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 1, failed: 0 });
    expect(storage.listOlderThan).toHaveBeenCalledWith('incoming/', hoursAgo(1));
    expect([...storage.objects.keys()].sort()).toEqual([`incoming/${OTHER_ID}`, `originals/${PLAIN_SHA}.jpg`].sort());
    expect(parseTrigger).toHaveBeenCalledWith(expect.any(Request));
    expect(authenticate).not.toHaveBeenCalled();
  });

  it('keeps going past a failed delete, logging it, and counts both', async () => {
    const { request, stage, storage, log } = setup();
    const ids = [ID, OTHER_ID, crypto.randomUUID()];
    ids.forEach((id) => stage(`incoming/${id}`, plainJpeg, new Date(0)));
    const failure = new Error('storage down');
    storage.remove.mockImplementationOnce(async () => { throw failure; });
    const res = await sweep(request);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 2, failed: 1 });
    expect(storage.remove).toHaveBeenCalledTimes(3);
    expect(log).toHaveBeenCalledWith('sweep could not delete', `incoming/${ID}`, failure);
    expect([...storage.objects.keys()]).toEqual([`incoming/${ID}`]);
  });

  it.each([['missing_header', 401], ['invocation_id_mismatch', 401], ['invalid_body', 400]])(
    'answers a failed delivery (%s) with %i and deletes nothing', async (error, status) => {
      const { request, stage, storage } = setup({ parseTrigger: vi.fn(async () => ({ ok: false, error })) });
      stage(`incoming/${ID}`, plainJpeg, new Date(0));
      const res = await sweep(request);
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual({ error });
      expect(storage.listOlderThan).not.toHaveBeenCalled();
      expect(storage.objects.size).toBe(1);
    });

  it('refuses a delivery from another trigger', async () => {
    const { request, storage } = setup({ parseTrigger: vi.fn(async () => scheduleDelivery('hourly')) });
    const res = await sweep(request);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'unknown_trigger' });
    expect(storage.listOlderThan).not.toHaveBeenCalled();
  });

  it('works with the real parseTriggerDelivery', async () => {
    const { request, stage, storage } = setup({ parseTrigger: parseTriggerDelivery });
    stage(`incoming/${ID}`, plainJpeg, new Date(0));
    const wire = {
      version: 1, invocation_id: 'inv-9', trigger: { type: 'schedule', id: 'trigger-1', name: 'sweep-incoming' },
      data: { scheduled_at: '2026-10-09T11:17:00Z' }
    };
    const unsigned = await sweep(request, { body: wire });
    expect(unsigned.status).toBe(401);
    expect(storage.objects.size).toBe(1);
    const res = await sweep(request, { body: wire, headers: { 'x-neon-trigger-invocation-id': 'inv-9' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 1, failed: 0 });
    const broken = await sweep(request, { body: '{', headers: { 'x-neon-trigger-invocation-id': 'inv-9' } });
    expect(broken.status).toBe(400);
  });
});
