import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadPersonWithFamily, prefetchFamily, PersonNotFoundError, resetDataLoaderForTests } from '../src/dataLoader.js';
import { mediaUrl, thumbUrl } from '../src/media.js';

const view = (id, familyIds = []) => ({
  person: { id, name: id, parentIds: [], spouseIds: [], childIds: [], photos: [] },
  family: familyIds.map(fid => ({ id: fid, name: fid, sex: 'M', birthDate: null, avatarKey: null, parentIds: [] })),
  relationships: { parents: familyIds.slice(0, 1), spouses: [], children: familyIds.slice(1), siblings: [] }
});
const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe('dataLoader', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_API_URL', 'https://api.test');
    vi.stubEnv('VITE_MEDIA_BASE_URL', 'https://media.test/bucket');
    resetDataLoaderForTests();
    vi.stubGlobal('requestIdleCallback', (cb) => cb());
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('loads a view and maps relationship ids to records', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok(view('I1', ['I2', 'I3'])));
    vi.stubGlobal('fetch', fetchMock);
    const result = await loadPersonWithFamily('I1');
    expect(fetchMock).toHaveBeenCalledWith('https://api.test/person/I1', expect.objectContaining({ signal: expect.anything() }));
    expect(result.person.id).toBe('I1');
    expect(result.relationships.parents.map(p => p.id)).toEqual(['I2']);
    expect(result.relationships.children.map(p => p.id)).toEqual(['I3']);
    expect(result.family).toHaveLength(2);
  });

  it('caches views', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok(view('I1')));
    vi.stubGlobal('fetch', fetchMock);
    await loadPersonWithFamily('I1');
    await loadPersonWithFamily('I1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws PersonNotFoundError on 404 and on a malformed id (400)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({ error: 'not_found' }) }));
    await expect(loadPersonWithFamily('I9')).rejects.toBeInstanceOf(PersonNotFoundError);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: 'bad_id' }) }));
    await expect(loadPersonWithFamily('a.b')).rejects.toBeInstanceOf(PersonNotFoundError);
  });

  it('retries once after a network error', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError('offline')).mockResolvedValue(ok(view('I1')));
    vi.stubGlobal('fetch', fetchMock);
    await expect(loadPersonWithFamily('I1')).resolves.toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries once after a 503 and resolves on the second attempt', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) })
      .mockResolvedValueOnce(ok(view('I1')));
    vi.stubGlobal('fetch', fetchMock);
    await expect(loadPersonWithFamily('I1')).resolves.toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after a second server error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) }));
    await expect(loadPersonWithFamily('I1')).rejects.toThrow('HTTP 503');
  });

  it('does not retry a 404', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({ error: 'not_found' }) });
    vi.stubGlobal('fetch', fetchMock);
    await expect(loadPersonWithFamily('I9')).rejects.toBeInstanceOf(PersonNotFoundError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failed load', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({ error: 'not_found' }) })
      .mockResolvedValueOnce(ok(view('I1')));
    vi.stubGlobal('fetch', fetchMock);
    await expect(loadPersonWithFamily('I1')).rejects.toBeInstanceOf(PersonNotFoundError);
    await expect(loadPersonWithFamily('I1')).resolves.toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('shares one request between concurrent loads of the same person', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok(view('I1')));
    vi.stubGlobal('fetch', fetchMock);
    const [a, b] = await Promise.all([loadPersonWithFamily('I1'), loadPersonWithFamily('I1')]);
    expect(a.person.id).toBe('I1');
    expect(b.person.id).toBe('I1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries once after a request timeout', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new DOMException('The operation timed out.', 'TimeoutError'))
      .mockResolvedValue(ok(view('I1')));
    vi.stubGlobal('fetch', fetchMock);
    await expect(loadPersonWithFamily('I1')).resolves.toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('still loads when AbortSignal.timeout is unavailable (Safari 15)', async () => {
    const original = AbortSignal.timeout;
    delete AbortSignal.timeout;
    try {
      expect(typeof AbortSignal.timeout).toBe('undefined');
      const fetchMock = vi.fn().mockResolvedValue(ok(view('I1')));
      vi.stubGlobal('fetch', fetchMock);
      await expect(loadPersonWithFamily('I1')).resolves.toBeTruthy();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    } finally {
      AbortSignal.timeout = original;
    }
  });

  it('fails loudly when VITE_API_URL is not configured', async () => {
    vi.stubEnv('VITE_API_URL', '');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(loadPersonWithFamily('I1')).rejects.toThrow('VITE_API_URL is not configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('prefetches uncached relatives only once', async () => {
    const fetchMock = vi.fn((url) => Promise.resolve(ok(view(url.split('/').pop()))));
    vi.stubGlobal('fetch', fetchMock);
    const result = await loadPersonWithFamily('I1');
    await loadPersonWithFamily('I2');
    fetchMock.mockClear();
    const withFamily = { ...result, family: [{ id: 'I2' }, { id: 'I3' }, { id: 'I4' }] };
    prefetchFamily(withFamily);
    prefetchFamily(withFamily);
    await flush();
    expect(fetchMock.mock.calls.map(([url]) => url).sort()).toEqual(['https://api.test/person/I3', 'https://api.test/person/I4']);
  });

  it('does not prefetch a person whose view is already being loaded', async () => {
    let resolveI5;
    const fetchMock = vi.fn((url) => url.endsWith('/I5')
      ? new Promise(resolve => { resolveI5 = () => resolve(ok(view('I5'))); })
      : Promise.resolve(ok(view(url.split('/').pop()))));
    vi.stubGlobal('fetch', fetchMock);
    const pending = loadPersonWithFamily('I5');
    prefetchFamily({ family: [{ id: 'I5' }] });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolveI5();
    await pending;
  });
});

describe('media urls', () => {
  beforeEach(() => vi.stubEnv('VITE_MEDIA_BASE_URL', 'https://media.test/bucket'));
  afterEach(() => vi.unstubAllEnvs());

  it('builds encoded media and thumbnail urls', () => {
    expect(mediaUrl('originals/a b.jpg')).toBe('https://media.test/bucket/originals/a%20b.jpg');
    expect(mediaUrl(null)).toBeNull();
    expect(thumbUrl({ thumbKey: 'thumbs/x.webp' })).toBe('https://media.test/bucket/thumbs/x.webp');
    expect(thumbUrl({ thumbKey: null })).toBeNull();
  });

  it('fails loudly when VITE_MEDIA_BASE_URL is not configured', () => {
    vi.stubEnv('VITE_MEDIA_BASE_URL', '');
    expect(() => mediaUrl('originals/a.jpg')).toThrow('VITE_MEDIA_BASE_URL is not configured');
    expect(mediaUrl(null)).toBeNull();
  });
});
