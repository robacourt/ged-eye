<div align="center" style="background-color: #1a1a1a; padding: 20px; border-radius: 10px;">
  <img src="GED-eye.png" alt="GED-eye Logo" width="400">
</div>

# GED-Eye

A modern, interactive family tree viewer for GEDCOM files. Because other family tree viewers look like they're stuck in 1999.

See it live [here](https://robacourt.github.io/ged-eye) showing my family tree!

## What is this?

GedEye takes GEDCOM genealogy files and turns them into a beautiful, interactive web-based family tree visualization. Click on any person to see their immediate family - parents, spouses, and children - all rendered as an animated graph.

## Features

- 🎯 **Interactive visualization** - Click any person to make them the focus
- 🚀 **One request per person** - A Neon Function returns a person and their whole immediate family in a single call, and relatives are prefetched while you look
- 🖼️ **Photos and avatars** - Served straight from a public Neon Object Storage bucket. Editors can upload photos, caption and tag them, and crop avatars ([Photos](#photos))
- 🎨 **Modern UI** - Built with Cytoscape.js for smooth graph rendering
- ⚡ **Fast** - Handles thousands of people without breaking a sweat
- 🎭 **Gender color coding** - Blue for males, pink for females
- 📊 **Relationship lines** - Visual connections between family members

## Quick Start

The front end talks to the live API and bucket, so all you need is Node:

```bash
# Install dependencies
npm install

# Start the dev server
npm run dev

# Open http://localhost:5173/ged-eye/ in your browser
```

To build the site for GitHub Pages:

```bash
npm run build    # writes the static site to docs/
```

Commit `docs/` and merge to `main`; GitHub Pages serves it.

### Neon setup

Only needed if you're touching the backend (database, Function or bucket). Install the Neon CLI, then:

```bash
neon link        # link this folder to the GED-Eye project; writes .neon and .env.local
neon env pull    # refresh .env.local later
neon deploy      # deploy the api and media Functions, the sweep-incoming trigger and the bucket declared in neon.ts
```

### Importing the tree (one-off, retired)

Neon is the master copy of the tree. `acourt.ged` was imported once, before editing arrived; the steps are kept here for reference. They ran in this order, against a database migrated only as far as 005:

```bash
npm run upload-media   # originals, thumbnails and avatars → ged-eye-media bucket (resumable)
npm run db:migrate     # apply db/migrations/*.sql
npm run import-ged     # load people, families and photos, and archive the GEDCOM
neon deploy            # deploy the api Function
npm run verify-neon    # parity check against the old JSON files; exits non-zero on any unexplained difference
```

- **After migration 006, `import-ged` is retired.** The tables' capture trigger refuses its inserts because they aren't recorded in a change, and `--replace` is refused by the `TRUNCATE` guard. Loading data again means writing a script that opens a change first (see [Editing](#editing)).
- The old JSON files and avatars (the parity baseline) now live outside the repo in `ignore/legacy-data/`. `upload-media`, `import-ged` and `verify-neon` read them from there by default; pass `--legacy-root <dir>` to point elsewhere.
- `scripts/generateAvatars.js` is legacy: it face-crops avatars from the old JSON files. Avatars are now chosen and cropped by editors ([Photos](#photos)), and nothing runs it any more.

### Backfilling facts (one-off, 2026-10)

The first import used a parser that dropped continuation lines, census transcriptions and most events. `backfill-facts` re-derives `person.facts` from the archived GEDCOM with the full parser, without touching anything else:

```bash
npm run backfill-facts                                         # read-only plan → .neon-import/facts-backfill-plan-<host>.json, plus a summary
npm run backfill-facts -- --apply <plan> --confirm <host>      # compare-and-swap the plan in, in one transaction
npm run backfill-facts -- --rollback <plan> --confirm <host>   # put the plan's "before" back
```

- It only writes `person.facts`. It skips (and lists) anyone edited since the import, i.e. anyone whose `updated_at` has moved; the backfill itself never changes `updated_at`.
- An apply writes exactly the reviewed plan or nothing. If any planned row has changed since the plan was made, nothing is written.
- **Keep the plan file: it is the rollback.** The CLI never overwrites an existing plan file; pass `--out <path>` for a new one.
- Rollback has the same guard. Once editing starts, rows edited after the backfill can only be restored from the `pre-facts-backfill-2026-10-09` Neon branch.
- To run it against another branch (the rehearsal used one), put `DATABASE_URL_UNPOOLED=<url>` in a mode-600 env file and run `node --env-file=<file> scripts/neon/backfillFacts.js …`. `--database-url <url>` also works, but it puts the password in shell history. `--sha <sha256>` picks an archive row if there is ever more than one.

### Configuration

| File | Committed | What's in it |
|---|---|---|
| `.env.development`, `.env.production` | yes | `VITE_API_URL` (the `api` Function), `VITE_MEDIA_BASE_URL` (the bucket), `VITE_NEON_AUTH_URL` (sign-in) and `VITE_MEDIA_API_URL` (the `media` Function, for uploads). Public values that end up in the JS bundle anyway. `VITE_MEDIA_API_URL` is empty in `.env.development`, and without it the site has no upload controls. |
| `.env.development.local` | no | Overrides of the four `VITE_*` values, to point `npm run dev` at a development branch such as `editing` or `photos`. All four must point at the same branch. |
| `.env.local` | no | Secrets written by `neon link` / `neon env pull`: database URLs and bucket keys. |
| `.env.test.local` | no | `DATABASE_URL_TEST`, for `npm run test:db`. |
| `.env.dev-accounts.local` | no | Passwords of the development accounts on the `editing` branch (and `photos`, its child). Never commit it. |
| `neon.ts` | yes | Neon resources: Auth, the `api` and `media` Functions, the `sweep-incoming` trigger and the `ged-eye-media` bucket. |

There's deliberately no plain `.env`: the Neon CLI writes secrets into `.env` whenever that file exists.

## Project Structure

```
├── acourt.ged              # The original GEDCOM (local only; archived in Neon)
├── Data/                   # Media the GEDCOM points at (local only; uploaded to the bucket)
├── neon.ts                 # Neon resources: api + media Functions, sweep-incoming trigger, ged-eye-media bucket
├── api/
│   ├── index.js            # Neon Function entry: Postgres pool
│   ├── handler.js          # Routes: person, search, me, changes, undo/redo, editors
│   ├── auth.js             # Verifies Neon Auth tokens
│   ├── changes.js          # Runs edit commands as recorded changes
│   ├── commands/           # One module per edit command (update_person, add_relative, …)
│   ├── uploads.js          # Checks uploaded photos exist in the bucket before they are recorded
│   ├── db.js, tx.js        # The handler's database calls; the write transaction
│   └── privacy.js          # Masks email addresses found in note text and photo captions
├── media/                  # Neon Function for photos (sharp): upload slots, processing, avatar crops, sweep
│   ├── index.js, handler.js
│   └── imaging.js          # Type sniffing, location stripping, display and thumbnail images
├── db/migrations/          # Schema and the person_view() Postgres function
├── scripts/
│   ├── gedTree.js          # GEDCOM lines → node tree (CONT/CONC folded in)
│   ├── gedParser.js        # INDI/FAM records and extractPersonData
│   ├── gedFacts.js         # A person's notes, occupations, census records and other facts
│   ├── generateAvatars.js  # Legacy avatar face-cropper (reads the old JSON)
│   └── neon/               # Import, migrate, verify, the backfills, and the media smoke tests
├── src/
│   ├── main.js             # App entry point (DEFAULT_PERSON_ID)
│   ├── dataLoader.js       # Fetches, caches and prefetches person views
│   ├── media.js            # Bucket URLs for photos and avatars
│   ├── familyTreeView.js   # Cytoscape graph visualization
│   ├── personDetails.js    # Details panel
│   ├── factLabels.js       # Labels for GEDCOM fact tags (_MILT → Military service)
│   ├── html.js             # escapeHtml
│   ├── photoViewer.js      # Photo viewer: display image, caption, tagged people
│   ├── mediaApi.js         # Calls to the media Function (uploads, avatar crops)
│   ├── uploadQueue.js      # Upload state machine: upload, process, retry, cancel
│   ├── addPhotosDialog.js  # Add photos sheet (also photoEditDialog.js, personPicker.js)
│   ├── avatarDialog.js     # Change avatar (crop with avatarCropper.js)
│   ├── auth.js, signIn.js  # Neon Auth client; sign-in dialog and account menu
│   ├── editApi.js          # Calls to the write API, with the sign-in token
│   ├── personEditor.js     # Edit dialogs (also relativeDialog.js, familyEditor.js)
│   ├── historyPanel.js     # History, with Revert and Restore
│   ├── editorsDialog.js    # Admins manage the editors list
│   ├── toast.js            # Messages, with Undo after an edit
│   └── style.css           # Styles (editorStyles.css for the editing UI)
├── public/placeholders/    # Default avatars
├── docs/                   # Built site, served by GitHub Pages
└── tests/                  # Unit tests (tests/db needs a database)
```

## How it Works

1. **Data in Neon**: People, families and photo records live in Neon Postgres. The Postgres function `person_view(id)` gathers a person plus their parents, spouses, children and siblings into one JSON document.

2. **One API call per person**: The `api` Neon Function answers `GET /person/:id` by calling `person_view`. The browser caches each answer and quietly prefetches the relatives you're likely to click next. Notes include pasted email threads, and editors may paste addresses into photo captions, so the Function masks any email address in note text and captions before it leaves the server (editors see them unmasked).

3. **Media from a bucket**: Photos (originals, 2000px display images and thumbnails) and avatars sit in the public `ged-eye-media` bucket and load straight into the browser. The `media` Function makes them from uploads ([Photos](#photos)).

4. **Graph Visualization**: Cytoscape.js renders the family as a graph with the selected person in the center, parents above, children below, and spouses to the sides.

The site itself is plain static files on GitHub Pages. Neon is the master copy of the data, and the original GEDCOM is archived byte for byte in the `gedcom_archive` table. Sources and citations, family-level facts (such as marriage notes) and photo titles are still only in that archive, ready to be parsed later.

## Editing

Viewing stays public. Family members on the invite list can also sign in and edit the tree from the website, and every edit can be undone.

- **Who can edit:** only people on the editors list. Admins manage it in the app (account menu → Editors): add someone by email as an editor or an admin, or remove them. An admin can't remove themselves, and the last admin can't be removed. Anyone can sign in, but someone who isn't on the list just sees the tree, with a note asking them to ask me for access.
- **Signing in:** **Sign in** in the header, then a one-time code sent by email, or Google (Neon Auth). Only verified email addresses are accepted.
- **What can be edited:**
  - a person's details: names, sex, birth, baptism, death and burial (with their notes), cause of death, notes, occupations, residences, census records, other facts, email and phone
  - adding a parent, spouse, child or sibling, as a new person or by linking someone already in the tree
  - removing a link (×), and deleting a person
  - a couple's marriage and divorce details

  The Contact fields (email and phone) are shown to everyone who views the tree, not only to editors, so enter only what you're happy to make public.
- **Photos:** uploading, captions, tagging and avatars are covered under [Photos](#photos).
- **History:** every edit is kept forever, with who made it and when. **History** (in the account menu, or "History of this person" in the details panel) lists everyone's changes. **Revert** undoes any change and **Restore** puts it back; both are recorded too, so nothing is ever lost. If later edits depend on it (someone has since edited the same field, or added a child to a family it created), Revert is refused and links to the changes in the way.
- **Undo and redo:** Ctrl/Cmd+Z undoes your own latest edit, and Ctrl/Cmd+Shift+Z (or Ctrl+Y) redoes it. The message after each edit also has an Undo button.
- **Two people editing one person:** the second save is refused ("Someone else changed this person"); reload to see their changes.
- **Browsers:** sign-in uses a partitioned cookie on Neon's domain. Current Chrome, Edge, Firefox and Safari are fine. Browsers without partitioned cookies, such as older iOS Safari, can view the tree but not edit; the sign-in dialog says the cookie was blocked. A browser that blocks site storage (`localStorage`) can sign in, but is signed out again when the page reloads.

### Developing the editing features

- Work against the Neon branch **`editing`** (a copy of production with its own Function, Auth and bucket), never production. Its credentials are in `.env.local` (`neon checkout editing --env .env.local`), and `.env.development.local` points `npm run dev` at its Function, bucket and Auth.
- Development accounts exist on `editing` only: `dev-admin@example.test`, `dev-editor@example.test` and `dev-viewer@example.test` (not an editor). Their passwords are in `.env.dev-accounts.local`, which must never be committed. The sign-in dialog shows a password form only in dev builds.
- `npm run test:db` runs against the Neon branch **`test-editing`** (`DATABASE_URL_TEST` in `.env.test.local`). It wipes that branch, so never run two at once.
- **Migrations:** `006_editing.sql` adds the editors list, the change log (`change`, with before/after snapshots of every row in `change_row`), the triggers that record them, undo/redo (`toggle_change`, `undo_last`, `redo_last`), id sequences and name search. `007_marriage_children.sql` adds each marriage's `childIds` to `person_view`.
- **Every write must go through `begin_change`.** Since 006, `person`, `family`, `family_child`, `media` and `person_media` refuse any write outside a recorded change, and refuse `TRUNCATE`. A script or data migration opens one first, in the same transaction, with `via = 'script'`:

  ```sql
  begin;
  select begin_change('you@example.com', 'Your name', 'my_script', 'script', 'What it did', '{}', '{}');
  -- writes …
  commit;
  ```

  It then shows in History, and a small script change can be reverted there (scripts are never Ctrl+Z targets). Undo a large one, such as a facts backfill touching thousands of rows, with the script's own rollback instead: a revert from History runs under the 10 s write timeout and may not finish. `backfill-facts` already opens a change and has `--rollback`.
- `npm run verify-neon` still checks the read path against the old JSON. It skips everyone an edit has touched, along with their relatives, and skips the person count once anything has been edited.

### Releasing to production

Follow the Rollout section of the [editing design](specs/2026-10-09-editing-design.md#rollout). Run every step from the **main checkout**, whose `.neon` and `.env.local` point at production (the `editing` worktree's point at the `editing` branch), once `editing` is merged into `main` there. In short: `git pull` and `npm ci`; `npm run db:migrate` (006 and 007), before the deploy because the new Function reads their tables; `neon deploy`; disable email/password sign-in and add the `https://robacourt.github.io` trusted domain; `npm run verify-neon` (it reads the production database and samples the production API); `npm run build` and commit `docs/`, which is the actual front-end release since Pages serves the committed `docs/` and merging alone changes nothing on the site; smoke tests and sign-in tests on real devices (email code, Google, iPhone Safari); and only then invite relatives.

## Photos

Editors can add photos to the tree from the website, on a phone or a computer. Everyone can view them.

- **What editors can do:**
  - upload photos and PDFs, several at once, each with its own progress. On a phone the file picker offers the camera, the photo library and files; on a computer you can also drop files onto a person's details panel
  - give each photo a caption and a date (free text, such as "about 1923"), and tag everyone in it. A photo is stored once and shown for everyone tagged, so the caption and date are shared. A file that is already in the tree is recognised ("Already in the tree") and only linked
  - **Change avatar** (the camera badge on the avatar, or "Avatar" in the photo viewer): pick any of the person's photos, or upload a new one, then drag and pinch the photo under a circle. Reopening it starts from the last crop. The avatar can also be removed
  - edit a photo's caption, date and people from the viewer, and remove a photo from a person (it stays for anyone else it's tagged with)

  Every one of these is recorded in History and can be undone, like any other edit. Viewers see the avatars, captions, dates and tagged people, plus "Download original", but no edit controls. The viewer shows a 2000px display image, not the original, so it stays quick on a phone. A PDF shows as a document tile and opens in the browser's own viewer.
- **Supported files:** JPEG, PNG, WebP, GIF, TIFF, AVIF and PDF, up to 50 MB each, identified from the file's bytes rather than its name. HEIC is not supported: iPhones convert to JPEG when you pick from the photo library, and a raw `.heic` file gets a message saying so.
- **Privacy:** the bucket is public, so anyone with a file's URL can fetch it (it can't be listed). Location (GPS) data is therefore stripped from uploaded photos: a photo that has any is re-encoded without it, and without its other EXIF data, before it is stored, and a photo without any is stored exactly as uploaded. Email addresses in captions are masked for everyone but editors, like those in notes.

### How photos work

1. The browser asks the `media` Function for an upload slot and PUTs the file straight to `incoming/<id>` in the bucket with a presigned URL. The URL signs the file's type and size, and expires after 15 minutes.
2. The browser then asks `media` to process it. It checks the type (from the file's bytes) and size, then stores `originals/<sha256>.<ext>`, with location data stripped by sharp, and for images `display/<sha256>.webp` (2000px) and `thumbs/<sha256>.webp` (320px). It then deletes the `incoming/` object. For an avatar it renders the crop to `avatars/<sha256>-<crop>.webp` (400×400). Stored keys are immutable and cached for a year, and nothing is ever deleted from storage apart from `incoming/`, so Undo can always bring a photo back.
3. When the editor saves, the `api` Function records the commands (`add_photos`, `update_photo`, `remove_photo`, `set_avatar`, `clear_avatar`). It never trusts keys from the browser: it works them out from the file's sha256 and checks the objects exist. `media` never writes to the tree.
4. The `sweep-incoming` trigger, declared in `neon.ts`, calls `media` hourly (`POST /sweep`) to delete `incoming/` objects more than an hour old: abandoned uploads.

`media` is a separate Function so that sharp's native code doesn't slow cold starts of `api`, which serves every page view.

### Developing the photo features

- Work against the Neon branch **`photos`**, a child of `editing`, so it has the dev accounts and Auth configuration. Pull its credentials into `.env.local` as for `editing`. `neon deploy` deploys both Functions and the trigger to it.
- Set **all four** `VITE_*` values in `.env.development.local` (`VITE_API_URL`, `VITE_MEDIA_BASE_URL`, `VITE_NEON_AUTH_URL` and `VITE_MEDIA_API_URL`) to that branch. Storage is per branch, so a stale `VITE_MEDIA_BASE_URL` makes new thumbnails 404. A branch's media URL is its `api` URL with `-api.` replaced by `-media.`. Without `VITE_MEDIA_API_URL` there is no Add tile, camera badge or drop zone.
- Migration `008_photos.sql` adds the display image, size, caption and date to `media` and `avatar_source` to `person`, and extends `person_record` (which `person_view` uses) with each photo's caption, size and tagged people. 006's change log picks up the new columns by itself, so photo edits are recorded and undoable.
- Smoke tests against the deployed Functions on a development branch (they refuse production and `main`, and need `.env.dev-accounts.local` for the dev editor's password):

  ```bash
  node --env-file=.env.local --env-file=.env.dev-accounts.local scripts/neon/smokeMedia.js    # health, auth, presigned PUT, processing, dedupe, avatars, the trigger
  node --env-file=.env.local --env-file=.env.dev-accounts.local scripts/neon/smokePhotos.js   # the photo commands through both Functions, then undoes them
  ```

  Each prints a PASS or FAIL line per check and exits non-zero on a failure. They leave their test objects in the branch's bucket, and `smokePhotos.js` leaves its changes in History.

### Backfilling display images (one-off)

Photos imported before this release have no display image, and the TIFF scans have no thumbnail either. `backfill-media` makes them, so the viewer can show a 2000px image instead of the multi-megabyte original (and open TIFFs at all), and records the images and their sizes:

```bash
npm run backfill-media -- --dry-run                    # the plan: what would be backfilled; downloads and writes nothing
npm run backfill-media -- --report-gps                 # which originals contain location data (ids only, no coordinates); writes nothing
npm run backfill-media -- --confirm <database host>    # the backfill; <database host> is the host it prints first
```

- The `--` matters: without it npm takes `--dry-run` as its own option and passes the script nothing, which the script refuses.
- It only adds files and fills in columns. It never changes or deletes an original, so the imported originals are left as they are even if `--report-gps` finds location data in them. It records one change in History (`backfill_media`), made after all images are uploaded, so the write lock is held for well under a second.
- It is safe to re-run: it only selects rows without a display image, so a re-run carries on where a stopped one left off. An image sharp can't read is reported and skipped, and the exit status is 1.
- **Same-branch check.** The script writes to a database and to a bucket, and both come from one env file. It prints the branch and both hosts first, then compares the database's own branch id with the `br-…` id in the bucket endpoint, and refuses (exit status 2, before writing anything) if they differ, if a bucket setting is missing (so nothing falls back to `~/.aws`), or if `--confirm` isn't the database host. A dry run or report that can't read both ids goes by `NEON_BRANCH` with a warning; a real run can't.
- To run it against another branch, put that branch's `DATABASE_URL_UNPOOLED`, `AWS_ENDPOINT_URL_S3`, `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` in a mode-600 env file outside the repo and run `node --env-file=<file> scripts/neon/backfillMedia.js --dry-run` (then `--confirm <database host>`). `neon env pull --branch <name> --file <file>` writes such a file; always pass `--file`, or it updates `.env.local`.

### Releasing photo changes

Run in this order. The new front end must be live **before** the backfill runs. The live front end ignores the fields the migration adds (display key, size, caption, date, tagged people, avatar source), but it takes any photo with a `thumbKey` to be an image and shows its original in an `<img>`. The backfill gives the 5 TIFF scans their first `thumb_key`, so with the old front end still live they would become `.tif` images that most browsers can't show. The new front end shows their display images instead.

The `npm run` scripts read the checkout's own `.env.local`, which on a development branch's worktree is that branch's, so aim each script at production with `--env-file`:

```bash
PROD_ENV=<main checkout>/.env.local    # production's credentials
```

1. **Safety branch:** `neon branches create --name pre-photos-<date> --parent production --no-secrets`.
2. **Migration:** `node --env-file=$PROD_ENV scripts/neon/migrate.js` applies `008_photos.sql`. It is additive, and no column the live Functions and front end read changes until the backfill. Do it before the deploy, because the new `api` reads its columns.
3. **Deploy both Functions:** `neon deploy --branch production --no-env-pull`. Check that `GET <media URL>/health` gives `{"ok":true}`, that an unauthenticated `POST <media URL>/uploads` gives 401, and that `neon triggers list --branch production` shows `sweep-incoming`.
4. **Front-end env:** put the production media URL (in the deploy output; the `api` URL with `-api.` replaced by `-media.`) in `.env.production` as `VITE_MEDIA_API_URL`.
5. **Release the front end:** `npm run build`, commit `docs/` together with `.env.production`, then merge the PR. GitHub Pages serves `main`'s committed `docs/`, so the new front end is live only once the PR is merged: check the live site before going on. Until the backfill, it shows imported images from their originals, and the TIFFs as documents, as now.
6. **Backfill on production:** `node --env-file=$PROD_ENV scripts/neon/backfillMedia.js --report-gps` (note how many originals have location data), then the same with `--dry-run`, then the real run with `--confirm <production database host>`. There is no separate rehearsal branch: the backfill was rehearsed on the `photos` development branch, which has the same 544 images as production, and that keeps the project within the free plan's 10 branches.
7. **Verify:** `node --env-file=$PROD_ENV scripts/neon/verify.js --legacy-root <main checkout>/ignore/legacy-data` (the `verify-neon` check: it reads the production database and samples the production API). It ignores the backfill's change, so expect no unexplained differences. Open a TIFF and a large PNG in the viewer.

**Rollback:** redeploy the previous Functions and front end. The new columns can stay, and no object was deleted, so nothing has to be restored. After the backfill, though, the previous front end would show the 5 TIFF scans as broken images, for the reason above.

## Tech Stack

- **Vanilla JavaScript** - No framework bloat, just modern ES6+
- **Cytoscape.js** - Graph visualization library
- **Neon** - Postgres for the tree, Functions for the API and for image processing, Object Storage for photos
- **sharp** - Image processing in the `media` Function
- **Cropper.js** - Avatar cropping (loaded only for editors)
- **Vite** - Lightning-fast dev server and build tool
- **Vitest** - Unit testing

## Testing

```bash
npx vitest run     # unit tests (npm test runs them in watch mode)
npm run test:db    # person_view tests against a real database
```

`npm run test:db` needs `DATABASE_URL_TEST` in `.env.test.local`, pointing at a Neon test branch (`test-editing` for the editing work). It wipes that branch's `public` schema on every run, so runs must not overlap, and it refuses to run against production.

`tests/realGed.test.js` checks the parser against the real tree, including exact parity with a frozen copy of the original parser for everything except facts. It reads `acourt.ged` from the repo root, or from `GED_PATH`, and skips when the file isn't there (as in a git worktree):

```bash
GED_PATH=/path/to/acourt.ged npx vitest run tests/realGed.test.js
```

## Changing the Default Person

Edit `DEFAULT_PERSON_ID` in `src/main.js` (it's `'I122'`). You can also link straight to anyone with `?person=I122`.

## Future Enhancements

- [ ] Smooth animations when switching between people
- [ ] Face detection and avatar extraction from photos
- [ ] Zoomed-out view showing hundreds of people at once
- [ ] Search functionality
- [ ] Info panel with detailed person information
- [ ] Export visualizations
- [x] Editing people and relationships, for signed-in family members ([Editing](#editing))
- [x] Uploading and editing photos, tagging people and choosing avatars ([Photos](#photos))

## Credits

Built by Rob with Claude Code. Vibes only. 🌊

## License

MIT - Do whatever you want with it
