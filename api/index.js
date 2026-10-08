import { Pool } from 'pg';
import { attachDatabasePool } from '@neon/functions';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
attachDatabasePool(pool);

export default {
  async fetch() {
    const started = Date.now();
    const { rows } = await pool.query('select 1 as one');
    return Response.json(
      { rows, dbMs: Date.now() - started },
      { headers: { 'access-control-allow-origin': '*' } }
    );
  },
};
