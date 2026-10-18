import { maskNoteEmails, redactLiving, redactRelative, redactSearchResult } from './privacy.js';
import { familyGraph, shortestPath } from './relationship.js';
import { AuthError, requireEditorOf } from './auth.js';
import { ApiError, errorJson, invalid, isObject, json, notModified, preflight, readJson } from './http.js';
import { createMailer, grantedEmail, inviteEmail, isSafeAddress, requestEmail, sanitizeName, SITE_URL } from './mailer.js';

/** Bump whenever masking or response shaping changes, so cached person views revalidate as new. */
export const VIEW_VERSION = 4;

const PERSON_ID = /^[A-Za-z0-9_-]{1,32}$/;
const CHANGE_ID = /^[1-9][0-9]{0,14}$/;
const REQUEST_ID = CHANGE_ID;
const POSITIVE_INTEGER = /^[1-9][0-9]{0,5}$/;
const EMAIL = /^[^\s@]+@[^\s@]+$/;
const ROLES = new Set(['admin', 'editor', 'viewer']);
const TOGGLE_VIAS = new Set(['history', 'keyboard']);
const SEARCH_MIN_CHARS = 2;
const SEARCH_MAX_CHARS = 100;
const SEARCH_LIMIT = 20;
const CHANGES_PAGE = 50;
const MAX_TEXT = 500;
const MAX_NOTE = 500;
const MAX_EMAIL = 254;
const MAX_KIND = 64;
// Invites per admin per hour, counted per Function instance: a brake on mail sent in the site's name, not a quota.
const INVITE_LIMIT = 20;
const INVITE_WINDOW_MS = 60 * 60 * 1000;

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

/**
 * An invite (POST /editors): { email, name, role, message }, where the address must also be one the mailer will
 * send to, so an invite can't be added and never sent. → { email, name, role, message }
 */
function validateNewEditor(body) {
  const { email, name = null, role = 'editor' } = body;
  if (typeof email !== 'string') throw invalid('email', 'Enter an email address.');
  const address = email.trim().toLowerCase();
  if (address.length > MAX_EMAIL || !EMAIL.test(address) || !isSafeAddress(address)) throw invalid('email', 'Enter an email address.');
  if (name !== null && typeof name !== 'string') throw invalid('name', 'name must be text.');
  const trimmedName = name?.trim() || null;
  if (trimmedName !== null && trimmedName.length > MAX_TEXT) throw invalid('name', `name must be at most ${MAX_TEXT} characters.`);
  if (!ROLES.has(role)) throw invalid('role', 'role must be admin, editor or viewer.');
  return { email: address, name: trimmedName, role, message: optionalNote(body.message ?? null, 'message') };
}

/** Optional text someone writes to someone else: trimmed, at most 500 characters (code points), no NUL. → the text, or null */
function optionalNote(value, field) {
  if (value === null) return null;
  if (typeof value !== 'string') throw invalid(field, `${field} must be text.`);
  const trimmed = value.trim();
  if (trimmed.includes('\u0000')) throw invalid(field, `The ${field} has a character that can't be stored.`);
  if ([...trimmed].length > MAX_NOTE) throw invalid(field, `Keep the ${field} to ${MAX_NOTE} characters or fewer.`);
  return trimmed === '' ? null : trimmed;
}

/** An access request's optional note (see optionalNote). */
const validateNote = (body) => optionalNote(body.note ?? null, 'note');

