// @vitest-environment node
// The media backfill against the test branch, with a fake bucket in memory and images made by sharp.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { TEST_DATABASE_URL as url, resetTestDatabase, withChange } from './testDatabase.js';
import { IMMUTABLE, apply, reportGps } from '../../scripts/neon/backfillMedia.js';

const sha = (buffer) => createHash('sha256').update(buffer).digest('hex');
const solid = (width, height) => sharp({ create: { width, height, channels: 3, background: '#c33' } });
const GPS = { IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '51/1 30/1 0/1' } };

// A 2400×1200 JPEG turned by orientation 6 (1200×2400 upright) with a thumbnail already, and with location data;
// a 300×200 TIFF scan without one; a JPEG sharp can't decode; a JPEG whose original is missing from the bucket;
// a PDF; and a JPEG that already has its display image.
const IMAGES = {
  turned: { ext: 'jpg', type: 'image/jpeg', body: await solid(2400, 1200).jpeg().withMetadata({ orientation: 6 }).withExif(GPS).toBuffer(), thumb: true },
  scan: { ext: 'tif', type: 'image/tiff', body: await solid(300, 200).tiff().toBuffer(), thumb: false },
  broken: { ext: 'jpg', type: 'image/jpeg', body: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('then garbage', 'latin1')]), thumb: true },
  missing: { ext: 'jpg', type: 'image/jpeg', body: Buffer.from('never uploaded'), thumb: true, absent: true },
  letter: { ext: 'pdf', type: 'application/pdf', body: Buffer.from('%PDF-1.4\n%%EOF\n'), thumb: false },
  done: { ext: 'jpg', type: 'image/jpeg', body: await solid(200, 100).jpeg().toBuffer(), thumb: true, display: true }
};
for (const image of Object.values(IMAGES)) image.sha = sha(image.body);
const originalKey = ({ sha: s, ext }) => `originals/${s}.${ext}`;

const FIXTURE = `insert into media (sha256, original_path, file_name, content_type, byte_size, object_key, thumb_key, display_key,
                                    width, height) values ${Object.entries(IMAGES).map(([name, image]) => `(
  '${image.sha}', 'Data/Media/${name}.${image.ext}', '${name}.${image.ext}', '${image.type}', ${image.body.length},
  '${originalKey(image)}', ${image.thumb ? `'thumbs/${image.sha}.webp'` : 'null'},
  ${image.display ? `'display/${image.sha}.webp', 200, 100` : 'null, null, null'})`).join(',')}`;
// Tree tables can't be truncated after 006, and every write to them is a recorded change.
const CLEAR_TREE = 'delete from person_media; delete from media; delete from family_child; delete from family; delete from person';

/** A bucket in memory holding the originals, with putOnce's semantics; `onGet(key)` runs before each read. */
function fakeStorage({ onGet } = {}) {
  const objects = new Map(Object.values(IMAGES).filter(image => !image.absent).map(image => [originalKey(image), image.body]));
  const puts = [];
  return {
    puts,
    async get(key) {
      await onGet?.(key);
      return objects.get(key) ?? null;
    },
    async putOnce(key, body, options) {
      if (objects.has(key)) return 'exists';
      objects.set(key, body);
      puts.push({ key, body, options });
      return 'uploaded';
    }
  };
}

