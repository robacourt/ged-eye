// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { planFacts, formatSummary, describeRow, checkConfirm, CORE_COLUMNS } from '../scripts/neon/backfillFacts.js';

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
