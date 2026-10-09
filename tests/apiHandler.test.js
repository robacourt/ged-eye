// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { createHandler, VIEW_VERSION } from '../api/handler.js';
import { ApiError, MAX_BODY_BYTES } from '../api/http.js';
import { AuthError, authenticatorFromEnv } from '../api/auth.js';
import { maskNoteEmails } from '../api/privacy.js';
import { createDb, escapeLike } from '../api/db.js';
import { inTransaction } from '../api/tx.js';

const VIEW = {
  person: { id: 'I1', notes: ['Write to jo@example.org'] },
  family: [],
  relationships: { parents: [], spouses: [], children: [], siblings: [] }
};
const VERSION = { changeId: '42', migration: '006_editing.sql' };
const ETAG = 'W/"2.006_editing.sql.42.I1"';

const EDITORS = {
  'admin@example.test': { email: 'admin@example.test', name: 'Ada Admin', role: 'admin' },
  'editor@example.test': { email: 'editor@example.test', name: 'Ed Editor', role: 'editor' },
  'noname@example.test': { email: 'noname@example.test', name: null, role: 'editor' }
};
const TOKENS = {
  admin: { email: 'admin@example.test', name: 'Ada', sub: 'u1' },
  editor: { email: 'editor@example.test', name: 'Ed', sub: 'u2' },
  noname: { email: 'noname@example.test', name: 'Token Name', sub: 'u3' },
  viewer: { email: 'viewer@example.test', name: 'Vi', sub: 'u4' }
};
const ADMIN = { email: 'admin@example.test', name: 'Ada Admin', role: 'admin' };
const EDITOR = { email: 'editor@example.test', name: 'Ed Editor', role: 'editor' };
const CHANGE = { id: 7, summary: 'Edited Rose Smith (birth date)', personIds: ['I1'] };

// Stands in for api/auth.js: no header → null, a known token → its user, 'outage' → a JWKS failure,
// anything else → AuthError(401).
async function fakeAuthenticate(request) {
  const header = request.headers.get('authorization');
  if (header === null) return null;
  const token = header.replace(/^Bearer /, '');
  if (token === 'outage') throw new Error('JWKS fetch failed');
  if (!TOKENS[token]) throw new AuthError(401, 'unauthenticated', 'bad token');
  return TOKENS[token];
}

function fakeDb(overrides = {}) {
  return {
    personView: vi.fn(async (id) => ({ view: id === 'I1' ? VIEW : null, version: VERSION })),
    search: vi.fn(async () => [{ id: 'I1', name: 'Ann Lee', birthYear: 1850, deathYear: null }]),
    lookupEditor: vi.fn(async (email) => EDITORS[email] ?? null),
    listEditors: vi.fn(async () => Object.values(EDITORS)),
    addEditor: vi.fn(async (editor, by) => ({ ...editor, addedBy: by, addedAt: '2026-10-09T10:00:00.000Z' })),
    removeEditor: vi.fn(async () => 'removed'),
    runChange: vi.fn(async () => ({ change: CHANGE, view: VIEW })),
    toggle: vi.fn(async () => CHANGE),
    undoLast: vi.fn(async () => CHANGE),
    redoLast: vi.fn(async () => CHANGE),
    listChanges: vi.fn(async () => [{ id: 7 }]),
    ...overrides
  };
}

function setup(overrides) {
  const db = fakeDb(overrides);
  const log = vi.fn();
  const authenticate = vi.fn(fakeAuthenticate);
  const handler = createHandler({ db, authenticate, log });
  const request = (path, { method = 'GET', token, headers = {}, body } = {}) => {
    const init = { method, headers: { ...headers } };
    if (token) init.headers.authorization = `Bearer ${token}`;
    if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
    return handler(new Request(`https://api.test${path}`, init));
  };
  return { db, log, authenticate, handler, request };
}

