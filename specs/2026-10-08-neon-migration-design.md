# Move GED-Eye data to Neon: design

**Date:** 2026-10-08
**Status:** Draft (revision 2, after spec review), awaiting the developer's review
**Scope:** Phase 1. Serve the existing tree (people, relationships, photos) from Neon instead of static JSON files, read-only. Editing comes in a later phase.

## Goals

- Store the family tree in Neon Postgres and the media in Neon Object Storage, so a later phase can add editing (people and photos) by signed-in family members.
- Load a person page (the person plus immediate family) in **one HTTP request** to the database, staying fast with thousands of people.
- Keep the site publicly viewable at `robacourt.github.io/ged-eye` with no sign-in, as today.
- Keep existing `?person=I122` links working.

## Non-goals (this phase)

- Editing, sign-in UI, uploads by family members, search, GEDCOM export.
- Media attached to families. 172 FAM records have OBJE media; today's code ignores them and so does this phase.
- Avatar generation for new photos. `scripts/generateAvatars.js` is left unchanged; the editing phase will rework it to read from Neon.
- Rewriting git history to remove the ~800 MB of media already committed under `docs/`.
- Re-running the import after go-live. Neon becomes the master copy; `acourt.ged` is imported once.

## Decisions made during brainstorming

| Topic | Decision |
|---|---|
| Master copy | Neon. One-time import from `acourt.ged`; Brother's Keeper is no longer used for edits. |
| Read access | Public (anonymous). Sign-in will only be needed for editing, later. |
| Data access | Normalized tables plus a `person_view()` Postgres function called through the Neon Data API (approach "A"). |
| Hosting | Front end stays on GitHub Pages; no backend server. |

## Constraints from Neon (as documented on 2026-10-08)

