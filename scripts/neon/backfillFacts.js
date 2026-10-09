/**
 * One-off backfill of person.facts from gedcom_archive with the full GEDCOM parser.
 * See specs/2026-10-09-gedcom-full-facts-design.md (Backfill).
 *
 *   npm run backfill-facts                                     # plan (read-only) → .neon-import/facts-backfill-plan-<host>.json
 *   npm run backfill-facts -- --apply <plan> --confirm <host>  # compare-and-swap the plan in
 *   npm run backfill-facts -- --rollback <plan> --confirm <host>
 * Options: --database-url <url> (default DATABASE_URL_UNPOOLED), --sha <sha256>, --out <path>.
 * Every option takes its value as the next argument (no --option=value); anything else is rejected.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import pg from 'pg';
import { canonical } from './verifyCompare.js';
import { parseGedcom } from '../gedParser.js';
import { gedToRows } from './gedToRows.js';
import { ROOT, isMain, readJson, writeJson } from './cli.js';

export const CORE_COLUMNS = ['given_name', 'surname', 'display_name', 'sex', 'birth_date', 'birth_place',
  'death_date', 'death_place', 'baptism_date', 'baptism_place', 'burial_date', 'burial_place'];

function countKeys(keys, before, after) {
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const kind = !(key in before) ? 'added' : !(key in after) ? 'removed'
      : canonical(before[key]) !== canonical(after[key]) ? 'changed' : null;
    if (!kind) continue;
    keys[key] ??= { added: 0, removed: 0, changed: 0 };
    keys[key][kind]++;
  }
}

/**
 * @param dbRows  [{ id, facts, edited, ...CORE_COLUMNS }] from readDbRows()
 * @param derived people rows from gedToRows() on the archive
 * @returns {{ rows: {id, before, after}[], summary }}
 */
export function planFacts(dbRows, derived) {
  const ged = new Map(derived.map(row => [row.id, row]));
  const ids = new Set(dbRows.map(row => row.id));
  const rows = [];
  const summary = { unchanged: 0, changed: 0, edited: [], onlyInDb: [], onlyInGed: [], keys: {}, columnDrift: [] };
  for (const current of dbRows) {
    const next = ged.get(current.id);
    if (!next) {
      summary.onlyInDb.push(current.id);
      continue;
    }
    for (const column of CORE_COLUMNS) {
      const db = current[column] ?? null;
      const fromGed = next[column] ?? null;
      if (db !== fromGed) summary.columnDrift.push({ id: current.id, column, db, derived: fromGed });
    }
    if (canonical(current.facts) === canonical(next.facts)) {
      summary.unchanged++;
    } else if (current.edited) {
      summary.edited.push(current.id);
    } else {
      summary.changed++;
      rows.push({ id: current.id, before: current.facts, after: next.facts });
      countKeys(summary.keys, current.facts, next.facts);
    }
  }
  for (const id of ged.keys()) if (!ids.has(id)) summary.onlyInGed.push(id);
  summary.keys = Object.fromEntries(Object.entries(summary.keys).sort(([a], [b]) => a.localeCompare(b)));
  return { rows, summary };
}

const MAX_LISTED = 20;
const listIds = (ids) => `${ids.slice(0, MAX_LISTED).join(' ')}${ids.length > MAX_LISTED ? ` … (${ids.length})` : ''}`;

/**
 * Console lines for a plan: the totals, per-key counts, the people skipped or found on one side
 * only, and up to 20 column-drift entries followed by a count of the rest.
 * @param summary the summary from planFacts()
 * @returns {string[]}
 */
export function formatSummary(summary) {
  const lines = [`unchanged ${summary.unchanged}, changed ${summary.changed}, edited ${summary.edited.length}, ` +
    `only in database ${summary.onlyInDb.length}, only in GEDCOM ${summary.onlyInGed.length}, column drift ${summary.columnDrift.length}`];
  for (const [key, c] of Object.entries(summary.keys)) lines.push(`  ${key}: added ${c.added}, removed ${c.removed}, changed ${c.changed}`);
  if (summary.edited.length) lines.push(`edited since import (skipped): ${listIds(summary.edited)}`);
  if (summary.onlyInDb.length) lines.push(`only in database: ${listIds(summary.onlyInDb)}`);
  if (summary.onlyInGed.length) lines.push(`only in GEDCOM: ${listIds(summary.onlyInGed)}`);
  for (const d of summary.columnDrift.slice(0, MAX_LISTED)) {
    lines.push(`column drift ${d.id}.${d.column}: database ${JSON.stringify(d.db)}, GEDCOM ${JSON.stringify(d.derived)}`);
  }
  if (summary.columnDrift.length > MAX_LISTED) lines.push(`column drift: … and ${summary.columnDrift.length - MAX_LISTED} more`);
  return lines;
}

