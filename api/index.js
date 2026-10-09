import { Pool } from 'pg';
import { attachDatabasePool } from '@neon/functions';
import { createHandler } from './handler.js';
import { createAuthenticator } from './auth.js';
import { ApiError } from './http.js';

/** Escapes LIKE wildcards and the escape character itself, for use with `escape '\'`. */
export function escapeLike(text) {
  return text.replace(/[\\%_]/g, '\\$&');
}

const PERSON_VIEW_SQL = `
  select person_view($1) as view,
         (select coalesce(max(id), 0) from change) as change_id,
         (select max(filename) from schema_migrations) as migration`;

const SEARCH_SQL = `
  select id, display_name as name,
         substring(birth_date from '[0-9]{4}')::int as birth_year,
         substring(death_date from '[0-9]{4}')::int as death_year
  from person
  where display_name % $1 or display_name ilike $2 escape '\\'
  order by similarity(display_name, $1) desc, display_name, id
  limit $3`;

const EDITOR_COLUMNS = 'email, name, role, added_by, added_at';

const editorFromRow = (row) => ({ email: row.email, name: row.name, role: row.role, addedBy: row.added_by, addedAt: row.added_at });

/**
 * Runs `run(client)` in a transaction with the write timeouts, so nothing it locks is held for long.
 * Stays at the default READ COMMITTED isolation: the locking below (and the global write lock in
 * begin_change) relies on each statement seeing everything committed before it.
 */
async function inTransaction(pool, run) {
  const client = await pool.connect();
  let broken;
  try {
    await client.query('begin');
    await client.query("set local statement_timeout = '10s'; set local idle_in_transaction_session_timeout = '15s'");
    const result = await run(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch((rollbackError) => { broken = rollbackError; });
    throw error;
  } finally {
    client.release(broken);
  }
}

const notImplemented = async () => {
  throw new ApiError(501, 'not_implemented');
};

/** The handler's `db`, backed by a pg pool. See createHandler for the contract. */
export function createDb(pool) {
  return {
    async personView(id) {
      // One statement, so the view and its version come from one snapshot.
      const { rows: [row] } = await pool.query(PERSON_VIEW_SQL, [id]);
      return { view: row.view, version: { changeId: String(row.change_id), migration: row.migration } };
    },

    async search(q, limit) {
      const { rows } = await pool.query(SEARCH_SQL, [q, `${escapeLike(q)}%`, limit]);
      return rows.map((row) => ({ id: row.id, name: row.name, birthYear: row.birth_year, deathYear: row.death_year }));
    },

    async lookupEditor(email) {
      const { rows: [row] } = await pool.query('select email, name, role from editor where email = $1', [email]);
      return row ? { email: row.email, name: row.name, role: row.role } : null;
    },

    async listEditors() {
      const { rows } = await pool.query(`select ${EDITOR_COLUMNS} from editor order by role = 'admin' desc, email`);
      return rows.map(editorFromRow);
    },

    async addEditor({ email, name, role }, by) {
      const { rows: [row] } = await pool.query(
        `insert into editor (email, name, role, added_by) values ($1, $2, $3, $4)
         on conflict (email) do nothing
         returning ${EDITOR_COLUMNS}`,
        [email, name, role, by]
      );
      return row ? editorFromRow(row) : null;
    },

    removeEditor(email, by) {
      return inTransaction(pool, async (client) => {
        // Locking every admin row, in a fixed order, serialises removals: if two admins remove each
        // other at once, the second waits, then finds it is no longer an admin.
        const { rows: admins } = await client.query("select email from editor where role = 'admin' order by email for update");
        if (!admins.some((row) => row.email === by)) return 'not_an_admin';
        const { rows: [target] } = await client.query('select role from editor where email = $1 for update', [email]);
        if (!target) return 'not_found';
        if (target.role === 'admin' && admins.length <= 1) return 'last_admin';
        await client.query('delete from editor where email = $1', [email]);
        return 'removed';
      });
    },

    // Tasks 7 and 8.
    runChange: notImplemented,
    toggle: notImplemented,
    undoLast: notImplemented,
    redoLast: notImplemented,
    listChanges: notImplemented
  };
}

/** Verifies Neon Auth JWTs; without Auth configured every request is anonymous, so the read-only site still works. */
export function authenticatorFromEnv({ NEON_AUTH_JWKS_URL, NEON_AUTH_BASE_URL }) {
  if (!NEON_AUTH_JWKS_URL || !NEON_AUTH_BASE_URL) {
    console.warn('NEON_AUTH_JWKS_URL or NEON_AUTH_BASE_URL is not set: every request is treated as anonymous');
    return async () => null;
  }
  return createAuthenticator({ jwksUrl: NEON_AUTH_JWKS_URL, issuer: new URL(NEON_AUTH_BASE_URL).origin });
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5, connectionTimeoutMillis: 10_000 });
attachDatabasePool(pool);

const handle = createHandler({ db: createDb(pool), authenticate: authenticatorFromEnv(process.env) });

export default { fetch: handle };
