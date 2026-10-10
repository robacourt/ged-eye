/**
 * One-off backfill of display images (and the missing thumbnails, which are the TIFFs') for the media imported
 * before the photos release. See specs/2026-10-09-photos-design.md (Backfill).
 *
 *   npm run backfill-media -- --dry-run              # list what would be backfilled; downloads and writes nothing
 *   npm run backfill-media -- --report-gps           # list the image originals with location data; writes nothing
 *   npm run backfill-media -- --confirm <db host>    # the backfill: <db host> is the host it prints first
 *
 * The `--` matters: without it npm takes --dry-run as its own option and passes the script nothing, which the
 * script refuses (it would otherwise be a real run).
 *
 * The database (DATABASE_URL_UNPOOLED) and the bucket (AWS_ENDPOINT_URL_S3, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)
 * both come from the env file: npm run backfill-media reads .env.local, and for another branch run
 *   node --env-file=<file> scripts/neon/backfillMedia.js [--dry-run | --report-gps | --confirm <db host>]
 * It prints NEON_BRANCH and both hosts first, and refuses (exit status 2, before writing anything) when a bucket
 * setting is missing (so nothing falls back to ~/.aws), when the database reports a different branch id
 * (neon.branch_id) from the bucket endpoint's, or when the real run's --confirm isn't the database host.
 *
 * It first makes and uploads every derivative with no transaction open, 4 images at a time, then records the rows
 * in one short transaction, so the global write lock is held for well under a second (and a busy lock is retried
 * 3 times). Derivative keys come from the sha and only rows without a display image are selected, so a re-run
 * carries on where an earlier one stopped and records nothing when there is nothing to do. An image sharp can't
 * read is reported and skipped (exit status 1).
 */
import pg from 'pg';
import { derivatives, fileHasLocation } from '../../media/imaging.js';
import { createStorage } from '../../media/storage.js';
import { IMMUTABLE, ImagingError } from '../../media/types.js';
import { isMain } from './cli.js';

const CONCURRENCY = 4;
const PROGRESS_EVERY = 50;
const RECORD_RETRIES = 3;
const LOCK_NOT_AVAILABLE = '55P03'; // lock_timeout expired
const WEBP = Object.freeze({ contentType: 'image/webp', cacheControl: IMMUTABLE });

/** "1 image", "2 images". */
const plural = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;

const PENDING_SQL = `
  select id, sha256, object_key, content_type, thumb_key
  from media
  where display_key is null and content_type like 'image/%'
  order by id`;

const IMAGES_SQL = `select id, object_key from media where content_type like 'image/%' order by id`;

// Only rows still without a display image: one given one since the select (by an upload of the same file) is left alone.
const UPDATE_SQL = `
  update media m
  set display_key = r.display_key, thumb_key = coalesce(m.thumb_key, r.thumb_key), width = r.width, height = r.height
  from jsonb_to_recordset($1::jsonb) as r (id bigint, display_key text, thumb_key text, width int, height int)
  where m.id = r.id and m.display_key is null`;

/** A reason not to start: main() prints it and exits with status 2, before writing anything. */
export class Refusal extends Error {
  constructor(message) {
    super(message);
    this.name = 'Refusal';
  }
}

const NPM_FLAGS = ['npm_config_dry_run', 'npm_config_report_gps', 'npm_config_confirm'];

/**
 * `npm run backfill-media --dry-run` (no `--`) gives npm the option and the script no arguments, which would be a
 * real run. npm leaves its reading of the option in npm_config_<name>, so throws Refusal when any of those is set.
 */
export function checkNpmFlags(env) {
  const set = NPM_FLAGS.filter(name => env[name] !== undefined);
  if (set.length) {
    throw new Refusal(`npm took this script's options as its own (${set.join(', ')}); put -- before them, as in ` +
      'npm run backfill-media -- --dry-run');
  }
}

const SWITCHES = new Map([['--dry-run', 'dryRun'], ['--report-gps', 'reportGps']]);

/**
 * Strict command-line parsing (argv without node and the script), so a mistyped --dry-run can't start a real run.
 * Throws Refusal on an unknown or repeated argument, --confirm without a value, both modes at once, or --confirm
 * with either mode (it only applies to the real run).
 * @returns {{ dryRun: boolean, reportGps: boolean, confirm?: string }}
 */
export function parseArgs(argv) {
  const args = { dryRun: false, reportGps: false };
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (seen.has(flag)) throw new Refusal(`Duplicate argument: ${flag}`);
    seen.add(flag);
    if (SWITCHES.has(flag)) {
      args[SWITCHES.get(flag)] = true;
    } else if (flag === '--confirm') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Refusal('--confirm needs the database host after it');
      args.confirm = value;
    } else {
      throw new Refusal(`Unknown argument: ${flag} (expected --dry-run, --report-gps or --confirm <db host>)`);
    }
  }
  if (args.dryRun && args.reportGps) throw new Refusal('Pass --dry-run or --report-gps, not both');
  if (args.confirm !== undefined && (args.dryRun || args.reportGps)) throw new Refusal('--confirm only applies to the real run');
  return args;
}

