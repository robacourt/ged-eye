/**
 * Shared setup for tests that need a real database: the dedicated Neon test branch in
 * DATABASE_URL_TEST, never production. Run via npm run test:db.
 */
import pg from 'pg';
import { migrate } from '../../scripts/neon/migrate.js';

export const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST;

const host = (u) => new URL(u).hostname.replace('-pooler', '');
const productionHosts = [process.env.DATABASE_URL, process.env.DATABASE_URL_UNPOOLED].filter(Boolean).map(host);
if (TEST_DATABASE_URL && productionHosts.length === 0) {
  throw new Error('DATABASE_URL_TEST is set but DATABASE_URL and DATABASE_URL_UNPOOLED are not, so it cannot be checked against production; run via npm run test:db');
}
if (TEST_DATABASE_URL && productionHosts.includes(host(TEST_DATABASE_URL))) {
  throw new Error('DATABASE_URL_TEST points at the production branch; refusing to reset it');
}

/** Connects to the test branch and gives it a freshly migrated, empty public schema. */
export async function resetTestDatabase() {
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  await client.query('drop schema public cascade; create schema public;');
  await migrate(TEST_DATABASE_URL, { log: () => {} });
  return client;
}

/**
 * Runs `sql` (one or more statements) inside a recorded change, as tests and scripts must after 006.
 * pg can't take params with multi-statement SQL, so call it once per statement when using params.
 * It commits: tests that roll back instead call begin_change themselves right after their own begin.
 * READ COMMITTED throughout: the global lock relies on each statement taking a fresh snapshot after it.
 */
export async function withChange(client, sql, params = []) {
  await client.query('begin');
  try {
    await client.query(`select begin_change('test@example.test', 'Test', 'fixture', 'script', 'Test fixture', '{}', '{}')`);
    const result = await client.query(sql, params);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}