- **Free plan:**
  - 1 GB Postgres per project.
  - 100 CU-hours per project per month.
  - 5 GB of Object Storage per project.
  - 5 GB of public network egress per project per month, **shared** by Postgres, Data API and Object Storage.
  - The compute scales to zero after 5 minutes idle (cannot be disabled on Free).
  - If an allowance runs out, the site stops loading data until the allowance resets at the start of the next month, or until the project is upgraded. Usage is checked in the Neon Console. The budget in [Performance and egress budget](#performance-and-egress-budget) keeps normal family use well inside the limits.
- **Object Storage:**
  - It is in beta.
  - It is S3-compatible, with path-style addressing and SigV4 only.
  - Buckets are private or `public_read`. The access level is declared in `neon.ts`, not via S3 ACLs.
- **Data API:**
  - It is PostgREST-compatible and calls functions via `rpc`.
  - It requires a JWT even for anonymous access. With Managed Better Auth (Neon Auth), `@neondatabase/neon-js` fetches a short-lived anonymous token from `GET {auth}/token/anonymous` when `allowAnonymous: true`.
  - Anonymous requests run as the `anonymous` Postgres role; signed-in requests run as `authenticated`.
  - Every table in an exposed schema needs RLS.
  - After schema changes, the schema cache is refreshed with `neon data-api refresh-schema`.

## Architecture

```
Browser (GitHub Pages: robacourt.github.io/ged-eye)
  ├─ GET  {auth-url}/token/anonymous       → anonymous JWT (SDK caches it, ~15 min life)
  ├─ POST {data-api-url}/rpc/person_view   → person + immediate family (1 request per page)
  └─ GET  {bucket-url}/avatars|thumbs|originals/…   → media from a public_read bucket

Neon project "GED-Eye" (calm-band-80930621), Free plan, AWS eu-central-1 (Frankfurt), Postgres 18
  ├─ Branch "production": tables, RLS policies, person_view()
  ├─ Data API (schema `public` only) + Managed Better Auth (anonymous read now; sign-in for edits later)
  └─ Object Storage bucket "ged-eye-media" (public_read, declared in neon.ts)

One-off scripts run on the developer's Mac (secrets in .env.local, gitignored)
  npm run upload-media → bucket + .neon-import/media-manifest.json
  npm run db:migrate   → schema, policies, function
  npm run import-ged   → rows
  npm run verify-neon  → parity check against the current JSON files
```

Frankfurt is required because Object Storage is offered only in us-east-1, us-east-2, eu-central-1 and ap-southeast-1, and most of the family is in the UK. For family in Perth, one round trip to Frankfurt (~300 ms) is the main cost of a page load.

## Step 0: Neon setup and verification spike

### Already done (2026-10-08)

- The developer created the Neon account and project `GED-Eye` (`calm-band-80930621`, aws-eu-central-1, Postgres 18, default branch `production`) and bucket `ged-eye-media` (`public_read`).
- The Neon CLI v8 is installed for this repo's Node version.
- `neon skills` and `neon mcp` have been run.
- `neon link` wrote `.neon` and `.env.local` (both gitignored).
- `neon.ts` declares the bucket. `neon deploy` reported no changes.

### Remaining setup (via the CLI, developer approves each step)

1. `neon neon-auth enable` on `production`.
2. Add trusted domains with `neon neon-auth domain`:
   - `https://robacourt.github.io`
   - `http://localhost:5173` (dev)
   - `http://localhost:4173` (`vite preview`)
3. Disable new sign-ups, using `neon neon-auth config` where the CLI supports it for each sign-in method. Phase 1 has no sign-in UI. Even if someone signs up, the `authenticated` role has the same read-only access as `anonymous` (see [Access control](#access-control)).
4. Create the Data API:
   ```
   neon data-api create --auth-provider neon_auth --db-schemas public --server-cors-allowed-origins "<the three origins above>"
   ```
   **Do not pass `--add-default-grants`**, which grants all permissions on `public` tables to `authenticated`.
5. Record the Auth URL, Data API URL and bucket base URL in `.env.development` and `.env.production` (see [Configuration](#configuration)).

### Spike

Throwaway code, not committed. It verifies what the docs leave unclear:

| # | Check | Fallback if it fails |
|---|---|---|
| 1 | The URL format for objects in a `public_read` bucket, and that `<img src>` loads one from `localhost` and `github.io`. | Stop and revisit media hosting with the developer. Options: keep media on GitHub Pages, or a private bucket plus a presigning Neon Function. |
| 2 | `Content-Type`, `Cache-Control` and `Content-Disposition` set at upload are returned on GET. | Drop forced-download for non-images; the viewer shows the original filename and a plain link. |
| 3 | The anonymous token flow plus `rpc('person_view')` works from all three origins. | Investigate the trusted-domain and CORS configuration. Do not proceed to the front-end work until this works. |
| 4 | Cold-start latency, measured as the time of the first `rpc` after 5+ minutes idle. | Informational only; recorded in the PR description. |

## Database schema

`db/migrations/001_schema.sql`:

```sql
create table person (
  id            text primary key,          -- GEDCOM xref, e.g. 'I122'
  given_name    text not null default '',
  surname       text not null default '',
  display_name  text not null,             -- "Given Surname", as today's `name`
  sex           text check (sex in ('M','F','U')),
  birth_date    text, birth_place   text,  -- GEDCOM date wording kept verbatim ("ABT 1850")
  death_date    text, death_place   text,
  baptism_date  text, baptism_place text,
  burial_date   text, burial_place  text,
  facts         jsonb not null default '{}',
  avatar_key    text,                      -- object key of the face-cropped avatar
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table family (                      -- a couple (GEDCOM FAM)
  id             text primary key,         -- e.g. 'F495'
  partner1_id    text references person(id) on delete set null,  -- GEDCOM HUSB
  partner2_id    text references person(id) on delete set null,  -- GEDCOM WIFE
  marriage_date  text, marriage_place text,
  divorce_date   text, divorce_place  text
);
create index family_partner1_idx on family (partner1_id);
create index family_partner2_idx on family (partner2_id);

create table family_child (
  family_id  text not null references family(id) on delete cascade,
  child_id   text not null references person(id) on delete cascade,
  position   int  not null,                -- GEDCOM CHIL order within the family
  primary key (family_id, child_id)
);
create index family_child_child_idx on family_child (child_id);

create table media (
  id             bigint generated always as identity primary key,
  sha256         text not null unique,
  original_path  text not null,            -- first path seen, e.g. 'Data/Media/1851 census/…/x.jpg'
  file_name      text not null,            -- basename of original_path, used for downloads
  content_type   text not null,
  byte_size      bigint not null,
  object_key     text not null,            -- 'originals/<sha256>.<ext>'
  thumb_key      text                      -- 'thumbs/<sha256>.webp'; null for non-displayable files
);

create table person_media (
  person_id  text   not null references person(id) on delete cascade,
  media_id   bigint not null references media(id)  on delete cascade,
  position   int    not null,              -- 0-based order after de-duplication
  primary key (person_id, media_id)
);
```

**`facts` keys** use the same camelCase names and shapes as today's JSON, so the function can merge them into its output unchanged. Each key is present only when it has a value:

- `occupations` (string[])
- `notes` (string[])
- `email`, `phone`, `religion`, `education` (string)
- `censusRecords` ({date, place}[])
- `residences` ({date, place}[])

**Ordering rules:**

- Parents are ordered partner1 then partner2.
- A person's families (and so their spouses, marriages and per-family child grouping) are ordered by the numeric part of the family ID. This approximates creation order in Brother's Keeper.
  - It differs from today's per-person FAMS order for 9 people. Their partnership colours and marriage order may change; this is an intended change.
- Children within a family are ordered by `position`.
- Photos are ordered by `person_media.position`.

### Migration bookkeeping

- `migrate.js` records applied migrations in `ged_admin.schema_migrations(filename text primary key, applied_at timestamptz not null default now())`.
- Schema `ged_admin` is not in the Data API's exposed schemas, and `usage` on it is revoked from `public`, `anonymous` and `authenticated`.

### Access control

`001_schema.sql` also:

- **Roles.** Ensures `anonymous` and `authenticated` exist, with a `DO` block that creates them `NOLOGIN` only if missing. This is a no-op on branches with the Data API, and it lets the same migrations run on the `test` branch.
- **Revoke first.** Runs `revoke all on all tables in schema public from anonymous, authenticated`. This removes anything the Data API's default privileges may have granted.
- **Grant read-only.** Grants `usage on schema public` and `select` on the five tables to `anonymous, authenticated`. No insert, update or delete.
- **RLS.** Runs `alter table … enable row level security` on all five tables, with one policy per table: `for select to anonymous, authenticated using (true)`.
  - With no write policies, writes are rejected even if a grant appears later.

## `person_view` function

`db/migrations/002_person_view.sql`:

```sql
create or replace function person_view(p_id text) returns jsonb
  language sql stable security invoker
  as $$ … $$;
revoke all on function person_view(text) from public;
grant execute on function person_view(text) to anonymous, authenticated;
```

### Who is included

| Group | Definition |
|---|---|
| parents | `partner1_id` and `partner2_id` of every family where p is a child |
| spouses | the other partner of every family where p is a partner (distinct, non-null) |
| children | children of every family where p is a partner |
| siblings | children (≠ p) of every family in which one of p's parents is a partner. This covers full and half siblings, and matches the current loader. |
| other parents | every parent of a sibling who is not one of p's parents |

`family` in the output is the distinct union of parents, spouses, children, siblings and other parents, excluding p.

### Output contract

Returns `null` if `p_id` does not exist. Otherwise:

```json
{
  "person": PersonRecord,
  "family": [RelativeRecord, …],
  "relationships": {
    "parents":  ["I1", "I2"],
    "spouses":  ["I3"],
    "children": ["I4", "I5"],
    "siblings": ["I6"]
  }
}
```

**`PersonRecord`** (the selected person only) is today's per-person JSON shape. The two differences are `photos` and `avatar`, marked **(changed)** below:

| Field | Source |
|---|---|
| `id`, `name`, `givenName`, `surname`, `sex` | `person` columns (`name` = `display_name`) |
| `birthDate`, `birthPlace`, `deathDate`, `deathPlace` | `person` columns; `null` when absent |
| `baptismDate`, `baptismPlace`, `burialDate`, `burialPlace` | `person` columns; omitted when null |
| `occupations`, `notes`, `email`, `phone`, `religion`, `education`, `censusRecords`, `residences` | merged from `facts`; omitted when absent |
| `parentIds`, `spouseIds`, `childIds` | ordered as above |
| `marriages` | one entry per family where the person is a partner: `{spouseId, familyId, marriageDate?, marriagePlace?, divorceDate?, divorcePlace?}`; omitted when empty |
| `photos` **(changed)** | `[{ "key", "thumbKey", "fileName", "contentType" }]` from `person_media` → `media`, ordered by position (`thumbKey` may be null) |
| `avatarKey` **(changed, replaces `avatar`)** | `person.avatar_key`, or `null` |

**`RelativeRecord`** (every entry in `family`) carries only what the graph and details panel read from relatives today:

- `id`, `name`, `sex`, `birthDate` (used by the node label)
- `avatarKey`
- `parentIds`, computed globally for that relative and used to attach children and siblings to the right partnership

Today's loader fetches every relative's full JSON, but nothing reads the extra fields: `FamilyTreeView.personDataCache` and `FamilyTreeView.photoViewer` are never used to open anything. Those two dead members are removed.

### Performance and egress budget

**Database time.** Every step is a primary-key or indexed lookup bounded by family size, so database time stays in the low milliseconds whatever the tree size.

**Response size.** About 3–8 KB uncompressed for a typical person.

**One fresh page view (nothing cached in the browser):**

| Item | Size |
|---|---|
| `person_view` | ~3 KB |
| prefetch of up to ~20 relatives' views | ~60 KB |
| ~20 avatars | ~200 KB |
| up to 4 thumbnails | ~60 KB |
| **Total** | **~0.3 MB** |

- Media is served `immutable`, so repeat views of the same people cost almost nothing.
- 5 GB a month therefore covers roughly 15,000 fresh page views, plus opening full-size originals at ~1 MB each.
- Compute is used only while the database is awake. Prefetch happens within the same awake window as the page view, so it adds negligible CU-hours.

## Import pipeline

All scripts live in `scripts/neon/`, run with `node --env-file=.env.local`, and are exposed as npm scripts.

- **Connection.** They connect with `DATABASE_URL_UNPOOLED`, a direct connection that suits DDL and long transactions.
- **Bucket.** They use `MEDIA_BUCKET` (default `ged-eye-media`) with the `AWS_*` variables written by `neon link`.
- **Dependencies.** New dev dependencies are `pg` and `@aws-sdk/client-s3`; `sharp` is already present.

### Shared helper: `scripts/neon/legacyData.js`

`readLegacyAvatars(dir)` reads every `I*.json` in `dir` (skipping `index.json` and dotfiles). It returns `Map<personId, avatarPath>` for people with an `avatar` field, e.g. `'I1033' → 'avatars/I1033_0.jpg'`, with paths relative to `public/`.

Both `uploadMedia.js` and `importGed.js` take `--legacy-dir` (default `public/data/people`).

### `npm run upload-media` (`scripts/neon/uploadMedia.js`)

1. **Find the files.**
   - Parse `acourt.ged` with the existing `parseGedcom`/`extractPersonData` to collect every referenced media path (currently 558 unique paths that exist on disk, 1,143 references).
   - Collect every avatar path from `readLegacyAvatars`.
2. **Upload each original that exists on disk.**
   - Compute its SHA-256.
   - Take the content type from the extension. If the extension is unknown or missing, use `application/octet-stream`. (All 6 extension-less references are missing on disk today.)
   - Upload it to `originals/<sha256>.<ext>` with:
     - `Cache-Control: public, max-age=31536000, immutable`
     - `Content-Disposition`: `inline; filename*=UTF-8''<file_name>` for displayable images (jpg, jpeg, png, gif, webp, bmp), else `attachment; filename*=…`. Non-images (docx, pdf, tif, htm, mht) therefore always download and never render as live pages.
3. **Thumbnails.** For displayable images, generate a WebP thumbnail fitting inside 320×320 → `thumbs/<sha256>.webp`.
4. **Avatars.** Upload each avatar file to `avatars/<sha256>.jpg`.
5. **Skip, retry, record.**
   - Skip any object that already exists (`HeadObject`), so the script can be resumed.
   - Retry each upload up to 3 times with backoff.
   - Write `.neon-import/media-manifest.json` (gitignored) incrementally, in this shape:
     ```json
     {
       "files":   { "<originalPath>": { "sha256", "objectKey", "thumbKey", "contentType", "byteSize", "fileName" } },
       "avatars": { "<avatarPath>": "<objectKey>" }
     }
     ```
6. **Report.** Print the counts uploaded, skipped, missing on disk and failed. Exit non-zero if anything failed.

Identical files at different paths share one object and one `media` row.

### `npm run db:migrate` (`scripts/neon/migrate.js`)

- Applies `db/migrations/*.sql` in filename order. Each file runs in its own transaction.
- Records applied files in `ged_admin.schema_migrations` and skips any already applied.
- Then runs `neon data-api refresh-schema` for the linked branch.
- Takes `--database-url` to override the connection, which the DB tests use.
  - With `--database-url`, it skips the schema refresh, because the `test` branch has no Data API.

### `npm run import-ged` (`scripts/neon/importGed.js`)

- **Pure transform (`scripts/neon/gedToRows.js`).** `gedToRows(parsedGed, manifest, avatarMap)` returns `{ people, families, familyChildren, media, personMedia, warnings }`. It has no I/O and is unit-tested.
  - **Person fields** come from `extractPersonData`, so they match today's JSON.
  - **Avatars.** `avatar_key` = `manifest.avatars[avatarMap.get(id)]`, or null.
  - **Relationships** come from FAM records only (HUSB, WIFE, CHIL).
  - **Dangling references are skipped** and reported as warnings. This covers a family pointing at a missing person, and a CHIL that is not a known person.
  - **GEDCOM inconsistencies are reported.** If a person's FAMS/FAMC lists disagree with the family records, that is a warning. Family records win.
  - **Missing photos are reported.** Media paths with no manifest entry (the file is missing on disk) are counted as a warning, as `processGed.js` does today.
  - **Duplicate photo references are removed.** This covers the same path twice on one person, or two paths with identical bytes. The first occurrence is kept, positions are renumbered from 0, and each removal is reported as a warning.
  - Each warning is `{ type, personId?, familyId?, detail }`, so `verify-neon` can match differences to warnings.
- **Guarded load.** The script refuses to run if `person` has any rows, unless given `--replace`.
- **Single transaction.** In one transaction it optionally truncates all five tables (`--replace`), then bulk-inserts all rows in batches. On any error it rolls back, leaving the database unchanged.
- **Report.** Prints the counts and the warnings, and also writes the warnings to `.neon-import/import-warnings.json`.

## Front-end changes

| File | Change |
|---|---|
| `package.json` | Add the `@neondatabase/neon-js` dependency and the npm scripts above. Remove the `process-ged` script. |
| `src/neonClient.js` (new) | Creates and exports the client from `VITE_NEON_AUTH_URL` and `VITE_NEON_DATA_API_URL`, with anonymous access enabled. |
| `src/media.js` (new) | `mediaUrl(key)` returns `${VITE_MEDIA_BASE_URL}/${key}` (key path segments URL-encoded). `thumbUrl(photo)` returns `mediaUrl(photo.thumbKey)`, or null. |
| `src/dataLoader.js` | `loadPersonWithFamily(id)` calls `rpc('person_view', { p_id: id })` and returns `{ person, family, relationships }`. It maps the relationship ID lists to `RelativeRecord` objects, so callers are unchanged. It caches responses by ID in memory, and throws `PersonNotFoundError` on `null`. It retries once on network failure, then throws. `prefetchFamily(view)` fetches `person_view` for each relative in the view that is not cached and not already in flight, at most 4 at a time, using `requestIdleCallback` (falling back to `setTimeout`) and ignoring errors. Each ID is fetched at most once per page session. It removes `loadPerson`, `loadPeople` and `loadIndex`. |
| `src/familyTreeView.js` | `getAvatarPath` returns `mediaUrl(person.avatarKey)` when set, else `${BASE_URL}placeholders/man.png` or `woman.png`. It calls `prefetchFamily` after rendering. It removes the unused `photoViewer` and `personDataCache`. |
| `src/personDetails.js` | Thumbnails use `thumbUrl(photo)`; a photo without a `thumbKey` shows the existing file icon. `isImageFile(path)` is replaced by checking `photo.thumbKey`. |
| `src/photoViewer.js` | Takes photo objects. It displays `mediaUrl(photo.key)` when `thumbKey` is set; otherwise it shows the existing download panel with `photo.fileName` and `mediaUrl(photo.key)` (the `Content-Disposition` header forces download). Its existing "Failed to load image" behaviour is unchanged. |
| `src/main.js` | Drops `loadIndex()`. The default person stays `I122`. Initial-load and navigation behaviour is described in [Error handling](#error-handling). |
| `public/placeholders/man.png`, `woman.png` (new, committed) | Copied from the current `public/avatars/`, which is gitignored and moves out at cutover. |
| `.gitignore` | Add `.env*.local`, `.neon-import/` and `ignore/`. `ignore/` is only ignored by the developer's global gitignore today. |
| `scripts/processGed.js` | Deleted. Running it would recreate `public/data` and republish about 4,900 files. `scripts/gedParser.js` stays, because the import uses it. |
| `README.md` | Quick Start, Project Structure and "How it Works" are rewritten for the Neon pipeline (setup, the four npm scripts, configuration). |

### Configuration

| File | Committed | Contents |
|---|---|---|
| `.env.development`, `.env.production` | yes | `VITE_NEON_AUTH_URL`, `VITE_NEON_DATA_API_URL`, `VITE_MEDIA_BASE_URL`. These are public values that ship in the JS bundle anyway. |
| `.env.local` | no | Written by `neon link` / `neon env pull`: `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `NEON_BRANCH`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_ENDPOINT_URL_S3`, `AWS_REGION`. Added by hand: optional `MEDIA_BUCKET` and `DATABASE_URL_TEST`. |
| `.neon` | no | Project and branch link, written by `neon link`. |
| `neon.ts` | yes | Neon resource policy (the bucket). |

## Error handling

| Situation | Behaviour |
|---|---|
| Initial load fails (token or `rpc`, after one retry) | The existing error panel in `initApp`, showing the message only, not the stack trace. |
| Unknown `?person=` ID (initial load or navigation) | "Person not found", with a link to the default person. |
| A navigation load (`onPersonSelect` or `popstate`) is slow | If it takes longer than 300 ms (e.g. a cold start of ~0.5–1 s), the `#loading` overlay reappears with "Loading…" until it finishes. |
| A navigation load fails (after one retry) | The current graph stays. The overlay shows "Couldn't load this person." with a Retry button that repeats the load. Today these handlers have no error handling and fail with an unhandled rejection. |
| Upload failure | Retried 3×, then reported. The script exits non-zero and can be resumed. |
| Import failure | The transaction rolls back and the database is unchanged. |

Missing media objects are prevented rather than handled: `verify-neon` checks that every media, thumbnail and avatar key exists before go-live. This phase adds no runtime fallback for a missing avatar, which today shows a blank node.

## Testing

- **Unit tests (Vitest, run by `npm test`, no network).** Fixtures live in `tests/fixtures/`, never in a directory named `data/`: the repo's `Data` ignore rule plus `core.ignorecase=true` would hide it.
  - `tests/gedToRows.test.js` covers:
    - a couple with children
    - remarriage (two families), plus a half-sibling
    - a single-parent family
    - a person with no families
    - the same media shared by two people
    - the same path twice on one person
    - two paths with identical bytes on one person
    - a media path missing from the manifest
    - a dangling CHIL reference
    - a FAMS/FAMC inconsistency
    - an avatar mapping
  - `tests/dataLoader.test.js` uses a stubbed client and covers:
    - mapping IDs to objects
    - the cache
    - `PersonNotFoundError`
    - retry once on network failure
    - prefetch skipping cached and in-flight IDs
- **Database tests (`npm run test:db`, skipped unless `DATABASE_URL_TEST` is set).**
  - **Setup:** they run against a dedicated Neon branch `test`, which is a child of `production` and has no Data API. Each run resets it by dropping the five tables, `person_view(text)` and schema `ged_admin`. Then it applies the migrations with `migrate.js --database-url` and loads a fixture tree.
  - **`person_view` cases:**
    - full and half siblings, plus their other parent
    - multiple spouses, with children grouped per family
    - ordering rules
    - `facts` merging
    - `photos` and `avatarKey`
    - the `RelativeRecord` fields
    - an unknown ID returns null
  - **RLS:** run as both `anonymous` and `authenticated`. `select` and `person_view` succeed; `insert`, `update` and `delete` on all five tables fail; any access to `ged_admin.schema_migrations` fails.
- **Parity check (`npm run verify-neon`, `scripts/neon/verify.js --legacy-dir <dir>`, default `public/data/people`).** For every person file (skipping `index.json` and dotfiles), compare `person_view(id)` against the current loader logic applied to the legacy JSON files.
  - Compare relationship ID sets (parents, spouses, children, siblings, family members), order-insensitive.
  - Compare all `PersonRecord` scalar and `facts` fields.
  - Compare photo file names against today's `photos` paths.
  - Compare `avatarKey` presence against today's `avatar`.
  - Check every `media.object_key`, `thumb_key` and `person.avatar_key` exists in the bucket (`HeadObject`).
  - It prints every difference. A difference counts as explained only if it matches an entry in `.neon-import/import-warnings.json` (for example a de-duplicated photo) or is a partner-order difference. Partner order is not compared, because of the intended ordering change. The script exits zero only when there are no unexplained differences.
- **Manual:**
  - `npm run dev` against Neon.
  - Navigate a few branches of the tree.
  - Confirm the Network tab shows one `rpc` per newly visited person, and that clicking a relative hits the prefetch cache.
  - Check a cold start, including the loading overlay on navigation.
  - Check mobile width.
  - Open one photo and one non-image download.

## Rollout

1. Finish Step 0 (remaining setup and spike).
2. Run `upload-media` → `db:migrate` → `import-ged` → `verify-neon` on `production`, with zero unexplained differences, **while the legacy files are still in `public/`**.
3. One PR with the front-end changes. To build:
   - Copy the two placeholder images to `public/placeholders/`.
   - Move `public/data` and `public/avatars` out to `ignore/legacy-data/`. They remain the parity baseline, usable via `--legacy-dir`.
   - Run `./build`.
   - `docs/` loses `Data/`, `data/` (the same directory on macOS) and `avatars/`, about 4,900 files.
4. Merge → GitHub Pages deploys.
5. **Rollback:** revert the merge commit. The old JSON files and media come back with it, and the old loader works without Neon.

## Notes for the editing phase (not in scope)

- `personDetails.js` builds HTML with unescaped strings such as `personData.name`. That is harmless while the data comes only from the GEDCOM, but it must be escaped before family members can edit text.
- New IDs: generate `I<n>` and `F<n>` from Postgres sequences seeded above the imported maximum.
- Write access needs:
  - RLS `insert`/`update` policies for `authenticated`
  - re-enabled sign-ups behind an allowlist. Neon Auth has no built-in allowlist today; a blocking `user.before_create` webhook is the documented route.
- Photo uploads from the browser need presigned PUT URLs, which means a small server-side piece (e.g. a Neon Function), plus avatar generation for new photos.
