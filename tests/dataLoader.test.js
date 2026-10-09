import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadPersonWithFamily, prefetchFamily, invalidateAll, cacheView, reload, PersonNotFoundError, resetDataLoaderForTests } from '../src/dataLoader.js';
import { mediaUrl, thumbUrl } from '../src/media.js';
import { getRole, getToken } from '../src/auth.js';

vi.mock('../src/auth.js', () => ({
  getRole: vi.fn(() => null),
  getToken: vi.fn(async () => null),
  setRole: vi.fn()
}));

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
    getRole.mockReturnValue(null);
    getToken.mockResolvedValue(null);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.useRealTimers();
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

  it('says whether the view was masked', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(ok({ ...view('I1'), masked: true }))
      .mockResolvedValueOnce(ok({ ...view('I2'), masked: false }))
      .mockResolvedValueOnce(ok(view('I3'))));
    expect((await loadPersonWithFamily('I1')).masked).toBe(true);
    expect((await loadPersonWithFamily('I2')).masked).toBe(false);
    expect((await loadPersonWithFamily('I3')).masked).toBeUndefined();
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

describe('dataLoader signed in', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_API_URL', 'https://api.test');
    resetDataLoaderForTests();
    vi.stubGlobal('requestIdleCallback', (cb) => cb());
    vi.clearAllMocks();
    getRole.mockReturnValue(null);
    getToken.mockResolvedValue('jwt-1');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('sends the bearer token when the cached role is editor or admin', async () => {
    const fetchMock = vi.fn(async (url) => ok(view(url.split('/').pop())));
    vi.stubGlobal('fetch', fetchMock);
    getRole.mockReturnValue('editor');
    await loadPersonWithFamily('I1');
    getRole.mockReturnValue('admin');
    await loadPersonWithFamily('I2');
    expect(fetchMock.mock.calls.map(([, init]) => init.headers)).toEqual([
      { authorization: 'Bearer jwt-1' },
      { authorization: 'Bearer jwt-1' }
    ]);
  });

  it('sends no token, so the request stays simple (no CORS preflight), for viewers and non-editors', async () => {
    const fetchMock = vi.fn(async () => ok(view('I1')));
    vi.stubGlobal('fetch', fetchMock);
    await loadPersonWithFamily('I1');
    expect(fetchMock.mock.calls[0][1].headers).toBeUndefined();
    expect(getToken).not.toHaveBeenCalled();
  });

  const rejected = () => ({ ok: false, status: 401, json: async () => ({ error: 'unauthenticated' }) });
  const masked = (id, isMasked) => ({ ...view(id), masked: isMasked });

  it('retries a rejected token once with a freshly fetched one', async () => {
    getRole.mockReturnValue('editor');
    getToken.mockImplementation(async ({ force } = {}) => (force ? 'jwt-2' : 'jwt-1'));
    const fetchMock = vi.fn().mockResolvedValueOnce(rejected()).mockResolvedValueOnce(ok(masked('I1', false)));
    vi.stubGlobal('fetch', fetchMock);
    expect((await loadPersonWithFamily('I1')).person.id).toBe('I1');
    expect(getToken).toHaveBeenLastCalledWith({ force: true });
    expect(fetchMock.mock.calls.map(([, init]) => init.headers)).toEqual([
      { authorization: 'Bearer jwt-1' },
      { authorization: 'Bearer jwt-2' }
    ]);
  });

  it('falls back to the public view when the fresh token is rejected too', async () => {
    getRole.mockReturnValue('editor');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(rejected())
      .mockResolvedValueOnce(rejected())
      .mockResolvedValueOnce(ok(masked('I1', true)));
    vi.stubGlobal('fetch', fetchMock);
    const result = await loadPersonWithFamily('I1');
    expect(result.person.id).toBe('I1');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2][1].headers).toBeUndefined();
  });

  it('falls back to the public view straight away when no fresh token can be had', async () => {
    getRole.mockReturnValue('editor');
    getToken.mockImplementation(async ({ force } = {}) => (force ? null : 'jwt-1'));
    const fetchMock = vi.fn().mockResolvedValueOnce(rejected()).mockResolvedValueOnce(ok(masked('I1', true)));
    vi.stubGlobal('fetch', fetchMock);
    await loadPersonWithFamily('I1');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1].headers).toBeUndefined();
  });

  const unavailable = () => ({ ok: false, status: 503, json: async () => ({}) });

  it('falls back to the public view when the editor request gets a 5xx twice', async () => {
    getRole.mockReturnValue('editor');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(unavailable())
      .mockResolvedValueOnce(unavailable())
      .mockResolvedValueOnce(ok(masked('I1', true)));
    vi.stubGlobal('fetch', fetchMock);
    const result = await loadPersonWithFamily('I1');
    expect(result.person.id).toBe('I1');
    expect(result.masked).toBe(true);
    expect(fetchMock.mock.calls.map(([, init]) => init.headers)).toEqual([
      { authorization: 'Bearer jwt-1' },
      { authorization: 'Bearer jwt-1' },
      undefined
    ]);
  });

  it('falls back to the public view when the editor request fails on the network twice', async () => {
    getRole.mockReturnValue('admin');
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(ok(masked('I1', true)));
    vi.stubGlobal('fetch', fetchMock);
    expect((await loadPersonWithFamily('I1')).masked).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2][1].headers).toBeUndefined();
  });

  it('does not fall back while the editor request succeeds on its retry', async () => {
    getRole.mockReturnValue('editor');
    const fetchMock = vi.fn().mockResolvedValueOnce(unavailable()).mockResolvedValueOnce(ok(masked('I1', false)));
    vi.stubGlobal('fetch', fetchMock);
    expect((await loadPersonWithFamily('I1')).masked).toBe(false);
    expect(fetchMock.mock.calls.map(([, init]) => init.headers)).toEqual([
      { authorization: 'Bearer jwt-1' },
      { authorization: 'Bearer jwt-1' }
    ]);
  });

  it('tries the public fallback once, then fails with its error', async () => {
    getRole.mockReturnValue('editor');
    const fetchMock = vi.fn().mockResolvedValue(unavailable());
    vi.stubGlobal('fetch', fetchMock);
    await expect(loadPersonWithFamily('I1')).rejects.toThrow('HTTP 503');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2][1].headers).toBeUndefined();

    resetDataLoaderForTests();
    const offline = vi.fn().mockRejectedValue(new TypeError('offline'));
    vi.stubGlobal('fetch', offline);
    await expect(loadPersonWithFamily('I1')).rejects.toThrow('offline');
    expect(offline).toHaveBeenCalledTimes(3);
  });

  it('does not serve a view loaded by the 5xx fallback to an editor from the cache', async () => {
    getRole.mockReturnValue('editor');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(unavailable())
      .mockResolvedValueOnce(unavailable())
      .mockResolvedValueOnce(ok(masked('I1', true)))
      .mockResolvedValueOnce(ok(masked('I1', false)));
    vi.stubGlobal('fetch', fetchMock);
    expect((await loadPersonWithFamily('I1')).masked).toBe(true);
    expect((await loadPersonWithFamily('I1')).masked).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[3][1].headers).toEqual({ authorization: 'Bearer jwt-1' });
  });

  it('does not use the public fallback for anyone who sent no token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(unavailable());
    vi.stubGlobal('fetch', fetchMock);
    await expect(loadPersonWithFamily('I1')).rejects.toThrow('HTTP 503');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not serve the fallback (masked) view to an editor from the cache', async () => {
    getRole.mockReturnValue('editor');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(rejected())
      .mockResolvedValueOnce(rejected())
      .mockResolvedValueOnce(ok(masked('I1', true)))
      .mockResolvedValueOnce(ok(masked('I1', false)));
    vi.stubGlobal('fetch', fetchMock);
    expect((await loadPersonWithFamily('I1')).person).toBeTruthy();
    await loadPersonWithFamily('I1');
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[3][1].headers).toEqual({ authorization: 'Bearer jwt-1' });
    await loadPersonWithFamily('I1');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('treats cached views as stale when the role changes, both ways', async () => {
    const fetchMock = vi.fn(async (url, init) => ok(masked('I1', !init.headers)));
    vi.stubGlobal('fetch', fetchMock);
    await loadPersonWithFamily('I1');
    await loadPersonWithFamily('I1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    getRole.mockReturnValue('editor'); // signed in as an editor: the masked view won't do
    await loadPersonWithFamily('I1');
    await loadPersonWithFamily('I1');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1].headers).toEqual({ authorization: 'Bearer jwt-1' });
    getRole.mockReturnValue(null); // signed out: the unmasked view must not be shown
    await loadPersonWithFamily('I1');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2][1].headers).toBeUndefined();
  });

  it('keeps a view that does not say whether it is masked (an older API) for anyone', async () => {
    const fetchMock = vi.fn(async () => ok(view('I1')));
    vi.stubGlobal('fetch', fetchMock);
    await loadPersonWithFamily('I1');
    getRole.mockReturnValue('editor');
    await loadPersonWithFamily('I1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not join a public request already in flight once the viewer is an editor', async () => {
    const resolvers = [];
    const fetchMock = vi.fn(() => new Promise(resolve => resolvers.push(resolve)));
    vi.stubGlobal('fetch', fetchMock);
    const anonymous = loadPersonWithFamily('I1');
    await flush();
    getRole.mockReturnValue('editor');
    const asEditor = loadPersonWithFamily('I1');
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1].headers).toEqual({ authorization: 'Bearer jwt-1' });
    resolvers[0](ok({ ...masked('I1', true), person: { ...view('I1').person, name: 'masked' } }));
    resolvers[1](ok({ ...masked('I1', false), person: { ...view('I1').person, name: 'unmasked' } }));
    expect((await asEditor).person.name).toBe('unmasked');
    await anonymous;
  });

  it('loads the public view when the token cannot be fetched', async () => {
    getRole.mockReturnValue('editor');
    getToken.mockRejectedValue(new Error("Couldn't reach the sign-in service."));
    const fetchMock = vi.fn(async () => ok(view('I1')));
    vi.stubGlobal('fetch', fetchMock);
    await expect(loadPersonWithFamily('I1')).resolves.toBeTruthy();
    expect(fetchMock.mock.calls[0][1].headers).toBeUndefined();
  });
});