/** Human-readable before/after for the keys that change in one planned row. */
export function describeRow(row, width = 160) {
  const show = (value) => {
    const s = value === undefined ? '(absent)' : JSON.stringify(value);
    return s.length > width ? `${s.slice(0, width - 1)}…` : s;
  };
  const keys = [...new Set([...Object.keys(row.before), ...Object.keys(row.after)])]
    .filter(key => canonical(row.before[key]) !== canonical(row.after[key])).sort();
  return [`${row.id}:`, ...keys.flatMap(key => [`  ${key} before ${show(row.before[key])}`, `  ${key} after  ${show(row.after[key])}`])];
}

const OPTIONS = new Map([
  ['--database-url', 'databaseUrl'], ['--sha', 'sha'], ['--out', 'out'],
  ['--apply', 'apply'], ['--rollback', 'rollback'], ['--confirm', 'confirm']
]);

/**
 * Strict command-line parsing (argv without node and the script): only the options above, each
 * followed by its own value. `--apply=path`, a trailing flag, an unknown flag, a stray positional
 * or an empty value throws before anything is read or connected to.
 * @returns {{ databaseUrl?, sha?, out?, apply?, rollback?, confirm? }} the options that were given
 */
export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!OPTIONS.has(flag) || value === undefined || value === '' || value.startsWith('--')) {
      throw new Error(`Unknown or incomplete argument: ${flag}`);
    }
    const key = OPTIONS.get(flag);
    if (key in args) throw new Error(`Duplicate argument: ${flag}`);
    args[key] = value;
  }
  return args;
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Throws unless a parsed plan file has the shape this script wrote: host, and rows of unique id + before + after objects. */
export function checkPlanFile(plan) {
  if (!isPlainObject(plan)) throw new Error('The plan file is not a plan: expected a JSON object');
  if (typeof plan.host !== 'string') throw new Error('The plan has no host (a string)');
  if (!Array.isArray(plan.rows)) throw new Error('The plan has no rows array');
  const seen = new Set();
  plan.rows.forEach((row, index) => {
    if (!isPlainObject(row) || typeof row.id !== 'string') throw new Error(`Plan row ${index} has no string id`);
    if (!isPlainObject(row.before) || !isPlainObject(row.after)) throw new Error(`Plan row ${index} (${row.id}) needs before and after objects`);
    if (seen.has(row.id)) throw new Error(`The plan lists ${row.id} more than once`);
    seen.add(row.id);
  });
}

/** Reads and parses a plan file, naming the path when it is missing or is not JSON. */
export function readPlanFile(planPath) {
  let plan;
  try {
    plan = readJson(planPath, undefined);
  } catch (error) {
    throw new Error(`Cannot read plan ${planPath}: ${error.message}`);
  }
  if (plan === undefined) throw new Error(`No plan at ${planPath}`);
  return plan;
}

/** Throws unless the plan was made against `host` and --confirm names it too. */
export function checkConfirm({ host, planHost, confirm, direction }) {
  if (planHost !== host) throw new Error(`The plan was made against ${planHost}, but this connection is ${host}`);
  if (confirm !== host) throw new Error(`Refusing to ${direction} on ${host}: pass --confirm ${host}`);
}

// Compare-and-swap: only rows whose facts still equal the side being replaced, and that nobody has
// edited since the import (the backfill itself never touches updated_at).
const UPDATE_SQL = `
  update person p set facts = r.replacement
  from jsonb_to_recordset($1::jsonb) as r (id text, expected jsonb, replacement jsonb)
  where p.id = r.id and p.facts = r.expected and p.updated_at = p.created_at
  returning p.id`;

export class StalePlanError extends Error {
  /** @param ids the stale rows of the batch; @param batchNumber 1-based; @param batchSize rows in that batch */
  constructor(ids, batchNumber, batchSize) {
    const shown = ids.slice(0, MAX_LISTED).join(', ');
    const more = ids.length > MAX_LISTED ? `, … and ${ids.length - MAX_LISTED} more` : '';
    super(`batch ${batchNumber}: ${ids.length} of ${batchSize} rows changed or were edited since the plan (${shown}${more}); nothing was written`);
    this.name = 'StalePlanError';
    this.ids = ids;
  }
}

