/**
 * The handler's `db` (see createHandler in handler.js for the contract), backed by a pg pool.
 * Importing this module has no side effects: index.js creates the pool and passes it in.
 */
import { ApiError } from './http.js';
import { runChange } from './changes.js';
import { inTransaction } from './tx.js';

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

const notImplemented = async () => {
  throw new ApiError(501, 'not_implemented');
};

export function createDb(pool) {
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
    runChange: (editor, kind, params) => runChange(pool, editor, kind, params),

    // Task 8.
    toggle: notImplemented,
    undoLast: notImplemented,
    redoLast: notImplemented,
    listChanges: notImplemented
  };
}