describe('GET /person/:id', () => {
  it('serves anonymous callers a masked view with revalidation caching and an ETag', async () => {
    const { request, db } = setup();
    const res = await request('/person/I1');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ...maskNoteEmails(VIEW), masked: true });
    expect(db.personView).toHaveBeenCalledWith('I1');
    expect(res.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');
    expect(res.headers.get('vary')).toBe('Authorization');
    expect(res.headers.get('etag')).toBe(ETAG);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('content-type')).toBe('application/json');
  });

  it('builds the ETag from the view version, latest migration, latest change id and person id', async () => {
    expect(VIEW_VERSION).toBe(2);
    const { request } = setup({
      personView: async () => ({ view: VIEW, version: { changeId: '0', migration: '007_next.sql' } })
    });
    const res = await request('/person/I1');
    expect(res.headers.get('etag')).toBe(`W/"${VIEW_VERSION}.007_next.sql.0.I1"`);
  });

  it('masks the view for a signed-in caller who is not an editor', async () => {
    const { request, db } = setup();
    const res = await request('/person/I1', { token: 'viewer' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.masked).toBe(true);
    expect(body.person.notes).toEqual(['Write to [email hidden]']);
    expect(res.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');
    expect(res.headers.get('etag')).toBe(ETAG);
    expect(db.lookupEditor).toHaveBeenCalledWith('viewer@example.test');
  });

  it('serves editors the unmasked view, privately and uncached, without an ETag', async () => {
    const { request } = setup();
    const res = await request('/person/I1', { token: 'editor' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ...VIEW, masked: false });
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('vary')).toBe('Authorization');
    expect(res.headers.get('etag')).toBeNull();
  });

  it('answers a matching If-None-Match with 304 for anonymous callers', async () => {
    const { request } = setup();
    const res = await request('/person/I1', { headers: { 'if-none-match': ETAG } });
    expect(res.status).toBe(304);
    expect(await res.text()).toBe('');
    expect(res.headers.get('etag')).toBe(ETAG);
    expect(res.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');
    expect(res.headers.get('vary')).toBe('Authorization');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('matches If-None-Match lists, strong forms of the tag, and *', async () => {
    const { request } = setup();
    for (const header of [`"other", ${ETAG}`, '"2.006_editing.sql.42.I1"', '*']) {
      expect((await request('/person/I1', { headers: { 'if-none-match': header } })).status).toBe(304);
    }
  });

  it('answers a matching If-None-Match with 304 for signed-in non-editors', async () => {
    const { request } = setup();
    const res = await request('/person/I1', { token: 'viewer', headers: { 'if-none-match': ETAG } });
    expect(res.status).toBe(304);
  });

  it('sends a fresh 200 when If-None-Match is stale', async () => {
    const { request } = setup();
    const res = await request('/person/I1', { headers: { 'if-none-match': 'W/"2.006_editing.sql.41.I1"' } });
    expect(res.status).toBe(200);
    expect((await res.json()).masked).toBe(true);
  });

  it('never answers editors with 304', async () => {
    const { request } = setup();
    const res = await request('/person/I1', { token: 'editor', headers: { 'if-none-match': ETAG } });
    expect(res.status).toBe(200);
    expect((await res.json()).masked).toBe(false);
  });

  it('returns 404 for an unknown person', async () => {
    const { request } = setup();
    const res = await request('/person/I999');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('rejects malformed ids without querying', async () => {
    const { request, db } = setup();
    for (const path of ['/person/' + encodeURIComponent('I1; drop table'), '/person/%E0%A4%A']) {
      const res = await request(path);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'bad_id' });
    }
    expect(db.personView).not.toHaveBeenCalled();
  });

  it('rejects an invalid token with 401 instead of serving an anonymous view', async () => {
    const { request, db } = setup();
    const res = await request('/person/I1', { token: 'expired' });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthenticated' });
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(db.personView).not.toHaveBeenCalled();
  });

  it('checks the token before the id', async () => {
    const { request } = setup();
    expect((await request('/person/' + encodeURIComponent('I1; drop table'), { token: 'expired' })).status).toBe(401);
    expect((await request('/person/%E0%A4%A', { token: 'expired' })).status).toBe(401);
  });

  it('returns 500 and logs when token verification fails for a reason other than the token', async () => {
    const { request, log } = setup();
    const res = await request('/person/I1', { token: 'outage' });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal' });
    expect(log).toHaveBeenCalled();
  });

  it('returns 500 and logs when the query fails', async () => {
    const { request, log } = setup({ personView: vi.fn().mockRejectedValue(new Error('boom')) });
    const res = await request('/person/I1');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal' });
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(log).toHaveBeenCalled();
  });

  it('returns 500 when the editor lookup fails', async () => {
    const { request } = setup({ lookupEditor: vi.fn().mockRejectedValue(new Error('boom')) });
    expect((await request('/person/I1', { token: 'editor' })).status).toBe(500);
  });
});

describe('health, unknown routes and preflight', () => {
  it('answers health checks without authenticating', async () => {
    const { request, authenticate } = setup();
    const res = await request('/health', { token: 'expired' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(authenticate).not.toHaveBeenCalled();
  });

  it('returns 404 for unknown paths and methods', async () => {
    const { request } = setup();
    for (const [path, method] of [['/nope', 'GET'], ['/person/I1', 'POST'], ['/me', 'DELETE'], ['/editors/', 'GET']]) {
      const res = await request(path, { method });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'not_found' });
    }
  });

  it('answers preflight with the CORS policy and a one-day max age', async () => {
    const { request, authenticate } = setup();
    const res = await request('/changes', { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-methods')).toBe('GET, POST, DELETE, OPTIONS');
    expect(res.headers.get('access-control-allow-headers')).toBe('authorization, content-type, if-none-match');
    expect(res.headers.get('access-control-max-age')).toBe('86400');
    expect(authenticate).not.toHaveBeenCalled();
  });

  it('sends CORS headers on errors', async () => {
    const { request } = setup();
    const res = await request('/me', { token: 'expired' });
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-methods')).toBe('GET, POST, DELETE, OPTIONS');
  });
});

describe('GET /search', () => {
  it('returns matches for the trimmed query, 20 at most', async () => {
    const { request, db } = setup();
    const res = await request('/search?q=%20Ann%20');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ results: [{ id: 'I1', name: 'Ann Lee', birthYear: 1850, deathYear: null }] });
    expect(db.search).toHaveBeenCalledWith('Ann', 20);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('accepts a smaller limit and caps a larger one at 20', async () => {
    const { request, db } = setup();
    await request('/search?q=Ann&limit=5');
    expect(db.search).toHaveBeenLastCalledWith('Ann', 5);
    await request('/search?q=Ann&limit=500');
    expect(db.search).toHaveBeenLastCalledWith('Ann', 20);
  });

  it('passes LIKE wildcards through for the database layer to escape', async () => {
    const { request, db } = setup();
    await request('/search?q=' + encodeURIComponent('50%_\\'));
    expect(db.search).toHaveBeenCalledWith('50%_\\', 20);
  });

  it('requires at least 2 characters', async () => {
    const { request, db } = setup();
    for (const q of ['', '?q=', '?q=a', '?q=%20a%20']) {
      const res = await request('/search' + q);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'invalid', field: 'q' });
    }
    expect(db.search).not.toHaveBeenCalled();
  });

  it('rejects an over-long query and a bad limit', async () => {
    const { request, db } = setup();
    expect(await (await request('/search?q=' + 'a'.repeat(101))).json()).toMatchObject({ error: 'invalid', field: 'q' });
    for (const limit of ['0', '-1', '1.5', 'ten']) {
      const res = await request(`/search?q=Ann&limit=${limit}`);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'invalid', field: 'limit' });
    }
    expect(db.search).not.toHaveBeenCalled();
  });

  it('counts characters as code points', async () => {
    const { request, db } = setup();
    const emoji = '\u{1F600}'; // two UTF-16 units
    expect((await request('/search?q=' + encodeURIComponent(emoji))).status).toBe(400);
    expect((await request('/search?q=' + encodeURIComponent(emoji.repeat(2)))).status).toBe(200);
    expect((await request('/search?q=' + encodeURIComponent(emoji.repeat(100)))).status).toBe(200);
    expect((await request('/search?q=' + encodeURIComponent(emoji.repeat(101)))).status).toBe(400);
    expect(db.search).toHaveBeenCalledTimes(2);
  });

  it('rejects an invalid token with 401, before validating the query', async () => {
    const { request, db } = setup();
    for (const query of ['?q=Ann', '?q=a', '?q=Ann&limit=x']) {
      const res = await request('/search' + query, { token: 'expired' });
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toBe('Bearer');
    }
    expect(db.search).not.toHaveBeenCalled();
  });
});