/**
 * The api Function's router.
 *
 * @param db  (api/db.js createDb in production) {
 *   personView(id) → { view | null, version: { changeId, migration } }  (one statement, one snapshot)
 *   search(q, limit) → [{ id, name, birthYear, deathYear, living }]
 *   lookupEditor(email) → { email, name, role } | null
 *   familyLinks() → { families: [{ id, partner1_id, partner2_id }], children: [{ family_id, child_id }] }
 *   relativeRecords(ids) → [relative_record | null], in order
 *   listEditors() → [{ email, name, role, addedBy, addedAt }]
 *   addEditor({ email, name, role }, byEmail) → { outcome: 'added' | 'listed' (already on the list) |
 *     'not_an_admin', editor | null }; when they end up able to edit, marks their pending access request granted
 *   removeEditor(email, byEmail) → 'removed' | 'not_found' | 'last_admin' | 'not_an_admin'
 *   changeEditorRole(email, role, byEmail) → { outcome: 'changed' | 'unchanged' | 'not_found' | 'last_admin' |
 *     'not_an_admin', editor | null }
 *   latestAccessRequest(email) → request | null, the newest, where a request is { id, email, name, note,
 *     status: 'pending' | 'granted' | 'dismissed', createdAt, resolvedBy, resolvedByName, resolvedAt }
 *     (resolvedBy: the resolving admin's email; resolvedByName: their editor name, else their email)
 *   pendingRequestCount() → the number of pending requests from people who aren't editors
 *   createAccessRequest({ email, name, note }) → { outcome: 'created' | 'pending' | 'editor' | 'limited', request | null }
 *     (checked in that order: an editor, a pending request, the rate limits; then inserted)
 *   listAccessRequests() → [{ id, email, name, note, createdAt }]: pending, from non-editors, oldest first, ≤ 100
 *   resolveAccessRequest(id, 'grant' | 'dismiss', adminEmail) → { outcome: 'granted' | 'dismissed' |
 *     'already_resolved' | 'not_found' | 'not_an_admin', request | null, editor | null, wasEditor }
 *     (one transaction; re-checks that adminEmail is an admin; a grant adds the requester as an editor)
 *   listRequestRecipients() → [email]: who is emailed about a new access request (editor.notify_access_requests)
 *   runChange(editor, kind, params) → { change: { id, summary, personIds }, view | null }
 *   toggle(editor, changeId, 'undo' | 'redo', via) → { id, summary, personIds, baseChangeId, kind }
 *   undoLast(editor), redoLast(editor) → { id, summary, personIds, baseChangeId, kind } | null
 *   listChanges({ before, limit, person }) → [{ id, createdAt, authorName, authorEmail, kind, via, summary,
 *     personIds, baseChangeId, undone }], newest first
 * }  Any of them may throw ApiError (sent as its status and body, unlogged); anything else is a logged 500.
 * @param authenticate  (request) → { email, name } | null; throws AuthError(401) for a bad token.
 *   Every route but /health and preflight authenticates first, before validating its input.
 * @param mailer  (api/mailer.js createMailer) { mode: 'smtp' | 'log', send({ to, subject, text }) → Promise };
 *   by default it only logs.
 * @param waitUntil  (promise) → void: keeps the invocation alive after the response until `promise`
 *   settles (@neon/functions in production). Mail is sent only through it, never awaited by a response,
 *   and its promise never rejects: failures are logged.
 */
