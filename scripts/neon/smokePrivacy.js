/**
 * Smoke test of privacy for living people (spec: specs/2026-10-10-living-privacy-design.md) against the api Function
 * deployed on a development branch. Picks, from the branch's database (read only), a living person with a birth date,
 * and a deceased person with a photo that shows a living person. Waits until the Function serves VIEW_VERSION 4
 * (old instances can serve for some minutes after a deploy), then checks that anonymous callers and the signed-in dev
 * viewer (not an editor) get the living person by name only, marked private, with no dates, notes, photos or avatar,
 * and without the shared photo on the deceased person's page; that search hides the living person's years from them;
 * and that the dev editor gets everything.
 *
 *   node --env-file=.env.local --env-file=.env.dev-accounts.local scripts/neon/smokePrivacy.js
 *
 * Env: NEON_BRANCH, NEON_AUTH_BASE_URL, NEON_FUNCTION_API_BASE_URL and DATABASE_URL (from .env.local),
 * DEV_EDITOR_PASSWORD and DEV_VIEWER_PASSWORD (from .env.dev-accounts.local). Refuses production and main.
 *
 * Prints a PASS or FAIL line per check, with statuses, ids and field names only: never a token, password or a
 * living person's details. Exits 1 on any failure, or 2 when it can't start.
 */
import pg from 'pg';
import { isMain } from './cli.js';
import { VIEW_VERSION } from '../../api/handler.js';
import { call, cannotStart, check, describe, runSmoke, signIn, trimSlash } from './smokeMedia.js';

const VIEWER = 'dev-viewer@example.test';
const CONVERGE_WAIT_MS = 15 * 60_000;
const CONVERGE_POLL_MS = 20_000;
// Fields a public living record may have; anything else is a leak.
const PUBLIC_LIVING = new Set(['id', 'name', 'givenName', 'surname', 'sex', 'parentIds', 'spouseIds', 'childIds',
  'parentFamilies', 'marriages', 'photos', 'avatarKey', 'living', 'private']);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function branchApi() {
  const env = process.env;
  const needed = ['NEON_BRANCH', 'NEON_AUTH_BASE_URL', 'NEON_FUNCTION_API_BASE_URL', 'DATABASE_URL', 'DEV_EDITOR_PASSWORD', 'DEV_VIEWER_PASSWORD'];
  const missing = needed.filter((name) => !env[name]);
  if (missing.length) cannotStart(`missing ${missing.join(', ')}; run with --env-file=.env.local --env-file=.env.dev-accounts.local`);
  if (['production', 'main'].includes(env.NEON_BRANCH)) cannotStart(`refusing to run against ${env.NEON_BRANCH}`);
  const api = trimSlash(env.NEON_FUNCTION_API_BASE_URL);
  if (!/^br-[a-z0-9-]+-api\./.test(new URL(api).host)) cannotStart('NEON_FUNCTION_API_BASE_URL is not a branch Function URL (br-…-api.…)');
  return { env, api, auth: trimSlash(env.NEON_AUTH_BASE_URL) };
}

/** → { living: { id, name }, shared: { id, mediaId } | null }, from the branch's database. */
async function pickPeople(databaseUrl) {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('begin read only');
    // A living person with a birth date whose name is unique enough to find by search.
    const { rows: [living] } = await client.query(`
      select p.id, p.display_name as name from person p
      where p.birth_date is not null and length(p.display_name) > 5 and person_is_living(p.id)
        and (select count(*) from person q where q.display_name = p.display_name) = 1
      order by (select count(*) from person_media pm where pm.person_id = p.id) desc, p.id
      limit 1`);
    const { rows: [shared] } = await client.query(`
      select pm.person_id as id, pm.media_id as "mediaId" from person_media pm
      where not person_is_living(pm.person_id)
        and exists (select 1 from person_media other where other.media_id = pm.media_id and person_is_living(other.person_id))
      order by pm.person_id, pm.media_id
      limit 1`);
    return { living, shared: shared ?? null };
  } finally {
    await client.end();
  }
}

/** Polls an anonymous view until its ETag carries VIEW_VERSION. → the last result */
async function waitForVersion(api, id) {
  const started = Date.now();
  for (;;) {
    const result = await call('GET', `${api}/person/${encodeURIComponent(id)}`);
    const etag = result.headers.get('etag') ?? '';
    if (etag.startsWith(`W/"${VIEW_VERSION}.`) || Date.now() - started > CONVERGE_WAIT_MS) return result;
    console.log(`waiting for the new Function (ETag version ${/^W\/"(\d+)\./.exec(etag)?.[1] ?? '?'})…`);
    await sleep(CONVERGE_POLL_MS);
  }
}

