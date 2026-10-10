import path from 'path';
import pg from 'pg';
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { ROOT, argValue, isMain, readJson } from './cli.js';
import { readLegacyPeople } from './legacyData.js';
import {
  apiMatchesView, apiBodyView, hasNoteEmailsToMask, canonical, legacyExpected, diffView, splitDiffs, noteView, createNotes, collectNotes,
  summarizeNotes, formatNotes, shuffled, touchedByEdits, countCheck
} from './verifyCompare.js';
import { BUCKET, MANIFEST_PATH } from './uploadMedia.js';
import { WARNINGS_PATH } from './importGed.js';

// T: every person any recorded change references. Person rows (and person_media) by key, family
// partners and children from the before/after snapshots, the people linked to a changed media row,
// and the current partners and children of every family a change touched (a re-filled partner slot
// changes a child's parents without a family_child row). Their legacy views no longer apply, nor
// do those of anyone whose view shows them (see touchedByEdits). The media backfill (and its undo
// or redo) only adds display and thumbnail keys and sizes, which the comparison doesn't check, so it
// marks nobody: otherwise everyone with a photo, and their relatives, would be skipped.
export const EDITED_SQL = `
  with touched_family as (
    select row_key ->> 'id' as id from change_row where table_name = 'family'
    union
    select row_key ->> 'family_id' from change_row where table_name = 'family_child'
  )
  select
    (select count(*)::int from change) as changes,
    coalesce((select array_agg(distinct id) from (
      select row_key ->> 'id' as id from change_row where table_name = 'person'
      union all
      select row_key ->> 'person_id' from change_row where table_name = 'person_media'
      union all
      select s.snap ->> k.col from change_row cr
        cross join lateral (values (cr.before), (cr.after)) s(snap)
        cross join lateral (values ('partner1_id'), ('partner2_id')) k(col)
        where cr.table_name = 'family'
      union all
      select s.snap ->> 'child_id' from change_row cr
        cross join lateral (values (cr.before), (cr.after)) s(snap)
        where cr.table_name = 'family_child'
      union all
      select pm.person_id from person_media pm
        where pm.media_id in (
          select (cr.row_key ->> 'id')::bigint from change_row cr join change c on c.id = cr.change_id
          where cr.table_name = 'media'
            and c.kind <> 'backfill_media'
            and not (c.kind in ('undo', 'redo') and exists (
                  select 1 from change b where b.id = c.base_change_id and b.kind = 'backfill_media')))
      union all
      select unnest(array[f.partner1_id, f.partner2_id]) from family f join touched_family t on t.id = f.id
      union all
      select fc.child_id from family_child fc join touched_family t on t.id = fc.family_id
    ) refs where id is not null), '{}') as ids`;

/** { changes, touched: Set<person id> }; nothing is edited on a database from before migration 006. */
async function editedPeople(pool) {
  const { rows: [{ logged }] } = await pool.query(`select to_regclass('change_row') is not null as logged`);
  if (!logged) return { changes: 0, touched: new Set() };
  const { rows: [row] } = await pool.query(EDITED_SQL);
  return { changes: row.changes, touched: new Set(row.ids) };
}

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

  const { changes, touched } = await editedPeople(pool);
  const { rows: [{ count }] } = await pool.query('select count(*)::int as count from person');
  const counted = countCheck(count, people.size, changes);
  if (counted.problem) problems.push(counted.problem);

  const ids = [...people.keys()];
  const views = new Map();
  const notes = createNotes();
  let explained = 0;
  let skippedEdited = 0;
  let next = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (next < ids.length) {
      const id = ids[next++];
      const { rows } = await pool.query('select person_view($1) as v', [id]);
      views.set(id, rows[0].v);
      const expected = legacyExpected(people, id);
      // Still fetched above: the API check compares the Function against the database, edits or not.
      if (touchedByEdits(id, expected, rows[0].v, touched)) {
        skippedEdited++;
        continue;
      }
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
    union all select display_key from media where display_key is not null
    union all select avatar_key from person where avatar_key is not null`);
  const missingKeys = keyRows.map(r => r.key).filter(key => !keys.has(key));
  if (missingKeys.length) problems.push(`missing bucket objects: ${missingKeys.slice(0, 20).join(', ')} (${missingKeys.length} total)`);

  const apiBase = (process.env.NEON_FUNCTION_API_BASE_URL || 'https://br-green-bonus-b26abimr-api.compute.c-6.eu-central-1.aws.neon.tech').replace(/\/$/, '');
  const timings = [];
  if (apiSample > 0) {
    // Legacy people deleted by an edit have no view (and a 404); everyone else is fair game.
    const live = ids.filter(id => views.get(id));
    // Always include a few people whose notes the Function masks, so the masking path is exercised.
    const maskedIds = shuffled(live.filter(id => hasNoteEmailsToMask(views.get(id)))).slice(0, 3);
    const sample = [...new Set([...shuffled(live).slice(0, apiSample), ...maskedIds])];
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
      const view = views.get(id);
      if (!apiMatchesView(body, view)) {
        problems.push(canonical(apiBodyView(body)) === canonical(view)
          ? `api ${id}: note emails served unmasked`
          : `api ${id}: body differs from database`);
      }
    }
  }
  await pool.end();

  console.log(formatNotes(notes).join('\n'));
  console.log(JSON.stringify({
    people: ids.length, skippedEdited, countCheck: counted.result, explained, unexplained: problems.length, bucketObjects: keys.size,
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
