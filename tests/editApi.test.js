import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/auth.js', () => ({
  getToken: vi.fn(async () => 'default-token'),
  setRole: vi.fn()
}));

const { createEditApi, ApiError, apiUrl } = await import('../src/editApi.js');
const editApi = await import('../src/editApi.js');
const auth = await import('../src/auth.js');

const respond = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: body === undefined ? async () => { throw new SyntaxError('Unexpected end of JSON input'); } : async () => body
});

describe('editApi', () => {
  let fetchMock;
  let getToken;
  let setRole;
  let api;

  beforeEach(() => {
    vi.stubEnv('VITE_API_URL', 'https://api.test');
    fetchMock = vi.fn(async () => respond(200, {}));
    vi.stubGlobal('fetch', fetchMock);
    getToken = vi.fn(async () => 'jwt-1');
    setRole = vi.fn();
    api = createEditApi({ getToken, setRole });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  const call = (n = 0) => {
    const [url, init] = fetchMock.mock.calls[n];
    return { url, method: init.method, headers: init.headers, body: init.body === undefined ? undefined : JSON.parse(init.body), signal: init.signal };
  };

  describe('authedFetch', () => {
    it('sends the bearer token, JSON body and a timeout, and returns the parsed body', async () => {
      fetchMock.mockResolvedValue(respond(200, { change: { id: 7, summary: 'Edited Rose', personIds: ['I1'] }, view: { person: { id: 'I1' } } }));
      const result = await api.runChange('update_person', { id: 'I1', fields: { surname: 'Smith' } });
      expect(result.change.id).toBe(7);
      expect(result.view.person.id).toBe('I1');
      expect(call()).toEqual({
        url: 'https://api.test/changes',
        method: 'POST',
        headers: { authorization: 'Bearer jwt-1', 'content-type': 'application/json' },
        body: { kind: 'update_person', params: { id: 'I1', fields: { surname: 'Smith' } } },
        signal: expect.any(AbortSignal)
      });
    });

    it('fails with 401 unauthenticated, without a request, when an editor call has no token', async () => {
      getToken.mockResolvedValue(null);
      const error = await api.undo().catch(e => e);
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ status: 401, code: 'unauthenticated' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('retries a rejected token once with a forced refresh', async () => {
      getToken.mockImplementation(async ({ force } = {}) => (force ? 'jwt-2' : 'jwt-1'));
      fetchMock
        .mockResolvedValueOnce(respond(401, { error: 'unauthenticated' }))
        .mockResolvedValueOnce(respond(200, { change: null }));
      await expect(api.undo()).resolves.toBeNull();
      expect(getToken).toHaveBeenLastCalledWith({ force: true });
      expect(call(1).headers.authorization).toBe('Bearer jwt-2');
    });

    it('gives up after the refreshed token is rejected too', async () => {
      fetchMock.mockResolvedValue(respond(401, { error: 'unauthenticated' }));
      await expect(api.undo()).rejects.toMatchObject({ status: 401, code: 'unauthenticated' });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('does not retry when the refresh finds the session gone', async () => {
      getToken.mockImplementation(async ({ force } = {}) => (force ? null : 'jwt-1'));
      fetchMock.mockResolvedValue(respond(401, { error: 'unauthenticated' }));
      await expect(api.undo()).rejects.toMatchObject({ status: 401, code: 'unauthenticated' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('maps a 409 conflict to reason and blocking changes', async () => {
      const blocking = [{ id: 12, action: 'undo', summary: 'Edited Rose (birth date)', authorName: 'Ann', createdAt: '2026-10-09T10:00:00Z' }];
      fetchMock.mockResolvedValue(respond(409, { error: 'conflict', reason: 'conflict', blocking }));
      const error = await api.revert(10).catch(e => e);
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({ status: 409, code: 'conflict', reason: 'conflict', blocking, field: null });
    });

    it('maps a 400 validation error to its field and message', async () => {
      fetchMock.mockResolvedValue(respond(400, { error: 'invalid', field: 'sex', message: 'sex must be M, F, U or empty.' }));
      const error = await api.runChange('update_person', {}).catch(e => e);
      expect(error).toMatchObject({ status: 400, code: 'invalid', field: 'sex', message: 'sex must be M, F, U or empty.', reason: null, blocking: [] });
    });

    it('keeps the rest of the error body, such as the email of a non-editor', async () => {
      fetchMock.mockResolvedValue(respond(409, { error: 'already_an_editor', email: 'ann@example.com' }));
      const error = await api.addEditor({ email: 'ann@example.com' }).catch(e => e);
      expect(error).toMatchObject({ status: 409, code: 'already_an_editor', message: 'already_an_editor' });
      expect(error.body.email).toBe('ann@example.com');
    });

    it('names an error without a JSON body by its status', async () => {
      fetchMock.mockResolvedValue(respond(502));
      await expect(api.undo()).rejects.toMatchObject({ status: 502, code: 'http_502' });
    });

    it('maps a network failure or timeout to status 0, code network', async () => {
      fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
      await expect(api.undo()).rejects.toMatchObject({ status: 0, code: 'network' });
      fetchMock.mockRejectedValue(new DOMException('The operation timed out.', 'TimeoutError'));
      await expect(api.undo()).rejects.toMatchObject({ status: 0, code: 'network' });
    });

    it('maps a token refresh that cannot reach the auth service to a network error', async () => {
      getToken.mockRejectedValue(Object.assign(new Error("Couldn't reach the sign-in service."), { code: 'network' }));
      await expect(api.undo()).rejects.toMatchObject({ status: 0, code: 'network' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('fails loudly when VITE_API_URL is not configured', async () => {
      vi.stubEnv('VITE_API_URL', '');
      await expect(api.undo()).rejects.toThrow('VITE_API_URL is not configured');
      expect(() => apiUrl('/me')).toThrow('VITE_API_URL is not configured');
    });
  });

  describe('changes', () => {
    it('reverts from History by default, or from the keyboard toast, and returns the change', async () => {
      fetchMock.mockResolvedValue(respond(200, { change: { id: 21, summary: 'Undid: Edited Rose', personIds: ['I1'] } }));
      expect(await api.revert(20)).toEqual({ id: 21, summary: 'Undid: Edited Rose', personIds: ['I1'] });
      expect(call(0)).toMatchObject({ url: 'https://api.test/changes/20/revert', method: 'POST', body: { via: 'history' } });
      await api.revert(20, 'keyboard');
      expect(call(1).body).toEqual({ via: 'keyboard' });
    });

    it('restores a change', async () => {
      fetchMock.mockResolvedValue(respond(200, { change: { id: 22, summary: 'Redid: Edited Rose', personIds: ['I1'] } }));
      expect((await api.restore(20)).id).toBe(22);
      expect(call()).toMatchObject({ url: 'https://api.test/changes/20/restore', method: 'POST', body: undefined });
      expect(call().headers).toEqual({ authorization: 'Bearer jwt-1' });
    });

    it('undoes and redoes, returning null when there is nothing to do', async () => {
      fetchMock.mockResolvedValueOnce(respond(200, { change: { id: 5 } })).mockResolvedValueOnce(respond(200, { change: null }));
      expect(await api.undo()).toEqual({ id: 5 });
      expect(await api.redo()).toBeNull();
      expect([call(0).url, call(1).url]).toEqual(['https://api.test/undo', 'https://api.test/redo']);
      expect(call(0).method).toBe('POST');
    });

    it('lists changes with only the filters given', async () => {
      const changes = [{ id: 3, summary: 'Added Jack' }];
      fetchMock.mockResolvedValue(respond(200, { changes }));
      expect(await api.listChanges()).toEqual(changes);
      expect(call(0)).toMatchObject({ url: 'https://api.test/changes', method: 'GET', headers: { authorization: 'Bearer jwt-1' } });
      await api.listChanges({ before: 40, limit: 10, person: 'I1' });
      expect(call(1).url).toBe('https://api.test/changes?before=40&limit=10&person=I1');
      await api.listChanges({ before: null, person: 'I2' });
      expect(call(2).url).toBe('https://api.test/changes?person=I2');
    });
  });

  describe('search', () => {
    it('searches by name, with the token when signed in', async () => {
      const results = [{ id: 'I1', name: 'Rose Smith', birthYear: 1901, deathYear: null }];
      fetchMock.mockResolvedValue(respond(200, { results }));
      expect(await api.search(' Rose & co ')).toEqual(results);
      expect(call()).toMatchObject({ url: 'https://api.test/search?q=Rose+%26+co', method: 'GET', headers: { authorization: 'Bearer jwt-1' } });
      await api.search('ro', { limit: 5 });
      expect(call(1).url).toBe('https://api.test/search?q=ro&limit=5');
    });

    it('searches without a token when signed out', async () => {
      getToken.mockResolvedValue(null);
      fetchMock.mockResolvedValue(respond(200, { results: [] }));
      await api.search('rose');
      expect(call().headers).toEqual({});
    });

    it('does not ask the server about fewer than 2 characters', async () => {
      expect(await api.search(' r ')).toEqual([]);
      expect(await api.search('')).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('me', () => {
    it('returns the account and caches the role for the user', async () => {
      fetchMock.mockResolvedValue(respond(200, { email: 'rose@example.com', name: 'Rose', role: 'admin' }));
      expect(await api.me()).toEqual({ email: 'rose@example.com', name: 'Rose', role: 'admin' });
      expect(call()).toMatchObject({ url: 'https://api.test/me', method: 'GET' });
      expect(setRole).toHaveBeenCalledWith('admin', 'rose@example.com');
    });

    it('returns a null role for a signed-in non-editor', async () => {
      fetchMock.mockResolvedValue(respond(403, { error: 'not_an_editor', email: 'tom@example.com' }));
      expect(await api.me()).toEqual({ email: 'tom@example.com', name: null, role: null });
      expect(setRole).toHaveBeenCalledWith(null, 'tom@example.com');
    });

    it('drops the role and rethrows when signed out', async () => {
      getToken.mockResolvedValue(null);
      await expect(api.me()).rejects.toMatchObject({ status: 401, code: 'unauthenticated' });
      expect(setRole).toHaveBeenCalledWith(null);
    });

    it('keeps the role through a network failure', async () => {
      fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
      await expect(api.me()).rejects.toMatchObject({ code: 'network' });
      expect(setRole).not.toHaveBeenCalled();
    });
  });

  describe('editors', () => {
    it('lists, adds and removes editors', async () => {
      fetchMock
        .mockResolvedValueOnce(respond(200, { editors: [{ email: 'rose@example.com', role: 'admin' }] }))
        .mockResolvedValueOnce(respond(201, { editor: { email: 'ann@example.com', name: 'Ann', role: 'editor' } }))
        .mockResolvedValueOnce(respond(200, { ok: true }));
      expect(await api.listEditors()).toEqual([{ email: 'rose@example.com', role: 'admin' }]);
      expect(await api.addEditor({ email: 'ann@example.com', name: 'Ann', role: 'editor' })).toEqual({ email: 'ann@example.com', name: 'Ann', role: 'editor' });
      await api.removeEditor('ann+family@example.com');
      expect(call(0)).toMatchObject({ url: 'https://api.test/editors', method: 'GET' });
      expect(call(1)).toMatchObject({ url: 'https://api.test/editors', method: 'POST', body: { email: 'ann@example.com', name: 'Ann', role: 'editor' } });
      expect(call(2)).toMatchObject({ url: 'https://api.test/editors/ann%2Bfamily%40example.com', method: 'DELETE', body: undefined });
    });
  });
});

describe('editApi default client', () => {
  beforeEach(() => vi.stubEnv('VITE_API_URL', 'https://api.test'));
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('uses the signed-in token and caches the role in auth', async () => {
    const fetchMock = vi.fn(async () => respond(200, { email: 'rose@example.com', name: 'Rose', role: 'editor' }));
    vi.stubGlobal('fetch', fetchMock);
    await editApi.me();
    expect(fetchMock.mock.calls[0][1].headers.authorization).toBe('Bearer default-token');
    expect(auth.setRole).toHaveBeenCalledWith('editor', 'rose@example.com');
  });
});
