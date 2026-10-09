/**
 * The handler's `db` (see createHandler in handler.js for the contract), backed by a pg pool.
 * Importing this module has no side effects: index.js creates the pool and passes it in.
 */
import { ApiError } from './http.js';
import { mapDbError, runChange } from './changes.js';
import { inTransaction } from './tx.js';

const CHANGES_PAGE = 50;

/** Escapes LIKE wildcards and the escape character itself, for use with `escape '\'`. */
export function escapeLike(text) {
  return text.replace(/[\\%_]/g, '\\$&');
}

// One statement, so the view and its version come from one snapshot.
const PERSON_VIEW_SQL = `
  select person_view($1) as view,
         (select coalesce(max(id), 0) from change) as change_id,
         (select max(filename) from schema_migrations) as migration`;

// $1 is the query text, $2 its LIKE-escaped prefix pattern. Matches a prefix of the whole name or
// of any later word ("Smi" finds "John Smith"), or a fuzzy match of the query against a word run
// in the name (word similarity, which the trigram index serves).
const SEARCH_SQL = `
  select id, display_name as name,
         gedcom_year(birth_date) as birth_year,
         gedcom_year(death_date) as death_year
  from person
  where display_name ilike $2::text escape '\\'
     or display_name ilike ('% ' || $2::text) escape '\\'
     or $1::text <% display_name
  order by greatest(similarity(display_name, $1), word_similarity($1, display_name)) desc, display_name, id
  limit $3`;

const EDITOR_COLUMNS = 'email, name, role, added_by, added_at';

const editorFromRow = (row) => ({ email: row.email, name: row.name, role: row.role, addedBy: row.added_by, addedAt: row.added_at });

const iso = (value) => (value instanceof Date ? value.toISOString() : value);
const idOrNull = (value) => (value === null || value === undefined ? null : Number(value));

/** A toggle's own change row, as the toggle routes return it. */
const toggledFromRow = (row) => ({
  id: Number(row.id),
  summary: row.summary,
  personIds: row.person_ids,
  baseChangeId: idOrNull(row.base_change_id),
  kind: row.kind
});

const historyFromRow = (row) => ({
  id: Number(row.id),
  createdAt: iso(row.created_at),
  authorName: row.author_name,
  authorEmail: row.author_email,
  kind: row.kind,
  via: row.via,
  summary: row.summary,
  personIds: row.person_ids,
  people: Array.isArray(row.people) ? row.people : [],
  baseChangeId: idOrNull(row.base_change_id),
  undone: row.undone
});

const HISTORY_COLUMNS = 'c.id, c.created_at, c.author_name, c.author_email, c.kind, c.via, c.summary, c.person_ids, ' +
  'c.base_change_id, c.undone';

// The people a change touched who still exist, in person_ids order, with their names now. Deleted
// people are left out; the History panel links to the rest.
const HISTORY_PEOPLE = `
  left join lateral (
    select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.display_name)
                     order by array_position(c.person_ids, p.id)) as people
    from person p
    where p.id = any (c.person_ids)
  ) touched on true`;

/**
 * A 409 conflict with each blocking change ({ id, action }, from toggle_change) given the
 * summary, author name and creation time the UI shows, in one query. The toggle's transaction
 * has rolled back by now; blocking changes are committed, and change rows are never deleted.
 * If they can't be read, the conflict is still sent, with those fields null.
 */
async function withBlockingDetails(pool, conflict, log) {
  // Entries that aren't objects can't name a change; they are left out rather than failing the response.
  const blocking = conflict.extra.blocking.filter((entry) => entry !== null && typeof entry === 'object');
  if (blocking.length === 0) return new ApiError(409, 'conflict', { ...conflict.extra, blocking });
  let byId = new Map();
  try {
    const { rows } = await pool.query(
      'select id, summary, author_name, created_at from change where id = any ($1::bigint[])',
      [blocking.map((entry) => entry.id)]);
    byId = new Map(rows.map((row) => [Number(row.id), row]));
  } catch (error) {
    log('could not read the blocking changes of a conflict', error);
  }
  const enriched = blocking.map(({ id, action }) => {
    const row = byId.get(Number(id));
    return { id, action, summary: row?.summary ?? null, authorName: row?.author_name ?? null, createdAt: row ? iso(row.created_at) : null };
  });
  return new ApiError(409, 'conflict', { ...conflict.extra, blocking: enriched });
}

