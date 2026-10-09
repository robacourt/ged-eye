// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  planFacts, formatSummary, describeRow, checkConfirm, parseArgs, checkPlanFile, readPlanFile, StalePlanError, CORE_COLUMNS
} from '../scripts/neon/backfillFacts.js';

const CORE = Object.fromEntries(CORE_COLUMNS.map(column => [column, null]));
const dbRow = (id, facts, extra = {}) => ({ id, facts, edited: false, ...CORE, given_name: 'A', ...extra });
const derivedRow = (id, facts, extra = {}) => ({ id, facts, ...CORE, given_name: 'A', avatar_key: null, ...extra });

describe('planFacts', () => {
  it('treats facts with the same content in a different key order as unchanged', () => {
    const { rows, summary } = planFacts(
      [dbRow('I1', { notes: ['n'], occupations: [{ value: 'Miller', date: '1881' }] })],
      [derivedRow('I1', { occupations: [{ date: '1881', value: 'Miller' }], notes: ['n'] })]
    );
    expect(rows).toEqual([]);
    expect(summary).toMatchObject({ unchanged: 1, changed: 0 });
  });

  it('plans changed people with before and after, and counts each key', () => {
    const { rows, summary } = planFacts(
      [dbRow('I1', { notes: ['short'], occupations: ['Miller'], religion: 'Protestant' }), dbRow('I2', {})],
      [derivedRow('I1', { notes: ['short\nand long'], occupations: [{ value: 'Miller' }], otherFacts: [{ tag: 'RELI', value: 'Protestant' }] }), derivedRow('I2', {})]
    );
    expect(rows).toEqual([{
      id: 'I1',
      before: { notes: ['short'], occupations: ['Miller'], religion: 'Protestant' },
      after: { notes: ['short\nand long'], occupations: [{ value: 'Miller' }], otherFacts: [{ tag: 'RELI', value: 'Protestant' }] }
    }]);
    expect(summary).toMatchObject({ unchanged: 1, changed: 1 });
    expect(summary.keys).toEqual({
      notes: { added: 0, removed: 0, changed: 1 },
      occupations: { added: 0, removed: 0, changed: 1 },
      otherFacts: { added: 1, removed: 0, changed: 0 },
      religion: { added: 0, removed: 1, changed: 0 }
    });
  });

  it('never plans an edited person whose facts would change', () => {
    const { rows, summary } = planFacts(
      [dbRow('I1', { notes: ['edited by hand'] }, { edited: true }), dbRow('I2', { notes: ['x'] }, { edited: true })],
      [derivedRow('I1', { notes: ['from the GEDCOM'] }), derivedRow('I2', { notes: ['x'] })]
    );
    expect(rows).toEqual([]);
    expect(summary).toMatchObject({ unchanged: 1, changed: 0, edited: ['I1'] });
  });

  it('lists people found on only one side, and never plans them', () => {
    const { rows, summary } = planFacts([dbRow('I1', {}), dbRow('I9', {})], [derivedRow('I1', {}), derivedRow('I5', { notes: ['n'] })]);
    expect(rows).toEqual([]);
    expect(summary).toMatchObject({ onlyInDb: ['I9'], onlyInGed: ['I5'] });
  });

  it('reports core-column drift without writing it, ignoring avatar_key', () => {
    const { rows, summary } = planFacts(
      [dbRow('I1', {}, { birth_date: '1900', avatar_key: 'avatars/x.jpg' })],
      [derivedRow('I1', {}, { birth_date: 'ABT 1900' })]
    );
    expect(rows).toEqual([]);
    expect(summary.columnDrift).toEqual([{ id: 'I1', column: 'birth_date', db: '1900', derived: 'ABT 1900' }]);
  });
});

describe('backfill reporting and guards', () => {
  it('formats a summary', () => {
    const { summary } = planFacts([dbRow('I1', { notes: ['a'] })], [derivedRow('I1', { notes: ['b'] })]);
    expect(formatSummary(summary)).toEqual([
      'unchanged 0, changed 1, edited 0, only in database 0, only in GEDCOM 0, column drift 0',
      '  notes: added 0, removed 0, changed 1'
    ]);
  });

  it('caps the column drift lines at 20 and counts the rest', () => {
    const columnDrift = Array.from({ length: 23 }, (_, i) => ({ id: `I${i}`, column: 'birth_date', db: null, derived: '1900' }));
    const lines = formatSummary({ unchanged: 0, changed: 0, edited: [], onlyInDb: [], onlyInGed: [], keys: {}, columnDrift });
    expect(lines[0]).toContain('column drift 23');
    expect(lines.filter(line => line.startsWith('column drift I'))).toHaveLength(20);
    expect(lines.at(-1)).toBe('column drift: … and 3 more');
    const exactly20 = formatSummary({ unchanged: 0, changed: 0, edited: [], onlyInDb: [], onlyInGed: [], keys: {}, columnDrift: columnDrift.slice(0, 20) });
    expect(exactly20.some(line => line.includes('more'))).toBe(false);
  });

  it('describes one planned row key by key, truncating long values', () => {
    expect(describeRow({ id: 'I1', before: { notes: ['a'], phone: '1' }, after: { notes: ['b'.repeat(200)], phone: '1' } }, 20)).toEqual([
      'I1:',
      '  notes before ["a"]',
      `  notes after  ${JSON.stringify(['b'.repeat(200)]).slice(0, 19)}…`
    ]);
  });

  it('refuses to write unless --confirm and the plan both name this host', () => {
    expect(() => checkConfirm({ host: 'h', planHost: 'h', confirm: 'h', direction: 'apply' })).not.toThrow();
    expect(() => checkConfirm({ host: 'h', planHost: 'h', confirm: undefined, direction: 'apply' })).toThrow('pass --confirm h');
    expect(() => checkConfirm({ host: 'h', planHost: 'other', confirm: 'h', direction: 'rollback' })).toThrow('made against other');
  });
});

