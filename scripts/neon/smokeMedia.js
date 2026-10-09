/**
 * Smoke test of the media Function deployed on a development branch (photos plan, Task 5). Signs in as the dev
 * editor, then checks health, auth, upload slots, a presigned PUT, processing (location stripped, three public
 * keys), repeat processing, dedupe by sha, avatars and Cancel against the live Function, and that the
 * sweep-incoming trigger exists.
 *
 *   node --env-file=.env.local --env-file=.env.dev-accounts.local scripts/neon/smokeMedia.js [--media-url <url>]
 *
 * Env: NEON_BRANCH, NEON_AUTH_BASE_URL, NEON_FUNCTION_API_BASE_URL and AWS_ENDPOINT_URL_S3 (from .env.local),
 * DEV_EDITOR_PASSWORD (from .env.dev-accounts.local), and optionally MEDIA_URL (default: the api Function's URL
 * with -api. replaced by -media.). Refuses production, and a media URL on a different branch from the api's.
 *
 * Prints a PASS or FAIL line per check, with statuses and shapes only: never a presigned URL, token or password.
 * Exits 1 on any failure, or 2 when it can't start. It writes nothing to the database, and leaves its test
 * objects in the branch's bucket (the hourly sweep deletes any incoming/ ones).
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { avatarKeyFor } from '../../media/crop.js';
import { hasLocation } from '../../media/imaging.js';
import { UUID } from '../../media/types.js';
import { ROOT, argValue, isMain } from './cli.js';

const BUCKET = 'ged-eye-media';
const ORIGIN = 'http://localhost:5175'; // a trusted origin of the dev branches' Auth
const EDITOR_EMAIL = 'dev-editor@example.test';
const IMMUTABLE = 'public, max-age=31536000, immutable';
const TRIGGER = 'sweep-incoming';
const TIMEOUT_MS = 60_000;
const WIDTH = 1000;
const HEIGHT = 800;
const CROP = { x: 0.1, y: 0.1, w: 0.4, h: 0.5 }; // a 400px square of the 1000×800 test image
const MEDIA_FIELDS = ['mediaId', 'sha256', 'ext', 'objectKey', 'displayKey', 'thumbKey', 'contentType', 'byteSize',
  'width', 'height', 'fileName', 'caption', 'date'];

let failures = 0;

/** Prints PASS or FAIL for `name` with `detail` (a status or shape, never a secret), and counts failures. → ok */
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : `: ${detail}`}`);
  return Boolean(ok);
}

/** Exits with a message, before any check has run. */
function cannotStart(message) {
  console.error(`cannot start: ${message}`);
  process.exit(2);
}

const trimSlash = (url) => url.replace(/\/+$/, '');
const shapeOf = (value) => (value !== null && typeof value === 'object' ? `{${Object.keys(value).join(', ')}}` : String(value));
const codeOf = (result) => result.body?.error ?? 'no error code';
const describe = (result) => `${result.status} ${result.status < 300 ? shapeOf(result.body) : codeOf(result)}`;
// Error messages could quote a URL, and a presigned one carries its signature.
const safeMessage = (error) => String(error?.message ?? error).replace(/https?:\/\/\S+/g, '<url>');

/** A JSON request with a deadline. → { status, headers, body (parsed JSON, or null) } */
async function call(method, url, { token, body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  return { status: response.status, headers: response.headers, body: parsed };
}

/** An unauthenticated HEAD of a public URL. → { status, headers } */
async function head(url) {
  const response = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(TIMEOUT_MS) });
  return { status: response.status, headers: response.headers };
}

/** A 1000×800 JPEG carrying a GPS latitude, in a random colour so each run uploads new bytes. → Buffer */
function gpsJpeg() {
  return sharp({ create: { width: WIDTH, height: HEIGHT, channels: 3, background: `#${randomBytes(3).toString('hex')}` } })
    .jpeg()
    .withExif({ IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '51/1 30/1 0/1' } })
    .toBuffer();
}

/**
 * Signs the dev editor in on the branch's Auth (Managed Better Auth) and takes the JWT that get-session sends
 * in set-auth-jwt. → the JWT, or null after a FAIL.
 */
