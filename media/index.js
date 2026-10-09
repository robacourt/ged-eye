import { Pool } from 'pg';
import { attachDatabasePool } from '@neon/functions';
import { parseTriggerDelivery } from '@neon/functions/triggers';
import { authenticatorFromEnv } from '../api/auth.js';
import { createMediaDb } from './db.js';
import { createMediaHandler } from './handler.js';
import * as imaging from './imaging.js';
import { createJobQueue } from './jobQueue.js';
import { createStorage } from './storage.js';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5, connectionTimeoutMillis: 10_000 });
attachDatabasePool(pool);

export default {
  fetch: createMediaHandler({
    storage: createStorage(),
    db: createMediaDb(pool),
    authenticate: authenticatorFromEnv(process.env),
    imaging,
    queue: createJobQueue(),
    // The handler answers a failed delivery ({ ok: false, error }) with 400 for invalid_body, else 401.
    parseTrigger: parseTriggerDelivery
  })
};
