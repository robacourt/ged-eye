import fs from 'fs';
import path from 'path';
import pg from 'pg';
import { ROOT, argValue, isMain } from './cli.js';

const MIGRATIONS_DIR = path.join(ROOT, 'db', 'migrations');

export async function migrate(databaseUrl, { log = console.log } = {}) {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(`create table if not exists schema_migrations (
      filename text primary key,
      applied_at timestamptz not null default now()
    )`);
    const applied = new Set((await client.query('select filename from schema_migrations')).rows.map(r => r.filename));
    const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into schema_migrations (filename) values ($1)', [file]);
        await client.query('commit');
        log(`applied ${file}`);
      } catch (error) {
        await client.query('rollback');
        throw new Error(`${file}: ${error.message}`);
      }
    }
  } finally {
    await client.end();
  }
}

if (isMain(import.meta.url)) {
  const url = argValue('--database-url', process.env.DATABASE_URL_UNPOOLED);
  if (!url) {
    console.error('No database URL: set DATABASE_URL_UNPOOLED (npm run db:migrate loads .env.local) or pass --database-url');
    process.exit(1);
  }
  migrate(url).catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}
