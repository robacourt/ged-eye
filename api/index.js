import { Pool } from 'pg';
import { attachDatabasePool } from '@neon/functions';
import { createHandler } from './handler.js';
import { authenticatorFromEnv } from './auth.js';
import { createDb } from './db.js';
import { headObjectFromEnv } from './uploads.js';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5, connectionTimeoutMillis: 10_000 });
attachDatabasePool(pool);

export default {
  fetch: createHandler({
    db: createDb(pool, { context: { headObject: headObjectFromEnv(process.env) } }),
    authenticate: authenticatorFromEnv(process.env)
  })
};
