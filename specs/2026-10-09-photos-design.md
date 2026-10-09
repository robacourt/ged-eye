# Photos: upload, captions, tagging and avatars: design

**Date:** 2026-10-09
**Status:** Revision 1. The developer approved the three design sections in conversation and asked for it to be written up and built.
**Follows:** [2026-10-09-editing-design.md](2026-10-09-editing-design.md). That release added sign-in, recorded changes, undo, and the "Next release: photos" notes this design builds on.

## Goals

- **Upload.** Editors can upload photos, scans and PDFs to a person from a phone or a computer: several at once, with upload progress.
- **Captions.** Each photo can have a caption and a free-text date, such as "about 1923".
- **Tagging.** One photo can be shown for several people. A wedding photo is stored once and appears for the bride, the groom and anyone else tagged.
- **Avatars.** An editor picks any of a person's photos, or uploads a new one, and positions it under a circle by dragging and pinching. Re-opening the crop starts from the last one.
- **Recorded and undoable.** Every photo action is a recorded change, like every other edit. Stored objects are never deleted, so a revert can always bring a photo back.
- **Fast viewing on phones.** The viewer shows a 2000px display image, never the multi-megabyte original. The existing 544 images are backfilled, and that includes the 5 TIFF scans, which become viewable instead of download-only.
- **Location privacy.** Location data (GPS) is stripped from uploaded photos, because the bucket is public.
- **Mobile first.** The experience is designed for phones and also works on desktop.

## Non-goals (this release)

- Reordering photos. New uploads go first; the existing order is kept.
- Previews of PDF pages. A PDF shows as a document tile with its caption and opens in the browser's own viewer.
- Automatic face detection for avatars. The 671 existing face-detected avatars stay until someone changes them.
- Changing existing originals. The backfill only *reports* how many contain GPS data; changing them needs the developer's go-ahead.
- HEIC decoding. iPhones convert HEIC to JPEG when picking from the photo library. A raw `.heic` file gets a clear message instead.
- Deleting objects from storage. Only the temporary `incoming/` uploads are ever deleted.

## Decisions

| Topic | Decision |
|---|---|
| Where image work happens | A new Neon Function `media` uses sharp. The browser only previews, crops (as fractions) and uploads. |
| Why a separate Function | sharp adds about 20 MB of native code. Keeping it out of `api` keeps cold starts for public page views unchanged. |
| Upload path | The browser PUTs straight to object storage with a presigned URL; the bucket's CORS already allows PUT. `media` then processes the file. |
| Who writes the tree | Only `api`, through recorded commands. `media` writes objects and reads the database; it never writes to it. |
| File types | JPEG, PNG, WebP, GIF, TIFF, AVIF and PDF, up to 50 MB, identified by their bytes. |
| Avatar source | Any of the person's photos, or a new upload, which is then also added to their photos. |
| Tagging | Many-to-many through the existing `person_media`. |
| Captions | `caption` and `date` (free text) on `media`, so they are shared by everyone the photo is tagged with. |
| Crop library | Cropper.js 1.6 (MIT, no framework, touch pinch-zoom), set up as a fixed circle you move the image under. It loads only with the editing chunk. |
| Display size | 2000px on the long edge, WebP quality 80. Thumbnails stay 320px WebP quality 75, as made by `uploadMedia.js`. Avatars are 400×400 WebP quality 85. |

## Neon setup

| Item | Development | Production (at release) |
|---|---|---|
| Neon branch | `photos`, a child of `editing`, so it has the dev accounts and the dev auth configuration. DB tests use `test-photos`. | `production` |
| Functions | `neon.ts` gains `media: { name: "ged-eye media", source: "media/index.js", externalPackages: ["sharp"] }`. `neon deploy` deploys both Functions to the branch. | `neon deploy --branch production --no-env-pull` |
| Front-end env | `.env.development.local` (gitignored) gains `VITE_MEDIA_API_URL` for the `photos` branch, alongside the other three. | `.env.production` gains `VITE_MEDIA_API_URL`. |

The `media` Function reads `AWS_*` (storage), `DATABASE_URL`, `NEON_AUTH_BASE_URL` and `NEON_AUTH_JWKS_URL`, all of which are injected on its branch.

