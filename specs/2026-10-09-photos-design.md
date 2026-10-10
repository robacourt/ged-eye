# Photos: upload, captions, tagging and avatars: design

**Date:** 2026-10-09
**Status:** Revision 3, approved by the second spec review, after the step 0 spike. The developer approved the three design sections in conversation and asked for it to be written up and built.
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
| Crop library | Cropper.js 1.7, the maintained 1.x line (MIT, no framework, touch pinch-zoom), set up as a fixed circle you move the image under. It loads only with the editing chunk. |
| Display size | 2000px on the long edge, WebP quality 80. Thumbnails stay 320px WebP quality 75, as made by `uploadMedia.js`. Avatars are 400×400 WebP quality 85. |

## Neon setup

| Item | Development | Production (at release) |
|---|---|---|
| Neon branch | `photos` (`br-solitary-darkness-b2jjfmob`), a child of `editing`, so it has the dev accounts and the dev auth configuration. DB tests reuse `test-editing`, whose schema each run resets; this keeps the project under the free plan's branch limit. | `production` |
| Functions | `neon.ts` gains:<br>• `media: { name: "ged-eye media", source: "media/index.js", externalPackages: ["sharp"] }`;<br>• the `sweep-incoming` schedule trigger.<br>`neon deploy` deploys both Functions to the branch. `@aws-sdk/client-s3` moves to `dependencies`, and `@aws-sdk/s3-request-presigner` is added. | `neon deploy --branch production --no-env-pull` |
| Front-end env | `.env.development.local` (gitignored) points all four `VITE_*` values (`VITE_API_URL`, `VITE_MEDIA_BASE_URL`, `VITE_NEON_AUTH_URL`, `VITE_MEDIA_API_URL`) at the `photos` branch. Storage is per branch, so a stale `VITE_MEDIA_BASE_URL` would make new thumbnails 404. | `.env.production` gains `VITE_MEDIA_API_URL`. |

The `media` Function reads `AWS_*` (storage), `DATABASE_URL`, `NEON_AUTH_BASE_URL` and `NEON_AUTH_JWKS_URL`, all of which are injected on its branch.

## Step 0: spike (on the `photos` branch, before building)

1. **sharp in the cloud.** Deploy a minimal `media` Function that imports sharp. Have it process the biggest existing original (the 31 MB PNG) and a typical 12 MP JPEG, and record the time and peak memory (2048 MiB is fixed).
2. **Presigned PUT from the browser.** Sign `Content-Type` and `Content-Length`, then PUT from a localhost page.
   - Confirm that a mismatched length or type is refused.
   - If it isn't, the 50 MB limit is enforced by the process step only, which re-checks the size anyway.
3. **Storage credentials.** The Function's injected credentials can GET, PUT and DELETE objects, and HEAD works on the public URL without credentials.
3b. **Production CORS and listing.** A PUT preflight from the GitHub Pages origin is allowed by the production bucket, and anonymous ListObjects is refused.
4. **Location detection.** Make a test JPEG carrying GPS tags (sharp `withExif`). Check that it is detected and that the re-encoded copy has neither GPS nor any other EXIF, and is rotated correctly.

The findings go in a "Spike findings" note at the end of this file.

## Storage layout

All keys are immutable and stored with `Cache-Control: public, max-age=31536000, immutable`, except `incoming/`. They are written only if absent (as `putOnce` does in `uploadMedia.js`), so an immutable key never changes content. `<sha>` is the sha256, in hex, of the file as uploaded.

