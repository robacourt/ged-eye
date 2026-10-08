import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import pg from 'pg';
import { parseGedcom } from '../gedParser.js';
import { ROOT, argValue, hasFlag, isMain, readJson, writeJson } from './cli.js';
import { readLegacyAvatars } from './legacyData.js';
import { gedToRows } from './gedToRows.js';
import { MANIFEST_PATH } from './uploadMedia.js';

export const WARNINGS_PATH = path.join(ROOT, '.neon-import', 'import-warnings.json');
const BATCH = 500;

async function insertRows(client, table, columns, rows, returning) {
  const out = [];
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const params = [];
    const tuples = chunk.map((row, r) => {
      columns.forEach(column => params.push(row[column]));
      return `(${columns.map((_, c) => `$${r * columns.length + c + 1}`).join(', ')})`;
    });
    const sql = `insert into ${table} (${columns.join(', ')}) values ${tuples.join(', ')}${returning ? ` returning ${returning}` : ''}`;
    out.push(...(await client.query(sql, params)).rows);
  }
  return out;
}

async function main() {
  const legacyRoot = path.resolve(ROOT, argValue('--legacy-root', 'ignore/legacy-data'));
  const replace = hasFlag('--replace');
  const url = process.env.DATABASE_URL_UNPOOLED;
  if (!url) throw new Error('DATABASE_URL_UNPOOLED is not set (run via npm run import-ged, or pass --env-file=.env.local)');
  const host = new URL(url).hostname;
  if (replace && argValue('--confirm') !== host) {
    throw new Error(`Refusing to wipe ${host}: pass --confirm ${host} to replace all people, families and media there (Neon is the master copy; this discards edits).`);
  }
  const manifest = readJson(MANIFEST_PATH, null);
  if (!manifest) throw new Error(`No media manifest at ${MANIFEST_PATH}; run npm run upload-media first`);

  const gedBytes = fs.readFileSync(path.join(ROOT, 'acourt.ged'));
  const parsed = parseGedcom(gedBytes.toString('utf-8'));
  const rows = gedToRows(parsed, manifest, readLegacyAvatars(legacyRoot));
  const people = rows.people.map(p => ({ ...p, facts: JSON.stringify(p.facts) }));

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const { rows: [{ count }] } = await client.query('select count(*)::int as count from person');
    if (count > 0 && !replace) throw new Error(`person already has ${count} rows; pass --replace to wipe and reload`);

    await client.query('begin');
    if (replace) await client.query('truncate person_media, media, family_child, family, person restart identity');
    await insertRows(client, 'person', ['id', 'given_name', 'surname', 'display_name', 'sex', 'birth_date', 'birth_place',
      'death_date', 'death_place', 'baptism_date', 'baptism_place', 'burial_date', 'burial_place', 'facts', 'avatar_key'], people);
    await insertRows(client, 'family', ['id', 'partner1_id', 'partner2_id', 'marriage_date', 'marriage_place',
      'divorce_date', 'divorce_place'], rows.families);
    await insertRows(client, 'family_child', ['family_id', 'child_id', 'position'], rows.familyChildren);
    const mediaIds = new Map((await insertRows(client, 'media', ['sha256', 'original_path', 'file_name', 'content_type',
      'byte_size', 'object_key', 'thumb_key'], rows.media, 'id, sha256')).map(r => [r.sha256, r.id]));
    await insertRows(client, 'person_media', ['person_id', 'media_id', 'position'],
      rows.personMedia.map(pm => ({ person_id: pm.person_id, media_id: mediaIds.get(pm.sha256), position: pm.position })));
    await client.query(
      'insert into gedcom_archive (file_name, sha256, content) values ($1, $2, $3) on conflict (sha256) do nothing',
      ['acourt.ged', crypto.createHash('sha256').update(gedBytes).digest('hex'), gedBytes]
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }

  writeJson(WARNINGS_PATH, rows.warnings);
  const byType = rows.warnings.reduce((acc, w) => ({ ...acc, [w.type]: (acc[w.type] || 0) + 1 }), {});
  console.log(JSON.stringify({
    people: rows.people.length, families: rows.families.length, familyChildren: rows.familyChildren.length,
    media: rows.media.length, personMedia: rows.personMedia.length, warnings: byType
  }));
}

if (isMain(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    if (error.detail) console.error(`detail: ${error.detail}`);
    if (error.constraint) console.error(`constraint: ${error.constraint}`);
    process.exit(1);
  });
}
