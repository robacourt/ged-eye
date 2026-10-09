/**
 * Runs edit commands (api/commands) as recorded changes, and maps database errors to API errors.
 */
import { ApiError, invalid, isObject } from './http.js';
import { inTransaction } from './db.js';
import { COMMANDS } from './commands/index.js';

/**
 * A database error as the API error it stands for, or the error itself when it has no mapping.
 * GE001–GE003 come from toggle_change; GE005–GE007 (an unrecorded write, a truncate, a primary-key
 * change) mean a bug, so they are logged 500s. Integrity violations (SQLSTATE class 23) can't come
 * from a race, since every write holds the global lock, so they are logged too.
 */
export function mapDbError(error, log = console.error) {
  if (error instanceof ApiError) return error;
  const code = typeof error?.code === 'string' ? error.code : '';
  switch (code) {
    case 'GE001': return new ApiError(404, 'not_found');
    case 'GE002': return new ApiError(409, 'wrong_state');
    case 'GE003': {
      let detail = {};
      try {
        detail = JSON.parse(error.detail);
      } catch {
        // keep the defaults
      }
      return new ApiError(409, 'conflict', {
        reason: typeof detail?.reason === 'string' ? detail.reason : 'constraint',
        blocking: Array.isArray(detail?.blocking) ? detail.blocking : []
      });
    }
    case 'GE004': return new ApiError(400, 'no_change');
    case 'GE005':
    case 'GE006':
    case 'GE007':
      log('edit refused by the database', code, error.message);
      return new ApiError(500, 'internal');
    default:
      break;
  }
  if (code.startsWith('23')) {
    log('edit hit an integrity constraint', code, error.message, error.detail);
    return new ApiError(409, 'conflict', { reason: 'constraint', blocking: [] });
  }
  return error;
}

/** Opens the recorded change (taking the global write lock) and returns its id. */
async function beginChange(tx, user, kind, params) {
  try {
    const { rows: [{ id }] } = await tx.query(
      `select begin_change($1, $2, $3, 'edit', 'pending', $4::jsonb, '{}') as id`,
      [user.email, user.name ?? null, kind, JSON.stringify(params)]);
    return id;
  } catch (error) {
    // A backstop: validation already refuses text jsonb can't hold (NUL, unpaired surrogates).
    if (error?.code === '22P05' || error?.code === '22P02') throw invalid('params', 'params contain text that cannot be stored.');
    throw error;
  }
}

/**
 * Runs the command `kind` for `user` ({ email, name }) as one recorded change, via 'edit':
 * validate (before connecting, so bad input never takes the lock), then in one transaction
 * begin_change (the global write lock), run, refuse an empty change as no_change, record the
 * summary and person ids, and read the focus person's view, then commit.
 * The view is read before commit so a failure can't report an error for an edit that was saved.
 *
 * The transaction (inTransaction) stays at the default READ COMMITTED isolation. Never change it:
 * the global lock in begin_change relies on each later statement taking a fresh snapshot, so it
 * sees every change committed before the lock was granted.
 *
 * → { change: { id, summary, personIds }, view: unmasked person_view of the focus, or null }
 * Throws ApiError (400 invalid / no_change, 404, 409 stale / conflict, 500 internal) or a raw error.
 * `commands` and `log` are injectable for tests.
 */
export async function runChange(pool, user, kind, params, { commands = COMMANDS, log = console.error } = {}) {
  const command = typeof kind === 'string' ? commands.get(kind) : undefined;
  if (!command) throw invalid('kind', `Unknown command: ${kind}.`);
  if (!isObject(params)) throw invalid('params', 'params must be an object.');
  const clean = command.validate(params);

  try {
    return await inTransaction(pool, async (tx) => {
      const id = await beginChange(tx, user, kind, params);
      const { summary, personIds, focusId } = await command.run(tx, clean, user);

      const { rows: [{ n }] } = await tx.query('select count(*)::int as n from change_row where change_id = $1', [id]);
      if (n === 0) throw new ApiError(400, 'no_change');

      await tx.query('update change set summary = $2, person_ids = $3 where id = $1', [id, summary, personIds]);
      const view = focusId ? (await tx.query('select person_view($1) as view', [focusId])).rows[0].view : null;
      return { change: { id: Number(id), summary, personIds }, view };
    });
  } catch (error) {
    throw mapDbError(error, log);
  }
}
