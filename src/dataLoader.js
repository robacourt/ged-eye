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
const inflight = new Map();   // personId -> Promise<view>
const prefetched = new Map(); // personId -> when it was queued for prefetch
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

/** The token for an unmasked view: only for editors, and never at the cost of the public view. */
async function editorToken() {
  if (!EDITOR_ROLES.has(getRole())) return null;
  try {
    return await getToken();
  } catch {
    return null;
  }
}

async function requestView(personId) {
  const url = apiUrl(`/person/${encodeURIComponent(personId)}`);
  let token = await editorToken();
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
      // A rejected token: show the public view rather than fail (an editor form reloads it with a fresh
      // token). This doesn't use up the retry.
      token = null;
      attempt--;
      continue;
    }
    if (response.status === 404 || response.status === 400) throw new PersonNotFoundError(personId);
    if (response.ok) return response.json();
    if (response.status >= 500 && attempt < 2) continue;
    throw new Error(`Failed to load person ${personId}: HTTP ${response.status}`);
  }
}

/** The cached view, or null when there is none or it has expired. */
function freshView(personId, now = Date.now()) {
  const entry = cache.get(personId);
  return entry && isFresh(entry.loadedAt, now) ? entry.view : null;
}

function getView(personId) {
  const cached = freshView(personId);
  if (cached) return Promise.resolve(cached);
  if (inflight.has(personId)) return inflight.get(personId);
  const startedIn = generation;
  const promise = requestView(personId)
    .then(
      view => {
        // Invalidated while loading (a change, sign-in or sign-out): this view may be out of date.
        if (startedIn !== generation) return getView(personId);
        cache.set(personId, { view, loadedAt: Date.now() });
        return view;
      },
      error => {
        if (startedIn !== generation) return getView(personId);
        throw error;
      }
    )
    .finally(() => {
      if (inflight.get(personId) === promise) inflight.delete(personId);
    });
  inflight.set(personId, promise);
  return promise;
}

/**
 * Load a person and their immediate family.
 * @returns {Promise<{person, family, relationships: {parents, spouses, children, siblings}}>}
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
    }
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
}

/** Caches a view the API returned with a change (`runChange`'s `view`). Call it after `invalidateAll()`. */
export function cacheView(view) {
  cache.set(view.person.id, { view, loadedAt: Date.now() });
}

export function resetDataLoaderForTests() {
  invalidateAll();
}
