/**
 * Loads person views (a person plus immediate family) from the Neon API, with an in-memory cache.
 *
 * Signed in as an editor, it sends the bearer token and gets unmasked views. Cached views expire after
 * 5 minutes, and `invalidateAll()` drops them all (on sign-in, sign-out and after every change).
 */
import { getRole, getToken } from './auth.js';
import { apiUrl, timeoutSignal } from './editApi.js';

const PREFETCH_CONCURRENCY = 4;
const REQUEST_TIMEOUT_MS = 10_000;
const VIEW_TTL_MS = 5 * 60_000;
const EDITOR_ROLES = new Set(['editor', 'admin']);

const cache = new Map();      // personId -> { view, loadedAt }
const inflight = new Map();   // personId -> { promise: Promise<view>, editor: whether it asked for the unmasked view }
const prefetched = new Map(); // personId -> when it was queued for prefetch
const reloads = new Map();    // personId -> how many times reload() has been called for it
// Bumped by invalidateAll(), so responses to requests made before it are thrown away.
let generation = 0;

export class PersonNotFoundError extends Error {
  constructor(personId) {
    super(`Person ${personId} not found`);
    this.name = 'PersonNotFoundError';
    this.personId = personId;
  }
}

const isFresh = (since, now = Date.now()) => now - since < VIEW_TTL_MS;

/** Editors get unmasked views; everyone else (signed out, or signed in without editor access) masked ones. */
const wantsUnmasked = () => EDITOR_ROLES.has(getRole());

/** Whether a view suits the current viewer. A view without `masked` (from an older API) suits anyone. */
function suitsViewer(view, editor = wantsUnmasked()) {
  return typeof view.masked !== 'boolean' || view.masked !== editor;
}

/** The token for an unmasked view: only for editors, and never at the cost of the public view. */
async function editorToken(options) {
  if (!wantsUnmasked()) return null;
  try {
    return await getToken(options);
  } catch {
    return null;
  }
}

async function requestView(personId) {
  const url = apiUrl(`/person/${encodeURIComponent(personId)}`);
  let token = await editorToken();
  let refreshed = false;
  for (let attempt = 1; ; attempt++) {
    // Anonymous requests send no headers, so they stay simple CORS requests, without a preflight.
    const init = { signal: timeoutSignal(REQUEST_TIMEOUT_MS) };
    if (token) init.headers = { authorization: `Bearer ${token}` };
    let response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      if (attempt < 2) continue;
      throw error;
    }
    if (response.status === 401 && token) {
      // A rejected token: try a freshly fetched one, then fall back to the public view rather than fail
      // (it isn't served to an editor from the cache). Neither uses up the retry.
      token = refreshed ? null : await editorToken({ force: true });
      refreshed = true;
      attempt--;
      continue;
    }
    if (response.status === 404 || response.status === 400) throw new PersonNotFoundError(personId);
    if (response.ok) return response.json();
    if (response.status >= 500 && attempt < 2) continue;
    throw new Error(`Failed to load person ${personId}: HTTP ${response.status}`);
  }
}

/**
 * The cached view, or null when there is none, it has expired, or it is masked for an editor (or unmasked
 * for anyone else, after a sign-out or a role change).
 */
function freshView(personId, now = Date.now()) {
  const entry = cache.get(personId);
  return entry && isFresh(entry.loadedAt, now) && suitsViewer(entry.view) ? entry.view : null;
}

function getView(personId) {
  const cached = freshView(personId);
  if (cached) return Promise.resolve(cached);
  const editor = wantsUnmasked();
  const pending = inflight.get(personId);
  if (pending && pending.editor === editor) return pending.promise;
  const startedIn = generation;
  const reloadCount = reloads.get(personId) ?? 0;
  // Invalidated while loading (a change, sign-in, sign-out or reload): the response may be out of date.
  const isOutdated = () => startedIn !== generation || (reloads.get(personId) ?? 0) !== reloadCount;
  const promise = requestView(personId)
    .then(
      view => {
        if (isOutdated()) return getView(personId);
        cache.set(personId, { view, loadedAt: Date.now() });
        return view;
      },
      error => {
        if (isOutdated()) return getView(personId);
        throw error;
      }
    )
    .finally(() => {
      if (inflight.get(personId)?.promise === promise) inflight.delete(personId);
    });
  inflight.set(personId, { promise, editor });
  return promise;
}

/**
 * Load a person and their immediate family. `masked` is whether the view's notes had email addresses masked
 * (undefined from an older API); the person editor refuses to edit a masked view.
 * @returns {Promise<{person, family, relationships: {parents, spouses, children, siblings}, masked}>}
 */
export async function loadPersonWithFamily(personId) {
  const view = await getView(personId);
  const byId = new Map(view.family.map(member => [member.id, member]));
  const pick = ids => ids.map(id => byId.get(id)).filter(Boolean);
  return {
    person: view.person,
    family: view.family,
    relationships: {
      parents: pick(view.relationships.parents),
      spouses: pick(view.relationships.spouses),
      children: pick(view.relationships.children),
      siblings: pick(view.relationships.siblings)
    },
    masked: view.masked
  };
}

/**
 * Quietly fetch the views of everyone in `result.family` so clicking them is instant.
 */
export function prefetchFamily(result) {
  const now = Date.now();
  const ids = result.family
    .map(member => member.id)
    .filter(id => !freshView(id, now) && !inflight.has(id) && !(prefetched.has(id) && isFresh(prefetched.get(id), now)));
  if (ids.length === 0) return;
  ids.forEach(id => prefetched.set(id, now));

  const startedIn = generation;
  const whenIdle = globalThis.requestIdleCallback ?? (callback => setTimeout(callback, 200));
  whenIdle(() => {
    let next = 0;
    const worker = async () => {
      while (next < ids.length && startedIn === generation) {
        const id = ids[next++];
        try {
          await getView(id);
        } catch {
          // Prefetch is best effort; a real click will retry and report errors.
        }
      }
    };
    for (let i = 0; i < Math.min(PREFETCH_CONCURRENCY, ids.length); i++) worker();
  });
}

/**
 * Forgets every cached view and prefetch, and discards responses still in flight (their callers get a fresh
 * load instead). Call it on sign-in, sign-out (after `me()` has set the role) and after every change.
 */
export function invalidateAll() {
  generation++;
  cache.clear();
  inflight.clear();
  prefetched.clear();
  reloads.clear();
}

/**
 * Loads one person afresh, ignoring the cache and any request already in flight for them (whose callers get
 * this load's result). Same result as loadPersonWithFamily.
 */
export function reload(personId) {
  reloads.set(personId, (reloads.get(personId) ?? 0) + 1);
  cache.delete(personId);
  inflight.delete(personId);
  prefetched.delete(personId);
  return loadPersonWithFamily(personId);
}

/**
 * Caches a view the API returned with a change (`runChange`'s `view`; null after a delete is ignored).
 * Call it after `invalidateAll()`.
 */
export function cacheView(view) {
  if (!view) return;
  cache.set(view.person.id, { view, loadedAt: Date.now() });
}

export function resetDataLoaderForTests() {
  invalidateAll();
}
