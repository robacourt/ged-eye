import { maskNoteEmails } from './privacy.js';
import { AuthError, requireEditorOf } from './auth.js';
import { ApiError, errorJson, invalid, isObject, json, notModified, preflight, readJson } from './http.js';

/** Bump whenever masking or response shaping changes, so cached person views revalidate as new. */
export const VIEW_VERSION = 3;

const PERSON_ID = /^[A-Za-z0-9_-]{1,32}$/;
const CHANGE_ID = /^[1-9][0-9]{0,14}$/;
const POSITIVE_INTEGER = /^[1-9][0-9]{0,5}$/;
const EMAIL = /^[^\s@]+@[^\s@]+$/;
const ROLES = new Set(['admin', 'editor']);
const TOGGLE_VIAS = new Set(['history', 'keyboard']);
const SEARCH_MIN_CHARS = 2;
const SEARCH_MAX_CHARS = 100;
const SEARCH_LIMIT = 20;
const CHANGES_PAGE = 50;
const MAX_TEXT = 500;
const MAX_EMAIL = 254;
const MAX_KIND = 64;

const PUBLIC_REVALIDATE = 'public, max-age=0, must-revalidate';
const VARY_AUTH = { vary: 'Authorization' };

function decode(raw, onError) {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw onError();
  }
}

/** A query parameter, with an empty value treated as absent. */
function queryParam(url, name) {
  const value = url.searchParams.get(name);
  return value === null || value === '' ? null : value;
}

function parseLimit(url, max) {
  const value = queryParam(url, 'limit');
  if (value === null) return max;
  if (!POSITIVE_INTEGER.test(value)) throw invalid('limit', 'limit must be a positive whole number.');
  return Math.min(Number(value), max);
}

