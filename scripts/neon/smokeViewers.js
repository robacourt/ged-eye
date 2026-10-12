/**
 * Smoke test of the viewer access level (spec: specs/2026-10-12-viewers-design.md) against the api and media
 * Functions deployed on a development branch, with mail only logged. Signs in as the dev admin and the dev viewer
 * (not on the list to start with), waits for the Function that knows the viewer level (old instances can serve for
 * some minutes after a deploy), then checks:
 *   - the admin invites the dev viewer as a viewer: 201; their /me is then 200 as a viewer;
 *   - they get a living person's whole view (a birth date, not private), privately;
 *   - they may not edit, read the history, or upload a photo: 403 not_an_editor from both Functions;
 *   - they ask for edit access (201); the admin sees it and grants it; their /me is then 200 as an editor.
 *
 *   node --env-file=.env.local --env-file=.env.dev-accounts.local scripts/neon/smokeViewers.js
 *
 * Env: NEON_BRANCH, NEON_AUTH_BASE_URL, NEON_FUNCTION_API_BASE_URL and DATABASE_URL (from .env.local),
 * DEV_VIEWER_PASSWORD and DEV_ADMIN_PASSWORD (from .env.dev-accounts.local). Refuses production and main, and a
 * Function that sends mail. Reads the database only to pick a living person.
 *
 * It leaves the dev viewer off the list again (DELETE /editors/…, as the admin), and dismisses their request if a
 * check stopped it before the grant. The request rows stay, and count towards the limit of 3 requests per email in
 * 24 hours. Prints a PASS or FAIL line per check, with statuses only: never a token, password or a living person's
 * details. Exits 1 on any failure, or 2 when it can't start.
 */
import pg from 'pg';
import { isMain } from './cli.js';
import { call, cannotStart, check, codeOf, describe, runSmoke, signIn, trimSlash } from './smokeMedia.js';

const VIEWER = 'dev-viewer@example.test';
const ADMIN = 'dev-admin@example.test';
const UNKNOWN = 'nobody-smoke@example.test';
const CONVERGE_WAIT_MS = 15 * 60_000;
const POLL_MS = 20_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const meDetail = (result) => `${result.status} ${result.status === 200 ? `role ${result.body?.role}` : codeOf(result)}`;

function branchFunctions() {
  const env = process.env;
  const needed = ['NEON_BRANCH', 'NEON_AUTH_BASE_URL', 'NEON_FUNCTION_API_BASE_URL', 'DATABASE_URL', 'DEV_VIEWER_PASSWORD', 'DEV_ADMIN_PASSWORD'];
  const missing = needed.filter((name) => !env[name]);
  if (missing.length) cannotStart(`missing ${missing.join(', ')}; run with --env-file=.env.local --env-file=.env.dev-accounts.local`);
  if (['production', 'main'].includes(env.NEON_BRANCH)) cannotStart(`refusing to run against ${env.NEON_BRANCH}`);
  const api = trimSlash(env.NEON_FUNCTION_API_BASE_URL);
  const branchHost = /^(br-[a-z0-9-]+)-api\./.exec(new URL(api).host)?.[1];
  if (!branchHost) cannotStart('NEON_FUNCTION_API_BASE_URL is not a branch Function URL (br-…-api.…)');
  return { env, api, media: api.replace(`${branchHost}-api.`, `${branchHost}-media.`), auth: trimSlash(env.NEON_AUTH_BASE_URL) };
}

/** A living person with a birth date, from the branch's database (read only). → id | null */
async function livingPersonId(databaseUrl) {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('begin read only');
    const { rows: [row] } = await client.query(
      'select id from person where birth_date is not null and person_is_living(id) order by id limit 1');
    return row?.id ?? null;
  } finally {
    await client.end();
  }
}

/** Waits until setting an unknown address's role to viewer is a 404 (older Functions refuse the role: 400). */
async function waitForViewerLevel(api, admin) {
  const started = Date.now();
  for (;;) {
    const probe = await call('POST', `${api}/editors/${encodeURIComponent(UNKNOWN)}/role`, { token: admin, body: { role: 'viewer' } });
    if (probe.status === 404 || Date.now() - started > CONVERGE_WAIT_MS) return probe;
    console.log(`waiting for the new Function (${probe.status} ${codeOf(probe)})…`);
    await sleep(POLL_MS);
  }
}

