# Photos Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Editors can upload photos and PDFs from a phone or computer, caption and tag them, and crop any photo into a person's avatar. Every action is recorded and undoable. Viewers get fast 2000px display images, and uploads have their location data stripped.

**Architecture:**
- **Uploads:** the browser uploads straight to object storage with a presigned PUT.
- **`media` Function** (new, with sharp):
  - checks each upload;
  - strips location data;
  - writes the original, a display image and a thumbnail;
  - renders avatar crops.
- **`api` Function:** records everything in the tree through five new commands. Each one is recorded by 006's change log, so every action is undoable with no new SQL in 006.
- **Database:** migration 008 adds columns and redefines `person_record`.
- **Front end:** new lazy-loaded editing modules for the upload queue, the Add photos sheet, the avatar cropper (Cropper.js 1.7) and photo editing. The viewer and details panel gain display images, captions, tags and the editor controls.

**Tech Stack:** Postgres 18, Node 24 Neon Functions, sharp 0.33.5, `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner`, `@neon/functions` triggers, Vite and vanilla JS, Cropper.js 1.7, and Vitest (jsdom and node).

**Spec:** `specs/2026-10-09-photos-design.md`, revision 3 or later. Read it before every task: it is the source of truth for behaviour. This plan gives the order, the interfaces, and code for the subtle parts.

## Ground rules for every task

- **Work only in the worktree** `/Users/rob/src/ged_eye/.claude/worktrees/photos` (git branch `photos`, from `main` at `61b626f`).
  - Its `.neon` points at the Neon branch **`photos`** (`br-solitary-darkness-b2jjfmob`, a child of `editing`), and its `.env.local` holds `photos`'s credentials.
  - **Never run anything against production** before Task 18. Never edit `/Users/rob/src/ged_eye/.neon` or other worktrees.
- **DB tests** run on the Neon branch **`test-editing`** via `.env.test.local` (`DATABASE_URL_TEST`), with `npm run test:db`. Each run resets that branch's schema.
  - Never run two `test:db` runs at once.
  - `npm run test:db` loads `.env.local` (the `photos` branch) only so `testDatabase.js` can refuse to run against it.
  - It always runs the whole `tests/db` suite, even when given a file. That's fine.
- **Conventions:**
  - ESM, 2-space indent, semicolons, single quotes.
  - Node-side tests start with `// @vitest-environment node`.
  - Run tests with `npx vitest run <path>`.
  - Escape every interpolated string with `escapeHtml` from `src/html.js`, or set it with `textContent`.
  - Follow the existing comment style: a short JSDoc on each export saying what it returns and throws.
