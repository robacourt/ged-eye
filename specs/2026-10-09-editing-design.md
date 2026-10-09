# Editing with sign-in and infinite undo: design

**Date:** 2026-10-09
**Status:** Draft. The developer approved the five design sections in conversation and asked for it to be built without further review gates.
**Follows:** [2026-10-08-neon-migration-design.md](2026-10-08-neon-migration-design.md) (the Neon backend) and [2026-10-09-gedcom-full-facts-design.md](2026-10-09-gedcom-full-facts-design.md) (PR #3: the full facts model, `escapeHtml`, note email masking).

## Goals

- Family members on an invite list can sign in, by email code or Google, and edit the tree from the website:
  - a person's details, including every fact in the full-facts model
  - adding parents, spouses, children and siblings, either as new people or by linking existing people
  - removing links
  - deleting people
  - a couple's marriage details
- **Infinite undo.** Every edit is recorded forever, with who made it and when.
  - Anyone can revert any recorded change from a History panel, and restore it again.
  - Each editor has an Undo/Redo for their own actions (Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z).
- Viewing stays public and unchanged.

## Non-goals (this release)

- **Photos:** upload, avatar choice and crop, and removing photos come in the next release. The change log already records `media` and `person_media`, so those edits will be undoable with no further design.
- **Sources, family-level facts, name variants:** none of these are stored yet; see the full-facts non-goals.
- **Sign-up allowlist at the identity layer:** anyone can create an account, but only editors can write. A blocking `user.before_create` webhook can be added later.
- **Live updates of other people's edits:** these appear on the next load, or within 5 minutes.
- **Merging duplicate people**, GEDCOM export, and moving a child between families in one step. The last of these is done today as unlink plus link, which is two undoable changes.

## Decisions

| Topic | Decision |
|---|---|
| Undo model | A History list where anyone can revert any change (recorded, so restorable), plus per-user Undo/Redo of their own actions. |
| Undo mechanism | A `change` row per edit, with row-level before and after snapshots captured by triggers in `change_row`. One generic revert does all undoing. Redo is reverting a revert. |
| Editors | An invite list (`editor` table) managed by admins. The developer, `saintderanged@gmail.com`, is seeded as admin. |
| Sign-in | Neon Auth (Managed Better Auth): email one-time code and Google. |
| Scope | People and relationships first; photos next. |
| Write API | The existing Neon Function `api`, with JWT-verified write routes. No Data API. |
| Development | A Neon branch `editing`, copied from production, with its own Function, Auth and bucket. Production is touched only at release. |

## Dependencies and sequencing

1. **PR #3 (full facts) merges first.**
   - This work builds on its `facts` shape, `src/html.js` (`escapeHtml`), `src/factLabels.js`, the escaped details panel, and `api/privacy.js` (masking).
   - The `editing` git branch is rebased onto `main` once #3 has merged.
2. **The full-facts backfill is applied to production (or abandoned) before migration 006 reaches production.**
   - The backfill updates `person.facts` directly, and 006's capture trigger refuses any write that isn't part of a recorded change.
   - The `editing` Neon branch is created after the backfill, so it inherits the backfilled facts. If it was created before the backfill, it is reset from its parent.
3. **Migrations start at `006`**, the next free number after #3. If #3 adds migrations, this work renumbers to follow them.

## Neon setup

| Item | Development (`editing` branch) | Production (at release) |
|---|---|---|
| Neon branch | `neon checkout editing --create --env .env.local`: a copy-on-write copy of production with Function, bucket and Auth provisioned from `neon.ts`. | `production` |
| Auth | `neon.ts` gets `auth: true`; `neon deploy` enables Managed Better Auth per branch. | the same |
| Email code | Enable the Email OTP plugin (`neon neon-auth plugins` / Console). Neon's shared SMTP is fine for a handful of relatives; it is rate limited, so a custom SMTP provider is a later option. | the same |
| Google | Neon's shared development Google credentials. | The developer creates a Google OAuth client (Google Cloud Console → Credentials → OAuth client ID, web). The redirect URI is `{NEON_AUTH_BASE_URL}/callback/google`, set with `neon neon-auth oauth-provider`. Until then the shared credentials keep working, but the consent screen names Neon. |
| Trusted domains | localhost is allowed by default. | `https://robacourt.github.io` |
| Front-end env | `.env.development.local` (gitignored) overrides `VITE_API_URL`, `VITE_MEDIA_BASE_URL` and `VITE_NEON_AUTH_URL` with the `editing` branch's values. | `.env.production` gains `VITE_NEON_AUTH_URL`. |

The Function gets `NEON_AUTH_BASE_URL` and `NEON_AUTH_JWKS_URL` injected when Auth is enabled on its branch.

## Step 0: spike (throwaway, on the `editing` branch)

The front end is served from `github.io` (and `localhost`), while the Auth service lives on a Neon domain, so session cookies are third-party. The spike verifies, before anything else is built:

| # | Check | Fallback if it fails |
|---|---|---|
| 1 | Email-code sign-in from the page completes; `authClient.token()` returns a JWT. | — |
| 2 | Google sign-in completes (popup or redirect) and returns to the page signed in. | Email code only, until fixed. |
| 3 | The session survives a reload in Chromium, and in Safari (iOS Simulator Safari or macOS Safari against the dev server). | Keep the session token in `localStorage` via the SDK's bearer mode if it has one, or ask the developer about a custom auth domain. Ship email-code + Chromium first if needed. |
| 4 | The Function verifies the JWT with `jose` against `NEON_AUTH_JWKS_URL` (EdDSA, issuer = origin of `NEON_AUTH_BASE_URL`), and the payload has `email` and `emailVerified`. | — |

The results are recorded in this spec's Step 0 table before implementation continues.

## Data model (migration `006_editing.sql`)

### Editors

```sql
create table editor (
  email      text primary key check (email = lower(email)),
  name       text,
  role       text not null check (role in ('admin', 'editor')),
  added_by   text,
  added_at   timestamptz not null default now()
);
insert into editor (email, name, role, added_by) values ('saintderanged@gmail.com', 'Rob A''Court', 'admin', 'migration');
```

The editor list is configuration, not tree data. It is not part of the change log, and changes to it cannot be undone.

### Change log

```sql
create table change (
  id                    bigint generated always as identity primary key,
  created_at            timestamptz not null default now(),
  author_email          text not null,
  author_name           text,
  kind                  text not null,         -- update_person | add_relative | link_existing | update_family | unlink | delete_person | revert
  via                   text not null check (via in ('edit', 'history', 'undo', 'redo')),
  summary               text not null,         -- "Jane added Rose Smith as a daughter of Tom Smith"
  params                jsonb not null,        -- the command as received (revert: {"target": id})
  person_ids            text[] not null default '{}',  -- people the change concerns, for History links and filtering
  reverts_change_id     bigint references change (id),
  reverted_by_change_id bigint references change (id)  -- non-null while this change is undone
);
create index change_author_idx on change (author_email, id desc);
create index change_person_ids_idx on change using gin (person_ids);

create table change_row (
  id         bigint generated always as identity primary key,
  change_id  bigint not null references change (id),
  table_name text not null,
  row_key    jsonb not null,   -- {"id":"I12"} | {"family_id":"F1","child_id":"I3"} | {"person_id":"I3","media_id":7}
  op         text not null check (op in ('insert', 'update', 'delete')),
  before     jsonb,            -- null for insert
  after      jsonb             -- null for delete
);
create index change_row_change_idx on change_row (change_id);
create index change_row_key_idx on change_row (table_name, row_key);
```

### Capture trigger

- `capture_change()` is a plpgsql `AFTER INSERT OR UPDATE OR DELETE FOR EACH ROW` trigger on `person`, `family`, `family_child`, `media` and `person_media`.
- It reads `current_setting('ged.change_id', true)`. If that is null or empty, it raises `tree tables can only be changed inside a recorded change`.
- Snapshots are `to_jsonb(row)` minus generated columns: today only `family.sort_key`. The function strips every column with `attgenerated <> ''` (looked up via `pg_attribute`), so future generated columns are handled too.
- `row_key` is built from the table's primary key columns.
- An `UPDATE` whose new snapshot equals the old one is not recorded.
- Rows changed by FK cascades (`on delete cascade` / `set null`) fire the same trigger inside the same transaction, so they land in the same change.

### IDs

- `create sequence person_number_seq` and `family_number_seq` are each started at max(numeric part)+1 of the existing ids.
- New ids are `'I' || nextval(...)` and `'F' || nextval(...)`.
- Sequences are not rolled back, so ids may skip numbers. That is acceptable.

### Read-side additions

`person_record` is replaced, copying the version from 005 (the latest at the time of writing). It gains:

- `updatedAt` (the person's `updated_at`, ISO text), used for optimistic concurrency.
- `parentFamilies: [{ familyId, partnerIds: [..] }]`, the families where the person is a child, in the same order as `parentIds`. Used to choose a family for "+ Sibling" and "+ Parent".
- `marriages[]` entries are unchanged.

`family` gets no new column, so 005's `dated_family` view, whose `f.*` was expanded at creation, needs no change.

Search: `create extension if not exists pg_trgm; create index person_name_trgm_idx on person using gin (display_name gin_trgm_ops);`

### Revert, undo and redo (SQL functions)

**`revert_change(target bigint, author_email text, author_name text, via text) returns bigint`** (plpgsql; returns the new change id).

1. **Lock and check the target.**
   - Lock the target `change` row (`for update`).
   - Error `not_found` if it is missing.
   - Error `already_reverted` if `reverted_by_change_id` is not null.
2. **Net effect per row.** Group the target's `change_row`s by `(table_name, row_key)`.
   - `initial` is the `before` of the earliest of them.
   - `final` is the `after` of the latest.
3. **Conflict check.**
   - For each key, compare the current row (as snapshot JSON, generated columns stripped) with `final`. A missing row counts as `null`.
   - Where they differ, find the later changes (`id > target`) that touched that key and are still in effect.
   - Error `conflict` with their ids in the error detail. The API turns this into `409 {blocking: [{id, summary, author, created_at}]}`.
4. **Record the revert.**
   - Insert the new `change`: `kind = 'revert'`, `params = {target}`, `reverts_change_id = target`, the target's `person_ids`, and the given `via`.
   - Summary: `"Undid: " || target.summary`, or `"Redid: " || inner summary` when the target is itself a revert.
   - `set_config('ged.change_id', new_id, true)`.
5. **Apply the inverse**, with `format('%I')` identifiers. Table names come only from the whitelisted five, and values go through `jsonb_populate_record(null::<table>, …)`.
   - **Re-inserts** (final null, initial not null) in rank order: `person` and `media` (1), `family` (2), `family_child` and `person_media` (3). `media` re-inserts use `overriding system value`.
   - **Updates** (both not null): set every non-generated column to `initial`.
   - **Deletes** (initial null, final not null) in reverse rank order.
   - The triggers record all of this under the new change.
6. **Bookkeeping.**
   - Set `target.reverted_by_change_id = new_id`.
   - If the target is itself a revert (a redo), also clear `reverted_by_change_id` on the change it reverted.
   - Return `new_id`.

**`undo_last(author_email, author_name)`** reverts the author's most recent change with `via in ('edit', 'history', 'redo')` and `reverted_by_change_id is null`, using `via = 'undo'`.
- A redo is a new action, so it can itself be undone.
- Returns null when there is nothing to undo.

**`redo_last(author_email, author_name)`** reverts the author's most recent change with `via = 'undo'` and `reverted_by_change_id is null`, using `via = 'redo'`.
- It acts only if that undo is newer than the author's latest `edit`/`history` change. A new edit clears the redo stack, as in any editor.
- Returns null when there is nothing to redo.

**A change is "in effect"** exactly when its `reverted_by_change_id` is null. The History panel shows a Revert button on changes in effect and a Restore button on undone ones. Restore reverts the revert that undid them.

## API (Function `api`)

### Authentication (`api/auth.js`)

- `authenticate(request)`:
  - reads `Authorization: Bearer <jwt>`
  - verifies it with `jose.jwtVerify` against `createRemoteJWKSet(new URL(NEON_AUTH_JWKS_URL))`, with `issuer = new URL(NEON_AUTH_BASE_URL).origin`
  - requires `emailVerified === true` (Google sign-ins are verified)
  - returns `{ email: lower(email), name }`
- A missing or invalid token gives `401 {error: 'unauthenticated'}`.
- `requireEditor(user, db)` looks up `editor`. It returns `{...user, role}`, or `403 {error: 'not_an_editor', email}`.
- The JWKS URL and issuer are injectable for tests, which sign tokens with a locally generated Ed25519 key.

### Routes

| Method & path | Who | Result |
|---|---|---|
| `GET /person/:id` | public | As today. Notes are masked for anonymous callers. With a valid **editor** token, the view is unmasked and sent `Cache-Control: private, no-store`, so editors can edit real note text without writing `[email hidden]` back. Anonymous 200s change from `max-age=300` to `public, max-age=0, must-revalidate` with a weak `ETag` of `W/"<latest change id>-<id>"`, answering `If-None-Match` with 304. |
| `GET /search?q=&limit=` | public | Up to 20 `{id, name, birthYear, deathYear}`. `q` is at least 2 characters; matching is by trigram similarity plus prefix on `display_name`. |
| `GET /me` | signed in | `{email, name, role}`, or 403 `not_an_editor`. |
| `POST /changes` | editor | Body `{kind, params}`. Runs the command; returns `{change: {id, summary}, view}`, where `view` is the unmasked `person_view` of the command's focus person (null after `delete_person`). |
| `GET /changes?before=&limit=&person=` | editor | Newest first, 50 per page: `{id, created_at, author_name, author_email, kind, via, summary, person_ids, reverts_change_id, reverted_by_change_id}`. |
| `POST /changes/:id/revert` | editor | `revert_change(id, …, via='history')`; returns `{change}`, or 409 `{error:'conflict', blocking:[…]}`, or 409 `{error:'already_reverted'}`. |
| `POST /undo`, `POST /redo` | editor | Returns `{change}` or `{change: null}` when there is nothing to do; 409 on conflict, as above. |
| `GET /editors`, `POST /editors`, `DELETE /editors/:email` | admin | List; add `{email, name, role}`; remove. An admin cannot remove themselves, and the last admin cannot be removed. |

**CORS:** `Access-Control-Allow-Origin: *` (bearer tokens, no cookies), allowed methods `GET, POST, DELETE, OPTIONS`, allowed headers `authorization, content-type, if-none-match`.

**Errors:** `400 {error:'invalid', field, message}` for validation, 401, 403, `404 not_found`, `409 conflict | stale | already_reverted`, and 500 `internal` (logged).

### Commands (`api/commands/*.js`)

Each command module exports `{ kind, validate(params), run(tx, params, user) → { summary, personIds, focusId } }`.

`api/changes.js` runs every command the same way:
1. `begin`
2. insert the `change` row with a placeholder summary
3. `set_config('ged.change_id', id, true)`
4. `run`
5. update `summary` and `person_ids`
6. `commit`

Any error rolls everything back, so no change row is left behind.

Shared rules:
- `display_name = trim(given_name || ' ' || surname)`.
- Every person write sets `updated_at = now()`.
- Every name in a summary uses the display name, with "Unnamed person" when it is empty.

| kind | params | Rules |
|---|---|---|
| `update_person` | `id`, `expectedUpdatedAt`, `fields` (any of `given_name`, `surname`, `sex`, `birth_date`, `birth_place`, `death_date`, `death_place`, `baptism_date`, `baptism_place`, `burial_date`, `burial_place`), `facts` (optional, the whole object) | `update … where id = $1 and updated_at = $expected`. 0 rows → 409 `stale` (or 404). Summary: "Edited Rose Smith (birth date, notes)". |
| `add_relative` | `anchorId`, `relation` (`parent`, `child`, `spouse`, `sibling`), `person` {fields, facts?}, `familyId?` | Creates the person and links them (rules below). Summary: "Added Rose Smith as a daughter of Tom Smith". Focus: the anchor. |
| `link_existing` | `relation` (`parent`, `child`, `spouse`, `sibling`), `anchorId`, `otherId`, `familyId?` | The same linking rules with an existing person. Summary: "Linked Ann Jones as the mother of Rose Smith". |
| `update_family` | `id`, `expected` {four fields as seen}, `fields` {`marriage_date`, `marriage_place`, `divorce_date`, `divorce_place`} | Compare-and-swap on the four fields (`is not distinct from`); 0 rows → 409 `stale`. Summary: "Edited the marriage of Tom Smith and Ann Jones". |
| `unlink` | `familyId`, `personId`, `role` (`partner` or `child`) | Partner: set that slot to null. Child: delete the `family_child` row. Afterwards, a family with no partners and no children is deleted. Summary: "Removed Rose Smith as a child of Tom Smith and Ann Jones". |
| `delete_person` | `id`, `expectedUpdatedAt` | Deletes the person; the FK cascades remove the links. Afterwards, families left with no partners and no children are deleted. Summary: "Deleted Rose Smith". Focus: their first parent, else first spouse, else null. |

**Linking rules** (A is the anchor, B the new or existing person):

- **parent:** let P be `familyId` if given (it must be one of A's parent families), else A's only parent family.
  - If A has no parent family, create `F(B, null)` with child A.
  - If A has several parent families and no `familyId` was given, that is invalid.
  - If P has an empty slot, put B in it: partner1 if empty, else partner2.
  - If both slots are full, that is invalid ("already has two parents in that family").
- **spouse:** create `F(A, B)`.
  - Invalid if A and B already share a family as partners.
- **child:** let P be `familyId`, which must be a family where A is a partner, or `'new'`.
  - `'new'` uses A's existing single-parent family if there is exactly one, else creates `F(A, null)`.
  - B is added at position = max+1.
- **sibling:** let P be `familyId` (one of A's parent families), else A's only parent family.
  - If A has none, create `F(null, null)` with A at position 0.
  - B is added at position = max+1.
- **Always invalid:**
  - B equals A.
  - B is already a child of P.
  - Linking would make someone their own ancestor. This is checked with a recursive CTE over parent links: refuse if B is an ancestor of A when making B A's child, or a descendant of A when making B A's parent.
- Partner order follows the existing convention (partner1 ≈ HUSB). When B is male and the other partner is not, B goes in partner1, otherwise in the free slot. This is cosmetic and changes nothing semantically.

**Validation:**
- `sex` is M, F or U.
- Each text field is at most 500 characters.
- `facts` must match the full-facts model: known keys only, `Fact` shapes, each note at most 50,000 characters, the whole object at most 200 KB as JSON.
- An empty `given_name` with an empty `surname` is allowed: GEDCOM has unnamed children.

## Front end

| File | Responsibility |
|---|---|
| `src/auth.js` (new) | Creates the `@neondatabase/auth` client from `VITE_NEON_AUTH_URL`. Provides `signInWithEmailCode(email)`, `verifyEmailCode(email, code)`, `signInWithGoogle()`, `signOut()`, `getToken()` (a cached JWT refreshed before its 15-minute expiry), and `onChange(listener)`. On load, it restores the session and calls `GET /me` to learn the role. |
| `src/editApi.js` (new) | `authedFetch` adds the bearer token and maps errors to `ApiError {status, code, blocking}`. Exposes `runChange(kind, params)`, `revert(id)`, `undo()`, `redo()`, `listChanges({before, person})`, `search(q)`, and the editors calls. |
| `src/dataLoader.js` | Sends the bearer token when signed in as an editor, so it gets unmasked views. Adds `invalidateAll()` and a 5-minute TTL on cached views. |
| `src/signIn.js` (new) | Header button, sign-in dialog (email → code; Google), and account menu (History, Editors, Sign out). |
| `src/personEditor.js` (new) | Edit form for the selected person: core fields, the four life events with notes, cause of death, person notes, a facts list (occupations, residences, census and other facts as rows of type/value/date/place/notes), email and phone. It also has Delete. It builds `update_person` and `delete_person`. |
| `src/relativeDialog.js` (new) | + Parent / Spouse / Child / Sibling dialog with "New person" and "Existing person" (search) tabs. It asks for the family ("with which partner?") when there is more than one candidate, and builds `add_relative` and `link_existing`. |
| `src/familyEditor.js` (new) | Edits marriage and divorce details from a marriage row, building `update_family`. |
| `src/historyPanel.js` (new) | Slide-over list with infinite scroll, a person filter, Revert and Restore buttons, conflict messages that link to the blocking change, and person links. |
| `src/editorsDialog.js` (new) | Admin list of editors, with add and remove. |
| `src/toast.js` (new) | Transient messages with an optional action (Undo). |
| `src/personDetails.js` | When `canEdit`, shows an Edit button, the + relative buttons, × on relationship rows, and a "History of this person" link. |
| `src/main.js` | Wires sign-in state and keyboard shortcuts. After any change it calls `invalidateAll()`, re-renders the focus person from the returned `view` (or the default person after a delete), and shows a toast with Undo. |

Rules:
- Every interpolated value goes through `escapeHtml`, or is set with `textContent`.
- Shortcuts are ignored while focus is in an `input`, `textarea` or `select`.
- Dialogs go full screen below 768 px.
- Errors appear inline in the dialog (validation) or as a toast (conflicts, network).
- A 409 `stale` offers "Reload this person".

## Error handling summary

| Situation | Behaviour |
|---|---|
| Token expired | `getToken()` refreshes it. If the refresh fails, the UI shows "Signed out — sign in again", and the unsaved form stays open. |
| Signed in, not an editor | The edit controls are hidden, and the account menu explains how to get access. |
| Concurrent edit of the same person | 409 `stale` → "Someone else changed this person. Reload to see their changes." |
| Revert blocked by a later change | 409 `conflict` → "Undo isn't possible until these later changes are reverted:" followed by links. |
| Undo or Redo with nothing to do | Toast "Nothing to undo" / "Nothing to redo". |
| Command validation | 400 → inline field error. |

## Testing

- **DB tests (`tests/db/`, `test` branch):**
  - the capture trigger: insert, update, delete, cascades, no-op updates skipped, and refusal without `ged.change_id`
  - `revert_change` for each command kind, including deleting a person with partners, children and photos
  - conflict detection and the reported blocking ids
  - restore (revert of a revert)
  - `undo_last` and `redo_last` stack semantics, including "a new edit clears redo"
  - the sequences
  - `person_record`'s new fields
  - search
- **Command tests** (`tests/db/commands.test.js`, against the `test` branch): every linking rule and its invalid cases, cycle refusal, stale detection, summaries, and `person_ids`.
- **API unit tests:** routing, CORS and preflight, and auth with locally signed EdDSA tokens (valid, expired, wrong issuer, unverified email, not an editor, admin-only routes), using fake DB functions. Masking applies only to anonymous callers.
- **Front-end unit tests (jsdom):** `editApi` error mapping, token refresh, building the person editor's fields and facts round trip (form → facts → form is identity), the relative dialog's family choice, and the history panel's rendering and button states.
- **Manual (browser, `editing` branch):**
  - sign in by email code and with Google
  - session survives a reload
  - every command once
  - Undo/Redo by keyboard
  - History revert and restore
  - a forced conflict
  - a non-editor account
  - admin adds and removes an editor
  - phone width
  - Safari via the iOS Simulator if available

## Rollout

1. Development and all tests on the `editing` Neon branch.
2. **Preconditions:** PR #3 is merged and its backfill applied (or abandoned), and this branch is rebased onto `main`.
3. **Production:**
   1. `neon deploy` with `auth: true`: enables Auth and redeploys the Function.
   2. Enable the Email OTP plugin, and Google with shared credentials until the developer's OAuth client exists.
   3. Add the trusted domain `https://robacourt.github.io`.
   4. Run `npm run db:migrate` (006).
   5. Run `npm run verify-neon`. The read path must be unchanged.
   6. Smoke-test `/me` and one `update_person` plus revert against production with the developer's account. This leaves no net change, and both changes stay in history.
4. Merge the front end (one PR). Pages publishes it, and the Edit controls appear only for signed-in editors.
5. **Rollback:**
   - Revert the front-end merge.
   - The tables and triggers can stay, since they're harmless.
   - If needed, the edits themselves can be reverted from History before rolling back.

## Next release: photos (design notes only)

- `POST /uploads` (editor) returns presigned PUT URLs for `originals/<sha>.<ext>` (the client computes the sha). The Function mints them with the branch's S3 credentials.
- Thumbnails are made in the browser (canvas → WebP), or by a Function Trigger on object creation.
- `add_photo`, `remove_photo` and `set_avatar` commands insert or delete `media` and `person_media` rows and set `avatar_key`, so they are recorded and undoable like everything else.
- Objects are never deleted, so a revert can always restore a photo.
