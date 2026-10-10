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

// Access requests (migration 009). The rate limits: at most 3 per email in any 24 hours, and at most
// 10 from everyone in any hour. At most 100 are listed.
// resolved_by_name: the resolving admin's editor name, or their email when they have none (or are no
// longer an editor). A scalar subquery, so it also works in RETURNING.
const REQUEST_COLUMNS = `id, email, name, note, created_at, status, resolved_by, resolved_at,
  coalesce((select nullif(e.name, '') from editor e where e.email = access_request.resolved_by),
           access_request.resolved_by) as resolved_by_name`;
const PER_EMAIL_LIMIT = 3;
const GLOBAL_LIMIT = 10;
const REQUESTS_LISTED = 100;
// pg_advisory_xact_lock key serialising new requests, so the rate limits hold under concurrency.
// Distinct from begin_change's 7262021.
const ACCESS_REQUEST_LOCK = 7262022;

const requestFromRow = (row) => ({
  id: Number(row.id),
  email: row.email,
  name: row.name,
  note: row.note,
  status: row.status,
  createdAt: iso(row.created_at),
  resolvedBy: row.resolved_by,
  resolvedByName: row.resolved_by_name,
  resolvedAt: row.resolved_at === null ? null : iso(row.resolved_at)
});

// Pending requests from people who aren't editors: the ones an admin still has to look at.
const OPEN_REQUESTS = `
  from access_request r
  where r.status = 'pending'
    and not exists (select 1 from editor e where e.email = r.email)`;

const LATEST_REQUEST = `select ${REQUEST_COLUMNS} from access_request where email = $1 order by created_at desc, id desc limit 1`;

const NO_RESOLUTION = { request: null, editor: null, wasEditor: false };
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

/**
 * The handler's db over `pool`. `log` records unexpected failures; `context` ({ headObject }, see
 * api/uploads.js) is passed to each command's prepare step.
 */
