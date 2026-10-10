// @vitest-environment node
// The five photo commands, run through the API's command path (runChange) on the test branch. Their prepare step
// HEADs the uploads, so the db is given a fake headObject: prepared is built from fake HEAD results and no network
// is needed.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { TEST_DATABASE_URL as url, resetTestDatabase } from './testDatabase.js';
import { createDb } from '../../api/db.js';
import { ApiError } from '../../api/http.js';
import { avatarKeyFor } from '../../media/crop.js';

const ED = { email: 'ed@example.test', name: 'Ed Itor', role: 'editor' };

const CONTENT_TYPES = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', pdf: 'application/pdf' };
const STORED_KEY = /^[a-z]+\/([0-9a-f]{64})(?:-[0-9a-f]{12})?\.([a-z]+)$/;
const BYTE_SIZE = 54321;

/**
 * A fake headObject for the commands' prepare step: every key exists unless it is in `missing`. An object reports
 * its extension's content type, BYTE_SIZE, and `dims[sha]` as its size (else 4000 × 3000).
 */
function fakeHead({ missing = [], dims = {} } = {}) {
  return async (key) => {
    if (missing.includes(key)) return { status: 404 };
    const [, sha, ext] = key.match(STORED_KEY);
    const size = dims[sha] ?? { width: 4000, height: 3000 };
    return { status: 200, contentType: CONTENT_TYPES[ext], contentLength: BYTE_SIZE, width: size.width, height: size.height };
  };
}

