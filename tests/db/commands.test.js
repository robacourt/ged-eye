// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { TEST_DATABASE_URL as url, resetTestDatabase, withChange } from './testDatabase.js';
import { createDb } from '../../api/db.js';
import { runChange } from '../../api/changes.js';
import { ApiError } from '../../api/http.js';
import { commandFor } from '../../api/commands/index.js';
import { validateFacts, PERSON_FIELDS } from '../../api/commands/validate.js';
import { changedFactKeys } from '../../api/commands/updatePerson.js';

const ED = { email: 'ed@example.test', name: 'Ed Itor', role: 'editor' };

describe.skipIf(!url)('edit commands (database)', { timeout: 60000 }, () => {
  let client;
  let pool;
  let db;
  const one = async (sql, params) => (await client.query(sql, params)).rows[0];
  const all = async (sql, params) => (await client.query(sql, params)).rows;

  beforeAll(async () => {
    client = await resetTestDatabase();
    pool = new pg.Pool({ connectionString: url, max: 4 });
    db = createDb(pool);
  }, 60000);

  afterAll(async () => {
    await pool?.end();
    await client?.end();
  });

  /**
   * Seeds people and families in one recorded fixture change, taking ids from the sequences (so they
   * never collide with ids that commands create), then syncs the sequences as fixtures must.
   * people:   { key: [given, surname, sex?, { other person columns }?] }
   * families: { key: [partner1Key | null, partner2Key | null, [childKeys]?, { other family columns }?] }
   * Returns { key: id } for both.
   */
  async function seed({ people = {}, families = {} }) {
    const ids = {};
    await client.query('begin');
    try {
      await client.query(`select begin_change('fixture@example.test', 'Fixture', 'fixture', 'script', 'Test fixture', '{}', '{}')`);
      for (const [key, [given, surname, sex = null, extra = {}]] of Object.entries(people)) {
        const columns = { given_name: given, surname, sex, ...extra };
        const names = Object.keys(columns);
        const values = names.map((name) => (name === 'facts' ? JSON.stringify(columns[name]) : columns[name]));
        const { id } = await one(
          `insert into person (id, ${names.join(', ')})
           values ('I' || nextval('person_number_seq'), ${names.map((_, i) => `$${i + 1}`).join(', ')}) returning id`, values);
        ids[key] = id;
      }
      for (const [key, [p1, p2, children = [], extra = {}]] of Object.entries(families)) {
        const columns = { partner1_id: p1 ? ids[p1] : null, partner2_id: p2 ? ids[p2] : null, ...extra };
        const names = Object.keys(columns);
        const { id } = await one(
          `insert into family (id, ${names.join(', ')})
           values ('F' || nextval('family_number_seq'), ${names.map((_, i) => `$${i + 1}`).join(', ')}) returning id`,
          names.map((name) => columns[name]));
        ids[key] = id;
        for (const [position, child] of children.entries()) {
          await client.query('insert into family_child (family_id, child_id, position) values ($1, $2, $3)', [id, ids[child], position]);
        }
      }
      await client.query('select sync_id_sequences()');
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
    return ids;
  }

  const run = (kind, params) => db.runChange(ED, kind, params);

  /** Awaits a command that must fail with an ApiError; returns { status, code, ...extra }. */
  async function failure(promise) {
    try {
      await promise;
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      return { status: error.status, code: error.code, ...error.extra };
    }
    throw new Error('expected the command to fail');
  }

  /** The `field` of the 400 invalid a command fails with (which must carry a message). */
  async function invalidField(kind, params) {
    const result = await failure(run(kind, params));
    expect(result).toMatchObject({ status: 400, code: 'invalid' });
    expect(result.message).toEqual(expect.any(String));
    return result.field;
  }

  const stamp = async (id) => (await one(`select person_view($1) -> 'person' ->> 'updatedAt' as t`, [id])).t;
  const person = (id) => one('select * from person where id = $1', [id]);
  const family = (id) => one(`select id, partner1_id, partner2_id, marriage_date, marriage_place, divorce_date, divorce_place
                              from family where id = $1`, [id]);
  const childrenOf = async (familyId) =>
    (await all('select child_id, position from family_child where family_id = $1 order by position', [familyId]));
  const childIdsOf = async (familyId) => (await childrenOf(familyId)).map((row) => row.child_id);
  const parentFamilyIds = async (personId) =>
    (await all('select family_id from family_child where child_id = $1 order by family_id', [personId])).map((row) => row.family_id);
  const partnerFamilies = (personId) =>
    all('select id, partner1_id, partner2_id from family where $1 in (partner1_id, partner2_id) order by sort_key', [personId]);
  const changeCount = async () => (await one('select count(*)::int as n from change')).n;
  const personCount = async () => (await one('select count(*)::int as n from person')).n;
  const familyCount = async () => (await one('select count(*)::int as n from family')).n;
  const changeRecord = (id) => one(`select kind, via, author_email, author_name, summary, params, person_ids, undone
                                    from change where id = $1`, [id]);

  /** The id the next nextval() of `seq` will give, with its prefix. */
  async function nextId(seq, prefix) {
    const { last_value: last, is_called: called } = await one(`select last_value, is_called from ${seq}`);
    return prefix + (called ? Number(last) + 1 : Number(last));
  }

  /** Every row of the tree tables, minus updated_at, which a toggle stamps on the rows it modifies. */
  async function treeState() {
    const strip = (rows) => rows.map(({ updated_at: _ignored, ...rest }) => rest);
    return {
      person: strip(await all('select * from person order by id')),
      family: await all('select * from family order by id'),
      family_child: await all('select * from family_child order by family_id, child_id'),
      media: await all('select * from media order by id'),
      person_media: await all('select * from person_media order by person_id, media_id')
    };
  }

  const toggle = async (id, direction) =>
    (await one(`select toggle_change($1, $2, $3, $4, 'history') as id`, [id, direction, ED.email, ED.name])).id;

  /**
   * Runs a command, undoes it with toggle_change (the tree must be exactly as before), then redoes it
   * (exactly as the command left it), and returns the command's result.
   */
  async function runUndoRedo(kind, params) {
    const before = await treeState();
    const result = await run(kind, params);
    const after = await treeState();
    expect(after).not.toEqual(before);
    await toggle(result.change.id, 'undo');
    expect(await treeState()).toEqual(before);
    await toggle(result.change.id, 'redo');
    expect(await treeState()).toEqual(after);
    return result;
  }

  /** Asserts that a failed command left nothing behind: no change, person or family rows. */
  async function expectNothingWritten(call) {
    const counts = [await changeCount(), await personCount(), await familyCount()];
    const state = await treeState();
    const result = await call();
    expect([await changeCount(), await personCount(), await familyCount()]).toEqual(counts);
    expect(await treeState()).toEqual(state);
    return result;
  }

  describe('runner', () => {
    it('records the change: kind, via edit, author, params as received, summary and person ids', async () => {
      const t = await seed({ people: { rose: ['Rose', 'Smith', 'F'] } });
      const params = { id: t.rose, expectedUpdatedAt: await stamp(t.rose), fields: { birth_place: '  Leeds ' } };
      const { change, view } = await run('update_person', params);
      expect(change).toEqual({ id: expect.any(Number), summary: 'Edited Rose Smith (birth place)', personIds: [t.rose] });
      expect(await changeRecord(change.id)).toEqual({
        kind: 'update_person', via: 'edit', author_email: ED.email, author_name: ED.name,
        summary: 'Edited Rose Smith (birth place)', params, person_ids: [t.rose], undone: false
      });
      expect(view.person).toMatchObject({ id: t.rose, birthPlace: 'Leeds' });
      expect(view).not.toHaveProperty('masked'); // the handler adds it
    });

    it('rolls back as no_change when a command writes no change rows', async () => {
      const t = await seed({ people: { rose: ['Rose', 'Smith', 'F'] } });
      const noop = {
        kind: 'noop',
        validate: (params) => params,
        run: async (tx) => {
          await tx.query('update person set given_name = given_name where id = $1', [t.rose]);
          return { summary: 'Did nothing', personIds: [t.rose], focusId: t.rose };
        }
      };
      const result = await expectNothingWritten(() => failure(runChange(pool, ED, 'noop', {}, { commands: new Map([['noop', noop]]) })));
      expect(result).toEqual({ status: 400, code: 'no_change' });
    });

    it('rolls everything back when a command fails after writing', async () => {
      const t = await seed({ people: { rose: ['Rose', 'Smith', 'F'] } });
      const failing = {
        kind: 'failing',
        validate: (params) => params,
        run: async (tx) => {
          await tx.query(`update person set birth_date = '1900' where id = $1`, [t.rose]);
          throw new ApiError(409, 'stale');
        }
      };
      const result = await expectNothingWritten(() => failure(runChange(pool, ED, 'failing', {}, { commands: new Map([['failing', failing]]) })));
      expect(result).toEqual({ status: 409, code: 'stale' });
    });

    it('maps a primary-key change (GE007) to a logged 500 internal', async () => {
      const t = await seed({ people: { rose: ['Rose', 'Smith', 'F'] } });
      const rekey = {
        kind: 'rekey',
        validate: (params) => params,
        run: async (tx) => {
          await tx.query(`update person set id = 'X' || id where id = $1`, [t.rose]);
          return { summary: 'x', personIds: [], focusId: null };
        }
      };
      const log = vi.fn();
      const result = await expectNothingWritten(() => failure(runChange(pool, ED, 'rekey', {}, { commands: new Map([['rekey', rekey]]), log })));
      expect(result).toEqual({ status: 500, code: 'internal' });
      expect(log).toHaveBeenCalledTimes(1);
    });

    it('maps an integrity violation (class 23), which only a bug could cause, to a logged 500 internal', async () => {
      const t = await seed({ people: { rose: ['Rose', 'Smith', 'F'] } });
      const duplicate = {
        kind: 'duplicate',
        validate: (params) => params,
        run: async (tx) => {
          await tx.query(`insert into person (id) values ($1)`, [t.rose]);
          return { summary: 'x', personIds: [], focusId: null };
        }
      };
      const log = vi.fn();
      const result = await expectNothingWritten(() =>
        failure(runChange(pool, ED, 'duplicate', {}, { commands: new Map([['duplicate', duplicate]]), log })));
      expect(result).toEqual({ status: 500, code: 'internal' });
      expect(log).toHaveBeenCalledTimes(1);
    });

    it('maps a statement timeout to 503 busy', async () => {
      const slow = {
        kind: 'slow',
        validate: (params) => params,
        run: async (tx) => {
          await tx.query("set local statement_timeout = '50ms'");
          await tx.query('select pg_sleep(1)');
          return { summary: 'x', personIds: [], focusId: null };
        }
      };
      const result = await expectNothingWritten(() =>
        failure(runChange(pool, ED, 'slow', {}, { commands: new Map([['slow', slow]]), log: () => {} })));
      expect(result).toEqual({ status: 503, code: 'busy', message: 'The family tree is busy — please try again.' });
    });

    it('refuses an unknown kind', async () => {
      expect(await invalidField('rename_planet', {})).toBe('kind');
    });

    it('serialises concurrent commands on the global lock: two links that together form a cycle cannot both succeed', async () => {
      const t = await seed({ people: { a: ['Al', 'Ash', 'M'], b: ['Bo', 'Birch', 'M'] } });
      const results = await Promise.allSettled([
        run('link_existing', { relation: 'parent', anchorId: t.a, otherId: t.b }),
        run('link_existing', { relation: 'parent', anchorId: t.b, otherId: t.a })
      ]);
      expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
      const refused = results.find((result) => result.status === 'rejected').reason;
      expect(refused).toMatchObject({ status: 400, code: 'invalid', extra: { field: 'otherId' } });
      expect((await one('select count(*)::int as n from ancestors_of($1) where id = $1', [t.a])).n).toBe(0);
    });
  });

  describe('update_person', () => {
    it('edits fields and facts; summary, person ids and view; undo and redo', async () => {
      const t = await seed({ people: { rose: ['Rose', 'Smith', 'F', { birth_date: '1900', facts: { notes: ['Old'] } }] } });
      const before = await stamp(t.rose);
      const { change, view } = await runUndoRedo('update_person', {
        id: t.rose, expectedUpdatedAt: before,
        fields: { given_name: 'Rose', birth_date: '2 FEB 1901', birth_place: 'Leeds' },
        facts: { notes: ['New'] }
      });
      expect(change.summary).toBe('Edited Rose Smith (birth date, birth place, notes)');
      expect(change.personIds).toEqual([t.rose]);
      expect(await person(t.rose)).toMatchObject({
        given_name: 'Rose', surname: 'Smith', display_name: 'Rose Smith', birth_date: '2 FEB 1901', birth_place: 'Leeds', facts: { notes: ['New'] }
      });
      expect(view.person).toMatchObject({ id: t.rose, birthDate: '2 FEB 1901', notes: ['New'] });
      expect(await stamp(t.rose)).not.toBe(before);
    });

    it('names the person as they are after the edit', async () => {
      const t = await seed({ people: { rose: ['Rose', 'Smith', 'F'] } });
      const { change } = await runUndoRedo('update_person', { id: t.rose, expectedUpdatedAt: await stamp(t.rose), fields: { given_name: 'Rosie' } });
      expect(change.summary).toBe('Edited Rosie Smith (given name)');
      expect((await person(t.rose)).display_name).toBe('Rosie Smith');
    });

    it('allows clearing both names, and calls the result "Unnamed person"', async () => {
      const t = await seed({ people: { rose: ['Rose', 'Smith', 'F'] } });
      const { change } = await run('update_person', { id: t.rose, expectedUpdatedAt: await stamp(t.rose), fields: { given_name: '', surname: '' } });
      expect(change.summary).toBe('Edited Unnamed person (given name, surname)');
      expect(await person(t.rose)).toMatchObject({ given_name: '', surname: '', display_name: '' });
    });

    it('lists every changed fact key, including removed ones, and replaces the whole facts object', async () => {
      const t = await seed({ people: { tom: ['Tom', 'Smith', 'M', { facts: { notes: ['n'], occupations: ['Farmer'], religion: 'Methodist' } }] } });
      const facts = { occupations: ['Farmer', { value: 'Miller', date: '1890' }], religion: 'Methodist', causeOfDeath: 'Fever' };
      const { change } = await runUndoRedo('update_person', { id: t.tom, expectedUpdatedAt: await stamp(t.tom), facts });
      expect(change.summary).toBe('Edited Tom Smith (notes, occupations, cause of death)');
      expect((await person(t.tom)).facts).toEqual(facts);
    });

    it('edits sex, and every date and place column', async () => {
      const t = await seed({ people: { kit: ['Kit', 'Lee'] } });
      const fields = {
        sex: 'U', birth_date: '1', birth_place: '2', death_date: '3', death_place: '4',
        baptism_date: '5', baptism_place: '6', burial_date: '7', burial_place: '8', surname: 'Leigh'
      };
      const { change } = await runUndoRedo('update_person', { id: t.kit, expectedUpdatedAt: await stamp(t.kit), fields });
      expect(change.summary).toBe('Edited Kit Leigh (surname, sex, birth date, birth place, death date, death place, '
        + 'baptism date, baptism place, burial date, burial place)');
      expect(await person(t.kit)).toMatchObject(fields);
    });

    it('stores trimmed text, and empty optional fields as null', async () => {
      const t = await seed({ people: { rose: ['Rose', 'Smith', 'F', { birth_place: 'Leeds' }] } });
      await run('update_person', { id: t.rose, expectedUpdatedAt: await stamp(t.rose), fields: { birth_place: '', death_place: '  York ' } });
      expect(await person(t.rose)).toMatchObject({ birth_place: null, death_place: 'York' });
    });

    it('is stale (409) when the person changed since it was read', async () => {
      const t = await seed({ people: { rose: ['Rose', 'Smith', 'F'] } });
      const seen = await stamp(t.rose);
      await run('update_person', { id: t.rose, expectedUpdatedAt: seen, fields: { birth_date: '1900' } });
      const result = await expectNothingWritten(() =>
        failure(run('update_person', { id: t.rose, expectedUpdatedAt: seen, fields: { birth_date: '1901' } })));
      expect(result).toMatchObject({ status: 409, code: 'stale' });
      expect((await person(t.rose)).birth_date).toBe('1900');
      expect(await failure(run('update_person', { id: t.rose, expectedUpdatedAt: 'not a time', fields: { birth_date: '1901' } })))
        .toMatchObject({ status: 409, code: 'stale' });
    });

    it('is not_found (404) for an unknown person', async () => {
      const result = await expectNothingWritten(() =>
        failure(run('update_person', { id: 'I999999', expectedUpdatedAt: '2026-10-09T00:00:00.000000Z', fields: { birth_date: '1' } })));
      expect(result).toMatchObject({ status: 404, code: 'not_found' });
    });

    it('is no_change (400) when nothing differs, writing nothing', async () => {
      const facts = { notes: ['a'], censusRecords: [{ date: '1881', place: 'Leeds' }], religion: 'Methodist' };
      const t = await seed({ people: { rose: ['Rose', 'Smith', 'F', { birth_date: '1900', facts }] } });
      const expectedUpdatedAt = await stamp(t.rose);
      const same = [
        { fields: { given_name: 'Rose', surname: 'Smith', sex: 'F', birth_date: '1900', birth_place: null } },
        { fields: { birth_place: '' } },
        { fields: { given_name: ' Rose ' } },
        { facts: { religion: 'Methodist', censusRecords: [{ place: 'Leeds', date: '1881' }], notes: ['a'] } },
        { fields: {} },
        {}
      ];
      for (const edit of same) {
        const result = await expectNothingWritten(() => failure(run('update_person', { id: t.rose, expectedUpdatedAt, ...edit })));
        expect(result).toEqual({ status: 400, code: 'no_change' });
      }
      expect(await stamp(t.rose)).toBe(expectedUpdatedAt);
    });

    it('refuses invalid fields and facts without writing', async () => {
      const t = await seed({ people: { rose: ['Rose', 'Smith', 'F'] } });
      const base = { id: t.rose, expectedUpdatedAt: await stamp(t.rose) };
      const cases = [
        [{ fields: { sex: 'X' } }, 'sex'],
        [{ fields: { display_name: 'X' } }, 'display_name'],
        [{ fields: { birth_place: 'x'.repeat(501) } }, 'birth_place'],
        [{ fields: { birth_place: 'a\nb' } }, 'birth_place'],
        [{ facts: { hobbies: 'x' } }, 'facts.hobbies'],
        [{ facts: { notes: [3] } }, 'facts.notes'],
        [{ facts: { notes: ['x'.repeat(100001)] } }, 'facts.notes'],
        [{ facts: { notes: Array(6).fill('x'.repeat(99000)) } }, 'facts']
      ];
      for (const [edit, field] of cases) {
        expect(await expectNothingWritten(() => invalidField('update_person', { ...base, ...edit }))).toBe(field);
      }
    });
  });

  describe('add_relative', () => {
    it('parent of someone without parents: creates F(B, none) with A as its child; ids from the sequences', async () => {
      const t = await seed({ people: { rose: ['Rose', 'Smith', 'F'] } });
      const [newPerson, newFamily] = [await nextId('person_number_seq', 'I'), await nextId('family_number_seq', 'F')];
      const { change, view } = await runUndoRedo('add_relative', {
        anchorId: t.rose, relation: 'parent', person: { fields: { given_name: 'Ann', surname: 'Jones', sex: 'F', birth_date: '1870' }, facts: { notes: ['Hi'] } }
      });
      expect(change.summary).toBe('Added Ann Jones as the mother of Rose Smith');
      expect(change.personIds).toEqual([newPerson, t.rose]);
      expect(await person(newPerson)).toMatchObject({ given_name: 'Ann', surname: 'Jones', display_name: 'Ann Jones', sex: 'F', birth_date: '1870', facts: { notes: ['Hi'] } });
      expect(await family(newFamily)).toMatchObject({ partner1_id: newPerson, partner2_id: null });
      expect(await childrenOf(newFamily)).toEqual([{ child_id: t.rose, position: 0 }]);
      expect(view.person.id).toBe(t.rose); // focus: the anchor
      expect(view.relationships.parents).toEqual([newPerson]);
    });

    it('parent: fills the empty slot of the only parent family, so B is a parent of all its children', async () => {
      const t = await seed({
        people: { tom: ['Tom', 'Smith', 'M'], rose: ['Rose', 'Smith', 'F'], jack: ['Jack', 'Smith', 'M'] },
        families: { f: ['tom', null, ['rose', 'jack']] }
      });
      const ann = await nextId('person_number_seq', 'I');
      const { change } = await runUndoRedo('add_relative', { anchorId: t.rose, relation: 'parent', person: { fields: { given_name: 'Ann', surname: 'Jones', sex: 'F' } } });
      expect(change.summary).toBe('Added Ann Jones as the mother of Rose Smith');
      expect(change.personIds).toEqual([ann, t.rose, t.tom, t.jack]);
      expect(await family(t.f)).toMatchObject({ partner1_id: t.tom, partner2_id: ann }); // Tom doesn't move
      expect((await one('select parent_ids($1) as ids', [t.jack])).ids).toEqual([t.tom, ann]);
    });

    it('parent: fills partner1 when that is the free slot', async () => {
      const t = await seed({ people: { ann: ['Ann', 'Jones', 'F'], rose: ['Rose', 'Smith', 'F'] }, families: { f: [null, 'ann', ['rose']] } });
      const tom = await nextId('person_number_seq', 'I');
      const { change } = await run('add_relative', { anchorId: t.rose, relation: 'parent', familyId: t.f, person: { fields: { given_name: 'Tom', surname: 'Smith', sex: 'M' } } });
      expect(change.summary).toBe('Added Tom Smith as the father of Rose Smith');
      expect(await family(t.f)).toMatchObject({ partner1_id: tom, partner2_id: t.ann });
    });

    it('parent: with several parent families, familyId is required and must be one of them', async () => {
      const t = await seed({
        people: { tom: ['Tom', 'Smith', 'M'], ann: ['Ann', 'Jones', 'F'], kim: ['Kim', 'Lee', 'F'], rose: ['Rose', 'Smith', 'F'] },
        families: { birth: ['tom', null, ['rose']], adoptive: [null, 'ann', ['rose']], other: ['tom', 'kim'] }
      });
      const params = { anchorId: t.rose, relation: 'parent', person: { fields: { given_name: 'Sam' } } };
      expect(await expectNothingWritten(() => invalidField('add_relative', params))).toBe('familyId');
      expect(await expectNothingWritten(() => invalidField('add_relative', { ...params, familyId: t.other }))).toBe('familyId');
      expect(await expectNothingWritten(() => invalidField('add_relative', { ...params, familyId: 'F999999' }))).toBe('familyId');
      const sam = await nextId('person_number_seq', 'I');
      await run('add_relative', { ...params, familyId: t.adoptive });
      expect(await family(t.adoptive)).toMatchObject({ partner1_id: sam, partner2_id: t.ann });
      expect(await family(t.birth)).toMatchObject({ partner1_id: t.tom, partner2_id: null });
    });

    it('parent: refuses a family that already has two parents', async () => {
      const t = await seed({
        people: { tom: ['Tom', 'Smith', 'M'], ann: ['Ann', 'Jones', 'F'], rose: ['Rose', 'Smith', 'F'] },
        families: { f: ['tom', 'ann', ['rose']] }
      });
      expect(await expectNothingWritten(() =>
        invalidField('add_relative', { anchorId: t.rose, relation: 'parent', person: { fields: { given_name: 'Sam' } } }))).toBe('familyId');
    });

    it('child: joins a family where A is a partner, at position max+1', async () => {
      const t = await seed({
        people: { tom: ['Tom', 'Smith', 'M'], ann: ['Ann', 'Jones', 'F'], rose: ['Rose', 'Smith', 'F'], jack: ['Jack', 'Smith', 'M'] },
        families: { f: ['tom', 'ann', ['rose', 'jack']] }
      });
      const lily = await nextId('person_number_seq', 'I');
      const { change, view } = await runUndoRedo('add_relative', {
        anchorId: t.tom, relation: 'child', familyId: t.f, person: { fields: { given_name: 'Lily', surname: 'Smith', sex: 'F' } }
      });
      expect(change.summary).toBe('Added Lily Smith as a daughter of Tom Smith');
      expect(change.personIds).toEqual([lily, t.tom, t.ann, t.rose, t.jack]);
      expect(await childrenOf(t.f)).toEqual([{ child_id: t.rose, position: 0 }, { child_id: t.jack, position: 1 }, { child_id: lily, position: 2 }]);
      expect(view.person.id).toBe(t.tom);
    });

    it('child: familyId is required and must be a family where A is a partner', async () => {
      const t = await seed({
        people: { tom: ['Tom', 'Smith', 'M'], ann: ['Ann', 'Jones', 'F'], rose: ['Rose', 'Smith', 'F'] },
        families: { f: ['tom', 'ann', ['rose']] }
      });
      const params = { anchorId: t.rose, relation: 'child', person: { fields: { given_name: 'Sam' } } };
      expect(await expectNothingWritten(() => invalidField('add_relative', params))).toBe('familyId');
      expect(await expectNothingWritten(() => invalidField('add_relative', { ...params, familyId: t.f }))).toBe('familyId'); // Rose is its child
      expect(await expectNothingWritten(() => invalidField('add_relative', { ...params, familyId: 'F999999' }))).toBe('familyId');
    });

    it("child with familyId 'new': reuses A's only single-parent family", async () => {
      const t = await seed({
        people: { tom: ['Tom', 'Smith', 'M'], ann: ['Ann', 'Jones', 'F'], rose: ['Rose', 'Smith', 'F'] },
        families: { couple: ['tom', 'ann'], alone: ['tom', null, ['rose']] }
      });
      const families = await familyCount();
      const sam = await nextId('person_number_seq', 'I');
      const { change } = await runUndoRedo('add_relative', { anchorId: t.tom, relation: 'child', familyId: 'new', person: { fields: { given_name: 'Sam', surname: 'Smith' } } });
      expect(change.summary).toBe('Added Sam Smith as a child of Tom Smith');
      expect(await familyCount()).toBe(families);
      expect(await childIdsOf(t.alone)).toEqual([t.rose, sam]);
    });

    it("child with familyId 'new': creates F(A, none) when A has no single-parent family", async () => {
      const t = await seed({ people: { ann: ['Ann', 'Jones', 'F'], tom: ['Tom', 'Smith', 'M'] }, families: { couple: ['tom', 'ann'] } });
      const [sam, f] = [await nextId('person_number_seq', 'I'), await nextId('family_number_seq', 'F')];
      const { change } = await runUndoRedo('add_relative', { anchorId: t.ann, relation: 'child', familyId: 'new', person: { fields: { given_name: 'Sam', sex: 'M' } } });
      expect(change.summary).toBe('Added Sam as a son of Ann Jones');
      expect(change.personIds).toEqual([sam, t.ann]);
      expect(await family(f)).toMatchObject({ partner1_id: t.ann, partner2_id: null }); // A first, whatever their sex
      expect(await childIdsOf(f)).toEqual([sam]);
      expect(await childIdsOf(t.couple)).toEqual([]);
    });

    it("child with familyId 'new': creates a new family when A has several single-parent families", async () => {
      const t = await seed({ people: { ann: ['Ann', 'Jones', 'F'], a: ['A', 'X'], b: ['B', 'X'] }, families: { one: ['ann', null, ['a']], two: [null, 'ann', ['b']] } });
      const f = await nextId('family_number_seq', 'F');
      const sam = await nextId('person_number_seq', 'I');
      await run('add_relative', { anchorId: t.ann, relation: 'child', familyId: 'new', person: { fields: { given_name: 'Sam' } } });
      expect(await family(f)).toMatchObject({ partner1_id: t.ann, partner2_id: null });
      expect(await childIdsOf(f)).toEqual([sam]);
      expect(await childIdsOf(t.one)).toEqual([t.a]);
      expect(await childIdsOf(t.two)).toEqual([t.b]);
    });

    it('spouse: creates F(A, B) with the male partner first when exactly one is male, else A first', async () => {
      const t = await seed({
        people: { ann: ['Ann', 'Jones', 'F'], tom: ['Tom', 'Smith', 'M'], kim: ['Kim', 'Lee', 'U'], bob: ['Bob', 'Ray', 'M'] }
      });
      const cases = [
        [t.ann, 'M', 'Added Max Doe as the husband of Ann Jones', (a, b) => [b, a]],
        [t.tom, 'F', 'Added Max Doe as the wife of Tom Smith', (a, b) => [a, b]],
        [t.ann, 'F', 'Added Max Doe as the wife of Ann Jones', (a, b) => [a, b]],
        [t.kim, 'M', 'Added Max Doe as the husband of Kim Lee', (a, b) => [b, a]],
        [t.bob, 'M', 'Added Max Doe as the husband of Bob Ray', (a, b) => [a, b]],
        [t.ann, null, 'Added Max Doe as the spouse of Ann Jones', (a, b) => [a, b]]
      ];
      for (const [anchorId, sex, summary, order] of cases) {
        const [b, f] = [await nextId('person_number_seq', 'I'), await nextId('family_number_seq', 'F')];
        const { change } = await runUndoRedo('add_relative', { anchorId, relation: 'spouse', person: { fields: { given_name: 'Max', surname: 'Doe', sex } } });
        expect(change.summary).toBe(summary);
        expect(change.personIds).toEqual([b, anchorId]);
        const [p1, p2] = order(anchorId, b);
        expect(await family(f)).toMatchObject({ partner1_id: p1, partner2_id: p2 });
        expect(await childIdsOf(f)).toEqual([]);
      }
    });

    it("sibling: joins A's only parent family at position max+1", async () => {
      const t = await seed({
        people: { tom: ['Tom', 'Smith', 'M'], ann: ['Ann', 'Jones', 'F'], rose: ['Rose', 'Smith', 'F'] },
        families: { f: ['tom', 'ann', ['rose']] }
      });
      const jack = await nextId('person_number_seq', 'I');
      const { change } = await runUndoRedo('add_relative', { anchorId: t.rose, relation: 'sibling', person: { fields: { given_name: 'Jack', surname: 'Smith', sex: 'M' } } });
      expect(change.summary).toBe('Added Jack Smith as a brother of Rose Smith');
      expect(change.personIds).toEqual([jack, t.rose, t.tom, t.ann]);
      expect(await childrenOf(t.f)).toEqual([{ child_id: t.rose, position: 0 }, { child_id: jack, position: 1 }]);
    });

    it('sibling: needs a parent family; with several, familyId must choose one', async () => {
      const t = await seed({
        people: { tom: ['Tom', 'Smith', 'M'], ann: ['Ann', 'Jones', 'F'], rose: ['Rose', 'Smith', 'F'], orphan: ['Ola', 'Nobody', 'F'] },
        families: { birth: ['tom', null, ['rose']], adoptive: [null, 'ann', ['rose']] }
      });
      const params = { relation: 'sibling', person: { fields: { given_name: 'Sam', sex: 'F' } } };
      expect(await expectNothingWritten(() => invalidField('add_relative', { ...params, anchorId: t.orphan }))).toBe('relation');
      expect(await expectNothingWritten(() => invalidField('add_relative', { ...params, anchorId: t.rose }))).toBe('familyId');
      expect(await expectNothingWritten(() => invalidField('add_relative', { ...params, anchorId: t.rose, familyId: 'F999999' }))).toBe('familyId');
      const sam = await nextId('person_number_seq', 'I');
      const { change } = await run('add_relative', { ...params, anchorId: t.rose, familyId: t.adoptive });
      expect(change.summary).toBe('Added Sam as a sister of Rose Smith');
      expect(await childIdsOf(t.adoptive)).toEqual([t.rose, sam]);
    });

    it('sibling: refuses a legacy partnerless family', async () => {
      const t = await seed({ people: { rose: ['Rose', 'Smith', 'F'] }, families: { f: [null, null, ['rose']] } });
      expect(await expectNothingWritten(() =>
        invalidField('add_relative', { anchorId: t.rose, relation: 'sibling', person: { fields: { given_name: 'Sam' } } }))).toBe('familyId');
    });

    it('uses neutral words when the new person has no known sex', async () => {
      const t = await seed({
        people: { tom: ['Tom', 'Smith', 'M'], rose: ['Rose', 'Smith', 'F'], solo: ['Solo', 'Han', 'M'] },
        families: { f: ['tom', null, ['rose']] }
      });
      const unknown = { fields: { given_name: 'Pat', surname: 'Doe', sex: 'U' } };
      expect((await run('add_relative', { anchorId: t.tom, relation: 'child', familyId: t.f, person: unknown })).change.summary)
        .toBe('Added Pat Doe as a child of Tom Smith');
      expect((await run('add_relative', { anchorId: t.rose, relation: 'sibling', person: unknown })).change.summary)
        .toBe('Added Pat Doe as a sibling of Rose Smith');
      expect((await run('add_relative', { anchorId: t.rose, relation: 'parent', person: unknown })).change.summary)
        .toBe('Added Pat Doe as a parent of Rose Smith');
      expect((await run('add_relative', { anchorId: t.solo, relation: 'spouse', person: {} })).change.summary)
        .toBe('Added Unnamed person as the spouse of Solo Han');
    });

    it('is not_found (404) for an unknown anchor, creating nobody', async () => {
      const result = await expectNothingWritten(() =>
        failure(run('add_relative', { anchorId: 'I999999', relation: 'spouse', person: { fields: { given_name: 'Sam' } } })));
      expect(result).toMatchObject({ status: 404, code: 'not_found' });
    });

    it('refuses an invalid new person', async () => {
      const t = await seed({ people: { rose: ['Rose', 'Smith', 'F'] } });
      expect(await expectNothingWritten(() =>
        invalidField('add_relative', { anchorId: t.rose, relation: 'spouse', person: { fields: { sex: 'Q' } } }))).toBe('sex');
      expect(await expectNothingWritten(() =>
        invalidField('add_relative', { anchorId: t.rose, relation: 'spouse', person: { facts: { nope: 'x' } } }))).toBe('facts.nope');
    });
  });

  describe('link_existing', () => {
    it('refuses linking a person to themselves, for every relation', async () => {
      const t = await seed({ people: { tom: ['Tom', 'Smith', 'M'] }, families: { f: ['tom', null] } });
      for (const relation of ['parent', 'child', 'spouse', 'sibling']) {
        const familyId = relation === 'child' ? t.f : undefined;
        expect(await expectNothingWritten(() => invalidField('link_existing', { relation, anchorId: t.tom, otherId: t.tom, familyId }))).toBe('otherId');
      }
    });

    it('is not_found (404) when either person is unknown', async () => {
      const t = await seed({ people: { tom: ['Tom', 'Smith', 'M'] } });
      expect(await failure(run('link_existing', { relation: 'spouse', anchorId: t.tom, otherId: 'I999999' }))).toMatchObject({ status: 404, code: 'not_found' });
      expect(await failure(run('link_existing', { relation: 'spouse', anchorId: 'I999999', otherId: t.tom }))).toMatchObject({ status: 404, code: 'not_found' });
    });

    it('parent: fills the free slot; summary; undo and redo', async () => {
      const t = await seed({
        people: { tom: ['Tom', 'Smith', 'M'], ann: ['Ann', 'Jones', 'F'], rose: ['Rose', 'Smith', 'F'], jack: ['Jack', 'Smith', 'M'] },
        families: { f: ['tom', null, ['rose', 'jack']] }
      });
      const { change, view } = await runUndoRedo('link_existing', { relation: 'parent', anchorId: t.rose, otherId: t.ann });
      expect(change.summary).toBe('Linked Ann Jones as the mother of Rose Smith');
      expect(change.personIds).toEqual([t.ann, t.rose, t.tom, t.jack]);
      expect(await family(t.f)).toMatchObject({ partner1_id: t.tom, partner2_id: t.ann });
      expect(view.person.id).toBe(t.rose);
    });

    it('parent: creates F(B, none) when A has no parent family', async () => {
      const t = await seed({ people: { tom: ['Tom', 'Smith', 'M'], rose: ['Rose', 'Smith', 'F'] } });
      const f = await nextId('family_number_seq', 'F');
      const { change } = await runUndoRedo('link_existing', { relation: 'parent', anchorId: t.rose, otherId: t.tom });
      expect(change.summary).toBe('Linked Tom Smith as the father of Rose Smith');
      expect(await family(f)).toMatchObject({ partner1_id: t.tom, partner2_id: null });
      expect(await childIdsOf(f)).toEqual([t.rose]);
    });

    it("parent and sibling: refuse a familyId that isn't one of A's parent families", async () => {
      const t = await seed({
        people: { tom: ['Tom', 'Smith', 'M'], ann: ['Ann', 'Jones', 'F'], rose: ['Rose', 'Smith', 'F'], kim: ['Kim', 'Lee', 'F'] },
        families: { birth: ['tom', null, ['rose']], roses: ['rose', null] }
      });
      for (const relation of ['parent', 'sibling']) {
        expect(await expectNothingWritten(() => invalidField('link_existing', { relation, anchorId: t.rose, otherId: t.kim, familyId: t.roses }))).toBe('familyId');
        expect(await expectNothingWritten(() => invalidField('link_existing', { relation, anchorId: t.rose, otherId: t.kim, familyId: 'F999999' }))).toBe('familyId');
      }
      expect(await expectNothingWritten(() => invalidField('link_existing', { relation: 'parent', anchorId: t.rose, otherId: t.ann, familyId: t.roses }))).toBe('familyId');
    });

    it("parent: filling a free slot applies the spouse rules to the new couple", async () => {
      const t = await seed({
        people: { tom: ['Tom', 'Smith', 'M'], ann: ['Ann', 'Jones', 'F'], rose: ['Rose', 'Smith', 'F'] },
        families: { couple: ['tom', 'ann'], roses: ['tom', null, ['rose']] }
      });
      // Tom and Ann are already a couple elsewhere: Rose should be linked to that family instead.
      expect(await expectNothingWritten(() => failure(run('link_existing', { relation: 'parent', anchorId: t.rose, otherId: t.ann }))))
        .toMatchObject({ status: 400, code: 'invalid', field: 'otherId', message: 'Ann Jones and Tom Smith are already partners in another family.' });
    });

    it('parent: refuses B who is already a partner in that family', async () => {
      const t = await seed({ people: { tom: ['Tom', 'Smith', 'M'], rose: ['Rose', 'Smith', 'F'] }, families: { f: ['tom', null, ['rose']] } });
      expect(await expectNothingWritten(() => invalidField('link_existing', { relation: 'parent', anchorId: t.rose, otherId: t.tom }))).toBe('otherId');
    });

    it('parent: refuses cycles (B a child of P, or a descendant of any child of P, or of A)', async () => {
      const t = await seed({
        people: {
          tom: ['Tom', 'Smith', 'M'], rose: ['Rose', 'Smith', 'F'], jack: ['Jack', 'Smith', 'M'],
          niece: ['Nia', 'Smith', 'F'], grandson: ['Gus', 'Smith', 'M'], lone: ['Lone', 'Wolf', 'M'], lonesKid: ['Kid', 'Wolf', 'M'],
          lonesGrandkid: ['Grand', 'Wolf', 'F']
        },
        families: {
          f: ['tom', null, ['rose', 'jack']],
          jacks: ['jack', null, ['niece']],
          roses: [null, 'rose', ['grandson']],
          lones: ['lone', null, ['lonesKid']],
          kids: ['lonesKid', null, ['lonesGrandkid']]
        }
      });
      const link = (anchorId, otherId) => expectNothingWritten(() => invalidField('link_existing', { relation: 'parent', anchorId, otherId }));
      expect(await link(t.rose, t.jack)).toBe('otherId'); // a sibling: a child of P
      expect(await link(t.rose, t.niece)).toBe('otherId'); // a sibling's child
      expect(await link(t.rose, t.grandson)).toBe('otherId'); // A's own child
      expect(await link(t.lone, t.lonesGrandkid)).toBe('otherId'); // no parent family: B is A's descendant
    });

    it("refuses a child link that would make a partner their spouse's child or descendant", async () => {
      const t = await seed({
        people: { tom: ['Tom', 'Smith', 'M'], ann: ['Ann', 'Jones', 'F'], jack: ['Jack', 'Smith', 'M'], kim: ['Kim', 'Lee', 'F'] },
        families: { marriage: ['tom', 'ann'], second: ['tom', 'kim'], first: ['tom', null, ['jack']] }
      });
      const refuse = (params) => expectNothingWritten(() => failure(run('link_existing', params)));
      // In their own family, Ann would be her own ancestor (the cycle check).
      expect(await refuse({ relation: 'child', anchorId: t.tom, otherId: t.ann, familyId: t.marriage })).toMatchObject({
        status: 400, code: 'invalid', field: 'otherId', message: 'That would make Ann Jones their own ancestor.'
      });
      // In Tom's single-parent family ('new' reuses `first`), she would be his wife and his daughter.
      expect(await refuse({ relation: 'child', anchorId: t.tom, otherId: t.ann, familyId: 'new' })).toMatchObject({
        status: 400, code: 'invalid', field: 'otherId', message: "That would make Ann Jones both Tom Smith's wife and his daughter."
      });
      // A grandchild: Kim as a child of Tom's son Jack.
      expect(await refuse({ relation: 'child', anchorId: t.jack, otherId: t.kim, familyId: 'new' })).toMatchObject({
        status: 400, code: 'invalid', field: 'otherId', message: "That would make Kim Lee both Tom Smith's wife and his descendant."
      });
      // A sibling of Tom's son is Tom's child.
      expect(await refuse({ relation: 'sibling', anchorId: t.jack, otherId: t.kim })).toMatchObject({
        status: 400, code: 'invalid', field: 'otherId', message: "That would make Kim Lee both Tom Smith's wife and his daughter."
      });
    });

    it("refuses a parent link that would make a partner their spouse's parent or ancestor", async () => {
      const t = await seed({
        people: {
          tom: ['Tom', 'Smith', 'M'], ann: ['Ann', 'Jones', 'F'], gran: ['Gran', 'Smith', 'F'], rose: ['Rose', 'Smith', 'F'],
          oldBob: ['Old', 'Bob', 'M'], youngBob: ['Young', 'Bob', 'M'], lily: ['Lily', 'May', 'F']
        },
        families: {
          marriage: ['tom', 'ann'], grans: [null, 'gran', ['tom']], toms: ['tom', null, ['rose']],
          bobs: ['oldBob', null, ['youngBob']], lilyAndBob: ['oldBob', 'lily']
        }
      });
      const refuse = (anchorId, otherId) => expectNothingWritten(() => failure(run('link_existing', { relation: 'parent', anchorId, otherId })));
      // Ann filling the free slot of her husband Tom's parent family.
      expect(await refuse(t.tom, t.ann)).toMatchObject({
        status: 400, code: 'invalid', field: 'otherId', message: "That would make Tom Smith both Ann Jones's husband and her son."
      });
      // Lily has no parent family, so F(Young Bob, none) would be created: Old Bob, her husband, would be her grandfather.
      expect(await refuse(t.lily, t.youngBob)).toMatchObject({
        status: 400, code: 'invalid', field: 'otherId', message: "That would make Lily May both Old Bob's wife and his descendant."
      });
      // Filling Rose's free parent slot with Gran would make Gran the partner of her own son Tom.
      expect(await refuse(t.rose, t.gran)).toMatchObject({
        status: 400, code: 'invalid', field: 'otherId', message: "That would make Tom Smith both Gran Smith's husband and her son."
      });
    });

    it('spouse: creates F(A, B), even when B is already married to someone else', async () => {
      const t = await seed({
        people: { tom: ['Tom', 'Smith', 'M'], ann: ['Ann', 'Jones', 'F'], kim: ['Kim', 'Lee', 'F'] },
        families: { first: ['tom', 'kim'] }
      });
      const f = await nextId('family_number_seq', 'F');
      const { change } = await runUndoRedo('link_existing', { relation: 'spouse', anchorId: t.ann, otherId: t.tom });
      expect(change.summary).toBe('Linked Tom Smith as the husband of Ann Jones');
      expect(change.personIds).toEqual([t.tom, t.ann]);
      expect(await family(f)).toMatchObject({ partner1_id: t.tom, partner2_id: t.ann });
    });

    it('spouse: refuses people who already share a family, or are ancestor and descendant', async () => {
      const t = await seed({
        people: { tom: ['Tom', 'Smith', 'M'], ann: ['Ann', 'Jones', 'F'], rose: ['Rose', 'Smith', 'F'], gus: ['Gus', 'Smith', 'M'], solo: ['Solo', 'X', 'M'] },
        families: { f: ['tom', 'ann', ['rose']], roses: [null, 'rose', ['gus']], soloOnly: ['solo', null] }
      });
      const link = (anchorId, otherId) => expectNothingWritten(() => invalidField('link_existing', { relation: 'spouse', anchorId, otherId }));
      expect(await link(t.tom, t.ann)).toBe('otherId');
      expect(await link(t.ann, t.tom)).toBe('otherId');
      expect(await link(t.gus, t.tom)).toBe('otherId'); // a grandparent
      expect(await link(t.tom, t.gus)).toBe('otherId'); // a grandchild
      expect(await link(t.rose, t.ann)).toBe('otherId'); // a parent
      expect(await failure(run('link_existing', { relation: 'spouse', anchorId: t.gus, otherId: t.tom })))
        .toMatchObject({ message: "That would make Gus Smith both Tom Smith's husband and his descendant." });
      expect(await failure(run('link_existing', { relation: 'spouse', anchorId: t.ann, otherId: t.rose })))
        .toMatchObject({ message: "That would make Rose Smith both Ann Jones's wife and her daughter." });
    });

    it('child: links B who already has parents, giving them a second parent family', async () => {
      const t = await seed({
        people: { tom: ['Tom', 'Smith', 'M'], ann: ['Ann', 'Jones', 'F'], rose: ['Rose', 'Smith', 'F'], kim: ['Kim', 'Lee', 'F'] },
        families: { birth: ['tom', 'ann', ['rose']], kims: [null, 'kim'] }
      });
      const { change } = await runUndoRedo('link_existing', { relation: 'child', anchorId: t.kim, otherId: t.rose, familyId: t.kims });
      expect(change.summary).toBe('Linked Rose Smith as a daughter of Kim Lee');
      expect(change.personIds).toEqual([t.rose, t.kim]);
      expect(await parentFamilyIds(t.rose)).toEqual([t.birth, t.kims].sort());
      expect(await childrenOf(t.kims)).toEqual([{ child_id: t.rose, position: 0 }]);
    });

    it("child: 'new' and an explicit family work as for add_relative", async () => {
      const t = await seed({ people: { tom: ['Tom', 'Smith', 'M'], ann: ['Ann', 'Jones', 'F'], rose: ['Rose', 'Smith', 'F'] }, families: { couple: ['tom', 'ann'] } });
      const f = await nextId('family_number_seq', 'F');
      await run('link_existing', { relation: 'child', anchorId: t.tom, otherId: t.rose, familyId: 'new' });
      expect(await family(f)).toMatchObject({ partner1_id: t.tom, partner2_id: null });
      expect(await childIdsOf(f)).toEqual([t.rose]);
      expect(await expectNothingWritten(() => invalidField('link_existing', { relation: 'child', anchorId: t.rose, otherId: t.ann, familyId: t.couple }))).toBe('familyId');
      expect(await expectNothingWritten(() => invalidField('link_existing', { relation: 'child', anchorId: t.tom, otherId: t.ann }))).toBe('familyId');
    });

    it('child: refuses B already a child in P, and cycles (B an ancestor-or-self of any partner of P)', async () => {
      const t = await seed({
        people: {
          gramps: ['Gramps', 'Smith', 'M'], inlaw: ['Inga', 'Law', 'F'], tom: ['Tom', 'Smith', 'M'], ann: ['Ann', 'Jones', 'F'], rose: ['Rose', 'Smith', 'F']
        },
        families: { top: ['gramps', null, ['tom']], annsParents: [null, 'inlaw', ['ann']], f: ['tom', 'ann', ['rose']] }
      });
      const link = (otherId) => expectNothingWritten(() => invalidField('link_existing', { relation: 'child', anchorId: t.tom, otherId, familyId: t.f }));
      expect(await link(t.rose)).toBe('otherId'); // already a child in P
      expect(await link(t.ann)).toBe('otherId'); // a partner of P
      expect(await link(t.gramps)).toBe('otherId'); // A's ancestor
      expect(await link(t.inlaw)).toBe('otherId'); // the other partner's ancestor
    });

    it('sibling: links B who already has parents', async () => {
      const t = await seed({
        people: { tom: ['Tom', 'Smith', 'M'], ann: ['Ann', 'Jones', 'F'], rose: ['Rose', 'Smith', 'F'], kim: ['Kim', 'Lee', 'F'], kid: ['Kid', 'Lee', 'M'] },
        families: { f: ['tom', 'ann', ['rose']], kims: [null, 'kim', ['kid']] }
      });
      const { change } = await runUndoRedo('link_existing', { relation: 'sibling', anchorId: t.rose, otherId: t.kid });
      expect(change.summary).toBe('Linked Kid Lee as a brother of Rose Smith');
      expect(change.personIds).toEqual([t.kid, t.rose, t.tom, t.ann]);
      expect(await childIdsOf(t.f)).toEqual([t.rose, t.kid]);
      expect(await childIdsOf(t.kims)).toEqual([t.kid]);
    });

    it('sibling: refuses B already in P, and B an ancestor of a partner of P', async () => {
      const t = await seed({
        people: { gramps: ['Gramps', 'Smith', 'M'], tom: ['Tom', 'Smith', 'M'], rose: ['Rose', 'Smith', 'F'], jack: ['Jack', 'Smith', 'M'] },
        families: { top: ['gramps', null, ['tom']], f: ['tom', null, ['rose', 'jack']] }
      });
      const link = (otherId) => expectNothingWritten(() => invalidField('link_existing', { relation: 'sibling', anchorId: t.rose, otherId }));
      expect(await link(t.jack)).toBe('otherId');
      expect(await link(t.tom)).toBe('otherId');
      expect(await link(t.gramps)).toBe('otherId');
    });
  });

  describe('update_family', () => {
    const NONE = { marriage_date: null, marriage_place: null, divorce_date: null, divorce_place: null };

    it('edits the marriage; summary, person ids and the first partner as focus; undo and redo', async () => {
      const t = await seed({
        people: { tom: ['Tom', 'Smith', 'M'], ann: ['Ann', 'Jones', 'F'], rose: ['Rose', 'Smith', 'F'] },
        families: { f: ['tom', 'ann', ['rose'], { marriage_date: '1920' }] }
      });
      const { change, view } = await runUndoRedo('update_family', {
        id: t.f, expected: { ...NONE, marriage_date: '1920' }, fields: { marriage_place: ' Leeds ', divorce_date: '1930' }
      });
      expect(change.summary).toBe('Edited the marriage of Tom Smith and Ann Jones');
      expect(change.personIds).toEqual([t.tom, t.ann, t.rose]); // the marriage year orders the children's families
      expect(await family(t.f)).toMatchObject({ marriage_date: '1920', marriage_place: 'Leeds', divorce_date: '1930', divorce_place: null });
      expect(view.person.id).toBe(t.tom);
    });

    it('returns the view of focusId when given, falling back to the first partner when that person does not exist', async () => {
      const t = await seed({ people: { tom: ['Tom', 'Smith', 'M'], ann: ['Ann', 'Jones', 'F'] }, families: { f: ['tom', 'ann'] } });
      const { view } = await run('update_family', { id: t.f, expected: NONE, fields: { marriage_date: '1920' }, focusId: t.ann });
      expect(view.person.id).toBe(t.ann);
      const { view: fallback } = await run('update_family', {
        id: t.f, expected: { ...NONE, marriage_date: '1920' }, fields: { marriage_date: '1921' }, focusId: 'I999999'
      });
      expect(fallback.person.id).toBe(t.tom);
    });

    it('names a lone partner', async () => {
      const t = await seed({ people: { ann: ['Ann', 'Jones', 'F'] }, families: { f: [null, 'ann'] } });
      const { change } = await run('update_family', { id: t.f, expected: NONE, fields: { marriage_date: '1920' } });
      expect(change.summary).toBe('Edited the marriage of Ann Jones');
      expect(change.personIds).toEqual([t.ann]);
    });

    it('is stale (409) when any of the four fields differs from expected; a missing expected field means none', async () => {
      const t = await seed({ people: { tom: ['Tom', 'Smith', 'M'] }, families: { f: ['tom', null, [], { divorce_place: 'Hull' }] } });
      for (const expected of [NONE, { marriage_date: null }, { ...NONE, divorce_place: 'York' }]) {
        const result = await expectNothingWritten(() => failure(run('update_family', { id: t.f, expected, fields: { marriage_date: '1920' } })));
        expect(result).toMatchObject({ status: 409, code: 'stale' });
      }
      await run('update_family', { id: t.f, expected: { divorce_place: 'Hull', marriage_date: '' }, fields: { marriage_date: '1920' } });
      expect((await family(t.f)).marriage_date).toBe('1920');
    });

    it("is no_change (400) when nothing differs, treating a stored '' as empty", async () => {
      const t = await seed({ people: { tom: ['Tom', 'Smith', 'M'] }, families: { f: ['tom', null, [], { marriage_date: '1920', marriage_place: '' }] } });
      const expected = { ...NONE, marriage_date: '1920', marriage_place: '' };
      for (const fields of [{}, { marriage_date: '1920' }, { marriage_date: ' 1920 ', divorce_date: '' }, { marriage_place: '' }, { marriage_place: null }]) {
        expect(await expectNothingWritten(() => failure(run('update_family', { id: t.f, expected, fields })))).toEqual({ status: 400, code: 'no_change' });
      }
    });

    it('is stale (409) for a family that no longer exists, and refuses invalid fields', async () => {
      expect(await expectNothingWritten(() => failure(run('update_family', { id: 'F999999', expected: NONE, fields: { marriage_date: '1' } }))))
        .toMatchObject({ status: 409, code: 'stale', message: expect.any(String) });
      expect(await invalidField('update_family', { id: 'F1', expected: NONE, fields: { marriage_place: 'x'.repeat(501) } })).toBe('marriage_place');
      expect(await invalidField('update_family', { id: 'F1', expected: NONE, fields: { partner1_id: 'I1' } })).toBe('partner1_id');
    });
  });

  describe('unlink', () => {
    it("child: removes the link; the couple's family stays; undo and redo", async () => {
      const t = await seed({
        people: { tom: ['Tom', 'Smith', 'M'], ann: ['Ann', 'Jones', 'F'], rose: ['Rose', 'Smith', 'F'], jack: ['Jack', 'Smith', 'M'] },
        families: { f: ['tom', 'ann', ['rose', 'jack']] }
      });
      const { change, view } = await runUndoRedo('unlink', { familyId: t.f, personId: t.rose, role: 'child' });
      expect(change.summary).toBe('Removed Rose Smith as a daughter of Tom Smith and Ann Jones');
      expect(change.personIds).toEqual([t.rose, t.tom, t.ann, t.jack]);
      expect(await childIdsOf(t.f)).toEqual([t.jack]);
      expect(await family(t.f)).toMatchObject({ partner1_id: t.tom, partner2_id: t.ann });
      expect(view.person.id).toBe(t.rose); // default focus: the person unlinked
    });

    it("child: keeps a couple's family when its last child is removed", async () => {
      const t = await seed({ people: { tom: ['Tom', 'Smith', 'M'], ann: ['Ann', 'Jones', 'F'], rose: ['Rose', 'Smith', 'F'] }, families: { f: ['tom', 'ann', ['rose']] } });
      const { view } = await run('unlink', { familyId: t.f, personId: t.rose, role: 'child', focusId: 'I999999' });
      expect(await family(t.f)).toMatchObject({ partner1_id: t.tom, partner2_id: t.ann });
      expect(view.person.id).toBe(t.rose); // an unknown focusId falls back to the person unlinked
    });

    it("cleanup: deletes a one-parent family when its last child is removed", async () => {
      const t = await seed({ people: { tom: ['Tom', 'Smith', 'M'], jack: ['Jack', 'Smith', 'M'] }, families: { f: ['tom', null, ['jack']] } });
      const { change } = await runUndoRedo('unlink', { familyId: t.f, personId: t.jack, role: 'child', focusId: t.tom });
      expect(change.summary).toBe('Removed Jack Smith as a son of Tom Smith');
      expect(await family(t.f)).toBeUndefined();
      expect(await partnerFamilies(t.tom)).toEqual([]);
    });

    it('cleanup: keeps a one-parent family that still has children', async () => {
      const t = await seed({ people: { tom: ['Tom', 'Smith', 'M'], rose: ['Rose', 'Smith', 'F'], jack: ['Jack', 'Smith', 'M'] }, families: { f: ['tom', null, ['rose', 'jack']] } });
      await run('unlink', { familyId: t.f, personId: t.jack, role: 'child' });
      expect(await childIdsOf(t.f)).toEqual([t.rose]);
    });

    it('partner: empties their slot; a family with one partner and children stays; undo and redo', async () => {
      const t = await seed({
        people: { tom: ['Tom', 'Smith', 'M'], ann: ['Ann', 'Jones', 'F'], rose: ['Rose', 'Smith', 'F'] },
        families: { f: ['tom', 'ann', ['rose'], { marriage_date: '1920' }] }
      });
      const { change, view } = await runUndoRedo('unlink', { familyId: t.f, personId: t.ann, role: 'partner', focusId: t.tom });
      expect(change.summary).toBe('Removed Ann Jones as the wife of Tom Smith');
      expect(change.personIds).toEqual([t.ann, t.tom, t.rose]);
      expect(await family(t.f)).toMatchObject({ partner1_id: t.tom, partner2_id: null, marriage_date: '1920' });
      expect(await childIdsOf(t.f)).toEqual([t.rose]);
      expect(view.person.id).toBe(t.tom);
    });

    it('cleanup: removing a partner of a childless couple deletes the family', async () => {
      const t = await seed({ people: { tom: ['Tom', 'Smith', 'M'], ann: ['Ann', 'Jones', 'F'] }, families: { f: ['tom', 'ann', [], { marriage_date: '1920' }] } });
      const { change } = await runUndoRedo('unlink', { familyId: t.f, personId: t.tom, role: 'partner' });
      expect(change.summary).toBe('Removed Tom Smith as the husband of Ann Jones');
      expect(await family(t.f)).toBeUndefined();
    });

    it('cleanup: removing the last parent deletes the family and its child links', async () => {
      const t = await seed({
        people: { tom: ['Tom', 'Smith', 'M'], rose: ['Rose', 'Smith', 'F'], jack: ['Jack', 'Smith', 'M'] },
        families: { f: ['tom', null, ['rose', 'jack']] }
      });
      const { change } = await runUndoRedo('unlink', { familyId: t.f, personId: t.tom, role: 'partner' });
      expect(change.summary).toBe('Removed Tom Smith as the father of Rose Smith and Jack Smith');
      expect(change.personIds).toEqual([t.tom, t.rose, t.jack]);
      expect(await family(t.f)).toBeUndefined();
      expect(await parentFamilyIds(t.rose)).toEqual([]);
      expect((await one('select person_view($1) as v', [t.rose])).v.relationships.siblings).toEqual([]);
    });

    it('cleanup: removing the only partner of an empty family deletes it', async () => {
      const t = await seed({ people: { kim: ['Kim', 'Lee', 'U'] }, families: { f: ['kim', null] } });
      const { change } = await run('unlink', { familyId: t.f, personId: t.kim, role: 'partner' });
      expect(change.summary).toBe('Removed Kim Lee from an empty family');
      expect(await family(t.f)).toBeUndefined();
    });

    it('is stale (409) when the link or its family no longer exists', async () => {
      const t = await seed({ people: { tom: ['Tom', 'Smith', 'M'], ann: ['Ann', 'Jones', 'F'], rose: ['Rose', 'Smith', 'F'] }, families: { f: ['tom', 'ann', ['rose']] } });
      for (const params of [
        { familyId: t.f, personId: t.rose, role: 'partner' },
        { familyId: t.f, personId: t.tom, role: 'child' },
        { familyId: t.f, personId: 'I999999', role: 'child' }
      ]) {
        expect(await expectNothingWritten(() => failure(run('unlink', params)))).toMatchObject({ status: 409, code: 'stale' });
      }
      expect(await expectNothingWritten(() => failure(run('unlink', { familyId: 'F999999', personId: t.rose, role: 'child' }))))
        .toMatchObject({ status: 409, code: 'stale', message: expect.any(String) });
    });
  });

  describe('delete_person', () => {
    it('deletes them with their links and photos, cleans up their families, focuses their first parent; undo and redo', async () => {
      const t = await seed({
        people: {
          dad: ['Dan', 'Smith', 'M'], mum: ['Meg', 'Smith', 'F'], rose: ['Rose', 'Smith', 'F'], jack: ['Jack', 'Smith', 'M'],
          husband: ['Hal', 'Brown', 'M'], kid: ['Kit', 'Brown', 'F'], ex: ['Ed', 'Grey', 'M'], solo: ['Sol', 'Smith', 'M']
        },
        families: {
          parents: ['dad', 'mum', ['rose', 'jack']],
          marriage: ['husband', 'rose', ['kid']],
          childless: ['ex', 'rose'],
          single: [null, 'rose', ['solo']]
        }
      });
      const { rows: [{ media_id: media }] } = await withChange(client, `
        with m as (insert into media (sha256, original_path, file_name, content_type, byte_size, object_key)
                   values ('del-sha', 'Data/rose.jpg', 'rose.jpg', 'image/jpeg', 10, 'originals/del-sha.jpg') returning id)
        insert into person_media (person_id, media_id, position) select $1, id, 0 from m returning media_id`, [t.rose]);

      const { change, view } = await runUndoRedo('delete_person', { id: t.rose, expectedUpdatedAt: await stamp(t.rose) });
      expect(change.summary).toBe('Deleted Rose Smith');
      expect(change.personIds).toEqual([t.rose, t.husband, t.kid, t.ex, t.solo, t.dad, t.mum, t.jack]);
      expect(view.person.id).toBe(t.dad);
      expect(await person(t.rose)).toBeUndefined();
      expect(await childIdsOf(t.parents)).toEqual([t.jack]);
      expect(await family(t.marriage)).toMatchObject({ partner1_id: t.husband, partner2_id: null }); // one partner and a child: kept
      expect(await childIdsOf(t.marriage)).toEqual([t.kid]);
      expect(await family(t.childless)).toBeUndefined(); // one partner, no children: deleted
      expect(await family(t.single)).toBeUndefined(); // no partners: deleted with its child link
      expect(await parentFamilyIds(t.solo)).toEqual([]);
      expect(await all('select * from person_media where person_id = $1', [t.rose])).toEqual([]);
      expect(await one('select id from media where id = $1', [media])).toEqual({ id: media }); // the photo itself stays
    });

    it("cleanup: deletes their parent family when they were its only child and it had one parent", async () => {
      const t = await seed({ people: { dad: ['Dan', 'Smith', 'M'], rose: ['Rose', 'Smith', 'F'] }, families: { f: ['dad', null, ['rose']] } });
      await runUndoRedo('delete_person', { id: t.rose, expectedUpdatedAt: await stamp(t.rose) });
      expect(await family(t.f)).toBeUndefined();
    });

    it('focuses their first spouse when they have no parents, else nobody', async () => {
      const t = await seed({
        people: { tom: ['Tom', 'Smith', 'M'], ann: ['Ann', 'Jones', 'F'], kim: ['Kim', 'Lee', 'F'], loner: ['', '', 'U'] },
        families: { first: ['tom', 'kim', [], { marriage_date: '1900' }], second: ['tom', 'ann', [], { marriage_date: '1910' }] }
      });
      const { view } = await run('delete_person', { id: t.tom, expectedUpdatedAt: await stamp(t.tom) });
      expect(view.person.id).toBe(t.kim);
      expect(await partnerFamilies(t.kim)).toEqual([]); // both marriages were left with one partner and no children
      const { change, view: none } = await run('delete_person', { id: t.loner, expectedUpdatedAt: await stamp(t.loner) });
      expect(change).toMatchObject({ summary: 'Deleted Unnamed person', personIds: [t.loner] });
      expect(none).toBeNull();
    });

    it('is stale (409) or not_found (404) without deleting', async () => {
      const t = await seed({ people: { rose: ['Rose', 'Smith', 'F'] } });
      const seen = await stamp(t.rose);
      await run('update_person', { id: t.rose, expectedUpdatedAt: seen, fields: { birth_date: '1900' } });
      expect(await expectNothingWritten(() => failure(run('delete_person', { id: t.rose, expectedUpdatedAt: seen })))).toMatchObject({ status: 409, code: 'stale' });
      expect(await failure(run('delete_person', { id: 'I999999', expectedUpdatedAt: seen }))).toMatchObject({ status: 404, code: 'not_found' });
      expect(await person(t.rose)).toBeDefined();
    });
  });
});

// The facts sweep reads the `editing` branch (DATABASE_URL in .env.local), read-only, to show every
// existing person can be saved unchanged.
function neonBranch() {
  try {
    return JSON.parse(readFileSync(new URL('../../.neon', import.meta.url), 'utf8')).branch;
  } catch {
    return null;
  }
}
const editingUrl = process.env.DATABASE_URL && neonBranch() === 'editing' ? process.env.DATABASE_URL : null;

describe.skipIf(!editingUrl)('facts validation sweep (editing branch, read-only)', { timeout: 60000 }, () => {
  it('every person passes validateFacts and update_person validation, unchanged', async () => {
    const client = new pg.Client({ connectionString: editingUrl });
    await client.connect();
    try {
      await client.query('begin read only');
      const { rows } = await client.query(`
        select id, ${PERSON_FIELDS.join(', ')}, facts,
               to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as stamp
        from person order by id`);
      await client.query('rollback');
      expect(rows.length).toBeGreaterThan(1000);
      const failures = [];
      for (const row of rows) {
        const fields = Object.fromEntries(PERSON_FIELDS.map((name) => [name, row[name]]));
        try {
          expect(validateFacts(row.facts)).toBe(row.facts);
          const clean = commandFor('update_person').validate({ id: row.id, expectedUpdatedAt: row.stamp, fields, facts: row.facts });
          // Saving unchanged changes nothing: the fields normalise to themselves, and update_person's
          // change detection sees no facts change.
          expect(clean.fields).toEqual(fields);
          expect(changedFactKeys(row.facts, clean.facts)).toEqual([]);
        } catch (error) {
          failures.push(`${row.id}: ${error.message}`);
        }
      }
      expect(failures).toEqual([]);
    } finally {
      await client.end();
    }
  });
});