describe('GET /me', () => {
  it('returns 401 when signed out or the token is invalid', async () => {
    const { request } = setup();
    for (const token of [undefined, 'expired']) {
      const res = await request('/me', { token });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'unauthenticated' });
      expect(res.headers.get('www-authenticate')).toBe('Bearer');
    }
  });

  it('returns 403 with the email for a signed-in non-editor', async () => {
    const { request } = setup();
    const res = await request('/me', { token: 'viewer' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'not_an_editor', email: 'viewer@example.test' });
  });

  it('returns the editor, preferring the editor list name over the token name', async () => {
    const { request } = setup();
    const res = await request('/me', { token: 'editor' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(EDITOR);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await (await request('/me', { token: 'noname' })).json())
      .toEqual({ email: 'noname@example.test', name: 'Token Name', role: 'editor' });
  });

  it('returns 500 on a JWKS outage', async () => {
    const { request, log } = setup();
    expect((await request('/me', { token: 'outage' })).status).toBe(500);
    expect(log).toHaveBeenCalled();
  });
});

describe('editors routes', () => {
  const routes = [
    ['/editors', 'GET'],
    ['/editors', 'POST', { email: 'new@example.test' }],
    ['/editors/editor%40example.test', 'DELETE']
  ];

  it('are for admins only', async () => {
    const { request, db } = setup();
    for (const [path, method, body] of routes) {
      expect((await request(path, { method, body })).status).toBe(401);
      const viewer = await request(path, { method, body, token: 'viewer' });
      expect(viewer.status).toBe(403);
      expect(await viewer.json()).toEqual({ error: 'not_an_editor', email: 'viewer@example.test' });
      const editor = await request(path, { method, body, token: 'editor' });
      expect(editor.status).toBe(403);
      expect(await editor.json()).toEqual({ error: 'not_an_admin' });
    }
    expect(db.listEditors).not.toHaveBeenCalled();
    expect(db.addEditor).not.toHaveBeenCalled();
    expect(db.removeEditor).not.toHaveBeenCalled();
  });

  it('lists editors', async () => {
    const { request } = setup();
    const res = await request('/editors', { token: 'admin' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ editors: Object.values(EDITORS) });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('adds an editor, normalising the email and defaulting the role', async () => {
    const { request, db } = setup();
    const res = await request('/editors', { method: 'POST', token: 'admin', body: { email: ' New@Example.TEST ', name: ' Nell ' } });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      editor: { email: 'new@example.test', name: 'Nell', role: 'editor', addedBy: 'admin@example.test', addedAt: '2026-10-09T10:00:00.000Z' }
    });
    expect(db.addEditor).toHaveBeenCalledWith({ email: 'new@example.test', name: 'Nell', role: 'editor' }, 'admin@example.test');
  });

  it('adds an admin with no name', async () => {
    const { request, db } = setup();
    expect((await request('/editors', { method: 'POST', token: 'admin', body: { email: 'a2@example.test', name: '', role: 'admin' } })).status).toBe(201);
    expect(db.addEditor).toHaveBeenCalledWith({ email: 'a2@example.test', name: null, role: 'admin' }, 'admin@example.test');
  });

  it('validates the new editor', async () => {
    const { request, db } = setup();
    const cases = [
      [{}, 'email'],
      [{ email: 'not-an-email' }, 'email'],
      [{ email: 42 }, 'email'],
      [{ email: 'x@example.test', role: 'owner' }, 'role'],
      [{ email: 'x@example.test', name: 7 }, 'name'],
      [{ email: 'x@example.test', name: 'n'.repeat(501) }, 'name'],
      ['[1]', 'body'],
      ['{not json', 'body']
    ];
    for (const [body, field] of cases) {
      const res = await request('/editors', { method: 'POST', token: 'admin', body });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'invalid', field });
    }
    expect(db.addEditor).not.toHaveBeenCalled();
  });

  it('refuses to add someone who is already an editor', async () => {
    const { request } = setup({ addEditor: vi.fn().mockResolvedValue(null) });
    const res = await request('/editors', { method: 'POST', token: 'admin', body: { email: 'editor@example.test' } });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'already_an_editor', email: 'editor@example.test' });
  });

  it('removes an editor', async () => {
    const { request, db } = setup();
    const res = await request('/editors/' + encodeURIComponent('Editor@Example.test'), { method: 'DELETE', token: 'admin' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(db.removeEditor).toHaveBeenCalledWith('editor@example.test', 'admin@example.test');
  });

  it('does not let an admin remove themselves', async () => {
    const { request, db } = setup();
    const res = await request('/editors/' + encodeURIComponent('ADMIN@example.test'), { method: 'DELETE', token: 'admin' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'cannot_remove_self' });
    expect(db.removeEditor).not.toHaveBeenCalled();
  });

  it('maps the database refusals: last admin, unknown editor, no longer an admin', async () => {
    const cases = [['last_admin', 409, 'last_admin'], ['not_found', 404, 'not_found'], ['not_an_admin', 403, 'not_an_admin']];
    for (const [outcome, status, error] of cases) {
      const { request } = setup({ removeEditor: vi.fn().mockResolvedValue(outcome) });
      const res = await request('/editors/other-admin%40example.test', { method: 'DELETE', token: 'admin' });
      expect(res.status).toBe(status);
      expect(await res.json()).toMatchObject({ error });
    }
  });

  it('rejects a malformed email in the path', async () => {
    const { request, db } = setup();
    const res = await request('/editors/%E0%A4%A', { method: 'DELETE', token: 'admin' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid', field: 'email' });
    expect(db.removeEditor).not.toHaveBeenCalled();
  });
});

describe('request body limit', () => {
  it('returns 413 for a body over 1 MB', async () => {
    const { request, db } = setup();
    const body = JSON.stringify({ kind: 'update_person', params: { text: 'x'.repeat(MAX_BODY_BYTES) } });
    const res = await request('/changes', { method: 'POST', token: 'editor', body });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'too_large' });
    expect(db.runChange).not.toHaveBeenCalled();
  });

  it('returns 413 from the declared Content-Length without reading the body', async () => {
    const { request, db } = setup();
    const res = await request('/editors', {
      method: 'POST', token: 'admin', body: '{}', headers: { 'content-length': String(MAX_BODY_BYTES + 1) }
    });
    expect(res.status).toBe(413);
    expect(db.addEditor).not.toHaveBeenCalled();
  });

  it('accepts a body of exactly 1 MB', async () => {
    const { request, db } = setup();
    const prefix = '{"kind":"update_person","params":{"text":"';
    const suffix = '"}}';
    const body = prefix + 'x'.repeat(MAX_BODY_BYTES - prefix.length - suffix.length) + suffix;
    expect((await request('/changes', { method: 'POST', token: 'editor', body })).status).toBe(200);
    expect(db.runChange).toHaveBeenCalled();
  });
});