describe.skipIf(!url)('photo commands (database)', { timeout: 60000 }, () => {
  let client;
  let pool;
  let db;
  const one = async (sql, params) => (await client.query(sql, params)).rows[0];
  const all = async (sql, params) => (await client.query(sql, params)).rows;

  beforeAll(async () => {
    client = await resetTestDatabase();
    pool = new pg.Pool({ connectionString: url, max: 4 });
    db = createDb(pool, { context: { headObject: fakeHead() } });
  }, 60000);

  afterAll(async () => {
    await pool?.end();
    await client?.end();
  });

  let shaCount = 0;
  const newSha = () => createHash('sha256').update(`photo commands ${shaCount++}`).digest('hex');
  const upload = (sha256, ext = 'jpg', fileName = `photo.${ext}`) => ({ sha256, ext, fileName });

  /**
   * Seeds people, media and links in one recorded fixture change, taking person ids from the sequence.
   * people: { key: [given, surname, { other person columns }?] }
   * media:  { key: { ext = 'jpg', caption, date, display, width, height } }; by default an image has a thumbnail
   *         and display image and is 4000 × 3000, and a PDF has none of them. `display: false` is an image not
   *         yet backfilled.
   * links:  [[personKey, mediaKey, position = 0]]
   * Returns { key: id } (media ids as numbers), plus `sha: { mediaKey: sha256 }`.
   */
  async function seed({ people = {}, media = {}, links = [] }) {
    const t = { sha: {} };
    await client.query('begin');
    try {
      await client.query(`select begin_change('fixture@example.test', 'Fixture', 'fixture', 'script', 'Test fixture', '{}', '{}')`);
      for (const [key, [given, surname, extra = {}]] of Object.entries(people)) {
        const columns = { given_name: given, surname, ...extra };
        const names = Object.keys(columns);
        const values = names.map((name) => (name === 'avatar_source' ? JSON.stringify(columns[name]) : columns[name]));
        const { id } = await one(
          `insert into person (id, ${names.join(', ')})
           values ('I' || nextval('person_number_seq'), ${names.map((_, i) => `$${i + 1}`).join(', ')}) returning id`, values);
        t[key] = id;
      }
      for (const [key, spec] of Object.entries(media)) {
        const { ext = 'jpg', caption = null, date = null, display = ext !== 'pdf' } = spec;
        const { width = ext !== 'pdf' ? 4000 : null, height = ext !== 'pdf' ? 3000 : null } = spec;
        const sha = newSha();
        const { id } = await one(
          `insert into media (sha256, original_path, file_name, content_type, byte_size, object_key, thumb_key,
                              display_key, width, height, caption, date)
           values ($1, $2, $3, $4, 1000, $5, $6, $7, $8, $9, $10, $11) returning id`,
          [sha, `Data/Media/${key}.${ext}`, `${key}.${ext}`, CONTENT_TYPES[ext], `originals/${sha}.${ext}`,
            ext !== 'pdf' ? `thumbs/${sha}.webp` : null, display ? `display/${sha}.webp` : null, width, height, caption, date]);
        t[key] = Number(id);
        t.sha[key] = sha;
      }
      for (const [personKey, mediaKey, position = 0] of links) {
        await client.query('insert into person_media (person_id, media_id, position) values ($1, $2, $3)', [t[personKey], t[mediaKey], position]);
      }
      await client.query('select sync_id_sequences()');
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
    return t;
  }

  const run = (kind, params, on = db) => on.runChange(ED, kind, params);
  const withHead = (options) => createDb(pool, { context: { headObject: fakeHead(options) } });

  /** Awaits a command that must fail with an ApiError; returns { status, code, ...extra }. */
  async function failure(promise) {
    try {
      await promise;
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      return { status: error.status, code: error.code, ...error.extra };
    }
    throw new Error('expected the command to fail');
  }

  /** The 400 invalid a command fails with (which must carry a message), writing nothing. */
  async function refused(kind, params) {
    const result = await expectNothingWritten(() => failure(run(kind, params)));
    expect(result).toMatchObject({ status: 400, code: 'invalid', message: expect.any(String) });
    return result;
  }

  const stamp = async (id) => (await one(`select person_view($1) -> 'person' ->> 'updatedAt' as t`, [id])).t;
  const person = (id) => one('select * from person where id = $1', [id]);
  const mediaRow = (id) => one('select * from media where id = $1', [id]);
  const mediaBySha = (sha) => one('select * from media where sha256 = $1', [sha]);
  const mediaCount = async () => (await one('select count(*)::int as n from media')).n;
  const changeCount = async () => (await one('select count(*)::int as n from change')).n;
  const changeRecord = (id) => one('select kind, via, summary, params, person_ids from change where id = $1', [id]);
  /** A person's links as [mediaId, position], in photo order. */
  const linksOf = async (personId) =>
    (await all('select media_id, position from person_media where person_id = $1 order by position, media_id', [personId]))
      .map((row) => [Number(row.media_id), row.position]);
  /** The ids of the people a media row is linked to, sorted. */
  const peopleOf = async (mediaId) =>
    (await all('select person_id from person_media where media_id = $1', [mediaId])).map((row) => row.person_id).sort();

  /** Every row of the tree tables, minus updated_at, which a toggle stamps on the rows it modifies. */
  async function treeState() {
    const strip = (rows) => rows.map(({ updated_at: _ignored, ...rest }) => rest);
    return {
      person: strip(await all('select * from person order by id')),
      family: await all('select * from family order by id'),
      family_child: await all('select * from family_child order by family_id, child_id'),
      media: await all('select * from media order by id'),
      person_media: await all('select * from person_media order by person_id, media_id')
    };
  }

  /**
   * Runs a command, undoes it with toggle_change (the tree must be exactly as before), then redoes it
   * (exactly as the command left it), and returns the command's result.
   */
  async function runUndoRedo(kind, params) {
    const before = await treeState();
    const result = await run(kind, params);
    const after = await treeState();
    expect(after).not.toEqual(before);
    await db.toggle(ED, result.change.id, 'undo', 'history');
    expect(await treeState()).toEqual(before);
    await db.toggle(ED, result.change.id, 'redo', 'history');
    expect(await treeState()).toEqual(after);
    return result;
  }

  /** Asserts that a failed command left nothing behind: no change, and the tree unchanged. */
  async function expectNothingWritten(call) {
    const count = await changeCount();
    const state = await treeState();
    const result = await call();
    expect(await changeCount()).toBe(count);
    expect(await treeState()).toEqual(state);
    return result;
  }

  describe('add_photos', () => {
    it('inserts new uploads tagged with several people, ahead of their photos in batch order; undo and redo', async () => {
      const t = await seed({
        people: { alice: ['Alice', 'Ash'], bob: ['Bob', 'Birch'] },
        media: { old: {} },
        links: [['alice', 'old', 0]]
      });
      const wedding = newSha();
      const letter = newSha();
      const params = {
        personId: t.alice,
        photos: [
          { upload: upload(wedding, 'jpg', ' Wedding.jpg '), caption: ' The wedding ', date: 'JUN 1923', personIds: [t.alice, t.bob] },
          { upload: upload(letter, 'pdf', 'Letter.pdf'), caption: '', personIds: [t.alice] }
        ]
      };
      const { change, view } = await runUndoRedo('add_photos', params);

      expect(change).toEqual({ id: expect.any(Number), summary: 'Added 2 photos for Alice Ash', personIds: [t.alice, t.bob] });
      expect(await changeRecord(change.id)).toEqual({
        kind: 'add_photos', via: 'edit', summary: 'Added 2 photos for Alice Ash', params, person_ids: [t.alice, t.bob]
      });
      const w = await mediaBySha(wedding);
      expect(w).toEqual({
        id: w.id, sha256: wedding, original_path: 'upload/Wedding.jpg', file_name: 'Wedding.jpg', content_type: 'image/jpeg',
        byte_size: String(BYTE_SIZE), object_key: `originals/${wedding}.jpg`, thumb_key: `thumbs/${wedding}.webp`,
        display_key: `display/${wedding}.webp`, width: 4000, height: 3000, caption: 'The wedding', date: 'JUN 1923'
      });
      const l = await mediaBySha(letter);
      expect(l).toEqual({
        id: l.id, sha256: letter, original_path: 'upload/Letter.pdf', file_name: 'Letter.pdf', content_type: 'application/pdf',
        byte_size: String(BYTE_SIZE), object_key: `originals/${letter}.pdf`, thumb_key: null, display_key: null,
        width: null, height: null, caption: null, date: null
      });
      const [wId, lId] = [Number(w.id), Number(l.id)];
      expect(await linksOf(t.alice)).toEqual([[wId, -2], [lId, -1], [t.old, 0]]);
      expect(await linksOf(t.bob)).toEqual([[wId, -1]]);

      expect(view.person.id).toBe(t.alice);
      expect(view.person.photos.map((photo) => photo.id)).toEqual([wId, lId, t.old]);
      expect(view.person.photos[0]).toMatchObject({
        caption: 'The wedding', date: 'JUN 1923', displayKey: `display/${wedding}.webp`,
        people: [{ id: t.alice, name: 'Alice Ash' }, { id: t.bob, name: 'Bob Birch' }]
      });
    });

    it('says "Added a photo" for one', async () => {
      const t = await seed({ people: { alice: ['Alice', 'Ash'] } });
      const { change } = await run('add_photos', { personId: t.alice, photos: [{ upload: upload(newSha()), personIds: [t.alice] }] });
      expect(change).toEqual({ id: expect.any(Number), summary: 'Added a photo for Alice Ash', personIds: [t.alice] });
    });

    it('re-links an existing photo by media id, filling only its null caption and date; undo and redo', async () => {
      const t = await seed({
        people: { alice: ['Alice', 'Ash'], bob: ['Bob', 'Birch'] },
        media: { beach: { caption: 'At the beach' }, own: {} },
        links: [['alice', 'beach', 0], ['bob', 'own', 5]]
      });
      const { change, view } = await runUndoRedo('add_photos', {
        personId: t.bob, photos: [{ mediaId: String(t.beach), caption: 'Not this', date: 'about 1923', personIds: [t.bob] }]
      });
      expect(change.summary).toBe('Added a photo for Bob Birch');
      expect(await mediaRow(t.beach)).toMatchObject({ caption: 'At the beach', date: 'about 1923' });
      expect(await linksOf(t.bob)).toEqual([[t.beach, 4], [t.own, 5]]);
      expect(await linksOf(t.alice)).toEqual([[t.beach, 0]]);
      expect(view.person.photos.map((photo) => photo.id)).toEqual([t.beach, t.own]);
    });

    it('reuses the row of an upload whose file gained one meanwhile, filling only its null fields', async () => {
      const t = await seed({
        people: { alice: ['Alice', 'Ash'], bob: ['Bob', 'Birch'] },
        media: { scan: { date: '1900' } },
        links: [['alice', 'scan']]
      });
      const count = await mediaCount();
      const { change } = await runUndoRedo('add_photos', {
        personId: t.bob, photos: [{ upload: upload(t.sha.scan, 'jpg', 'again.jpg'), caption: 'Scan', date: 'Other', personIds: [t.bob] }]
      });
      expect(change.summary).toBe('Added a photo for Bob Birch');
      expect(await mediaCount()).toBe(count);
      expect(await mediaRow(t.scan)).toMatchObject({ caption: 'Scan', date: '1900', file_name: 'scan.jpg', byte_size: '1000' });
      expect(await peopleOf(t.scan)).toEqual([t.alice, t.bob].sort());
    });

    it('links only the people missing, leaving existing links where they are', async () => {
      const t = await seed({
        people: { alice: ['Alice', 'Ash'], bob: ['Bob', 'Birch'] },
        media: { beach: {}, other: {} },
        links: [['alice', 'beach', 3], ['alice', 'other', 1]]
      });
      const { change } = await runUndoRedo('add_photos', { personId: t.alice, photos: [{ mediaId: t.beach, personIds: [t.alice, t.bob] }] });
      // Nothing new is shown for Alice: her photo is now shown for Bob too.
      expect(change).toEqual({ id: expect.any(Number), summary: 'Edited a photo of Alice Ash', personIds: [t.alice, t.bob] });
      expect(await linksOf(t.alice)).toEqual([[t.other, 1], [t.beach, 3]]);
      expect(await linksOf(t.bob)).toEqual([[t.beach, -1]]);
    });

    it('counts only the photos newly shown for the person', async () => {
      const t = await seed({ people: { alice: ['Alice', 'Ash'] }, media: { beach: {} }, links: [['alice', 'beach']] });
      const { change } = await run('add_photos', {
        personId: t.alice, photos: [{ mediaId: t.beach, personIds: [t.alice] }, { upload: upload(newSha()), personIds: [t.alice] }]
      });
      expect(change.summary).toBe('Added a photo for Alice Ash');
    });

    it('takes an upload and a media id of the same file in one batch as one photo', async () => {
      const t = await seed({
        people: { alice: ['Alice', 'Ash'], bob: ['Bob', 'Birch'], cara: ['Cara', 'Cole'] },
        media: { beach: {} },
        links: [['bob', 'beach']]
      });
      const count = await mediaCount();
      const { change } = await runUndoRedo('add_photos', {
        personId: t.alice,
        photos: [
          { upload: upload(t.sha.beach, 'jpg', 'again.jpg'), caption: 'Beach', personIds: [t.alice] },
          { mediaId: t.beach, personIds: [t.alice, t.cara] }
        ]
      });
      expect(change).toEqual({ id: expect.any(Number), summary: 'Added a photo for Alice Ash', personIds: [t.alice, t.cara] });
      expect(await mediaCount()).toBe(count);
      expect(await mediaRow(t.beach)).toMatchObject({ caption: 'Beach' });
      expect(await linksOf(t.alice)).toEqual([[t.beach, -1]]);
      expect(await linksOf(t.cara)).toEqual([[t.beach, -1]]);
      expect(await peopleOf(t.beach)).toEqual([t.alice, t.bob, t.cara].sort());
    });

    it('is no_change when every link already exists and there is no caption or date', async () => {
      const t = await seed({ people: { alice: ['Alice', 'Ash'] }, media: { beach: {} }, links: [['alice', 'beach']] });
      const result = await expectNothingWritten(() => failure(run('add_photos', {
        personId: t.alice, photos: [{ mediaId: t.beach, caption: '', personIds: [t.alice] }]
      })));
      expect(result).toEqual({ status: 400, code: 'no_change' });
    });

    it('records a caption filled into an existing photo\'s null caption, though every link exists', async () => {
      const t = await seed({ people: { alice: ['Alice', 'Ash'] }, media: { beach: { date: '1923' } }, links: [['alice', 'beach']] });
      const { change } = await runUndoRedo('add_photos', {
        personId: t.alice, photos: [{ mediaId: t.beach, caption: 'New', date: 'Other', personIds: [t.alice] }]
      });
      expect(change).toEqual({ id: expect.any(Number), summary: 'Edited a photo of Alice Ash', personIds: [t.alice] });
      expect(await mediaRow(t.beach)).toMatchObject({ caption: 'New', date: '1923' });
    });

    it('is no_change when every link already exists and the photo already has a caption', async () => {
      const t = await seed({ people: { alice: ['Alice', 'Ash'] }, media: { beach: { caption: 'Old' } }, links: [['alice', 'beach']] });
      const result = await expectNothingWritten(() => failure(run('add_photos', {
        personId: t.alice, photos: [{ mediaId: t.beach, caption: 'New', personIds: [t.alice] }]
      })));
      expect(result).toEqual({ status: 400, code: 'no_change' });
      expect(await mediaRow(t.beach)).toMatchObject({ caption: 'Old' });
    });

    it('stores a null width and height for an image whose original has no size metadata', async () => {
      const t = await seed({ people: { alice: ['Alice', 'Ash'] } });
      const sha = newSha();
      const on = withHead({ dims: { [sha]: { width: null, height: null } } });
      await run('add_photos', { personId: t.alice, photos: [{ upload: upload(sha, 'png'), personIds: [t.alice] }] }, on);
      expect(await mediaBySha(sha)).toMatchObject({ content_type: 'image/png', display_key: `display/${sha}.webp`, width: null, height: null });
    });

    it('refuses an unknown person or media as 404 not_found, writing nothing', async () => {
      const t = await seed({ people: { alice: ['Alice', 'Ash'] }, media: { beach: {} } });
      const notFound = (params) => expectNothingWritten(() => failure(run('add_photos', params)));
      expect(await notFound({ personId: 'I999999', photos: [{ mediaId: t.beach, personIds: ['I999999'] }] }))
        .toEqual({ status: 404, code: 'not_found', field: 'personId', id: 'I999999' });
      expect(await notFound({
        personId: t.alice,
        photos: [{ upload: upload(newSha()), personIds: [t.alice] }, { mediaId: t.beach, personIds: [t.alice, 'I999998'] }]
      })).toEqual({ status: 404, code: 'not_found', field: 'photos.1.personIds', id: 'I999998' });
      expect(await notFound({ personId: t.alice, photos: [{ mediaId: 999999, personIds: [t.alice] }] }))
        .toEqual({ status: 404, code: 'not_found', field: 'photos.0.mediaId', id: 999999 });
    });

    it('refuses the same file twice in one batch as invalid', async () => {
      const t = await seed({ people: { alice: ['Alice', 'Ash'] } });
      const sha = newSha();
      const result = await refused('add_photos', {
        personId: t.alice, photos: [{ upload: upload(sha), personIds: [t.alice] }, { upload: upload(sha, 'jpg', 'copy.jpg'), personIds: [t.alice] }]
      });
      expect(result.field).toBe('photos');
    });

    it('reports a missing upload as missing_upload with the photo\'s index, recording nothing', async () => {
      const t = await seed({ people: { alice: ['Alice', 'Ash'] } });
      const [a, b] = [newSha(), newSha()];
      const on = withHead({ missing: [`originals/${b}.jpg`] });
      const result = await expectNothingWritten(() => failure(run('add_photos', {
        personId: t.alice, photos: [{ upload: upload(a), personIds: [t.alice] }, { upload: upload(b), personIds: [t.alice] }]
      }, on)));
      expect(result).toEqual({ status: 400, code: 'missing_upload', index: 1, field: 'photos' });
    });
  });

  describe('update_photo', () => {
    it('edits the caption and date and re-tags: added links go first, removed ones go; undo and redo', async () => {
      const t = await seed({
        people: { alice: ['Alice', 'Ash'], bob: ['Bob', 'Birch'], cara: ['Cara', 'Cole'] },
        media: { beach: { caption: 'At the beach' }, caras: {} },
        links: [['alice', 'beach', 0], ['bob', 'beach', 0], ['cara', 'caras', 3]]
      });
      const { change, view } = await runUndoRedo('update_photo', {
        mediaId: t.beach, caption: ' On the pier ', date: 'about 1923', personIds: [t.alice, t.cara],
        expected: { caption: 'At the beach', date: null, personIds: [t.bob, t.alice] }, focusId: t.alice
      });
      expect(change).toEqual({ id: expect.any(Number), summary: 'Edited a photo of Alice Ash', personIds: [t.alice, t.cara, t.bob] });
      expect(await mediaRow(t.beach)).toMatchObject({ caption: 'On the pier', date: 'about 1923' });
      expect(await peopleOf(t.beach)).toEqual([t.alice, t.cara].sort());
      expect(await linksOf(t.alice)).toEqual([[t.beach, 0]]);
      expect(await linksOf(t.cara)).toEqual([[t.beach, 2], [t.caras, 3]]);
      expect(await linksOf(t.bob)).toEqual([]);
      expect(view.person.id).toBe(t.alice);
      expect(view.person.photos[0]).toMatchObject({ id: t.beach, caption: 'On the pier', date: 'about 1923' });
    });

    it('clears a caption to null, changing nothing else', async () => {
      const t = await seed({ people: { alice: ['Alice', 'Ash'] }, media: { beach: { caption: 'At the beach', date: '1923' } }, links: [['alice', 'beach']] });
      const { change } = await runUndoRedo('update_photo', {
        mediaId: t.beach, caption: '', date: '1923', personIds: [t.alice], expected: { caption: 'At the beach', date: '1923', personIds: [t.alice] }
      });
      expect(change).toEqual({ id: expect.any(Number), summary: 'Edited a photo of Alice Ash', personIds: [t.alice] });
      expect(await mediaRow(t.beach)).toMatchObject({ caption: null, date: '1923' });
    });

    it('returns the view of focusId even when the edit untags them, so the editor stays on their page', async () => {
      const t = await seed({
        people: { alice: ['Alice', 'Ash'], bob: ['Bob', 'Birch'] },
        media: { beach: {} },
        links: [['alice', 'beach'], ['bob', 'beach']]
      });
      const untagged = await runUndoRedo('update_photo', {
        mediaId: t.beach, caption: null, date: null, personIds: [t.bob],
        expected: { caption: null, date: null, personIds: [t.alice, t.bob] }, focusId: t.alice
      });
      expect(untagged.change).toEqual({ id: expect.any(Number), summary: 'Edited a photo of Alice Ash', personIds: [t.alice, t.bob] });
      expect(untagged.view.person.id).toBe(t.alice);
      expect(untagged.view.person.photos).toEqual([]);
      expect(await peopleOf(t.beach)).toEqual([t.bob]);
    });

    it('focuses on the first of personIds when focusId is not given, or no longer exists', async () => {
      const t = await seed({
        people: { alice: ['Alice', 'Ash'], bob: ['Bob', 'Birch'] },
        media: { beach: {} },
        links: [['alice', 'beach']]
      });
      const captioned = await run('update_photo', {
        mediaId: t.beach, caption: 'Beach', date: null, personIds: [t.bob, t.alice], expected: { caption: '', date: '', personIds: [t.alice] }
      });
      expect(captioned.change).toEqual({ id: expect.any(Number), summary: 'Edited a photo of Bob Birch', personIds: [t.bob, t.alice] });
      expect(captioned.view.person.id).toBe(t.bob);

      const gone = await run('update_photo', {
        mediaId: t.beach, caption: 'Beach', date: null, personIds: [t.alice],
        expected: { caption: 'Beach', date: null, personIds: [t.alice, t.bob] }, focusId: 'I999999'
      });
      expect(gone.change).toEqual({ id: expect.any(Number), summary: 'Edited a photo of Alice Ash', personIds: [t.alice, t.bob] });
      expect(gone.view.person.id).toBe(t.alice);
    });

    it('is stale (409) when the caption, date or people changed since it was read, writing nothing', async () => {
      const t = await seed({
        people: { alice: ['Alice', 'Ash'], bob: ['Bob', 'Birch'] },
        media: { beach: { caption: 'A', date: 'D' } },
        links: [['alice', 'beach']]
      });
      const edit = (expected) => expectNothingWritten(() => failure(run('update_photo', {
        mediaId: t.beach, caption: 'New', date: 'D', personIds: [t.alice], expected
      })));
      for (const expected of [
        { caption: 'B', date: 'D', personIds: [t.alice] },
        { caption: 'A', date: null, personIds: [t.alice] },
        { caption: 'A', date: 'D', personIds: [t.alice, t.bob] },
        { caption: 'A', date: 'D', personIds: [] }
      ]) {
        expect(await edit(expected)).toEqual({ status: 409, code: 'stale', message: expect.stringContaining('Reload') });
      }
    });

    it('is 404 not_found when the photo no longer exists', async () => {
      const t = await seed({ people: { alice: ['Alice', 'Ash'] } });
      const sha = newSha();
      const added = await run('add_photos', { personId: t.alice, photos: [{ upload: upload(sha), personIds: [t.alice] }] });
      const id = Number((await mediaBySha(sha)).id);
      await db.toggle(ED, added.change.id, 'undo', 'history');
      const result = await expectNothingWritten(() => failure(run('update_photo', {
        mediaId: id, caption: 'x', date: null, personIds: [t.alice], expected: { caption: null, date: null, personIds: [t.alice] }
      })));
      expect(result).toEqual({ status: 404, code: 'not_found', field: 'mediaId', id });
    });

    it('is 404 not_found for a person who does not exist', async () => {
      const t = await seed({ people: { alice: ['Alice', 'Ash'] }, media: { beach: {} }, links: [['alice', 'beach']] });
      const result = await expectNothingWritten(() => failure(run('update_photo', {
        mediaId: t.beach, caption: null, date: null, personIds: [t.alice, 'I999999'], expected: { caption: null, date: null, personIds: [t.alice] }
      })));
      expect(result).toEqual({ status: 404, code: 'not_found', field: 'personIds', id: 'I999999' });
    });

    it('is no_change when nothing differs', async () => {
      const t = await seed({ people: { alice: ['Alice', 'Ash'] }, media: { beach: { caption: 'A' } }, links: [['alice', 'beach']] });
      const result = await expectNothingWritten(() => failure(run('update_photo', {
        mediaId: t.beach, caption: ' A ', date: '', personIds: [t.alice], expected: { caption: 'A', date: null, personIds: [t.alice] }
      })));
      expect(result).toEqual({ status: 400, code: 'no_change' });
    });
  });

  describe('remove_photo', () => {
    it('removes one link, keeping the photo for everyone else; undo and redo', async () => {
      const t = await seed({
        people: { alice: ['Alice', 'Ash'], bob: ['Bob', 'Birch'] },
        media: { beach: {}, other: {} },
        links: [['alice', 'beach', 0], ['alice', 'other', 1], ['bob', 'beach', 0]]
      });
      const { change, view } = await runUndoRedo('remove_photo', { personId: t.alice, mediaId: String(t.beach) });
      expect(change).toEqual({ id: expect.any(Number), summary: 'Removed a photo from Alice Ash', personIds: [t.alice] });
      expect(await linksOf(t.alice)).toEqual([[t.other, 1]]);
      expect(await linksOf(t.bob)).toEqual([[t.beach, 0]]);
      expect(view.person.photos.map((photo) => photo.id)).toEqual([t.other]);
    });

    it('keeps the media row when its last link goes', async () => {
      const t = await seed({ people: { alice: ['Alice', 'Ash'] }, media: { letter: { ext: 'pdf' } }, links: [['alice', 'letter']] });
      await runUndoRedo('remove_photo', { personId: t.alice, mediaId: t.letter });
      expect(await mediaRow(t.letter)).toMatchObject({ id: String(t.letter) });
      expect(await peopleOf(t.letter)).toEqual([]);
    });

    it('is stale (409) when the photo is no longer linked to the person', async () => {
      const t = await seed({ people: { alice: ['Alice', 'Ash'] }, media: { beach: {} }, links: [['alice', 'beach']] });
      await run('remove_photo', { personId: t.alice, mediaId: t.beach });
      const result = await expectNothingWritten(() => failure(run('remove_photo', { personId: t.alice, mediaId: t.beach })));
      expect(result).toEqual({ status: 409, code: 'stale', message: expect.stringContaining('Reload') });
    });

    it('is 404 not_found for an unknown person or media', async () => {
      const t = await seed({ people: { alice: ['Alice', 'Ash'] }, media: { beach: {} }, links: [['alice', 'beach']] });
      expect(await expectNothingWritten(() => failure(run('remove_photo', { personId: 'I999999', mediaId: t.beach }))))
        .toEqual({ status: 404, code: 'not_found', field: 'personId', id: 'I999999' });
      expect(await expectNothingWritten(() => failure(run('remove_photo', { personId: t.alice, mediaId: 999999 }))))
        .toEqual({ status: 404, code: 'not_found', field: 'mediaId', id: 999999 });
    });
  });

  describe('set_avatar', () => {
    const CROP = { x: 0.1, y: 0.1, w: 0.3, h: 0.4 }; // 1200 × 1200 px of a 4000 × 3000 photo

    it('with mediaId: sets avatar_key and avatar_source; undo and redo', async () => {
      const t = await seed({
        people: { alice: ['Alice', 'Ash', { avatar_key: 'avatars/legacy.jpg' }] },
        media: { portrait: {} },
        links: [['alice', 'portrait']]
      });
      const avatarKey = avatarKeyFor(t.sha.portrait, CROP);
      const { change, view } = await runUndoRedo('set_avatar', { personId: t.alice, mediaId: t.portrait, crop: CROP, avatarKey });
      expect(change).toEqual({ id: expect.any(Number), summary: 'Changed the avatar of Alice Ash', personIds: [t.alice] });
      expect(await person(t.alice)).toMatchObject({ avatar_key: avatarKey, avatar_source: { mediaId: t.portrait, crop: CROP } });
      expect(view.person).toMatchObject({ id: t.alice, avatarKey, avatarSource: { mediaId: t.portrait, crop: CROP } });
    });

    it('with photo (an upload): adds it to everyone tagged, first, then makes it the avatar; undo and redo', async () => {
      const t = await seed({
        people: { alice: ['Alice', 'Ash'], bob: ['Bob', 'Birch'] },
        media: { old: {} },
        links: [['alice', 'old', 0]]
      });
      const sha = newSha();
      const avatarKey = avatarKeyFor(sha, CROP);
      const { change, view } = await runUndoRedo('set_avatar', {
        personId: t.alice, crop: CROP, avatarKey,
        photo: { upload: upload(sha, 'jpg', 'Portrait.jpg'), caption: 'Portrait', personIds: [t.alice, t.bob] }
      });
      const row = await mediaBySha(sha);
      const id = Number(row.id);
      expect(row).toMatchObject({
        original_path: 'upload/Portrait.jpg', caption: 'Portrait', display_key: `display/${sha}.webp`, width: 4000, height: 3000
      });
      expect(await linksOf(t.alice)).toEqual([[id, -1], [t.old, 0]]);
      expect(await linksOf(t.bob)).toEqual([[id, -1]]);
      expect(await person(t.alice)).toMatchObject({ avatar_key: avatarKey, avatar_source: { mediaId: id, crop: CROP } });
      expect(change).toEqual({ id: expect.any(Number), summary: 'Changed the avatar of Alice Ash', personIds: [t.alice, t.bob] });
      expect(view.person.photos.map((photo) => photo.id)).toEqual([id, t.old]);
      expect(view.person.avatarSource).toEqual({ mediaId: id, crop: CROP });
    });

    it('with photo by media id (a file already uploaded): links it, filling its null caption', async () => {
      const t = await seed({
        people: { alice: ['Alice', 'Ash'], bob: ['Bob', 'Birch'] },
        media: { shared: {} },
        links: [['bob', 'shared']]
      });
      const avatarKey = avatarKeyFor(t.sha.shared, CROP);
      await runUndoRedo('set_avatar', { personId: t.alice, crop: CROP, avatarKey, photo: { mediaId: t.shared, caption: 'Filled', personIds: [t.alice] } });
      expect(await peopleOf(t.shared)).toEqual([t.alice, t.bob].sort());
      expect(await mediaRow(t.shared)).toMatchObject({ caption: 'Filled' });
      expect(await person(t.alice)).toMatchObject({ avatar_key: avatarKey, avatar_source: { mediaId: t.shared, crop: CROP } });
    });

    it('refuses a PDF, a photo not linked to the person, and a photo without a display image, each for its reason', async () => {
      // Each differs from `portrait`, which is accepted, in just one way.
      const t = await seed({
        people: { alice: ['Alice', 'Ash'] },
        media: { portrait: {}, pdf: { ext: 'pdf', display: true, width: 4000, height: 3000 }, unlinked: {}, undisplayed: { display: false } },
        links: [['alice', 'portrait'], ['alice', 'pdf'], ['alice', 'undisplayed']]
      });
      const reason = async (key) => {
        const { field, message } = await refused('set_avatar', { personId: t.alice, mediaId: t[key], crop: CROP, avatarKey: avatarKeyFor(t.sha[key], CROP) });
        return [field, message];
      };
      expect(await reason('pdf')).toEqual(['mediaId', "A PDF can't be an avatar: choose a photo."]);
      expect(await reason('unlinked')).toEqual(['mediaId', "That photo isn't one of Alice Ash's photos."]);
      expect(await reason('undisplayed')).toEqual(['mediaId', "That photo hasn't been prepared for viewing yet, so it can't be an avatar."]);
      const { change } = await run('set_avatar', { personId: t.alice, mediaId: t.portrait, crop: CROP, avatarKey: avatarKeyFor(t.sha.portrait, CROP) });
      expect(change.summary).toBe('Changed the avatar of Alice Ash');
    });

    it('refuses an avatarKey made from another photo or another crop', async () => {
      const t = await seed({
        people: { alice: ['Alice', 'Ash'] },
        media: { portrait: {}, other: {} },
        links: [['alice', 'portrait'], ['alice', 'other']]
      });
      for (const avatarKey of [avatarKeyFor(t.sha.other, CROP), avatarKeyFor(t.sha.portrait, { ...CROP, x: 0.2 })]) {
        const { field, message } = await refused('set_avatar', { personId: t.alice, mediaId: t.portrait, crop: CROP, avatarKey });
        expect([field, message]).toEqual(['avatarKey', "The avatar wasn't made from this photo and crop. Make it again."]);
      }
    });

    it('is no_change when the same crop of the same photo is saved again', async () => {
      const t = await seed({ people: { alice: ['Alice', 'Ash'] }, media: { portrait: {} }, links: [['alice', 'portrait']] });
      const params = { personId: t.alice, mediaId: t.portrait, crop: CROP, avatarKey: avatarKeyFor(t.sha.portrait, CROP) };
      await run('set_avatar', params);
      expect(await expectNothingWritten(() => failure(run('set_avatar', { ...params, crop: { ...CROP, x: 0.10001 } }))))
        .toEqual({ status: 400, code: 'no_change' });
    });

    it('refuses a crop that is not square, or too small, in the photo\'s pixels; unknown sizes are not checked', async () => {
      const t = await seed({
        people: { alice: ['Alice', 'Ash'] },
        media: { portrait: {}, unsized: { width: null, height: null } },
        links: [['alice', 'portrait'], ['alice', 'unsized']]
      });
      const set = (mediaId, crop) => run('set_avatar', { personId: t.alice, mediaId, crop, avatarKey: avatarKeyFor(t.sha[mediaId === t.portrait ? 'portrait' : 'unsized'], crop) });
      const wide = { x: 0, y: 0, w: 0.3, h: 0.3 }; // 1200 × 900 px
      const tiny = { x: 0, y: 0, w: 0.006, h: 0.008 }; // 24 × 24 px
      for (const crop of [wide, tiny]) {
        const result = await expectNothingWritten(() => failure(set(t.portrait, crop)));
        expect(result).toMatchObject({ status: 400, code: 'invalid', field: 'crop', message: expect.any(String) });
      }
      const { change } = await set(t.unsized, wide);
      expect(change.summary).toBe('Changed the avatar of Alice Ash');
    });

    it('is 404 not_found for an unknown person or media', async () => {
      const t = await seed({ people: { alice: ['Alice', 'Ash'] }, media: { portrait: {} }, links: [['alice', 'portrait']] });
      const avatarKey = avatarKeyFor(t.sha.portrait, CROP);
      expect(await expectNothingWritten(() => failure(run('set_avatar', { personId: 'I999999', mediaId: t.portrait, crop: CROP, avatarKey }))))
        .toEqual({ status: 404, code: 'not_found', field: 'personId', id: 'I999999' });
      expect(await expectNothingWritten(() => failure(run('set_avatar', { personId: t.alice, mediaId: 999999, crop: CROP, avatarKey }))))
        .toEqual({ status: 404, code: 'not_found', field: 'mediaId', id: 999999 });
    });

    it('reports a missing avatar as missing_upload for avatarKey, recording nothing', async () => {
      const t = await seed({ people: { alice: ['Alice', 'Ash'] }, media: { portrait: {} }, links: [['alice', 'portrait']] });
      const avatarKey = avatarKeyFor(t.sha.portrait, CROP);
      const on = withHead({ missing: [avatarKey] });
      const result = await expectNothingWritten(() => failure(run('set_avatar', { personId: t.alice, mediaId: t.portrait, crop: CROP, avatarKey }, on)));
      expect(result).toEqual({ status: 400, code: 'missing_upload', field: 'avatarKey' });
    });
  });

  describe('clear_avatar', () => {
    it('clears avatar_key and avatar_source; undo and redo', async () => {
      const source = { mediaId: 1, crop: { x: 0, y: 0, w: 0.5, h: 0.5 } };
      const t = await seed({ people: { bert: ['Bert', 'Jones', { avatar_key: `avatars/${'e'.repeat(64)}-0123456789ab.webp`, avatar_source: source }] } });
      const { change, view } = await runUndoRedo('clear_avatar', { personId: t.bert });
      expect(change).toEqual({ id: expect.any(Number), summary: 'Removed the avatar of Bert Jones', personIds: [t.bert] });
      expect(await person(t.bert)).toMatchObject({ avatar_key: null, avatar_source: null });
      expect(view.person.avatarKey).toBeNull();
      expect('avatarSource' in view.person).toBe(false);
    });

    it('clears a legacy avatar, which has no source', async () => {
      const t = await seed({ people: { bert: ['Bert', 'Jones', { avatar_key: 'avatars/legacy.jpg' }] } });
      await runUndoRedo('clear_avatar', { personId: t.bert });
      expect(await person(t.bert)).toMatchObject({ avatar_key: null, avatar_source: null });
    });

    it('is no_change without an avatar, and 404 not_found for an unknown person', async () => {
      const t = await seed({ people: { bert: ['Bert', 'Jones'] } });
      expect(await expectNothingWritten(() => failure(run('clear_avatar', { personId: t.bert })))).toEqual({ status: 400, code: 'no_change' });
      expect(await expectNothingWritten(() => failure(run('clear_avatar', { personId: 'I999999' }))))
        .toEqual({ status: 404, code: 'not_found', field: 'personId', id: 'I999999' });
    });
  });

  it('set_avatar and clear_avatar leave person.updated_at alone, so an open person editor stays fresh', async () => {
    const t = await seed({ people: { alice: ['Alice', 'Ash'] }, media: { portrait: {} }, links: [['alice', 'portrait']] });
    const crop = { x: 0.1, y: 0.1, w: 0.3, h: 0.4 };
    const seen = await stamp(t.alice);
    await run('set_avatar', { personId: t.alice, mediaId: t.portrait, crop, avatarKey: avatarKeyFor(t.sha.portrait, crop) });
    expect(await stamp(t.alice)).toBe(seen);
    const sha = newSha();
    await run('set_avatar', { personId: t.alice, photo: { upload: upload(sha), personIds: [t.alice] }, crop, avatarKey: avatarKeyFor(sha, crop) });
    expect(await stamp(t.alice)).toBe(seen);
    await run('clear_avatar', { personId: t.alice });
    expect(await stamp(t.alice)).toBe(seen);
    const { change } = await run('update_person', { id: t.alice, expectedUpdatedAt: seen, fields: { birth_place: 'Leeds' } });
    expect(change.summary).toBe('Edited Alice Ash (birth place)');
  });

  describe('undo and redo conflicts', () => {
    it('undo of add_photos is blocked by a later update_photo of its caption, naming that change', async () => {
      const t = await seed({ people: { alice: ['Alice', 'Ash'] } });
      const sha = newSha();
      const added = await run('add_photos', { personId: t.alice, photos: [{ upload: upload(sha), caption: 'Old', personIds: [t.alice] }] });
      const id = Number((await mediaBySha(sha)).id);
      const edited = await run('update_photo', {
        mediaId: id, caption: 'New', date: null, personIds: [t.alice], expected: { caption: 'Old', date: null, personIds: [t.alice] }
      });
      const state = await treeState();
      const conflict = await failure(db.toggle(ED, added.change.id, 'undo', 'history'));
      expect(conflict).toMatchObject({ status: 409, code: 'conflict', reason: 'precondition' });
      expect(conflict.blocking).toEqual([
        { id: edited.change.id, action: 'revert', summary: 'Edited a photo of Alice Ash', authorName: ED.name, createdAt: expect.any(String) }
      ]);
      expect(await treeState()).toEqual(state);
    });

    it('redo of an undone add_photos after the same file was added again is a 409 constraint conflict, not a 500', async () => {
      const t = await seed({ people: { alice: ['Alice', 'Ash'], bob: ['Bob', 'Birch'] } });
      const sha = newSha();
      const first = await run('add_photos', { personId: t.alice, photos: [{ upload: upload(sha), personIds: [t.alice] }] });
      await db.toggle(ED, first.change.id, 'undo', 'history');
      await run('add_photos', { personId: t.bob, photos: [{ upload: upload(sha), personIds: [t.bob] }] });
      const state = await treeState();
      expect(await failure(db.toggle(ED, first.change.id, 'redo', 'history')))
        .toEqual({ status: 409, code: 'conflict', reason: 'constraint', blocking: [] });
      expect(await treeState()).toEqual(state);
    });
  });
});
