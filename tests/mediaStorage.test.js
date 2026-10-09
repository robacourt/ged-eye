// @vitest-environment node
import { createServer } from 'node:http';
import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client
} from '@aws-sdk/client-s3';
import { CLIENT_OPTIONS, createStorage } from '../media/storage.js';
import { createMediaDb } from '../media/db.js';
import { MAX_UPLOAD_BYTES } from '../media/types.js';

const ID = '0b6f5a0e-4d1c-4f7e-9a51-2a3c4d5e6f70';
const SHA = 'ab'.repeat(32);
const IMMUTABLE = 'public, max-age=31536000, immutable';
const EDITOR = { email: 'editor@example.test', name: 'Ed Editor', role: 'editor' };

afterEach(() => {
  vi.unstubAllEnvs();
});

/** A fake S3 client: `respond(command, options)` answers each send. */
function fakeClient(respond) {
  return { send: vi.fn(async (command, options) => respond(command, options)) };
}

const s3Error = (name, status) => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });

/** A body like the SDK's, holding `bytes`. */
const sdkBody = (bytes) => ({ transformToByteArray: vi.fn(async () => new Uint8Array(bytes)), destroy: vi.fn() });

/** A send that never answers until its abort signal fires, like a hung connection. */
const hang = (command, { abortSignal } = {}) => new Promise((_, reject) => {
  abortSignal?.addEventListener('abort', () => reject(abortSignal.reason));
});