const sides = (direction) => {
  if (direction === 'apply') return { from: 'before', to: 'after' };
  if (direction === 'rollback') return { from: 'after', to: 'before' };
  throw new Error(`direction must be apply or rollback, not ${direction}`);
};

/** The gedcom_archive row (the only one, or the one with `sha`), with its content hash checked. */
export async function loadArchive(client, sha) {
  const { rows } = sha
    ? await client.query('select sha256, content from gedcom_archive where sha256 = $1', [sha])
    : await client.query('select sha256, content from gedcom_archive');
  if (rows.length !== 1) {
    throw new Error(sha ? `No gedcom_archive row has sha256 ${sha}` : `Expected exactly one gedcom_archive row, found ${rows.length}; pass --sha <sha256>`);
  }
  const [{ sha256, content }] = rows;
  const actual = crypto.createHash('sha256').update(content).digest('hex');
  if (actual !== sha256) throw new Error(`gedcom_archive content hashes to ${actual}, but its row says ${sha256}`);
  return { sha256, content };
}

/** Every person's facts, edited flag (updated_at moved since the import) and CORE_COLUMNS. */
export async function readDbRows(client) {
  const { rows } = await client.query(
    `select id, facts, updated_at <> created_at as edited, ${CORE_COLUMNS.join(', ')} from person order by id`);
  return rows;
}

/**
 * Compare-and-swap the plan into person.facts in one transaction. Leaves updated_at alone: the
 * backfill re-derives the import, it is not an edit. Throws StalePlanError (and writes nothing)
 * if any row's facts no longer match the side being replaced, or the row was edited since the import.
 */
export async function applyPlan(client, plan, { direction = 'apply', batchSize = 500 } = {}) {
  const { from, to } = sides(direction);
  const pairs = plan.rows.map(row => ({ id: row.id, expected: row[from], replacement: row[to] }));
  await client.query('begin');
  try {
    let updated = 0;
    for (let i = 0; i < pairs.length; i += batchSize) {
      const batch = pairs.slice(i, i + batchSize);
      const { rows } = await client.query(UPDATE_SQL, [JSON.stringify(batch)]);
      if (rows.length !== batch.length) {
        const done = new Set(rows.map(row => row.id));
        throw new StalePlanError(batch.map(pair => pair.id).filter(id => !done.has(id)), Math.floor(i / batchSize) + 1, batch.length);
      }
      updated += rows.length;
    }
    await client.query('commit');
    return { updated };
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  }
}

/** Planned ids whose facts don't equal the side the given direction writes. */
export async function verifyPlan(client, plan, { direction = 'apply' } = {}) {
  const { to } = sides(direction);
  const ids = plan.rows.map(row => row.id);
  const { rows } = await client.query('select id, facts from person where id = any($1)', [ids]);
  const actual = new Map(rows.map(row => [row.id, row.facts]));
  return plan.rows.filter(row => !actual.has(row.id) || canonical(actual.get(row.id)) !== canonical(row[to])).map(row => row.id);
}

/**
 * Where each planned row stands now: holding the plan's before, its after, or neither (including
 * a missing row). Ids are in plan order. Used to tell a re-run or interrupted apply/rollback from a stale plan.
 */
export async function planState(client, plan) {
  const { rows } = await client.query('select id, facts from person where id = any($1)', [plan.rows.map(row => row.id)]);
  const actual = new Map(rows.map(row => [row.id, canonical(row.facts)]));
  const state = { atBefore: [], atAfter: [], neither: [] };
  for (const row of plan.rows) {
    const facts = actual.get(row.id);
    const isBefore = actual.has(row.id) && facts === canonical(row.before);
    const isAfter = actual.has(row.id) && facts === canonical(row.after);
    if (isBefore) state.atBefore.push(row.id);
    if (isAfter) state.atAfter.push(row.id);
    if (!isBefore && !isAfter) state.neither.push(row.id);
  }
  return state;
}

const SAMPLE_IDS = ['I1', 'I23', 'I443'];

