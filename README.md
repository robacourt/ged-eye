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
- 🖼️ **Photos and avatars** - Served straight from a public Neon Object Storage bucket
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
neon deploy      # deploy the api Function and bucket declared in neon.ts
```

### Importing the tree (one-off)

Neon is the master copy of the tree. `acourt.ged` was imported once; the steps are kept here for reference. Run them in this order:

```bash
npm run upload-media   # originals, thumbnails and avatars → ged-eye-media bucket (resumable)
npm run db:migrate     # apply db/migrations/*.sql
npm run import-ged     # load people, families and photos, and archive the GEDCOM
neon deploy            # deploy the api Function
npm run verify-neon    # parity check against the old JSON files; exits non-zero on any unexplained difference
```

- `import-ged` refuses to run if the database already has people. `npm run import-ged -- --replace --confirm <database host>` used to wipe and reload everything; since migration 006 the tree tables refuse `TRUNCATE`, so it no longer works (see [Editing](#editing)).
- The old JSON files and avatars (the parity baseline) now live outside the repo in `ignore/legacy-data/`. `upload-media`, `import-ged` and `verify-neon` read them from there by default; pass `--legacy-root <dir>` to point elsewhere.
- `scripts/generateAvatars.js` is legacy: it face-crops avatars from the old JSON files. It'll be reworked to read from Neon when editing arrives.

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
| `.env.development`, `.env.production` | yes | `VITE_API_URL` (the Function), `VITE_MEDIA_BASE_URL` (the bucket) and `VITE_NEON_AUTH_URL` (sign-in). Public values that end up in the JS bundle anyway. |
| `.env.development.local` | no | Overrides of the three `VITE_*` values, to point `npm run dev` at a development branch such as `editing`. |
| `.env.local` | no | Secrets written by `neon link` / `neon env pull`: database URLs and bucket keys. |
| `.env.test.local` | no | `DATABASE_URL_TEST`, for `npm run test:db`. |
| `.env.dev-accounts.local` | no | Passwords of the development accounts on the `editing` branch. Never commit it. |
| `neon.ts` | yes | Neon resources: Auth, the `api` Function and the `ged-eye-media` bucket. |

There's deliberately no plain `.env`: the Neon CLI writes secrets into `.env` whenever that file exists.

## Project Structure

```
├── acourt.ged              # The original GEDCOM (local only; archived in Neon)
├── Data/                   # Media the GEDCOM points at (local only; uploaded to the bucket)
├── neon.ts                 # Neon resources: api Function + ged-eye-media bucket
├── api/
│   ├── index.js            # Neon Function entry: Postgres pool
│   ├── handler.js          # Routes: person, search, me, changes, undo/redo, editors
│   ├── auth.js             # Verifies Neon Auth tokens
│   ├── changes.js          # Runs edit commands as recorded changes
│   ├── commands/           # One module per edit command (update_person, add_relative, …)
│   ├── db.js, tx.js        # The handler's database calls; the write transaction
│   └── privacy.js          # Masks email addresses found in note text
├── db/migrations/          # Schema and the person_view() Postgres function
├── scripts/
│   ├── gedTree.js          # GEDCOM lines → node tree (CONT/CONC folded in)
│   ├── gedParser.js        # INDI/FAM records and extractPersonData
│   ├── gedFacts.js         # A person's notes, occupations, census records and other facts
│   ├── generateAvatars.js  # Legacy avatar face-cropper (reads the old JSON)
│   └── neon/               # One-off import: upload, migrate, import, verify, backfill-facts
├── src/
│   ├── main.js             # App entry point (DEFAULT_PERSON_ID)
│   ├── dataLoader.js       # Fetches, caches and prefetches person views
│   ├── media.js            # Bucket URLs for photos and avatars
│   ├── familyTreeView.js   # Cytoscape graph visualization
│   ├── personDetails.js    # Details panel
│   ├── factLabels.js       # Labels for GEDCOM fact tags (_MILT → Military service)
│   ├── html.js             # escapeHtml
│   ├── photoViewer.js      # Photo viewer
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

2. **One API call per person**: The `api` Neon Function answers `GET /person/:id` by calling `person_view`. The browser caches each answer and quietly prefetches the relatives you're likely to click next. Notes include pasted email threads, so the Function masks any email address in note text before it leaves the server.

3. **Media from a bucket**: Photos, thumbnails and face-cropped avatars sit in the public `ged-eye-media` bucket and load straight into the browser.

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

  Photos come next.
- **History:** every edit is kept forever, with who made it and when. **History** (in the account menu, or "History of this person" in the details panel) lists everyone's changes. **Revert** undoes any change and **Restore** puts it back; both are recorded too, so nothing is ever lost. If later edits depend on it (someone has since edited the same field, or added a child to a family it created), Revert is refused and links to the changes in the way.
- **Undo and redo:** Ctrl/Cmd+Z undoes your own latest edit, and Ctrl/Cmd+Shift+Z (or Ctrl+Y) redoes it. The message after each edit also has an Undo button.
- **Two people editing one person:** the second save is refused ("Someone else changed this person"); reload to see their changes.
- **Browsers:** sign-in uses a partitioned cookie on Neon's domain. Current Chrome, Edge, Firefox and Safari are fine. Browsers without partitioned cookies, such as older iOS Safari, can view the tree but not edit; the sign-in dialog says the cookie was blocked.

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

  It then shows in History and can be reverted there (scripts are never Ctrl+Z targets). `backfill-facts` already does this.
- `npm run verify-neon` still checks the read path against the old JSON. It skips everyone an edit has touched, along with their relatives, and skips the person count once anything has been edited.

### Releasing to production

Follow the Rollout section of the [editing design](specs/2026-10-09-editing-design.md#rollout). In short: `npm run db:migrate`, `neon deploy`, disable email/password sign-in and add the `https://robacourt.github.io` trusted domain, `npm run verify-neon`, a smoke test, then sign-in tests on real devices (email code, Google, iPhone Safari), and only then merge the front end. Relatives are invited once the device tests pass.

## Tech Stack

- **Vanilla JavaScript** - No framework bloat, just modern ES6+
- **Cytoscape.js** - Graph visualization library
- **Neon** - Postgres for the tree, a Function for the API, Object Storage for photos
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
- [ ] Editing photos

## Credits

Built by Rob with Claude Code. Vibes only. 🌊

## License

MIT - Do whatever you want with it