describe('media/storage.js', () => {
  const quick = (client, options = {}) => createStorage({ client, retryDelay: () => 0, ...options });

  /** Points the default client (as the Function builds it) at `endpoint`, through the env vars Neon injects. */
  function stubStorageEnv(endpoint) {
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'AKIDTEST');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'test-secret');
    vi.stubEnv('AWS_REGION', 'eu-central-1');
    vi.stubEnv('AWS_ENDPOINT_URL_S3', endpoint);
  }

  it("presigns, with the default client, a 15-minute PUT signing content-type and content-length, and no checksum", async () => {
    stubStorageEnv('https://storage.test');
    const url = new URL(await createStorage().presignPut(`incoming/${ID}`, 'image/jpeg', 1234));
    expect(`${url.origin}${url.pathname}`).toBe(`https://storage.test/ged-eye-media/incoming/${ID}`);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(url.searchParams.get('X-Amz-SignedHeaders').split(';').sort()).toEqual(['content-length', 'content-type', 'host']);
    const keys = [...url.searchParams.keys()].map((key) => key.toLowerCase());
    expect(keys.filter((key) => key.startsWith('x-amz-checksum') || key === 'x-amz-sdk-checksum-algorithm')).toEqual([]);
  });

  it("would put an empty body's checksum in the URL without CLIENT_OPTIONS", async () => {
    // Shows what requestChecksumCalculation: 'WHEN_REQUIRED' prevents, so the test above can't pass by accident.
    stubStorageEnv('https://storage.test');
    const { requestChecksumCalculation, ...rest } = CLIENT_OPTIONS;
    expect(requestChecksumCalculation).toBe('WHEN_REQUIRED');
    const url = new URL(await createStorage({ client: new S3Client(rest) }).presignPut(`incoming/${ID}`, 'image/jpeg', 1234));
    expect(url.searchParams.get('x-amz-sdk-checksum-algorithm')).toBe('CRC32');
  });

  describe('the default client against a failing server', () => {
    let server;
    afterEach(() => new Promise((resolve) => server.close(resolve)));

    /** A local HTTP server that answers every request with 503; → its count of requests. */
    async function failingServer() {
      const seen = { requests: 0 };
      server = createServer((request, response) => {
        seen.requests++;
        response.statusCode = 503;
        response.end();
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      stubStorageEnv(`http://127.0.0.1:${server.address().port}`);
      return seen;
    }

    it("doesn't retry inside the SDK: one request per call", async () => {
      const seen = await failingServer();
      await expect(createStorage().exists('originals/x.jpg')).rejects.toMatchObject({ $metadata: { httpStatusCode: 503 } });
      expect(seen.requests).toBe(1);
    });

    it("so putOnce's withRetry is the only retry layer: three HEADs, not nine", async () => {
      const seen = await failingServer();
      await expect(createStorage({ retryDelay: () => 0 }).putOnce('originals/x.jpg', Buffer.from('x')))
        .rejects.toMatchObject({ $metadata: { httpStatusCode: 503 } });
      expect(seen.requests).toBe(3);
    });
  });

  it('get returns a Buffer of the object, with a deadline on the call', async () => {
    const client = fakeClient(() => ({ ContentLength: 3, Body: sdkBody([1, 2, 3]) }));
    const body = await quick(client).get('incoming/x');
    expect(Buffer.isBuffer(body)).toBe(true);
    expect([...body]).toEqual([1, 2, 3]);
    const [command, options] = client.send.mock.calls[0];
    expect(command).toBeInstanceOf(GetObjectCommand);
    expect(command.input).toEqual({ Bucket: 'ged-eye-media', Key: 'incoming/x' });
    expect(options.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it('get returns null for a missing object, and rethrows anything else', async () => {
    expect(await quick(fakeClient(() => { throw s3Error('NoSuchKey', 404); })).get('k')).toBeNull();
    expect(await quick(fakeClient(() => { throw s3Error('NotFound', 404); })).get('k')).toBeNull();
    await expect(quick(fakeClient(() => { throw s3Error('AccessDenied', 403); })).get('k')).rejects.toThrow('AccessDenied');
  });

  it('get refuses an object over 50 MB before reading its body', async () => {
    const body = sdkBody([1]);
    const storage = quick(fakeClient(() => ({ ContentLength: MAX_UPLOAD_BYTES + 1, Body: body })));
    await expect(storage.get('k')).rejects.toMatchObject({ code: 'too_large', status: 413 });
    expect(body.transformToByteArray).not.toHaveBeenCalled();
    expect(body.destroy).toHaveBeenCalled();
  });

  it('get times out a hung request, and a body that stops arriving', async () => {
    const timeouts = { transfer: 20, quick: 20 };
    await expect(quick(fakeClient(hang), { timeouts }).get('k')).rejects.toMatchObject({ name: 'TimeoutError' });
    const body = { transformToByteArray: () => new Promise(() => {}), destroy: vi.fn() };
    const stalled = quick(fakeClient(() => ({ ContentLength: 10, Body: body })), { timeouts });
    await expect(stalled.get('k')).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(body.destroy).toHaveBeenCalled();
  });

  it('exists is true for a HEAD that succeeds, false for a 404, and throws otherwise', async () => {
    const client = fakeClient(() => ({}));
    expect(await quick(client).exists('k')).toBe(true);
    expect(client.send.mock.calls[0][0]).toBeInstanceOf(HeadObjectCommand);
    expect(await quick(fakeClient(() => { throw s3Error('NotFound', 404); })).exists('k')).toBe(false);
    await expect(quick(fakeClient(() => { throw s3Error('InternalError', 500); })).exists('k')).rejects.toThrow('InternalError');
    await expect(quick(fakeClient(hang), { timeouts: { transfer: 20, quick: 20 } }).exists('k'))
      .rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('putOnce leaves an existing key alone', async () => {
    const client = fakeClient(() => ({}));
    expect(await quick(client).putOnce('originals/a.jpg', Buffer.from('new'), { contentType: 'image/jpeg' })).toBe('exists');
    expect(client.send).toHaveBeenCalledTimes(1);
    expect(client.send.mock.calls[0][0]).toBeInstanceOf(HeadObjectCommand);
  });

  it('putOnce writes an absent key with its headers and metadata', async () => {
    const client = fakeClient((command) => {
      if (command instanceof HeadObjectCommand) throw s3Error('NotFound', 404);
      return {};
    });
    const body = Buffer.from('bytes');
    const result = await quick(client).putOnce('originals/a.jpg', body, {
      contentType: 'image/jpeg', cacheControl: IMMUTABLE, contentDisposition: "inline; filename*=UTF-8''a.jpg",
      metadata: { width: '200', height: '400' }
    });
    expect(result).toBe('uploaded');
    const [put, options] = client.send.mock.calls[1];
    expect(put).toBeInstanceOf(PutObjectCommand);
    expect(put.input).toEqual({
      Bucket: 'ged-eye-media', Key: 'originals/a.jpg', Body: body, ContentType: 'image/jpeg', CacheControl: IMMUTABLE,
      ContentDisposition: "inline; filename*=UTF-8''a.jpg", Metadata: { width: '200', height: '400' }
    });
    expect(options.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it('putOnce retries a transient failure twice, then gives up', async () => {
    let puts = 0;
    const flaky = (failures) => fakeClient((command) => {
      if (command instanceof HeadObjectCommand) throw s3Error('NotFound', 404);
      if (++puts <= failures) throw s3Error('SlowDown', 503);
      return {};
    });
    expect(await quick(flaky(2)).putOnce('k', Buffer.from('x'))).toBe('uploaded');
    expect(puts).toBe(3);
    puts = 0;
    await expect(quick(flaky(3)).putOnce('k', Buffer.from('x'))).rejects.toThrow('SlowDown');
    expect(puts).toBe(3);
  });

  it("putOnce doesn't retry a refusal", async () => {
    const client = fakeClient((command) => {
      if (command instanceof HeadObjectCommand) throw s3Error('NotFound', 404);
      throw s3Error('AccessDenied', 403);
    });
    await expect(quick(client).putOnce('k', Buffer.from('x'))).rejects.toThrow('AccessDenied');
    expect(client.send).toHaveBeenCalledTimes(2);
  });

  it('putOnce times out a hung PUT', async () => {
    const client = fakeClient((command, options) => {
      if (command instanceof HeadObjectCommand) throw s3Error('NotFound', 404);
      return hang(command, options);
    });
    await expect(quick(client, { timeouts: { transfer: 20, quick: 20 } }).putOnce('k', Buffer.from('x')))
      .rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('remove deletes the key and ignores a 404', async () => {
    const client = fakeClient(() => ({}));
    await quick(client).remove('incoming/x');
    expect(client.send.mock.calls[0][0]).toBeInstanceOf(DeleteObjectCommand);
    expect(client.send.mock.calls[0][0].input).toEqual({ Bucket: 'ged-eye-media', Key: 'incoming/x' });
    await quick(fakeClient(() => { throw s3Error('NoSuchKey', 404); })).remove('incoming/x');
    await expect(quick(fakeClient(() => { throw s3Error('InternalError', 500); })).remove('k')).rejects.toThrow('InternalError');
  });

  it('listOlderThan pages through the listing and keeps keys modified before the cutoff', async () => {
    const cutoff = new Date('2026-10-09T11:00:00Z');
    const pages = [
      { IsTruncated: true, NextContinuationToken: 't1', Contents: [
        { Key: 'incoming/old', LastModified: new Date('2026-10-09T10:00:00Z') },
        { Key: 'incoming/new', LastModified: new Date('2026-10-09T11:30:00Z') }] },
      { IsTruncated: false, Contents: [{ Key: 'incoming/older', LastModified: new Date('2026-10-08T10:00:00Z') }] }
    ];
    const client = fakeClient(() => pages.shift());
    expect(await quick(client).listOlderThan('incoming/', cutoff)).toEqual(['incoming/old', 'incoming/older']);
    const [first, second] = client.send.mock.calls.map(([command]) => command);
    expect(first).toBeInstanceOf(ListObjectsV2Command);
    expect(first.input).toEqual({ Bucket: 'ged-eye-media', Prefix: 'incoming/', ContinuationToken: undefined });
    expect(second.input).toMatchObject({ ContinuationToken: 't1' });
    expect(await quick(fakeClient(() => ({ IsTruncated: false }))).listOlderThan('incoming/', cutoff)).toEqual([]);
  });
});

describe('media/db.js', () => {
  it('looks editors up with the api query and media by sha', async () => {
    const pool = {
      query: vi.fn(async (sql) => {
        if (/from editor/.test(sql)) return { rows: [{ email: 'editor@example.test', name: 'Ed Editor', role: 'editor' }] };
        return { rows: [{ id: '42', sha256: SHA }] };
      })
    };
    const db = createMediaDb(pool);
    expect(await db.lookupEditor('editor@example.test')).toEqual(EDITOR);
    expect(pool.query).toHaveBeenLastCalledWith('select email, name, role from editor where email = $1', ['editor@example.test']);
    expect(await db.mediaBySha(SHA)).toEqual({ id: '42', sha256: SHA });
    const [sql, params] = pool.query.mock.calls[1];
    expect(sql.replace(/\s+/g, ' ').trim()).toBe(
      'select id, sha256, object_key, display_key, thumb_key, content_type, byte_size, width, height, file_name, caption, date ' +
      'from media where sha256 = $1');
    expect(params).toEqual([SHA]);
  });

  it('returns null for an unknown sha or editor', async () => {
    const db = createMediaDb({ query: vi.fn(async () => ({ rows: [] })) });
    expect(await db.mediaBySha(SHA)).toBeNull();
    expect(await db.lookupEditor('nobody@example.test')).toBeNull();
  });
});