## Step 0: spike (on the `photos` branch, before building)

1. **sharp in the cloud.** Deploy a minimal `media` Function that imports sharp. Have it process the biggest existing original (the 31 MB PNG) and a typical 12 MP JPEG, and record the time and peak memory (2048 MiB is fixed).
2. **Presigned PUT from the browser.** Sign `Content-Type` and `Content-Length`, then PUT from a localhost page.
   - Confirm that a mismatched length or type is refused.
   - If it isn't, the 50 MB limit is enforced by the process step only, which re-checks the size anyway.
3. **Storage credentials.** The Function's injected credentials can GET, PUT and DELETE objects, and HEAD works on the public URL without credentials.
4. **Location detection.** Make a test JPEG carrying GPS tags (sharp `withExif`). Check that it is detected and that the re-encoded copy has neither GPS nor any other EXIF, and is rotated correctly.

The findings go in a "Spike findings" note at the end of this file.

## Storage layout

All keys are immutable and stored with `Cache-Control: public, max-age=31536000, immutable`, except `incoming/`. `<sha>` is the sha256, in hex, of the file as uploaded.

| Key | Content |
|---|---|
| `incoming/<uuid>` | A temporary upload, deleted once processed (or once rejected as unsupported). |
| `originals/<sha>.<ext>` | The uploaded file, byte for byte, unless it contains location data (see "Processing"). Stored with `Content-Disposition: inline; filename*=UTF-8''<name>`, so PDFs open in the phone's viewer. |
| `display/<sha>.webp` | Images only: oriented, 2000px on the long edge, never enlarged. |
| `thumbs/<sha>.webp` | Images only: oriented, 320px, never enlarged. This is the existing format. |
| `avatars/<sha>-<crop12>.webp` | A 400×400 crop. `<crop12>` is the first 12 hex digits of the sha256 of the crop rounded to 4 decimal places, so the same crop always gives the same key. Legacy `avatars/<sha>.jpg` keys stay valid. |

`<ext>` comes from the detected type: `jpg`, `png`, `webp`, `gif`, `tif`, `avif` or `pdf`.

## Data model (migration `008_photos.sql`)

```sql
alter table media
  add column display_key text,
  add column width   int,       -- oriented pixel size; null for PDFs and not-yet-backfilled media
  add column height  int,
  add column caption text,
  add column date    text;      -- free text, like the facts' dates ("about 1923", "JUN 1923")
alter table person add column avatar_source jsonb;  -- {"mediaId": 123, "crop": {"x":…, "y":…, "w":…, "h":…}}
```

- **Change log.** Both tables are already captured by 006's triggers, and `toggle_change` compares changes column by column, so the new columns are recorded and undoable with no change to 006's functions.
- **`avatar_source`** is a soft reference with no foreign key, so 006's FK checks need no new case. A `mediaId` that no longer exists means Change avatar starts afresh instead of reopening the old crop.
- **`person_record`** is redefined, copying 007 verbatim apart from these changes:
  - Each photo becomes `{id, key, thumbKey, displayKey, fileName, contentType, caption, date, width, height, people}`. `people` is `[{id, name}]`, everyone the photo is tagged with, in `display_name` order. Null keys are stripped.
  - The person gains `avatarSource`, which is omitted when null.
- **Masking.** Captions are masked for non-editors the way notes are (`api/privacy.js`), and `VIEW_VERSION` is bumped.
- **Position.** New links take `position = min(position) - 1` for that person, so new photos come first and the old order is kept. Within one batch, the first file chosen comes first.
- **`original_path`** (not null) is `upload/<file name>` for uploaded media.

## Function `media`

`media/index.js` and `media/handler.js`, with the processing in `media/imaging.js` (pure functions of a buffer, shared with the backfill script).

- It reuses `api/auth.js` (JWT and `requireEditor`), `api/http.js` (JSON, errors and CORS) and `api/db.js` (read-only queries).
- Every route except `/health` and preflight requires an editor.
- CORS matches `api`.

