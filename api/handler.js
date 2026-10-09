import { maskNoteEmails } from './privacy.js';

const ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const PERSON_PATH = /^\/person\/([^/]+)$/;
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS'
};

function json(status, body, cacheControl = 'no-store') {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'content-type': 'application/json', 'cache-control': cacheControl }
  });
}

/**
 * @param queryPersonView (id) => Promise<object|null>
 */
export function createHandler(queryPersonView, { log = console.error } = {}) {
  return async function handle(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { ...CORS, 'access-control-max-age': '86400' } });
    }
    if (request.method !== 'GET') return json(404, { error: 'not_found' });

    const { pathname } = new URL(request.url);
    if (pathname === '/health') return json(200, { ok: true });

    const match = PERSON_PATH.exec(pathname);
    if (!match) return json(404, { error: 'not_found' });

    let id;
    try {
      id = decodeURIComponent(match[1]);
    } catch {
      return json(400, { error: 'bad_id' });
    }
    if (!ID_PATTERN.test(id)) return json(400, { error: 'bad_id' });

    try {
      const view = await queryPersonView(id);
      if (!view) return json(404, { error: 'not_found' });
      return json(200, maskNoteEmails(view), 'public, max-age=300');
    } catch (error) {
      log('person_view failed', id, error);
      return json(500, { error: 'internal' });
    }
  };
}
