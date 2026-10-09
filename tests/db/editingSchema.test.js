// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import pg from 'pg';
import { ROOT } from '../../scripts/neon/cli.js';
import { TEST_DATABASE_URL as url, resetTestDatabase, withChange } from './testDatabase.js';

// Three generations: Ann + Bob -> Cat; Cat + Dan -> Eve.
// Ida (I9) is a child of two families: F5 (Fay + Gus, undated, with Jon first) and F6 (Kim alone, 1940).
// Lin (I12) has an empty surname.
const FIXTURE = `
insert into person (id, given_name, surname, sex, birth_date) values
  ('I1', 'Ann', 'Lee', 'F', '1900'),
  ('I2', 'Bob', 'Lee', 'M', null),
  ('I3', 'Cat', 'Lee', 'F', '1930'),
  ('I4', 'Dan', 'Moss', 'M', null),
  ('I5', 'Eve', 'Moss', 'F', '1960'),
  ('I6', 'Fay', 'Hart', 'F', null),
  ('I7', 'Gus', 'Hart', 'M', null),
  ('I8', 'Kim', 'Vale', 'M', null),
  ('I9', 'Ida', 'Hart', 'F', null),
  ('I10', 'Jon', 'Hart', 'M', null),
  ('I12', 'Lin', '', 'F', null);
insert into family (id, partner1_id, partner2_id, marriage_date) values
  ('F1', 'I2', 'I1', '1925'),
  ('F2', 'I4', 'I3', null),
  ('F5', 'I7', 'I6', null),
  ('F6', 'I8', null, '1940');
insert into family_child (family_id, child_id, position) values
  ('F1', 'I3', 0), ('F2', 'I5', 0), ('F5', 'I10', 0), ('F5', 'I9', 1), ('F6', 'I9', 0);
`;

const BEGIN_CHANGE = `select begin_change('test@example.test', 'Test', 'test', 'script', 'Test', '{}', '{}') as id`;