const STORAGE_ENV = ['AWS_ENDPOINT_URL_S3', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'];
const BRANCH_ID = /^br-[a-z0-9-]+$/;

/** The URL's host, or null when it is unset or not a URL. */
function hostOf(url) {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

/** Where the env points: → { branchName, databaseUrl, databaseHost, storageHost }, each null when unset or unusable. */
export function settingsFrom(env) {
  const databaseHost = hostOf(env.DATABASE_URL_UNPOOLED);
  return {
    branchName: env.NEON_BRANCH || null,
    databaseUrl: databaseHost ? env.DATABASE_URL_UNPOOLED : null,
    databaseHost,
    storageHost: hostOf(env.AWS_ENDPOINT_URL_S3)
  };
}

/** The line printed before anything else: NEON_BRANCH and the two hosts (never a credential). */
export const describeSettings = ({ branchName, databaseHost, storageHost }) =>
  `branch ${branchName ?? '(unset)'}, database ${databaseHost ?? '(unset)'}, storage ${storageHost ?? '(unset)'}`;

/**
 * Throws Refusal unless the env names a database and every bucket setting (so the S3 client can't fall back to
 * ~/.aws or another profile), and, for the real run, --confirm is the database host.
 */
export function checkSettings(settings, env, args) {
  if (!settings.databaseHost) throw new Refusal('DATABASE_URL_UNPOOLED is not set (run via npm run backfill-media, or node --env-file=<file>)');
  const missing = STORAGE_ENV.filter(name => !env[name]);
  if (missing.length) {
    throw new Refusal(`${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set: the bucket must come from the ` +
      'same env file as the database');
  }
  if (!settings.storageHost) throw new Refusal('AWS_ENDPOINT_URL_S3 is not a URL');
  if (!args.dryRun && !args.reportGps && args.confirm !== settings.databaseHost) {
    throw new Refusal(`Refusing to write to ${settings.databaseHost}: pass --confirm ${settings.databaseHost}`);
  }
}

/**
 * Checks the database and the bucket are on the same branch: the database's own neon.branch_id against the bucket
 * endpoint's first label (br-…). A real run (`realRun`) must pass that comparison. When either id can't be read, a
 * dry run or report goes on by NEON_BRANCH (`branchName`), which must be set, with a warning.
 * → the line to print. Throws Refusal when the ids differ, or when they can't be compared on a real run or without
 * NEON_BRANCH.
 */
export function checkBranch({ databaseBranch, storageHost, branchName, realRun }) {
  const storageBranch = storageHost?.split('.')[0] ?? null;
  if (BRANCH_ID.test(databaseBranch ?? '') && BRANCH_ID.test(storageBranch ?? '')) {
    if (databaseBranch !== storageBranch) {
      throw new Refusal(`The database is on branch ${databaseBranch} but the bucket endpoint is on ${storageBranch}: ` +
        'use one env file with both settings for the same branch');
    }
    return `database and bucket are both on ${databaseBranch}`;
  }
  const unknown = `can't compare branch ids (database ${databaseBranch || 'not reported'}, bucket ${storageHost})`;
  if (realRun) {
    throw new Refusal(`${unknown}: a real run needs the database's neon.branch_id to equal the bucket endpoint's br-… id`);
  }
  if (!branchName) throw new Refusal(`${unknown}: set NEON_BRANCH to the branch this env file is for`);
  return `warning: ${unknown}; going by NEON_BRANCH=${branchName}, which only a read-only run may do`;
}

/**
 * What to write for each pending row: its display key, and a thumbnail key when it has no thumbnail yet.
 * @param rows media rows from PENDING_SQL: { id, sha256, object_key, content_type, thumb_key }
 * @returns {{ id, objectKey, contentType, displayKey, thumbKey: string|null }[]}
 */
export function plan(rows) {
  return rows.map(row => ({
    id: row.id,
    objectKey: row.object_key,
    contentType: row.content_type,
    displayKey: `display/${row.sha256}.webp`,
    thumbKey: row.thumb_key ? null : `thumbs/${row.sha256}.webp`
  }));
}

/** Console lines for a plan(): the count by content type, and the ids that also need a thumbnail. */
export function formatPlan(planned) {
  const byType = new Map();
  for (const item of planned) byType.set(item.contentType, (byType.get(item.contentType) ?? 0) + 1);
  const types = [...byType].sort(([a], [b]) => a.localeCompare(b)).map(([type, count]) => `${type} ${count}`).join(', ');
  const lines = [`${plural(planned.length, 'image')} without a display image${types ? ` (${types})` : ''}`];
  const thumbs = planned.filter(item => item.thumbKey).map(item => item.id);
  if (thumbs.length) lines.push(`${thumbs.length} of them also ${thumbs.length === 1 ? 'needs' : 'need'} a thumbnail: ${thumbs.join(' ')}`);
  return lines;
}

/** The image rows without a display image, as plan() items. */
async function pending(client) {
  return plan((await client.query(PENDING_SQL)).rows);
}

const byId = (a, b) => Number(a.id) - Number(b.id);

/**
 * Downloads each item's original (`item.objectKey`) and runs `work(item, original)` on it, `concurrency` at a time.
 * Each worker holds one original at a time, and drops it before taking the next. A failure (no such object, a
 * download error, or `work` throwing) skips that item and is logged.
 * → { results: what `work` returned, skipped: [{ id, objectKey, reason }] }, both in id order
 */
async function eachOriginal(items, storage, work, { log, concurrency }) {
  const results = [];
  const skipped = [];
  let next = 0;
  let finished = 0;
  const one = async (item) => {
    try {
      const original = await storage.get(item.objectKey);
      if (!original) throw new Error('missing original');
      results.push(await work(item, original));
    } catch (error) {
      // An ImagingError's code (unreadable, too_many_pixels, too_large), with sharp's own message alongside in the log.
      const reason = error instanceof ImagingError ? error.code : error.message;
      skipped.push({ id: item.id, objectKey: item.objectKey, reason });
      log(`skipped media ${item.id} (${item.objectKey}): ${reason}${error.cause?.message ? ` (${error.cause.message})` : ''}`);
    }
    if (++finished % PROGRESS_EVERY === 0) log(`${finished} of ${items.length}`);
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) await one(items[next++]);
  }));
  return { results: results.sort(byId), skipped: skipped.sort(byId) };
}