async function makePlan(client, host, { out: outArg, sha }) {
  const out = path.resolve(outArg ?? path.join(ROOT, '.neon-import', `facts-backfill-plan-${host}.json`));
  // An earlier plan may be the only rollback for an apply already made, so never overwrite one.
  if (fs.existsSync(out)) throw new Error(`${out} already exists (it may be the rollback for an apply); move it or pass --out <path>`);
  // One snapshot for the archive and the people, read-only.
  await client.query('begin isolation level repeatable read, read only');
  let archive;
  let dbRows;
  try {
    archive = await loadArchive(client, sha);
    dbRows = await readDbRows(client);
  } finally {
    // Read-only, so there is nothing to lose; don't let a failed rollback hide the real error.
    await client.query('rollback').catch(() => {});
  }
  const { people } = gedToRows(parseGedcom(archive.content.toString('utf-8')), { files: {}, avatars: {} }, new Map());
  const { rows, summary } = planFacts(dbRows, people);
  writeJson(out, { createdAt: new Date().toISOString(), host, archiveSha: archive.sha256, summary, rows });
  console.log(formatSummary(summary).join('\n'));
  for (const row of rows.filter(r => SAMPLE_IDS.includes(r.id))) console.log(describeRow(row).join('\n'));
  console.log(`plan for ${host} (archive ${archive.sha256.slice(0, 12)}): ${out}, ${rows.length} rows`);
  if (rows.length > 0) {
    console.log(`apply with: npm run backfill-facts -- --apply ${out} --confirm ${host}`);
    console.log(`keep this file: it is the rollback (--rollback ${out} --confirm ${host})`);
  }
}

const sampleIds = (ids) => `${ids.slice(0, 3).join(' ')}${ids.length > 3 ? ' …' : ''}`;

/**
 * Applies (or rolls back) a plan and verifies it. If that fails, looks at where the rows stand:
 * a plan already at the side being written is reported and returns normally (a re-run, or a commit
 * that went through before the connection failed); otherwise throws saying what the rows hold.
 */
export async function writePlan(client, planFile, direction, host, log = console.log) {
  if (planFile.rows.length === 0) {
    log(`The plan has no rows; nothing to ${direction}.`);
    return;
  }
  let updated;
  try {
    ({ updated } = await applyPlan(client, planFile, { direction }));
  } catch (error) {
    let state;
    try {
      state = await planState(client, planFile);
    } catch (checkError) {
      throw rethrown(error, `${direction} failed and the database could not be checked afterwards (${checkError.message}); ` +
        'run the same command again to see where the plan stands');
    }
    const written = direction === 'apply' ? state.atAfter : state.atBefore;
    if (written.length === planFile.rows.length) {
      log(`This plan is already ${direction === 'apply' ? 'applied' : 'rolled back'} on ${host}; nothing to do.`);
      return;
    }
    const first = Object.entries({ before: state.atBefore, after: state.atAfter, neither: state.neither })
      .filter(([, ids]) => ids.length).map(([side, ids]) => `${side} ${sampleIds(ids)}`).join('; ');
    throw rethrown(error, `${direction} wrote nothing: ${state.atBefore.length} rows hold the plan's before, ` +
      `${state.atAfter.length} its after, ${state.neither.length} neither (first ids: ${first})`);
  }
  const mismatched = await verifyPlan(client, planFile, { direction });
  if (mismatched.length) throw new Error(`${direction} committed ${updated} rows, but ${mismatched.length} don't match the plan: ${mismatched.join(', ')}`);
  log(JSON.stringify({ direction, host, updated, verified: planFile.rows.length }));
}

/** A new error saying `what` followed by the original message, keeping the original's detail and cause. */
function rethrown(error, what) {
  const wrapped = new Error(`${what}. ${error.message}`, { cause: error });
  if (error.detail) wrapped.detail = error.detail;
  return wrapped;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = args.databaseUrl ?? process.env.DATABASE_URL_UNPOOLED;
  if (!url) throw new Error('DATABASE_URL_UNPOOLED is not set (run via npm run backfill-facts, or pass --database-url)');
  const host = new URL(url).hostname;
  if (args.apply !== undefined && args.rollback !== undefined) throw new Error('Pass --apply or --rollback, not both');
  const direction = args.apply !== undefined ? 'apply' : args.rollback !== undefined ? 'rollback' : null;
  let planFile = null;
  if (direction) {
    const planPath = path.resolve(args.apply ?? args.rollback);
    planFile = readPlanFile(planPath);
    try {
      checkPlanFile(planFile);
    } catch (error) {
      throw new Error(`${planPath} is not a valid plan: ${error.message}`);
    }
    checkConfirm({ host, planHost: planFile.host, confirm: args.confirm, direction });
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    if (direction) await writePlan(client, planFile, direction, host);
    else await makePlan(client, host, args);
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
