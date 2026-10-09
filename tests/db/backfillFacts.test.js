// @vitest-environment node
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import crypto from 'crypto';
import { TEST_DATABASE_URL as url, resetTestDatabase } from './testDatabase.js';
import { applyPlan, verifyPlan, planState, writePlan, readDbRows, loadArchive, StalePlanError } from '../../scripts/neon/backfillFacts.js';

const PEOPLE = `
insert into person (id, given_name, surname, display_name, sex, birth_date, facts) values
  ('I1', 'Adam', 'Smith', 'Adam Smith', 'M', '1900', '{"notes": ["old 1"]}'),
  ('I2', 'Beth', 'Jones', 'Beth Jones', 'F', null, '{"occupations": ["Miller"]}'),
  ('I3', 'Carl', 'Smith', 'Carl Smith', 'M', null, '{}');
`;
const PLAN = {
  host: 'test',
  rows: [
    { id: 'I1', before: { notes: ['old 1'] }, after: { notes: ['new 1\nline 2'] } },
    { id: 'I2', before: { occupations: ['Miller'] }, after: { occupations: [{ value: 'Miller', date: '1881' }] } },
    { id: 'I3', before: {}, after: { otherFacts: [{ tag: '_MILT' }] } }
  ]
};

describe.skipIf(!url)('backfillFacts (database)', () => {
  let client;
  const snapshot = async () => (await client.query('select * from person order by id')).rows;
  const factsOf = async () => Object.fromEntries((await client.query('select id, facts from person order by id')).rows.map(r => [r.id, r.facts]));

  beforeAll(async () => {
    client = await resetTestDatabase();
  }, 60000);

  beforeEach(async () => {
    await client.query('truncate person cascade; truncate gedcom_archive;');
    await client.query(PEOPLE);
  });

  afterAll(async () => {
    await client?.end();
  });

  it('applies the plan, touching nothing but facts', async () => {
    const before = await snapshot();
    expect(await applyPlan(client, PLAN)).toEqual({ updated: 3 });
    const after = await snapshot();
    expect(after.map(r => r.facts)).toEqual(PLAN.rows.map(r => r.after));
    expect(after.map(({ facts, ...rest }) => rest)).toEqual(before.map(({ facts, ...rest }) => rest));
    // updated_at is how the next plan tells hand edits from the import, so the apply must not move it.
    expect((await client.query('select count(*)::int as n from person where updated_at <> created_at')).rows[0].n).toBe(0);
    expect(await verifyPlan(client, PLAN)).toEqual([]);
  });

  it('refuses a row edited since the import even when its facts still match', async () => {
    await client.query(`update person set updated_at = updated_at + interval '1 second' where id = 'I2'`);
    const error = await applyPlan(client, PLAN).catch(e => e);
    expect(error).toBeInstanceOf(StalePlanError);
    expect(error.ids).toEqual(['I2']);
    expect(error.message).toBe('batch 1: 1 of 3 rows was changed or edited since the plan (I2); nothing was written');
    expect(await factsOf()).toEqual({ I1: { notes: ['old 1'] }, I2: { occupations: ['Miller'] }, I3: {} });
  });

  it('rolls the whole apply back when a later batch is stale', async () => {
    await client.query(`update person set facts = '{"notes": ["edited"]}' where id = 'I3'`);
    const error = await applyPlan(client, PLAN, { batchSize: 1 }).catch(e => e);
    expect(error).toBeInstanceOf(StalePlanError);
    expect(error.ids).toEqual(['I3']);
    expect(error.message).toMatch(/^batch 3: 1 of 1 row was /);
    expect(await factsOf()).toEqual({ I1: { notes: ['old 1'] }, I2: { occupations: ['Miller'] }, I3: { notes: ['edited'] } });
  });

  it('refuses to roll back a row whose facts drifted from the plan\'s after', async () => {
    await applyPlan(client, PLAN);
    await client.query(`update person set facts = '{"notes": ["changed since the apply"]}' where id = 'I2'`);
    const error = await applyPlan(client, PLAN, { direction: 'rollback' }).catch(e => e);
    expect(error).toBeInstanceOf(StalePlanError);
    expect(error.ids).toEqual(['I2']);
    expect(await factsOf()).toEqual({
      I1: { notes: ['new 1\nline 2'] },
      I2: { notes: ['changed since the apply'] },
      I3: { otherFacts: [{ tag: '_MILT' }] }
    });
  });

  it('rolls back to before, and verifyPlan checks the requested side', async () => {
    await applyPlan(client, PLAN);
    expect(await verifyPlan(client, PLAN, { direction: 'rollback' })).toEqual(['I1', 'I2', 'I3']);
    expect(await applyPlan(client, PLAN, { direction: 'rollback' })).toEqual({ updated: 3 });
    expect(await factsOf()).toEqual({ I1: { notes: ['old 1'] }, I2: { occupations: ['Miller'] }, I3: {} });
    expect(await verifyPlan(client, PLAN, { direction: 'rollback' })).toEqual([]);
    expect(await verifyPlan(client, PLAN)).toEqual(['I1', 'I2', 'I3']);
  });

  it('classifies each planned row as holding the plan\'s before, its after, or neither', async () => {
    expect(await planState(client, PLAN)).toEqual({ atBefore: ['I1', 'I2', 'I3'], atAfter: [], neither: [] });
    await applyPlan(client, PLAN);
    expect(await planState(client, PLAN)).toEqual({ atBefore: [], atAfter: ['I1', 'I2', 'I3'], neither: [] });
    await client.query(`update person set facts = '{"notes": ["tampered"]}' where id = 'I2'`);
    expect(await planState(client, PLAN)).toEqual({ atBefore: [], atAfter: ['I1', 'I3'], neither: ['I2'] });
    await client.query(`delete from person where id = 'I3'`);
    expect(await planState(client, PLAN)).toEqual({ atBefore: [], atAfter: ['I1'], neither: ['I2', 'I3'] });
  });

  describe('writePlan (what the CLI runs)', () => {
    const run = async (direction, plan = PLAN) => {
      const lines = [];
      await writePlan(client, plan, direction, 'test', line => lines.push(line));
      return lines;
    };

    it('applies, verifies and reports the host', async () => {
      const lines = await run('apply');
      expect(lines.map(line => JSON.parse(line))).toEqual([{ direction: 'apply', host: 'test', updated: 3, verified: 3 }]);
      expect(await factsOf()).toEqual({ I1: PLAN.rows[0].after, I2: PLAN.rows[1].after, I3: PLAN.rows[2].after });
    });

    const SHA = 'abcdef0123456789'.repeat(4);
    const CREATED = '2026-10-09T10:00:00.000Z';
    const FACTS_AFTER_APPLY = { I1: PLAN.rows[0].after, I2: PLAN.rows[1].after, I3: PLAN.rows[2].after };
    const FACTS_BEFORE = { I1: { notes: ['old 1'] }, I2: { occupations: ['Miller'] }, I3: {} };

    it('reports a plan whose rows all hold its after, and exits normally', async () => {
      await run('apply');
      expect(await run('apply', { ...PLAN, createdAt: CREATED, archiveSha: SHA })).toEqual([
        `All 3 planned rows on test already hold this plan's after (plan created ${CREATED}, archive abcdef012345); ` +
        'nothing to do. If you expected a change, check this is the plan you meant to apply.'
      ]);
      expect(await factsOf()).toEqual(FACTS_AFTER_APPLY);
    });

    it('reports a plan whose rows all hold its before, and exits normally', async () => {
      await run('apply');
      await run('rollback');
      expect(await run('rollback', { ...PLAN, createdAt: CREATED, archiveSha: SHA })).toEqual([
        `All 3 planned rows on test already hold this plan's before (plan created ${CREATED}, archive abcdef012345); ` +
        'nothing to do. If you expected a change, check this is the plan you applied.'
      ]);
      expect(await factsOf()).toEqual(FACTS_BEFORE);
    });

    it('leaves out whatever the plan file does not say about itself, and agrees with a single row', async () => {
      await run('apply');
      const nothingToDo = ' already hold this plan\'s after';
      const tail = '; nothing to do. If you expected a change, check this is the plan you meant to apply.';
      expect(await run('apply')).toEqual([`All 3 planned rows on test${nothingToDo}${tail}`]);
      expect(await run('apply', { ...PLAN, createdAt: CREATED })).toEqual([`All 3 planned rows on test${nothingToDo} (plan created ${CREATED})${tail}`]);
      expect(await run('apply', { ...PLAN, archiveSha: SHA })).toEqual([`All 3 planned rows on test${nothingToDo} (archive abcdef012345)${tail}`]);
      expect(await run('apply', { host: 'test', rows: [PLAN.rows[1]] })).toEqual([`The only planned row on test already holds this plan's after${tail}`]);
    });

    it('does not report a plan as done while some of its rows still hold the before', async () => {
      await run('apply');
      await client.query(`update person set facts = '{"occupations": ["Miller"]}' where id = 'I2'`);
      const error = await run('apply').catch(e => e);
      expect(error.message).toMatch(/^apply wrote nothing: 1 row holds the plan's before, 2 its after, 0 neither /);
    });

    it('explains an apply that wrote nothing because a row holds neither side', async () => {
      await run('apply');
      await client.query(`update person set facts = '{"notes": ["tampered"]}' where id = 'I2'`);
      const error = await run('apply').catch(e => e);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toMatch(/^apply wrote nothing: 0 rows hold the plan's before, 2 its after, 1 neither \(first ids: .*I2.*\)/);
      expect(error.message).toContain('batch 1: 3 of 3 rows were changed or edited since the plan');
    });

    it('reports an edited row as still holding the plan\'s before', async () => {
      await client.query(`update person set updated_at = updated_at + interval '1 second' where id = 'I2'`);
      const error = await run('apply').catch(e => e);
      expect(error.message).toMatch(/^apply wrote nothing: 3 rows hold the plan's before, 0 its after, 0 neither /);
      expect(await factsOf()).toEqual({ I1: { notes: ['old 1'] }, I2: { occupations: ['Miller'] }, I3: {} });
    });

    it('keeps the database error detail on the error it rethrows', async () => {
      const failing = { query: async (sql) => { if (sql === 'begin') throw Object.assign(new Error('boom'), { detail: 'the detail' }); return { rows: [] }; } };
      const error = await writePlan(failing, PLAN, 'apply', 'test', () => {}).catch(e => e);
      expect(error.message).toContain('boom');
      expect(error.detail).toBe('the detail');
    });

    it('says a re-run may write, and a new plan is the read-only check, when the database cannot be checked after a failure', async () => {
      const failing = { query: async (sql) => { throw new Error(sql === 'begin' ? 'boom' : 'connection lost'); } };
      const error = await writePlan(failing, PLAN, 'apply', 'test', () => {}).catch(e => e);
      expect(error.message).toBe(
        'apply failed and the database could not be checked afterwards (connection lost); ' +
        're-running the same command may carry out the write (guarded by compare-and-swap), ' +
        'while re-planning with a new --out is the read-only way to see where the plan stands. boom');
    });

    // A client that behaves like `client` until the commit, then answers each select of person with `handler(sql, params)`.
    const afterCommit = (handler) => {
      let committed = false;
      return {
        query: async (sql, params) => {
          if (committed && sql.startsWith('select id, facts from person')) return handler(sql, params);
          const result = await client.query(sql, params);
          if (sql === 'commit') committed = true;
          return result;
        }
      };
    };

    it('says the commit happened when the check afterwards fails', async () => {
      const lost = afterCommit(() => { throw Object.assign(new Error('connection lost'), { detail: 'the detail' }); });
      const error = await writePlan(lost, PLAN, 'apply', 'test', () => {}).catch(e => e);
      expect(error.message).toBe('apply committed 3 rows on test, but the check afterwards failed (connection lost); ' +
        're-plan with a new --out (read-only) or re-run the same command to confirm');
      expect(error.detail).toBe('the detail');
      expect(error.cause.message).toBe('connection lost');
      expect(await factsOf()).toEqual(FACTS_AFTER_APPLY);
      // The re-run it suggests finds nothing left to do.
      expect((await run('apply'))[0]).toMatch(/^All 3 planned rows on test already hold this plan's after/);
    });

    it('says the commit happened, in the singular, for a rollback of one row', async () => {
      const one = { host: 'test', rows: [PLAN.rows[0]] };
      await run('apply', one);
      const lost = afterCommit(() => { throw new Error('connection lost'); });
      const error = await writePlan(lost, one, 'rollback', 'test', () => {}).catch(e => e);
      expect(error.message).toMatch(/^rollback committed 1 row on test, but the check afterwards failed \(connection lost\);/);
    });

    it('names the rows that do not match after a commit, in the singular and the plural', async () => {
      const wrong = (ids) => afterCommit(async (sql, params) => {
        const { rows } = await client.query(sql, params);
        return { rows: rows.map(row => (ids.includes(row.id) ? { ...row, facts: { notes: ['somebody else'] } } : row)) };
      });
      const one = await writePlan(wrong(['I2']), PLAN, 'apply', 'test', () => {}).catch(e => e);
      expect(one.message).toBe(`apply committed 3 rows, but 1 doesn't match the plan: I2`);
      await client.query('truncate person cascade');
      await client.query(PEOPLE);
      const two = await writePlan(wrong(['I1', 'I3']), { host: 'test', rows: [PLAN.rows[0], PLAN.rows[2]] }, 'apply', 'test', () => {}).catch(e => e);
      expect(two.message).toBe(`apply committed 2 rows, but 2 don't match the plan: I1, I3`);
    });
  });

  it('flags only rows whose updated_at moved as edited', async () => {
    await client.query(`update person set updated_at = updated_at + interval '1 second' where id = 'I2'`);
    const rows = await readDbRows(client);
    expect(rows.map(r => [r.id, r.edited])).toEqual([['I1', false], ['I2', true], ['I3', false]]);
    expect(rows[0]).toMatchObject({ given_name: 'Adam', birth_date: '1900', facts: { notes: ['old 1'] } });
  });

  it('loads the single archive row and checks its hash', async () => {
    const content = Buffer.from('0 HEAD\n0 TRLR\n');
    const sha = crypto.createHash('sha256').update(content).digest('hex');
    try {
      await expect(loadArchive(client)).rejects.toThrow('found 0');
      await expect(loadArchive(client, '0'.repeat(64))).rejects.toThrow('No gedcom_archive row has sha256');
      await client.query('insert into gedcom_archive (file_name, sha256, content) values ($1, $2, $3)', ['t.ged', sha, content]);
      expect((await loadArchive(client)).content.equals(content)).toBe(true);
      expect((await loadArchive(client, sha)).sha256).toBe(sha);
      await client.query('insert into gedcom_archive (file_name, sha256, content) values ($1, $2, $3)', ['u.ged', 'f'.repeat(64), content]);
      await expect(loadArchive(client)).rejects.toThrow('pass --sha');
      await expect(loadArchive(client, 'f'.repeat(64))).rejects.toThrow('hashes to');
    } finally {
      // Leave the test branch with no archive, so a later plan run against this branch sees none.
      await client.query('truncate gedcom_archive');
    }
  });
});
