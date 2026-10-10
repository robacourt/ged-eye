/**
 * Smoke test of edit access requests (spec: specs/2026-10-10-access-requests-design.md) against the api Function
 * deployed on a development branch, with mail only logged (deployed without the SMTP secrets). Signs in as the dev
 * viewer (not an editor) and the dev admin, then checks: /health says mail is logged; the viewer's /me is a 403
 * with no pending request; the viewer asks (201) and asks again (200, the same request); /me shows it pending; the
 * admin's /me counts it and GET /access-requests lists it; Grant is 200 and a second Grant 409 already_resolved;
 * the viewer's /me is then 200 as an editor; and the branch's Function logs show one "mail (not sent)" line per
 * admin for the request (none for the repeat) and one to the viewer for the grant.
 *
 *   node --env-file=.env.local --env-file=.env.dev-accounts.local scripts/neon/smokeAccess.js
 *
 * Env: NEON_BRANCH, NEON_AUTH_BASE_URL and NEON_FUNCTION_API_BASE_URL (from .env.local), DEV_VIEWER_PASSWORD and
 * DEV_ADMIN_PASSWORD (from .env.dev-accounts.local). Refuses production and main. The log check needs the neon CLI.
 *
 * It leaves the viewer a viewer again: it removes them from the editors (DELETE /editors/…, as the admin) once
 * granted, or dismisses the request if a check stopped it before the grant. The request rows stay, and count
 * towards the limit of 3 requests per email in 24 hours, so it can run 3 times a day.
 *
 * Prints a PASS or FAIL line per check, with statuses and counts only: never a token or password. Exits 1 on any
 * failure, or 2 when it can't start.
 */
import { execFileSync } from 'node:child_process';
import { ROOT, isMain } from './cli.js';
import { call, cannotStart, check, codeOf, describe, runSmoke, safeMessage, signIn, trimSlash } from './smokeMedia.js';

const VIEWER = 'dev-viewer@example.test';
const ADMIN = 'dev-admin@example.test';
const NOTE = 'Smoke test (scripts/neon/smokeAccess.js): please add me.';
const NOT_SENT = 'mail (not sent): ';
const LOG_WAIT_MS = 180_000;
const LOG_POLL_MS = 10_000;
const NEON_TIMEOUT_MS = 60_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const meDetail = (result) => `${result.status} ${result.status === 200 ? `role ${result.body?.role}` : codeOf(result)}`;

/** Checks the environment (see the header). → { env, api (no trailing slash), auth (Auth base URL) } */
function branchApi() {
  const env = process.env;
  const needed = ['NEON_BRANCH', 'NEON_AUTH_BASE_URL', 'NEON_FUNCTION_API_BASE_URL', 'DEV_VIEWER_PASSWORD', 'DEV_ADMIN_PASSWORD'];
  const missing = needed.filter((name) => !env[name]);
  if (missing.length) cannotStart(`missing ${missing.join(', ')}; run with --env-file=.env.local --env-file=.env.dev-accounts.local`);
  if (['production', 'main'].includes(env.NEON_BRANCH)) cannotStart(`refusing to run against ${env.NEON_BRANCH}`);
  const api = trimSlash(env.NEON_FUNCTION_API_BASE_URL);
  if (!/^br-[a-z0-9-]+-api\./.test(new URL(api).host)) cannotStart('NEON_FUNCTION_API_BASE_URL is not a branch Function URL (br-…-api.…)');
  return { env, api, auth: trimSlash(env.NEON_AUTH_BASE_URL) };
}

/** The branch's "mail (not sent)" Function log lines since `since` (ISO), via the neon CLI. → [message] */
function notSentLines(branch, since) {
  const lines = [];
  let cursor = null;
  do {
    const args = ['logs', 'query', '--branch', branch, '--source', 'function', '--start-time', since,
      '--body-contains', NOT_SENT, '--limit', '1000', '-o', 'json'];
    if (cursor) args.push('--cursor', cursor);
    const output = execFileSync('neon', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: NEON_TIMEOUT_MS });
    const page = JSON.parse(output);
    for (const record of page.logs ?? []) lines.push(String(record.message ?? ''));
    cursor = page.is_truncated ? page.next_cursor : null;
  } while (cursor);
  return lines;
}

