/**
 * Client for the API's editing routes (api/handler.js): commands, history, undo/redo, search, /me and editors.
 * Errors come back as ApiError, with the server's `{ error: code, ... }` body spread onto it.
 */
import { getToken as authGetToken, setRole as authSetRole } from './auth.js';

const REQUEST_TIMEOUT_MS = 30_000;
const SEARCH_MIN_CHARS = 2;

/**
 * A failed API call. `status` is the HTTP status, or 0 when the server couldn't be reached (code 'network').
 * `code` is the server's error code (`invalid`, `no_change`, `unauthenticated`, `not_an_editor`, `not_an_admin`,
 * `not_found`, `conflict`, `stale`, `wrong_state`, `too_large`, `internal`, ...), or `http_<status>` without one.
 * `field` names the invalid field (400 invalid); `reason` and `blocking` explain a 409 conflict.
 */
export class ApiError extends Error {
  constructor(status, code, body = {}) {
    super(typeof body.message === 'string' && body.message ? body.message : code);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.field = body.field ?? null;
    this.reason = body.reason ?? null;
    this.blocking = Array.isArray(body.blocking) ? body.blocking : [];
    this.body = body;
  }
}

/**
 * The absolute URL of an API path (which starts with `/`) on `base`, which is VITE_API_URL unless given.
 * Throws when the base isn't configured, naming `name` (the setting it came from) in the message.
 */
export function apiUrl(path, base = import.meta.env.VITE_API_URL, name = 'VITE_API_URL') {
  if (typeof path !== 'string' || !path.startsWith('/')) throw new Error(`API paths start with /: ${path}`);
  if (!base) throw new Error(`${name} is not configured`);
  return `${base}${path}`;
}