describe('parseArgs', () => {
  it('parses every supported option', () => {
    expect(parseArgs(['--database-url', 'postgres://h/db', '--sha', 'abc', '--out', 'p.json'])).toEqual({
      databaseUrl: 'postgres://h/db', sha: 'abc', out: 'p.json'
    });
    expect(parseArgs(['--apply', 'p.json', '--confirm', 'h'])).toEqual({ apply: 'p.json', confirm: 'h' });
    expect(parseArgs(['--rollback', 'p.json', '--confirm', 'h'])).toEqual({ rollback: 'p.json', confirm: 'h' });
    expect(parseArgs([])).toEqual({});
  });

  it.each([
    [['--apply=p.json'], '--apply=p.json'],
    [['--apply'], '--apply'],
    [['--confirm', 'h', '--rollback'], '--rollback'],
    [['--apply', '--confirm', 'h'], '--apply'],
    [['--out', '--sha', 'x'], '--out'],
    [['--sha', ''], '--sha'],
    [['--bogus', 'x'], '--bogus'],
    [['--apply', 'p.json', 'extra'], 'extra'],
    [['p.json'], 'p.json'],
    [['-x'], '-x']
  ])('rejects %j', (argv, offender) => {
    expect(() => parseArgs(argv)).toThrow(`Unknown or incomplete argument: ${offender}`);
  });

  it('rejects an option given twice', () => {
    expect(() => parseArgs(['--apply', 'a.json', '--apply', 'b.json'])).toThrow('Duplicate argument: --apply');
  });
});

describe('checkPlanFile', () => {
  const good = () => ({ host: 'h', rows: [{ id: 'I1', before: {}, after: { notes: ['n'] } }, { id: 'I2', before: { a: 1 }, after: {} }] });

  it('accepts a well-formed plan, including one with no rows', () => {
    expect(() => checkPlanFile(good())).not.toThrow();
    expect(() => checkPlanFile({ host: 'h', rows: [] })).not.toThrow();
  });

  it.each([
    ['null', () => null, 'not a plan'],
    ['an array', () => [], 'not a plan'],
    ['a string', () => 'plan', 'not a plan'],
    ['no host', () => ({ rows: [] }), 'host'],
    ['a numeric host', () => ({ host: 1, rows: [] }), 'host'],
    ['no rows', () => ({ host: 'h' }), 'rows'],
    ['rows that is an object', () => ({ host: 'h', rows: {} }), 'rows'],
    ['a row that is null', () => ({ host: 'h', rows: [null] }), 'row 0'],
    ['a row without an id', () => ({ host: 'h', rows: [{ before: {}, after: {} }] }), 'row 0'],
    ['a numeric id', () => ({ host: 'h', rows: [{ id: 1, before: {}, after: {} }] }), 'row 0'],
    ['a repeated id', () => { const p = good(); p.rows[1].id = 'I1'; return p; }, 'more than once'],
    ['a null before', () => { const p = good(); p.rows[1].before = null; return p; }, 'row 1'],
    ['an array before', () => { const p = good(); p.rows[1].before = []; return p; }, 'row 1'],
    ['a missing after', () => { const p = good(); delete p.rows[0].after; return p; }, 'row 0'],
    ['a string after', () => { const p = good(); p.rows[0].after = '{}'; return p; }, 'row 0']
  ])('rejects %s', (_name, make, mention) => {
    expect(() => checkPlanFile(make())).toThrow(mention);
  });
});

describe('readPlanFile', () => {
  const withFile = (contents, fn) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-test-'));
    const file = path.join(dir, 'plan.json');
    try {
      if (contents !== null) fs.writeFileSync(file, contents);
      return fn(file);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  };

  it('reads a plan', () => {
    expect(withFile('{"host":"h","rows":[]}', readPlanFile)).toEqual({ host: 'h', rows: [] });
  });

  it('says where the plan should have been when there is no file', () => {
    expect(() => withFile(null, readPlanFile)).toThrow(/^No plan at .*plan\.json$/);
  });

  it('names the file when its JSON is broken', () => {
    expect(() => withFile('{"host":', (file) => {
      try {
        return readPlanFile(file);
      } catch (error) {
        expect(error.message).toContain(`Cannot read plan ${file}`);
        throw error;
      }
    })).toThrow('Cannot read plan');
  });
});

describe('StalePlanError', () => {
  it('names the batch and how many of its rows were stale', () => {
    const error = new StalePlanError(['I2', 'I3'], 3, 500);
    expect(error.message).toBe('batch 3: 2 of 500 rows changed or were edited since the plan (I2, I3); nothing was written');
    expect(error.ids).toEqual(['I2', 'I3']);
    expect(error.name).toBe('StalePlanError');
  });

  it('lists only the first 20 ids in the message, keeping all of them on .ids', () => {
    const ids = Array.from({ length: 25 }, (_, i) => `I${i}`);
    const error = new StalePlanError(ids, 1, 25);
    expect(error.message).toContain('I19, … and 5 more)');
    expect(error.message).not.toContain('I20');
    expect(error.ids).toHaveLength(25);
  });
});
