// @vitest-environment node
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import crypto from 'crypto';
import { TEST_DATABASE_URL as url, resetTestDatabase } from './testDatabase.js';
import { applyPlan, verifyPlan, readDbRows, loadArchive, StalePlanError } from '../../scripts/neon/backfillFacts.js';

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
    expect(await verifyPlan(client, PLAN)).toEqual([]);
  });

  it('refuses a row edited since the import even when its facts still match', async () => {
    await client.query(`update person set updated_at = updated_at + interval '1 second' where id = 'I2'`);
    const error = await applyPlan(client, PLAN).catch(e => e);
    expect(error).toBeInstanceOf(StalePlanError);
    expect(error.ids).toEqual(['I2']);
    expect(await factsOf()).toEqual({ I1: { notes: ['old 1'] }, I2: { occupations: ['Miller'] }, I3: {} });
  });

  it('rolls the whole apply back when a later batch is stale', async () => {
    await client.query(`update person set facts = '{"notes": ["edited"]}' where id = 'I3'`);
    const error = await applyPlan(client, PLAN, { batchSize: 1 }).catch(e => e);
    expect(error).toBeInstanceOf(StalePlanError);
    expect(error.ids).toEqual(['I3']);
    expect(await factsOf()).toEqual({ I1: { notes: ['old 1'] }, I2: { occupations: ['Miller'] }, I3: { notes: ['edited'] } });
  });

  it('rolls back to before, and verifyPlan checks the requested side', async () => {
    await applyPlan(client, PLAN);
    expect(await verifyPlan(client, PLAN, { direction: 'rollback' })).toEqual(['I1', 'I2', 'I3']);
    expect(await applyPlan(client, PLAN, { direction: 'rollback' })).toEqual({ updated: 3 });
    expect(await factsOf()).toEqual({ I1: { notes: ['old 1'] }, I2: { occupations: ['Miller'] }, I3: {} });
    expect(await verifyPlan(client, PLAN, { direction: 'rollback' })).toEqual([]);
    expect(await verifyPlan(client, PLAN)).toEqual(['I1', 'I2', 'I3']);
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
      await client.query('insert into gedcom_archive (file_name, sha256, content) values ($1, $2, $3)', ['t.ged', sha, content]);
      expect((await loadArchive(client)).content.equals(content)).toBe(true);
      expect((await loadArchive(client, sha)).sha256).toBe(sha);
      await client.query('insert into gedcom_archive (file_name, sha256, content) values ($1, $2, $3)', ['u.ged', 'f'.repeat(64), content]);
      await expect(loadArchive(client)).rejects.toThrow('pass --sha');
      await expect(loadArchive(client, 'f'.repeat(64))).rejects.toThrow('hashes to');
    } finally {
      // Leave the test branch with no archive, so the Task 8 smoke test sees "found 0".
      await client.query('truncate gedcom_archive');
    }
  });
});