/**
 * Listens for the client's 'error' event (a connection dropped while idle: during phase 1, a report's downloads or
 * a retry's wait), which would otherwise crash the process. Each one is logged; the next query on the client then
 * fails, and main() says what happened. → { failure(): the first error, or null; stop(): stop listening }
 */
export function watchConnection(client, log) {
  let first = null;
  const onError = (error) => {
    first ??= error;
    log(`the database connection failed: ${error.message}`);
  };
  client.on('error', onError);
  return { failure: () => first, stop: () => client.off('error', onError) };
}

/** Makes one item's display image (and thumbnail, if planned) and uploads them. → its row update */
async function backfillOne(storage, item, original) {
  const { display, thumb, width, height } = await derivatives(original);
  await storage.putOnce(item.displayKey, display, WEBP);
  if (item.thumbKey) await storage.putOnce(item.thumbKey, thumb, WEBP);
  return { id: item.id, display_key: item.displayKey, thumb_key: item.thumbKey, width, height };
}

/**
 * Records the updates in one backfill_media change. Rolls back, so nothing is recorded, when no row still lacks a
 * display image. → { updated, changeId: the change's id, or null when nothing was recorded }
 */
async function record(client, updates, lockTimeout) {
  await client.query('begin');
  try {
    // This transaction holds the global write lock: fail rather than wait behind, or hold up, an editor.
    await client.query(`select set_config('lock_timeout', $1, true)`, [lockTimeout]);
    await client.query(`set local statement_timeout = '60s'`);
    await client.query(`set local idle_in_transaction_session_timeout = '15s'`);
    const { rows: [{ id }] } = await client.query(
      `select begin_change('backfill@ged-eye.local', 'Media backfill', 'backfill_media', 'script',
                           'Display images for existing photos', '{}', '{}') as id`);
    const { rowCount } = await client.query(UPDATE_SQL, [JSON.stringify(updates)]);
    if (rowCount === 0) {
      await client.query('rollback');
      return { updated: 0, changeId: null };
    }
    await client.query('commit');
    return { updated: rowCount, changeId: id };
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  }
}

/**
 * record(), tried again up to RECORD_RETRIES times while the write lock is busy (lock_timeout), so an editor's
 * command doesn't throw away the images already made. Other errors, and the last busy one, are thrown.
 */
async function recordRetrying(client, updates, { log, lockTimeout, retryDelay }) {
  for (let retry = 1; ; retry++) {
    try {
      return await record(client, updates, lockTimeout);
    } catch (error) {
      if (error.code !== LOCK_NOT_AVAILABLE || retry > RECORD_RETRIES) throw error;
      const ms = retryDelay(retry);
      log(`the write lock is busy (${error.message}); retry ${retry} of ${RECORD_RETRIES} in ${ms / 1000} s`);
      await new Promise(resolve => setTimeout(resolve, ms));
    }
  }
}