/**
 * Waits for the Function logs to show a request line to each of `admins` and one grant line since `since`, then
 * checks there are exactly those: the repeat request sent none.
 */
async function checkMailLogs(branch, since, admins) {
  const name = 'Function logs: one "mail (not sent)" line per admin for the request, one to the viewer for the grant';
  const requestLine = (to) => `${NOT_SENT}${to}, Edit access request from ${VIEWER}`;
  const grantLine = `${NOT_SENT}${VIEWER}, You can now edit the A'Court family tree`;
  let counts = null;
  let failure = null;
  for (let waited = 0; ; waited += LOG_POLL_MS) {
    try {
      const lines = notSentLines(branch, since);
      counts = {
        request: lines.filter((line) => line.includes(`, Edit access request from ${VIEWER}`)).length,
        unmailed: admins.filter((to) => !lines.some((line) => line.includes(requestLine(to)))).length,
        grant: lines.filter((line) => line.includes(grantLine)).length
      };
      failure = null;
      if (counts.unmailed === 0 && counts.grant >= 1) break;
    } catch (error) {
      const unreachable = /Could not reach the Neon API/.test(String(error.stderr));
      failure = `neon logs query failed${unreachable ? ' (Neon API unreachable)' : `: ${safeMessage(error).slice(0, 120)}`}`;
    }
    if (waited >= LOG_WAIT_MS) break;
    await sleep(LOG_POLL_MS);
  }
  if (!counts) return check(name, false, failure ?? 'no logs');
  return check(name, counts.request === admins.length && counts.unmailed === 0 && counts.grant === 1,
    `${counts.request} request line(s) for ${admins.length} admin(s), ${counts.unmailed} admin(s) without one, ` +
    `${counts.grant} grant line(s)${failure ? `; last query: ${failure}` : ''}`);
}