| Method & path | Body | Result |
|---|---|---|
| `POST /uploads` | `{fileName, contentType, byteSize}` | Checks that `byteSize` is between 1 and 52,428,800, and that the declared type is in the allowed list. Returns `{uploadId, url, headers}`: a presigned PUT for `incoming/<uploadId>` that expires in 15 minutes, with `Content-Type` and `Content-Length` signed. |
| `POST /uploads/:id/process` | `{fileName}` | Processes `incoming/<id>` (see below). Returns `{media}`, where `media` is `{mediaId \| null, sha256, objectKey, displayKey, thumbKey, contentType, byteSize, width, height, fileName}`. `mediaId` is set when a `media` row with this sha already exists. Idempotent. |
| `POST /avatars` | `{objectKey, crop: {x, y, w, h}}` | Renders the crop from `objectKey`, which must match `^originals/[0-9a-f]{64}\.[a-z0-9]+$` and be an image. Returns `{avatarKey}`. Idempotent. |

**Processing** (`imaging.js`, run by `/process` and by the backfill)

1. **Size and type.**
   - Read the object and recheck its size (`too_large`, `empty`).
   - Sniff the type from the magic bytes. The sniffed type wins over the declared one.
   - HEIC/HEIF gives `heic_unsupported`; anything outside the list gives `unsupported_type`.
2. **Dedupe.** Work out the sha256. If a `media` row with that `sha256` exists (the import used the same hash of the file as uploaded), return that row's fields with its `mediaId`, and write nothing.
3. **Images.**
   - Read metadata with `limitInputPixels: 100_000_000` (otherwise `too_many_pixels`).
   - Location is present when EXIF IFD0 has a GPSInfo pointer (tag `0x8825`) or the XMP mentions `GPSLatitude`.
   - If it is present, the stored original is re-encoded in the same format: `.rotate()`, `.keepIccProfile()`, no other metadata, at JPEG/WebP quality 92, lossless PNG, LZW TIFF, AVIF quality 70, or GIF. Otherwise the bytes are stored unchanged.
   - Write `display` and `thumbs`, taking the first frame of animated images.
   - `width` and `height` are the oriented size, swapped for EXIF orientations 5–8.
4. **PDFs.** Stored unchanged, with no derivatives.
5. **Clean up.** Delete `incoming/<id>` after success or after a permanent rejection. Leave it in place after a transient failure, so Retry can re-run `/process`.

**Avatar crop.** `crop` is given as fractions of the oriented image.

- **Validity:** `0 ≤ x, y`, `w, h > 0`, `x + w ≤ 1.0001` and `y + h ≤ 1.0001`. The pixel crop must be square to within 1%, and at least 32px.
- **Rendering:** the server takes the side as `round(min(w·W, h·H))` from the oriented original, then resizes to 400×400.

**Errors:** `400 invalid`, `400 unsupported_type`, `400 heic_unsupported`, `413 too_large`, `400 empty`, `400 too_many_pixels`, `404 not_found` (an expired or unknown upload), `401`, `403 not_an_editor`, and `500 internal` (logged).

## API changes (Function `api`)

**Upload check.** Before recording new media, `api` checks the upload exists with an unauthenticated `HEAD` of `${AWS_ENDPOINT_URL_S3}/ged-eye-media/<key>` for each key.

- `content_type` and `byte_size` come from the original's HEAD response, not from the client.
- A missing object gives `400 missing_upload`.
- Keys must match `^(originals|display|thumbs)/[0-9a-f]{64}(\.[a-z0-9]+)?$`, and `^avatars/[0-9a-f]{64}-[0-9a-f]{12}\.webp$` for avatars.

**Commands.** These are new modules in `api/commands/`. Each runs as one recorded change.

| Kind | Params | Effect | Summary |
|---|---|---|---|
| `add_photos` | `{personId, photos: [{media, caption, date, personIds}]}`, 1–20 photos. `media` is the `/process` result; with a `mediaId` it links the existing row. `personIds` is non-empty and includes `personId`. | Inserts `media` rows for new uploads; a sha that appeared meanwhile is reused. Links every tagged person at the front; existing links are left alone. | "Added 2 photos for Alice Smith" |
| `update_photo` | `{mediaId, caption, date, personIds}`, where `personIds` is the full, non-empty set | Updates `caption` and `date`, and adds or removes links to match. | "Edited a photo of Alice Smith" |
| `remove_photo` | `{personId, mediaId}` | Deletes that one link. The `media` row stays, even with no links left. | "Removed a photo from Alice Smith" |
| `set_avatar` | `{personId, mediaId \| photo, crop, avatarKey}`. `photo` is one `add_photos` item, used for an upload made in the avatar flow. | Requires the photo to be an image linked to the person; `photo` links it first. Sets `avatar_key` and `avatar_source`. | "Changed the avatar of Bert Jones" |
| `clear_avatar` | `{personId}` | Sets `avatar_key` and `avatar_source` to null. | "Removed the avatar of Bert Jones" |