describe('write routes', () => {
  const routes = [
    ['/changes', 'POST', { kind: 'update_person', params: {} }],
    ['/changes', 'GET'],
    ['/changes/7/revert', 'POST'],
    ['/changes/7/restore', 'POST'],
    ['/undo', 'POST'],
    ['/redo', 'POST']
  ];

  it('require an editor', async () => {
    const { request, db } = setup();
    for (const [path, method, body] of routes) {
      for (const token of [undefined, 'expired']) {
        const res = await request(path, { method, body, token });
        expect(res.status).toBe(401);
        expect(res.headers.get('www-authenticate')).toBe('Bearer');
      }
      const res = await request(path, { method, body, token: 'viewer' });
      expect(res.status).toBe(403);
      expect(res.headers.get('www-authenticate')).toBeNull();
      expect(await res.json()).toEqual({ error: 'not_an_editor', email: 'viewer@example.test' });
    }
    for (const fn of ['runChange', 'listChanges', 'toggle', 'undoLast', 'redoLast']) expect(db[fn]).not.toHaveBeenCalled();
  });

  it('POST /changes runs the command as the editor and returns the change and unmasked view', async () => {
    const { request, db } = setup();
    const params = { id: 'I1', expectedUpdatedAt: '2026-10-09T10:00:00.000000Z', fields: { birth_date: '1850' } };
    const res = await request('/changes', { method: 'POST', token: 'editor', body: { kind: 'update_person', params } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ change: CHANGE, view: { ...VIEW, masked: false } });
    expect(db.runChange).toHaveBeenCalledWith(EDITOR, 'update_person', params);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('POST /changes returns a null view when the command has no focus person', async () => {
    const { request } = setup({ runChange: vi.fn().mockResolvedValue({ change: CHANGE, view: null }) });
    const res = await request('/changes', { method: 'POST', token: 'editor', body: { kind: 'delete_person', params: { id: 'I1' } } });
    expect(await res.json()).toEqual({ change: CHANGE, view: null });
  });

  it('POST /changes validates the envelope', async () => {
    const { request, db } = setup();
    const cases = [
      [{ params: {} }, 'kind'],
      [{ kind: '', params: {} }, 'kind'],
      [{ kind: 3, params: {} }, 'kind'],
      [{ kind: 'update_person' }, 'params'],
      [{ kind: 'update_person', params: [] }, 'params'],
      [{ kind: 'update_person', params: 'x' }, 'params'],
      ['', 'kind'],
      ['nope', 'body']
    ];
    for (const [body, field] of cases) {
      const res = await request('/changes', { method: 'POST', token: 'editor', body });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'invalid', field });
    }
    expect(db.runChange).not.toHaveBeenCalled();
  });

  it('maps ApiErrors from the database layer to their status and body', async () => {
    const cases = [
      [new ApiError(400, 'invalid', { field: 'sex', message: 'sex must be M, F, U or empty' }), 400, { error: 'invalid', field: 'sex', message: 'sex must be M, F, U or empty' }],
      [new ApiError(400, 'no_change'), 400, { error: 'no_change' }],
      [new ApiError(404, 'not_found'), 404, { error: 'not_found' }],
      [new ApiError(409, 'stale'), 409, { error: 'stale' }],
      [new ApiError(501, 'not_implemented'), 501, { error: 'not_implemented' }]
    ];
    for (const [error, status, body] of cases) {
      const { request } = setup({ runChange: vi.fn().mockRejectedValue(error) });
      const res = await request('/changes', { method: 'POST', token: 'editor', body: { kind: 'update_person', params: {} } });
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual(body);
    }
  });

  it('does not log deliberate ApiErrors', async () => {
    const { request, log } = setup({ runChange: vi.fn().mockRejectedValue(new ApiError(501, 'not_implemented')) });
    expect((await request('/changes', { method: 'POST', token: 'editor', body: { kind: 'update_person', params: {} } })).status).toBe(501);
    expect(log).not.toHaveBeenCalled();
  });

  it('returns 500 and logs unexpected database errors', async () => {
    const { request, log } = setup({ runChange: vi.fn().mockRejectedValue(new Error('connection reset')) });
    const res = await request('/changes', { method: 'POST', token: 'editor', body: { kind: 'update_person', params: {} } });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal' });
    expect(log).toHaveBeenCalled();
  });

  it('POST /changes/:id/revert and /restore toggle the change, from History by default', async () => {
    const { request, db } = setup();
    const revert = await request('/changes/7/revert', { method: 'POST', token: 'editor' });
    expect(revert.status).toBe(200);
    expect(await revert.json()).toEqual({ change: CHANGE });
    expect(db.toggle).toHaveBeenLastCalledWith(EDITOR, 7, 'undo', 'history');
    await request('/changes/7/restore', { method: 'POST', token: 'editor', body: {} });
    expect(db.toggle).toHaveBeenLastCalledWith(EDITOR, 7, 'redo', 'history');
    await request('/changes/12/revert', { method: 'POST', token: 'editor', body: { via: 'keyboard' } });
    expect(db.toggle).toHaveBeenLastCalledWith(EDITOR, 12, 'undo', 'keyboard');
  });

  it('POST /changes/:id/revert validates the id and via', async () => {
    const { request, db } = setup();
    for (const [path, body, field] of [
      ['/changes/abc/revert', undefined, 'id'],
      ['/changes/0/revert', undefined, 'id'],
      ['/changes/1e3/revert', undefined, 'id'],
      ['/changes/7/revert', { via: 'script' }, 'via'],
      ['/changes/7/restore', { via: 'edit' }, 'via']
    ]) {
      const res = await request(path, { method: 'POST', token: 'editor', body });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'invalid', field });
    }
    expect(db.toggle).not.toHaveBeenCalled();
  });

  it('maps a toggle conflict to 409 with its reason and blocking changes', async () => {
    const blocking = [{ id: 9, action: 'revert', summary: 'Edited Rose Smith (notes)', authorName: 'Ann', createdAt: '2026-10-09T10:00:00Z' }];
    const { request } = setup({ toggle: vi.fn().mockRejectedValue(new ApiError(409, 'conflict', { reason: 'precondition', blocking })) });
    const res = await request('/changes/7/revert', { method: 'POST', token: 'editor' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'conflict', reason: 'precondition', blocking });
  });

  it('maps wrong_state to 409', async () => {
    const { request } = setup({ toggle: vi.fn().mockRejectedValue(new ApiError(409, 'wrong_state')) });
    const res = await request('/changes/7/restore', { method: 'POST', token: 'editor' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'wrong_state' });
  });

  it('POST /undo and /redo act on the editor\'s own stack', async () => {
    const { request, db } = setup();
    const undo = await request('/undo', { method: 'POST', token: 'editor' });
    expect(undo.status).toBe(200);
    expect(await undo.json()).toEqual({ change: CHANGE });
    expect(db.undoLast).toHaveBeenCalledWith(EDITOR);
    const redo = await request('/redo', { method: 'POST', token: 'admin' });
    expect(await redo.json()).toEqual({ change: CHANGE });
    expect(db.redoLast).toHaveBeenCalledWith(ADMIN);
  });

  it('POST /undo and /redo return a null change when there is nothing to do', async () => {
    const { request } = setup({ undoLast: vi.fn().mockResolvedValue(null), redoLast: vi.fn().mockResolvedValue(null) });
    expect(await (await request('/undo', { method: 'POST', token: 'editor' })).json()).toEqual({ change: null });
    expect(await (await request('/redo', { method: 'POST', token: 'editor' })).json()).toEqual({ change: null });
  });

  it('POST /undo maps a conflict to 409', async () => {
    const { request } = setup({ undoLast: vi.fn().mockRejectedValue(new ApiError(409, 'conflict', { reason: 'untracked', blocking: [] })) });
    const res = await request('/undo', { method: 'POST', token: 'editor' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'conflict', reason: 'untracked', blocking: [] });
  });

  it('GET /changes pages newest first, 50 at a time', async () => {
    const { request, db } = setup();
    const res = await request('/changes', { token: 'editor' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ changes: [{ id: 7 }] });
    expect(db.listChanges).toHaveBeenLastCalledWith({ before: null, limit: 50, person: null });
    await request('/changes?before=100&limit=10&person=I3', { token: 'editor' });
    expect(db.listChanges).toHaveBeenLastCalledWith({ before: 100, limit: 10, person: 'I3' });
    await request('/changes?limit=500&before=&person=', { token: 'editor' });
    expect(db.listChanges).toHaveBeenLastCalledWith({ before: null, limit: 50, person: null });
  });

  it('GET /changes validates its query', async () => {
    const { request, db } = setup();
    for (const [query, field] of [['before=x', 'before'], ['before=0', 'before'], ['limit=0', 'limit'], ['person=' + encodeURIComponent('I1;x'), 'person']]) {
      const res = await request('/changes?' + query, { token: 'editor' });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'invalid', field });
    }
    expect(db.listChanges).not.toHaveBeenCalled();
  });
});

