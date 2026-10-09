// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ROOT } from '../../scripts/neon/cli.js';
import { TEST_DATABASE_URL as url, resetTestDatabase, withChange } from './testDatabase.js';

// Adam (I1) has three families: F1 with Beth (children in position order Dan, Cara), F2 with Eve
// (childless) and F3 without a spouse (Gail, Finn). Hal (I8) has no family at all.
const FIXTURE = `
insert into person (id, given_name, surname, sex, birth_date) values
  ('I1', 'Adam', 'Smith', 'M', null), ('I2', 'Beth', 'Jones', 'F', null), ('I3', 'Cara', 'Smith', 'F', '1902'),
  ('I4', 'Dan', 'Smith', 'M', '1901'), ('I5', 'Eve', 'Brown', 'F', null), ('I6', 'Finn', 'Smith', 'M', null),
  ('I7', 'Gail', 'Smith', 'F', null), ('I8', 'Hal', 'Gray', 'U', null);
insert into family (id, partner1_id, partner2_id, marriage_date, marriage_place) values
  ('F1', 'I1', 'I2', '1900', 'Leeds'),
  ('F2', 'I1', 'I5', '1910', null),
  ('F3', 'I1', null, null, null);
insert into family_child (family_id, child_id, position) values
  ('F1', 'I3', 1), ('F1', 'I4', 0), ('F3', 'I6', 2), ('F3', 'I7', 0);
`;

/** 006's person_record, as its own statement, to compare 007's output with. */
function person_record006() {
  const sql = fs.readFileSync(path.join(ROOT, 'db', 'migrations', '006_editing.sql'), 'utf-8');
  const start = sql.indexOf('create or replace function person_record(p_id text)');
  const end = sql.indexOf('$$;', start);
  if (start < 0 || end < 0) throw new Error("Couldn't find person_record in 006_editing.sql");
  return sql.slice(start, end + 3);
}

describe.skipIf(!url)('person_record marriages[].childIds (007)', () => {
  let client;
  const view = async (id) => (await client.query('select person_view($1) as v', [id])).rows[0].v;

  beforeAll(async () => {
    client = await resetTestDatabase();
    await withChange(client, FIXTURE);
    await client.query('select sync_id_sequences()');
  }, 60000);

  afterAll(async () => {
    await client?.end();
  });

  it("lists each family's children in position order, [] when childless, also for a family without a spouse", async () => {
    const { person } = await view('I1');
    expect(person.marriages).toEqual([
      { spouseId: 'I2', familyId: 'F1', marriageDate: '1900', marriagePlace: 'Leeds', childIds: ['I4', 'I3'] },
      { spouseId: 'I5', familyId: 'F2', marriageDate: '1910', childIds: [] },
      { spouseId: null, familyId: 'F3', childIds: ['I7', 'I6'] }
    ]);
  });

  it('gives the other partner the same children', async () => {
    expect((await view('I2')).person.marriages).toEqual([
      { spouseId: 'I1', familyId: 'F1', marriageDate: '1900', marriagePlace: 'Leeds', childIds: ['I4', 'I3'] }
    ]);
    expect((await view('I5')).person.marriages).toEqual([{ spouseId: 'I1', familyId: 'F2', marriageDate: '1910', childIds: [] }]);
  });

  it('still leaves out marriages for someone with no family', async () => {
    expect((await view('I8')).person.marriages).toBeUndefined();
  });

  it('follows changes to the children', async () => {
    await withChange(client, `update family_child set position = 5 where family_id = 'F1' and child_id = 'I4'`);
    await withChange(client, `delete from family_child where family_id = 'F3' and child_id = 'I7'`);
    const { person } = await view('I1');
    expect(person.marriages.map(m => [m.familyId, m.childIds])).toEqual([['F1', ['I3', 'I4']], ['F2', []], ['F3', ['I6']]]);
  });

  it("otherwise returns exactly 006's person view", async () => {
    const ids = ['I1', 'I2', 'I3', 'I4', 'I5', 'I6', 'I7', 'I8'];
    const views = async () => (await client.query('select id, person_view(id) as v from unnest($1::text[]) as id order by id', [ids])).rows;
    const now = await views();
    let before;
    await client.query('begin');
    try {
      await client.query(person_record006());
      before = await views();
    } finally {
      await client.query('rollback');
    }
    const withoutChildIds = (rows) => rows.map(({ id, v }) => {
      const marriages = v.person.marriages?.map(({ childIds, ...marriage }) => {
        expect(Array.isArray(childIds)).toBe(true);
        return marriage;
      });
      return { id, v: { ...v, person: { ...v.person, ...(marriages ? { marriages } : {}) } } };
    });
    expect(before.some(({ v }) => v.person.marriages?.some(m => 'childIds' in m))).toBe(false);
    expect(withoutChildIds(now)).toEqual(before);
    // The rollback restored 007's definition.
    expect((await view('I5')).person.marriages[0].childIds).toEqual([]);
  });
});