- **Validation.** Captions are at most 500 characters, dates at most 100, and both are trimmed; empty becomes null.
- **Unknown records.** An unknown person or media gives `404 not_found`. A photo not linked to the person gives `400 invalid` (`field: 'mediaId'`).
- **Response.** As for other commands, the result's `view` is the focus person's unmasked view. `personIds` lists everyone whose photos changed, so their cached views are invalidated.
- **Front end.** `changeMessages.js` and the History panel get labels for the five kinds.

## Front end

Everything for editors lives in the lazy editing chunk, so viewers download no upload, crop or Cropper.js code.

| File | Responsibility |
|---|---|
| `src/media.js` | Adds `displayUrl(photo)`, which uses the display key, else the original for images (until the backfill), else null. |
| `src/mediaApi.js` (new) | `requestUpload`, `uploadFile(slot, file, {onProgress, signal})` (XHR, for progress), `processUpload(id, fileName)` and `renderAvatar(objectKey, crop)`. Uses `editApi`'s authenticated fetch and error mapping, against `VITE_MEDIA_API_URL`. |
| `src/uploadQueue.js` (new) | One state machine per file, with no DOM: `queued → uploading(progress) → processing → ready(media) \| failed(error, retryable)`. It runs two at a time; `cancel()` aborts in-flight uploads and `retry(item)` restarts a failed one. |
| `src/personPicker.js` (new) | The "search the tree" input and results, moved out of `relativeDialog.js`, which now uses it. Selected people show as chips with ×. |
| `src/addPhotosDialog.js` (new) | The Add photos sheet. Each file is a card: a preview (an object URL, swapped for the server thumbnail when ready), progress or status, Caption, Date, and a "Shown for" picker that defaults to the current person. Save sends `add_photos` once every card is ready or removed. Closing during uploads asks first. |
| `src/avatarDialog.js` (new) | Change avatar: a grid of the person's image photos, "Upload new", and "Remove avatar" when there is one. Choosing a photo opens the cropper; Save renders the crop and sends `set_avatar`. |
| `src/avatarCropper.js` (new) | Wraps Cropper.js. It loads the display image, with a fixed circular crop area you can't move or resize, the image dragged and pinched underneath, a zoom slider, and arrow keys and +/− for keyboard users. It starts from `avatarSource.crop` when that crop's photo is chosen, else a centred square 80% of the shorter side, and returns fractions. |
| `src/photoEditDialog.js` (new) | Caption, date and people for one photo, sending `update_photo`. |
| `src/photoViewer.js` | Shows the display image, the caption and date, and the tagged people as links (opening that person closes the viewer), plus "Download original". Takes optional editor hooks `{onEdit, onUseAsAvatar, onRemove}`, which render Caption, Avatar, People and Remove. Remove confirms first; the toast offers Undo. |
| `src/personDetails.js` | The header shows the avatar, or the placeholder, beside the name. For editors it has a camera badge that opens Change avatar. The photo row shows "+N" on the 4th thumbnail when there are more, and an Add tile for editors. Editors can also drop files onto the panel. |
| `src/editing.js`, `src/main.js` | Wire up the new dialogs and the viewer hooks, and invalidate and reload after each change, as existing commands do. |

**Mobile behaviour**

- The file input is `accept="image/*,application/pdf" multiple`, with no `capture` attribute, so the phone offers library, camera and files.
- Sheets are full screen below 768px (the existing rule). The action bar sticks to the bottom with `env(safe-area-inset-bottom)` padding.
- The crop area is `touch-action: none`, at most `min(60vh, 100%)` tall. Buttons are at least 44px.
- `beforeunload` warns while uploads are in flight.

## Error handling