/**
 * The backfill. Phase 1, with no transaction open: for each image row without a display image, download the
 * original, make its derivatives and putOnce them. Phase 2: one short transaction recording every row made, skipped
 * entirely when phase 1 made none, so a re-run records no empty change.
 * @param client a connected pg client, not in a transaction
 * @param storage { get, putOnce } as media/storage.js's createStorage()
 * Options: `log`, `concurrency` (4), `lockTimeout` (Postgres interval text, '5s') and `retryDelay(retry)` (ms).
 * @returns {{ pending, updated, changeId: string|null, skipped: {id, objectKey, reason}[] }}
 * Throws when phase 2 fails (after the retries, for a busy lock), including when the connection has dropped.
 */
export async function apply(client, storage, {
  log = console.log, concurrency = CONCURRENCY, lockTimeout = '5s', retryDelay = (retry) => 2000 * retry
} = {}) {
  const items = await pending(client);
  log(formatPlan(items).join('\n'));
  const { results, skipped } = await eachOriginal(items, storage, (item, original) => backfillOne(storage, item, original),
    { log, concurrency });
  const { updated, changeId } = results.length
    ? await recordRetrying(client, results, { log, lockTimeout, retryDelay })
    : { updated: 0, changeId: null };
  return { pending: items.length, updated, changeId, skipped };
}

/**
 * Read-only: downloads every image original (with a display image or not) and lists those carrying location data,
 * by the same rule as an upload (fileHasLocation: the files processFile re-encodes), reading only their metadata.
 * Never reports coordinates, and writes nothing.
 * @returns {{ checked: number, withLocation: string[] (media ids), skipped: {id, objectKey, reason}[] }}
 */
export async function reportGps(client, storage, { log = console.log, concurrency = CONCURRENCY } = {}) {
  const items = (await client.query(IMAGES_SQL)).rows.map(row => ({ id: row.id, objectKey: row.object_key }));
  log(`checking ${plural(items.length, 'image original')} for location data`);
  const { results, skipped } = await eachOriginal(items, storage,
    async (item, original) => ({ id: item.id, location: await fileHasLocation(original) }), { log, concurrency });
  return { checked: results.length, withLocation: results.filter(result => result.location).map(result => result.id), skipped };
}

const skippedLines = (skipped) => skipped.map(skip => `  ${skip.id} ${skip.objectKey}: ${skip.reason}`);

async function main() {
  checkNpmFlags(process.env);
  const args = parseArgs(process.argv.slice(2));
  const settings = settingsFrom(process.env);
  console.log(describeSettings(settings));
  checkSettings(settings, process.env, args);
  const client = new pg.Client({ connectionString: settings.databaseUrl });
  const connection = watchConnection(client, console.error); // every phase, including the retries' waits
  await client.connect();
  try {
    const { rows: [{ branch }] } = await client.query(`select current_setting('neon.branch_id', true) as branch`);
    console.log(checkBranch({
      databaseBranch: branch, storageHost: settings.storageHost, branchName: settings.branchName, realRun: !args.dryRun && !args.reportGps
    }));
    if (args.dryRun) {
      console.log('dry run: nothing is downloaded or written');
      console.log(formatPlan(await pending(client)).join('\n'));
      return;
    }
    const storage = createStorage();
    if (args.reportGps) {
      console.log('location report: nothing is written');
      const report = await reportGps(client, storage);
      console.log(`location data in ${report.withLocation.length} of ${plural(report.checked, 'image original')} checked` +
        `${report.withLocation.length ? `: ${report.withLocation.join(' ')}` : ''}`);
      if (report.skipped.length) {
        console.log(`could not check ${report.skipped.length}:\n${skippedLines(report.skipped).join('\n')}`);
        process.exitCode = 1;
      }
      return;
    }
    console.log('backfill');
    const result = await apply(client, storage);
    console.log(result.changeId
      ? `recorded ${plural(result.updated, 'row')} in change ${result.changeId}`
      : 'nothing recorded');
    if (result.skipped.length) {
      console.log(`skipped ${result.skipped.length} of ${result.pending}:\n${skippedLines(result.skipped).join('\n')}`);
      process.exitCode = 1;
    }
  } catch (error) {
    const dropped = connection.failure();
    if (!dropped || error instanceof Refusal) throw error;
    // Uploaded derivatives stay (their keys come from the sha), so a re-run only has to record them.
    throw new Error(`The database connection failed (${dropped.message}), so nothing more was recorded; ` +
      `re-run to finish. ${error.message}`, { cause: error });
  } finally {
    await client.end().catch(() => {}); // after a dropped connection, keep the error that says what happened
  }
}

if (isMain(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    if (error.detail) console.error(`detail: ${error.detail}`);
    process.exit(error instanceof Refusal ? 2 : 1);
  });
}