export function createDb(pool, { log = console.error } = {}) {
  /**
   * Runs one toggle statement (`sql` returns the new change's `id`, or null when there was nothing
   * to do) in a write transaction, and reads back the change it recorded.
   * → { id, summary, personIds, baseChangeId, kind } | null; database errors become ApiErrors
   * (404 not_found, 409 wrong_state, 409 conflict with enriched blocking, 503 busy, 500 internal).
   */
  async function runToggle(sql, params) {
    try {
      return await inTransaction(pool, async (tx) => {
        const { rows: [{ id }] } = await tx.query(sql, params);
        if (id === null) return null;
        const { rows: [row] } = await tx.query(
          'select id, summary, person_ids, base_change_id, kind from change where id = $1', [id]);
        return toggledFromRow(row);
      });
    } catch (error) {
      const mapped = mapDbError(error, log);
      if (mapped instanceof ApiError && mapped.status === 409 && mapped.code === 'conflict') {
        throw await withBlockingDetails(pool, mapped, log);
      }
      throw mapped;
    }
  }

  return {
    /** → { view | null, version: { changeId (string), migration } } */
    async personView(id) {
      const { rows: [row] } = await pool.query(PERSON_VIEW_SQL, [id]);
      return { view: row.view, version: { changeId: String(row.change_id), migration: row.migration } };
    },

    /** → [{ id, name, birthYear, deathYear }], best match first */
    async search(q, limit) {
      const { rows } = await pool.query(SEARCH_SQL, [q, `${escapeLike(q)}%`, limit]);
      return rows.map((row) => ({ id: row.id, name: row.name, birthYear: row.birth_year, deathYear: row.death_year }));
    },

    /** → { email, name, role } | null */
    async lookupEditor(email) {
      const { rows: [row] } = await pool.query('select email, name, role from editor where email = $1', [email]);
      return row ? { email: row.email, name: row.name, role: row.role } : null;
    },

    /** → [{ email, name, role, addedBy, addedAt }], admins first */
    async listEditors() {
      const { rows } = await pool.query(`select ${EDITOR_COLUMNS} from editor order by role = 'admin' desc, email`);
      return rows.map(editorFromRow);
    },

    /** → the new editor, or null when the email is already listed (an existing editor is never changed) */
    async addEditor({ email, name, role }, by) {
      const { rows: [row] } = await pool.query(
        `insert into editor (email, name, role, added_by) values ($1, $2, $3, $4)
         on conflict (email) do nothing
         returning ${EDITOR_COLUMNS}`,
        [email, name, role, by]
      );
      return row ? editorFromRow(row) : null;
    },

    /** → 'removed' | 'not_found' | 'not_an_admin' (`by` isn't, or is no longer, an admin) | 'last_admin' */
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

    /** → { change: { id, summary, personIds }, view | null }; see api/changes.js */
    runChange: (editor, kind, params) => runChange(pool, editor, kind, params, { log }),

    /** Reverts ('undo') or restores ('redo') change `id`; → the toggle's change (see runToggle). */
    toggle: (editor, id, direction, via) => runToggle(
      'select toggle_change($1, $2, $3, $4, $5) as id', [id, direction, editor.email, editor.name ?? null, via]),

    /** Undoes the editor's latest edit still in effect (Ctrl+Z); → the toggle's change, or null. */
    undoLast: (editor) => runToggle('select undo_last($1, $2) as id', [editor.email, editor.name ?? null]),

    /** Redoes the editor's latest keyboard undo (Ctrl+Shift+Z); → the toggle's change, or null. */
    redoLast: (editor) => runToggle('select redo_last($1, $2) as id', [editor.email, editor.name ?? null]),

    /**
     * → [{ id, createdAt (ISO), authorName, authorEmail, kind, via, summary, personIds, people, baseChangeId, undone }],
     * newest first: at most `limit` (≤ 50) changes with ids below `before`, touching `person` if given.
     * `people` is `[{ id, name }]` for those of `personIds` who still exist, in the same order.
     */
    async listChanges({ before = null, limit = CHANGES_PAGE, person = null } = {}) {
      const where = [];
      const params = [];
      if (before !== null) {
        params.push(before);
        where.push(`c.id < $${params.length}`);
      }
      if (person !== null) {
        params.push(person);
        where.push(`c.person_ids @> array[$${params.length}::text]`);
      }
      params.push(Number.isInteger(limit) && limit > 0 ? Math.min(limit, CHANGES_PAGE) : CHANGES_PAGE);
      const { rows } = await pool.query(
        `select ${HISTORY_COLUMNS}, coalesce(touched.people, '[]'::jsonb) as people
         from change c ${HISTORY_PEOPLE}
         ${where.length > 0 ? `where ${where.join(' and ')}` : ''}
         order by c.id desc
         limit $${params.length}`, params);
      return rows.map(historyFromRow);
    }
  };
}
