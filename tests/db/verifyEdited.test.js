// @vitest-environment node
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { TEST_DATABASE_URL as url, resetTestDatabase, withChange } from './testDatabase.js';
import { EDITED_SQL } from '../../scripts/neon/verify.js';

// Ann (I1) and Bob (I2) are both in m1; Cat (I3) is alone in m2.
const FIXTURE = `
insert into person (id, given_name, surname) values ('I1', 'Ann', 'Ash'), ('I2', 'Bob', 'Ash'), ('I3', 'Cat', 'Cole');
insert into media (sha256, original_path, file_name, content_type, byte_size, object_key, thumb_key) values
  ('m1', 'Data/Media/m1.jpg', 'm1.jpg', 'image/jpeg', 10, 'originals/m1.jpg', 'thumbs/m1.webp'),
  ('m2', 'Data/Media/m2.tif', 'm2.tif', 'image/tiff', 20, 'originals/m2.tif', null);
insert into person_media (person_id, media_id, position)
  select 'I1', id, 0 from media where sha256 = 'm1'
  union all select 'I2', id, 0 from media where sha256 = 'm1'
  union all select 'I3', id, 0 from media where sha256 = 'm2';
`;
// Tree tables can't be truncated after 006, and every write to them is a recorded change.
const CLEAR_TREE = 'delete from person_media; delete from media; delete from family_child; delete from family; delete from person';

describe.skipIf(!url)('verify EDITED_SQL (database)', () => {
  let client;
  const one = async (sql, params) => (await client.query(sql, params)).rows[0];
  const edited = async () => (await one(EDITED_SQL)).ids.sort();
  const toggle = async (id, dir) =>
    (await one(`select toggle_change($1, $2, 'me@example.test', 'Me', 'history') as id`, [id, dir])).id;

  /** Runs `sql` in a committed change of `kind`, as the backfill or a command would. → the change id */
  const recorded = async (kind, sql) => {
    await client.query('begin');
    try {
      const { id } = await one(`select begin_change('me@example.test', 'Me', $1, 'script', 'Test', '{}', '{}') as id`, [kind]);
      await client.query(sql);
      await client.query('commit');
      return id;
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  };

  beforeAll(async () => {
    client = await resetTestDatabase();
  }, 60000);

  // A freshly imported tree: the fixture's own change is cleared, so nobody starts out edited.
  beforeEach(async () => {
    await withChange(client, CLEAR_TREE);
    await withChange(client, FIXTURE);
    await client.query('truncate change_row, change');
  });

  afterAll(async () => {
    await client?.end();
  });

  it('marks nobody before any change', async () => {
    expect(await one(EDITED_SQL)).toEqual({ changes: 0, ids: [] });
  });

  it("marks a media row's people as edited after a fixture change to it", async () => {
    await withChange(client, `update media set caption = 'At the beach' where sha256 = 'm1'`);
    expect(await edited()).toEqual(['I1', 'I2']);
  });

  it("doesn't mark the people of media rows the backfill changed", async () => {
    await recorded('backfill_media', `update media set display_key = 'display/' || sha256 || '.webp',
      thumb_key = coalesce(thumb_key, 'thumbs/' || sha256 || '.webp'), width = 800, height = 600`);
    expect(await edited()).toEqual([]);
  });

  it("doesn't mark them after an undo and a redo of the backfill either", async () => {
    const backfill = await recorded('backfill_media', `update media set display_key = 'display/' || sha256 || '.webp'`);
    await toggle(backfill, 'undo');
    await toggle(backfill, 'redo');
    expect(await one(`select count(*)::int as n from change where base_change_id = $1`, [backfill])).toEqual({ n: 2 });
    expect(await edited()).toEqual([]);
  });

  it('still marks people for a later edit to a backfilled media row, and its undo', async () => {
    await recorded('backfill_media', `update media set display_key = 'display/' || sha256 || '.webp'`);
    const edit = await recorded('update_photo', `update media set caption = 'Cat' where sha256 = 'm2'`);
    expect(await edited()).toEqual(['I3']);
    await toggle(edit, 'undo');
    expect(await edited()).toEqual(['I3']);
  });
});
