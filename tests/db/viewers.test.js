// @vitest-environment node
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import pg from 'pg';
import { TEST_DATABASE_URL as url, resetTestDatabase } from './testDatabase.js';
import { createDb } from '../../api/db.js';

const OWNER = 'saintderanged@gmail.com'; // seeded as admin by migration 006
const EDITOR = 'ed@example.test';
const VIEWER = 'vi@example.test';

describe.skipIf(!url)('viewers (database, migration 012)', { timeout: 30000 }, () => {
  let client;
  let pool;
  let db;
  const one = async (sql, params) => (await client.query(sql, params)).rows[0];
  const roleOf = async (email) => (await db.lookupEditor(email))?.role ?? null;

  beforeAll(async () => {
    client = await resetTestDatabase();
    pool = new pg.Pool({ connectionString: url, max: 4 });
    db = createDb(pool);
  }, 60000);

  beforeEach(async () => {
    await client.query('delete from access_request');
    await client.query('delete from editor where email <> $1', [OWNER]);
    await client.query(`insert into editor (email, name, role, added_by) values
      ($1, 'Ed', 'editor', 'test'), ($2, 'Vi', 'viewer', 'test')`, [EDITOR, VIEWER]);
  });

  afterAll(async () => {
    await pool?.end();
    await client?.end();
  });

  it('allows the viewer role, and no other new one', async () => {
    expect(await roleOf(VIEWER)).toBe('viewer');
    await expect(client.query("update editor set role = 'owner' where email = $1", [VIEWER])).rejects.toThrow(/editor_role_check/);
  });

  it("lets a viewer ask for edit access, lists and counts it, and granting makes them an editor", async () => {
    const { outcome, request } = await db.createAccessRequest({ email: VIEWER, name: 'Vi', note: 'May I edit?' });
    expect(outcome).toBe('created');
    expect((await db.listAccessRequests()).map((r) => r.email)).toEqual([VIEWER]);
    expect(await db.pendingRequestCount()).toBe(1);

    const granted = await db.resolveAccessRequest(request.id, 'grant', OWNER);
    expect(granted).toMatchObject({ outcome: 'granted', wasEditor: false, editor: { email: VIEWER, role: 'editor', name: 'Vi', addedBy: 'test' } });
    expect(await roleOf(VIEWER)).toBe('editor');
    expect(await db.pendingRequestCount()).toBe(0);
  });

  it('still tells an editor they already can edit', async () => {
    expect(await db.createAccessRequest({ email: EDITOR, name: null, note: null })).toEqual({ outcome: 'editor', request: null });
  });

  it('leaves an editor as they are when their request is granted', async () => {
    const { id } = await one("insert into access_request (email) values ($1) returning id::int", [EDITOR]);
    expect(await db.resolveAccessRequest(id, 'grant', OWNER)).toMatchObject({ outcome: 'granted', wasEditor: true, editor: { role: 'editor' } });
    expect(await roleOf(EDITOR)).toBe('editor');
  });

  it("leaves a pending request for edit access pending when someone is invited as a viewer, and grants it otherwise", async () => {
    await client.query("insert into access_request (email) values ('new@example.test'), ('other@example.test'), ($1)", [VIEWER]);
    const status = async (email) => (await one('select status from access_request where email = $1', [email])).status;

    expect(await db.addEditor({ email: 'new@example.test', name: null, role: 'viewer' }, OWNER)).toMatchObject({ outcome: 'added', editor: { role: 'viewer' } });
    expect(await status('new@example.test')).toBe('pending');

    expect(await db.addEditor({ email: 'other@example.test', name: null, role: 'editor' }, OWNER)).toMatchObject({ outcome: 'added' });
    expect(await status('other@example.test')).toBe('granted');

    // Already a viewer, invited again as an editor: still listed as a viewer, so the request stays pending.
    expect(await db.addEditor({ email: VIEWER, name: null, role: 'editor' }, OWNER)).toEqual({ outcome: 'listed', editor: null });
    expect(await status(VIEWER)).toBe('pending');
    expect(await roleOf(VIEWER)).toBe('viewer');
  });

  it("grants a viewer's pending request when an admin makes them an editor, so it never comes back", async () => {
    const { request } = await db.createAccessRequest({ email: VIEWER, name: 'Vi', note: null });
    expect(await db.changeEditorRole(VIEWER, 'editor', OWNER)).toMatchObject({ outcome: 'changed', editor: { role: 'editor' } });
    expect(await one('select status, resolved_by from access_request where id = $1', [request.id])).toEqual({ status: 'granted', resolved_by: OWNER });
    // Made a viewer again, or removed: nothing pending reappears.
    expect((await db.changeEditorRole(VIEWER, 'viewer', OWNER)).outcome).toBe('changed');
    expect(await db.pendingRequestCount()).toBe(0);
    expect(await db.removeEditor(VIEWER, OWNER)).toBe('removed');
    expect(await db.pendingRequestCount()).toBe(0);
  });

  it("leaves a pending request alone when someone is made a viewer", async () => {
    const { request } = await db.createAccessRequest({ email: VIEWER, name: 'Vi', note: null });
    await client.query("update editor set role = 'editor' where email = $1", [VIEWER]);
    expect((await db.changeEditorRole(VIEWER, 'viewer', OWNER)).outcome).toBe('changed');
    expect((await one('select status from access_request where id = $1', [request.id])).status).toBe('pending');
  });

  it("grants without locking an existing editor's row", async () => {
    const { id } = await one('insert into access_request (email) values ($1) returning id::int', [EDITOR]);
    // Hold the editor's row, as changeEditorRole or removeEditor would: the grant must not wait on it.
    const holder = await pool.connect();
    try {
      await holder.query('begin');
      await holder.query('select 1 from editor where email = $1 for update', [EDITOR]);
      await holder.query("set local lock_timeout = '5s'");
      const granted = await db.resolveAccessRequest(id, 'grant', OWNER);
      expect(granted).toMatchObject({ outcome: 'granted', wasEditor: true, editor: { role: 'editor' } });
    } finally {
      await holder.query('rollback').catch(() => {});
      holder.release();
    }
  });

  it('changes someone to and from viewer; a viewer is not an admin', async () => {
    expect(await db.changeEditorRole(EDITOR, 'viewer', OWNER)).toMatchObject({ outcome: 'changed', editor: { role: 'viewer' } });
    expect(await db.changeEditorRole(EDITOR, 'editor', OWNER)).toMatchObject({ outcome: 'changed', editor: { role: 'editor' } });
    expect((await db.changeEditorRole(EDITOR, 'admin', VIEWER)).outcome).toBe('not_an_admin');
    expect((await db.addEditor({ email: 'x@example.test', name: null, role: 'viewer' }, VIEWER)).outcome).toBe('not_an_admin');
    expect(await db.removeEditor(EDITOR, VIEWER)).toBe('not_an_admin');
  });
});
