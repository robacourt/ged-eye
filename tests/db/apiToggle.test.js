// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { TEST_DATABASE_URL as url, resetTestDatabase, withChange } from './testDatabase.js';
import { createDb } from '../../api/db.js';
import { ApiError } from '../../api/http.js';

// Each test edits its own people, so the tests don't depend on each other's edits. Undo and redo
// are per author, so the tests of the stack use their own editor.
const PEOPLE = `
insert into person (id, given_name, surname, birth_place) values
  ('I1', 'Rose', 'Smith', 'York'),
  ('I2', 'Tom', 'Brown', 'Hull'),
  ('I3', 'Ann', 'Lee', 'P'),
  ('I4', 'Una', 'Doe', null),
  ('I5', 'Ivy', 'Hart', null),
  ('I6', 'Sam', 'Cole', null),
  ('I7', 'Max', 'Reed', null);
`;

const ED = { email: 'ed@example.test', name: 'Ed Itor', role: 'editor' };
const ANN = { email: 'ann@example.test', name: 'Ann', role: 'editor' };

describe.skipIf(!url)('api/db.js toggles and history (database)', { timeout: 30000 }, () => {
  let client;
  let pool;
  let db;
  const one = async (sql, params) => (await client.query(sql, params)).rows[0];

  beforeAll(async () => {
    client = await resetTestDatabase();
    await withChange(client, PEOPLE);
    await client.query('select sync_id_sequences()');
    pool = new pg.Pool({ connectionString: url, max: 4 });
    db = createDb(pool);
  }, 60000);

  afterAll(async () => {
    await pool?.end();
    await client?.end();
  });

  const birthPlace = async (id) => (await one('select birth_place from person where id = $1', [id])).birth_place;
  const changeCount = async () => (await one('select count(*)::int as n from change')).n;

  /** A real edit through the API's command path: sets the person's birth place. → its change. */
  async function setBirthPlace(editor, id, place) {
    const { stamp } = await one(`select person_view($1) -> 'person' ->> 'updatedAt' as stamp`, [id]);
    const { change } = await db.runChange(editor, 'update_person', { id, expectedUpdatedAt: stamp, fields: { birth_place: place } });
    return change;
  }

  /** Awaits a call that must fail with an ApiError; returns { status, code, ...extra }. */
  async function failure(promise) {
    try {
      await promise;
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      return { status: error.status, code: error.code, ...error.extra };
    }
    throw new Error('expected the call to fail');
  }

  describe('toggle', () => {
    it('reverts and restores a change, returning the toggle\'s own change', async () => {
      const base = await setBirthPlace(ED, 'I1', 'Leeds');
      expect(base.summary).toBe('Edited Rose Smith (birth place)');

      const reverted = await db.toggle(ANN, base.id, 'undo', 'history');
      expect(reverted).toEqual({
        id: expect.any(Number), summary: 'Undid: Edited Rose Smith (birth place)', personIds: ['I1'], baseChangeId: base.id, kind: 'undo'
      });
      expect(reverted.id).toBeGreaterThan(base.id);
      expect(await birthPlace('I1')).toBe('York');
      expect(await one('select author_email, author_name, via from change where id = $1', [reverted.id]))
        .toEqual({ author_email: ANN.email, author_name: 'Ann', via: 'history' });

      const restored = await db.toggle(ED, base.id, 'redo', 'keyboard');
      expect(restored).toEqual({
        id: expect.any(Number), summary: 'Redid: Edited Rose Smith (birth place)', personIds: ['I1'], baseChangeId: base.id, kind: 'redo'
      });
      expect(await birthPlace('I1')).toBe('Leeds');
      expect((await one('select via from change where id = $1', [restored.id])).via).toBe('keyboard');
    });

    it('refuses a toggle in the wrong state as 409 wrong_state, recording nothing', async () => {
      const base = await setBirthPlace(ED, 'I2', 'Goole');
      const before = await changeCount();
      expect(await failure(db.toggle(ED, base.id, 'redo', 'history'))).toEqual({ status: 409, code: 'wrong_state' });
      await db.toggle(ED, base.id, 'undo', 'history');
      expect(await failure(db.toggle(ED, base.id, 'undo', 'history'))).toEqual({ status: 409, code: 'wrong_state' });
      expect(await changeCount()).toBe(before + 1);
      expect(await birthPlace('I2')).toBe('Hull');
    });

    it('answers 404 not_found for an unknown change or a toggle of a toggle', async () => {
      expect(await failure(db.toggle(ED, 999999, 'undo', 'history'))).toEqual({ status: 404, code: 'not_found' });
      const base = await setBirthPlace(ED, 'I2', 'Selby');
      const reverted = await db.toggle(ED, base.id, 'undo', 'history');
      expect(await failure(db.toggle(ED, reverted.id, 'undo', 'history'))).toEqual({ status: 404, code: 'not_found' });
    });

    it('reports a conflict with the blocking change\'s summary, author and time', async () => {
      const base = await setBirthPlace(ED, 'I3', 'Q');
      const later = await setBirthPlace(ANN, 'I3', 'R');
      const before = await changeCount();

      const conflict = await failure(db.toggle(ED, base.id, 'undo', 'history'));
      const { created_at: createdAt } = await one('select created_at from change where id = $1', [later.id]);
      expect(conflict).toEqual({
        status: 409,
        code: 'conflict',
        reason: 'precondition',
        blocking: [{ id: later.id, action: 'revert', summary: 'Edited Ann Lee (birth place)', authorName: 'Ann', createdAt: createdAt.toISOString() }]
      });
      expect(await changeCount()).toBe(before);
      expect(await birthPlace('I3')).toBe('R');
    });

    it('names the base change, not its undo, when an undo blocks, with the action restore', async () => {
      // I3 is 'R' (from the test above). X: R → S, Z: S → T, B: T → S; reverting X then leaves R,
      // so reverting B (which needs S) is blocked by X's undo, and restoring X unblocks it.
      const x = await setBirthPlace(ANN, 'I3', 'S');
      await setBirthPlace(ANN, 'I3', 'T');
      const b = await setBirthPlace(ED, 'I3', 'S');
      await db.toggle(ANN, x.id, 'undo', 'history');
      expect(await birthPlace('I3')).toBe('R');

      const conflict = await failure(db.toggle(ED, b.id, 'undo', 'history'));
      expect(conflict).toMatchObject({ status: 409, code: 'conflict', reason: 'precondition' });
      expect(conflict.blocking).toEqual([
        { id: x.id, action: 'restore', summary: 'Edited Ann Lee (birth place)', authorName: 'Ann', createdAt: expect.any(String) }
      ]);
    });
  });

  describe('undoLast and redoLast', () => {
    const UNA = { email: 'una@example.test', name: 'Una', role: 'editor' };
    const IVY = { email: 'ivy@example.test', name: null, role: 'editor' };

    it('return null when there is nothing to undo or redo', async () => {
      expect(await db.undoLast(UNA)).toBeNull();
      expect(await db.redoLast(UNA)).toBeNull();
    });

    it('undo the editor\'s latest edit, then redo it, from the keyboard', async () => {
      await setBirthPlace(UNA, 'I4', 'Ely');
      const base = await setBirthPlace(UNA, 'I4', 'Rye');
      await setBirthPlace(ANN, 'I1', 'Bath'); // someone else's edit is not on Una's stack

      const undone = await db.undoLast(UNA);
      expect(undone).toEqual({ id: expect.any(Number), summary: 'Undid: Edited Una Doe (birth place)', personIds: ['I4'], baseChangeId: base.id, kind: 'undo' });
      expect(await birthPlace('I4')).toBe('Ely');
      expect(await birthPlace('I1')).toBe('Bath');

      const redone = await db.redoLast(UNA);
      expect(redone).toEqual({ id: expect.any(Number), summary: 'Redid: Edited Una Doe (birth place)', personIds: ['I4'], baseChangeId: base.id, kind: 'redo' });
      expect(await birthPlace('I4')).toBe('Rye');
      expect(await db.redoLast(UNA)).toBeNull();

      const vias = await client.query('select via, author_name from change where id = any ($1::bigint[]) order by id', [[undone.id, redone.id]]);
      expect(vias.rows).toEqual([{ via: 'keyboard', author_name: 'Una' }, { via: 'keyboard', author_name: 'Una' }]);
    });

    it('report a conflict with enriched blocking changes', async () => {
      await setBirthPlace(IVY, 'I5', 'Wells');
      const later = await setBirthPlace(ED, 'I5', 'Diss');
      const conflict = await failure(db.undoLast(IVY));
      expect(conflict).toMatchObject({ status: 409, code: 'conflict', reason: 'precondition' });
      expect(conflict.blocking).toEqual([
        { id: later.id, action: 'revert', summary: 'Edited Ivy Hart (birth place)', authorName: 'Ed Itor', createdAt: expect.any(String) }
      ]);
      expect(await birthPlace('I5')).toBe('Diss');
    });
  });

  describe('listChanges', () => {
    const SHAPE = ['authorEmail', 'authorName', 'baseChangeId', 'createdAt', 'id', 'kind', 'personIds', 'summary', 'undone', 'via'];

    it('filters by person, newest first, with the history fields', async () => {
      const base = await setBirthPlace(ED, 'I6', 'Ware');
      const reverted = await db.toggle(ANN, base.id, 'undo', 'history');
      await setBirthPlace(ED, 'I7', 'Hove');

      const changes = await db.listChanges({ before: null, limit: 50, person: 'I6' });
      const { created_at: createdAt } = await one('select created_at from change where id = $1', [base.id]);
      expect(changes).toEqual([
        {
          id: reverted.id, createdAt: expect.any(String), authorName: 'Ann', authorEmail: ANN.email, kind: 'undo', via: 'history',
          summary: 'Undid: Edited Sam Cole (birth place)', personIds: ['I6'], baseChangeId: base.id, undone: false
        },
        {
          id: base.id, createdAt: createdAt.toISOString(), authorName: 'Ed Itor', authorEmail: ED.email, kind: 'update_person', via: 'edit',
          summary: 'Edited Sam Cole (birth place)', personIds: ['I6'], baseChangeId: null, undone: true
        }
      ]);
      expect(Object.keys(changes[0]).sort()).toEqual(SHAPE);
      expect(await db.listChanges({ person: 'I999' })).toEqual([]);
    });

    it('pages newest first with before and limit, at most 50 a page', async () => {
      // 60 more (empty) changes, so there is more than one page.
      await client.query('begin');
      await client.query(`select begin_change('fixture@example.test', 'Fixture', 'fixture', 'script', 'Filler ' || n, '{}', '{}')
                          from generate_series(1, 60) n`);
      await client.query('commit');
      const { rows } = await client.query('select id from change order by id desc');
      const allIds = rows.map((row) => Number(row.id));

      const first = await db.listChanges({ before: null, limit: 500, person: null });
      expect(first.map((change) => change.id)).toEqual(allIds.slice(0, 50));
      expect(first[0]).toMatchObject({ kind: 'fixture', via: 'script', summary: expect.stringMatching(/^Filler /), personIds: [], baseChangeId: null, undone: false });

      const next = await db.listChanges({ before: first.at(-1).id, limit: 50, person: null });
      expect(next.map((change) => change.id)).toEqual(allIds.slice(50, 100));

      const small = await db.listChanges({ before: allIds[2], limit: 3, person: null });
      expect(small.map((change) => change.id)).toEqual(allIds.slice(3, 6));
    });
  });
});