export function createHandler({ db, authenticate, mailer = createMailer({}), waitUntil = () => {}, log = console.error }) {
  const lookupEditor = (email) => db.lookupEditor(email);
  const invitesSent = new Map(); // admin email → times of their invites in the last hour, on this instance

  /** The admin's invites still in the window (pruned). */
  function recentInvites(email, now) {
    const times = (invitesSent.get(email) ?? []).filter((time) => now - time < INVITE_WINDOW_MS);
    if (times.length) invitesSent.set(email, times);
    else invitesSent.delete(email);
    return times;
  }
  const editorOf = (request) => requireEditorOf(request, authenticate, lookupEditor);

  /**
   * After the response, sends `build(to)` (→ { to, subject, text }; may throw) to each address that
   * `recipients()` (→ a promise of [to]) gives, one message each, in turn. Any failure is logged and
   * skipped; the response never waits for any of it.
   */
  function sendLater(what, recipients, build) {
    const sending = (async () => {
      let addresses;
      try {
        addresses = await recipients();
      } catch (error) {
        log(`could not find who to send the ${what} mail to`, error);
        return;
      }
      for (const to of addresses) {
        try {
          await mailer.send(build(to));
        } catch (error) {
          log(`could not send the ${what} mail to`, to, error);
        }
      }
    })();
    try {
      waitUntil(sending);
    } catch (error) {
      log('waitUntil failed, so the mail may be cut short', error);
    }
  }

  /** Who to email about a new access request; with nobody set to be told, a log line says so. */
  async function requestRecipients() {
    const recipients = await db.listRequestRecipients();
    if (!recipients.length) log('nobody is set to be emailed about access requests (editor.notify_access_requests)');
    return recipients;
  }

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

    // Anyone on the list (viewers, editors and admins) sees the whole view.
    const [listed, { view, version }] = await Promise.all([
      user ? db.lookupEditor(user.email) : null,
      db.personView(id)
    ]);
    if (!view) return json(404, { error: 'not_found' }, VARY_AUTH);
    if (listed) return json(200, { ...view, masked: false }, { ...VARY_AUTH, 'cache-control': 'private, no-store' });

    const etag = `W/"${VIEW_VERSION}.${version.migration}.${version.changeId}.${id}"`;
    const headers = { ...VARY_AUTH, 'cache-control': PUBLIC_REVALIDATE, etag };
    if (etagMatches(request.headers.get('if-none-match'), etag)) return notModified(headers);
    return json(200, { ...redactLiving(maskNoteEmails(view)), masked: true }, headers);
  }

  async function search({ request, url }) {
    const user = await authenticate(request);
    const q = (url.searchParams.get('q') ?? '').trim();
    const chars = [...q].length; // code points, so an emoji counts once
    if (chars < SEARCH_MIN_CHARS) throw invalid('q', `Type at least ${SEARCH_MIN_CHARS} characters.`);
    if (chars > SEARCH_MAX_CHARS) throw invalid('q', `Search text must be at most ${SEARCH_MAX_CHARS} characters.`);
    const limit = parseLimit(url, SEARCH_LIMIT);
    const [listed, results] = await Promise.all([user ? db.lookupEditor(user.email) : null, db.search(q, limit)]);
    // Only people on the list (viewers too) see living people's years.
    return json(200, { results: listed ? results : results.map(redactSearchResult) }, VARY_AUTH);
  }

  /** A request for edit access as /me shows it: { status, createdAt } of the latest, or null. */
  async function latestRequestOf(email) {
    const latest = await db.latestAccessRequest(email);
    return latest ? { status: latest.status, createdAt: latest.createdAt } : null;
  }

  /**
   * How `to` is related to `from` (spec: specs/2026-10-18-relationship-search-design.md): the people on the
   * shortest family path between them, each with how they are related to the one before. Living people are by
   * name only for anyone not on the list, as relatives are in a person view.
   */
  async function relationship({ request, url }) {
    const user = await authenticate(request);
    const ids = ['from', 'to'].map((name) => {
      const id = queryParam(url, name);
      if (id === null || !PERSON_ID.test(id)) throw invalid(name, `${name} must be a person id.`);
      return id;
    });
    const [listed, links, ends] = await Promise.all([
      user ? db.lookupEditor(user.email) : null,
      db.familyLinks(),
      db.relativeRecords(ids)
    ]);
    if (ends.some((record) => !record)) throw new ApiError(404, 'not_found');
    const path = shortestPath(familyGraph(links.families, links.children), ids[0], ids[1]);
    if (!path) return json(200, { path: null }, VARY_AUTH);
    const records = await db.relativeRecords(path.map((entry) => entry.id));
    return json(200, {
      path: records.map((record, i) => ({ ...(listed ? record : redactRelative(record)), step: path[i].step }))
    }, VARY_AUTH);
  }

  async function me({ request }) {
    const user = await authenticate(request);
    if (!user) throw new AuthError(401, 'unauthenticated');
    const listed = await db.lookupEditor(user.email);
    // A signed-in account not on the list also learns where their latest access request stands.
    if (!listed) throw new ApiError(403, 'not_an_editor', { email: user.email, accessRequest: await latestRequestOf(user.email) });
    const account = { email: user.email, name: listed.name ?? user.name, role: listed.role };
    switch (listed.role) {
      case 'admin': return json(200, { ...account, pendingRequests: await db.pendingRequestCount() });
      // A viewer may ask for edit access, so they learn where that stands too.
      case 'viewer': return json(200, { ...account, accessRequest: await latestRequestOf(user.email) });
      default: return json(200, account);
    }
  }

  async function requestAccess({ request }) {
    const user = await authenticate(request);
    if (!user) throw new AuthError(401, 'unauthenticated');
    const note = validateNote(await readJson(request));
    const { outcome, request: saved } = await db.createAccessRequest({ email: user.email, name: sanitizeName(user.name), note });
    switch (outcome) {
      case 'created':
        sendLater('access request', requestRecipients, (to) => requestEmail({ to, request: saved, siteUrl: SITE_URL }));
        return json(201, { request: saved });
      case 'pending': return json(200, { request: saved });
      case 'editor': throw new ApiError(409, 'already_an_editor', { email: user.email });
      case 'limited': throw new ApiError(429, 'too_many_requests');
      default: throw new Error(`createAccessRequest returned ${outcome}`);
    }
  }

  async function listAccessRequests({ request }) {
    await requireAdminOf(request);
    return json(200, { requests: await db.listAccessRequests() });
  }

  async function resolveAccessRequest({ request, params: [rawId, action] }) {
    const admin = await requireAdminOf(request);
    if (!REQUEST_ID.test(rawId)) throw invalid('id', 'Not a request id.');
    const result = await db.resolveAccessRequest(Number(rawId), action, admin.email);
    switch (result.outcome) {
      case 'granted':
        if (!result.wasEditor) {
          const to = result.request.email;
          sendLater('access granted', async () => [to], () => grantedEmail({ to, siteUrl: SITE_URL }));
        }
        return json(200, { request: result.request, editor: result.editor });
      case 'dismissed': return json(200, { request: result.request });
      case 'already_resolved':
        throw new ApiError(409, 'already_resolved', {
          status: result.request.status, resolvedBy: result.request.resolvedBy, resolvedByName: result.request.resolvedByName
        });
      case 'not_found': throw new ApiError(404, 'not_found');
      case 'not_an_admin': throw new ApiError(403, 'not_an_admin');
      default: throw new Error(`resolveAccessRequest returned ${result.outcome}`);
    }
  }

  async function listEditors({ request }) {
    await requireAdminOf(request);
    return json(200, { editors: await db.listEditors() });
  }

  /** Invites someone: adds them to the editors list, then emails them (after the response) how to sign in. */
  async function addEditor({ request }) {
    const admin = await requireAdminOf(request);
    const { message, ...editor } = validateNewEditor(await readJson(request));
    if (recentInvites(admin.email, Date.now()).length >= INVITE_LIMIT) throw new ApiError(429, 'too_many_invites');
    const { outcome, editor: added } = await db.addEditor(editor, admin.email);
    switch (outcome) {
      case 'added': break;
      case 'listed': throw new ApiError(409, 'already_an_editor', { email: editor.email });
      case 'not_an_admin': throw new ApiError(403, 'not_an_admin');
      default: throw new Error(`addEditor returned ${outcome}`);
    }
    invitesSent.set(admin.email, [...recentInvites(admin.email, Date.now()), Date.now()]);
    sendLater('invite', async () => [added.email],
      (to) => inviteEmail({ to, role: added.role, inviter: { email: admin.email, name: admin.name }, message }));
    return json(201, { editor: added });
  }

  async function changeEditorRole({ request, params: [raw] }) {
    const admin = await requireAdminOf(request);
    const email = decode(raw, () => invalid('email', 'Malformed email address.')).trim().toLowerCase();
    const { role } = await readJson(request);
    if (!ROLES.has(role)) throw invalid('role', 'role must be admin, editor or viewer.');
    if (email === admin.email) throw new ApiError(409, 'cannot_change_self', { message: "You can't change your own access." });
    // The database re-checks under a lock, as for removal, so two admins can't demote each other at once.
    const { outcome, editor } = await db.changeEditorRole(email, role, admin.email);
    switch (outcome) {
      case 'changed':
      case 'unchanged': return json(200, { editor });
      case 'not_found': throw new ApiError(404, 'not_found');
      case 'not_an_admin': throw new ApiError(403, 'not_an_admin');
      case 'last_admin': throw new ApiError(409, 'last_admin', { message: "The last admin can't be made an editor." });
      default: throw new Error(`changeEditorRole returned ${outcome}`);
    }
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
    // `mail` says only whether SMTP credentials are configured ('smtp') or mail is logged ('log').
    ['GET', /^\/health$/, async () => json(200, { ok: true, mail: mailer.mode })],
    ['GET', /^\/person\/([^/]+)$/, getPerson],
    ['GET', /^\/search$/, search],
    ['GET', /^\/relationship$/, relationship],
    ['GET', /^\/me$/, me],
    ['GET', /^\/editors$/, listEditors],
    ['POST', /^\/editors$/, addEditor],
    ['DELETE', /^\/editors\/([^/]+)$/, removeEditor],
    ['POST', /^\/editors\/([^/]+)\/role$/, changeEditorRole],
    ['POST', /^\/access-requests$/, requestAccess],
    ['GET', /^\/access-requests$/, listAccessRequests],
    ['POST', /^\/access-requests\/([^/]+)\/(grant|dismiss)$/, resolveAccessRequest],
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
      // Not `not_found`, which callers read as "no such person or editor".
      return json(404, { error: 'no_route' });
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
