import path from 'path';
import pg from 'pg';
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { ROOT, argValue, isMain, readJson } from './cli.js';
import { readLegacyPeople } from './legacyData.js';
import { legacyExpected, diffView } from './verifyCompare.js';
import { BUCKET, MANIFEST_PATH } from './uploadMedia.js';
import { WARNINGS_PATH } from './importGed.js';

const canonical = (value) => JSON.stringify(value, (_, v) =>
  v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);

async function listKeys(s3) {
  const keys = new Set();
  let token;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, ContinuationToken: token }));
    for (const object of page.Contents ?? []) keys.add(object.Key);
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

async function main() {
  const legacyRoot = path.resolve(ROOT, argValue('--legacy-root', 'public'));
  const apiSample = Number(argValue('--api-sample', '25'));
  const manifest = readJson(MANIFEST_PATH, null);
  const warnings = readJson(WARNINGS_PATH, []);
  const warnedPeople = new Set(warnings.map(w => w.personId).filter(Boolean));
  const people = readLegacyPeople(legacyRoot);
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
  const problems = [];

  const { rows: [{ count }] } = await pool.query('select count(*)::int as count from person');
  if (count !== people.size) problems.push(`person count ${count} != legacy ${people.size}`);

  const ids = [...people.keys()];
  const views = new Map();
  let explained = 0;
  let next = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (next < ids.length) {
      const id = ids[next++];
      const { rows } = await pool.query('select person_view($1) as v', [id]);
      views.set(id, rows[0].v);
      const diffs = diffView(legacyExpected(people, id), rows[0].v, manifest, people);
      if (!diffs.length) continue;
      if (warnedPeople.has(id)) {
        explained++;
        console.log(`[explained] ${id}: ${diffs.join(' | ')}`);
      } else {
        problems.push(`${id}: ${diffs.join(' | ')}`);
      }
    }
  }));

  const s3 = new S3Client({ forcePathStyle: true });
  const keys = await listKeys(s3);
  const { rows: keyRows } = await pool.query(`
    select object_key as key from media
    union all select thumb_key from media where thumb_key is not null
    union all select avatar_key from person where avatar_key is not null`);
  const missingKeys = keyRows.map(r => r.key).filter(key => !keys.has(key));
  if (missingKeys.length) problems.push(`missing bucket objects: ${missingKeys.slice(0, 20).join(', ')} (${missingKeys.length} total)`);

  const apiBase = (process.env.NEON_FUNCTION_API_BASE_URL || 'https://br-green-bonus-b26abimr-api.compute.c-6.eu-central-1.aws.neon.tech').replace(/\/$/, '');
  const timings = [];
  if (apiSample > 0) {
    const sample = [...ids].sort(() => Math.random() - 0.5).slice(0, apiSample);
    for (const id of sample) {
      const started = Date.now();
      const res = await fetch(`${apiBase}/person/${encodeURIComponent(id)}`);
      timings.push(Date.now() - started);
      const body = await res.json();
      if (res.status !== 200 || canonical(body) !== canonical(views.get(id))) problems.push(`api ${id}: status ${res.status} or body differs from database`);
    }
  }
  await pool.end();

  console.log(JSON.stringify({
    people: ids.length, explained, unexplained: problems.length, bucketObjects: keys.size,
    apiSample: timings.length, apiMedianMs: timings.sort((a, b) => a - b)[Math.floor(timings.length / 2)] ?? null
  }));
  if (problems.length) {
    console.error(problems.join('\n'));
    process.exit(1);
  }
}

if (isMain(import.meta.url)) {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