- **Commits:** end every message with a blank line, then `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
  - Stage only the task's files.
  - Never stage `.env*` (except the committed `.env.development` and `.env.production`), `.neon`, `.neon-import`, `skills-lock.json`, or `docs/`. `docs/` is the build output, rebuilt only in Task 18.
- **Migrations** are append-only and checksummed. Never edit 001–007. All new SQL goes in `008_photos.sql`.
- **Tree writes:** after 006, every write to `person`, `family`, `family_child`, `media` and `person_media` must be inside `begin_change(...)`. Scripts use `via = 'script'`.
- **Secrets:**
  - Never print `.env.local`, `.env.test.local` or `.env.dev-accounts.local`.
  - Scripts load them with `node --env-file=…`.
  - Presigned URLs are never logged.
- **The spike code** (`media/index.js`, as committed with the spike, plus the `media` entry in `neon.ts`) is replaced in Task 4. Don't build on it.

---

## Chunk 1: Database

### Task 1: Migration 008

**Files:** Create `db/migrations/008_photos.sql`. Tests: `tests/db/photosSchema.test.js` (new). Also modify `tests/db/personView.test.js`, whose photo expectations gain the new fields.

- [ ] **Step 1: Write the failing DB test `tests/db/photosSchema.test.js`.**
  - Use `resetTestDatabase()` and seed with `withChange`, following `tests/db/editingSchema.test.js`.
  - Seed people `I1` (Alice) and `I2` (Bert), and media `m1` and `m2`.
  - Link `m1` to both people (positions 0 and 0) and `m2` to `I1` only, at position 0. That gives a position tie, broken by `media_id`.
  - Assert:
    - `person_record('I1')->'photos'` has 2 entries ordered by `(position, media_id)`.
    - Each entry has exactly the keys `id, key, thumbKey, displayKey, fileName, contentType, caption, date, width, height, people`. Unknown values are `null`, not missing.
    - `m1`'s `people` is `[{id:'I1',name:'Alice …'},{id:'I2',name:'Bert …'}]`, ordered by `display_name`, then `id`.
    - `avatarSource` is absent while `avatar_source` is null. After `update person set avatar_source = '{"mediaId":1,"crop":{"x":0.1,"y":0.1,"w":0.5,"h":0.5}}'` (inside `withChange`), it equals that object.
    - **Change log:** an update of `media.caption` inside `begin_change` records a `change_row` with `caption` in `before`/`after`.
    - **Undo:** `toggle_change(<that change>, 'undo', …)` restores the old caption. This proves 006 needs no change.
    - **Undo of an insert:** a recorded insert of a `media` row plus its `person_media` link undoes cleanly and redoes with the same `id`. That exercises 006's `overriding system value`.
- [ ] **Step 2: Run it and check it fails.** Run `npm run test:db -- tests/db/photosSchema.test.js`. Expect a failure such as `column "display_key" does not exist`.
- [ ] **Step 3: Write `db/migrations/008_photos.sql`.**
  - Copy 007's `create or replace function person_record` **verbatim**.
  - Change only the `'photos'` expression and the trailing `jsonb_strip_nulls` block, as shown below.
  - Keep the header comment style of 007.

  ```sql
  -- 008: photos. media gains a display image, its oriented size, a caption and a free-text date;
  -- person gains avatar_source ({"mediaId", "crop"}: which photo and crop made the avatar). 006's
  -- capture trigger and toggle_change read columns from the catalogue, so the new columns are recorded
  -- and undoable with no change there. person_record is 007's, copied verbatim, except for 'photos'
  -- (every field always present, plus the people tagged in each photo, ordered by position then id)
  -- and 'avatarSource' (omitted when null).
  alter table media
    add column display_key text,
    add column width   int,
    add column height  int,
    add column caption text,
    add column date    text;
  alter table person add column avatar_source jsonb;
  -- person_record's 'people' and verify.js look links up by media.
  create index person_media_media_idx on person_media (media_id);

  create or replace function person_record(p_id text) returns jsonb
  language sql stable as $$
    -- … 007 verbatim, with 'photos' replaced by:
        'photos', coalesce((
          select jsonb_agg(jsonb_build_object(
                   'id', m.id, 'key', m.object_key, 'thumbKey', m.thumb_key, 'displayKey', m.display_key,
                   'fileName', m.file_name, 'contentType', m.content_type,
                   'caption', m.caption, 'date', m.date, 'width', m.width, 'height', m.height,
                   'people', coalesce((
                     select jsonb_agg(jsonb_build_object('id', q.id, 'name', q.display_name)
                                      order by q.display_name, q.id)
                     from person_media pq join person q on q.id = pq.person_id
                     where pq.media_id = m.id), '[]'::jsonb))
                 order by pm.position, pm.media_id)
          from person_media pm
          join media m on m.id = pm.media_id
          where pm.person_id = p.id
        ), '[]'::jsonb),
    -- … and 'avatarSource', p.avatar_source added inside the existing jsonb_strip_nulls(jsonb_build_object(…)) block.
  $$;
  ```

  `jsonb_strip_nulls` is recursive, but `avatar_source` never contains nulls, so adding it there is safe.
- [ ] **Step 4: Update the existing view test.** `tests/db/personView.test.js` expects the old photo shape (`{key, thumbKey, fileName, contentType}`). Update those expectations to the new shape. Don't touch anything else in it.
- [ ] **Step 5: Run both DB test files, then the whole DB suite.**
  - `npm run test:db -- tests/db/photosSchema.test.js tests/db/personView.test.js`: expect PASS.
  - `npm run test:db`: expect every DB test to pass, including `toggleChange` and `commands`.
- [ ] **Step 6: Apply 008 to the `photos` branch.** Run `npm run db:migrate`, whose `.env.local` is `photos`. Then check it applied:

  ```sql
  select filename from schema_migrations order by 1 desc limit 1
  ```

  Expect `008_photos.sql`.
- [ ] **Step 7: Commit** `db/migrations/008_photos.sql`, `tests/db/photosSchema.test.js` and `tests/db/personView.test.js` with the message "Migration 008: photo captions, display images, avatar source".

---

## Chunk 2: The `media` Function

### Task 2: Shared types, file names and crops

**Files:**
- Create `media/types.js` and `media/crop.js`.
- Tests: `tests/mediaTypesUpload.test.js` and `tests/mediaCrop.test.js` (node environment).

- [ ] **Step 1: Write the failing tests.** They cover the exports below.

  `media/types.js`:

  ```js
  export const MAX_UPLOAD_BYTES = 52_428_800;
  /** The accepted types, by the extension stored in originals/<sha>.<ext>. */
  export const TYPES = new Map([
    ['jpg', { ext: 'jpg', contentType: 'image/jpeg', image: true }],
    ['png', { ext: 'png', contentType: 'image/png', image: true }],
    ['webp', { ext: 'webp', contentType: 'image/webp', image: true }],
    ['gif', { ext: 'gif', contentType: 'image/gif', image: true }],
    ['tif', { ext: 'tif', contentType: 'image/tiff', image: true }],
    ['avif', { ext: 'avif', contentType: 'image/avif', image: true }],
    ['pdf', { ext: 'pdf', contentType: 'application/pdf', image: false }]
  ]);
  /** The type of `bytes` from its magic numbers: a TYPES entry, 'heic', or null. */
  export function sniff(bytes) { … }
  /** What /uploads may be told: one of TYPES' content types, 'image/jpg', or '' (unknown). → the type to sign, or throws code. */
  export function declaredType(contentType) { … }  // '' → 'application/octet-stream'; image/heic|image/heif → throws 'heic_unsupported'; else 'unsupported_type'
  /** A file name as stored: trimmed, 1–255 characters, no / \ or control characters, no unpaired surrogate. → the name, or null. */
  export function cleanFileName(value) { … }
  /** `inline; filename*=UTF-8''<percent-encoded name>` (RFC 5987). */
  export function inlineDisposition(fileName) { … }
  export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  export const SHA256 = /^[0-9a-f]{64}$/;
  ```

  `sniff` rules:
  - JPEG starts `FF D8 FF`.
  - PNG starts `89 50 4E 47 0D 0A 1A 0A`.
  - GIF starts `GIF87a` or `GIF89a`.
  - WebP is `RIFF` at 0 and `WEBP` at 8.
  - TIFF starts `II*\0` or `MM\0*`.
  - PDF starts `%PDF-`.
  - **ISO-BMFF** (`ftyp` at bytes 4–8):
    - Read the major brand and the compatible brands inside the `ftyp` box; its size is the big-endian u32 at 0.
    - If any brand is `avif` or `avis`, it is AVIF.
    - Otherwise, if any brand is `heic`, `heix`, `hevc`, `hevx`, `heim`, `heis`, `mif1` or `msf1`, it returns `'heic'`.
  - Anything else is null.

  The tests build byte arrays by hand for each case, including an AVIF whose major brand is `mif1` but whose compatible brands include `avif`, and a 3-byte input. They also cover:
  - `cleanFileName` with `''`, `'   '`, `'a/b.jpg'`, `'a\u0000.jpg'`, 256 characters, and an emoji name;
  - `inlineDisposition("Ian's photo.jpg")`.

  `media/crop.js`:

  ```js
  import { createHash } from 'node:crypto';
  /** Thrown for an invalid crop; `field` is 'crop' or 'crop.<x|y|w|h>'. */
  export class CropError extends Error { constructor(field, message) { super(message); this.field = field; } }
  const round4 = (n) => Math.round(n * 10_000) / 10_000;
  /** { x, y, w, h } as finite fractions: 0 ≤ x, y; w, h > 0; x + w ≤ 1.0001; y + h ≤ 1.0001. → rounded to 4 dp. */
  export function validateCrop(crop) { … }
  /** The square crop in pixels of a width × height oriented image: side = round(min(w·W, h·H)); throws unless
   *  w·W and h·H differ by at most 1% and side ≥ 32. → { left, top, size }, clamped inside the image. */
  export function cropPixels(crop, width, height) { … }
  /** avatars/<sha>-<first 12 hex of sha256("x,y,w,h" with 4 dp each)>.webp */
  export function avatarKeyFor(sha256, crop) {
    const c = validateCrop(crop);
    const digest = createHash('sha256').update([c.x, c.y, c.w, c.h].map((n) => n.toFixed(4)).join(',')).digest('hex');
    return `avatars/${sha256}-${digest.slice(0, 12)}.webp`;
  }
  ```

  The crop tests cover:
  - every invalid shape: missing key, NaN, Infinity, negative, zero width, overflow beyond 1.0001, and a string;
  - rounding;
  - `cropPixels` on 4000×3000 with `{x:0.25,y:0,w:0.75,h:1}`, giving size 3000;
  - a non-square crop (more than 1% off) being refused;
  - a 20px crop being refused;
  - `avatarKeyFor` being deterministic and changing with any field.
- [ ] **Step 2: Run them and check they fail.** Run `npx vitest run tests/mediaTypesUpload.test.js tests/mediaCrop.test.js`. Expect a failure because the module can't be found.
- [ ] **Step 3: Implement both modules** so the tests pass. They must have no dependencies outside `node:crypto`, because the `api` Function imports them too.
- [ ] **Step 4: Run the tests** and expect PASS.
- [ ] **Step 5: Commit** with the message "media: shared types, file names and crop maths".

### Task 3: Imaging

**Files:**
- Create `media/imaging.js` and `media/jobQueue.js`.
- Tests: `tests/mediaImaging.test.js` and `tests/mediaJobQueue.test.js` (node environment).

- [ ] **Step 1: Write the failing tests.** Fixtures are generated in the test with sharp; nothing is committed.

  ```js
  const red = () => sharp({ create: { width: 400, height: 200, channels: 3, background: '#c33' } });
  const gpsJpeg = await red().jpeg().withMetadata({ orientation: 6 })
    .withExif({ IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '51/1 30/1 0/1' } }).toBuffer();
  const plainJpeg = await red().jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const gpsTiff = await red().tiff().withExif({ IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '51/1 30/1 0/1' } }).toBuffer();
  const pdf = Buffer.from('%PDF-1.4\n…minimal…');
  ```

  Assert:
  - `inspect(buffer)` returns `{ sha256, type }`:
    - an empty buffer throws `ImagingError('empty')`;
    - a buffer over `MAX_UPLOAD_BYTES` throws `ImagingError('too_large', 413)`, using a fake length object, not a real 50 MB buffer;
    - a HEIC `ftyp` header throws `'heic_unsupported'`;
    - random bytes throw `'unsupported_type'`;
    - a PDF named `x.jpg` still sniffs as PDF.
  - `processFile(gpsJpeg)`:
    - `original.reencoded === true`;
    - `metadata(original.body)` has no `exif`, and its size is 200×400;
    - `width === 200` and `height === 400`;
    - `display` is WebP of 200×400;
    - `thumb` is WebP with its long edge at most 320.
  - `processFile(plainJpeg)`: `original.reencoded === false`, `original.body` equals the input byte for byte, and `width === 200` and `height === 400` (orientation 6 swaps them).
  - **TIFF with GPS:** run `processFile(gpsTiff)` and assert `reencoded === true`.
    - **If the TIFF's GPS isn't visible** in `metadata().exif`, `hasLocation` alone can't pass this test. Then set `export const ALWAYS_REENCODE_TIFF = true` in `imaging.js` (re-encode every TIFF), say so in a comment, and keep the test.
  - **A two-page TIFF keeps both pages after a re-encode.**
    - Build it by hand with the helper below.
    - Call `reencodeWithoutMetadata(buffer, TYPES.get('tif'), await sharp(buffer).metadata())`, exported for this test.
    - Assert `(await sharp(out, { pages: -1 }).metadata()).pages === 2`.

    ```js
    /** A minimal uncompressed 8-bit greyscale TIFF, one page per { width, height }. */
    function multiPageTiff(pages) {
      const entries = 9;
      const ifdSize = 2 + entries * 12 + 4;
      let size = 8;
      const layout = pages.map(({ width, height }) => {
        const ifd = size;
        const data = ifd + ifdSize;
        size = data + width * height;
        return { width, height, ifd, data };
      });
      const b = Buffer.alloc(size);
      b.write('II', 0, 'latin1');
      b.writeUInt16LE(42, 2);
      b.writeUInt32LE(layout[0].ifd, 4);
      layout.forEach(({ width, height, ifd, data }, i) => {
        const tags = [[256, 3, width], [257, 3, height], [258, 3, 8], [259, 3, 1], [262, 3, 1],
          [273, 4, data], [277, 3, 1], [278, 3, height], [279, 4, width * height]];
        b.writeUInt16LE(entries, ifd);
        tags.forEach(([tag, type, value], j) => {
          const o = ifd + 2 + j * 12;
          b.writeUInt16LE(tag, o);
          b.writeUInt16LE(type, o + 2);
          b.writeUInt32LE(1, o + 4);
          if (type === 3) b.writeUInt16LE(value, o + 8); else b.writeUInt32LE(value, o + 8);
        });
        b.writeUInt32LE(layout[i + 1]?.ifd ?? 0, ifd + 2 + entries * 12);
        b.fill(i === 0 ? 64 : 192, data, data + width * height);
      });
      return b;
    }
    // multiPageTiff([{ width: 40, height: 30 }, { width: 40, height: 30 }])
    ```

  - **Unreadable files:**
    - A JPEG header followed by garbage, passed to `processFile`, gives `ImagingError('unreadable')`, which is permanent.
    - `reencodeWithoutMetadata(mixedTiff, TYPES.get('tif'), await sharp(mixedTiff).metadata())`, where `mixedTiff` is `multiPageTiff([{ width: 40, height: 30 }, { width: 20, height: 10 }])`, also gives `unreadable`. So the mapping to `unreadable` lives inside `reencodeWithoutMetadata` too, and its `limitInputPixels` defaults to `LIMIT_PIXELS`.
  - An animated GIF (`sharp({ create … }).gif()` with `pages` if supported; else skip) with no XMP is stored unchanged.
  - PDF: `display === null`, `thumb === null`, `width === null`, and `original.body` equals the input.
  - `renderAvatar(plainJpeg, { x: 0, y: 0.25, w: 1, h: 0.5 })` gives a 400×400 WebP with no EXIF. The oriented image is 200×400, so `w·W = 200` and `h·H = 200`, which is square.
  - **Pixel limit:** `limitInputPixels` is honoured; a 100,000,001-pixel header gives `ImagingError('too_many_pixels')`. Use `sharp({ create: { width: 10001, height: 10000, … } }).png({ compressionLevel: 0 })` only if it is fast enough; otherwise call `processFile` with `{ limitInputPixels: 1000 }` (an injectable option) on a 100×100 image.

  `jobQueue` tests:
  - `run` executes jobs one at a time, in order.
  - A rejected job doesn't stop the next one.
  - When `maxWaiting` (4) jobs are already waiting, `run` throws `BusyError` without queueing. That matches the spec: 4 waiting means the next request is refused.
- [ ] **Step 2: Run them and check they fail.**
- [ ] **Step 3: Implement `media/jobQueue.js`.**

  ```js
  /** Thrown when too many jobs are already waiting; the handler answers 503 busy. */
  export class BusyError extends Error {}
  /** One job at a time, so a large image's memory never stacks (spec "Memory rules"). → { run(job) → job's result } */
  export function createJobQueue({ maxWaiting = 4 } = {}) {
    let tail = Promise.resolve();
    let waiting = 0;
    return {
      run(job) {
        if (waiting >= maxWaiting) throw new BusyError('busy');
        waiting++;
        const result = tail.then(() => { waiting--; return job(); });
        tail = result.catch(() => {});
        return result;
      }
    };
  }
  ```

  The running job doesn't count as waiting, because `waiting--` happens as it starts.
- [ ] **Step 4: Implement `media/imaging.js`.** It has no S3 and no HTTP: everything takes buffers.

  ```js
  import sharp from 'sharp';
  import { createHash } from 'node:crypto';
  import { MAX_UPLOAD_BYTES, sniff } from './types.js';
  import { cropPixels, validateCrop } from './crop.js';

  sharp.cache(false);
  sharp.concurrency(2);

  export const LIMIT_PIXELS = 100_000_000;
  export const DISPLAY_SIZE = 2000;
  export const THUMB_SIZE = 320;
  export const AVATAR_SIZE = 400;

  /** A file we refuse. `status` 400 (413 for too_large); `permanent` means re-trying the same bytes can't help. */
  export class ImagingError extends Error {
    constructor(code, status = 400) { super(code); this.code = code; this.status = status; this.permanent = true; }
  }

  export const sha256Hex = (buffer) => createHash('sha256').update(buffer).digest('hex');

  /** Does sharp's metadata().exif (with or without its "Exif\0\0" prefix) have a GPSInfo pointer (0x8825) in IFD0? */
  export function hasGps(exif) {
    try {
      if (!exif || exif.length < 8) return false;
      let b = exif;
      if (b.subarray(0, 6).toString('latin1') === 'Exif\0\0') b = b.subarray(6);
      const order = b.subarray(0, 2).toString('latin1');
      if (order !== 'II' && order !== 'MM') return false;
      const le = order === 'II';
      const u16 = (o) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o));
      const u32 = (o) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
      const ifd0 = u32(4);
      const count = u16(ifd0);
      for (let i = 0; i < count; i++) if (u16(ifd0 + 2 + i * 12) === 0x8825) return true;
      return false;
    } catch {
      return false; // a truncated block (RangeError) has no readable GPS pointer
    }
  }

  export const hasLocation = (meta) => hasGps(meta.exif) || Boolean(meta.xmp && meta.xmp.toString('latin1').includes('GPSLatitude'));

  /** Size and type checks plus the sha, without decoding. → { sha256, type } */
  export function inspect(buffer) {
    if (buffer.length === 0) throw new ImagingError('empty');
    if (buffer.length > MAX_UPLOAD_BYTES) throw new ImagingError('too_large', 413);
    const type = sniff(buffer);
    if (type === 'heic') throw new ImagingError('heic_unsupported');
    if (!type) throw new ImagingError('unsupported_type');
    return { sha256: sha256Hex(buffer), type };
  }

  /** → { sha256, type, original: { body, reencoded }, display, thumb, width, height } (display/thumb/width/height null for PDFs). */
  export async function processFile(buffer, { limitInputPixels = LIMIT_PIXELS } = {}) {
    const { sha256, type } = inspect(buffer);
    if (!type.image) return { sha256, type, original: { body: buffer, reencoded: false }, display: null, thumb: null, width: null, height: null };
    const meta = await readMetadata(buffer, limitInputPixels);  // maps sharp's pixel-limit error to ImagingError('too_many_pixels')
    const swap = (meta.orientation ?? 1) >= 5;
    const width = swap ? meta.height : meta.width;
    const height = swap ? meta.width : meta.height;
    const reencode = hasLocation(meta) || (type.ext === 'tif' && ALWAYS_REENCODE_TIFF);
    const original = reencode ? { body: await reencodeWithoutMetadata(buffer, type, meta, limitInputPixels), reencoded: true } : { body: buffer, reencoded: false };
    const display = await sharp(buffer, { limitInputPixels }).rotate()
      .resize(DISPLAY_SIZE, DISPLAY_SIZE, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
    const thumb = await sharp(display).resize(THUMB_SIZE, THUMB_SIZE, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 75 }).toBuffer();
    return { sha256, type, original, display, thumb, width, height };
  }
  ```

  - **Unreadable input:** any sharp decode error, other than the pixel limit, becomes `ImagingError('unreadable')` (permanent, 400). This includes a re-encode that fails, such as a multi-page TIFF whose pages differ in size. So Retry is never offered for a file that can never succeed.
  - **`reencodeWithoutMetadata(buffer, type, meta, limitInputPixels)`** (exported for tests; `processFile` calls it) re-encodes in the same format, keeping the ICC profile and no other metadata:
    - **jpg:** `.rotate().keepIccProfile().jpeg({ quality: 92 })`
    - **webp:** `.rotate().keepIccProfile().webp({ quality: 92 })`
    - **png:** `.rotate().keepIccProfile().png()`
    - **avif:** `.rotate().keepIccProfile().avif({ quality: 70 })`
    - **tif:** `sharp(buffer, { pages: -1 }).keepIccProfile().tiff({ compression: 'lzw' })`. Add `.rotate()` only when `meta.orientation > 1`, and then without `pages: -1`.
    - **gif:** `sharp(buffer, { animated: true }).gif()`, with no rotate.
  - **`derivatives(buffer)`** is for the backfill. It returns `{ display, thumb, width, height }`, using the same display and thumbnail code, with no type checks beyond sharp being able to read the file.
  - **`renderAvatar(buffer, crop)`:** validate the crop, then:
    1. Read the metadata.
    2. Work out the oriented width and height.
    3. `const { left, top, size } = cropPixels(crop, width, height)`.
    4. `sharp(buffer, { limitInputPixels }).rotate().extract({ left, top, width: size, height: size }).resize(AVATAR_SIZE, AVATAR_SIZE).webp({ quality: 85 }).toBuffer()`.

    `CropError` passes through. The handler maps it to `400 invalid`.
- [ ] **Step 5: Run the tests** and expect PASS.
- [ ] **Step 6: Commit** with the message "media: imaging (location stripping, display and thumbnail, avatars) and job queue".

### Task 4: Storage adapter and handler

**Files:**
- Create `media/storage.js`, `media/db.js`, `media/handler.js`, and `media/index.js` (replacing the spike).
- Modify `neon.ts`, `package.json` and `package-lock.json`.
- Test: `tests/mediaHandler.test.js` (node environment).

- [ ] **Step 1: Dependencies.** Move `@aws-sdk/client-s3` from `devDependencies` to `dependencies`, and keep `@aws-sdk/s3-request-presigner` (added during the spike) in `dependencies`. Run `npm install`.
- [ ] **Step 2: Write the failing handler tests**, in the style of `tests/apiHandler.test.js`. Use a fake `authenticate`, as that file's `fakeAuthenticate` does; real JWT verification is already covered by `tests/apiAuth.test.js`. Fakes:
  - `storage`: an in-memory `Map` of key → `{ body, contentType, metadata, cacheControl, contentDisposition, lastModified }`, with `presignPut`, `get`, `exists`, `putOnce`, `remove` and `listOlderThan`.
  - `db`: `lookupEditor` and `mediaBySha`.
  - `imaging`: the real module.
  - `queue`: the real one.
  - `parseTrigger`: a stub.

  Cases:
  - **Auth:** 401 without a token and 403 `not_an_editor` on every route except `/health`, `OPTIONS` and `/sweep`.
  - **`POST /uploads`:**
    - Rejects a bad `byteSize` (0, 52,428,801, or not an integer), `contentType` `image/heic` (400 `heic_unsupported`), `text/html` (`unsupported_type`), and a bad `fileName`.
    - On success, returns `{ uploadId (UUID), url, headers: { 'Content-Type': 'image/jpeg' } }`. `storage.presignPut` was called with `incoming/<uploadId>`, the type and the length.
    - `''` signs `application/octet-stream`.
  - **`POST /uploads/:id/process`:**
    - A non-UUID id gives 400.
    - A missing incoming object gives 404 `not_found`.
    - **A JPEG with GPS:**
      - `originals/<sha>.jpg` is written re-encoded, with `cacheControl` immutable, the inline disposition, `contentType` `image/jpeg`, and metadata `{ width: '200', height: '400' }`;
      - `display/<sha>.webp` and `thumbs/<sha>.webp` are written;
      - the incoming object is deleted;
      - the response is the spec's `media` object with `mediaId: null`.
    - **A dedupe hit** (`db.mediaBySha` returns a row): no derivatives are written, the incoming object is deleted, and the response carries `mediaId`, `caption` and `date` from the row.
    - **An unsupported file:** the incoming object is deleted and the response is 400 `unsupported_type`.
    - **A transient failure** (storage `putOnce` throws once): the incoming object stays and the response is 500.
    - **`putOnce` on an existing key** doesn't overwrite it.
    - **A full queue** gives 503 `busy`.
  - **`DELETE /uploads/:id`:** 204, and the object is gone. It is also 204 when the object was already gone.
  - **`POST /avatars`:**
    - Rejects an object key not matching `^originals/[0-9a-f]{64}\.[a-z0-9]+$` (400 invalid, field `objectKey`), and a bad crop (400 invalid, field `crop…`).
    - An unknown original gives 404.
    - A PDF original gives 400 invalid with the message "Only images can be avatars."
    - On success, writes `avatarKeyFor(sha, crop)` once and returns `{ avatarKey }`. A second identical call doesn't render again; spy on `imaging.renderAvatar`.
  - **`POST /sweep`:**
    - A failed `parseTrigger` gives 401, or 400 for `invalid_body`.
    - A delivery whose `trigger.name` isn't `sweep-incoming` gives 400.
    - With a valid delivery, it deletes only `incoming/` objects older than 1 hour (with `now` injected) and returns `{ deleted: n }`.
- [ ] **Step 3: Run them and check they fail.**
- [ ] **Step 4: Implement `media/storage.js`.** `createStorage({ client = new S3Client({ forcePathStyle: true }), bucket = 'ged-eye-media' })` returns:
  - `presignPut(key, contentType, contentLength)`: `getSignedUrl(client, new PutObjectCommand({ Bucket, Key, ContentType, ContentLength }), { expiresIn: 900, signableHeaders: new Set(['content-type', 'content-length']) })`.
  - `get(key)`: returns a Buffer, or null on `NoSuchKey` or 404. It refuses (`ImagingError('too_large', 413)`) when `ContentLength > MAX_UPLOAD_BYTES` **before** reading the body.
  - `exists(key)`: a `HeadObjectCommand`, giving true or false.
  - `putOnce(key, body, { contentType, cacheControl, contentDisposition, metadata })`: returns `'exists'` or `'uploaded'`, and is retried twice on a transient error, as `withRetry` does in `uploadMedia.js`.
  - `remove(key)`: a `DeleteObjectCommand`, ignoring 404.
  - `listOlderThan(prefix, cutoff)`: pages through `ListObjectsV2` and returns the keys whose `LastModified` is before `cutoff`.
- [ ] **Step 5: Implement `media/db.js`.** `createMediaDb(pool)` returns `{ lookupEditor(email), mediaBySha(sha256) }`.
  - `lookupEditor` uses the same SQL as `api/db.js`.
  - `mediaBySha` selects `id, sha256, object_key, display_key, thumb_key, content_type, byte_size, width, height, file_name, caption, date` from `media` where `sha256 = $1`.
- [ ] **Step 6: Implement `media/handler.js`.**

  ```js
  createMediaHandler({ storage, db, authenticate, imaging, queue, parseTrigger, now = () => new Date(), log = console.error })
  ```

  - **Shared code:** reuse `api/http.js` (`json`, `errorJson`, `preflight`, `readJson`, `ApiError`, `invalid`) and `api/auth.js` (`requireEditor`, `AuthError`).
  - **Editor check:** `requireEditorOf` maps an `AuthError` 403 to `ApiError(403, 'not_an_editor', { email })`, as `api/handler.js` does.
  - **Routing:** copy the router loop and error mapping from `api/handler.js`.
  - **Error mapping:**
    - `ImagingError` becomes `ApiError(e.status, e.code)`.
    - `CropError` becomes `invalid(e.field, e.message)`.
    - `BusyError` becomes `ApiError(503, 'busy', { message: 'Busy processing photos. Try again in a moment.' })`.
  - **`/process`** runs inside `queue.run`:
    1. `get` the incoming object, inside the job.
    2. `inspect` it.
    3. `db.mediaBySha`. On a hit, remove the incoming object and return the row, mapped to the response shape.
    4. Otherwise run `processFile` and `putOnce` the original, display image and thumbnail. All use `Cache-Control: public, max-age=31536000, immutable`. The original also gets `inlineDisposition(fileName)` and, for images, the metadata width and height.
    5. Remove the incoming object and respond.

    On an `ImagingError` with `permanent`, remove the incoming object before rethrowing.
  - **`/avatars`:**
    1. Check that `avatarKeyFor` already `exists`; if it does, return it.
    2. Otherwise, inside `queue.run`, `get` the original, check with `inspect` that it is an image, run `renderAvatar` and `putOnce`.
  - **`/sweep`:**
    1. Call `parseTrigger(request)`, and require `trigger.name === 'sweep-incoming'`. Task 5 confirms this is the delivered name, from the logs of the first run or a manual trigger. The proxy strips client `x-neon-*` headers, but the body can still be forged, so this is a sanity check, not authentication. The sweep is harmless either way.
    2. Delete `listOlderThan('incoming/', now() - 1h)`.
    3. Return `{ deleted }`.
- [ ] **Step 7: Implement `media/index.js`.** It mirrors `api/index.js`:
  - a `pg` `Pool` with `max: 5`, then `attachDatabasePool`;
  - `createStorage()`;
  - `createJobQueue()`;
  - `authenticatorFromEnv(process.env)` from `api/auth.js`;
  - `parseTriggerDelivery` from `@neon/functions/triggers`, wrapped so `{ ok: false, error }` becomes `ApiError(error === 'invalid_body' ? 400 : 401, error)`;
  - `export default { fetch: createMediaHandler(...) }`.
- [ ] **Step 8: Add the trigger to `neon.ts`:**

  ```ts
  triggers: {
    'sweep-incoming': { type: 'schedule', function: 'media', cron: '17 * * * *', functionPath: '/sweep' }
  }
  ```

  Keep `media: { name: "ged-eye media", source: "media/index.js", externalPackages: ["sharp"] }`.
- [ ] **Step 9: Run the handler tests, then the whole unit suite.** Run `npx vitest run tests/mediaHandler.test.js`, then `npx vitest run`, and expect PASS. The existing count was 887, plus the new tests.
- [ ] **Step 10: Commit** with the message "media Function: uploads, processing, avatars, sweep".

### Task 5: Deploy `media` to `photos` and smoke-test it

**Files:** `scripts/neon/smokeMedia.js` (new, committed).

- [ ] **Step 1: Deploy.** Run `ASDF_NODEJS_VERSION=24.11.1 neon deploy --no-env-pull`, retrying on "Could not reach the Neon API".
  - Expect `~ function media`, `~ function api` and the trigger `sweep-incoming` to be applied.
  - Note the `media` URL printed under "Function URLs". Task 9 needs it.
  - If the trigger is refused with `404 function triggers not available`, deploy without it and note this in the spec's spike findings.
- [ ] **Step 2: Write `scripts/neon/smokeMedia.js`.**
  - **Getting a JWT:** use a dev account, read only via `--env-file=.env.dev-accounts.local` and never printed.
    1. Copy it with `cp /Users/rob/src/ged_eye/.claude/worktrees/editing/.env.dev-accounts.local .env.dev-accounts.local`, without reading it.
    2. Sign in with a password on the `photos` branch's Auth.
    3. Call `GET /get-session` and take the `set-auth-jwt` header.
    4. Check with `GET /me` on `photos`'s `api` that the account is an editor on `photos`, which is a child of `editing`.
  - **Then run, printing only statuses and shapes:**
    1. `GET /health`.
    2. `/uploads` for a 2-byte `text/plain`: expect 400.
    3. `/uploads` for a generated 1,000×800 JPEG with GPS (sharp, as in the tests), then PUT it to the presigned URL, then `/process`. Check the response shape and that the public HEADs of all three keys return 200.
    4. Repeat `/process` on the same id: expect 404.
    5. Upload and process the same file again: expect `mediaId: null`, because no row is recorded yet, and the same sha.
    6. `/avatars` twice: same key both times.
    7. `DELETE /uploads/<fresh id>`: 204.
    8. `neon triggers list`, which shows `sweep-incoming`.
- [ ] **Step 3: Run it.** Use `node --env-file=.env.local --env-file=.env.dev-accounts.local scripts/neon/smokeMedia.js` and expect every check to pass.
  - If the dev accounts can't sign in on `photos` (Auth isn't copied with the branch), stop and tell the controller. Don't create accounts.
- [ ] **Step 4: Commit** `scripts/neon/smokeMedia.js` with the message "media: smoke test against a branch".

---

## Chunk 3: API

### Task 6: Upload checks and the `prepare` step

**Files:**
- Create `api/uploads.js`.
- Modify `api/changes.js` (`prepare`), `api/db.js` (pass `headObject` through), `api/index.js` (build `headObject` from env) and `api/privacy.js` (captions).
- Tests: `tests/apiUploads.test.js` (new), `tests/apiHandler.test.js` (extend), and the masking tests wherever `maskNoteEmails` is tested.

- [ ] **Step 1: Write the failing tests.** They cover these exports from `api/uploads.js`:

  ```js
  import { SHA256, TYPES, cleanFileName } from '../media/types.js';
  /** The keys of an upload: originals/<sha>.<ext>, plus display/ and thumbs/ for images. */
  export function keysFor({ sha256, ext }) { … } // → { objectKey, displayKey | null, thumbKey | null, type }
  /** Validates `upload: { sha256, ext, fileName }` from a command's params (400 invalid with `field`). */
  export function validateUpload(upload, field) { … }
  /**
   * HEADs each upload's original and, for images, its display image: in parallel, at most 8 at a time, each with
   * a 5 s timeout, before any transaction opens. → [{ contentType, byteSize, width, height }] in input order.
   * Throws ApiError 400 missing_upload { index, field } when an object is absent (404/403), 400 invalid when the
   * stored content type doesn't match ext, and 503 busy on a timeout or network error.
   */
  export async function headUploads(uploads, headObject) { … }
  /** headObject(key) → { status, contentType, contentLength, width, height } from an unauthenticated HEAD of the public URL. */
  export function publicHead(baseUrl, fetchImpl = fetch) { … }
  ```

  The tests use a fake `headObject` to cover:
  - parallelism no greater than 8 (count concurrent calls);
  - the timeout giving 503, through a never-resolving fake and fake timers;
  - a 404 on the display image of an image giving `missing_upload` with `index`;
  - PDFs never HEADing a display image;
  - a content type that doesn't match `ext` giving invalid;
  - a missing `x-amz-meta-width` giving null width.

  `publicHead` is tested against a stub `fetch`. It reads the `x-amz-meta-width` and `x-amz-meta-height` headers as integers, or null when missing.
- [ ] **Step 2: Write the failing `runChange` test** in `tests/commandValidation.test.js`, in its `describe('api/changes.js')` block. That block already exercises the runner with a fake pool.
  - A fake command with `prepare` records the call order.
  - `prepare` is called after `validate` and before the fake pool's `connect`/`begin`.
  - Its result is passed to `run` as the fourth argument.
  - When `prepare` throws, the transaction is never opened.
- [ ] **Step 3: Run them and check they fail.**
- [ ] **Step 4: Implement.**
  - **`runChange`.** In `api/changes.js`:

    ```js
    export async function runChange(pool, user, kind, params, { commands = COMMANDS, log = console.error, context = {} } = {}) {
      …
      const clean = command.validate(params);
      // Before the lock: network checks (HEADs of uploads) must never hold begin_change's global lock.
      const prepared = command.prepare ? await command.prepare(clean, context) : undefined;
      try {
        return await inTransaction(pool, async (tx) => {
          const id = await beginChange(tx, user, kind, params);
          const { summary, personIds, focusId } = await command.run(tx, clean, user, prepared);
          …
    ```

    `prepare` errors are `ApiError`s and pass through `mapDbError` unchanged.
  - **Wiring.** `api/db.js`'s `createDb(pool, { log, context })` passes `context` to `runChange`. `api/index.js` builds:

    ```js
    context: { headObject: publicHead(`${process.env.AWS_ENDPOINT_URL_S3}/ged-eye-media`) }
    ```

    If `AWS_ENDPOINT_URL_S3` is unset, `headObject` throws `ApiError(500, 'internal')`, and the problem is logged once.
  - **Masking.** In `api/privacy.js`:

    ```js
    const isNoteKey = (key) => key === 'notes' || key.endsWith('Notes') || key === 'caption';
    ```

    Add a test that a view's `photos[0].caption` with an email address is masked and a `fileName` isn't.
  - **Cache version.** Bump `VIEW_VERSION` in `api/handler.js` to 3. Then update `tests/apiHandler.test.js` to match: its `ETAG` constant `'W/"2.…"'` becomes `'W/"3.…"'`, and `expect(VIEW_VERSION).toBe(2)` becomes `toBe(3)`.
- [ ] **Step 5: Run the tests** and expect PASS. Then run `npx vitest run` and expect everything to pass.
- [ ] **Step 6: Commit** with the message "api: upload HEAD checks before the lock; captions masked".

### Task 7: Photo commands

**Files:**
- Create `api/commands/photos.js` (shared helpers), `addPhotos.js`, `updatePhoto.js`, `removePhoto.js`, `setAvatar.js` and `clearAvatar.js`.
- Modify `api/commands/index.js` (register them) and `api/commands/validate.js` (export `optionalLine`).
- Tests:
  - `tests/commandValidation.test.js` (extend);
  - `tests/editContract.test.js` (extend, in Task 15, once the front end builds these params);
  - `tests/db/photoCommands.test.js` (new).

- [ ] **Step 1: Add the `optionalLine` helper to `validate.js`.**

  ```js
  /** Optional single-line text: trimmed, at most `max` characters, storable; '' and absent → null. */
  export function optionalLine(value, field, { max = MAX_LINE, label = field } = {}) { … }
  ```

  It is the existing `line()` logic with a `max`, for names outside `PERSON_FIELDS`. Unit-test it.
- [ ] **Step 2: Write the failing validation tests** in `tests/commandValidation.test.js`. Each kind rejects unknown keys (`requireParams`). Check:
  - **`add_photos`:**
    - `photos` must hold 1–20 items.
    - Each item has exactly one of `upload` and `mediaId`. `mediaId` is a positive integer, but may arrive as a number or a numeric string, because `media.id` comes back from JSON as a number.
    - `personIds` is a non-empty array of ids, with no duplicates, including the top-level `personId`.
    - `caption` is at most 500 characters and `date` at most 100.
    - A sha or `mediaId` repeated across items is invalid (`field: 'photos'`).
  - **`update_photo`:** `expected` must hold exactly `caption`, `date` and `personIds`. `focusId` is optional.
  - **`set_avatar`:** exactly one of `mediaId` and `photo`, where `photo` is one `add_photos` item. `crop` is checked with `validateCrop` (a `CropError` becomes `invalid`). `avatarKey` must be a string matching `^avatars/[0-9a-f]{64}-[0-9a-f]{12}\.webp$`.
  - **`remove_photo` and `clear_avatar`:** the ids.
- [ ] **Step 3: Write the failing DB tests** in `tests/db/photoCommands.test.js`.
  - Call the command modules directly inside a transaction, as `tests/db/commands.test.js` does.
  - Pass a fake `prepared`, built from fake HEAD results, so no network is needed.
  - Check every row of the spec's Commands table, and the DB-test list in the spec's Testing section:
    - batch insert with tags, and the positions: new photos first, in batch order;
    - re-linking an existing sha;
    - a caption on an existing media fills only null fields;
    - `no_change` when every link exists;
    - `update_photo` stale on each of caption, date and personIds, and 404 `not_found` on media that no longer exists (as the spec says for any unknown media);
    - `remove_photo` stale when already unlinked;
    - `set_avatar`:
      - with `mediaId` and with `photo`;
      - refused for a PDF, for an unlinked photo, for media without a display image, and for an `avatarKey` that doesn't match `avatarKeyFor(sha, crop)`;
      - leaves `updated_at` unchanged;
    - `clear_avatar`;
    - the summaries;
    - `personIds`;
    - every command undone and redone with `toggle_change`, returning the exact prior rows;
    - undo of `add_photos` blocked by a later `update_photo` (a conflict naming that change);
    - redo of an undone `add_photos` after the same sha was re-inserted, giving GE003 `constraint` (a 409, not a 500).
- [ ] **Step 4: Run them and check they fail.**
- [ ] **Step 5: Implement `api/commands/photos.js`.**

  ```js
  /** media row (id, sha256, object_key, display_key, thumb_key, content_type, width, height, caption, date) or 404 not_found. */
  export async function requireMedia(tx, id, field = 'mediaId') { … }
  /** person ids linked to a media row, sorted. */
  export async function linkedPeople(tx, mediaId) { … }
  /**
   * Links `mediaIds` (in order) to `personId` at the front: positions min(position) - n … min(position) - 1, so
   * the first comes first and existing photos keep their order. Existing links are left alone (on conflict do nothing).
   */
  export async function linkAtFront(tx, personId, mediaIds) {
    const { rows: [{ low }] } = await tx.query(
      'select coalesce(min(position), 0) as low from person_media where person_id = $1', [personId]);
    for (const [i, mediaId] of mediaIds.entries()) {
      await tx.query(`insert into person_media (person_id, media_id, position) values ($1, $2, $3)
                      on conflict (person_id, media_id) do nothing`, [personId, mediaId, low - mediaIds.length + i]);
    }
  }
  /**
   * The media id for an uploaded file: a new row from the upload and its HEAD results, or the existing row with
   * this sha (another editor's upload since /process), whose null caption/date are filled in.
   */
  export async function mediaForUpload(tx, upload, head, { caption, date }) { … }
  /** Sets caption and/or date only where the row's are null. */
  export async function fillCaption(tx, mediaId, { caption, date }) { … }
  ```

  `mediaForUpload` inserts `(sha256, original_path, file_name, content_type, byte_size, object_key, thumb_key, display_key, width, height, caption, date)`:
  - `original_path` is `upload/<fileName>`.
  - The keys come from `keysFor`.
  - `content_type` and `byte_size` come from the HEAD.
  - It uses `on conflict (sha256) do nothing returning id`, then selects the id when nothing was inserted.
- [ ] **Step 6: Implement the five commands.** Each exports `kind`, `validate`, an optional `prepare` and `run`.
  - **`prepare`:**
    - `add_photos`: `headUploads(items with upload)`, mapped back by index.
    - `set_avatar`: HEADs `photo.upload` if present, and always HEADs `avatarKey`. A missing avatar gives `400 missing_upload`, field `avatarKey`.
  - **Summaries:**
    - "Added a photo for X" / "Added N photos for X"
    - "Edited a photo of X", where X is the focus person
    - "Removed a photo from X"
    - "Changed the avatar of X"
    - "Removed the avatar of X"

    Use `nameOf` from `summary.js`.
  - **`personIds`:**
    - `add_photos`: every tagged person.
    - `update_photo`: the union of the old and new links.
    - The others: the person.
  - **`focusId`:**
    - `add_photos`: `personId`.
    - `update_photo`: `focusId` if it is still linked, else the first of the new `personIds`.
    - The others: the person.
  - **`set_avatar`** runs:

    ```sql
    update person set avatar_key = $2, avatar_source = $3::jsonb where id = $1
    ```

    with `$3 = { mediaId, crop }`. It doesn't touch `updated_at`. Check the square with `cropPixels(crop, media.width, media.height)` when both are known.
- [ ] **Step 7: Register the five commands** in `api/commands/index.js`.
- [ ] **Step 8: Run the tests.** Run `npx vitest run` (unit) and `npm run test:db` (DB), and expect both to pass.
- [ ] **Step 9: Commit** with the message "api: add_photos, update_photo, remove_photo, set_avatar, clear_avatar".

### Task 8: Deploy `api` to `photos` and smoke-test the flow

**Files:** extend `scripts/neon/smokeMedia.js`, or add `scripts/neon/smokePhotos.js`, which reuses its sign-in.

- [ ] **Step 1: Deploy** with `neon deploy --no-env-pull`, retrying on API errors.
- [ ] **Step 2: Extend the smoke test.**
  1. Upload and process a JPEG with GPS.
  2. `add_photos` for `I1`, tagged with one relative.
  3. Check `GET /person/I1` (as editor): the photo is first, has `displayKey`, `people` has both, and the caption is set.
  4. Check an anonymous `GET /person/I1`: a caption containing `a@b.com` is masked.
  5. `update_photo`: a successful caption change. Then the same call again with the old `expected`, giving 409 `stale`.
  6. `/avatars`, then `set_avatar`: the view's `avatarKey` equals the returned key.
  7. `POST /undo` twice: the avatar edit and then the caption edit are reverted. Check both in the view.
  8. `POST /redo`.
  9. `remove_photo`.
  10. `clear_avatar`.
  11. Leave the branch tidy: undo everything the smoke test did, via `/undo` until its first change is undone. The recorded changes stay in History, which is fine on a dev branch.
- [ ] **Step 3: Run it** and expect every check to pass.
- [ ] **Step 4: Commit** with the message "api: photos smoke test on a branch".

---

## Chunk 4: Front end

All new UI lives in new modules, loaded with the editing chunk (`src/editing.js`). Viewers must still download no editing code: `main.js` imports `editing.js` lazily, as today. Unit tests use jsdom, with stubs for `fetch`, `XMLHttpRequest` and `URL.createObjectURL`.

### Task 9: Media URLs, API client and upload client

**Files:**
- Modify `src/media.js`, `src/editApi.js` and `.env.development`, then create `src/mediaApi.js`.
- Modify `.env.development.local` (not committed): add `VITE_MEDIA_API_URL=<the media URL from Task 5's deploy output>`. The spike's deploy printed `https://br-solitary-darkness-b2jjfmob-media.compute.c-6.eu-central-1.aws.neon.tech`.
- Tests: `tests/media.test.js` (new or extended), `tests/editApi.test.js` (extend) and `tests/mediaApi.test.js` (new).

- [ ] **Step 1: `src/media.js`.**
  - `displayUrl(photo)` returns `mediaUrl(photo.displayKey)`. Failing that, for an image (`thumbKey` present) it returns `mediaUrl(photo.key)`; otherwise null.
  - `avatarUrl(person)` is moved from `FamilyTreeView.getAvatarPath`, which now calls it. It returns the avatar or the placeholder.
  - `isImage(photo)` returns `Boolean(photo.thumbKey || photo.displayKey)`.
  - Tests cover all three.
- [ ] **Step 2: `src/editApi.js`.**
  - `apiUrl(path, base = import.meta.env.VITE_API_URL)`.
  - `createEditApi({ getToken, setRole, baseUrl })` uses `baseUrl` for every call.
  - The module-level `api` stays on `VITE_API_URL`.
  - Export `createEditApi`, and also a `mediaClient`: `createEditApi({ getToken, setRole, baseUrl: import.meta.env.VITE_MEDIA_API_URL })`, exposing only `authedFetch`.
  - Throw "VITE_MEDIA_API_URL is not configured" lazily, on first use.
- [ ] **Step 3: `src/mediaApi.js`.**

  ```js
  /** → { uploadId, url, headers } */
  export const requestUpload = ({ fileName, contentType, byteSize }) => …POST /uploads
  /**
   * PUTs `file` to a presigned slot with XMLHttpRequest, for upload progress. onProgress(fraction 0..1).
   * `signal` aborts. Rejects with ApiError(0, 'network') on network failure, ApiError(0, 'aborted') on abort,
   * and ApiError(status, 'upload_failed') on a non-2xx (403 means the slot expired or was used).
   */
  export function uploadFile(slot, file, { onProgress, signal } = {}) { … }
  export const processUpload = (uploadId, fileName) => …POST /uploads/:id/process → media
  export const discardUpload = (uploadId) => …DELETE /uploads/:id (errors swallowed and logged)
  export const renderAvatar = (objectKey, crop) => …POST /avatars → avatarKey
  ```

  Tests: a fake `XMLHttpRequest` checks the method, the `Content-Type` header from `slot.headers`, progress events, abort and errors. The other functions are tested through a stubbed `fetch`.
- [ ] **Step 4: `.env.development`.** Add `VITE_MEDIA_API_URL=` (empty, overridden locally) with a comment.
  - `.env.production` gets its value in Task 18.
  - Until then, the production build would only break when editors try to upload. To keep it safe, the details panel hides the Add tile when `VITE_MEDIA_API_URL` is empty (Task 15).
- [ ] **Step 5: Run the tests** (`npx vitest run`), then **commit** with the message "Front end: display URLs, media API client".

### Task 10: Upload queue

**Files:** Create `src/uploadQueue.js`. Test: `tests/uploadQueue.test.js`.

- [ ] **Step 1: Write the failing tests** against this interface, with fake `mediaApi` functions.

  ```js
  /**
   * createUploadQueue({ api: { requestUpload, uploadFile, processUpload, discardUpload }, concurrency = 2, onChange })
   * → { add(files) → items, retry(item), remove(item), cancel(), items(), allSettled() → Promise, hasActive() }
   * item: { id, file, state: 'queued'|'uploading'|'processing'|'ready'|'failed', progress, media, error,
   *         retryable, duplicateOf }
   */
  ```

  Behaviour to test:
  - At most two items are uploading or processing at once.
  - The states change in order, and `onChange` is called on each change.
  - `ready` carries `media`.
  - A permanent processing error (`unsupported_type`, `heic_unsupported`, `unreadable`, `too_large`, `empty`, `too_many_pixels`) gives `failed` with `retryable: false`.
  - Each of these has a card message in `addPhotosDialog`. For example, `unreadable` shows "This file couldn't be read."
  - A network error or 503 gives `retryable: true`.
  - **`retry` of a failed upload:**
    - if the slot is under 14 minutes old, it reuses the slot;
    - otherwise it requests a new one;
    - a 403 from `uploadFile` always requests a new one.
  - **`retry` after processing failed:** it re-runs `processUpload`, and a 404 there re-uploads the file with a new slot.
  - **`cancel`:** aborts in-flight uploads (through the signal), and calls `discardUpload` for items that uploaded but aren't processed.
  - **`remove(item)`:** the same as cancel, for one item.
  - **Duplicates:** two files whose processed `sha256` matches, giving the second `duplicateOf` and `state: 'ready'` with no separate media.
  - `hasActive()` is true while anything is queued, uploading or processing.
- [ ] **Step 2: Run them and check they fail.**
- [ ] **Step 3: Implement it**, without the DOM.
- [ ] **Step 4: Run the tests** and expect PASS.
- [ ] **Step 5: Commit** with the message "Front end: upload queue".

### Task 11: Person search and person picker

**Files:**
- Create `src/personSearch.js` and `src/personPicker.js`, and modify `src/relativeDialog.js`.
- Tests: `tests/personPicker.test.js` (new). `tests/relativeDialog.test.js` must pass unchanged.

- [ ] **Step 1: Extract `createPersonSearch`** into `src/personSearch.js`. Move the debounce, minimum length, "Searching…" status, stale-result guard and error message out of `relativeDialog.js`:

  ```js
  /**
   * The search half of "find someone in the tree": a debounced search box with a polite status line.
   * createPersonSearch({ api, isActive: () => bool, onResults(people), label = 'Search the tree' })
   * → { input, status, element (label + input + status), runNow(), clear(), destroy() }
   */
  ```

  `relativeDialog.js` then uses it and keeps its own radio results. Run `npx vitest run tests/relativeDialog.test.js`: it must pass with no test changes.
- [ ] **Step 2: Write the failing `personPicker` tests,** then implement it.

  ```js
  /**
   * Choose several people: chips (name + ×) for the chosen, a person search, and an "Add" button per result.
   * createPersonPicker({ api, chosen: [{ id, name }], fixedIds = [] (no × on these), onChange(chosen) })
   * → { element, chosen(), destroy() }
   */
  ```

  The tests check:
  - adding from the results;
  - no duplicates;
  - × removes a chip, but not a fixed one;
  - `onChange` fires;
  - names go through `textContent`.
- [ ] **Step 3: Run the tests** and **commit** with the message "Front end: shared person search and multi-person picker".

### Task 12: Photo command params and the Add photos sheet

**Files:**
- Create `src/photoParams.js` and `src/addPhotosDialog.js`, and modify `src/editingStyles.css`.
- Tests: `tests/photoParams.test.js` and `tests/addPhotosDialog.test.js`.

- [ ] **Step 0: `src/photoParams.js`.** This is a pure module: no DOM, and no imports of `cropperjs` or of dialogs. The dialogs and `main.js` build every photo command's params here, and Task 15's contract test runs them through the server validators in the node environment.

  ```js
  /** One add_photos item from a ready upload-queue item: { mediaId } for a dedupe hit, else { upload: { sha256, ext, fileName } }. */
  export function photoItem(media, { caption, date, personIds }) { … }
  export const addPhotosParams = (personId, items) => ({ personId, photos: items });
  export const updatePhotoParams = (photo, { caption, date, personIds }, focusId) => ({ mediaId: photo.id, caption, date, personIds,
    expected: { caption: photo.caption, date: photo.date, personIds: photo.people.map((p) => p.id) }, focusId });
  export const removePhotoParams = (personId, photo) => ({ personId, mediaId: photo.id });
  /** `source` is { mediaId } for an existing photo, or { media } for a fresh upload (photoItem decides upload vs mediaId). */
  export function setAvatarParams(personId, source, crop, avatarKey) { … }
  export const clearAvatarParams = (personId) => ({ personId });
  ```

  Unit-test each builder.

- [ ] **Step 1: Write the failing tests** for this interface:

  ```js
  /**
   * openAddPhotosDialog({ person, files?, api (editApi), mediaApi, queue? (injectable), onSaved(result) })
   * Opens the full-screen sheet; `files` (from a drop) start uploading at once, otherwise the file picker opens.
   */
  ```

  Behaviour (per the spec's front-end table and Error handling):
  - **Picker:** a hidden `<input type="file" accept="image/*,application/pdf" multiple>`, opened by an "Add more" button and, when no `files` are given, on open.
    - iOS only opens a file picker from inside the tap's own event handler. So `openAddPhotosDialog` creates the input, appends it to the sheet (a detached input is unreliable in some Safari versions), and calls `input.click()` synchronously, before any `await`.
    - The details panel's Add tile calls the hook directly from its click handler, and `main.js`'s hook must not `await` before calling `openAddPhotosDialog`. That holds because the editing chunk is already loaded whenever editor controls are shown.
  - **Cards:** one per file, with a preview, status, Caption, Date and "Shown for" (the person picker with the person fixed).
    - The preview is `URL.createObjectURL` for `image/*` types the browser can show, else a document icon. It switches to the thumbnail URL when ready.
    - The status is a progress bar with "Uploading 62%", or "Processing…", "Ready", or the error with Retry or Remove.
  - **Dedupe hit:** a card shows "Already in the tree", with the existing caption read-only.
  - **Duplicates:** cards with the same sha as an earlier card show "Same as photo 1" and are left out of the save.
  - **Save** is labelled "Save N photos" and stays enabled.
    - If any card is still uploading or processing, it says "Waiting for uploads…" and saves when they finish.
    - Failed cards must be removed or retried first; the inline message says so.
    - It then sends one `add_photos`, built with `addPhotosParams` and `photoItem`.
  - **Save responses:**
    - `no_change` closes the sheet with the toast "Already shown for everyone selected".
    - `missing_upload` marks that card failed and retryable.
    - Other errors use `commandErrorMessage`.
    - Success calls `onSaved(result)`.
  - **Closing:**
    - Cancel, Escape or × while uploads are active asks "Stop uploading and discard N photos?", then calls `queue.cancel()`.
    - While the sheet is open with active uploads, a `beforeunload` handler is registered, and it is removed on close.
- [ ] **Step 2: Add the styles.**
  - Cards stack, with 44px minimum controls.
  - The action bar is `position: sticky; bottom: 0` with `padding-bottom: env(safe-area-inset-bottom)`.
  - The sheet uses the existing `.editor-dialog` full-screen rule below 768px.
- [ ] **Step 3: Implement it**, run the tests, and **commit** with the message "Front end: Add photos sheet".

### Task 13: Avatar cropper and Change avatar

**Files:**
- Add the `cropperjs@1.7.0` dependency.
- Create `src/avatarCropper.js` and `src/avatarDialog.js`, and modify `src/editingStyles.css`.
- Tests: `tests/avatarCropper.test.js` (crop maths only) and `tests/avatarDialog.test.js`.

- [ ] **Step 1: Install Cropper.js** with `npm install cropperjs@1.7.0`. Import `cropperjs/dist/cropper.css` from `src/avatarCropper.js`, so it lands in the editing chunk.
- [ ] **Step 2: Write the failing tests** for the pure helpers in `avatarCropper.js`:
  - `toFractions(cropData, naturalWidth, naturalHeight)` converts Cropper's `getData(true)` (pixels of the loaded display image) into `{x,y,w,h}` fractions, rounded to 4 decimal places.
  - `fromFractions(crop, naturalWidth, naturalHeight)` is its inverse; the tests use it to check the round trip.
  - `defaultCrop(width, height)` returns a centred square, 80% of the shorter side, as fractions.

  The display image has the same aspect ratio as the oriented original, so the fractions carry over.
- [ ] **Step 3: Implement `createAvatarCropper`.**

  ```js
  /**
   * createAvatarCropper({ imageUrl, initialCrop | null, onReady }) → { element, getCrop() → fractions, destroy() }
   * Cropper.js set up as a fixed circle you move the image under:
   */
  new Cropper(img, {
    viewMode: 1, dragMode: 'move', aspectRatio: 1, autoCropArea: 0.8,
    cropBoxMovable: false, cropBoxResizable: false, toggleDragModeOnDblclick: false,
    guides: false, center: false, highlight: false, background: false, restore: false,
    checkOrientation: false,
    ready() { if (initialCrop) placeAt(this.cropper, initialCrop); onReady?.(); }
  });
  ```

  - **Options:**
    - Add `checkOrientation: false`. Display images are already upright, and leaving it on makes Cropper re-download the image through XHR with a cache-busting query.
    - The canvas is never read, so `crossOrigin` isn't needed.
  - **Reopening at a saved crop:** keep the fixed circle centred. Instead of `setData`, move and scale the image under it in `ready()`:

    ```js
    const box = cropper.getCropBoxData();
    const nat = cropper.getImageData();
    const width = box.width / initialCrop.w;
    const height = width * nat.naturalHeight / nat.naturalWidth;
    cropper.setCanvasData({ left: box.left - initialCrop.x * width, top: box.top - initialCrop.y * height, width });
    ```

    `setCanvasData` fires no `zoom` event, so then set the slider's value from `width / nat.naturalWidth`.
  - **Circle:** CSS `.avatar-cropper .cropper-view-box, .avatar-cropper .cropper-face { border-radius: 50%; }`. The container is `touch-action: none` and `height: min(60vh, 100vw)`.
  - **Zoom slider:** an `<input type="range">` bound to `cropper.zoomTo`. Listen for the `zoom` event to keep the slider in sync with pinch zoom.
  - **Keyboard:** while the cropper has focus, arrow keys call `cropper.move(±10, 0)` and so on, and `+`/`-` call `cropper.zoom(±0.1)`.
- [ ] **Step 4: Write the failing `avatarDialog` tests,** then implement it.

  ```js
  /** openAvatarDialog({ person, api, mediaApi, startWith?: photo, onSaved(result) })
   *  `startWith` opens straight at the crop step for that photo, from the viewer's Avatar button. */
  ```

  - **Step 1 of the dialog, the picker:**
    - a grid of `person.photos` where `photo.displayKey` is set, shown as thumbnails;
    - the tile for `person.avatarSource?.mediaId` is marked "Current";
    - an "Upload new" tile, a single-file input that runs a one-item upload queue with a progress view;
    - "Remove avatar" when `person.avatarKey` is set, which sends `clear_avatar` after a confirm.
  - **Step 2 of the dialog, the crop:**
    - the cropper on `displayUrl(photo)`, starting from `avatarSource.crop` when its `mediaId` is chosen;
    - Back, and "Use as avatar".
  - **Save:**
    1. `renderAvatar(objectKey, crop)`: `photo.key` for an existing photo, or the processed `media.objectKey` for a new upload.
    2. `set_avatar`, with params from `setAvatarParams`:
       - an existing photo sends `mediaId`;
       - a new upload sends `photo`, built by `photoItem(media, { caption: null, date: null, personIds: [person.id] })`. A dedupe hit therefore sends `{ mediaId }` rather than `upload`; a legacy row may have no display image to HEAD.
    3. Call `onSaved`.
  - **`no_change`** (re-saving the same crop) closes the dialog with the toast "Avatar unchanged".
  - **Errors:** shown inline, with Retry.
  - **Tests:** stub `createAvatarCropper` through an injectable factory, because jsdom has no layout.
- [ ] **Step 5: Run the tests** and **commit** with the message "Front end: avatar cropper and Change avatar".

### Task 14: Photo editing and the viewer

**Files:**
- Create `src/photoEditDialog.js`, and modify `src/photoViewer.js` and `src/style.css` (viewer caption and actions).
- Tests: `tests/photoEditDialog.test.js` and `tests/photoViewer.test.js` (new).

- [ ] **Step 1: `photoEditDialog`.**

  ```js
  /** openPhotoEditDialog({ photo, person, api, onSaved }) */
  ```

  - Caption, Date, and the person picker. Its chosen people are `photo.people`, and none are fixed.
  - Save sends `update_photo` with params from `updatePhotoParams(photo, fields, person.id)`.
  - `no_change` closes the dialog quietly.
  - Removing every person is refused inline: "A photo must be shown for at least one person."
  - A 409 `stale` shows "Someone else changed this photo. Reload to see their changes", with a Reload button that calls `onSaved(null)` to make the caller reload.
- [ ] **Step 2: Write the failing viewer tests,** then change `photoViewer.js`.
  - **Image:** shows `displayUrl(photo)`. A PDF, or any photo without an image, keeps the download panel.
  - **Caption block:** caption, date, and "Shown for" links, one per `photo.people` entry.
    - Clicking one calls `this.onOpenPerson(id)` and closes the viewer.
    - `onOpenPerson` is set by `PersonDetails`.
  - **"Download original":** an `<a href={mediaUrl(photo.key)} target="_blank" rel="noopener">`. Cross-origin `download` attributes are ignored, and the object's `Content-Disposition` names it.
  - **Editor actions:** `setEditorHooks({ onEdit, onUseAsAvatar, onRemove } | null)` renders Caption, Avatar, People and Remove buttons when set.
    - Caption and People both call `onEdit(photo)`.
    - Avatar calls `onUseAsAvatar(photo)`, which opens the avatar dialog for the current person with `startWith: photo`. The current person is always tagged on photos shown in their viewer, so `set_avatar` accepts it.
    - Remove confirms ("Remove this photo from Alice Smith? It stays for anyone else it's shown for."), then calls `onRemove(photo)`.
    - Hide Avatar for photos without `displayKey`, and when `VITE_MEDIA_API_URL` is empty.
    - **The viewer closes before calling any hook**, and before showing Remove's confirmation. The editor dialogs sit above the viewer and stop Escape but not the arrow keys, and the details panel re-renders after a change anyway.
  - **Escaping:** everything interpolated goes through `textContent` or `escapeHtml`.
- [ ] **Step 3: Run the tests** and **commit** with the message "Front end: photo captions, tags and editor actions in the viewer".

### Task 15: Details panel and wiring

**Files:**
- Modify `src/personDetails.js`, `src/editing.js`, `src/main.js`, `src/style.css` and `tests/editContract.test.js`.
- Tests: `tests/personDetails.test.js`, `tests/mainEditing.test.js` (extend) and `tests/editContract.test.js` (extend).

- [ ] **Step 1: `personDetails.js`.**
  - **Header:** a 52px avatar circle (`avatarUrl(person)`) before the name, for everyone.
  - **When `canEdit`:**
    - The avatar is a button labelled "Change avatar for X", with a camera badge, calling `options.onChangeAvatar(person)`.
    - The photo row ends with an Add tile, calling `options.onAddPhotos(person)`. Editors get the row, holding just the Add tile, even when the person has no photos. Today the row only renders when `photos.length > 0`.
    - When `import.meta.env.VITE_MEDIA_API_URL` is empty, the Add tile, the avatar badge, the drop zone and the viewer's Avatar button are all hidden.
    - `dragover`/`drop` on the panel calls `options.onAddPhotos(person, files)`, with a dashed outline while dragging.
  - **Photo row:** when there are more than 4 photos, the 4th thumbnail gets a "+N" overlay, and clicking it opens the viewer at index 3.
  - **Viewer wiring:**
    - Pass `options.onOpenPerson` to `this.photoViewer.onOpenPerson`.
    - When `canEdit`, call `this.photoViewer.setEditorHooks({ onEdit, onUseAsAvatar, onRemove })` wrapping `options.onEditPhoto`, `options.onUseAsAvatar` and `options.onRemovePhoto`. Otherwise call `setEditorHooks(null)`.
  - **Tests:** viewers see the avatar but no badge, Add tile or drop zone; editors get all three. Also test the "+N" overlay and that each hook is called with the person.
- [ ] **Step 2: `editing.js`.** Export:
  - `openAddPhotosDialog`, `openAvatarDialog`, `openPhotoEditDialog` and `createUploadQueue`;
  - `mediaApi`, by re-exporting `src/mediaApi.js`, so viewers never load it;
  - `commandErrorMessage` from `editorDialog.js`;
  - `removePhotoParams` from `photoParams.js`.
- [ ] **Step 3: `main.js` `detailsOptions()`.**
  - Both branches return `onOpenPerson: navigateTo`.
  - The editor branch also adds:

    ```js
    onAddPhotos: (person, files) => editing.openAddPhotosDialog({ person, files, api, mediaApi: editing.mediaApi,
      onSaved: (result) => afterCommand(result, person.id) }),
    onChangeAvatar: (person) => editing.openAvatarDialog({ person, api, mediaApi: editing.mediaApi,
      onSaved: (result) => afterCommand(result, person.id) }),
    onEditPhoto: (photo, person) => editing.openPhotoEditDialog({ photo, person, api,
      onSaved: (result) => result ? afterCommand(result, person.id) : afterChange({}, { from: person.id }) }),
    onUseAsAvatar: (photo, person) => editing.openAvatarDialog({ person, api, mediaApi: editing.mediaApi, startWith: photo,
      onSaved: (result) => afterCommand(result, person.id) }),
    onRemovePhoto: (photo, person) => removePhoto(photo, person)
    ```

  - **`removePhoto`:** there is no dialog to show an error in, so failures are toasts.

    ```js
    async function removePhoto(photo, person) {
      let result;
      try {
        result = await api.runChange('remove_photo', editing.removePhotoParams(person.id, photo));
      } catch (error) {
        const message = error?.code === 'stale'
          ? 'That photo was already removed. Reloading.'
          : editing.commandErrorMessage(error);
        showToast(message, { kind: 'error' });
        if (error?.code === 'stale') await afterChange({}, { from: person.id });
        return;
      }
      await afterCommand(result, person.id);
    }
    ```

  - The viewer has already closed itself before calling any hook (Task 14).
  - The existing toast after a command offers Undo.
  - `mainEditing.test.js` gets a case for each new hook with fakes.
- [ ] **Step 4: Contract test.** In `tests/editContract.test.js`, extend the existing test, which runs front-end-built params through the server validators. Add the five photo commands, building their params with `src/photoParams.js` (Task 12). It has no DOM or `cropperjs` imports, so it runs in the node environment.
- [ ] **Step 5: Run everything.** Run `npx vitest run` and expect everything to pass. Then build into a scratch folder, **not** `docs/` (`npm run build` writes the tracked `docs/`, which only changes in Task 18): `npx vite build --outDir /private/tmp/claude-501/-Users-rob-src-ged-eye/ecf33951-ec53-4feb-ae73-cb10bae6e18b/scratchpad/build --emptyOutDir`. Check two things in its `assets/`:
  - the main chunk has no `cropper`, and grepping the entry chunk for `Cropper` finds nothing;
  - the editing chunk includes it.
- [ ] **Step 6: Commit** with the message "Front end: avatar in the details header, Add photos, viewer actions, wiring".

---

## Chunk 5: Backfill, verification, end to end, release

### Task 16: Verification tweaks and the media backfill

**Files:**
- Modify `scripts/neon/verify.js` and `package.json` (script `backfill-media`).
- Create `scripts/neon/backfillMedia.js`.
- Tests: `tests/db/backfillMedia.test.js` (new) and `tests/db/verifyEdited.test.js` (new, with `describe.skipIf(!TEST_DATABASE_URL)` as the other DB tests do). If `EDITED_SQL` already has a DB test, extend that instead.

- [ ] **Step 1: Change `verify.js`.**
  - **`EDITED_SQL`:** replace the media line with:

    ```sql
    select pm.person_id from person_media pm
      where pm.media_id in (
        select (cr.row_key ->> 'id')::bigint from change_row cr join change c on c.id = cr.change_id
        where cr.table_name = 'media'
          and c.kind <> 'backfill_media'
          and not (c.kind in ('undo', 'redo') and exists (
                select 1 from change b where b.id = c.base_change_id and b.kind = 'backfill_media')))
    ```

  - **Missing-objects query:** add `union all select display_key from media where display_key is not null`.
  - **DB test:** a recorded `backfill_media` change on a media row doesn't mark its people as edited, and a `fixture` change does.
- [ ] **Step 2: Write `scripts/neon/backfillMedia.js`**, using `scripts/neon/backfillFacts.js` as the model: `cli.js` helpers, `--dry-run`, and an exported `plan`/`apply` for tests.
  - **Select:**

    ```sql
    select id, sha256, object_key, content_type, thumb_key
    from media
    where display_key is null and content_type like 'image/%'
    order by id
    ```

  - **Phase 1, no transaction**, 4 at a time:
    1. Download the original.
    2. `derivatives(buffer)` from `media/imaging.js`. On failure, log it and skip that row; for example, sharp can't read BMP.
    3. `putOnce` `display/<sha>.webp`, plus `thumbs/<sha>.webp` when `thumb_key` is null.
    4. Collect `{ id, display_key, thumb_key, width, height }`.
  - **Phase 2, one short transaction.** Skip it entirely when Phase 1 collected nothing, so a re-run records no empty change.

    ```sql
    begin;
    select begin_change('backfill@ged-eye.local', 'Media backfill', 'backfill_media', 'script',
                        'Display images for existing photos', '{}', '{}');
    update media set display_key = …, thumb_key = coalesce(thumb_key, …), width = …, height = …
      where id = … and display_key is null;  -- one statement per row, or one update … from (values …)
    commit;
    ```

    `begin_change`'s argument order matches `backfillFacts.js`'s call.
  - **`--report-gps`:** read-only. It downloads every image original (not just those without a display image), runs `hasLocation(await sharp(buffer).metadata())` on each, and prints the count and the media ids, never coordinates. It writes nothing, even without `--dry-run`.
  - **`npm run backfill-media`:** `node --env-file=.env.local scripts/neon/backfillMedia.js`.
  - **DB test** (`tests/db/backfillMedia.test.js`): run `apply` with a fake storage on `test-editing`'s fixture. Check that:
    - the rows are updated in one change of kind `backfill_media`;
    - a second run does nothing and records no new `change` row;
    - a failing image is skipped and reported.
- [ ] **Step 3: Run it on `photos`.**
  1. `npm run backfill-media -- --dry-run`, and record the counts.
  2. `npm run backfill-media -- --report-gps`, and record the GPS count.
  3. `npm run backfill-media -- --confirm <database host>`.
  4. `npm run verify-neon -- --legacy-root /Users/rob/src/ged_eye/ignore/legacy-data`. The worktree has no `ignore/` folder; the media manifest comes through the `.neon-import` symlink. Expect 0 unexplained.
- [ ] **Step 4: Commit** with the message "Backfill display images for existing photos; verify ignores the backfill".

### Task 17: End-to-end check on `photos`

- [ ] **Step 1: Dev server.** Use the `photos-dev` launch configuration (port 5175). `.env.development.local` points all four `VITE_*` values at `photos`.
- [ ] **Step 2: Sign in.** Ask the developer to sign in on `http://localhost:5175/ged-eye/?person=I1` with an email code or a dev account. Never type a password yourself.
- [ ] **Step 3: Check in the browser pane, at desktop size and at the `mobile` preset:**
  - add 3 photos (two JPEGs and a PDF) with a caption, a date and a tag;
  - progress shows, and Save gives the toast with Undo;
  - the photos come first in the details row;
  - "+N" shows;
  - the viewer shows the display image, caption, people links and Download original;
  - Caption edit works, and so does a stale edit from a second tab;
  - "Use as avatar" opens the crop step: drag, slider and keyboard all work, and the tree node shows the new avatar;
  - Change avatar from the header badge, including "Upload new" and "Remove avatar";
  - Remove photo, then Undo;
  - History shows every change with the right summaries;
  - a TIFF scan now opens in the viewer (from the backfill);
  - signed out, viewers see the avatar header, captions and tags, but no edit controls;
  - the network panel shows no editing or Cropper chunk for viewers;
  - no console errors.
- [ ] **Step 4: README.** Add a "Photos" section after "Editing" covering:
  - uploads and supported types;
  - location stripping;
  - avatars;
  - the `media` Function and the `sweep-incoming` trigger;
  - `npm run backfill-media`;
  - the dev env (`VITE_MEDIA_API_URL`);
  - the release steps.
- [ ] **Step 5: Final review.** Run a whole-branch code review with superpowers:code-reviewer, then fix the findings.
- [ ] **Step 6: Commit** the README and any fixes.

### Task 18: Release to production

This follows the spec's Rollout. Production steps are additive, and nothing is deleted.

- [ ] **Step 1: Safety branch.** `neon branches create --name pre-photos-2026-10-09 --parent production --no-secrets`. Use the actual date.
- [ ] **Step 2: Migration 008 on production.**
  - The main checkout's `/Users/rob/src/ged_eye/.env.local` holds production's credentials.
  - From the worktree, run `node --env-file=/Users/rob/src/ged_eye/.env.local scripts/neon/migrate.js`. `migrate.js` reads `DATABASE_URL_UNPOOLED`.
  - Expect `008_photos.sql` to be applied.
  - Never use the `npm run` scripts for production steps: they are hard-wired to the worktree's `.env.local`, which is the `photos` branch.
- [ ] **Step 3: Deploy both Functions** with `neon deploy --branch production --no-env-pull`. If production is a protected branch and the CLI asks to confirm, re-run with the flags it names (such as `--allow-protected -y`), never interactively.
  - Note the new `media` URL from the output.
  - **Smoke-test:** `GET <media>/health` gives `{ok:true}`, and an unauthenticated `POST <media>/uploads` gives 401. The dev accounts aren't production editors, so there are no uploads to production.
  - Check `neon triggers list --branch production` shows `sweep-incoming`.
- [ ] **Step 4: Backfill rehearsal.**
  1. `neon branches create --name photos-backfill-rehearsal --parent production --no-secrets`.
  2. Run the backfill there with that branch's credentials. The script needs `DATABASE_URL` and the `AWS_*` storage variables for that branch.
     - Get them with `neon env pull --branch photos-backfill-rehearsal --file <scratchpad>/rehearsal.env`, run from the scratchpad and never printed.
     - Never run it from the worktree without `--file`: it would overwrite the worktree's `.env.local`.
     - The script reads `DATABASE_URL_UNPOOLED` and the `AWS_*` variables. It checks that the database and storage belong to the same branch, and needs `--confirm <database host>`, the host it prints first, for a real run.
     - Then run `node --env-file=<scratchpad>/rehearsal.env scripts/neon/backfillMedia.js --dry-run`, then the same command with `--confirm <host>`.
  3. Check the counts match the dry run, and spot-check 3 display images.
- [ ] **Step 5: Production backfill.**
  1. `node --env-file=/Users/rob/src/ged_eye/.env.local scripts/neon/backfillMedia.js --report-gps`, and record the count.
  2. The same command with `--dry-run`, then with `--confirm <production database host>` (printed by the dry run) for the real run.
  3. `node --env-file=/Users/rob/src/ged_eye/.env.local scripts/neon/verify.js --legacy-root /Users/rob/src/ged_eye/ignore/legacy-data`: expect 0 unexplained.
- [ ] **Step 6: Front-end env.** Add `VITE_MEDIA_API_URL=<production media URL>` to `.env.production`.
- [ ] **Step 7: Build the site.** Run `npm run build` into `docs/`, as in earlier releases (check `vite.config.js` for `outDir`).
- [ ] **Step 7b: Commit and push.** Commit `.env.production` and `docs/` with the message "Release photos: production media URL and site build", then push the `photos` branch.
- [ ] **Step 8: Pull request.**
  - Create a PR with `gh pr create`, ending the body with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
  - Its description states what was done on production and the GPS report count.
  - Merge with a squash.
- [ ] **Step 9: Live check.** On https://robacourt.github.io/ged-eye/, confirm the viewer uses display images and viewers load no editing chunk.
- [ ] **Step 10: Report.**
  - Tell the developer what changed, the evidence, the rollback path (redeploy the previous Functions and front end), and the GPS count.
  - Ask them to try uploading from their iPhone (library and camera).
  - List the branches they may delete: `photos-backfill-rehearsal`, and later `pre-photos-…`.