| Key | Content |
|---|---|
| `incoming/<uuid>` | A temporary upload. It is deleted once processed, once rejected as unsupported, on Cancel (`DELETE /uploads/:id`), or by the hourly sweep if it is over an hour old. Anonymous listing of the bucket is refused (checked), so these keys can't be discovered. |
| `originals/<sha>.<ext>` | The uploaded file, byte for byte, unless it contains location data (see "Processing"). Stored with:<br>• `Content-Disposition: inline; filename*=UTF-8''<name>`, so PDFs open in the phone's viewer;<br>• `Content-Type` set to the detected type;<br>• for images, the metadata `x-amz-meta-width` and `x-amz-meta-height` (the oriented size), which `api` reads back. |
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
create index person_media_media_idx on person_media (media_id);  -- the photos' people, and verify.js
```

- **Change log.** Both tables are already captured by 006's triggers, and `toggle_change` compares changes column by column, so the new columns are recorded and undoable with no change to 006's functions.
- **`avatar_source`** is a soft reference with no foreign key, so 006's FK checks need no new case. A `mediaId` that no longer exists means Change avatar starts afresh instead of reopening the old crop.
- **`person_record`** is redefined, copying 007 verbatim apart from these changes:
  - Each photo becomes `{id, key, thumbKey, displayKey, fileName, contentType, caption, date, width, height, people}`.
    - Every field is always present, with null when unknown, as `thumbKey` is today.
    - `people` is `[{id, name}]`, everyone the photo is tagged with, ordered by `display_name`, then `id`.
    - Photos are ordered by `pm.position, pm.media_id`, because undo and redo combined with `min - 1` can leave two links with the same position.
  - The person gains `avatarSource`, which is omitted when null.
- **Masking.** Email addresses in captions are masked for non-editors, the way notes are. To do this, `isNoteKey` in `api/privacy.js` is extended to cover `caption`, which also keeps `verify.js` consistent automatically. `VIEW_VERSION` is bumped.
- **Position.** New links take `position = min(position) - 1` for that person, so new photos come first and the old order is kept. Within one batch, the first file chosen comes first.
- **`original_path`** (not null) is `upload/<file name>` for uploaded media.

## Function `media`

`media/index.js` and `media/handler.js`, with the processing in `media/imaging.js` (pure functions of a buffer, shared with the backfill script).

- It reuses `api/auth.js` (JWT and `requireEditor`), `api/http.js` (JSON, errors and CORS) and `api/db.js` (read-only queries).
- Every route except `/health`, preflight and `/sweep` (which takes a trigger delivery) requires an editor.
- CORS matches `api`.

| Method & path | Body | Result |
|---|---|---|
| `POST /uploads` | `{fileName, contentType, byteSize}` | Checks that `byteSize` is between 1 and 52,428,800, and that the declared type is in the allowed list. Returns `{uploadId, url, headers}`.<br>• `url` is a presigned PUT for `incoming/<uploadId>`, expiring in 15 minutes, with `content-type` and `content-length` signed (`signableHeaders`).<br>• `headers` is just `{'Content-Type': …}`, because browsers set `Content-Length` themselves. |
| `POST /uploads/:id/process` | `{fileName}` | Processes `incoming/<id>` (see below). Returns `{media}`: `{mediaId \| null, sha256, ext, objectKey, displayKey, thumbKey, contentType, byteSize, width, height, fileName, caption, date}`.<br>• `mediaId`, `caption` and `date` are set when a `media` row with this sha already exists.<br>• Once processing has succeeded, the incoming object is gone, so calling it again gives `404 not_found`. The client then uploads the file again: it still has the `File`, and dedupe makes the second run cheap. |
| `DELETE /uploads/:id` | | Deletes `incoming/<id>` if it is still there. Used by Cancel, and by removing a card that has uploaded but not been processed. Returns 204. |
| `POST /avatars` | `{objectKey, crop: {x, y, w, h}}` | Renders the crop from `objectKey`, which must match `^originals/[0-9a-f]{64}\.[a-z0-9]+$` and be an image. Returns `{avatarKey}`. Idempotent. |
| `POST /sweep` | (a schedule trigger delivery) | Deletes `incoming/` objects more than an hour old. The trigger `sweep-incoming` (`type: "schedule"`, `cron: "17 * * * *"`, `functionPath: "/sweep"`) is declared in `neon.ts`. The route authenticates the delivery with `parseTriggerDelivery` from `@neon/functions/triggers`, not with a user token. |

`:id` must be a UUID. `fileName` is 1–255 characters after trimming, with no `/`, `\\` or control characters. The same rule is shared with `api`.

**Processing** (`imaging.js`, run by `/process` and by the backfill)

**Memory rules** (from the spike):
- Set `sharp.cache(false)` and `sharp.concurrency(2)`. `limitInputPixels` stays at 100 MP: the spike's 79 MP JPEG peaked at 861 MB even with a full re-encode.
- Make the thumbnail from the display image, not the original.
- Run one image job at a time per isolate. Further requests wait their turn in an in-process queue; the platform adds isolates under load.
  - The download from storage happens *inside* the queued job, so waiting requests hold no file buffers.
  - `/avatars` goes through the same queue.
  - If 4 jobs are already waiting, the next request gets `503 busy`, which the client retries.

1. **Size and type.**
   - Read the object and recheck its size (`too_large`, `empty`).
   - Sniff the type from the magic bytes. The sniffed type wins over the declared one.
   - HEIC/HEIF gives `heic_unsupported`; anything outside the list gives `unsupported_type`.
2. **Dedupe.** Work out the sha256. If a `media` row with that `sha256` exists (the import used the same hash of the file as uploaded), return that row's fields with its `mediaId`, and write nothing.
3. **Images.**
   - Read metadata with `limitInputPixels: 100_000_000` (otherwise `too_many_pixels`).
   - Location is present when EXIF IFD0 has a GPSInfo pointer (tag `0x8825`) or the XMP mentions `GPSLatitude`.
   - If it is present, the stored original is re-encoded in the same format: `.rotate()`, `.keepIccProfile()`, no other metadata, at JPEG/WebP quality 92, lossless PNG, LZW TIFF (read with `pages: -1`, so multi-page scans keep every page), or AVIF quality 70. Otherwise the bytes are stored unchanged.
   - GIFs have no EXIF orientation. One carrying location XMP is re-encoded with `animated: true` and no `.rotate()`, which keeps every frame.
   - **TIFF and GIF location** is read from the file's own bytes, because sharp 0.33.5 exposes neither a TIFF's EXIF nor a GIF's XMP (found in Task 3).
     - A TIFF is itself a TIFF/EXIF structure, so `hasGps(buffer)` finds a GPSInfo pointer in its first IFD.
     - A GIF counts as having location when its bytes contain `GPSLatitude`.
     - TIFFs and GIFs without location are stored byte for byte.
   - Write `display` and `thumbs`, taking the first frame of animated images.
   - `width` and `height` are the oriented size, swapped for EXIF orientations 5–8.
4. **PDFs.** Stored unchanged, with no derivatives.
5. **Clean up.** Delete `incoming/<id>` after success or after a permanent rejection. Leave it in place after a transient failure, so Retry can re-run `/process`.

**Avatar crop.** `crop` is given as fractions of the oriented image. A shared module, `media/crop.js`, validates it and computes the key, and both Functions use it.

- **Validity:** `0 ≤ x, y`, `w, h > 0`, `x + w ≤ 1.0001` and `y + h ≤ 1.0001`. The pixel crop must be square to within 1%, and at least 32px.
- **Rendering:** the server takes the side as `round(min(w·W, h·H))` from the oriented original, then resizes to 400×400.

**Errors:** `400 invalid`, `400 unsupported_type`, `400 heic_unsupported`, `400 unreadable` (sharp can't decode or re-encode the file), `413 too_large`, `400 empty`, `400 too_many_pixels`, `404 not_found` (an expired or unknown upload), `401`, `403 not_an_editor`, and `500 internal` (logged).

## API changes (Function `api`)

**Upload check.** The client never sends object keys. A new upload is described by `upload: {sha256, ext, fileName}`, and `api` works out everything else from the objects themselves.

- **Keys:** `api` derives `originals/<sha>.<ext>`, plus `display/<sha>.webp` and `thumbs/<sha>.webp` for images. `sha256` must be 64 hex characters and `ext` one of the allowed extensions.
- **HEAD checks:** it sends unauthenticated `HEAD`s of `${AWS_ENDPOINT_URL_S3}/ged-eye-media/<key>` for the original and, for images, the display image.
- **Data taken from the objects, not the client:**
  - `content_type`, which must match `ext`, and `byte_size` come from the original's response;
  - `width` and `height` come from its `x-amz-meta-*` headers. A public, anonymous HEAD does return these headers (checked on the `photos` branch). If an image original lacks them, `width` and `height` are stored as null.
- **Timing:** commands get an optional async `prepare(params)` step, which `runChange` calls after `validate` and *before* `beginChange`. The HEADs therefore run in parallel (at most 8 at a time, 5 s timeout each) without holding the global lock or an open transaction, and `run` receives the results.
- **Errors:** a missing object gives `400 missing_upload` (with the photo's index), and a timeout gives `503 busy`.
- **Avatars:** `avatarKey` must match `^avatars/<sha of the chosen media>-[0-9a-f]{12}\.webp$` and equal the key `media/crop.js` computes from the crop. It is HEAD-checked the same way.

**Commands.** These are new modules in `api/commands/`. Each runs as one recorded change.

| Kind | Params | Effect | Summary |
|---|---|---|---|
| `add_photos` | `{personId, photos: [{upload \| mediaId, caption, date, personIds}]}`, 1–20 photos. `personIds` is non-empty and includes `personId`. No sha or `mediaId` may appear twice in one batch (`400 invalid`); the dialog merges duplicates before saving. | Inserts `media` rows for new uploads; a sha that gained a row meanwhile is reused. For an existing row, `caption` and `date` only fill fields that are null and never overwrite a shared caption. Links every tagged person at the front; existing links are left alone. If nothing changes (every link already exists and no empty caption or date was filled), it returns `400 no_change`, and the dialog closes with "Already shown for everyone selected". Filling an empty caption on an already-linked photo is recorded, as "Edited a photo of X". | "Added 2 photos for Alice Smith" |
| `update_photo` | `{mediaId, caption, date, personIds, expected: {caption, date, personIds}, focusId?}`, where `personIds` is the full, non-empty set | Checks `expected` against the stored values (`409 stale` on any difference, as `update_family` does), then updates `caption` and `date` and adds or removes links to match. `focusId` chooses whose view is returned, even when the edit untags them, so the editor stays on their page; when it is missing or that person no longer exists, it is the first of `personIds`. | "Edited a photo of Alice Smith" |
| `remove_photo` | `{personId, mediaId}` | Deletes that one link. The `media` row stays, even with no links left. If the link is already gone (another editor removed it), it returns `409 stale`. | "Removed a photo from Alice Smith" |
| `set_avatar` | `{personId, mediaId \| photo, crop, avatarKey}`. `photo` is one `add_photos` item, used for an upload made in the avatar flow. | Requires the photo to be an image (with a display image) linked to the person; `photo` links it first. Sets `avatar_key` and `avatar_source`. It does not bump `person.updated_at` and takes no `expectedUpdatedAt`, so an open person editor isn't made stale; `toggle_change` bumps `updated_at` on undo and redo anyway. | "Changed the avatar of Bert Jones" |
| `clear_avatar` | `{personId}` | Sets `avatar_key` and `avatar_source` to null. Like `set_avatar`, it leaves `updated_at` alone. | "Removed the avatar of Bert Jones" |

- **Validation.** Captions are at most 500 characters, dates at most 100, and both are trimmed; empty becomes null.
- **Unknown records.** An unknown person or media gives `404 not_found`. A photo not linked to the person gives `400 invalid` (`field: 'mediaId'`).
- **Response.** As for other commands, the result's `view` is the focus person's unmasked view. `personIds` lists everyone whose photos changed, which is what History's per-person filter uses. The front end already calls `invalidateAll()` after every change.
- **Redo after re-upload.** If `add_photos` is undone and the same file is then uploaded again, the new upload gets a new `media` row. Redoing the original change then hits the `sha256` unique constraint and gets the existing generic "constraint" conflict message. This is accepted and covered by a DB test.

## Front end

Everything for editors lives in the lazy editing chunk, so viewers download no upload, crop or Cropper.js code.

| File | Responsibility |
|---|---|
| `src/media.js` | Adds `displayUrl(photo)`, which uses the display key, else the original for images (until the backfill), else null. |
| `src/mediaApi.js` (new) | `requestUpload`, `uploadFile(slot, file, {onProgress, signal})` (XHR, for progress), `processUpload(id, fileName)`, `discardUpload(id)` and `renderAvatar(objectKey, crop)`. Uses `editApi`'s authenticated fetch and error mapping against `VITE_MEDIA_API_URL`; `editApi.apiUrl` gains a base-URL parameter for this. |
| `src/uploadQueue.js` (new) | One state machine per file, with no DOM: `queued → uploading(progress) → processing → ready(media) \| failed(error, retryable)`.<br>• It runs two at a time.<br>• `cancel()` aborts in-flight uploads and discards uploaded but unprocessed ones.<br>• `retry(item)` restarts a failed one. A 404 from processing re-uploads the file with a new slot.<br>• A `503 busy` is retried once by itself after about 3 seconds; a second one fails the file, retryably.<br>• Two files with the same sha are merged into one card ("Same as photo 1"). |
| `src/personPicker.js` (new) | The "search the tree" input and results, moved out of `relativeDialog.js`, which now uses it. Selected people show as chips with ×. |
| `src/addPhotosDialog.js` (new) | The Add photos sheet. Each file is a card with:<br>• a preview: an object URL, swapped for the server thumbnail when ready;<br>• progress or status;<br>• Caption and Date;<br>• a "Shown for" picker that defaults to the current person.<br>A file already in the tree shows "Already in the tree", with any existing caption shown read-only. Save sends `add_photos` once every card is ready or removed. Closing during uploads asks first. |
| `src/avatarDialog.js` (new) | Change avatar: a grid of the person's image photos that have a display image (TIFFs only qualify once backfilled), "Upload new", and "Remove avatar" when there is one. Choosing a photo opens the cropper; Save renders the crop and sends `set_avatar`. |
| `src/avatarCropper.js` (new) | Wraps Cropper.js. It loads the display image, with a fixed circular crop area you can't move or resize, the image dragged and pinched underneath, a zoom slider, and arrow keys and +/− for keyboard users. It starts from `avatarSource.crop` when that crop's photo is chosen, else a centred square 80% of the shorter side, and returns fractions. |
| `src/photoEditDialog.js` (new) | Caption, date and people for one photo. It sends `update_photo` with `expected` set to the values it opened with, and a 409 `stale` offers "Reload". |
| `src/photoViewer.js` | Shows the display image, the caption and date, and the tagged people as links (opening that person closes the viewer), plus "Download original". Takes optional editor hooks `{onEdit, onUseAsAvatar, onRemove}`, which render Caption, Avatar, People and Remove. Remove confirms first; the toast offers Undo. |
| `src/personDetails.js` | The header shows the avatar, or the placeholder, beside the name. For editors it has a camera badge that opens Change avatar. The photo row shows "+N" on the 4th thumbnail when there are more, and an Add tile for editors. Editors can also drop files onto the panel. |
| `src/editing.js`, `src/main.js` | Wire up the new dialogs and the viewer hooks, and invalidate and reload after each change, as existing commands do. Before the photo editor opens, a person whose cached view is masked is reloaded unmasked, as for the person editor, so a masked caption is never edited or sent as `expected`. |

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
| `missing_upload` on Save | The affected card switches to failed with Retry, which re-processes it (re-uploading on 404). The other cards stay ready. |
| Someone else edited the photo | `update_photo` gets 409 `stale`: "Someone else changed this photo. Reload to see their changes." |
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
  - a TIFF with GPS;
  - a JPEG without GPS: stored byte-for-byte;
  - PNG, TIFF, animated GIF and PDF;
  - a HEIC header: `heic_unsupported`;
  - a PDF named `.jpg`: stored as PDF;
  - too many pixels;
  - dedupe;
  - crop validation and determinism.
- **`media` handler tests** with locally signed Ed25519 tokens and a fake S3, in the style of `apiHandler.test.js`. They cover UUID and file-name validation, `DELETE /uploads/:id`, `/sweep` with and without a valid trigger delivery, and the 404 after a completed `/process`.
- **`api` handler tests:** the `prepare` step runs before the lock (no transaction is open during the HEADs); keys are derived and checked; `avatarKey` must match the crop.
- **DB tests on `test-editing`:**
  - each command, with undo and redo;
  - batch insert with tags;
  - re-linking an existing sha;
  - undo of `add_photos` blocked by a later caption edit (conflict);
  - `set_avatar` with `photo`, and its undo;
  - `update_photo` with a stale `expected`, giving 409;
  - `add_photos` that changes nothing, giving `no_change`, and a duplicate sha in one batch, giving `invalid`;
  - redo of an undone `add_photos` after the same file was re-uploaded, giving a conflict, not a 500;
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
- **Short lock:** it first processes and uploads every derivative, with no transaction open. Only then does it open one short transaction with `begin_change` and the row updates, so the global lock is held for well under a second, not for minutes.

## Rollout

The new front end goes live **before** the backfill. The live front end ignores the fields migration 008 adds, but it takes any photo with a `thumbKey` to be an image and shows its original in an `<img>`. The backfill fills `thumb_key` for the 5 TIFF scans, so with the old front end still live they would become `.tif` images that most browsers can't show.

1. **Safety branch:** create `pre-photos-<date>` from production.
2. **Migration:** apply 008 to production. It is additive: the live Functions pass `person_record`'s new fields through and the live front end ignores them, and no column they read changes until the backfill (step 6).
3. **Functions:** deploy `media` and `api` to production, and smoke-check them: `media`'s `/health`, a 401 for an unauthenticated upload, and the `sweep-incoming` trigger.
4. **Front-end env:** put `media`'s production URL in `.env.production` as `VITE_MEDIA_API_URL`.
5. **Front end:** build `docs/`, commit it, then merge the PR. GitHub Pages serves `main`'s `docs/`, so the new front end is live once the PR is merged. Until the backfill it shows imported images from their originals, as now, and the TIFFs as documents.
6. **Backfill** on production:
   - Report the GPS count (`--report-gps`) to the developer.
   - A dry run, then the real run with `--confirm`.
   - There is no separate rehearsal branch. The backfill was rehearsed on the `photos` development branch, which has the same 544 images as production, and this keeps the project within the free plan's 10 branches.
7. **Verify:**
   - Run `verify-neon`. `verifyCompare` needs no change: it compares only sha, `fileName` and `contentType` per photo. Two changes go into `verify.js` before the backfill:
     - `EDITED_SQL` ignores `media` rows changed by `kind = 'backfill_media'` changes, and by undo or redo changes whose `base_change_id` points at one. Otherwise the backfill would mark everyone with a photo, and their relatives, as edited, and verification would skip them.
     - The missing-bucket-objects check also covers `display_key`.
   - Spot-check the viewer on a TIFF and a large PNG.

**Rollback:** redeploy the previous Functions and front end. Migration 008's columns can stay. No object is ever deleted, so nothing has to be restored. After the backfill, though, the previous front end would show the 5 TIFF scans as broken images.

## Spike findings (2026-10-09, `photos` branch)

1. **sharp in the cloud.** sharp 0.33.5 with libvips 8.15.3 loads on the linux-arm64 runtime through `externalPackages`.
   - **Timings** (process step, excluding a 0.1–0.4 s fetch):
     - 18 MP JPEG (2 MB): 0.4 s
     - 79 MP JPEG (11 MB): 1.3 s, or 2.4 s with a full re-encode
     - 24 MP PNG (31 MB) with a re-encode: 2.5 s
     - TIFF scan (13 MB): 0.6 s
   - **Memory, before tuning:** with sharp's defaults (cache on, the original decoded three times), the 79 MP JPEG peaked at 1.4 GB RSS. Memory then accumulated across requests, and an isolate died on the following request.
   - **Memory, after tuning:** with the memory rules above, the same image peaks at 408 MB, or 861 MB with the re-encode, and RSS returns to about 175 MB afterwards.
2. **Presigned PUT.**
   - Signing `content-type` and `content-length` (`signableHeaders`) is enforced: a different type or a longer body gets 403.
   - A browser `XMLHttpRequest` PUT from `http://localhost:5175` succeeds through CORS, fires upload progress events, and the object is publicly readable straight away.
3. **Storage credentials.** The Function's injected credentials PUT and DELETE objects. An unauthenticated HEAD of the public URL gives 200, then 404 after the delete.
3b. **Production CORS and listing.**
   - A PUT preflight from `https://robacourt.github.io` to the *production* bucket is allowed (`access-control-allow-origin: *`).
   - Anonymous ListObjects is refused with 403 on both branches.
4. **Location detection.**
   - A GPSInfo pointer (`0x8825`) in IFD0 of sharp's `metadata().exif` reliably shows that GPS is present.
   - `.rotate().keepIccProfile().jpeg({quality: 92})` drops all EXIF and applies the orientation: a 400×200 image with orientation 6 becomes 200×400.
   - Display WebP images carry no EXIF.
5. **Not covered:** iPhone picker behaviour (HEIC to JPEG) needs a real device, and is checked at the end.