describe('api/db.js', () => {
  function fakePool(rows) {
    const query = vi.fn(async () => ({ rows }));
    return { query, connect: vi.fn() };
  }

  it('escapes LIKE wildcards and the escape character', () => {
    expect(escapeLike('50%_a\\b')).toBe('50\\%\\_a\\\\b');
    expect(escapeLike('Ann Lee')).toBe('Ann Lee');
  });

  it('reads the view and its version in one statement', async () => {
    const pool = fakePool([{ view: VIEW, change_id: '42', migration: '006_editing.sql' }]);
    expect(await createDb(pool).personView('I1')).toEqual({ view: VIEW, version: VERSION });
    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/person_view\(\$1\)/);
    expect(sql).toMatch(/max\(id\)/);
    expect(sql).toMatch(/schema_migrations/);
    expect(params).toEqual(['I1']);
  });

  it('searches by name or word prefix, escaped, or by word similarity', async () => {
    const pool = fakePool([{ id: 'I1', name: 'Ann Lee', birth_year: 1850, death_year: null }]);
    expect(await createDb(pool).search('50%_\\', 20)).toEqual([{ id: 'I1', name: 'Ann Lee', birthYear: 1850, deathYear: null }]);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/display_name ilike \$2::text escape '\\'/);
    expect(sql).toMatch(/display_name ilike \('% ' \|\| \$2::text\) escape '\\'/);
    expect(sql).toMatch(/\$1::text <% display_name/);
    expect(sql).toMatch(/gedcom_year\(birth_date\)/);
    expect(params).toEqual(['50%_\\', '50\\%\\_\\\\%', 20]);
  });

  it('looks up an editor, or null', async () => {
    expect(await createDb(fakePool([EDITOR])).lookupEditor('editor@example.test')).toEqual(EDITOR);
    expect(await createDb(fakePool([])).lookupEditor('nobody@example.test')).toBeNull();
  });

  it('returns null when adding an editor who already exists', async () => {
    expect(await createDb(fakePool([])).addEditor({ email: 'editor@example.test', name: null, role: 'editor' }, 'admin@example.test')).toBeNull();
  });

  describe('toggles and history', () => {
    const CREATED = new Date('2026-10-09T10:00:00.123Z');
    const TOGGLE_ROW = { id: '12', summary: 'Undid: Edited Rose Smith (birth date)', person_ids: ['I1'], base_change_id: '7', kind: 'undo' };
    const TOGGLED = { id: 12, summary: 'Undid: Edited Rose Smith (birth date)', personIds: ['I1'], baseChangeId: 7, kind: 'undo' };
    const pgError = (code, detail) => Object.assign(new Error(code), { code, detail });

    /**
     * A pool whose transaction client answers the toggle statement with `toggled` (a new change id,
     * null, or an error to throw) and the read-back with TOGGLE_ROW; pool.query (used outside the
     * transaction) answers with `rows`, or throws `rows` when it is an Error.
     */
    function togglePool(toggled, rows = []) {
      const client = {
        query: vi.fn(async (sql) => {
          if (/toggle_change|undo_last|redo_last/.test(sql)) {
            if (toggled instanceof Error) throw toggled;
            return { rows: [{ id: toggled }] };
          }
          if (/from change where id = \$1/.test(sql)) return { rows: [TOGGLE_ROW] };
          return { rows: [] };
        }),
        release: vi.fn()
      };
      const query = vi.fn(async () => {
        if (rows instanceof Error) throw rows;
        return { rows };
      });
      return { client, query, connect: vi.fn(async () => client) };
    }
    const statements = (client) => client.query.mock.calls.map(([sql]) => sql);

    async function rejection(promise) {
      try {
        await promise;
      } catch (error) {
        return error;
      }
      throw new Error('expected a rejection');
    }

    it('toggles a change in a write transaction and reads back the change it recorded', async () => {
      const pool = togglePool('12');
      expect(await createDb(pool).toggle(EDITOR, 7, 'undo', 'history')).toEqual(TOGGLED);
      expect(statements(pool.client)).toEqual([
        'begin',
        "set local statement_timeout = '10s'; set local idle_in_transaction_session_timeout = '15s'",
        'select toggle_change($1, $2, $3, $4, $5) as id',
        'select id, summary, person_ids, base_change_id, kind from change where id = $1',
        'commit'
      ]);
      expect(pool.client.query.mock.calls[2][1]).toEqual([7, 'undo', 'editor@example.test', 'Ed Editor', 'history']);
      expect(pool.client.query.mock.calls[3][1]).toEqual(['12']);
      expect(pool.client.release).toHaveBeenCalled();
      expect(pool.query).not.toHaveBeenCalled();
    });

    it('undoes and redoes the editor\'s last change, passing a missing name as null', async () => {
      const editor = { email: 'noname@example.test', name: null, role: 'editor' };
      for (const [method, fn] of [['undoLast', 'undo_last'], ['redoLast', 'redo_last']]) {
        const pool = togglePool('12');
        expect(await createDb(pool)[method](editor)).toEqual(TOGGLED);
        expect(pool.client.query.mock.calls[2]).toEqual([`select ${fn}($1, $2) as id`, ['noname@example.test', null]]);
        expect(statements(pool.client).at(-1)).toBe('commit');
      }
    });

    it('returns null from undo and redo when there is nothing to do, reading nothing back', async () => {
      for (const method of ['undoLast', 'redoLast']) {
        const pool = togglePool(null);
        expect(await createDb(pool)[method](EDITOR)).toBeNull();
        expect(statements(pool.client).filter((sql) => /from change/.test(sql))).toEqual([]);
        expect(statements(pool.client).at(-1)).toBe('commit');
      }
    });

    it('maps not_found and wrong_state, rolling back', async () => {
      for (const [code, status, error] of [['GE001', 404, 'not_found'], ['GE002', 409, 'wrong_state']]) {
        const pool = togglePool(pgError(code));
        const thrown = await rejection(createDb(pool).toggle(EDITOR, 7, 'redo', 'history'));
        expect(thrown).toBeInstanceOf(ApiError);
        expect(thrown).toMatchObject({ status, code: error });
        expect(statements(pool.client).at(-1)).toBe('rollback');
        expect(pool.query).not.toHaveBeenCalled();
      }
    });

    it('enriches a conflict\'s blocking changes in one query, keeping their order and actions', async () => {
      const detail = JSON.stringify({ reason: 'precondition', blocking: [{ id: 9, action: 'revert' }, { id: 4, action: 'restore' }] });
      const pool = togglePool(pgError('GE003', detail), [
        { id: '4', summary: 'Added Ann Lee', author_name: null, created_at: CREATED },
        { id: '9', summary: 'Edited Rose Smith (notes)', author_name: 'Ann', created_at: new Date('2026-10-09T11:00:00Z') }
      ]);
      const thrown = await rejection(createDb(pool).toggle(EDITOR, 7, 'undo', 'history'));
      expect(thrown).toBeInstanceOf(ApiError);
      expect(thrown.status).toBe(409);
      expect(thrown.code).toBe('conflict');
      expect(thrown.extra).toEqual({
        reason: 'precondition',
        blocking: [
          { id: 9, action: 'revert', summary: 'Edited Rose Smith (notes)', authorName: 'Ann', createdAt: '2026-10-09T11:00:00.000Z' },
          { id: 4, action: 'restore', summary: 'Added Ann Lee', authorName: null, createdAt: '2026-10-09T10:00:00.123Z' }
        ]
      });
      expect(pool.query).toHaveBeenCalledTimes(1);
      const [sql, params] = pool.query.mock.calls[0];
      expect(sql).toMatch(/from change where id = any \(\$1::bigint\[\]\)/);
      expect(params).toEqual([[9, 4]]);
      expect(statements(pool.client).at(-1)).toBe('rollback');
    });

    it('enriches conflicts from undo and redo too', async () => {
      const detail = JSON.stringify({ reason: 'cascade', blocking: [{ id: 9, action: 'revert' }] });
      for (const method of ['undoLast', 'redoLast']) {
        const pool = togglePool(pgError('GE003', detail), [{ id: '9', summary: 'Linked a child', author_name: 'Ann', created_at: CREATED }]);
        const thrown = await rejection(createDb(pool)[method](EDITOR));
        expect(thrown.extra).toEqual({
          reason: 'cascade',
          blocking: [{ id: 9, action: 'revert', summary: 'Linked a child', authorName: 'Ann', createdAt: '2026-10-09T10:00:00.123Z' }]
        });
      }
    });

    it('leaves out blocking entries that aren\'t objects', async () => {
      const detail = JSON.stringify({ reason: 'precondition', blocking: [null, { id: 9, action: 'revert' }, 'x'] });
      const pool = togglePool(pgError('GE003', detail), [{ id: '9', summary: 'Linked a child', author_name: 'Ann', created_at: CREATED }]);
      const thrown = await rejection(createDb(pool).toggle(EDITOR, 7, 'undo', 'history'));
      expect(thrown.extra.blocking).toEqual([
        { id: 9, action: 'revert', summary: 'Linked a child', authorName: 'Ann', createdAt: '2026-10-09T10:00:00.123Z' }
      ]);
      expect(pool.query.mock.calls[0][1]).toEqual([[9]]);

      const onlyNull = togglePool(pgError('GE003', JSON.stringify({ reason: 'cascade', blocking: [null] })));
      const empty = await rejection(createDb(onlyNull).toggle(EDITOR, 7, 'undo', 'history'));
      expect(empty).toMatchObject({ status: 409, code: 'conflict', extra: { reason: 'cascade', blocking: [] } });
      expect(onlyNull.query).not.toHaveBeenCalled();
    });

    it('logs a command\'s database failure with the injected log', async () => {
      const log = vi.fn();
      const pool = togglePool(null);
      pool.client.query.mockImplementation(async (sql) => {
        if (/begin_change/.test(sql)) throw pgError('23503');
        return { rows: [] };
      });
      const params = { id: 'I1', expectedUpdatedAt: '2026-10-09T10:00:00Z', fields: { birth_place: 'York' } };
      const thrown = await rejection(createDb(pool, { log }).runChange(EDITOR, 'update_person', params));
      expect(thrown).toMatchObject({ status: 500, code: 'internal' });
      expect(log).toHaveBeenCalledTimes(1);
    });

    it('sends a conflict with no blocking changes without querying', async () => {
      const pool = togglePool(pgError('GE003', JSON.stringify({ reason: 'constraint', blocking: [] })));
      const thrown = await rejection(createDb(pool).toggle(EDITOR, 7, 'undo', 'history'));
      expect(thrown).toMatchObject({ status: 409, code: 'conflict', extra: { reason: 'constraint', blocking: [] } });
      expect(pool.query).not.toHaveBeenCalled();
    });

    it('still sends the conflict, logged and with null details, when the blocking changes can\'t be read', async () => {
      const log = vi.fn();
      const detail = JSON.stringify({ reason: 'structure', blocking: [{ id: 9, action: 'revert' }] });
      const pool = togglePool(pgError('GE003', detail), new Error('connection reset'));
      const thrown = await rejection(createDb(pool, { log }).toggle(EDITOR, 7, 'undo', 'history'));
      expect(thrown).toMatchObject({ status: 409, code: 'conflict' });
      expect(thrown.extra).toEqual({ reason: 'structure', blocking: [{ id: 9, action: 'revert', summary: null, authorName: null, createdAt: null }] });
      expect(log).toHaveBeenCalledTimes(1);
    });

    it('maps a timeout to 503 busy and an integrity violation to a logged 500', async () => {
      const log = vi.fn();
      const busy = await rejection(createDb(togglePool(pgError('57014')), { log }).undoLast(EDITOR));
      expect(busy).toMatchObject({ status: 503, code: 'busy' });
      const broken = await rejection(createDb(togglePool(pgError('23503')), { log }).toggle(EDITOR, 7, 'undo', 'history'));
      expect(broken).toMatchObject({ status: 500, code: 'internal' });
      expect(log).toHaveBeenCalledTimes(2);
    });

    it('passes other errors through unchanged', async () => {
      const failure = new Error('connection reset');
      expect(await rejection(createDb(togglePool(failure)).toggle(EDITOR, 7, 'undo', 'history'))).toBe(failure);
    });

    const HISTORY_ROW = {
      id: '12', created_at: CREATED, author_name: 'Ed Editor', author_email: 'editor@example.test', kind: 'undo',
      via: 'keyboard', summary: 'Undid: Edited Rose Smith (birth date)', person_ids: ['I1', 'I9'], base_change_id: '7', undone: false,
      people: [{ id: 'I1', name: 'Rose Smith' }]
    };

    it('lists changes newest first, with camelCase fields, ISO times and the people who still exist', async () => {
      const base = {
        ...HISTORY_ROW, id: '7', kind: 'update_person', via: 'edit', summary: 'Edited Rose Smith (birth date)', base_change_id: null,
        undone: true, people: null
      };
      const pool = fakePool([HISTORY_ROW, base]);
      expect(await createDb(pool).listChanges({ before: null, limit: 50, person: null })).toEqual([
        { id: 12, createdAt: '2026-10-09T10:00:00.123Z', authorName: 'Ed Editor', authorEmail: 'editor@example.test', kind: 'undo',
          via: 'keyboard', summary: 'Undid: Edited Rose Smith (birth date)', personIds: ['I1', 'I9'], people: [{ id: 'I1', name: 'Rose Smith' }],
          baseChangeId: 7, undone: false },
        { id: 7, createdAt: '2026-10-09T10:00:00.123Z', authorName: 'Ed Editor', authorEmail: 'editor@example.test', kind: 'update_person',
          via: 'edit', summary: 'Edited Rose Smith (birth date)', personIds: ['I1', 'I9'], people: [], baseChangeId: null, undone: true }
      ]);
      const [sql, params] = pool.query.mock.calls[0];
      expect(sql).not.toMatch(/touched on true\s+where/); // no filter on the changes themselves
      expect(sql).toMatch(/left join lateral/);
      expect(sql).toMatch(/jsonb_build_object\('id', p\.id, 'name', p\.display_name\)/);
      expect(sql).toMatch(/order by array_position\(c\.person_ids, p\.id\)/);
      expect(sql).toMatch(/where p\.id = any \(c\.person_ids\)/);
      expect(sql).toMatch(/coalesce\(touched\.people, '\[\]'::jsonb\) as people/);
      expect(sql).toMatch(/order by c\.id desc\s+limit \$1/);
      expect(params).toEqual([50]);
    });

    it('filters by before and person, and caps the page at 50', async () => {
      const pool = fakePool([]);
      const db = createDb(pool);
      await db.listChanges({ before: 100, limit: 10, person: 'I3' });
      let [sql, params] = pool.query.mock.calls[0];
      expect(sql).toMatch(/where c\.id < \$1 and c\.person_ids @> array\[\$2::text\]/);
      expect(sql).toMatch(/limit \$3/);
      expect(params).toEqual([100, 'I3', 10]);

      await db.listChanges({ person: 'I3', limit: 500 });
      [sql, params] = pool.query.mock.calls[1];
      expect(sql).toMatch(/where c\.person_ids @> array\[\$1::text\]/);
      expect(params).toEqual(['I3', 50]);

      await db.listChanges();
      expect(pool.query.mock.calls[2][1]).toEqual([50]);
    });
  });

  it('runs a transaction with the write timeouts and releases the client', async () => {
    const client = { query: vi.fn(async () => ({ rows: [] })), release: vi.fn() };
    const pool = { connect: vi.fn(async () => client) };
    expect(await inTransaction(pool, async (tx) => { await tx.query('select 1'); return 'done'; })).toBe('done');
    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual([
      'begin',
      "set local statement_timeout = '10s'; set local idle_in_transaction_session_timeout = '15s'",
      'select 1',
      'commit'
    ]);
    expect(client.release).toHaveBeenCalledWith(undefined);
  });

  it('rolls back and rethrows on error, discarding the client if the rollback fails too', async () => {
    const failure = new Error('boom');
    const client = { query: vi.fn(async () => ({ rows: [] })), release: vi.fn() };
    const pool = { connect: vi.fn(async () => client) };
    await expect(inTransaction(pool, async () => { throw failure; })).rejects.toBe(failure);
    expect(client.query).toHaveBeenLastCalledWith('rollback');
    expect(client.release).toHaveBeenCalledWith(undefined);

    const lost = new Error('connection lost');
    const broken = { query: vi.fn(async (sql) => { if (sql === 'rollback') throw lost; return { rows: [] }; }), release: vi.fn() };
    await expect(inTransaction({ connect: async () => broken }, async () => { throw failure; })).rejects.toBe(failure);
    expect(broken.release).toHaveBeenCalledWith(lost);
  });

  it('imports without creating a pool or logging', async () => {
    vi.resetModules();
    const Pool = vi.fn();
    vi.doMock('pg', () => ({ Pool, default: { Pool } }));
    const spies = ['log', 'info', 'warn', 'error'].map((method) => vi.spyOn(console, method));
    try {
      await import('../api/db.js');
      expect(Pool).not.toHaveBeenCalled();
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
      vi.doUnmock('pg');
    }
  });
});

