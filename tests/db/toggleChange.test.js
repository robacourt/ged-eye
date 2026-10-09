// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { TEST_DATABASE_URL as url, resetTestDatabase, withChange } from './testDatabase.js';

// Each test seeds its own people (ids with a test-specific prefix) and, where the per-user stack
// matters, uses its own author, so the tests don't depend on each other.
const ME = 'me@example.test';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/** SQL inserting a media row; `sha` is a short test-chosen literal. */
const insertMedia = (sha) => `insert into media (sha256, original_path, file_name, content_type, byte_size, object_key, thumb_key)
  values ('${sha}', 'Data/Media/${sha}.jpg', '${sha}.jpg', 'image/jpeg', 10, 'originals/${sha}.jpg', 'thumbs/${sha}.webp')`;

describe.skipIf(!url)('toggle_change, undo_last and redo_last (database)', { timeout: 30000 }, () => {
  let client;
  const one = async (sql, params) => (await client.query(sql, params)).rows[0];
  const all = async (sql, params) => (await client.query(sql, params)).rows;

  /**
   * A base edit made the way a command makes it: `sql` runs inside
   * begin_change(email, 'Name', 'test_edit', via, summary, '{}', personIds) and commits.
   * Like a command, an edit that writes no change_row is rolled back as no_change, so every
   * base change in these tests really changed data.
   */
  const edit = async (email, sql, { personIds = [], summary = 'summary', via = 'edit' } = {}) => {
    await client.query('begin');
    try {
      const { id } = await one(`select begin_change($1, 'Name', 'test_edit', $2, $3, '{}', $4) as id`,
        [email, via, summary, personIds]);
      await client.query(sql);
      const { n } = await one('select count(*)::int as n from change_row where change_id = $1', [id]);
      if (n === 0) throw new Error('no_change');
      await client.query('commit');
      return id;
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  };

  /**
   * A base edit (via 'edit') whose single person change_row is written by hand rather than by the
   * capture trigger, with the given before and after snapshots. Nothing in the person table changes.
   */
  const handMadeChange = async (email, personId, before, after) => {
    await client.query('begin');
    try {
      const { id } = await one(`select begin_change($1, 'Name', 'test_edit', 'edit', 'summary', '{}', array[$2::text]) as id`,
        [email, personId]);
      await client.query(`insert into change_row (change_id, table_name, row_key, op, before, after)
        values ($1, 'person', jsonb_build_object('id', $2::text), 'update', $3, $4)`, [id, personId, before, after]);
      await client.query('commit');
      return id;
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  };
  const snapshot = async (personId) =>
    (await one(`select tree_current('person', jsonb_build_object('id', $1::text)) as s`, [personId])).s;

  const toggle = async (id, dir, email = ME, via = 'history') =>
    (await one(`select toggle_change($1, $2, $3, 'Name', $4) as id`, [id, dir, email, via])).id;
  const undoLast = async (email) => (await one(`select undo_last($1, 'Name') as id`, [email])).id;
  const redoLast = async (email) => (await one(`select redo_last($1, 'Name') as id`, [email])).id;

  const change = (id) => one(`select kind, via, author_email, base_change_id, summary, params, person_ids, undone
    from change where id = $1`, [id]);
  const baseOf = async (toggleId) => (await change(toggleId)).base_change_id;
  const isUndone = async (id) => (await change(id)).undone;
  const togglesOf = async (base) =>
    (await one('select count(*)::int as n from change where base_change_id = $1', [base])).n;
  const rowsOf = (changeId) => all(`select table_name, row_key, op from change_row where change_id = $1 order by id`, [changeId]);
  const person = (id) => one('select * from person where id = $1', [id]);

  /** Awaits a call that must fail; returns its SQLSTATE and, for a GE003 conflict, the parsed detail. */
  const failure = async (promise) => {
    try {
      await promise;
    } catch (error) {
      return { code: error.code, ...(error.code === 'GE003' ? JSON.parse(error.detail) : {}) };
    }
    throw new Error('expected the call to fail');
  };

  beforeAll(async () => {
    client = await resetTestDatabase();
  }, 60000);

  afterAll(async () => {
    await client?.end();
  });

  it('undoes and then redoes a person update', async () => {
    await withChange(client, `insert into person (id, given_name, surname, birth_date) values ('A1', 'Ann', 'Lee', '1900')`);
    const base = await edit(ME, `update person set given_name = 'Anne', birth_date = '1901', updated_at = now() where id = 'A1'`,
      { personIds: ['A1'], summary: 'Edited Anne Lee (birth date)' });

    const undo = await toggle(base, 'undo');
    expect(await person('A1')).toMatchObject({ given_name: 'Ann', display_name: 'Ann Lee', birth_date: '1900' });
    expect(await isUndone(base)).toBe(true);
    expect(await change(undo)).toEqual({
      kind: 'undo', via: 'history', author_email: ME, base_change_id: base, summary: 'Undid: Edited Anne Lee (birth date)',
      params: { base: Number(base) }, person_ids: ['A1'], undone: false
    });
    expect(await rowsOf(undo)).toEqual([{ table_name: 'person', row_key: { id: 'A1' }, op: 'update' }]);

    const redo = await toggle(base, 'redo', 'Me@Example.TEST');
    expect(await person('A1')).toMatchObject({ given_name: 'Anne', display_name: 'Anne Lee', birth_date: '1901' });
    expect(await isUndone(base)).toBe(false);
    expect(await change(redo)).toEqual({
      kind: 'redo', via: 'history', author_email: ME, base_change_id: base, summary: 'Redid: Edited Anne Lee (birth date)',
      params: { base: Number(base) }, person_ids: ['A1'], undone: false
    });
  });

  it('checks conflicts per column: a later notes edit does not block, a later birth-date edit does', async () => {
    await withChange(client, `insert into person (id, given_name, surname, birth_date) values
      ('B1', 'Bea', 'Ray', '1900'), ('B2', 'Bob', 'Ray', '1900')`);

    const base = await edit(ME, `update person set birth_date = '1901' where id = 'B1'`);
    const later = await edit(ME, `update person set facts = '{"notes": ["A later note"]}' where id = 'B1'`);
    await toggle(base, 'undo');
    expect(await person('B1')).toMatchObject({ birth_date: '1900', facts: { notes: ['A later note'] } });
    expect(await isUndone(later)).toBe(false);

    const base2 = await edit(ME, `update person set birth_date = '1901' where id = 'B2'`);
    const later2 = await edit(ME, `update person set birth_date = '1902' where id = 'B2'`);
    expect(await failure(toggle(base2, 'undo'))).toEqual({
      code: 'GE003', reason: 'precondition', blocking: [{ id: Number(later2), action: 'revert' }]
    });
    expect(await person('B2')).toMatchObject({ birth_date: '1902' });
    expect(await isUndone(base2)).toBe(false);
    expect(await togglesOf(base2)).toBe(0);
  });

  it('reports an undone blocker with the restore action', async () => {
    await withChange(client, `insert into person (id, given_name, surname, birth_date) values ('C1', 'Cy', 'Dee', '1900')`);
    const b3 = await edit(ME, `update person set birth_date = '1901' where id = 'C1'`);
    const b5 = await edit(ME, `update person set birth_date = '1902' where id = 'C1'`);
    await toggle(b5, 'undo');
    await toggle(b3, 'undo');
    expect(await person('C1')).toMatchObject({ birth_date: '1900' });
    expect(await failure(toggle(b5, 'redo'))).toEqual({
      code: 'GE003', reason: 'precondition', blocking: [{ id: Number(b3), action: 'restore' }]
    });
    expect(await isUndone(b5)).toBe(true);
  });

  it('undoes an added relative children first, and refuses once a later change links into the family', async () => {
    await withChange(client, `insert into person (id, given_name, surname) values
      ('D1', 'Dan', 'Eck'), ('D3', 'Dot', 'Eck'), ('D4', 'Del', 'Fry')`);
    const base = await edit(ME, `
      insert into person (id, given_name, surname) values ('D2', 'Dee', 'Eck');
      insert into family (id, partner1_id) values ('FD1', 'D1');
      insert into family_child (family_id, child_id, position) values ('FD1', 'D2', 0);`);
    const links = () => one(`select
      (select count(*)::int from person where id = 'D2') as people,
      (select count(*)::int from family where id = 'FD1') as families,
      (select count(*)::int from family_child where family_id = 'FD1') as children`);

    const undo = await toggle(base, 'undo');
    expect(await links()).toEqual({ people: 0, families: 0, children: 0 });
    expect((await rowsOf(undo)).map(r => [r.table_name, r.op])).toEqual([
      ['family_child', 'delete'], ['family', 'delete'], ['person', 'delete']
    ]);
    const redo = await toggle(base, 'redo');
    expect(await links()).toEqual({ people: 1, families: 1, children: 1 });
    expect((await rowsOf(redo)).map(r => [r.table_name, r.op])).toEqual([
      ['person', 'insert'], ['family', 'insert'], ['family_child', 'insert']
    ]);

    const base2 = await edit(ME, `
      insert into person (id, given_name, surname) values ('D5', 'Dag', 'Fry');
      insert into family (id, partner1_id) values ('FD2', 'D4');
      insert into family_child (family_id, child_id, position) values ('FD2', 'D5', 0);`);
    const later = await edit(ME, `insert into family_child (family_id, child_id, position) values ('FD2', 'D3', 1)`);
    // Every precondition holds; deleting FD2 then cascades into the later link.
    expect(await failure(toggle(base2, 'undo'))).toEqual({
      code: 'GE003', reason: 'cascade', blocking: [{ id: Number(later), action: 'revert' }]
    });
    expect(await one(`select count(*)::int as n from family_child where family_id = 'FD2'`)).toEqual({ n: 2 });
    expect(await isUndone(base2)).toBe(false);
  });

  it('names the change that set the partner slot when a removal cascades a set-null onto a later-edited family', async () => {
    await withChange(client, `
      insert into person (id, given_name, surname) values ('DA1', 'Abe', 'Cole');
      insert into family (id, partner1_id) values ('FDA1', 'DA1');`);
    const add = await edit(ME, `insert into person (id, given_name, surname) values ('DA2', 'Ada', 'Cole')`);
    const marry = await edit(ME, `update family set partner2_id = 'DA2' where id = 'FDA1'`);
    // An unrelated later edit to the same family row, in other columns.
    await edit(ME, `update family set marriage_date = '1950' where id = 'FDA1'`);
    // Removing DA2 sets FDA1.partner2_id to null: the blocker is the change that filled that slot.
    expect(await failure(toggle(add, 'undo'))).toEqual({
      code: 'GE003', reason: 'cascade', blocking: [{ id: Number(marry), action: 'revert' }]
    });
    expect(await one(`select partner2_id, marriage_date from family where id = 'FDA1'`))
      .toEqual({ partner2_id: 'DA2', marriage_date: '1950' });
  });

  it('refuses to remove a row that a later change edited', async () => {
    await withChange(client, `insert into person (id, given_name, surname) values ('DB1', 'Bo', 'Dunn')`);
    const add = await edit(ME, `
      insert into person (id, given_name, surname) values ('DB2', 'Bea', 'Dunn');
      insert into family (id, partner1_id) values ('FDB1', 'DB1');
      insert into family_child (family_id, child_id, position) values ('FDB1', 'DB2', 0);`);
    const later = await edit(ME, `update person set birth_date = '1960' where id = 'DB2'`);
    expect(await failure(toggle(add, 'undo'))).toEqual({
      code: 'GE003', reason: 'precondition', blocking: [{ id: Number(later), action: 'revert' }]
    });
    expect(await person('DB2')).toMatchObject({ birth_date: '1960' });
  });

  it('refuses to re-create a row whose key a later change re-used', async () => {
    await withChange(client, `
      insert into person (id, given_name, surname) values ('DC1', 'Cal', 'Eby'), ('DC2', 'Cia', 'Eby'), ('DC3', 'Cob', 'Eby');
      insert into family (id, partner1_id, partner2_id) values ('FDC1', 'DC1', 'DC2');
      insert into family_child (family_id, child_id, position) values ('FDC1', 'DC3', 0);`);
    const unlink = await edit(ME, `delete from family_child where family_id = 'FDC1' and child_id = 'DC3'`);
    const relink = await edit(ME, `insert into family_child (family_id, child_id, position) values ('FDC1', 'DC3', 0)`);
    expect(await failure(toggle(unlink, 'undo'))).toEqual({
      code: 'GE003', reason: 'precondition', blocking: [{ id: Number(relink), action: 'revert' }]
    });
  });

  it('refuses to modify a row that a later change deleted', async () => {
    await withChange(client, `insert into person (id, given_name, surname) values ('DD1', 'Dov', 'Fay')`);
    const base = await edit(ME, `update person set birth_date = '1901' where id = 'DD1'`);
    const deleter = await edit(ME, `delete from person where id = 'DD1'`);
    expect(await failure(toggle(base, 'undo'))).toEqual({
      code: 'GE003', reason: 'precondition', blocking: [{ id: Number(deleter), action: 'revert' }]
    });
  });

  it('lists each blocking change once, and at most five of them', async () => {
    const ids = ['DE1', 'DE2', 'DE3', 'DE4', 'DE5', 'DE6', 'DE7', 'DE8'];
    await withChange(client, `insert into person (id, given_name, surname, birth_date) values
      ${ids.map(id => `('${id}', 'Eli', 'Gow', '1900')`).join(', ')}`);
    const inList = (list) => `(${list.map(id => `'${id}'`).join(', ')})`;

    // One later change touching three of the base's rows is listed once.
    const base = await edit(ME, `update person set birth_date = '1901' where id in ${inList(ids.slice(0, 3))}`);
    const allThree = await edit(ME, `update person set birth_date = '1902' where id in ${inList(ids.slice(0, 3))}`);
    expect(await failure(toggle(base, 'undo'))).toEqual({
      code: 'GE003', reason: 'precondition', blocking: [{ id: Number(allThree), action: 'revert' }]
    });

    // Six distinct later changes block the base: five are listed.
    const base6 = await edit(ME, `update person set death_date = '1980' where id in ${inList(ids.slice(2))}`);
    const later = [];
    for (const id of ids.slice(2)) {
      later.push(Number(await edit(ME, `update person set death_date = '1981' where id = '${id}'`)));
    }
    const { code, reason, blocking } = await failure(toggle(base6, 'undo'));
    expect({ code, reason }).toEqual({ code: 'GE003', reason: 'precondition' });
    expect(blocking).toHaveLength(5);
    expect(new Set(blocking.map(b => b.id)).size).toBe(5);
    for (const b of blocking) {
      expect(later).toContain(b.id);
      expect(b.action).toBe('revert');
    }
  });

  it('undoes and redoes deleting a person with two families, children, a parent family and a photo', async () => {
    await withChange(client, `
      insert into person (id, given_name, surname, sex, birth_date, facts) values
        ('E1', 'Eve', 'Fox', 'F', '1920', '{"notes": ["Her note"]}'),
        ('E2', 'Ed', 'Fox', 'M', null, '{}'),
        ('E3', 'Eli', 'Gay', 'M', null, '{}'),
        ('E4', 'Ena', 'Fox', 'F', null, '{}'),
        ('E5', 'Eon', 'Gay', 'M', null, '{}'),
        ('E6', 'Emil', 'Fox', 'M', null, '{}');
      insert into family (id, partner1_id, partner2_id, marriage_date) values
        ('FE0', 'E6', null, null),
        ('FE1', 'E2', 'E1', '1940'),
        ('FE2', 'E1', 'E3', '1950');
      insert into family_child (family_id, child_id, position) values ('FE0', 'E1', 0), ('FE1', 'E4', 0), ('FE2', 'E5', 0);
      ${insertMedia('e1')};
      insert into person_media (person_id, media_id, position) select 'E1', id, 0 from media where sha256 = 'e1';`);
    const state = () => one(`select
      (select to_jsonb(p) from person p where id = 'E1') as person,
      (select jsonb_agg(to_jsonb(f) order by id) from family f where id like 'FE%') as families,
      (select jsonb_agg(to_jsonb(c) order by family_id, child_id) from family_child c where family_id like 'FE%') as children,
      (select jsonb_agg(to_jsonb(pm)) from person_media pm where person_id = 'E1') as photos,
      (select jsonb_agg(to_jsonb(m)) from media m where sha256 = 'e1') as media`);
    const original = await state();
    expect(original.photos).toHaveLength(1);

    const base = await edit(ME, `delete from person where id = 'E1'`, { personIds: ['E1'] });
    const deleted = await state();
    expect(deleted.person).toBeNull();
    expect(deleted.families.map(f => [f.id, f.partner1_id, f.partner2_id]))
      .toEqual([['FE0', 'E6', null], ['FE1', 'E2', null], ['FE2', null, 'E3']]);
    expect(deleted.photos).toBeNull();
    expect(deleted.media).toEqual(original.media);

    await toggle(base, 'undo');
    expect(await state()).toEqual(original);

    await toggle(base, 'redo');
    expect(await state()).toEqual(deleted);
    expect(await isUndone(base)).toBe(false);
  });

  it('refuses to undo an unlink after the unlinked partner was deleted', async () => {
    await withChange(client, `
      insert into person (id, given_name, surname) values ('G1', 'Gil', 'Hay'), ('G2', 'Gwen', 'Hay'), ('G3', 'Gus', 'Hay');
      insert into family (id, partner1_id, partner2_id) values ('FG1', 'G1', 'G2');
      insert into family_child (family_id, child_id, position) values ('FG1', 'G3', 0);`);
    const unlink = await edit(ME, `update family set partner2_id = null where id = 'FG1'`);
    const later = await edit(ME, `delete from person where id = 'G2'`);
    const conflict = await failure(toggle(unlink, 'undo'));
    expect(conflict).toMatchObject({ code: 'GE003', reason: 'precondition' });
    expect(conflict.blocking).toContainEqual({ id: Number(later), action: 'revert' });
    expect(await isUndone(unlink)).toBe(false);
  });

  it('refuses an undo that would leave a family with no partners', async () => {
    await withChange(client, `
      insert into person (id, given_name, surname) values ('H1', 'Hal', 'Ide'), ('H2', 'Hope', 'Ide'), ('H3', 'Hans', 'Ide');
      insert into family (id, partner1_id) values ('FH1', 'H1');
      insert into family_child (family_id, child_id, position) values ('FH1', 'H3', 0);`);
    const fill = await edit(ME, `update family set partner2_id = 'H2' where id = 'FH1'`);
    const later = await edit(ME, `update family set partner1_id = null where id = 'FH1'`);
    expect(await failure(toggle(fill, 'undo'))).toEqual({
      code: 'GE003', reason: 'structure', blocking: [{ id: Number(later), action: 'revert' }]
    });
    expect(await one(`select partner1_id, partner2_id from family where id = 'FH1'`)).toEqual({ partner1_id: null, partner2_id: 'H2' });
    expect(await isUndone(fill)).toBe(false);
  });

  it('refuses an undo that would make someone their own ancestor', async () => {
    await withChange(client, `
      insert into person (id, given_name, surname) values ('J1', 'Jay', 'Kim'), ('J2', 'Joy', 'Kim');
      insert into family (id, partner1_id) values ('FJ1', 'J1');
      insert into family_child (family_id, child_id, position) values ('FJ1', 'J2', 0);`);
    // J2 is unlinked from J1's family, and the family is cleaned up.
    const unlink = await edit(ME, `
      delete from family_child where family_id = 'FJ1' and child_id = 'J2';
      delete from family where id = 'FJ1';`);
    // Later J1 becomes J2's child.
    const later = await edit(ME, `
      insert into family (id, partner1_id) values ('FJ2', 'J2');
      insert into family_child (family_id, child_id, position) values ('FJ2', 'J1', 0);`);
    // The later change touched two of the cycle's keys (FJ2 and its link to J1): it is listed once.
    expect(await failure(toggle(unlink, 'undo'))).toEqual({
      code: 'GE003', reason: 'cycle', blocking: [{ id: Number(later), action: 'revert' }]
    });
    expect(await one(`select count(*)::int as n from family where id = 'FJ1'`)).toEqual({ n: 0 });
    expect(await isUndone(unlink)).toBe(false);
  });

  it('checks the state of the change being toggled', async () => {
    await withChange(client, `insert into person (id, given_name, surname) values ('K1', 'Kai', 'Lin')`);
    const base = await edit(ME, `update person set birth_date = '1950' where id = 'K1'`);
    const before = await one('select max(id) as id from change');
    expect(await failure(toggle(base, 'redo'))).toEqual({ code: 'GE002' });
    expect(await failure(toggle(base, 'sideways'))).toMatchObject({ code: 'P0001' });
    expect(await failure(toggle('999999999', 'undo'))).toEqual({ code: 'GE001' });
    expect(await one('select max(id) as id from change')).toEqual(before);

    const undo = await toggle(base, 'undo');
    expect(await failure(toggle(base, 'undo'))).toEqual({ code: 'GE002' });
    expect(await failure(toggle(undo, 'undo'))).toEqual({ code: 'GE001' });
    expect(await failure(toggle(undo, 'redo'))).toEqual({ code: 'GE001' });
    expect(await togglesOf(base)).toBe(1);
  });

  it('reports untracked and constraint conflicts with no blockers', async () => {
    await withChange(client, `insert into person (id, given_name, surname, birth_date) values ('K2', 'Kay', 'Lin', '1900')`);
    // The base's snapshot doesn't match the data, and no later change explains why.
    const current = await snapshot('K2');
    const stray = await handMadeChange(ME, 'K2', { ...current, birth_date: '1800' }, { ...current, birth_date: '1801' });
    expect(await failure(toggle(stray, 'undo'))).toEqual({ code: 'GE003', reason: 'untracked', blocking: [] });
    expect(await isUndone(stray)).toBe(false);

    // Another media row took the sha256 while the base was undone: the insert hits the unique constraint.
    const base = await edit(ME, insertMedia('k2'));
    await toggle(base, 'undo');
    await edit(ME, insertMedia('k2'));
    expect(await failure(toggle(base, 'redo'))).toEqual({ code: 'GE003', reason: 'constraint', blocking: [] });
    expect(await isUndone(base)).toBe(true);
    expect(await togglesOf(base)).toBe(1);
  });

  it('toggles a change with no net effect, so Ctrl+Z cannot get stuck on it', async () => {
    const email = 'empty@example.test';
    await withChange(client, `insert into person (id, given_name, surname) values ('L1', 'Lea', 'Moe')`);
    // A change whose only row has before = after (as if a later migration dropped the changed column).
    const empty = await handMadeChange(email, 'L1', await snapshot('L1'), await snapshot('L1'));
    const lea = await person('L1');

    const undo = await undoLast(email);
    expect(await change(undo)).toMatchObject({ kind: 'undo', via: 'keyboard', base_change_id: empty });
    expect(await rowsOf(undo)).toEqual([]);
    expect(await isUndone(empty)).toBe(true);
    expect(await undoLast(email)).toBeNull();

    const redo = await toggle(empty, 'redo');
    expect(await rowsOf(redo)).toEqual([]);
    expect(await isUndone(empty)).toBe(false);
    expect(await person('L1')).toEqual(lea);
  });

  it('undo_last and redo_last work a per-author stack of edits', async () => {
    const email = 'stack@example.test';
    const other = 'other@example.test';
    await withChange(client, `insert into person (id, given_name, surname) values ('M1', 'Max', 'Nye')`);
    const dates = () => one(`select birth_date, death_date, birth_place, burial_date, burial_place from person where id = 'M1'`);

    expect(await undoLast(email)).toBeNull();
    expect(await redoLast(email)).toBeNull();

    const e1 = await edit(email, `update person set birth_date = '1901' where id = 'M1'`);
    const e2 = await edit(email, `update person set death_date = '1980' where id = 'M1'`);
    // Another author's newer edit is never chosen for me.
    const theirs = await edit(other, `update person set birth_place = 'Leeds' where id = 'M1'`);

    // Undo, undo, redo, redo.
    const u2 = await undoLast(email);
    expect(await change(u2)).toMatchObject({ kind: 'undo', via: 'keyboard', author_email: email, base_change_id: e2 });
    const u1 = await undoLast(email);
    expect(await baseOf(u1)).toBe(e1);
    expect(await undoLast(email)).toBeNull();
    expect(await dates()).toMatchObject({ birth_date: null, death_date: null, birth_place: 'Leeds' });
    expect(await isUndone(theirs)).toBe(false);
    expect(await redoLast(other)).toBeNull();

    const r1 = await redoLast(email);
    expect(await change(r1)).toMatchObject({ kind: 'redo', via: 'keyboard', base_change_id: e1 });
    const r2 = await redoLast(email);
    expect(await baseOf(r2)).toBe(e2);
    expect(await redoLast(email)).toBeNull();
    expect(await dates()).toMatchObject({ birth_date: '1901', death_date: '1980', birth_place: 'Leeds' });

    // A new edit clears redo.
    expect(await baseOf(await undoLast(email))).toBe(e2);
    const e3 = await edit(email, `update person set burial_date = '1981' where id = 'M1'`);
    expect(await redoLast(email)).toBeNull();
    expect(await isUndone(e2)).toBe(true);

    // The other author's Ctrl+Z picks their own change.
    expect(await baseOf(await undoLast(other))).toBe(theirs);

    // Script changes are never Ctrl+Z targets.
    const script = await edit(email, `update person set burial_place = 'York' where id = 'M1'`, { via: 'script' });
    expect(await baseOf(await undoLast(email))).toBe(e3);
    expect(await baseOf(await undoLast(email))).toBe(e1);
    expect(await undoLast(email)).toBeNull();
    expect(await isUndone(script)).toBe(false);
    expect(await dates()).toEqual({ birth_date: null, death_date: null, birth_place: null, burial_date: null, burial_place: 'York' });
  });

  it('Ctrl+Z after a History revert of my last edit undoes the edit before it', async () => {
    const email = 'history@example.test';
    await withChange(client, `insert into person (id, given_name, surname) values ('N1', 'Ned', 'Orr')`);
    const e1 = await edit(email, `update person set birth_date = '1901' where id = 'N1'`);
    const e2 = await edit(email, `update person set death_date = '1980' where id = 'N1'`);
    await toggle(e2, 'undo', email, 'history');
    expect(await baseOf(await undoLast(email))).toBe(e1);
    expect(await isUndone(e1)).toBe(true);
    expect(await isUndone(e2)).toBe(true);
    expect(await undoLast(email)).toBeNull();
    // Redo only replays keyboard undos.
    expect(await baseOf(await redoLast(email))).toBe(e1);
    expect(await redoLast(email)).toBeNull();
    expect(await isUndone(e2)).toBe(true);
  });

  it('keeps the bookkeeping right through undo, redo, undo, undo', async () => {
    const email = 'urdd@example.test';
    await withChange(client, `insert into person (id, given_name, surname) values ('O1', 'Ola', 'Pym')`);
    const e1 = await edit(email, `update person set birth_date = '1901' where id = 'O1'`);
    const e2 = await edit(email, `update person set death_date = '1980' where id = 'O1'`);

    expect(await baseOf(await undoLast(email))).toBe(e2);
    expect(await baseOf(await redoLast(email))).toBe(e2);
    expect(await baseOf(await undoLast(email))).toBe(e2);
    expect(await baseOf(await undoLast(email))).toBe(e1);
    expect(await isUndone(e1)).toBe(true);
    expect(await isUndone(e2)).toBe(true);
    expect(await person('O1')).toMatchObject({ birth_date: null, death_date: null });
    expect(await failure(toggle(e2, 'undo', email))).toEqual({ code: 'GE002' });
    expect(await failure(toggle(e1, 'undo', email))).toEqual({ code: 'GE002' });
    expect(await undoLast(email)).toBeNull();

    expect(await baseOf(await redoLast(email))).toBe(e1);
    expect(await baseOf(await redoLast(email))).toBe(e2);
    expect(await redoLast(email)).toBeNull();
    expect(await person('O1')).toMatchObject({ birth_date: '1901', death_date: '1980' });
  });

  it('serialises changes with the global lock', async () => {
    const first = new pg.Client({ connectionString: url });
    const second = new pg.Client({ connectionString: url });
    await first.connect();
    await second.connect();
    try {
      await first.query('begin');
      await first.query(`select begin_change('lock1@example.test', 'Name', 'test_edit', 'script', 'First', '{}', '{}')`);
      await first.query(`insert into person (id, given_name, surname) values ('P1', 'Pat', 'Quin')`);

      await second.query('begin');
      await second.query(`set local statement_timeout = '20s'`);
      let settled = false;
      const blocked = second.query(`select begin_change('lock2@example.test', 'Name', 'test_edit', 'script', 'Second', '{}', '{}')`)
        .then(result => result, error => error)
        .finally(() => { settled = true; });

      // From a third connection: the second is waiting for the advisory lock.
      const waiting = async () => (await one(`select count(*)::int as n from pg_locks
        where locktype = 'advisory' and objid = 7262021 and not granted`)).n;
      const deadline = Date.now() + 10000;
      while (await waiting() !== 1) {
        if (Date.now() > deadline) throw new Error('the second begin_change never waited for the lock');
        await sleep(50);
      }
      await sleep(400);
      expect(settled).toBe(false);

      await first.query('commit');
      const result = await blocked;
      expect(result).not.toBeInstanceOf(Error);
      // Its next statement sees what the first change committed.
      expect((await second.query(`select count(*)::int as n from person where id = 'P1'`)).rows[0]).toEqual({ n: 1 });
      await second.query('rollback');
    } finally {
      await first.end();
      await second.end();
    }
  });

  it('a History revert of a redone change undoes it, and a History restore redoes it', async () => {
    const email = 'redone@example.test';
    await withChange(client, `insert into person (id, given_name, surname) values ('Q1', 'Quy', 'Ros')`);
    const e = await edit(email, `update person set birth_date = '1901' where id = 'Q1'`);
    expect(await baseOf(await undoLast(email))).toBe(e);
    expect(await baseOf(await redoLast(email))).toBe(e);

    const revert = await toggle(e, 'undo', email, 'history');
    expect(await change(revert)).toMatchObject({ kind: 'undo', via: 'history', base_change_id: e });
    expect(await isUndone(e)).toBe(true);
    expect(await person('Q1')).toMatchObject({ birth_date: null });

    const restore = await toggle(e, 'redo', email, 'history');
    expect(await change(restore)).toMatchObject({ kind: 'redo', via: 'history', base_change_id: e });
    expect(await isUndone(e)).toBe(false);
    expect(await person('Q1')).toMatchObject({ birth_date: '1901' });
  });

  it('never records a no-op base edit, as commands roll those back', async () => {
    await withChange(client, `insert into person (id, given_name, surname, birth_date) values ('R1', 'Rex', 'Sol', '1900')`);
    const before = await one('select max(id) as id from change');
    await expect(edit(ME, `update person set birth_date = '1900', updated_at = now() where id = 'R1'`)).rejects.toThrow('no_change');
    expect(await one('select max(id) as id from change')).toEqual(before);
  });

  it('keeps media ids and never snapshots or writes generated columns', async () => {
    await withChange(client, `insert into person (id, given_name, surname) values ('S1', 'Sam', 'Tay')`);
    const base = await edit(ME, `
      ${insertMedia('s1')};
      insert into person_media (person_id, media_id, position) select 'S1', id, 0 from media where sha256 = 's1';`);
    const { id: mediaId } = await one(`select id from media where sha256 = 's1'`);

    await toggle(base, 'undo');
    expect(await one(`select (select count(*)::int from media where sha256 = 's1') as media,
      (select count(*)::int from person_media where person_id = 'S1') as photos`)).toEqual({ media: 0, photos: 0 });
    await toggle(base, 'redo');
    expect(await one(`select id from media where sha256 = 's1'`)).toEqual({ id: mediaId });
    expect(await all(`select media_id from person_media where person_id = 'S1'`)).toEqual([{ media_id: mediaId }]);
    // The identity sequence still hands out fresh ids.
    await withChange(client, insertMedia('s2'));
    expect(Number((await one(`select id from media where sha256 = 's2'`)).id)).toBeGreaterThan(Number(mediaId));

    // display_name isn't compared: a given-name edit is undone although the surname changed later.
    const given = await edit(ME, `update person set given_name = 'Sid' where id = 'S1'`);
    await edit(ME, `update person set surname = 'Tate' where id = 'S1'`);
    await toggle(given, 'undo');
    expect(await person('S1')).toMatchObject({ given_name: 'Sam', surname: 'Tate', display_name: 'Sam Tate' });

    // sort_key is regenerated when a family is re-created.
    const family = await edit(ME, `insert into family (id, partner1_id) values ('F1401', 'S1')`);
    await toggle(family, 'undo');
    await toggle(family, 'redo');
    expect(await one(`select sort_key from family where id = 'F1401'`)).toEqual({ sort_key: '1401' });

    // No snapshot, from any change or toggle in this file, holds a generated column.
    expect(await one(`select count(*)::int as n from change_row
      where coalesce(before ?| array['display_name', 'sort_key'], false) or coalesce(after ?| array['display_name', 'sort_key'], false)`))
      .toEqual({ n: 0 });
  });
});