describe.skipIf(!url)('migration 006: editing schema (database)', () => {
  let client;
  const one = async (sql, params) => (await client.query(sql, params)).rows[0];

  /** Runs `sql` in its own committed change; returns the change id and its change_row rows. */
  const recorded = async (sql) => {
    await client.query('begin');
    try {
      const { id } = await one(BEGIN_CHANGE);
      await client.query(sql);
      const { rows } = await client.query(
        'select table_name, row_key, op, before, after from change_row where change_id = $1 order by table_name, id', [id]);
      await client.query('commit');
      return { id, rows };
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  };

  /** Runs `fn` inside a recorded change that is rolled back afterwards. */
  const scratch = async (fn) => {
    await client.query('begin');
    try {
      await client.query(`set local statement_timeout = '10s'`);
      await client.query(BEGIN_CHANGE);
      return await fn();
    } finally {
      await client.query('rollback');
    }
  };

  beforeAll(async () => {
    client = await resetTestDatabase();
    await withChange(client, FIXTURE);
    await client.query('select sync_id_sequences()');
  }, 60000);

  afterAll(async () => {
    await client?.end();
  });

  it('refuses writes to tree tables outside a recorded change', async () => {
    // client has run a change (in beforeAll), so ged.change_id is '' here; on a new connection it was never set.
    await expect(client.query(`insert into person (id, given_name, surname) values ('X1', 'A', 'B')`))
      .rejects.toMatchObject({ code: 'GE005' });
    const fresh = new pg.Client({ connectionString: url });
    await fresh.connect();
    try {
      expect((await fresh.query(`select current_setting('ged.change_id', true) as v`)).rows[0].v).toBeNull();
      await expect(fresh.query(`insert into person (id, given_name, surname) values ('X1', 'A', 'B')`))
        .rejects.toMatchObject({ code: 'GE005' });
    } finally {
      await fresh.end();
    }
    // Even an update that would change nothing.
    await expect(client.query(`update person set birth_date = birth_date where id = 'I1'`))
      .rejects.toMatchObject({ code: 'GE005' });
    expect(await one(`select count(*)::int as n from person where id = 'X1'`)).toEqual({ n: 0 });
  });

  it('begin_change takes the global lock, records the change and sets ged.change_id', async () => {
    await client.query('begin');
    try {
      const { id } = await one(`select begin_change('Test@Example.TEST', 'Tess', 'fixture', 'script', 'A summary', '{"a": 1}', '{I1}') as id`);
      expect(id).toMatch(/^\d+$/);
      expect(await one(`select current_setting('ged.change_id') as v`)).toEqual({ v: id });
      expect(await one('select author_email, author_name, kind, via, summary, params, person_ids, undone from change where id = $1', [id]))
        .toEqual({ author_email: 'test@example.test', author_name: 'Tess', kind: 'fixture', via: 'script',
          summary: 'A summary', params: { a: 1 }, person_ids: ['I1'], undone: false });
      expect(await one(`select count(*)::int as n from pg_locks
        where locktype = 'advisory' and objid = 7262021 and pid = pg_backend_pid() and granted`)).toEqual({ n: 1 });
    } finally {
      await client.query('rollback');
    }
    // The setting is local to the transaction.
    expect(await one(`select coalesce(current_setting('ged.change_id', true), '') as v`)).toEqual({ v: '' });
  });

  it('captures an insert, an update and a delete of a person', async () => {
    const inserted = await recorded(`insert into person (id, given_name, surname, sex) values ('X1', 'Xena', 'Xu', 'F')`);
    expect(inserted.rows).toHaveLength(1);
    expect(inserted.rows[0]).toMatchObject({ table_name: 'person', row_key: { id: 'X1' }, op: 'insert', before: null });
    expect(inserted.rows[0].after).toMatchObject({ id: 'X1', given_name: 'Xena', surname: 'Xu', sex: 'F', birth_date: null });
    expect(inserted.rows[0].after).toHaveProperty('updated_at');
    expect(inserted.rows[0].after).not.toHaveProperty('display_name');

    const updated = await recorded(`update person set birth_date = '1901', updated_at = now() where id = 'X1'`);
    expect(updated.rows).toHaveLength(1);
    expect(updated.rows[0]).toMatchObject({ table_name: 'person', row_key: { id: 'X1' }, op: 'update' });
    expect(updated.rows[0].before).toMatchObject({ id: 'X1', birth_date: null });
    expect(updated.rows[0].after).toMatchObject({ id: 'X1', birth_date: '1901' });
    expect(updated.rows[0].before).not.toHaveProperty('display_name');
    expect(updated.rows[0].after).not.toHaveProperty('display_name');

    const touched = await recorded(`update person set updated_at = updated_at + interval '1 second' where id = 'X1'`);
    expect(touched.rows).toEqual([]);

    const deleted = await recorded(`delete from person where id = 'X1'`);
    expect(deleted.rows).toHaveLength(1);
    expect(deleted.rows[0]).toMatchObject({ table_name: 'person', row_key: { id: 'X1' }, op: 'delete', after: null });
    expect(deleted.rows[0].before).toMatchObject({ id: 'X1', given_name: 'Xena', birth_date: '1901' });
  });

  it('leaves the generated sort_key out of family snapshots and keys family_child by both columns', async () => {
    const { rows } = await recorded(`
      insert into person (id, given_name, surname) values ('Y1', 'Yan', 'Yu');
      insert into family (id, partner1_id) values ('FY1', 'Y1');
      insert into family_child (family_id, child_id, position) values ('F1', 'Y1', 1);
    `);
    expect(rows.map(r => [r.table_name, r.op, r.row_key])).toEqual([
      ['family', 'insert', { id: 'FY1' }],
      ['family_child', 'insert', { family_id: 'F1', child_id: 'Y1' }],
      ['person', 'insert', { id: 'Y1' }]
    ]);
    expect(rows[0].after).toMatchObject({ id: 'FY1', partner1_id: 'Y1', partner2_id: null });
    expect(rows[0].after).not.toHaveProperty('sort_key');
  });

  it('records the cascades of deleting a person under the same change', async () => {
    // Y1 (from the previous test) is a partner in FY1 and a child in F1.
    const { id, rows } = await recorded(`delete from person where id = 'Y1'`);
    expect(rows.map(r => [r.table_name, r.op, r.row_key])).toEqual([
      ['family', 'update', { id: 'FY1' }],
      ['family_child', 'delete', { family_id: 'F1', child_id: 'Y1' }],
      ['person', 'delete', { id: 'Y1' }]
    ]);
    expect(rows[0].before).toMatchObject({ partner1_id: 'Y1' });
    expect(rows[0].after).toMatchObject({ partner1_id: null });
    expect(rows[1].after).toBeNull();
    expect(await one('select count(*)::int as n from change_row where change_id = $1', [id])).toEqual({ n: 3 });
    await withChange(client, `delete from family where id = 'FY1'`);
  });

  it('refuses to truncate tree tables, even inside a change', async () => {
    await expect(client.query('truncate person cascade')).rejects.toMatchObject({ code: 'GE006' });
    await expect(scratch(() => client.query('truncate person cascade'))).rejects.toMatchObject({ code: 'GE006' });
    await expect(scratch(() => client.query('truncate person_media'))).rejects.toMatchObject({ code: 'GE006' });
    expect(await one('select count(*)::int as n from person')).toEqual({ n: 11 });
  });

  it('refuses to change a primary key', async () => {
    await expect(scratch(async () => {
      await client.query(`insert into person (id, given_name, surname) values ('X1', 'Xena', 'Xu')`);
      await client.query(`update person set id = 'X2' where id = 'X1'`);
    })).rejects.toMatchObject({ code: 'GE007' });
  });

  it('generates display_name from the name parts', async () => {
    expect((await client.query(`select id, display_name from person where id in ('I1', 'I12') order by id`)).rows)
      .toEqual([{ id: 'I1', display_name: 'Ann Lee' }, { id: 'I12', display_name: 'Lin' }]);
    await scratch(async () => {
      await client.query(`insert into person (id, given_name, surname) values ('X1', 'Ann', 'Lee'), ('X2', 'Ann', ''), ('X3', '', 'Lee')`);
      expect((await client.query(`select id, display_name from person where id like 'X%' order by id`)).rows)
        .toEqual([{ id: 'X1', display_name: 'Ann Lee' }, { id: 'X2', display_name: 'Ann' }, { id: 'X3', display_name: 'Lee' }]);
      // 428C9: generated_always
      await expect(client.query(`update person set display_name = 'Bogus' where id = 'X1'`)).rejects.toMatchObject({ code: '428C9' });
    });
  });

  it('guards the display_name drop: 006 aborts if any stored name differs from the formula', async () => {
    const sql = fs.readFileSync(path.join(ROOT, 'db', 'migrations', '006_editing.sql'), 'utf-8');
    const guard = sql.match(/^do \$\$\n[\s\S]*?^end \$\$;/m)[0];
    expect(guard).toContain('display_name');
    await client.query('begin');
    try {
      // A temporary table shadows public.person for the unqualified name, as the table stood before 006.
      await client.query(`create temp table person (given_name text not null default '', surname text not null default '',
        display_name text) on commit drop`);
      await client.query(`insert into person values ('Ann', 'Lee', 'Ann Lee'), ('Lin', '', 'Lin')`);
      await client.query(guard);
      await client.query('savepoint mismatch');
      await client.query(`insert into person values ('Bob', 'Lee', 'Robert Lee')`);
      await expect(client.query(guard)).rejects.toThrow(/006: display_name differs/);
      await client.query('rollback to savepoint mismatch');
      await client.query(`insert into person values ('Bob', 'Lee', null)`);
      await expect(client.query(guard)).rejects.toThrow(/006: display_name differs/);
    } finally {
      await client.query('rollback');
    }
  });

  it('moves the id sequences past the largest numeric ids', async () => {
    const people = await one(`select nextval('person_number_seq') as next,
      (select max(substring(id from '[0-9]+')::bigint) from person) as max`);
    expect(people.max).toBe('12');
    expect(Number(people.next)).toBeGreaterThan(Number(people.max));
    const families = await one(`select nextval('family_number_seq') as next,
      (select max(substring(id from '[0-9]+')::bigint) from family) as max`);
    expect(families.max).toBe('6');
    expect(Number(families.next)).toBeGreaterThan(Number(families.max));
  });

  it('lists the site owner as an admin editor', async () => {
    expect(await one(`select role from editor where email = 'saintderanged@gmail.com'`)).toEqual({ role: 'admin' });
  });

  it('adds updatedAt (UTC, microseconds) and parentFamilies to person_record', async () => {
    const ida = (await one(`select person_record('I9') as r`)).r;
    expect(ida.updatedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/);
    const { exact } = await one(`select to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as exact
      from person where id = 'I9'`);
    expect(ida.updatedAt).toBe(exact);
    // F6 (1940) before F5 (undated), although F5 sorts first by id and by sort_key.
    expect(ida.parentFamilies).toEqual([
      { familyId: 'F6', partnerIds: ['I8'], childIds: ['I9'] },
      { familyId: 'F5', partnerIds: ['I7', 'I6'], childIds: ['I10', 'I9'] }
    ]);
    expect((await one(`select person_record('I1') as r`)).r.parentFamilies).toEqual([]);
    expect((await one(`select person_record('I5') as r`)).r.parentFamilies)
      .toEqual([{ familyId: 'F2', partnerIds: ['I4', 'I3'], childIds: ['I5'] }]);

    await client.query('begin');
    try {
      await client.query(`set local timezone = 'America/New_York'`);
      expect((await one(`select person_record('I9') as r`)).r.updatedAt).toBe(exact);
    } finally {
      await client.query('rollback');
    }
  });

  it('indexes display_name for trigram search', async () => {
    const index = await one(`select indexdef from pg_indexes where indexname = 'person_name_trgm_idx'`);
    expect(index.indexdef).toMatch(/using gin \(display_name gin_trgm_ops\)/i);
    const { rows } = await client.query(`select id from person where display_name % 'Ann Le'`);
    expect(rows.map(r => r.id)).toContain('I1');
  });

  it('finds ancestors and descendants', async () => {
    const ids = async (sql, id) => (await client.query(sql, [id])).rows.map(r => r.id).sort();
    expect(await ids('select id from ancestors_of($1)', 'I5')).toEqual(['I1', 'I2', 'I3', 'I4']);
    expect(await ids('select id from ancestors_of($1)', 'I3')).toEqual(['I1', 'I2']);
    expect(await ids('select id from ancestors_of($1)', 'I1')).toEqual([]);
    expect(await ids('select id from descendants_of($1)', 'I1')).toEqual(['I3', 'I5']);
    expect(await ids('select id from descendants_of($1)', 'I4')).toEqual(['I5']);
    expect(await ids('select id from descendants_of($1)', 'I5')).toEqual([]);
  });

  it('terminates on a cyclic tree', async () => {
    await scratch(async () => {
      // C1 is C2's parent and C2 is C1's parent.
      await client.query(`
        insert into person (id, given_name, surname) values ('C1', 'Cy', 'Cle'), ('C2', 'Cyd', 'Cle');
        insert into family (id, partner1_id) values ('FC1', 'C1'), ('FC2', 'C2');
        insert into family_child (family_id, child_id, position) values ('FC1', 'C2', 0), ('FC2', 'C1', 0);
      `);
      const ids = async (sql) => (await client.query(sql)).rows.map(r => r.id).sort();
      expect(await ids(`select id from ancestors_of('C1')`)).toEqual(['C1', 'C2']);
      expect(await ids(`select id from descendants_of('C1')`)).toEqual(['C1', 'C2']);
    });
  });
});