async function main() {
  const { env, api, media, auth } = branchFunctions();
  console.log(`branch ${env.NEON_BRANCH}`);

  const health = await call('GET', `${api}/health`);
  if (!check('GET /health says mail is logged', health.status === 200 && health.body?.mail === 'log', `${health.status} mail ${health.body?.mail}`)) return;
  const personId = await livingPersonId(env.DATABASE_URL);
  if (!check('found a living person with a birth date', Boolean(personId), personId ?? 'none')) return;

  const viewer = await signIn(auth, env.DEV_VIEWER_PASSWORD, VIEWER);
  const admin = await signIn(auth, env.DEV_ADMIN_PASSWORD, ADMIN);
  if (!viewer || !admin) return;

  const probe = await waitForViewerLevel(api, admin);
  if (!check('the Function knows the viewer level (an unknown address is 404)', probe.status === 404 && probe.body?.error === 'not_found',
    `${probe.status} ${codeOf(probe)}`)) return;

  const before = await call('GET', `${api}/me`, { token: viewer });
  if (!check('dev viewer GET /me is 403 not_an_editor to start with', before.status === 403 && before.body?.error === 'not_an_editor', meDetail(before))) return;

  let invited = false;
  let requestId = null;
  let granted = false;
  try {
    const invite = await call('POST', `${api}/editors`, { token: admin, body: { email: VIEWER, role: 'viewer' } });
    invited = invite.status === 201;
    if (!check('admin invites the dev viewer as a viewer: 201', invited && invite.body?.editor?.role === 'viewer', describe(invite))) return;

    const me = await call('GET', `${api}/me`, { token: viewer });
    check('their GET /me is 200 as a viewer, with where a request stands', me.status === 200 && me.body?.role === 'viewer' && 'accessRequest' in (me.body ?? {}),
      meDetail(me));

    const person = await call('GET', `${api}/person/${encodeURIComponent(personId)}`, { token: viewer });
    check(`they get ${personId}'s whole view, privately`, person.status === 200 && person.body?.masked === false
      && Boolean(person.body?.person?.birthDate) && !('private' in (person.body?.person ?? {}))
      && person.headers.get('cache-control') === 'private, no-store',
    `${person.status}, masked ${person.body?.masked}, birthDate ${person.body?.person?.birthDate ? 'shown' : 'missing'}`);

    const refusals = [
      ['POST /changes', 'POST', `${api}/changes`, { kind: 'update_person', params: { id: personId } }],
      ['GET /changes', 'GET', `${api}/changes`],
      ['POST /undo', 'POST', `${api}/undo`],
      ['GET /editors', 'GET', `${api}/editors`],
      ['media POST /uploads', 'POST', `${media}/uploads`, { fileName: 'a.jpg', contentType: 'image/jpeg', byteSize: 1 }]
    ];
    for (const [label, method, url, body] of refusals) {
      const res = await call(method, url, { token: viewer, body });
      check(`a viewer's ${label} is 403 not_an_editor`, res.status === 403 && res.body?.error === 'not_an_editor', `${res.status} ${codeOf(res)}`);
    }

    const asked = await call('POST', `${api}/access-requests`, { token: viewer, body: { note: 'Smoke test (scripts/neon/smokeViewers.js): may I edit?' } });
    requestId = asked.body?.request?.id ?? null;
    if (!check('the viewer asks for edit access: 201, pending', asked.status === 201 && asked.body?.request?.status === 'pending', describe(asked))) return;

    const list = await call('GET', `${api}/access-requests`, { token: admin });
    check("the admin's list has it", list.status === 200 && (list.body?.requests ?? []).some((r) => r.id === requestId),
      `${list.status}, ${list.body?.requests?.length ?? 0} listed`);

    const grant = await call('POST', `${api}/access-requests/${requestId}/grant`, { token: admin });
    granted = grant.status === 200;
    check('the admin grants it: the viewer becomes an editor', granted && grant.body?.editor?.role === 'editor' && grant.body?.request?.status === 'granted',
      `${describe(grant)}, editor ${grant.body?.editor?.role}`);

    const after = await call('GET', `${api}/me`, { token: viewer });
    check('their GET /me is then 200 as an editor', after.status === 200 && after.body?.role === 'editor', meDetail(after));
  } finally {
    if (requestId !== null && !granted) {
      const dismissed = await call('POST', `${api}/access-requests/${requestId}/dismiss`, { token: admin });
      check('clean-up: admin dismisses the request', dismissed.status === 200, describe(dismissed));
    }
    if (invited) {
      const removed = await call('DELETE', `${api}/editors/${encodeURIComponent(VIEWER)}`, { token: admin });
      check('clean-up: admin DELETE /editors/<dev viewer> is 200', removed.status === 200, `${removed.status}${removed.status === 200 ? '' : ` ${codeOf(removed)}`}`);
      const back = await call('GET', `${api}/me`, { token: viewer });
      check('clean-up: dev viewer GET /me is 403 again', back.status === 403 && back.body?.error === 'not_an_editor', meDetail(back));
    }
  }
}

if (isMain(import.meta.url)) await runSmoke(main);