| Situation | Behaviour |
|---|---|
| Unsupported or too-large file | The card shows the reason and a Remove button, for example "This HEIC file couldn't be read. Export it as JPEG and try again." or "PDFs and images only, up to 50 MB." |
| Network failure during upload or processing | The card shows "Upload failed" and Retry. Retry reuses the upload slot if it hasn't expired, else asks for a new one. |
| Upload slot expired (15 min) | A new slot is requested automatically on Retry. |
| `missing_upload` on Save | The affected card switches to failed with Retry, which re-processes it. The other cards stay ready. |
| Signed out mid-flow | As for other dialogs: the sheet stays open and sign-in is offered. |
| Undo conflicts | Handled by the existing 409 conflict messages. For example, undoing an upload after its caption was edited names the caption edit. |

## Testing

- **Unit tests (vitest, jsdom):**
  - `uploadQueue`: states, concurrency, cancel and retry, slot expiry.
  - Crop maths: fractions to pixels, the square tolerance, orientation swaps.
  - Command validators, plus the existing contract test extended to the five new kinds.
  - `addPhotosDialog`, `avatarDialog`, `photoEditDialog` and the viewer hooks.
  - `personDetails` rendering for viewers and editors.
  - `personPicker`, and `relativeDialog` still passing.
- **`media/imaging.js` tests in Node,** with small fixtures generated by sharp in the test:
  - a JPEG with GPS and orientation 6: the stored original has no GPS and is upright;
  - a JPEG without GPS: stored byte-for-byte;
  - PNG, TIFF, animated GIF and PDF;
  - a HEIC header: `heic_unsupported`;
  - a PDF named `.jpg`: stored as PDF;
  - too many pixels;
  - dedupe;
  - crop validation and determinism.
- **`media` handler tests** with locally signed Ed25519 tokens and a fake S3, in the style of `apiHandler.test.js`.
- **DB tests on `test-photos`:**
  - each command, with undo and redo;
  - batch insert with tags;
  - re-linking an existing sha;
  - undo of `add_photos` blocked by a later caption edit (conflict);
  - `set_avatar` with `photo`, and its undo;
  - `person_record`'s new photo fields and caption masking.
- **Deployed checks on `photos`:**
  - Smoke-test both Functions (sharp loads; upload, process, add, set avatar, undo).
  - Exercise the full flow from the dev server at desktop and phone sizes in the browser pane.
- **Real device:** the developer tries an iPhone (camera and library) and Android if possible. This is the one check that can't be automated here.

## Backfill (`scripts/neon/backfillMedia.js`, `npm run backfill-media`)

- **What it does:** for every image `media` row without a `display_key` (JPEG, PNG, GIF, WebP and TIFF; BMP if sharp can read it), it:
  1. downloads the original;
  2. writes the display image, plus a thumbnail when there is none (the TIFFs);
  3. records `display_key`, `thumb_key`, `width` and `height`.
- **How it records:** all updates go in one `begin_change('backfill@ged-eye.local', 'Media backfill', 'backfill_media', 'script', …)`.
- **Modes:**
  - `--dry-run` prints the plan.
  - `--report-gps` lists originals that contain location data, without changing them.
- **Idempotent:** derivative keys come from the sha, and rows that already have a display key are skipped.

## Rollout

1. **Safety branch:** create `pre-photos-<date>` from production.
2. **Migration:** apply 008 to production. It is additive, and the old Functions and front end ignore the new fields.
3. **Functions:**
   - Deploy `media` to production, smoke-test it (sharp loads), and put its URL in `.env.production`.
   - Deploy `api`.
4. **Backfill:**
   - Rehearse on a branch copied from production, and check the counts and a sample of images.
   - Run it on production.
   - Report the GPS count to the developer.
5. **Verify:**
   - Run `verify-neon`. `verifyCompare` is taught to ignore the new photo fields (`id`, `displayKey`, `caption`, `date`, `width`, `height` and `people`) and `avatarSource`, as it already ignores `masked`.
   - Spot-check the viewer on a TIFF and a large PNG.
6. **Release:** build `docs/` and merge the PR.

**Rollback:** redeploy the previous Functions and front end. Migration 008's columns can stay. No object is ever deleted, so nothing has to be restored.
