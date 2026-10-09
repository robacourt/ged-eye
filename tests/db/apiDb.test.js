// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { TEST_DATABASE_URL as url, resetTestDatabase, withChange } from './testDatabase.js';
import { createDb } from '../../api/db.js';
import { inTransaction } from '../../api/tx.js';

// I5 and I6 have LIKE wildcards in their names, to show search matches them literally.
// I8 and I9 have a punctuation-only word, which trigrams ignore, so only the prefix clauses find it.
const PEOPLE = `
insert into person (id, given_name, surname, birth_date, death_date) values
  ('I1', 'John', 'Smith', 'ABT 1850', '12 MAR 1901'),
  ('I2', 'Johnny', 'Smithson', null, null),
  ('I3', 'Mary', 'Jones', 'BET 1855 AND 1856', null),
  ('I4', 'Ann', 'Lee', null, null),
  ('I5', '50%_\\', 'Literal', null, null),
  ('I6', 'J%h', 'Odd', null, null),
  ('I7', 'Robert', 'Brown', '1820', '1880'),
  ('I8', 'Tom', '??', null, null),
  ('I9', '??', 'Ward', null, null);
`;

const OWNER = 'saintderanged@gmail.com'; // seeded as admin by migration 006

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!url)('api/db.js (database)', { timeout: 30000 }, () => {
  let client;
  let pool;
  let db;
  const ids = (results) => results.map((result) => result.id);

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

  describe('personView', () => {
    it('returns the view with the latest change id and migration', async () => {
      const { id: latest } = (await client.query('select max(id)::text as id from change')).rows[0];
      const { view, version } = await db.personView('I1');
      expect(view.person.id).toBe('I1');
      expect(version).toEqual({ changeId: latest, migration: '006_editing.sql' });
    });

    it('returns a null view for an unknown person', async () => {
      expect((await db.personView('I999')).view).toBeNull();
    });
  });

  describe('search', () => {
    it('finds an exact name first, with years from the GEDCOM dates', async () => {
      const results = await db.search('John Smith', 20);
      expect(results[0]).toEqual({ id: 'I1', name: 'John Smith', birthYear: 1850, deathYear: 1901 });
      expect(ids(results)).toContain('I2');
    });

    it('finds a given-name prefix', async () => {
      expect(ids(await db.search('Mar', 20))).toEqual(['I3']);
      expect((await db.search('Mar', 20))[0]).toEqual({ id: 'I3', name: 'Mary Jones', birthYear: 1855, deathYear: null });
    });

    it('finds a surname prefix', async () => {
      expect(ids(await db.search('Smi', 20)).sort()).toEqual(['I1', 'I2']);
      expect(ids(await db.search('brow', 20))).toEqual(['I7']);
    });

    it('finds a name or later word by prefix even where trigrams see nothing', async () => {
      expect(ids(await db.search('??', 20)).sort()).toEqual(['I8', 'I9']);
    });

    it('works with a 2-character query', async () => {
      expect(ids(await db.search('Jo', 20)).sort()).toEqual(['I1', 'I2', 'I3']);
    });

    it('honours the limit', async () => {
      expect(await db.search('Jo', 2)).toHaveLength(2);
    });

    it('matches LIKE wildcards and backslashes literally', async () => {
      expect(ids(await db.search('50%_\\', 20))).toEqual(['I5']);
      expect(ids(await db.search('J%h', 20))).toEqual(['I6']);
      expect(ids(await db.search('Jo_n', 20))).toEqual([]);
      expect(ids(await db.search('%%', 20))).toEqual([]);
    });
  });

  describe('editors', () => {
    it('looks up an editor, or null', async () => {
      expect(await db.lookupEditor(OWNER)).toEqual({ email: OWNER, name: "Rob A'Court", role: 'admin' });
      expect(await db.lookupEditor('nobody@example.test')).toBeNull();
    });

    it('adds an editor once; a duplicate returns null and changes nothing', async () => {
      const added = await db.addEditor({ email: 'ed@example.test', name: 'Ed', role: 'editor' }, OWNER);
      expect(added).toMatchObject({ email: 'ed@example.test', name: 'Ed', role: 'editor', addedBy: OWNER });
      expect(added.addedAt).toBeInstanceOf(Date);
      expect(await db.addEditor({ email: 'ed@example.test', name: 'Other', role: 'admin' }, OWNER)).toBeNull();
      expect(await db.lookupEditor('ed@example.test')).toEqual({ email: 'ed@example.test', name: 'Ed', role: 'editor' });
    });

    it('lists admins first, then by email', async () => {
      await db.addEditor({ email: 'aa@example.test', name: null, role: 'editor' }, OWNER);
      await db.addEditor({ email: 'zz-admin@example.test', name: 'Zed', role: 'admin' }, OWNER);
      const editors = await db.listEditors();
      expect(editors.map((editor) => editor.email)).toEqual([OWNER, 'zz-admin@example.test', 'aa@example.test', 'ed@example.test']);
      expect(editors[0]).toMatchObject({ name: "Rob A'Court", role: 'admin', addedBy: 'migration 006' });
    });

    it('removes an editor', async () => {
      expect(await db.removeEditor('aa@example.test', OWNER)).toBe('removed');
      expect(await db.lookupEditor('aa@example.test')).toBeNull();
    });

    it('reports an unknown editor', async () => {
      expect(await db.removeEditor('nobody@example.test', OWNER)).toBe('not_found');
    });

    it('refuses when the remover is not an admin', async () => {
      expect(await db.removeEditor('zz-admin@example.test', 'ed@example.test')).toBe('not_an_admin');
      expect(await db.removeEditor('ed@example.test', 'nobody@example.test')).toBe('not_an_admin');
      expect(await db.lookupEditor('zz-admin@example.test')).not.toBeNull();
    });

    it('never removes the last admin', async () => {
      expect(await db.removeEditor('zz-admin@example.test', OWNER)).toBe('removed');
      expect(await db.removeEditor(OWNER, OWNER)).toBe('last_admin');
      expect(await db.lookupEditor(OWNER)).not.toBeNull();
    });

    it('lets exactly one of two admins removing each other at once succeed, without deadlock', async () => {
      await db.addEditor({ email: 'a@example.test', name: 'A', role: 'admin' }, OWNER);
      await db.addEditor({ email: 'b@example.test', name: 'B', role: 'admin' }, OWNER);

      // Hold the admin rows so both removals start and queue behind the same lock.
      const blocker = await pool.connect();
      try {
        await blocker.query('begin');
        await blocker.query("select email from editor where role = 'admin' for update");
        const removals = Promise.all([
          db.removeEditor('b@example.test', 'a@example.test'),
          db.removeEditor('a@example.test', 'b@example.test')
        ]);
        for (let waited = 0; ; waited += 50) {
          const { n } = (await client.query(`select count(*)::int as n from pg_stat_activity
            where datname = current_database() and wait_event_type = 'Lock' and query like '%for update%'`)).rows[0];
          if (n === 2) break;
          if (waited > 10000) throw new Error(`expected 2 removals waiting on the lock, saw ${n}`);
          await sleep(50);
        }
        await blocker.query('commit');
        expect((await removals).sort()).toEqual(['not_an_admin', 'removed']);
      } finally {
        await blocker.query('rollback').catch(() => {});
        blocker.release();
      }

      const left = await Promise.all(['a@example.test', 'b@example.test'].map((email) => db.lookupEditor(email)));
      expect(left.filter(Boolean)).toHaveLength(1);
    });
  });

  describe('inTransaction', () => {
    it('sets the write timeouts for the transaction only', async () => {
      const settings = await inTransaction(pool, async (tx) => ({
        statement: (await tx.query('show statement_timeout')).rows[0].statement_timeout,
        idle: (await tx.query('show idle_in_transaction_session_timeout')).rows[0].idle_in_transaction_session_timeout
      }));
      expect(settings).toEqual({ statement: '10s', idle: '15s' });
    });

    it('rolls back on error', async () => {
      await expect(inTransaction(pool, async (tx) => {
        await tx.query(`insert into editor (email, name, role) values ('rollback@example.test', null, 'editor')`);
        throw new Error('stop');
      })).rejects.toThrow('stop');
      expect(await db.lookupEditor('rollback@example.test')).toBeNull();
    });
  });
});
