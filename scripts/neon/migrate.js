import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import pg from 'pg';
import { ROOT, argValue, isMain } from './cli.js';

const MIGRATIONS_DIR = path.join(ROOT, 'db', 'migrations');

const readMigration = (file) => fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');

/** sha256 of a migration's text with LF line endings, so a CRLF checkout still matches. */
export function migrationChecksum(sql) {
  return crypto.createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
}

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
    const applied = (await client.query('select filename, checksum from schema_migrations order by filename')).rows;
    const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();

    // Check every applied migration before running anything new.
    const backfill = [];
    for (const { filename, checksum: stored } of applied) {
      if (!files.includes(filename)) {
        throw new Error(`Migration ${filename} was applied but its file is missing from db/migrations`);
      }
      const checksum = migrationChecksum(readMigration(filename));
      if (stored === null) backfill.push([filename, checksum]);
      else if (stored !== checksum) throw new Error(`Migration ${filename} has changed since it was applied`);
    }
    for (const [filename, checksum] of backfill) {
      await client.query('update schema_migrations set checksum = $2 where filename = $1', [filename, checksum]);
    }

    const appliedNames = new Set(applied.map(r => r.filename));
    for (const file of files.filter(f => !appliedNames.has(f))) {
      const sql = readMigration(file);
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into schema_migrations (filename, checksum) values ($1, $2)', [file, migrationChecksum(sql)]);
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