describe('when Neon Auth is not configured', () => {
  const unconfigured = () => {
    const log = vi.fn();
    const db = fakeDb();
    const handler = createHandler({ db, authenticate: authenticatorFromEnv({}, { log }), log });
    const request = (path, headers = {}) => handler(new Request(`https://api.test${path}`, { headers }));
    return { log, db, request };
  };

  it('serves anonymous callers as usual', async () => {
    const { request, log } = unconfigured();
    const res = await request('/person/I1');
    expect(res.status).toBe(200);
    expect((await res.json()).masked).toBe(true);
    expect((await request('/me')).status).toBe(401);
    expect(log).not.toHaveBeenCalled();
  });

  it('answers any request with an Authorization header with 500, logging it once', async () => {
    const { request, log, db } = unconfigured();
    for (const path of ['/person/I1', '/me', '/search?q=Ann']) {
      const res = await request(path, { authorization: 'Bearer anything' });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'internal' });
    }
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatch(/Neon Auth is not configured/);
    expect(db.personView).not.toHaveBeenCalled();
  });

  it('uses the real authenticator when it is configured', async () => {
    const authenticate = authenticatorFromEnv({
      NEON_AUTH_JWKS_URL: 'https://auth.example.test/.well-known/jwks.json',
      NEON_AUTH_BASE_URL: 'https://auth.example.test/neondb/auth'
    });
    expect(await authenticate(new Request('https://api.test/me'))).toBeNull();
    await expect(authenticate(new Request('https://api.test/me', { headers: { authorization: 'Basic x' } })))
      .rejects.toMatchObject({ status: 401, code: 'unauthenticated' });
  });
});