export function createDb(pool, { log = console.error, context = {} } = {}) {
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

    /**
     * → the new editor, or null when the email is already listed (an existing editor is never changed).
     * Either way, a pending access request for the email is marked granted by `by`, in the same
     * transaction, so nothing is left pending.
     */
    addEditor({ email, name, role }, by) {
      return inTransaction(pool, async (client) => {
        // The request row first, then the editor: the order resolveAccessRequest locks them in.
        await client.query(
          `update access_request set status = 'granted', resolved_by = $2, resolved_at = now()
           where email = $1 and status = 'pending'`,
          [email, by]);
        const { rows: [row] } = await client.query(
          `insert into editor (email, name, role, added_by) values ($1, $2, $3, $4)
           on conflict (email) do nothing
           returning ${EDITOR_COLUMNS}`,
          [email, name, role, by]
        );
        return row ? editorFromRow(row) : null;
      });
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

    /**
     * The newest access request from `email`.
     * → { id, email, name, note, status, createdAt, resolvedBy, resolvedByName, resolvedAt } | null, where
     * resolvedBy is the resolving admin's email and resolvedByName their editor name, or their email
     * when they have none (both null while pending)
     */
    async latestAccessRequest(email) {
      const { rows: [row] } = await pool.query(LATEST_REQUEST, [email]);
      return row ? requestFromRow(row) : null;
    },

    /** → how many pending requests there are from people who aren't editors */
    async pendingRequestCount() {
      const { rows: [{ count }] } = await pool.query(`select count(*)::int as count ${OPEN_REQUESTS}`);
      return count;
    },

    /**
     * Asks for edit access for `email`. Checks, in this order: already an editor ('editor'); a pending
     * request ('pending', with it); the rate limits ('limited'); then inserts ('created', with it). New
     * requests are serialised by an advisory lock, so the limits hold; if a pending request appears
     * anyway (the insert's `on conflict … do nothing`), that one is returned as 'pending'.
     * → { outcome: 'created' | 'pending' | 'editor' | 'limited', request (as latestAccessRequest) | null }
     */
    createAccessRequest({ email, name, note }) {
      return inTransaction(pool, async (client) => {
        await client.query('select pg_advisory_xact_lock($1)', [ACCESS_REQUEST_LOCK]);
        const { rows: [editor] } = await client.query('select 1 from editor where email = $1', [email]);
        if (editor) return { outcome: 'editor', request: null };
        const { rows: [pending] } = await client.query(
          `select ${REQUEST_COLUMNS} from access_request where email = $1 and status = 'pending'`, [email]);
        if (pending) return { outcome: 'pending', request: requestFromRow(pending) };
        const { rows: [{ mine, everyone }] } = await client.query(
          `select count(*) filter (where email = $1 and created_at > now() - interval '24 hours')::int as mine,
                  count(*) filter (where created_at > now() - interval '1 hour')::int as everyone
           from access_request
           where created_at > now() - interval '24 hours'`, [email]);
        if (mine >= PER_EMAIL_LIMIT || everyone >= GLOBAL_LIMIT) return { outcome: 'limited', request: null };
        const { rows: [created] } = await client.query(
          `insert into access_request (email, name, note) values ($1, $2, $3)
           on conflict (email) where status = 'pending' do nothing
           returning ${REQUEST_COLUMNS}`,
          [email, name, note]);
        if (created) return { outcome: 'created', request: requestFromRow(created) };
        const { rows: [other] } = await client.query(LATEST_REQUEST, [email]);
        return { outcome: 'pending', request: other ? requestFromRow(other) : null };
      });
    },

    /** → [{ id, email, name, note, createdAt }]: pending requests from people who aren't editors, oldest first, at most 100 */
    async listAccessRequests() {
      const { rows } = await pool.query(
        `select r.id, r.email, r.name, r.note, r.created_at ${OPEN_REQUESTS}
         order by r.created_at, r.id
         limit $1`, [REQUESTS_LISTED]);
      return rows.map((row) => ({ id: Number(row.id), email: row.email, name: row.name, note: row.note, createdAt: iso(row.created_at) }));
    },

    /**
     * Grants ('grant') or dismisses ('dismiss') request `id` as `admin` (an email), in one transaction:
     * re-checks that `admin` is still an admin, locks the request, and for a grant adds the requester as
     * an editor (unless they already are) before marking the request resolved.
     * → { outcome: 'granted' | 'dismissed' | 'already_resolved' | 'not_found' | 'not_an_admin',
     *     request (as latestAccessRequest; for already_resolved, as it was resolved) | null,
     *     editor (granted: the new or existing editor, as addEditor) | null,
     *     wasEditor (granted: true when the requester was already an editor, so nothing changed for them) }
     */
    async resolveAccessRequest(id, action, admin) {
      if (action !== 'grant' && action !== 'dismiss') throw new Error(`resolveAccessRequest: unknown action ${action}`);
      return inTransaction(pool, async (client) => {
        // A share lock on the admin's own row: removeEditor locks admin rows for update, so a removal
        // waits for this to commit, and this waits for a removal in progress, then finds no row.
        const { rows: [stillAdmin] } = await client.query(
          "select 1 from editor where email = $1 and role = 'admin' for share", [admin]);
        if (!stillAdmin) return { outcome: 'not_an_admin', ...NO_RESOLUTION };
        const { rows: [row] } = await client.query(`select ${REQUEST_COLUMNS} from access_request where id = $1 for update`, [id]);
        if (!row) return { outcome: 'not_found', ...NO_RESOLUTION };
        if (row.status !== 'pending') return { outcome: 'already_resolved', ...NO_RESOLUTION, request: requestFromRow(row) };

        let editor = null;
        let wasEditor = false;
        if (action === 'grant') {
          const { rows: [added] } = await client.query(
            `insert into editor (email, name, role, added_by) values ($1, $2, 'editor', $3)
             on conflict (email) do nothing
             returning ${EDITOR_COLUMNS}`,
            [row.email, row.name, admin]);
          if (added) {
            editor = editorFromRow(added);
          } else {
            const { rows: [existing] } = await client.query(`select ${EDITOR_COLUMNS} from editor where email = $1`, [row.email]);
            editor = editorFromRow(existing);
            wasEditor = true;
          }
        }
        const { rows: [resolved] } = await client.query(
          `update access_request set status = $2, resolved_by = $3, resolved_at = now()
           where id = $1
           returning ${REQUEST_COLUMNS}`,
          [id, action === 'grant' ? 'granted' : 'dismissed', admin]);
        return { outcome: action === 'grant' ? 'granted' : 'dismissed', request: requestFromRow(resolved), editor, wasEditor };
      });
    },

    /** → the admins' emails, in order */
    async listAdminEmails() {
      const { rows } = await pool.query("select email from editor where role = 'admin' order by email");
      return rows.map((row) => row.email);
    },

    /** → { change: { id, summary, personIds }, view | null }; see api/changes.js */
    runChange: (editor, kind, params) => runChange(pool, editor, kind, params, { log, context }),

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