async function main() {
  const { env, api, auth } = branchApi();
  const since = new Date().toISOString();
  console.log(`branch ${env.NEON_BRANCH}, api Function ${new URL(api).host}`);

  const health = await call('GET', `${api}/health`);
  check('GET /health says mail is logged', health.status === 200 && health.body?.ok === true && health.body?.mail === 'log',
    `${health.status} mail ${health.body?.mail}`);

  const viewer = await signIn(auth, env.DEV_VIEWER_PASSWORD, VIEWER);
  const admin = await signIn(auth, env.DEV_ADMIN_PASSWORD, ADMIN);
  if (!viewer || !admin) return;

  // The viewer starts as a viewer with nothing pending: a resolved request from an earlier run is fine.
  const before = await call('GET', `${api}/me`, { token: viewer });
  const earlier = before.body?.accessRequest;
  if (!check('viewer GET /me is 403 not_an_editor, with no pending request',
    before.status === 403 && before.body?.error === 'not_an_editor' && (earlier === null || (earlier?.status && earlier.status !== 'pending')),
    `${meDetail(before)}, accessRequest ${earlier === null ? 'null' : earlier?.status ?? 'missing'}${earlier ? ' (from an earlier run)' : ''}`)) return;

  let requestId = null;
  let granted = false;
  try {
    const asked = await call('POST', `${api}/access-requests`, { token: viewer, body: { note: NOTE } });
    const request = asked.body?.request;
    if (!check('viewer POST /access-requests with a note is 201, pending', asked.status === 201 && request?.status === 'pending'
      && request?.email === VIEWER && request?.note === NOTE && Number.isSafeInteger(request?.id), describe(asked))) return;
    requestId = request.id;

    const again = await call('POST', `${api}/access-requests`, { token: viewer, body: { note: 'again' } });
    check('viewer POST /access-requests again is 200 with the same request', again.status === 200 && again.body?.request?.id === requestId
      && again.body?.request?.note === NOTE, `${describe(again)}${again.body?.request?.id === requestId ? ', same id' : ''}`);

    const pending = await call('GET', `${api}/me`, { token: viewer });
    check('viewer GET /me shows the request pending', pending.status === 403 && pending.body?.accessRequest?.status === 'pending'
      && pending.body?.accessRequest?.createdAt === request.createdAt, `${meDetail(pending)}, accessRequest ${pending.body?.accessRequest?.status}`);

    const adminMe = await call('GET', `${api}/me`, { token: admin });
    check('admin GET /me has pendingRequests >= 1', adminMe.status === 200 && adminMe.body?.role === 'admin' && adminMe.body?.pendingRequests >= 1,
      `${meDetail(adminMe)}, pendingRequests ${adminMe.body?.pendingRequests}`);

    const list = await call('GET', `${api}/access-requests`, { token: admin });
    const listed = (list.body?.requests ?? []).find((entry) => entry.id === requestId);
    check('admin GET /access-requests lists it', list.status === 200 && listed?.email === VIEWER && listed?.note === NOTE,
      `${list.status}, ${list.body?.requests?.length ?? 0} listed, ${listed ? 'ours included' : 'ours missing'}`);

    const editors = await call('GET', `${api}/editors`, { token: admin });
    const admins = (editors.body?.editors ?? []).filter((editor) => editor.role === 'admin').map((editor) => editor.email);
    check('admin GET /editors (to count the admins mailed)', editors.status === 200 && admins.length > 0, `${editors.status}, ${admins.length} admin(s)`);

    const grant = await call('POST', `${api}/access-requests/${requestId}/grant`, { token: admin });
    granted = grant.status === 200;
    check('admin grants it: 200, granted, viewer added as an editor', grant.status === 200 && grant.body?.request?.status === 'granted'
      && grant.body?.request?.resolvedBy === ADMIN && grant.body?.editor?.email === VIEWER && grant.body?.editor?.role === 'editor',
      `${describe(grant)}, request ${grant.body?.request?.status}, editor ${grant.body?.editor?.role}`);

    const regrant = await call('POST', `${api}/access-requests/${requestId}/grant`, { token: admin });
    check('a second grant is 409 already_resolved, granted by the admin', regrant.status === 409 && regrant.body?.error === 'already_resolved'
      && regrant.body?.status === 'granted' && regrant.body?.resolvedBy === ADMIN && typeof regrant.body?.resolvedByName === 'string',
      `${regrant.status} ${codeOf(regrant)}, status ${regrant.body?.status}`);

    const after = await call('GET', `${api}/me`, { token: viewer });
    check('viewer GET /me is now 200 as an editor', after.status === 200 && after.body?.role === 'editor', meDetail(after));

    await checkMailLogs(env.NEON_BRANCH, since, admins);
  } finally {
    // Leave the viewer a viewer, with nothing pending.
    if (granted) {
      const removed = await call('DELETE', `${api}/editors/${encodeURIComponent(VIEWER)}`, { token: admin });
      check('clean-up: admin DELETE /editors/<viewer> is 200', removed.status === 200, `${removed.status}${removed.status === 200 ? '' : ` ${codeOf(removed)}`}`);
      const back = await call('GET', `${api}/me`, { token: viewer });
      check('clean-up: viewer GET /me is 403 again', back.status === 403 && back.body?.error === 'not_an_editor', meDetail(back));
    } else if (requestId !== null) {
      const dismissed = await call('POST', `${api}/access-requests/${requestId}/dismiss`, { token: admin });
      check('clean-up: admin dismisses the request', dismissed.status === 200, describe(dismissed));
    }
  }
}

if (isMain(import.meta.url)) await runSmoke(main);
