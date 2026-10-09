/**
 * One-off backfill of person.facts from gedcom_archive with the full GEDCOM parser.
 * See specs/2026-10-09-gedcom-full-facts-design.md (Backfill).
 *
 *   npm run backfill-facts                                     # plan (read-only) → .neon-import/facts-backfill-plan-<host>.json
 *   npm run backfill-facts -- --apply <plan> --confirm <host>  # compare-and-swap the plan in
 *   npm run backfill-facts -- --rollback <plan> --confirm <host>
 * Options: --database-url <url> (default DATABASE_URL_UNPOOLED), --sha <sha256>, --out <path>.
 */
import { canonical } from './verifyCompare.js';

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

const listIds = (ids) => `${ids.slice(0, 20).join(' ')}${ids.length > 20 ? ` … (${ids.length})` : ''}`;

export function formatSummary(summary) {
  const lines = [`unchanged ${summary.unchanged}, changed ${summary.changed}, edited ${summary.edited.length}, ` +
    `only in database ${summary.onlyInDb.length}, only in GEDCOM ${summary.onlyInGed.length}, column drift ${summary.columnDrift.length}`];
  for (const [key, c] of Object.entries(summary.keys)) lines.push(`  ${key}: added ${c.added}, removed ${c.removed}, changed ${c.changed}`);
  if (summary.edited.length) lines.push(`edited since import (skipped): ${listIds(summary.edited)}`);
  if (summary.onlyInDb.length) lines.push(`only in database: ${listIds(summary.onlyInDb)}`);
  if (summary.onlyInGed.length) lines.push(`only in GEDCOM: ${listIds(summary.onlyInGed)}`);
  for (const d of summary.columnDrift.slice(0, 20)) {
    lines.push(`column drift ${d.id}.${d.column}: database ${JSON.stringify(d.db)}, GEDCOM ${JSON.stringify(d.derived)}`);
  }
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

/** Throws unless the plan was made against `host` and --confirm names it too. */
export function checkConfirm({ host, planHost, confirm, direction }) {
  if (planHost !== host) throw new Error(`The plan was made against ${planHost}, but this connection is ${host}`);
  if (confirm !== host) throw new Error(`Refusing to ${direction} on ${host}: pass --confirm ${host}`);
}
