/** The write transaction shared by api/db.js and api/changes.js. */

/**
 * Runs `run(client)` in a transaction with the write timeouts, so nothing it locks is held for long,
 * and returns its result. Any error rolls back and is rethrown.
 * Stays at the default READ COMMITTED isolation; never change it: the row locks in removeEditor
 * and the global write lock in begin_change rely on each statement seeing everything committed
 * before it.
 */
export async function inTransaction(pool, run) {
  const client = await pool.connect();
  let broken;
  try {
    await client.query('begin');
    await client.query("set local statement_timeout = '10s'; set local idle_in_transaction_session_timeout = '15s'");
    const result = await run(client);
    await client.query('commit');
    return result;
  } catch (error) {
    // A failed rollback means the connection is unusable: release(error) discards it.
    await client.query('rollback').catch((rollbackError) => { broken = rollbackError; });
    throw error;
  } finally {
    client.release(broken);
  }
}