/** Weak comparison (RFC 9110 §13.1.2): a list of tags, `*`, or the tag with or without `W/`. */
function etagMatches(header, etag) {
  if (!header) return false;
  const opaque = (tag) => tag.trim().replace(/^W\//, '');
  const target = opaque(etag);
  return header.split(',').some((tag) => tag.trim() === '*' || opaque(tag) === target);
}

function validateNewEditor(body) {
  const { email, name = null, role = 'editor' } = body;
  if (typeof email !== 'string') throw invalid('email', 'Enter an email address.');
  const address = email.trim().toLowerCase();
  if (address.length > MAX_EMAIL || !EMAIL.test(address)) throw invalid('email', 'Enter an email address.');
  if (name !== null && typeof name !== 'string') throw invalid('name', 'name must be text.');
  const trimmedName = name?.trim() || null;
  if (trimmedName !== null && trimmedName.length > MAX_TEXT) throw invalid('name', `name must be at most ${MAX_TEXT} characters.`);
  if (!ROLES.has(role)) throw invalid('role', 'role must be admin or editor.');
  return { email: address, name: trimmedName, role };
}

/**
 * The api Function's router.
 *
 * @param db  (api/db.js createDb in production) {
 *   personView(id) → { view | null, version: { changeId, migration } }  (one statement, one snapshot)
 *   search(q, limit) → [{ id, name, birthYear, deathYear }]
 *   lookupEditor(email) → { email, name, role } | null
 *   listEditors() → [{ email, name, role, addedBy, addedAt }]
 *   addEditor({ email, name, role }, byEmail) → the new editor, or null if the email is already listed
 *   removeEditor(email, byEmail) → 'removed' | 'not_found' | 'last_admin' | 'not_an_admin'
 *   runChange(editor, kind, params) → { change: { id, summary, personIds }, view | null }
 *   toggle(editor, changeId, 'undo' | 'redo', via) → { id, summary, personIds, baseChangeId, kind }
 *   undoLast(editor), redoLast(editor) → { id, summary, personIds, baseChangeId, kind } | null
 *   listChanges({ before, limit, person }) → [{ id, createdAt, authorName, authorEmail, kind, via, summary,
 *     personIds, baseChangeId, undone }], newest first
 * }  Any of them may throw ApiError (sent as its status and body, unlogged); anything else is a logged 500.
 * @param authenticate  (request) → { email, name } | null; throws AuthError(401) for a bad token.
 *   Every route but /health and preflight authenticates first, before validating its input.
 */
export function createHandler({ db, authenticate, log = console.error }) {
  const lookupEditor = (email) => db.lookupEditor(email);
  const editorOf = (request) => requireEditorOf(request, authenticate, lookupEditor);

  async function requireAdminOf(request) {
    const editor = await editorOf(request);
    if (editor.role !== 'admin') throw new ApiError(403, 'not_an_admin');
    return editor;
  }

  async function getPerson({ request, params: [raw] }) {
    // First, so a bad token is always a 401, never a silent anonymous view.
    const user = await authenticate(request);
    const id = decode(raw, () => new ApiError(400, 'bad_id'));
    if (!PERSON_ID.test(id)) throw new ApiError(400, 'bad_id');

    const [editor, { view, version }] = await Promise.all([
      user ? db.lookupEditor(user.email) : null,
      db.personView(id)
    ]);
    if (!view) return json(404, { error: 'not_found' }, VARY_AUTH);
    if (editor) return json(200, { ...view, masked: false }, { ...VARY_AUTH, 'cache-control': 'private, no-store' });

    const etag = `W/"${VIEW_VERSION}.${version.migration}.${version.changeId}.${id}"`;
    const headers = { ...VARY_AUTH, 'cache-control': PUBLIC_REVALIDATE, etag };
    if (etagMatches(request.headers.get('if-none-match'), etag)) return notModified(headers);
    return json(200, { ...maskNoteEmails(view), masked: true }, headers);
  }

  async function search({ request, url }) {
    await authenticate(request);
    const q = (url.searchParams.get('q') ?? '').trim();
    const chars = [...q].length; // code points, so an emoji counts once
    if (chars < SEARCH_MIN_CHARS) throw invalid('q', `Type at least ${SEARCH_MIN_CHARS} characters.`);
    if (chars > SEARCH_MAX_CHARS) throw invalid('q', `Search text must be at most ${SEARCH_MAX_CHARS} characters.`);
    const limit = parseLimit(url, SEARCH_LIMIT);
    return json(200, { results: await db.search(q, limit) });
  }

  async function me({ request }) {
    const { email, name, role } = await editorOf(request);
    return json(200, { email, name, role });
  }

  async function listEditors({ request }) {
    await requireAdminOf(request);
    return json(200, { editors: await db.listEditors() });
  }

  async function addEditor({ request }) {
    const admin = await requireAdminOf(request);
    const editor = validateNewEditor(await readJson(request));
    const added = await db.addEditor(editor, admin.email);
    if (!added) throw new ApiError(409, 'already_an_editor', { email: editor.email });
    return json(201, { editor: added });
  }

  async function removeEditor({ request, params: [raw] }) {
    const admin = await requireAdminOf(request);
    const email = decode(raw, () => invalid('email', 'Malformed email address.')).trim().toLowerCase();
    if (email === admin.email) throw new ApiError(409, 'cannot_remove_self', { message: "You can't remove yourself." });
    // The database re-checks under a lock, so two admins can't remove each other at once.
    const outcome = await db.removeEditor(email, admin.email);
    switch (outcome) {
      case 'removed': return json(200, { ok: true });
      case 'not_found': throw new ApiError(404, 'not_found');
      case 'not_an_admin': throw new ApiError(403, 'not_an_admin');
      case 'last_admin': throw new ApiError(409, 'last_admin', { message: "The last admin can't be removed." });
      default: throw new Error(`removeEditor returned ${outcome}`);
    }
  }

  async function runChange({ request }) {
    const editor = await editorOf(request);
    const { kind, params } = await readJson(request);
    if (typeof kind !== 'string' || kind === '' || kind.length > MAX_KIND) throw invalid('kind', 'kind is required.');
    if (!isObject(params)) throw invalid('params', 'params must be an object.');
    const { change, view } = await db.runChange(editor, kind, params);
    return json(200, { change, view: view ? { ...view, masked: false } : null });
  }

  async function listChanges({ request, url }) {
    await editorOf(request);
    const before = queryParam(url, 'before');
    if (before !== null && !CHANGE_ID.test(before)) throw invalid('before', 'before must be a change id.');
    const person = queryParam(url, 'person');
    if (person !== null && !PERSON_ID.test(person)) throw invalid('person', 'person must be a person id.');
    const limit = parseLimit(url, CHANGES_PAGE);
    const changes = await db.listChanges({ before: before === null ? null : Number(before), limit, person });
    return json(200, { changes });
  }

  async function toggle({ request, params: [rawId, action] }) {
    const editor = await editorOf(request);
    if (!CHANGE_ID.test(rawId)) throw invalid('id', 'Not a change id.');
    const { via = 'history' } = await readJson(request);
    if (!TOGGLE_VIAS.has(via)) throw invalid('via', 'via must be history or keyboard.');
    const change = await db.toggle(editor, Number(rawId), action === 'revert' ? 'undo' : 'redo', via);
    return json(200, { change });
  }

  async function undo({ request }) {
    const editor = await editorOf(request);
    return json(200, { change: (await db.undoLast(editor)) ?? null });
  }

  async function redo({ request }) {
    const editor = await editorOf(request);
    return json(200, { change: (await db.redoLast(editor)) ?? null });
  }

  const routes = [
    ['GET', /^\/health$/, async () => json(200, { ok: true })],
    ['GET', /^\/person\/([^/]+)$/, getPerson],
    ['GET', /^\/search$/, search],
    ['GET', /^\/me$/, me],
    ['GET', /^\/editors$/, listEditors],
    ['POST', /^\/editors$/, addEditor],
    ['DELETE', /^\/editors\/([^/]+)$/, removeEditor],
    ['POST', /^\/changes$/, runChange],
    ['GET', /^\/changes$/, listChanges],
    ['POST', /^\/changes\/([^/]+)\/(revert|restore)$/, toggle],
    ['POST', /^\/undo$/, undo],
    ['POST', /^\/redo$/, redo]
  ];

  return async function handle(request) {
    if (request.method === 'OPTIONS') return preflight();
    const url = new URL(request.url);
    try {
      for (const [method, pattern, run] of routes) {
        if (method !== request.method) continue;
        const match = pattern.exec(url.pathname);
        if (match) return await run({ request, url, params: match.slice(1) });
      }
      return json(404, { error: 'not_found' });
    } catch (error) {
      // ApiErrors and AuthErrors are deliberate responses, not logged here; whoever throws a 5xx
      // ApiError logs it. Anything else is unexpected: logged, and a 500.
      if (error instanceof AuthError) return errorJson({ status: error.status, code: error.code });
      if (error instanceof ApiError) return errorJson(error);
      log('request failed', request.method, url.pathname, error);
      return json(500, { error: 'internal' });
    }
  };
}
