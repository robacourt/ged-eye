/**
 * One-off backfill of display images (and the missing thumbnails, which are the TIFFs') for the media imported
 * before the photos release. See specs/2026-10-09-photos-design.md (Backfill).
 *
 *   npm run backfill-media                    # write the derivatives, then record them in one change
 *   npm run backfill-media -- --dry-run       # list what would be backfilled; downloads and writes nothing
 *   npm run backfill-media -- --report-gps    # list the image originals that carry location data; writes nothing
 *
 * The database (DATABASE_URL_UNPOOLED) and the bucket (AWS_*) both come from the env file, so they are always the
 * same branch: npm run backfill-media reads .env.local; for another branch run
 *   node --env-file=<file> scripts/neon/backfillMedia.js [--dry-run | --report-gps]
 *
 * It first makes and uploads every derivative with no transaction open, 4 images at a time, then records the rows
 * in one short transaction, so the global write lock is held for well under a second. Derivative keys come from the
 * sha and only rows without a display image are selected, so a re-run carries on where an earlier one stopped and
 * records nothing when there is nothing to do. An image sharp can't read is reported and skipped (exit status 1).
 */
import pg from 'pg';
import { derivatives, processFile } from '../../media/imaging.js';
import { createStorage } from '../../media/storage.js';
import { ImagingError } from '../../media/types.js';
import { isMain } from './cli.js';

/** Derivatives are immutable: written once, cached for a year (as the media Function writes them). */
export const IMMUTABLE = 'public, max-age=31536000, immutable';
const CONCURRENCY = 4;
const PROGRESS_EVERY = 50;
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

const FLAGS = new Map([['--dry-run', 'dryRun'], ['--report-gps', 'reportGps']]);

/**
 * Strict command-line parsing (argv without node and the script), so a mistyped --dry-run can't start a real run.
 * Throws on an unknown or repeated argument, or on both modes at once.
 * @returns {{ dryRun: boolean, reportGps: boolean }}
 */
export function parseArgs(argv) {
  const args = { dryRun: false, reportGps: false };
  const seen = new Set();
  for (const flag of argv) {
    if (!FLAGS.has(flag)) throw new Error(`Unknown argument: ${flag} (expected --dry-run or --report-gps)`);
    if (seen.has(flag)) throw new Error(`Duplicate argument: ${flag}`);
    seen.add(flag);
    args[FLAGS.get(flag)] = true;
  }
  if (args.dryRun && args.reportGps) throw new Error('Pass --dry-run or --report-gps, not both');
  return args;
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
async function record(client, updates) {
  await client.query('begin');
  try {
    // This transaction holds the global write lock: fail rather than wait behind, or hold up, an editor.
    await client.query(`set local lock_timeout = '5s'`);
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
 * The backfill. Phase 1, with no transaction open: for each image row without a display image, download the
 * original, make its derivatives and putOnce them. Phase 2: one short transaction recording every row made, skipped
 * entirely when phase 1 made none, so a re-run records no empty change.
 * @param client a connected pg client, not in a transaction
 * @param storage { get, putOnce } as media/storage.js's createStorage()
 * @returns {{ pending, updated, changeId: string|null, skipped: {id, objectKey, reason}[] }}
 */
export async function apply(client, storage, { log = console.log, concurrency = CONCURRENCY } = {}) {
  const items = await pending(client);
  log(formatPlan(items).join('\n'));
  const { results, skipped } = await eachOriginal(items, storage, (item, original) => backfillOne(storage, item, original),
    { log, concurrency });
  const { updated, changeId } = results.length ? await record(client, results) : { updated: 0, changeId: null };
  return { pending: items.length, updated, changeId, skipped };
}

/**
 * Read-only: downloads every image original (with a display image or not) and lists those carrying location data,
 * by the same rule as an upload (processFile re-encodes exactly those). Never reports coordinates, and writes nothing.
 * @returns {{ checked: number, withLocation: string[] (media ids), skipped: {id, objectKey, reason}[] }}
 */
export async function reportGps(client, storage, { log = console.log, concurrency = CONCURRENCY } = {}) {
  const items = (await client.query(IMAGES_SQL)).rows.map(row => ({ id: row.id, objectKey: row.object_key }));
  log(`checking ${plural(items.length, 'image original')} for location data`);
  const { results, skipped } = await eachOriginal(items, storage,
    async (item, original) => ({ id: item.id, location: (await processFile(original)).original.reencoded }), { log, concurrency });
  return { checked: results.length, withLocation: results.filter(result => result.location).map(result => result.id), skipped };
}

const skippedLines = (skipped) => skipped.map(skip => `  ${skip.id} ${skip.objectKey}: ${skip.reason}`);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = process.env.DATABASE_URL_UNPOOLED;
  if (!url) throw new Error('DATABASE_URL_UNPOOLED is not set (run via npm run backfill-media, or node --env-file=<file>)');
  const host = new URL(url).hostname;
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    if (args.dryRun) {
      console.log(`dry run on ${host}; nothing is downloaded or written`);
      console.log(formatPlan(await pending(client)).join('\n'));
      return;
    }
    const storage = createStorage();
    if (args.reportGps) {
      console.log(`location report on ${host}; nothing is written`);
      const report = await reportGps(client, storage);
      console.log(`location data in ${report.withLocation.length} of ${plural(report.checked, 'image original')} checked` +
        `${report.withLocation.length ? `: ${report.withLocation.join(' ')}` : ''}`);
      if (report.skipped.length) {
        console.log(`could not check ${report.skipped.length}:\n${skippedLines(report.skipped).join('\n')}`);
        process.exitCode = 1;
      }
      return;
    }
    console.log(`backfill on ${host}`);
    const result = await apply(client, storage);
    console.log(result.changeId
      ? `recorded ${plural(result.updated, 'row')} in change ${result.changeId}`
      : 'nothing recorded');
    if (result.skipped.length) {
      console.log(`skipped ${result.skipped.length} of ${result.pending}:\n${skippedLines(result.skipped).join('\n')}`);
      process.exitCode = 1;
    }
  } finally {
    await client.end();
  }
}

if (isMain(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    if (error.detail) console.error(`detail: ${error.detail}`);
    process.exit(1);
  });
}