describe.skipIf(!url)('backfillMedia (database)', { timeout: 60000 }, () => {
  let client;
  let ids;
  let lastChange;
  const one = async (sql, params) => (await client.query(sql, params)).rows[0];
  const all = async (sql, params) => (await client.query(sql, params)).rows;
  const media = async (name) => one(`select display_key, thumb_key, width, height from media where id = $1`, [ids[name]]);
  const changesSince = () => all(`select id, author_email, author_name, kind, via, summary, person_ids from change where id > $1 order by id`,
    [lastChange]);
  const quiet = () => {
    const lines = [];
    return { lines, log: (line) => lines.push(line) };
  };

  beforeAll(async () => {
    client = await resetTestDatabase();
  }, 60000);

  beforeEach(async () => {
    await withChange(client, CLEAR_TREE);
    await withChange(client, FIXTURE);
    const rows = await all('select id, file_name from media');
    ids = Object.fromEntries(rows.map(row => [row.file_name.replace(/\..*/, ''), row.id]));
    lastChange = (await one('select max(id) as id from change')).id;
  });

  afterAll(async () => {
    await client?.end();
  });

  it('writes display images, and thumbnails where missing, then records every row in one backfill_media change', async () => {
    const storage = fakeStorage();
    const { log } = quiet();
    const result = await apply(client, storage, { log });

    expect(result).toMatchObject({ pending: 4, updated: 2 });
    const changes = await changesSince();
    expect(changes).toEqual([{
      id: result.changeId, author_email: 'backfill@ged-eye.local', author_name: 'Media backfill', kind: 'backfill_media',
      via: 'script', summary: 'Display images for existing photos', person_ids: []
    }]);
    const rows = await all(`select table_name, row_key ->> 'id' as id, op from change_row where change_id = $1 order by id`, [result.changeId]);
    expect(rows).toEqual([ids.turned, ids.scan].sort((a, b) => a - b).map(id => ({ table_name: 'media', id, op: 'update' })));

    const { turned, scan } = IMAGES;
    expect(await media('turned')).toEqual({
      display_key: `display/${turned.sha}.webp`, thumb_key: `thumbs/${turned.sha}.webp`, width: 1200, height: 2400
    });
    expect(await media('scan')).toEqual({
      display_key: `display/${scan.sha}.webp`, thumb_key: `thumbs/${scan.sha}.webp`, width: 300, height: 200
    });
    for (const name of ['broken', 'missing', 'letter']) expect((await media(name)).display_key).toBeNull();
    expect(await media('done')).toEqual({ display_key: `display/${IMAGES.done.sha}.webp`, thumb_key: `thumbs/${IMAGES.done.sha}.webp`, width: 200, height: 100 });

    // The turned JPEG already had a thumbnail, so only the scan gets one.
    expect(storage.puts.map(put => put.key).sort()).toEqual(
      [`display/${turned.sha}.webp`, `display/${scan.sha}.webp`, `thumbs/${scan.sha}.webp`].sort());
    for (const put of storage.puts) expect(put.options).toEqual({ contentType: 'image/webp', cacheControl: IMMUTABLE });
    const shown = await sharp(storage.puts.find(put => put.key === `display/${turned.sha}.webp`).body).metadata();
    expect(shown).toMatchObject({ format: 'webp', width: 1000, height: 2000 });
  });

  it('skips and reports an image it cannot read or download, and still backfills the rest', async () => {
    const { lines, log } = quiet();
    const result = await apply(client, fakeStorage(), { log });

    expect(result.skipped).toEqual([
      { id: ids.broken, objectKey: originalKey(IMAGES.broken), reason: 'unreadable' },
      { id: ids.missing, objectKey: originalKey(IMAGES.missing), reason: 'missing original' }
    ].sort((a, b) => a.id - b.id));
    expect(lines.some(line => line.includes(`media ${ids.broken}`) && line.includes('unreadable'))).toBe(true);
    expect(lines.some(line => line.includes(`media ${ids.missing}`) && line.includes('missing original'))).toBe(true);
    expect(result.updated).toBe(2);
  });

  it('does nothing on a second run, and records no new change', async () => {
    const storage = fakeStorage();
    const first = await apply(client, storage, quiet());
    const putsAfterFirst = storage.puts.length;

    const second = await apply(client, storage, quiet());
    expect(second).toMatchObject({ pending: 2, updated: 0, changeId: null });
    expect(second.skipped.map(skip => skip.id)).toEqual([ids.broken, ids.missing].sort((a, b) => a - b));
    expect(storage.puts.length).toBe(putsAfterFirst);
    expect((await changesSince()).map(change => change.id)).toEqual([first.changeId]);
  });

  it('leaves a row given a display image while it ran, and records no empty change', async () => {
    // Someone else backfills both readable rows while this run is still making its images.
    let raced = false;
    const storage = fakeStorage({
      onGet: async () => {
        if (raced) return;
        raced = true;
        await withChange(client, `update media set display_key = 'display/elsewhere.webp' where display_key is null`);
      }
    });

    const result = await apply(client, storage, quiet());
    expect(result).toMatchObject({ updated: 0, changeId: null });
    expect((await changesSince()).map(change => change.kind)).toEqual(['fixture']); // only the race's own change
    expect(await media('turned')).toMatchObject({ display_key: 'display/elsewhere.webp', width: null, height: null });
    expect(await media('scan')).toMatchObject({ display_key: 'display/elsewhere.webp', thumb_key: null });
  });

  it('--report-gps lists every image original with location data by id, and writes nothing', async () => {
    const storage = fakeStorage();
    const report = await reportGps(client, storage, quiet());

    // Every image, including the one that already has its display image; never the PDF.
    expect(report).toEqual({
      checked: 3,
      withLocation: [ids.turned],
      skipped: [
        { id: ids.broken, objectKey: originalKey(IMAGES.broken), reason: 'unreadable' },
        { id: ids.missing, objectKey: originalKey(IMAGES.missing), reason: 'missing original' }
      ].sort((a, b) => a.id - b.id)
    });
    expect(storage.puts).toEqual([]);
    expect(await changesSince()).toEqual([]);
    expect(await media('turned')).toMatchObject({ display_key: null, width: null });
  });
});
