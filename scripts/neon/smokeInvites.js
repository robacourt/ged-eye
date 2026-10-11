/**
 * Smoke test of invites and access levels (spec: specs/2026-10-11-invites-design.md) against the api Function
 * deployed on a development branch, with mail only logged (deployed without the SMTP secrets). Signs in as the dev
 * admin and the dev viewer (not an editor), waits for this version of the Function (old instances can serve for
 * some minutes after a deploy), then checks:
 *   - the admin invites the viewer as an editor, with a message: 201;
 *   - the viewer's /me is then 200 as an editor, and a second invite is 409 already_an_editor;
 *   - the admin makes the viewer an admin (/me says so), then an editor again;
 *   - the same role again is 200; the admin's own role is 409 cannot_change_self; an unknown address is 404;
 *   - the Function logs show one "mail (not sent)" invite line to the viewer.
 *
 *   node --env-file=.env.local --env-file=.env.dev-accounts.local scripts/neon/smokeInvites.js
 *
 * Env: NEON_BRANCH, NEON_AUTH_BASE_URL and NEON_FUNCTION_API_BASE_URL (from .env.local), DEV_VIEWER_PASSWORD and
 * DEV_ADMIN_PASSWORD (from .env.dev-accounts.local). Refuses production and main, and a Function that sends mail.
 * The log check needs the neon CLI.
 *
 * It leaves the viewer a viewer again (DELETE /editors/…, as the admin). Prints a PASS or FAIL line per check, with
 * statuses only: never a token or password. Exits 1 on any failure, or 2 when it can't start.
 */
import { execFileSync } from 'node:child_process';
import { ROOT, isMain } from './cli.js';
import { call, cannotStart, check, codeOf, describe, runSmoke, safeMessage, signIn, trimSlash } from './smokeMedia.js';

const VIEWER = 'dev-viewer@example.test';
const ADMIN = 'dev-admin@example.test';
const MESSAGE = 'Smoke test (scripts/neon/smokeInvites.js): welcome!';
const INVITE_LINE = `mail (not sent): ${VIEWER}, You're invited to the A'Court family tree`;
const CONVERGE_WAIT_MS = 15 * 60_000;
const POLL_MS = 20_000;
const LOG_WAIT_MS = 180_000;
const LOG_POLL_MS = 10_000;
const NEON_TIMEOUT_MS = 60_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const meDetail = (result) => `${result.status} ${result.status === 200 ? `role ${result.body?.role}` : codeOf(result)}`;
const rolePath = (api, email) => `${api}/editors/${encodeURIComponent(email)}/role`;

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

/**
 * Waits until the Function is this version: an unknown path answers 404 no_route (older ones said not_found).
 * → the last answer
 */
async function waitForFunction(api) {
  const started = Date.now();
  for (;;) {
    const probe = await call('GET', `${api}/no-such-route`);
    if (probe.body?.error === 'no_route' || Date.now() - started > CONVERGE_WAIT_MS) return probe;
    console.log(`waiting for the new Function (${probe.status} ${codeOf(probe)})…`);
    await sleep(POLL_MS);
  }
}

/** The branch's invite log lines to the viewer since `since`, via the neon CLI. → count */
function inviteLines(branch, since) {
  const output = execFileSync('neon', ['logs', 'query', '--branch', branch, '--source', 'function', '--start-time', since,
    '--body-contains', INVITE_LINE, '--limit', '100', '-o', 'json'],
  { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: NEON_TIMEOUT_MS });
  return (JSON.parse(output).logs ?? []).filter((record) => String(record.message ?? '').includes(INVITE_LINE)).length;
}

async function checkInviteLog(branch, since) {
  let count = null;
  let failure = null;
  for (let waited = 0; ; waited += LOG_POLL_MS) {
    try {
      count = inviteLines(branch, since);
      failure = null;
      if (count >= 1) break;
    } catch (error) {
      failure = `neon logs query failed: ${safeMessage(error).slice(0, 120)}`;
    }
    if (waited >= LOG_WAIT_MS) break;
    await sleep(LOG_POLL_MS);
  }
  check('Function logs: one "mail (not sent)" invite line to the viewer', count === 1,
    `${count ?? 'no'} line(s)${failure ? `; last query: ${failure}` : ''}`);
}