// AbortSignal.timeout() needs Safari 16+; fall back for older iPads and iPhones.
export function timeoutSignal(ms) {
  if (typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

function query(params) {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(name, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

const networkError = (message) => new ApiError(0, 'network', { message });

/**
 * A client for one Function, with the caller's bearer token on every call.
 * @param getToken     ({ force }?) → Promise<jwt | null>
 * @param setRole      (role, email?) → void, caches the role from /me
 * @param baseUrl      The Function's URL, or a function returning it (read on each call, so a missing setting only
 *                     fails when used). Leave it out for VITE_API_URL. Once given, an empty value is an error:
 *                     it never falls back to VITE_API_URL.
 * @param baseUrlName  The setting `baseUrl` comes from, for the "is not configured" error.
 */
export function createEditApi(options) {
  const { getToken, setRole = () => {}, baseUrlName = 'VITE_API_URL' } = options;
  const resolveBase = () => {
    if (!('baseUrl' in options)) return import.meta.env.VITE_API_URL;
    return (typeof options.baseUrl === 'function' ? options.baseUrl() : options.baseUrl) || '';
  };

  /** The bearer token. When it's optional, failing to get one just means calling without it. */
  async function token(tokenOptions, optional) {
    try {
      return await getToken(tokenOptions);
    } catch (error) {
      if (optional) return null;
      throw networkError(error?.message || "Couldn't reach the sign-in service.");
    }
  }

  async function send(url, method, body, bearer, timeoutMs) {
    const headers = {};
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    try {
      return await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: timeoutSignal(timeoutMs)
      });
    } catch (error) {
      const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      throw networkError(timedOut ? 'The server took too long to answer.' : "Couldn't reach the server. Check your connection.");
    }
  }

  /**
   * Calls the API and returns the parsed JSON body. Adds the bearer token: `auth: 'required'` (the default)
   * fails with 401 `unauthenticated` when signed out, `'optional'` sends it only when signed in.
   * A 401 is retried once with a force-refreshed token; with optional auth, then without a token.
   * Each request gives up after `timeoutMs` (30 s by default) with a `network` error.
   */
  async function authedFetch(path, { method = 'GET', body, auth = 'required', timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    const url = apiUrl(path, resolveBase(), baseUrlName);
    const optional = auth === 'optional';
    let bearer = await token(undefined, optional);
    if (!bearer && !optional) throw new ApiError(401, 'unauthenticated', { message: 'Signed out. Sign in again.' });
    let response = await send(url, method, body, bearer, timeoutMs);
    if (response.status === 401 && bearer) {
      bearer = await token({ force: true }, optional);
      if (bearer) response = await send(url, method, body, bearer, timeoutMs);
      if (optional && (!bearer || response.status === 401)) response = await send(url, method, body, null, timeoutMs);
    }
    const parsed = await response.json().catch(() => null);
    if (response.ok) return parsed;
    const details = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    throw new ApiError(response.status, typeof details.error === 'string' ? details.error : `http_${response.status}`, details);
  }

  const post = (path, body) => authedFetch(path, { method: 'POST', body });
  const changePath = (id, action) => `/changes/${encodeURIComponent(id)}/${action}`;

  return {
    authedFetch,

    /** → `{ change: { id, summary, personIds }, view }`; `view` is the focus person's unmasked view, or null. */
    runChange: (kind, params) => post('/changes', { kind, params }),

    /** → the undo change `{ id, summary, personIds }`. `via` is 'history' or 'keyboard' (the toast's Undo). */
    revert: async (id, via = 'history') => (await post(changePath(id, 'revert'), { via })).change,

    /** → the redo change `{ id, summary, personIds }`. */
    restore: async (id) => (await post(changePath(id, 'restore'))).change,

    /** → the change, or null when there is nothing to undo. */
    undo: async () => (await post('/undo')).change ?? null,

    /** → the change, or null when there is nothing to redo. */
    redo: async () => (await post('/redo')).change ?? null,

    /** Newest first: `[{ id, createdAt, authorName, authorEmail, kind, via, summary, personIds, baseChangeId, undone }]`. */
    listChanges: async ({ before, limit, person } = {}) =>
      (await authedFetch(`/changes${query({ before, limit, person })}`)).changes,

    /** `[{ id, name, birthYear, deathYear }]`; [] without asking for fewer than 2 characters. */
    async search(q, { limit } = {}) {
      const text = (q ?? '').trim();
      if ([...text].length < SEARCH_MIN_CHARS) return [];
      return (await authedFetch(`/search${query({ q: text, limit })}`, { auth: 'optional' })).results;
    },

    /**
     * → `{ email, name, role }`, with `role: null` (and `name: null`) for a signed-in non-editor.
     * Caches the role in auth, for the data loader. Throws ApiError 401 when signed out.
     */
    async me() {
      try {
        const account = await authedFetch('/me');
        setRole(account.role ?? null, account.email);
        return account;
      } catch (error) {
        if (error instanceof ApiError && error.status === 403 && error.code === 'not_an_editor') {
          const email = error.body.email ?? null;
          setRole(null, email);
          return { email, name: null, role: null };
        }
        if (error instanceof ApiError && error.status === 401) setRole(null);
        throw error;
      }
    },

    /** Admins only. → `[{ email, name, role, addedBy, addedAt }]`. */
    listEditors: async () => (await authedFetch('/editors')).editors,

    /** Admins only. → the new editor. */
    addEditor: async ({ email, name, role }) => (await post('/editors', { email, name, role })).editor,

    /** Admins only. */
    async removeEditor(email) {
      await authedFetch(`/editors/${encodeURIComponent(email)}`, { method: 'DELETE' });
    }
  };
}

const api = createEditApi({
  getToken: (options) => authGetToken(options),
  setRole: (role, email) => authSetRole(role, email)
});

/**
 * Authenticated calls to the `media` Function (src/mediaApi.js), with the same token, retry and error mapping as
 * `api`. Fails with "VITE_MEDIA_API_URL is not configured" on first use, not at import.
 */
export const mediaClient = {
  authedFetch: createEditApi({
    getToken: (options) => authGetToken(options),
    baseUrl: () => import.meta.env.VITE_MEDIA_API_URL,
    baseUrlName: 'VITE_MEDIA_API_URL'
  }).authedFetch
};

export const {
  authedFetch,
  runChange,
  revert,
  restore,
  undo,
  redo,
  listChanges,
  search,
  me,
  listEditors,
  addEditor,
  removeEditor
} = api;