describe('dataLoader invalidation and expiry', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_API_URL', 'https://api.test');
    resetDataLoaderForTests();
    vi.stubGlobal('requestIdleCallback', (cb) => cb());
    getRole.mockReturnValue(null);
    getToken.mockResolvedValue(null);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const named = (id, name) => ({ ...view(id), person: { ...view(id).person, name } });

  it('clears cached views', async () => {
    const fetchMock = vi.fn(async () => ok(view('I1')));
    vi.stubGlobal('fetch', fetchMock);
    await loadPersonWithFamily('I1');
    invalidateAll();
    await loadPersonWithFamily('I1');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('discards a response that was in flight when it was called, and loads again', async () => {
    const resolvers = [];
    const fetchMock = vi.fn(() => new Promise(resolve => resolvers.push(resolve)));
    vi.stubGlobal('fetch', fetchMock);
    const pending = loadPersonWithFamily('I1');
    await flush();
    invalidateAll();
    resolvers[0](ok(named('I1', 'Before the edit')));
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    resolvers[1](ok(named('I1', 'After the edit')));
    expect((await pending).person.name).toBe('After the edit');
    // Only the fresh view was cached.
    expect((await loadPersonWithFamily('I1')).person.name).toBe('After the edit');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('starts a new request for a load made after it, instead of joining the old one', async () => {
    const resolvers = [];
    const fetchMock = vi.fn(() => new Promise(resolve => resolvers.push(resolve)));
    vi.stubGlobal('fetch', fetchMock);
    const before = loadPersonWithFamily('I1');
    await flush();
    invalidateAll();
    const after = loadPersonWithFamily('I1');
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    resolvers[1](ok(named('I1', 'After the edit')));
    resolvers[0](ok(named('I1', 'Before the edit')));
    expect((await after).person.name).toBe('After the edit');
    expect((await before).person.name).toBe('After the edit');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries a failure that was in flight when it was called', async () => {
    const resolvers = [];
    const fetchMock = vi.fn(() => new Promise(resolve => resolvers.push(resolve)));
    vi.stubGlobal('fetch', fetchMock);
    const pending = loadPersonWithFamily('I1');
    await flush();
    invalidateAll();
    resolvers[0]({ ok: false, status: 404, json: async () => ({ error: 'not_found' }) });
    await flush();
    resolvers[1](ok(view('I1')));
    await expect(pending).resolves.toBeTruthy();
  });

  it('forgets prefetched relatives, and stops a prefetch queued before it', async () => {
    const idle = [];
    vi.stubGlobal('requestIdleCallback', (cb) => idle.push(cb));
    const fetchMock = vi.fn(async (url) => ok(view(url.split('/').pop())));
    vi.stubGlobal('fetch', fetchMock);
    prefetchFamily({ family: [{ id: 'I2' }, { id: 'I3' }] });
    invalidateAll();
    idle.shift()();
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    prefetchFamily({ family: [{ id: 'I2' }, { id: 'I3' }] });
    idle.shift()();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('expires cached views after 5 minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-09T12:00:00Z'));
    const fetchMock = vi.fn(async () => ok(view('I1')));
    vi.stubGlobal('fetch', fetchMock);
    await loadPersonWithFamily('I1');
    vi.setSystemTime(new Date('2026-10-09T12:04:59Z'));
    await loadPersonWithFamily('I1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date('2026-10-09T12:05:01Z'));
    await loadPersonWithFamily('I1');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('prefetches an expired relative again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-09T12:00:00Z'));
    const fetchMock = vi.fn(async (url) => ok(view(url.split('/').pop())));
    vi.stubGlobal('fetch', fetchMock);
    prefetchFamily({ family: [{ id: 'I2' }] });
    await flush();
    vi.setSystemTime(new Date('2026-10-09T12:04:00Z'));
    prefetchFamily({ family: [{ id: 'I2' }] });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date('2026-10-09T12:06:00Z'));
    prefetchFamily({ family: [{ id: 'I2' }] });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reloads one person afresh, leaving the rest of the cache alone', async () => {
    let version = 0;
    const fetchMock = vi.fn(async (url) => ok(named(url.split('/').pop(), `v${++version}`)));
    vi.stubGlobal('fetch', fetchMock);
    await loadPersonWithFamily('I1');
    await loadPersonWithFamily('I2');
    const result = await reload('I1');
    expect(result.person.name).toBe('v3');
    expect(result.relationships).toBeTruthy();
    expect((await loadPersonWithFamily('I1')).person.name).toBe('v3');
    expect((await loadPersonWithFamily('I2')).person.name).toBe('v2');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('reload discards a request for that person already in flight', async () => {
    const resolvers = [];
    const fetchMock = vi.fn(() => new Promise(resolve => resolvers.push(resolve)));
    vi.stubGlobal('fetch', fetchMock);
    const before = loadPersonWithFamily('I1');
    await flush();
    const reloaded = reload('I1');
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    resolvers[1](ok(named('I1', 'After the edit')));
    resolvers[0](ok(named('I1', 'Before the edit')));
    expect((await reloaded).person.name).toBe('After the edit');
    expect((await before).person.name).toBe('After the edit');
    expect((await loadPersonWithFamily('I1')).person.name).toBe('After the edit');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('ignores cacheView(null), the view after a delete', () => {
    expect(() => cacheView(null)).not.toThrow();
  });

  it('caches a view returned by a command, so showing it needs no request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    invalidateAll();
    cacheView(named('I1', 'Saved'));
    expect((await loadPersonWithFamily('I1')).person.name).toBe('Saved');
    expect(fetchMock).not.toHaveBeenCalled();
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