function checkPrivate(label, person) {
  const extra = Object.keys(person ?? {}).filter((key) => !PUBLIC_LIVING.has(key));
  check(`${label}: private, by name only`, person?.private === true && person?.living === true && extra.length === 0,
    extra.length ? `also shows ${extra.join(', ')}` : `private ${person?.private}`);
  check(`${label}: no photos or avatar`, Array.isArray(person?.photos) && person.photos.length === 0 && person.avatarKey === null,
    `${person?.photos?.length ?? 'no'} photos, avatar ${person?.avatarKey === null ? 'none' : 'shown'}`);
  const dated = (person?.marriages ?? []).filter((marriage) => Object.keys(marriage).some((key) => !['spouseId', 'familyId', 'childIds'].includes(key)));
  check(`${label}: marriages without dates or places`, dated.length === 0, `${dated.length} dated`);
}

async function main() {
  const { env, api, auth } = branchApi();
  console.log(`branch ${env.NEON_BRANCH}`);
  const { living, shared } = await pickPeople(env.DATABASE_URL);
  if (!check('found a living person with a birth date', Boolean(living), living?.id)) return;
  check('found a deceased person with a photo showing a living person', Boolean(shared), shared ? `${shared.id}, media ${shared.mediaId}` : 'none');

  const first = await waitForVersion(api, living.id);
  if (!check(`the Function serves view version ${VIEW_VERSION}`, (first.headers.get('etag') ?? '').startsWith(`W/"${VIEW_VERSION}.`),
    first.headers.get('etag') ?? describe(first))) return;

  const editor = await signIn(auth, env.DEV_EDITOR_PASSWORD);
  const viewer = await signIn(auth, env.DEV_VIEWER_PASSWORD, VIEWER);
  if (!editor || !viewer) return;

  // The living person: name only for the public, everything for an editor.
  for (const [label, token] of [['anonymous', undefined], ['viewer', viewer]]) {
    const result = await call('GET', `${api}/person/${encodeURIComponent(living.id)}`, { token });
    check(`${label} GET /person/${living.id}`, result.status === 200 && result.body?.masked === true, describe(result));
    checkPrivate(`${label} ${living.id}`, result.body?.person);
    const relatives = (result.body?.family ?? []).filter((relative) => relative.living !== false);
    const leaky = relatives.filter((relative) => 'birthDate' in relative || relative.avatarKey != null);
    check(`${label}: living relatives without birth dates or avatars`, leaky.length === 0, `${relatives.length} living, ${leaky.length} showing details`);
  }
  const full = await call('GET', `${api}/person/${encodeURIComponent(living.id)}`, { token: editor });
  check(`editor GET /person/${living.id}: the whole record`,
    full.status === 200 && full.body?.masked === false && Boolean(full.body?.person?.birthDate) && full.body?.person?.living === true
      && typeof full.body?.person?.livingEstimate === 'boolean' && !('private' in full.body.person),
    `${full.status}, birthDate ${full.body?.person?.birthDate ? 'shown' : 'missing'}, livingEstimate ${typeof full.body?.person?.livingEstimate}`);

  // Search: years hidden from the public.
  const q = encodeURIComponent(living.name);
  for (const [label, token] of [['anonymous', undefined], ['viewer', viewer]]) {
    const result = await call('GET', `${api}/search?q=${q}`, { token });
    const hit = result.body?.results?.find((r) => r.id === living.id);
    check(`${label} search finds ${living.id} without years`, Boolean(hit) && hit.birthYear === null && hit.deathYear === null && hit.living === true,
      hit ? `birthYear ${hit.birthYear === null ? 'hidden' : 'shown'}` : describe(result));
  }
  const editorSearch = await call('GET', `${api}/search?q=${q}`, { token: editor });
  const editorHit = editorSearch.body?.results?.find((r) => r.id === living.id);
  check(`editor search shows ${living.id}'s birth year`, typeof editorHit?.birthYear === 'number', editorHit ? `birthYear ${editorHit.birthYear}` : describe(editorSearch));

  // A shared photo: off the deceased person's public page, on their editor page.
  if (shared) {
    const path = `${api}/person/${encodeURIComponent(shared.id)}`;
    const publicView = await call('GET', path);
    const publicIds = (publicView.body?.person?.photos ?? []).map((photo) => Number(photo.id));
    check(`anonymous ${shared.id}: photo ${shared.mediaId} hidden`, publicView.status === 200 && !publicIds.includes(Number(shared.mediaId)),
      `${publicView.status}, ${publicIds.length} photos`);
    const editorView = await call('GET', path, { token: editor });
    const editorIds = (editorView.body?.person?.photos ?? []).map((photo) => Number(photo.id));
    check(`editor ${shared.id}: photo ${shared.mediaId} shown`, editorIds.includes(Number(shared.mediaId)), `${editorIds.length} photos`);
  }
}

if (isMain(import.meta.url)) runSmoke(main);
