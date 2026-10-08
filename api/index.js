import { Pool } from 'pg';
import { attachDatabasePool } from '@neon/functions';
import { createHandler } from './handler.js';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
attachDatabasePool(pool);

const handle = createHandler(async (id) => {
  const { rows } = await pool.query('select person_view($1) as view', [id]);
  return rows[0].view;
});

export default { fetch: handle };