describe('email masking', () => {
  const person = {
    id: 'I1', email: 'keep@example.com', birthPlace: 'x@example.net',
    notes: ['From: Jo <jo.smith@mail.example.test>\nSent: Monday'],
    deathNotes: ['mail a.b@example.org'],
    censusRecords: [{ date: '1851', notes: ['c@example.net and e@example.com'] }],
    otherFacts: [{ tag: 'EVEN', value: 'v@example.com', notes: ['g@example.org'] }]
  };
  const view = { person, family: [{ id: 'I2', name: 'n@example.com' }], relationships: { parents: [], spouses: [], children: [], siblings: [] } };

  it('masks addresses in note text only', async () => {
    const { request } = setup({ personView: async () => ({ view, version: VERSION }) });
    const body = await (await request('/person/I1')).json();
    expect(body.person).toEqual({
      ...person,
      notes: ['From: Jo <[email hidden]>\nSent: Monday'],
      deathNotes: ['mail [email hidden]'],
      censusRecords: [{ date: '1851', notes: ['[email hidden] and [email hidden]'] }],
      otherFacts: [{ tag: 'EVEN', value: 'v@example.com', notes: ['[email hidden]'] }]
    });
    expect(body.family).toEqual(view.family);
  });

  it('masks note keys anywhere in the view, not only under person', () => {
    const masked = maskNoteEmails({ person: { id: 'I1' }, family: [{ id: 'I2', notes: ['n@example.com'], name: 'n@example.com' }] });
    expect(masked.family).toEqual([{ id: 'I2', notes: ['[email hidden]'], name: 'n@example.com' }]);
  });

  it('returns a missing view as is', () => {
    expect(maskNoteEmails(null)).toBeNull();
    expect(maskNoteEmails(undefined)).toBeUndefined();
  });

  it('masks addresses with non-ASCII letters', () => {
    const masked = maskNoteEmails({ person: { id: 'I1', notes: ['Write to josé@exämple.org today'] } });
    expect(masked.person.notes).toEqual(['Write to [email hidden] today']);
  });

  it('masks addresses whose accents are decomposed (NFD), as text pasted from macOS can be', () => {
    const masked = maskNoteEmails({ person: { id: 'I1', notes: ['Write to jose\u0301@example.org today'] } });
    expect(masked.person.notes).toEqual(['Write to [email hidden] today']);
  });

  it('masks an address stored with the GEDCOM @@ escape too', () => {
    const masked = maskNoteEmails({ person: { id: 'I1', notes: ['Write to jo@@example.org'] } });
    expect(masked.person.notes).toEqual(['Write to [email hidden]']);
  });

  it('does not backtrack quadratically on a long run of address characters', () => {
    const text = 'a'.repeat(30_000) + '@';
    const started = performance.now();
    const masked = maskNoteEmails({ person: { id: 'I1', notes: [text] } });
    expect(performance.now() - started).toBeLessThan(100);
    expect(masked.person.notes).toEqual([text]);
  });

  it('does not modify its input', () => {
    const copy = structuredClone(view);
    maskNoteEmails(view);
    expect(view).toEqual(copy);
  });
});
