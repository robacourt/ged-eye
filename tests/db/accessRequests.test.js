// @vitest-environment node
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import pg from 'pg';
import { TEST_DATABASE_URL as url, resetTestDatabase } from './testDatabase.js';
import { ACCESS_REQUEST_LOCK, createDb } from '../../api/db.js';

const OWNER = 'saintderanged@gmail.com'; // seeded as admin by migration 006
const ADMIN2 = 'admin2@example.test';
const EDITOR = 'ed@example.test';
const ASKER = 'asker@example.test';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!url)('access requests (database)', { timeout: 30000 }, () => {
  let client;
  let pool;
  let db;
  const one = async (sql, params) => (await client.query(sql, params)).rows[0];
  const count = async (sql, params) => (await one(sql, params)).n;

  /** Inserts a request directly, `age` (an interval) ago; resolved ones get a resolver and time. */
  const insertRequest = (email, { status = 'pending', age = '0 seconds', note = null, name = null } = {}) => one(
    `insert into access_request (email, name, note, created_at, status, resolved_by, resolved_at)
     values ($1, $2, $3, now() - $4::interval, $5::text,
             case when $5::text = 'pending' then null else 'someone@example.test' end,
             case when $5::text = 'pending' then null else now() end)
     returning id::int`,
    [email, name, note, age, status]);

  const statusOf = async (id) => (await one('select status, resolved_by from access_request where id = $1', [id]));

  /** Waits until `n` backends are waiting on a lock with a query matching `like`. */
  async function waitForLockWaiters(n, like) {
    for (let waited = 0; ; waited += 50) {
      const { waiting } = await one(`select count(*)::int as waiting from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock' and query like $1`, [like]);
      if (waiting === n) return;
      if (waited > 10000) throw new Error(`expected ${n} waiting on a lock, saw ${waiting}`);
      await sleep(50);
    }
  }

  beforeAll(async () => {
    client = await resetTestDatabase();
    pool = new pg.Pool({ connectionString: url, max: 6 });
    db = createDb(pool);
  }, 60000);

  beforeEach(async () => {
    await client.query('delete from access_request');
    await client.query('delete from editor where email <> $1', [OWNER]);
    await client.query(`insert into editor (email, name, role, added_by) values
      ($1, 'Admin Two', 'admin', 'test'), ($2, 'Ed', 'editor', 'test')`, [ADMIN2, EDITOR]);
  });

  afterAll(async () => {
    await pool?.end();
    await client?.end();
  });

  describe('the table (migration 009)', () => {
    it('allows one pending request per email, and any number of resolved ones', async () => {
      await insertRequest(ASKER);
      await expect(insertRequest(ASKER)).rejects.toMatchObject({ code: '23505', constraint: 'access_request_one_pending' });
      await insertRequest(ASKER, { status: 'dismissed' });
      await insertRequest(ASKER, { status: 'granted' });
      await insertRequest('other@example.test');
      expect(await count('select count(*)::int as n from access_request')).toBe(4);
    });

    it('checks the email case, the note and name lengths, and that only resolved requests have a resolved time', async () => {
      const bad = [
        ["insert into access_request (email) values ('Asker@example.test')"],
        ['insert into access_request (email, note) values ($1, $2)', [ASKER, 'n'.repeat(501)]],
        ['insert into access_request (email, name) values ($1, $2)', [ASKER, 'n'.repeat(101)]],
        ['insert into access_request (email, resolved_at) values ($1, now())', [ASKER]],
        ["insert into access_request (email, status) values ($1, 'granted')", [ASKER]],
        ["insert into access_request (email, status, resolved_at) values ($1, 'approved', now())", [ASKER]]
      ];
      for (const [sql, params] of bad) await expect(client.query(sql, params)).rejects.toMatchObject({ code: '23514' });
      // Lengths count characters, not bytes.
      await client.query('insert into access_request (email, name, note) values ($1, $2, $3)', [ASKER, 'é'.repeat(100), '\u{1F600}'.repeat(500)]);
    });
  });

  describe('createAccessRequest', () => {
    it('creates a pending request', async () => {
      const { outcome, request } = await db.createAccessRequest({ email: ASKER, name: 'Asker', note: 'Please add me' });
      expect(outcome).toBe('created');
      expect(request).toEqual({
        id: expect.any(Number), email: ASKER, name: 'Asker', note: 'Please add me', status: 'pending',
        createdAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/), resolvedBy: null, resolvedByName: null,
        resolvedAt: null
      });
      expect(await db.latestAccessRequest(ASKER)).toEqual(request);
    });

    it('stores a missing name and note as null', async () => {
      const { request } = await db.createAccessRequest({ email: ASKER, name: null, note: null });
      expect(request).toMatchObject({ name: null, note: null });
    });

    it('returns the pending request instead of adding another', async () => {
      const { request: first } = await db.createAccessRequest({ email: ASKER, name: null, note: 'one' });
      const again = await db.createAccessRequest({ email: ASKER, name: null, note: 'two' });
      expect(again).toEqual({ outcome: 'pending', request: first });
      expect(await count('select count(*)::int as n from access_request')).toBe(1);
    });

    it('refuses an editor first, whatever else applies', async () => {
      await insertRequest(EDITOR);
      for (let i = 0; i < 10; i++) await insertRequest(`flood${i}@example.test`, { status: 'dismissed' });
      expect(await db.createAccessRequest({ email: EDITOR, name: null, note: null })).toEqual({ outcome: 'editor', request: null });
      expect(await db.createAccessRequest({ email: OWNER, name: null, note: null })).toEqual({ outcome: 'editor', request: null });
    });

    it('returns a pending request even when over the rate limits', async () => {
      const { id } = await insertRequest(ASKER);
      await insertRequest(ASKER, { status: 'dismissed', age: '1 hour' });
      await insertRequest(ASKER, { status: 'dismissed', age: '2 hours' });
      for (let i = 0; i < 10; i++) await insertRequest(`flood${i}@example.test`, { status: 'dismissed' });
      const { outcome, request } = await db.createAccessRequest({ email: ASKER, name: null, note: null });
      expect(outcome).toBe('pending');
      expect(request.id).toBe(id);
    });

    it('allows 3 requests per email in any 24 hours', async () => {
      await insertRequest(ASKER, { status: 'dismissed', age: '23 hours' });
      await insertRequest(ASKER, { status: 'dismissed', age: '1 hour' });
      expect((await db.createAccessRequest({ email: ASKER, name: null, note: null })).outcome).toBe('created');
      await client.query("update access_request set status = 'dismissed', resolved_at = now() where status = 'pending'");
      expect(await db.createAccessRequest({ email: ASKER, name: null, note: null })).toEqual({ outcome: 'limited', request: null });
      // Another address is unaffected.
      expect((await db.createAccessRequest({ email: 'other@example.test', name: null, note: null })).outcome).toBe('created');
    });

    it('does not count requests from more than 24 hours ago', async () => {
      for (const age of ['25 hours', '30 hours', '2 days']) await insertRequest(ASKER, { status: 'dismissed', age });
      await insertRequest(ASKER, { status: 'dismissed', age: '1 hour' });
      await insertRequest(ASKER, { status: 'dismissed', age: '2 hours' });
      expect((await db.createAccessRequest({ email: ASKER, name: null, note: null })).outcome).toBe('created');
    });

    it('accepts at most 10 new requests from everyone in any hour', async () => {
      for (let i = 0; i < 9; i++) await insertRequest(`flood${i}@example.test`, { age: '59 minutes' });
      for (let i = 0; i < 5; i++) await insertRequest(`old${i}@example.test`, { age: '61 minutes' });
      expect((await db.createAccessRequest({ email: ASKER, name: null, note: null })).outcome).toBe('created');
      expect(await db.createAccessRequest({ email: 'eleventh@example.test', name: null, note: null })).toEqual({ outcome: 'limited', request: null });
      expect(await count("select count(*)::int as n from access_request where email = 'eleventh@example.test'")).toBe(0);
    });

    it('serialises concurrent requests, so the limits hold', async () => {
      for (let i = 0; i < 8; i++) await insertRequest(`flood${i}@example.test`);
      const outcomes = await Promise.all(['a', 'b', 'c', 'd'].map((who) =>
        db.createAccessRequest({ email: `${who}@example.test`, name: null, note: null })));
      expect(outcomes.map((result) => result.outcome).sort()).toEqual(['created', 'created', 'limited', 'limited']);
      expect(await count("select count(*)::int as n from access_request where created_at > now() - interval '1 hour'")).toBe(10);

      const same = await Promise.all([1, 2, 3].map(() => db.createAccessRequest({ email: 'twice@example.test', name: null, note: null })));
      expect(same.map((result) => result.outcome).sort()).toEqual(['limited', 'limited', 'limited']);
    });

    it('two concurrent requests from one email make one request', async () => {
      const results = await Promise.all([1, 2].map(() => db.createAccessRequest({ email: ASKER, name: null, note: null })));
      expect(results.map((result) => result.outcome).sort()).toEqual(['created', 'pending']);
      expect(results[0].request.id).toBe(results[1].request.id);
    });

    it('returns the other request when a pending one is inserted between its check and its insert', async () => {
      let raced = null;
      // Stands in for a writer that doesn't take the lock: its pending row commits just before our insert.
      const racingPool = {
        query: (...args) => pool.query(...args),
        connect: async () => {
          const real = await pool.connect();
          return {
            release: (...args) => real.release(...args),
            query: async (sql, params) => {
              if (typeof sql === 'string' && /insert into access_request/.test(sql) && raced === null) {
                raced = await insertRequest(ASKER, { note: 'the other one' });
              }
              return real.query(sql, params);
            }
          };
        }
      };
      const { outcome, request } = await createDb(racingPool).createAccessRequest({ email: ASKER, name: null, note: 'mine' });
      expect(outcome).toBe('pending');
      expect(request).toMatchObject({ id: raced.id, note: 'the other one', status: 'pending' });
      expect(await count('select count(*)::int as n from access_request')).toBe(1);
    });
  });

  describe('latestAccessRequest', () => {
    it('returns the newest request for the email, or null', async () => {
      expect(await db.latestAccessRequest(ASKER)).toBeNull();
      await insertRequest(ASKER, { status: 'dismissed', age: '2 hours' });
      const { id } = await insertRequest(ASKER, { status: 'granted', age: '1 hour' });
      await insertRequest('other@example.test');
      expect(await db.latestAccessRequest(ASKER)).toMatchObject({ id, email: ASKER, status: 'granted', resolvedBy: 'someone@example.test' });
      expect((await db.latestAccessRequest(ASKER)).resolvedAt).toMatch(/Z$/);
    });
  });

  describe('listing and counting', () => {
    it('lists pending requests from non-editors, oldest first', async () => {
      const { id: newer } = await insertRequest('b@example.test', { age: '1 minute', name: 'Bee', note: 'hi' });
      const { id: older } = await insertRequest('a@example.test', { age: '1 hour' });
      await insertRequest('c@example.test', { status: 'dismissed' });
      await insertRequest(EDITOR); // already an editor
      const requests = await db.listAccessRequests();
      expect(requests).toEqual([
        { id: older, email: 'a@example.test', name: null, note: null, createdAt: expect.stringMatching(/Z$/) },
        { id: newer, email: 'b@example.test', name: 'Bee', note: 'hi', createdAt: expect.stringMatching(/Z$/) }
      ]);
      expect(await db.pendingRequestCount()).toBe(2);
    });

    it('lists at most 100', async () => {
      await client.query(`insert into access_request (email, created_at)
        select 'p' || n || '@example.test', now() - n * interval '1 second' from generate_series(1, 105) n`);
      const requests = await db.listAccessRequests();
      expect(requests).toHaveLength(100);
      expect(requests[0].email).toBe('p105@example.test');
      expect(await db.pendingRequestCount()).toBe(105);
    });

    it('counts nothing when there are no pending requests from non-editors', async () => {
      expect(await db.pendingRequestCount()).toBe(0);
      await insertRequest(EDITOR);
      await insertRequest(ASKER, { status: 'granted' });
      expect(await db.pendingRequestCount()).toBe(0);
      expect(await db.listAccessRequests()).toEqual([]);
    });

    it('lists the admins\' emails', async () => {
      expect(await db.listAdminEmails()).toEqual([ADMIN2, OWNER]);
    });
  });

  describe('resolveAccessRequest', () => {
    it('grants: adds the editor and marks the request granted, in one transaction', async () => {
      const { request } = await db.createAccessRequest({ email: ASKER, name: 'Asker', note: null });
      const result = await db.resolveAccessRequest(request.id, 'grant', ADMIN2);
      expect(result).toEqual({
        outcome: 'granted',
        request: { ...request, status: 'granted', resolvedBy: ADMIN2, resolvedByName: 'Admin Two', resolvedAt: expect.stringMatching(/Z$/) },
        editor: { email: ASKER, name: 'Asker', role: 'editor', addedBy: ADMIN2, addedAt: expect.any(Date) },
        wasEditor: false
      });
      expect(await db.lookupEditor(ASKER)).toEqual({ email: ASKER, name: 'Asker', role: 'editor' });
      expect(await db.pendingRequestCount()).toBe(0);
    });

    it('grants a request from someone who is already an editor, returning them unchanged', async () => {
      const { id } = await insertRequest(EDITOR, { name: 'New name' });
      const result = await db.resolveAccessRequest(id, 'grant', OWNER);
      expect(result).toMatchObject({
        outcome: 'granted',
        request: { id, status: 'granted', resolvedBy: OWNER },
        editor: { email: EDITOR, name: 'Ed', role: 'editor', addedBy: 'test' },
        wasEditor: true
      });
    });

    it('dismisses: no editor, the request dismissed, and the person may ask again', async () => {
      const { request } = await db.createAccessRequest({ email: ASKER, name: null, note: null });
      const result = await db.resolveAccessRequest(request.id, 'dismiss', OWNER);
      expect(result).toEqual({
        outcome: 'dismissed',
        request: { ...request, status: 'dismissed', resolvedBy: OWNER, resolvedByName: "Rob A'Court", resolvedAt: expect.stringMatching(/Z$/) },
        editor: null,
        wasEditor: false
      });
      expect(await db.lookupEditor(ASKER)).toBeNull();
      expect((await db.createAccessRequest({ email: ASKER, name: null, note: null })).outcome).toBe('created');
    });

    it('reports a resolved request with who resolved it and how', async () => {
      const { request } = await db.createAccessRequest({ email: ASKER, name: null, note: null });
      await db.resolveAccessRequest(request.id, 'dismiss', OWNER);
      for (const action of ['grant', 'dismiss']) {
        const result = await db.resolveAccessRequest(request.id, action, ADMIN2);
        expect(result).toMatchObject({
          outcome: 'already_resolved', request: { id: request.id, status: 'dismissed', resolvedBy: OWNER, resolvedByName: "Rob A'Court" }, editor: null
        });
      }
      expect(await db.lookupEditor(ASKER)).toBeNull();
    });

    it('names the resolver by their email when they have no name, or are no longer an editor', async () => {
      await client.query("insert into editor (email, name, role, added_by) values ('nameless@example.test', null, 'admin', 'test')");
      const { id } = await insertRequest(ASKER);
      const { request } = await db.resolveAccessRequest(id, 'dismiss', 'nameless@example.test');
      expect(request).toMatchObject({ resolvedBy: 'nameless@example.test', resolvedByName: 'nameless@example.test' });
      await client.query("update editor set name = 'Nora' where email = 'nameless@example.test'");
      expect(await db.latestAccessRequest(ASKER)).toMatchObject({ resolvedByName: 'Nora' });
      await client.query("delete from editor where email = 'nameless@example.test'");
      expect(await db.latestAccessRequest(ASKER)).toMatchObject({ resolvedBy: 'nameless@example.test', resolvedByName: 'nameless@example.test' });
    });

    it('reports an unknown request', async () => {
      expect(await db.resolveAccessRequest(999999, 'grant', OWNER)).toEqual({ outcome: 'not_found', request: null, editor: null, wasEditor: false });
    });

    it('refuses someone who is not, or no longer, an admin, changing nothing', async () => {
      const { id } = await insertRequest(ASKER);
      for (const by of [EDITOR, 'nobody@example.test']) {
        expect(await db.resolveAccessRequest(id, 'grant', by)).toEqual({ outcome: 'not_an_admin', request: null, editor: null, wasEditor: false });
      }
      expect(await statusOf(id)).toEqual({ status: 'pending', resolved_by: null });
      expect(await db.lookupEditor(ASKER)).toBeNull();
    });

    it('lets exactly one of two racing grants win', async () => {
      const { id } = await insertRequest(ASKER);
      const blocker = await pool.connect();
      try {
        // Hold the request so both grants queue behind the same lock.
        await blocker.query('begin');
        await blocker.query('select id from access_request where id = $1 for update', [id]);
        const grants = Promise.all([
          db.resolveAccessRequest(id, 'grant', OWNER),
          db.resolveAccessRequest(id, 'grant', ADMIN2)
        ]);
        await waitForLockWaiters(2, '%from access_request%for update%');
        await blocker.query('commit');
        const results = await grants;
        expect(results.map((result) => result.outcome).sort()).toEqual(['already_resolved', 'granted']);
        const winner = results.find((result) => result.outcome === 'granted');
        const loser = results.find((result) => result.outcome === 'already_resolved');
        expect(loser.request).toMatchObject({ status: 'granted', resolvedBy: winner.request.resolvedBy, resolvedByName: winner.request.resolvedByName });
        expect(['Admin Two', "Rob A'Court"]).toContain(winner.request.resolvedByName);
      } finally {
        await blocker.query('rollback').catch(() => {});
        blocker.release();
      }
      expect(await count('select count(*)::int as n from editor where email = $1', [ASKER])).toBe(1);
    });

    it('re-checks the admin under a lock: an admin removed meanwhile is refused', async () => {
      const { id } = await insertRequest(ASKER);
      const remover = await pool.connect();
      try {
        // As removeEditor does: lock the admin rows, then delete one.
        await remover.query('begin');
        await remover.query("select email from editor where role = 'admin' order by email for update");
        const grant = db.resolveAccessRequest(id, 'grant', ADMIN2);
        await waitForLockWaiters(1, '%from editor%');
        await remover.query('delete from editor where email = $1', [ADMIN2]);
        await remover.query('commit');
        expect((await grant).outcome).toBe('not_an_admin');
      } finally {
        await remover.query('rollback').catch(() => {});
        remover.release();
      }
      expect(await statusOf(id)).toEqual({ status: 'pending', resolved_by: null });
      expect(await db.lookupEditor(ASKER)).toBeNull();
    });

    it('holds off a removal of the granting admin until the grant commits', async () => {
      const { id } = await insertRequest(ASKER);
      const holder = await pool.connect();
      try {
        // Hold the request, so the grant has re-checked its admin and waits with that row locked.
        await holder.query('begin');
        await holder.query('select id from access_request where id = $1 for update', [id]);
        const grant = db.resolveAccessRequest(id, 'grant', ADMIN2);
        await waitForLockWaiters(1, '%from access_request%for update%');
        const removal = db.removeEditor(ADMIN2, OWNER);
        await waitForLockWaiters(1, '%from editor%for update%');
        await holder.query('commit');
        expect((await grant).outcome).toBe('granted');
        expect(await removal).toBe('removed');
      } finally {
        await holder.query('rollback').catch(() => {});
        holder.release();
      }
      expect(await statusOf(id)).toEqual({ status: 'granted', resolved_by: ADMIN2 });
    });
  });

  describe('addEditor', () => {
    it('marks a pending request for that email granted, by the adding admin', async () => {
      const { request } = await db.createAccessRequest({ email: ASKER, name: null, note: null });
      await insertRequest(ASKER, { status: 'dismissed', age: '1 hour' });
      expect(await db.addEditor({ email: ASKER, name: 'Asker', role: 'editor' }, ADMIN2)).toMatchObject({ email: ASKER, addedBy: ADMIN2 });
      expect(await statusOf(request.id)).toEqual({ status: 'granted', resolved_by: ADMIN2 });
      expect(await db.latestAccessRequest(ASKER)).toMatchObject({ id: request.id, resolvedBy: ADMIN2, resolvedByName: 'Admin Two' });
      expect(await count("select count(*)::int as n from access_request where status = 'dismissed'")).toBe(1);
      expect(await db.pendingRequestCount()).toBe(0);
    });

    it('adds an editor with no request as before', async () => {
      expect(await db.addEditor({ email: 'new@example.test', name: null, role: 'admin' }, OWNER)).toMatchObject({ email: 'new@example.test', role: 'admin' });
      expect(await count('select count(*)::int as n from access_request')).toBe(0);
    });

    it('still leaves nothing pending when the email is already an editor', async () => {
      const { id } = await insertRequest(EDITOR);
      expect(await db.addEditor({ email: EDITOR, name: null, role: 'editor' }, OWNER)).toBeNull();
      expect(await statusOf(id)).toEqual({ status: 'granted', resolved_by: OWNER });
    });

    it('takes the request row before the editor, as a grant does, so the two never deadlock', async () => {
      const { id } = await insertRequest(ASKER);
      const blocker = await pool.connect();
      let results;
      try {
        // Hold the request, so the grant (admin row locked) and then addEditor both queue behind it. Were
        // addEditor to insert the editor before locking the request, the grant would then wait on that
        // insert while addEditor waited on the grant: a deadlock, which Postgres would abort.
        await blocker.query('begin');
        await blocker.query('select id from access_request where id = $1 for update', [id]);
        const grant = db.resolveAccessRequest(id, 'grant', ADMIN2);
        await waitForLockWaiters(1, '%from access_request%for update%');
        const added = db.addEditor({ email: ASKER, name: null, role: 'editor' }, OWNER);
        await waitForLockWaiters(1, '%update access_request%');
        await blocker.query('commit');
        results = await Promise.all([grant, added]);
      } finally {
        await blocker.query('rollback').catch(() => {});
        blocker.release();
      }
      const [grant, added] = results;
      expect(await count('select count(*)::int as n from editor where email = $1', [ASKER])).toBe(1);
      expect((await statusOf(id)).status).toBe('granted');
      // Whichever got the request first added the editor and resolved it; the other found both done.
      if (grant.outcome === 'granted') {
        expect(grant.wasEditor).toBe(false);
        expect(added).toBeNull();
      } else {
        expect(grant.outcome).toBe('already_resolved');
        expect(added).toMatchObject({ email: ASKER, addedBy: OWNER });
      }
    });

    it('takes the request lock first, so a request made meanwhile is granted, not left pending', async () => {
      const holder = await pool.connect();
      try {
        // As createAccessRequest does: take the lock, find no editor, insert a pending request.
        await holder.query('begin');
        await holder.query('select pg_advisory_xact_lock($1)', [ACCESS_REQUEST_LOCK]);
        const added = db.addEditor({ email: ASKER, name: null, role: 'editor' }, OWNER);
        await waitForLockWaiters(1, '%pg_advisory_xact_lock%');
        expect(await db.lookupEditor(ASKER)).toBeNull();
        await holder.query('insert into access_request (email) values ($1)', [ASKER]);
        await holder.query('commit');
        expect(await added).toMatchObject({ email: ASKER, addedBy: OWNER });
      } finally {
        await holder.query('rollback').catch(() => {});
        holder.release();
      }
      expect(await count("select count(*)::int as n from access_request where status = 'pending'")).toBe(0);
      expect(await db.latestAccessRequest(ASKER)).toMatchObject({ status: 'granted', resolvedBy: OWNER });
    });

    it('makes a request that waited on it find the new editor', async () => {
      const holder = await pool.connect();
      try {
        // Hold the lock as addEditor would, with the editor inserted but not yet committed.
        await holder.query('begin');
        await holder.query('select pg_advisory_xact_lock($1)', [ACCESS_REQUEST_LOCK]);
        await holder.query("insert into editor (email, name, role, added_by) values ($1, null, 'editor', $2)", [ASKER, OWNER]);
        const asked = db.createAccessRequest({ email: ASKER, name: null, note: null });
        await waitForLockWaiters(1, '%pg_advisory_xact_lock%');
        await holder.query('commit');
        expect(await asked).toEqual({ outcome: 'editor', request: null });
      } finally {
        await holder.query('rollback').catch(() => {});
        holder.release();
      }
      expect(await count('select count(*)::int as n from access_request')).toBe(0);
    });
  });
});
