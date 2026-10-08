import crypto from 'crypto';
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
    // sha256 of each file as applied; null for rows from before checksums were recorded.
    await client.query('alter table schema_migrations add column if not exists checksum text');
    const applied = new Map((await client.query('select filename, checksum from schema_migrations')).rows
      .map(r => [r.filename, r.checksum]));
    const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
    for (const file of files) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
      const checksum = crypto.createHash('sha256').update(sql).digest('hex');
      if (applied.has(file)) {
        const stored = applied.get(file);
        if (stored === null) {
          await client.query('update schema_migrations set checksum = $2 where filename = $1', [file, checksum]);
        } else if (stored !== checksum) {
          throw new Error(`Migration ${file} has changed since it was applied`);
        }
        continue;
      }
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into schema_migrations (filename, checksum) values ($1, $2)', [file, checksum]);
        await client.query('commit');
        log(`applied ${file}`);
      } catch (error) {
        // A failed rollback must not hide why the migration failed.
        await client.query('rollback').catch(() => {});
        throw new Error(`${file}: ${error.message}`, { cause: error });
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
