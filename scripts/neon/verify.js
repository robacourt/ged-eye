import path from 'path';
import pg from 'pg';
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { ROOT, argValue, isMain, readJson } from './cli.js';
import { readLegacyPeople } from './legacyData.js';
import {
  apiMatchesView, legacyExpected, diffView, splitDiffs, noteView, createNotes, collectNotes, summarizeNotes, formatNotes, shuffled
} from './verifyCompare.js';
import { BUCKET, MANIFEST_PATH } from './uploadMedia.js';
import { WARNINGS_PATH } from './importGed.js';

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
  const legacyRoot = path.resolve(ROOT, argValue('--legacy-root', 'ignore/legacy-data'));
  const apiSample = Number(argValue('--api-sample', '25'));
  const manifest = readJson(MANIFEST_PATH, null);
  const warnings = readJson(WARNINGS_PATH, []);
  // personId -> import warning types; splitDiffs() decides which differences a warning can explain.
  const warningTypes = new Map();
  for (const w of warnings) {
    if (!w.personId) continue;
    if (!warningTypes.has(w.personId)) warningTypes.set(w.personId, new Set());
    warningTypes.get(w.personId).add(w.type);
  }
  const people = readLegacyPeople(legacyRoot);
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
  const problems = [];

  const { rows: [{ count }] } = await pool.query('select count(*)::int as count from person');
  if (count !== people.size) problems.push(`person count ${count} != legacy ${people.size}`);

  const ids = [...people.keys()];
  const views = new Map();
  const notes = createNotes();
  let explained = 0;
  let next = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (next < ids.length) {
      const id = ids[next++];
      const { rows } = await pool.query('select person_view($1) as v', [id]);
      views.set(id, rows[0].v);
      const expected = legacyExpected(people, id);
      collectNotes(notes, id, noteView(expected, rows[0].v, manifest));
      const split = splitDiffs(diffView(expected, rows[0].v, manifest, people), warningTypes.get(id));
      if (split.explained.length) {
        explained++;
        console.log(`[explained] ${id}: ${split.explained.join(' | ')}`);
      }
      if (split.unexplained.length) problems.push(`${id}: ${split.unexplained.join(' | ')}`);
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
    const sample = shuffled(ids).slice(0, apiSample);
    console.log(`API sample (${sample.length}): ${sample.join(' ')}`);
    for (const id of sample) {
      const started = Date.now();
      let res;
      try {
        res = await fetch(`${apiBase}/person/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(30_000) });
      } catch (error) {
        problems.push(`api ${id}: request failed (${error.message})`);
        continue;
      }
      timings.push(Date.now() - started);
      const contentType = res.headers.get('content-type') ?? '';
      if (!res.ok || !/json/i.test(contentType)) {
        problems.push(`api ${id}: status ${res.status}, content-type ${contentType || 'none'}`);
        continue;
      }
      let body;
      try {
        body = await res.json();
      } catch (error) {
        problems.push(`api ${id}: status ${res.status} but body is not valid JSON (${error.message})`);
        continue;
      }
      if (!apiMatchesView(body, views.get(id))) problems.push(`api ${id}: body differs from database`);
    }
  }
  await pool.end();

  console.log(formatNotes(notes).join('\n'));
  console.log(JSON.stringify({
    people: ids.length, explained, unexplained: problems.length, bucketObjects: keys.size,
    apiSample: timings.length, apiMedianMs: timings.sort((a, b) => a - b)[Math.floor(timings.length / 2)] ?? null,
    notes: summarizeNotes(notes)
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
