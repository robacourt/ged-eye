/**
 * Loads person views (a person plus immediate family) from the Neon API, with an in-memory cache.
 */

const PREFETCH_CONCURRENCY = 4;

const cache = new Map();      // personId -> view
const inflight = new Map();   // personId -> Promise<view>
const prefetched = new Set(); // personIds already queued for prefetch

export class PersonNotFoundError extends Error {
  constructor(personId) {
    super(`Person ${personId} not found`);
    this.name = 'PersonNotFoundError';
    this.personId = personId;
  }
}

async function requestView(personId) {
  const url = `${import.meta.env.VITE_API_URL}/person/${encodeURIComponent(personId)}`;
  for (let attempt = 1; ; attempt++) {
    let response;
    try {
      response = await fetch(url);
    } catch (error) {
      if (attempt < 2) continue;
      throw error;
    }
    if (response.status === 404 || response.status === 400) throw new PersonNotFoundError(personId);
    if (response.ok) return response.json();
    if (response.status >= 500 && attempt < 2) continue;
    throw new Error(`Failed to load person ${personId}: HTTP ${response.status}`);
  }
}

function getView(personId) {
  if (cache.has(personId)) return Promise.resolve(cache.get(personId));
  if (inflight.has(personId)) return inflight.get(personId);
  const promise = requestView(personId)
    .then(view => {
      cache.set(personId, view);
      return view;
    })
    .finally(() => inflight.delete(personId));
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
  const ids = result.family
    .map(member => member.id)
    .filter(id => !cache.has(id) && !inflight.has(id) && !prefetched.has(id));
  if (ids.length === 0) return;
  ids.forEach(id => prefetched.add(id));

  const whenIdle = globalThis.requestIdleCallback ?? (callback => setTimeout(callback, 200));
  whenIdle(() => {
    let next = 0;
    const worker = async () => {
      while (next < ids.length) {
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

export function resetDataLoaderForTests() {
  cache.clear();
  inflight.clear();
  prefetched.clear();
}
