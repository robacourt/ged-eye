// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TEST_DATABASE_URL as url, resetTestDatabase, withChange } from './testDatabase.js';

// Alice (I1) and Aaron (I2) are both tagged in m1; m2 is Alice's alone. Aaron's name sorts before
// Alice's but his id sorts after hers, and m1's links are made in id order, so only ordering by
// display_name lists Aaron first. Both of Alice's links are at position 0, broken by media_id. m2's
// link is made first, so on this small table the scan order would likely put m2 first without the
// tie-break, but that rests on the scan order and doesn't prove the tie-break on its own.
const FIXTURE = `
insert into person (id, given_name, surname) values ('I1', 'Alice', 'Ash'), ('I2', 'Aaron', 'Baker');
insert into media (sha256, original_path, file_name, content_type, byte_size, object_key, thumb_key,
                   display_key, width, height, caption, date) values
  ('m1', 'upload/m1.jpg', 'm1.jpg', 'image/jpeg', 10, 'originals/m1.jpg', 'thumbs/m1.webp',
   'display/m1.webp', 2000, 1500, 'At the beach', 'about 1923'),
  ('m2', 'Data/Media/m2.pdf', 'm2.pdf', 'application/pdf', 20, 'originals/m2.pdf', null,
   null, null, null, null, null);
insert into person_media (person_id, media_id, position)
  select 'I1', id, 0 from media where sha256 = 'm2';
insert into person_media (person_id, media_id, position)
  select p.id, m.id, 0 from person p cross join media m where m.sha256 = 'm1' order by p.id;
`;

const PHOTO_KEYS = ['id', 'key', 'thumbKey', 'displayKey', 'fileName', 'contentType', 'caption', 'date', 'width', 'height', 'people'];

describe.skipIf(!url)('migration 008: photos schema (database)', () => {
  let client;
  let m1;
  let m2;
  const one = async (sql, params) => (await client.query(sql, params)).rows[0];
  const record = async (id) => (await one('select person_record($1) as r', [id])).r;
  const toggle = async (id, dir) =>
    (await one(`select toggle_change($1, $2, 'me@example.test', 'Me', 'history') as id`, [id, dir])).id;

  /** Runs `sql` in its own committed change, as a command would; returns the change id and its change_row rows. */
  const recorded = async (sql) => {
    await client.query('begin');
    try {
      const { id } = await one(`select begin_change('me@example.test', 'Me', 'test_edit', 'edit', 'Test', '{}', '{}') as id`);
      await client.query(sql);
      const { rows } = await client.query(
        'select table_name, row_key, op, before, after from change_row where change_id = $1 order by table_name, id', [id]);
      await client.query('commit');
      return { id, rows };
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  };

  beforeAll(async () => {
    client = await resetTestDatabase();
    await withChange(client, FIXTURE);
    await client.query('select sync_id_sequences()');
    m1 = Number((await one(`select id from media where sha256 = 'm1'`)).id);
    m2 = Number((await one(`select id from media where sha256 = 'm2'`)).id);
  }, 60000);

  afterAll(async () => {
    await client?.end();
  });

  it('lists every photo field, null when unknown, with its people, ordered by position then media id', async () => {
    expect(m1).toBeLessThan(m2);
    const { photos } = await record('I1');
    expect(photos).toEqual([
      {
        id: m1, key: 'originals/m1.jpg', thumbKey: 'thumbs/m1.webp', displayKey: 'display/m1.webp',
        fileName: 'm1.jpg', contentType: 'image/jpeg', caption: 'At the beach', date: 'about 1923', width: 2000, height: 1500,
        people: [{ id: 'I2', name: 'Aaron Baker' }, { id: 'I1', name: 'Alice Ash' }]
      },
      {
        id: m2, key: 'originals/m2.pdf', thumbKey: null, displayKey: null,
        fileName: 'm2.pdf', contentType: 'application/pdf', caption: null, date: null, width: null, height: null,
        people: [{ id: 'I1', name: 'Alice Ash' }]
      }
    ]);
    for (const photo of photos) expect(Object.keys(photo).sort()).toEqual([...PHOTO_KEYS].sort());
    expect((await record('I2')).photos.map(p => [p.id, p.people])).toEqual([
      [m1, [{ id: 'I2', name: 'Aaron Baker' }, { id: 'I1', name: 'Alice Ash' }]]
    ]);
  });

  it('adds avatarSource only once avatar_source is set', async () => {
    expect('avatarSource' in await record('I2')).toBe(false);
    await withChange(client,
      `update person set avatar_source = '{"mediaId":1,"crop":{"x":0.1,"y":0.1,"w":0.5,"h":0.5}}' where id = 'I2'`);
    expect((await record('I2')).avatarSource).toEqual({ mediaId: 1, crop: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 } });
    expect('avatarSource' in await record('I1')).toBe(false);
  });

  it('records a caption edit in the change log, and undo restores the old caption', async () => {
    const { id, rows } = await recorded(`update media set caption = 'On the pier' where sha256 = 'm1'`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      table_name: 'media', row_key: { id: m1 }, op: 'update',
      before: { caption: 'At the beach' }, after: { caption: 'On the pier' }
    });

    await toggle(id, 'undo');
    expect(await one(`select caption from media where sha256 = 'm1'`)).toEqual({ caption: 'At the beach' });
  });

  it('undoes a recorded insert of a media row and its link, and redoes it with the same id', async () => {
    const state = () => one(`select
      (select to_jsonb(m) from media m where sha256 = 'm3') as media,
      (select jsonb_agg(to_jsonb(pm)) from person_media pm join media m on m.id = pm.media_id where m.sha256 = 'm3') as links`);
    const { id } = await recorded(`
      insert into media (sha256, original_path, file_name, content_type, byte_size, object_key, thumb_key,
                         display_key, width, height, caption, date)
        values ('m3', 'upload/m3.jpg', 'm3.jpg', 'image/jpeg', 30, 'originals/m3.jpg', 'thumbs/m3.webp',
                'display/m3.webp', 800, 600, 'Wedding', 'JUN 1923');
      insert into person_media (person_id, media_id, position) select 'I2', id, -1 from media where sha256 = 'm3';`);
    const original = await state();
    expect(original.media).toMatchObject({ display_key: 'display/m3.webp', width: 800, height: 600, caption: 'Wedding', date: 'JUN 1923' });
    expect(original.links).toEqual([{ person_id: 'I2', media_id: original.media.id, position: -1 }]);

    await toggle(id, 'undo');
    expect(await state()).toEqual({ media: null, links: null });

    await toggle(id, 'redo');
    expect(await state()).toEqual(original);
    expect((await record('I2')).photos.map(p => p.id)).toEqual([original.media.id, m1]);
  });
});
