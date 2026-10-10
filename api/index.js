import { Pool } from 'pg';
import { attachDatabasePool, waitUntil } from '@neon/functions';
import { createHandler } from './handler.js';
import { authenticatorFromEnv } from './auth.js';
import { createDb } from './db.js';
import { createMailer } from './mailer.js';
import { headObjectFromEnv } from './uploads.js';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5, connectionTimeoutMillis: 10_000 });
attachDatabasePool(pool);

export default {
  fetch: createHandler({
    db: createDb(pool, { context: { headObject: headObjectFromEnv(process.env) } }),
    authenticate: authenticatorFromEnv(process.env),
    // Sends through Gmail when SMTP_USER and SMTP_PASS are set (neon.ts passes them only when both are), else logs.
    mailer: createMailer(process.env),
    waitUntil
  })
};