async function signIn(authBase, password) {
  const response = await fetch(`${authBase}/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ email: EDITOR_EMAIL, password }),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  const body = await response.json().catch(() => null); // holds the session token: read only for an error code
  if (!check(`sign in as ${EDITOR_EMAIL}`, response.ok, `${response.status}${response.ok ? '' : ` ${body?.code ?? ''}`}`)) {
    return null;
  }
  const cookie = response.headers.getSetCookie().map((setCookie) => setCookie.split(';')[0]).join('; ');
  const session = await fetch(`${authBase}/get-session`, {
    headers: { cookie, origin: ORIGIN },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  await session.arrayBuffer();
  const jwt = session.headers.get('set-auth-jwt');
  check('GET /get-session gives a JWT', session.ok && Boolean(jwt), `${session.status}, set-auth-jwt ${jwt ? 'present' : 'missing'}`);
  return session.ok ? jwt : null;
}

/** Gets an upload slot for `bytes` (a JPEG) and PUTs them to it. → the uploadId, or null after a FAIL. */
async function upload(media, token, bytes, fileName, label) {
  const slot = await call('POST', `${media}/uploads`, { token, body: { fileName, contentType: 'image/jpeg', byteSize: bytes.length } });
  const { uploadId, url, headers } = slot.body ?? {};
  const slotOk = slot.status === 200 && UUID.test(uploadId ?? '') && typeof url === 'string' && url.startsWith('https://')
    && headers !== null && typeof headers === 'object' && Object.keys(headers).length === 1 && headers['Content-Type'] === 'image/jpeg';
  if (!check(`${label}: POST /uploads`, slotOk, `${describe(slot)}, headers ${shapeOf(headers ?? null)} ${headers?.['Content-Type'] ?? ''}`)) {
    return null;
  }
  // Exactly the returned headers: Content-Length (also signed) is set by fetch, as a browser does.
  const put = await fetch(url, { method: 'PUT', headers, body: bytes, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const putText = await put.text();
  const s3Code = /<Code>([^<]*)<\/Code>/.exec(putText)?.[1] ?? '';
  return check(`${label}: PUT to the presigned URL`, put.status === 200, `${put.status}${put.ok ? '' : ` ${s3Code}`}`) ? uploadId : null;
}

/** Checks /process's `media` against the spec's shape for the new (unrecorded) JPEG. */
function checkMedia(label, media, { sha256, fileName }) {
  const expected = {
    mediaId: null,
    sha256,
    ext: 'jpg',
    objectKey: `originals/${sha256}.jpg`,
    displayKey: `display/${sha256}.webp`,
    thumbKey: `thumbs/${sha256}.webp`,
    contentType: 'image/jpeg',
    width: WIDTH,
    height: HEIGHT,
    fileName,
    caption: null,
    date: null
  };
  if (media === null || typeof media !== 'object') return check(label, false, shapeOf(media ?? null));
  const wrong = MEDIA_FIELDS.filter((field) => (field === 'byteSize'
    ? !(Number.isSafeInteger(media.byteSize) && media.byteSize > 0)
    : media[field] !== expected[field]));
  const extra = Object.keys(media).filter((field) => !MEDIA_FIELDS.includes(field));
  const detail = wrong.length || extra.length
    ? `wrong ${wrong.map((field) => `${field}=${JSON.stringify(media[field])}`).join(', ') || 'none'}; extra ${extra.join(', ') || 'none'}`
    : `mediaId null, ${media.width}×${media.height}, ${media.byteSize} bytes, keys originals/ display/ thumbs/ <sha>`;
  return check(label, wrong.length === 0 && extra.length === 0, detail);
}

/**
 * HEADs one stored key on the public bucket URL and checks its type and immutable caching, plus `extra(headers)`
 * (→ problems, null for none), which `checked` names.
 */
async function checkPublic(publicUrl, key, contentType, extra = () => [], checked = '') {
  const result = await head(publicUrl(key));
  const problems = result.status === 200 ? [
    result.headers.get('content-type') === contentType ? null : `content-type ${result.headers.get('content-type')}`,
    result.headers.get('cache-control') === IMMUTABLE ? null : `cache-control ${result.headers.get('cache-control')}`,
    ...extra(result.headers)
  ].filter(Boolean) : [];
  const folder = key.split('/')[0];
  return check(`public HEAD ${folder}/`, result.status === 200 && problems.length === 0,
    `${result.status}${problems.length ? `, ${problems.join(', ')}` : `, ${contentType}, immutable${checked}`}`);
}

/** `neon triggers list` on `branch` shows the sweep trigger, retrying an unreachable Neon API. */
function checkTrigger(branch) {
  const name = `neon triggers list shows ${TRIGGER}`;
  let output = null;
  let failure = '';
  for (let attempt = 1; attempt <= 3 && output === null; attempt++) {
    try {
      output = execFileSync('neon', ['triggers', 'list', '--branch', branch], {
        cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: TIMEOUT_MS
      });
    } catch (error) {
      failure = `neon exited ${error.status ?? error.code}${/Could not reach the Neon API/.test(String(error.stderr)) ? ' (Neon API unreachable)' : ''}`;
    }
  }
  if (output === null) return check(name, false, failure);
  const cells = output.split('\n').map((line) => line.trim().split(/\s+/)).find((row) => row[1] === TRIGGER);
  const ok = Boolean(cells) && cells[2] === 'schedule' && cells[3] === 'media' && cells[4] === '/sweep' && cells.includes('true');
  return check(name, ok, cells ? cells.slice(1).join(' ') : 'not listed');
}

async function main() {
  const env = process.env;
  const needed = ['NEON_BRANCH', 'NEON_AUTH_BASE_URL', 'NEON_FUNCTION_API_BASE_URL', 'AWS_ENDPOINT_URL_S3', 'DEV_EDITOR_PASSWORD'];
  const missing = needed.filter((name) => !env[name]);
  if (missing.length) cannotStart(`missing ${missing.join(', ')}; run with --env-file=.env.local --env-file=.env.dev-accounts.local`);
  if (['production', 'main'].includes(env.NEON_BRANCH)) cannotStart(`refusing to run against ${env.NEON_BRANCH}`);
  const api = trimSlash(env.NEON_FUNCTION_API_BASE_URL);
  const branchHost = /^(br-[a-z0-9-]+)-api\./.exec(new URL(api).host)?.[1];
  if (!branchHost) cannotStart('NEON_FUNCTION_API_BASE_URL is not a branch Function URL (br-…-api.…)');
  const media = trimSlash(argValue('--media-url', env.MEDIA_URL) ?? api.replace(`${branchHost}-api.`, `${branchHost}-media.`));
  if (!new URL(media).host.startsWith(`${branchHost}-media.`)) cannotStart('the media URL is not the media Function on the api Function\'s branch');
  const storage = trimSlash(env.AWS_ENDPOINT_URL_S3);
  const publicUrl = (key) => `${storage}/${BUCKET}/${key}`;
  console.log(`branch ${env.NEON_BRANCH}, media Function ${new URL(media).host}`);

  // The Function is up, and refuses anonymous uploads.
  const health = await call('GET', `${media}/health`);
  check('GET /health', health.status === 200 && health.body?.ok === true, describe(health));
  const anonymous = await call('POST', `${media}/uploads`, { body: { fileName: 'a.jpg', contentType: 'image/jpeg', byteSize: 1 } });
  check('POST /uploads without a token is 401', anonymous.status === 401, describe(anonymous));

  // An editor's JWT from the branch's Auth.
  const token = await signIn(trimSlash(env.NEON_AUTH_BASE_URL), env.DEV_EDITOR_PASSWORD);
  if (!token) return;
  const me = await call('GET', `${api}/me`, { token });
  if (!check('api GET /me: an editor', me.status === 200 && ['editor', 'admin'].includes(me.body?.role),
    `${me.status} ${me.status === 200 ? `role ${me.body?.role}` : codeOf(me)}`)) return;

  // A type outside the list is refused before any upload.
  const text = await call('POST', `${media}/uploads`, { token, body: { fileName: 'note.txt', contentType: 'text/plain', byteSize: 2 } });
  check('POST /uploads for a 2-byte text/plain is 400 unsupported_type', text.status === 400 && text.body?.error === 'unsupported_type', describe(text));

  // A JPEG with GPS: upload, process, and the three public keys.
  const jpeg = await gpsJpeg();
  const sha256 = createHash('sha256').update(jpeg).digest('hex');
  const fileName = 'smoke-media.jpg';
  check('the test JPEG carries location', hasLocation(await sharp(jpeg).metadata()), `${jpeg.length} bytes`);
  const firstId = await upload(media, token, jpeg, fileName, 'first upload');
  if (!firstId) return;
  const processed = await call('POST', `${media}/uploads/${firstId}/process`, { token, body: { fileName } });
  const stored = processed.body?.media ?? null;
  if (!check('POST /uploads/<id>/process', processed.status === 200, describe(processed))) return;
  if (!checkMedia('process: the media shape', stored, { sha256, fileName })) return;
  await checkPublic(publicUrl, stored.objectKey, 'image/jpeg', (headers) => [
    headers.get('content-disposition')?.startsWith('inline') ? null : `content-disposition ${headers.get('content-disposition')}`,
    headers.get('x-amz-meta-width') === String(WIDTH) && headers.get('x-amz-meta-height') === String(HEIGHT)
      ? null : `metadata ${headers.get('x-amz-meta-width')}×${headers.get('x-amz-meta-height')}`
  ], `, inline, metadata ${WIDTH}×${HEIGHT}`);
  await checkPublic(publicUrl, stored.displayKey, 'image/webp');
  await checkPublic(publicUrl, stored.thumbKey, 'image/webp');
  const original = await fetch(publicUrl(stored.objectKey), { signal: AbortSignal.timeout(TIMEOUT_MS) });
  const originalMeta = original.ok ? await sharp(Buffer.from(await original.arrayBuffer())).metadata() : {};
  check('the stored original has no location or other EXIF', original.ok && !originalMeta.exif && !hasLocation(originalMeta),
    `${original.status}, EXIF ${originalMeta.exif ? 'present' : 'none'}, location ${original.ok && hasLocation(originalMeta) ? 'present' : 'none'}`);

  // The upload is gone once processed.
  const repeat = await call('POST', `${media}/uploads/${firstId}/process`, { token, body: { fileName } });
  check('process again is 404 not_found', repeat.status === 404 && repeat.body?.error === 'not_found', describe(repeat));

  // The same file again: no media row is recorded yet, so mediaId stays null, with the same sha and keys.
  const secondId = await upload(media, token, jpeg, fileName, 'same file again');
  if (secondId) {
    const again = await call('POST', `${media}/uploads/${secondId}/process`, { token, body: { fileName } });
    if (check('same file again: process', again.status === 200, describe(again))) checkMedia('same file again: the media shape', again.body?.media ?? null, { sha256, fileName });
  }

  // Avatars are idempotent: the key is a function of the original and the crop.
  const avatarRequest = { objectKey: stored.objectKey, crop: CROP };
  const avatar = await call('POST', `${media}/avatars`, { token, body: avatarRequest });
  const expectedAvatar = avatarKeyFor(sha256, CROP);
  check('POST /avatars', avatar.status === 200 && avatar.body?.avatarKey === expectedAvatar,
    `${describe(avatar)}${avatar.body?.avatarKey === expectedAvatar ? ', avatarKeyFor(sha, crop)' : ''}`);
  const avatarAgain = await call('POST', `${media}/avatars`, { token, body: avatarRequest });
  check('POST /avatars again: the same key', avatarAgain.status === 200 && avatarAgain.body?.avatarKey === expectedAvatar, describe(avatarAgain));
  await checkPublic(publicUrl, expectedAvatar, 'image/webp');

  // Cancel deletes an uploaded but unprocessed file, and is 204 again once it's gone.
  const freshId = await upload(media, token, jpeg, fileName, 'cancel');
  if (freshId) {
    const before = await head(publicUrl(`incoming/${freshId}`));
    const cancelled = await call('DELETE', `${media}/uploads/${freshId}`, { token });
    const after = await head(publicUrl(`incoming/${freshId}`));
    check('DELETE /uploads/<fresh id> is 204 and the upload is gone', before.status === 200 && cancelled.status === 204 && after.status === 404,
      `HEAD before ${before.status}, DELETE ${cancelled.status}, HEAD after ${after.status}`);
    const cancelledAgain = await call('DELETE', `${media}/uploads/${freshId}`, { token });
    check('DELETE again is still 204', cancelledAgain.status === 204, String(cancelledAgain.status));
  }

  checkTrigger(env.NEON_BRANCH);
}

if (isMain(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    check('no unexpected error', false, `${error?.name ?? 'Error'}: ${safeMessage(error)}`);
  }
  console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
}