async function main() {
  const { env, api, auth } = branchApi();
  const since = new Date().toISOString();
  console.log(`branch ${env.NEON_BRANCH}, api Function ${new URL(api).host}`);

  const health = await call('GET', `${api}/health`);
  if (!check('GET /health says mail is logged', health.status === 200 && health.body?.mail === 'log', `${health.status} mail ${health.body?.mail}`)) return;

  const viewer = await signIn(auth, env.DEV_VIEWER_PASSWORD, VIEWER);
  const admin = await signIn(auth, env.DEV_ADMIN_PASSWORD, ADMIN);
  if (!viewer || !admin) return;

  const version = await waitForFunction(api);
  if (!check('an unknown path is 404 no_route (the Function is this version)', version.status === 404 && version.body?.error === 'no_route',
    `${version.status} ${codeOf(version)}`)) return;
  const self = await call('POST', rolePath(api, ADMIN), { token: admin, body: { role: 'admin' } });
  if (!check("the admin's own role change is 409 cannot_change_self", self.status === 409 && self.body?.error === 'cannot_change_self',
    `${self.status} ${codeOf(self)}`)) return;

  const before = await call('GET', `${api}/me`, { token: viewer });
  if (!check('viewer GET /me is 403 not_an_editor to start with', before.status === 403 && before.body?.error === 'not_an_editor', meDetail(before))) return;

  let invited = false;
  try {
    const invite = await call('POST', `${api}/editors`, { token: admin, body: { email: VIEWER, role: 'editor', message: MESSAGE } });
    invited = invite.status === 201;
    check('admin invites the viewer as an editor: 201', invited && invite.body?.editor?.email === VIEWER && invite.body?.editor?.role === 'editor'
      && invite.body?.editor?.addedBy === ADMIN, describe(invite));
    if (!invited) return;

    const me = await call('GET', `${api}/me`, { token: viewer });
    check('viewer GET /me is now 200 as an editor', me.status === 200 && me.body?.role === 'editor', meDetail(me));

    const again = await call('POST', `${api}/editors`, { token: admin, body: { email: VIEWER, role: 'admin' } });
    check('a second invite is 409 already_an_editor', again.status === 409 && again.body?.error === 'already_an_editor', `${again.status} ${codeOf(again)}`);

    const promote = await call('POST', rolePath(api, VIEWER), { token: admin, body: { role: 'admin' } });
    check('admin makes the viewer an admin: 200', promote.status === 200 && promote.body?.editor?.role === 'admin', describe(promote));
    const promoted = await call('GET', `${api}/me`, { token: viewer });
    check('viewer GET /me says admin', promoted.status === 200 && promoted.body?.role === 'admin', meDetail(promoted));

    const same = await call('POST', rolePath(api, VIEWER), { token: admin, body: { role: 'admin' } });
    check('the same role again is 200', same.status === 200 && same.body?.editor?.role === 'admin', describe(same));

    const demote = await call('POST', rolePath(api, VIEWER), { token: admin, body: { role: 'editor' } });
    check('admin makes the viewer an editor again: 200', demote.status === 200 && demote.body?.editor?.role === 'editor', describe(demote));

    const unknown = await call('POST', rolePath(api, 'nobody-smoke@example.test'), { token: admin, body: { role: 'admin' } });
    check('an unknown address is 404', unknown.status === 404 && unknown.body?.error === 'not_found', `${unknown.status} ${codeOf(unknown)}`);

    const byViewer = await call('POST', rolePath(api, ADMIN), { token: viewer, body: { role: 'editor' } });
    check("an editor can't change access: 403 not_an_admin", byViewer.status === 403 && byViewer.body?.error === 'not_an_admin',
      `${byViewer.status} ${codeOf(byViewer)}`);

    await checkInviteLog(env.NEON_BRANCH, since);
  } finally {
    if (invited) {
      const removed = await call('DELETE', `${api}/editors/${encodeURIComponent(VIEWER)}`, { token: admin });
      check('clean-up: admin DELETE /editors/<viewer> is 200', removed.status === 200, `${removed.status}${removed.status === 200 ? '' : ` ${codeOf(removed)}`}`);
      const back = await call('GET', `${api}/me`, { token: viewer });
      check('clean-up: viewer GET /me is 403 again', back.status === 403 && back.body?.error === 'not_an_editor', meDetail(back));
    }
  }
}

if (isMain(import.meta.url)) await runSmoke(main);
