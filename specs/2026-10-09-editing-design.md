# Editing with sign-in and infinite undo: design

**Date:** 2026-10-09
**Status:** Revision 2, after spec review. The undo mechanism is reworked: base changes are toggled by undo/redo changes, conflicts are checked per column, cascades are checked, and every write takes one advisory lock. The developer approved the design sections in conversation and asked for it to be built without further review gates.
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
| Undo mechanism | A `change` row per edit, with row-level before and after snapshots captured by triggers in `change_row`. One generic, column-aware `toggle_change` undoes or redoes a base change and records that as its own `undo` or `redo` change. There are no revert-of-revert chains. |
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
| Email code | Part of Managed Auth's fixed plugin set; there is no separate switch. Neon's shared SMTP is fine for a handful of relatives; it is rate limited, so a custom SMTP provider is a later option. | the same |
| Email/password | Left on, for development accounts only. | Disabled. |
| Google | Neon's shared development Google credentials. | The developer creates a Google OAuth client (Google Cloud Console → Credentials → OAuth client ID, web). The redirect URI is `{NEON_AUTH_BASE_URL}/callback/google`, set with `neon neon-auth oauth-provider`. Until then the shared credentials keep working, but the consent screen names Neon. |
| Trusted domains | localhost is allowed by default. | `https://robacourt.github.io` |
| Front-end env | `.env.development.local` (gitignored) overrides `VITE_API_URL`, `VITE_MEDIA_BASE_URL` and `VITE_NEON_AUTH_URL` with the `editing` branch's values. | `.env.production` gains `VITE_NEON_AUTH_URL`. |

The Function gets `NEON_AUTH_BASE_URL` and `NEON_AUTH_JWKS_URL` injected when Auth is enabled on its branch.

## Step 0: spike (done 2026-10-09, on the `editing` branch)

The front end is served from `github.io` (and `localhost`), while Auth lives on a Neon domain, so the session cookie is cross-site.

| # | Check | Result |
|---|---|---|
| 1 | Sign-in from the page and get a JWT | ✅ Password sign-up and sign-in (enabled by default on a new Auth branch) work from `localhost:5174`. The JWT is **not** in the sign-in response. It comes from the `set-auth-jwt` header of `GET /get-session`, which the SDK copies into `session.token`. So `(await auth.getSession()).data.session.token` is the API token; `auth.token()` returns `{data: {session, user}}`. Email-code delivery can't be tested without a real mailbox; it's left to the developer's manual test. |
| 2 | Google sign-in | Not tested: it needs the developer's Google account. The branch already lists Google with Neon's shared credentials. This is left to the manual test. |
| 3 | Session survives a reload | ✅ in Chromium. The session cookie is `__Secure-neon-auth.session_token`, set `HttpOnly; Secure; SameSite=None; Partitioned` (CHIPS). It works cross-site wherever partitioned cookies are supported: Chrome, Edge, Firefox, and recent Safari. The raw session token is **not** accepted as a bearer credential, and no JWT is issued without the cookie. So a browser that blocks the cookie can view but cannot edit. |
| 4 | Function-side verification | ✅ `jose.jwtVerify(token, createRemoteJWKSet(NEON_AUTH_JWKS_URL), { issuer, audience: issuer })` with `issuer = new URL(NEON_AUTH_BASE_URL).origin`. The header is `EdDSA` with a `kid`. The payload has `email`, `emailVerified`, `name`, `sub`, `role: "authenticated"` (the Data API role, not ours), `iat`, `exp` (15 minutes), `iss` and `aud`. A tampered token is rejected. |

**Decisions from the spike:**
- **Browser support for editing.** Editing needs partitioned-cookie support. If a sign-in completes but `getSession()` comes back empty, the UI says: "Your browser blocked the sign-in cookie. Editing needs a recent Safari/iOS, Chrome, Edge or Firefox." Viewing is unaffected.
  - The developer confirms iPhone Safari during the manual test.
  - A custom domain shared by the site and Auth would remove the dependency; that is a later option.
- **`emailVerified` is mandatory.**
  - Email/password sign-up is on by default and doesn't verify the address, so anyone could register a password account under an editor's email. The API therefore requires `emailVerified === true`.
  - In production, email/password is disabled (`neon neon-auth config email-password update`), leaving email code and Google.
  - The `editing` branch keeps it, for development accounts.
- **Development accounts.**
  - `dev-admin@example.test`, `dev-editor@example.test` and `dev-viewer@example.test` are created by password sign-up on the `editing` branch only.
  - They are marked verified with `update neon_auth."user" set "emailVerified" = true where email like 'dev-%@example.test'`, and dev-admin and dev-editor are added to `editor` on that branch.
  - A password sign-in form appears only when `import.meta.env.DEV` is true.
- **Production Auth already exists.** Neon Auth was enabled on `production` at 2026-10-09 09:13 UTC, outside this work. Release only adds plugins, trusted domains and config.

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
  id              bigint generated always as identity primary key,
  created_at      timestamptz not null default now(),
  author_email    text not null,
  author_name     text,
  kind            text not null,  -- a command kind (update_person, add_relative, …), or 'undo' / 'redo'
  via             text not null check (via in ('edit', 'history', 'keyboard', 'script')),
  summary         text not null,  -- "Jane added Rose Smith as a daughter of Tom Smith"
  params          jsonb not null, -- the command as received; for undo/redo: {"base": id}
  person_ids      text[] not null default '{}',
  base_change_id  bigint references change (id), -- undo/redo only: the base change toggled
  undone          boolean not null default false, -- base changes only: currently undone?
  last_toggle_id  bigint references change (id)  -- base changes only: latest undo/redo of it
);
create index change_author_idx on change (author_email, id desc);
create index change_person_ids_idx on change using gin (person_ids);
create index change_base_idx on change (base_change_id);

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
create index change_row_key_idx on change_row (table_name, row_key, change_id desc);
```

- **Base and toggle changes.** A *base change* is any command. An *undo* or *redo* change toggles exactly one base change and is never toggled itself.
- **Status.** A base change is "in effect" while `undone = false`.
- **History.** Base changes get Revert (when in effect) or Restore (when undone). Undo and redo changes appear as plain log lines, for example "Ann undid: Added Rose Smith…".

### Opening a recorded change

`begin_change(author_email, author_name, kind, via, summary, params, person_ids) returns bigint` (plpgsql):
1. Takes `pg_advisory_xact_lock(7262021)`, the single global write lock, before anything else.
2. Inserts the `change` row.
3. Runs `set_config('ged.change_id', id::text, true)`.
4. Returns the id.

**Who calls it.** Every write path calls it first in its transaction: API commands, `toggle_change`, test fixtures, and any future script or data migration (`via = 'script'`). The summary can be updated later in the same transaction.

**Why one global lock.** Writes are rare, so serialising them costs nothing. It means:
- no lost updates or write skew (two concurrent links can't form a cycle unseen)
- no deadlocks
- change ids appear in commit order, which the conflict search and the ETag rely on

### Capture trigger

- **Row trigger.** `capture_change()` is a plpgsql `AFTER INSERT OR UPDATE OR DELETE FOR EACH ROW` trigger on `person`, `family`, `family_child`, `media` and `person_media`.
  - It is declared `set timezone = 'UTC'` so timestamp text in snapshots is stable.
  - It reads `current_setting('ged.change_id', true)`. If that is null or empty, it raises `tree tables can only be changed inside a recorded change (call begin_change)`.
- **Truncate guard.** A `BEFORE TRUNCATE` statement trigger on the same tables raises unconditionally. `import-ged --replace` therefore stops working, which is intended: Neon is the master copy, and the import is retired.
- **Snapshots.**
  - A snapshot is `to_jsonb(row)` minus generated columns: every column with `attgenerated <> ''`, looked up in `pg_attribute`. Today that is only `family.sort_key`.
  - `row_key` is built from the table's primary key columns.
- **No-op updates.** An `UPDATE` whose new snapshot equals the old one is not recorded.
- **Cascades.** Rows changed by FK cascades fire the same trigger in the same transaction, so they land in the same change.
- **Empty commands.** A command that ends with no `change_row` rows is rolled back as `no_change` (400). Ctrl+Z therefore never "undoes" an invisible edit.

### IDs

- `create sequence person_number_seq` and `family_number_seq` are each started at max(numeric part)+1 of the existing ids.
- New ids are `'I' || nextval(...)` and `'F' || nextval(...)`.
- Gaps after a rollback are acceptable.

### Read-side additions

**`person_record`** is replaced, copying 005's version (the latest at the time of writing). It gains:
- **`updatedAt`:** `to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`. It is a string with microseconds, sent back verbatim for optimistic concurrency. It is never parsed into a JS `Date`, which would lose the microseconds.
- **`parentFamilies`:** `[{ familyId, partnerIds: [..], childIds: [..] }]`, the families where the person is a child, ordered `start_year nulls last, sort_key, id` (from `dated_family`). Used to choose a family for "+ Sibling" and "+ Parent".

`family` gets no new column, so 005's `dated_family` view needs no change.

**Search:** `create extension if not exists pg_trgm; create index person_name_trgm_idx on person using gin (display_name gin_trgm_ops);`

### Undo and redo: `toggle_change(base bigint, direction text, author_email, author_name, via) returns bigint`

This is plpgsql with `set timezone = 'UTC'`. `direction` is `'undo'` or `'redo'`. It raises custom SQLSTATEs: `GE001 not_found`, `GE002 wrong_state`, `GE003 conflict` (detail: JSON `{blocking: [ids], reason}`) and `GE004 no_change`.

1. **Open and check.**
   - Call `begin_change(…, kind = direction, …)`, which takes the global lock.
   - Lock the base row.
   - `not_found` if it doesn't exist or is itself an undo/redo.
   - `wrong_state` if `undone` doesn't match the direction: undo needs `false`, redo needs `true`.
2. **Net effect per row.**
   - Group the base's `change_row`s by `(table_name, row_key)`.
   - `initial` is the `before` of the earliest of them; `final` is the `after` of the latest.
   - For an undo, `from = final` and `to = initial`. For a redo, the other way round.
   - Comparable columns are those present in both the snapshot and the table's current non-generated columns, minus `updated_at`.
3. **Preconditions, per key.**

   | Net op (from → to) | Requires now | Applies |
   |---|---|---|
   | row → null (remove) | The row exists and equals `from` on all comparable columns. | `DELETE` by key |
   | null → row (re-create) | No row with that key exists. | `INSERT` with an explicit column list (the snapshot's columns that still exist, minus generated ones). `media` uses `overriding system value`. |
   | row → row (modify) | The row exists. On the columns C where `initial` ≠ `final`, it equals `from`. | `UPDATE` setting only C to `to`, and `updated_at = now()` when the table has it. Key, identity and generated columns are never in C. |

   - **Per-column checks.** These are per column, so a later edit to *other* columns of the same row (for example someone's notes) doesn't block undoing an earlier birth-date edit.
   - **Referenced rows.** Each to-state row's foreign keys must reference rows that exist, or that this toggle re-creates:
     - `family.partner1_id` and `partner2_id` → `person`
     - `family_child.family_id` → `family`, and `child_id` → `person`
     - `person_media.person_id` → `person`, and `media_id` → `media`
   - **Order.** Re-creates run in rank order: `person` and `media` (1), `family` (2), `family_child` and `person_media` (3). Then modifies. Then removes in reverse rank order.
4. **Cascade check.**
   - After applying, every `change_row` written under this toggle must have a key in the base's key set.
   - An extra key means a delete cascaded into a later change, for example a child linked into a family that the undo removes. That raises `conflict`.
5. **Blocking changes.** For any failed precondition or cascade, `blocking` lists, up to 5, the in-effect changes that last touched the offending keys or columns after the base.
   - "In effect" means a base change not undone, or the base change behind a later toggle.
   - If none can be found (for example the data changed outside the history, or after a schema change), `blocking` is empty and `reason` is `untracked`. The UI then says: "This change can't be undone automatically: the data has changed in a way the history doesn't explain."
   - Any FK or unique violation that still occurs (`23503`, `23505`) is caught and re-raised as `GE003` with `reason: 'constraint'`.
6. **Bookkeeping.**
   - Set the base's `undone` (true for undo, false for redo) and `last_toggle_id`.
   - Set the toggle change's `base_change_id`, `person_ids` (the base's), and summary: "Undid: <base summary>" or "Redid: <base summary>".
   - Return the toggle change's id.

**Per-user Undo and Redo** (keyboard and toast; `via = 'keyboard'`):
- **`undo_last(email, name)`** toggles, as an undo, the author's most recent base change with `undone = false`. It returns null when there is none. So Ctrl+Z undoes *your own* most recent edit that is still in effect.
- **`redo_last(email, name)`** finds the author's most recent `via = 'keyboard'` undo change U.
  - It acts only if U's base is still undone, U is newer than the author's latest base change, and U is newer than any later redo of that base by the author.
  - Then it toggles U's base as a redo.
  - A new edit clears the redo stack, as in any editor.
- **History buttons** (`via = 'history'`): Revert = `toggle_change(id, 'undo')`, Restore = `toggle_change(id, 'redo')`. Anyone can use them on anyone's change.

## API (Function `api`)

### Authentication (`api/auth.js`)

- `authenticate(request)`:
  - reads `Authorization: Bearer <jwt>`
  - verifies it with `jose.jwtVerify` against `createRemoteJWKSet(new URL(NEON_AUTH_JWKS_URL))`, with `issuer` and `audience` both `new URL(NEON_AUTH_BASE_URL).origin`
  - requires `emailVerified === true` (Google sign-ins are verified)
  - returns `{ email: lower(email), name }`
- A missing or invalid token gives `401 {error: 'unauthenticated'}`.
- Verification pins `algorithms: ['EdDSA']`.
- `requireEditor(user, db)` looks up `editor`. It returns `{...user, role, name: editor.name ?? token name}`, or `403 {error: 'not_an_editor', email}`. `author_name` in changes comes from `editor.name`, because email-code users' tokens may have no name.
- The JWKS URL and issuer are injectable for tests, which sign tokens with a locally generated Ed25519 key.

### Routes

| Method & path | Who | Result |
|---|---|---|
| `GET /person/:id` | public | As today, with `masked: true/false` added to the view. **Non-editors** (anonymous or signed-in without editor access) get masked notes. Their 200s are sent `Cache-Control: public, max-age=0, must-revalidate`, `Vary: Authorization`, and a weak `ETag` of `W/"<VIEW_VERSION>.<latest change id>.<id>"` (`VIEW_VERSION` is a constant in the Function, bumped whenever view output or masking changes). `If-None-Match` is answered with 304 for non-editors only. **Editors** (valid token) always get a fresh 200 with the unmasked view and `Cache-Control: private, no-store`. A request with an invalid or expired token gets 401, never a silent anonymous view. |
| `GET /search?q=&limit=` | public | Up to 20 `{id, name, birthYear, deathYear}`. `q` is at least 2 characters; matching is by trigram similarity plus prefix on `display_name`. |
| `GET /me` | signed in | `{email, name, role}`, or 403 `not_an_editor`. |
| `POST /changes` | editor | Body `{kind, params}`. Runs the command; returns `{change: {id, summary}, view}`, where `view` is the unmasked `person_view` of the command's focus person (null after `delete_person`). |
| `GET /changes?before=&limit=&person=` | editor | Newest first, 50 per page: `{id, createdAt, authorName, authorEmail, kind, via, summary, personIds, baseChangeId, undone}`. |
| `POST /changes/:id/revert`, `POST /changes/:id/restore` | editor | `toggle_change(id, 'undo' / 'redo', …, 'history')`. Returns `{change: {id, summary, personIds}}`, or 409 `{error: 'conflict', reason, blocking: [{id, summary, authorName, createdAt}]}`, or 409 `{error: 'wrong_state'}`. |
| `POST /undo`, `POST /redo` | editor | `undo_last` / `redo_last`. Returns `{change}`, or `{change: null}` when there is nothing to do; 409 on conflict, as above. |
| `GET /editors`, `POST /editors`, `DELETE /editors/:email` | admin | List; add `{email, name, role}`; remove. An admin cannot remove themselves, and the last admin cannot be removed. |

**CORS:** `Access-Control-Allow-Origin: *` (bearer tokens, no cookies), allowed methods `GET, POST, DELETE, OPTIONS`, allowed headers `authorization, content-type, if-none-match`, `Access-Control-Max-Age: 86400`.

**Request bodies** are limited to 1 MB (`413`). Search escapes `%`, `_` and `\` in the prefix match.

**Errors:** `400 {error: 'invalid', field, message}` for validation, `400 no_change`, 401, 403, `404 not_found`, `409 conflict | stale | wrong_state`, `413`, and `500 internal` (logged). Postgres `GE00x` SQLSTATEs map to these.

### Commands (`api/commands/*.js`)

Each command module exports `{ kind, validate(params), run(tx, params, user) → { summary, personIds, focusId } }`.

`api/changes.js` runs every command the same way:
1. `begin`
2. `begin_change(…, summary = 'pending')`, which takes the global lock and sets `ged.change_id`
3. `run`
4. If no `change_row` was written, roll back with `no_change`
5. Update `summary` and `person_ids`
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

**Linking rules** (A is the anchor, B the new or existing person). A family always keeps at least one partner; partnerless families are never created.

- **parent:**
  - Let P be `familyId` if given (it must be one of A's parent families), else A's only parent family.
  - If A has no parent family, create `F(B, null)` with child A.
  - If A has several parent families and no `familyId` was given, that is invalid.
  - If P has an empty partner slot, put B in it (partner order below).
  - If both slots are full, that is invalid ("already has two parents in that family"). A second, for example adoptive, parent family is out of scope.
  - **Cycle check:** B must not be a child of P, and must not be a descendant-or-self of any child of P. B becomes a parent of all of P's children.
- **spouse:**
  - Create `F(A, B)`.
  - Invalid if A and B already share a family as partners, or if one is an ancestor or descendant of the other.
- **child:**
  - Let P be `familyId`, which must be a family where A is a partner, or `'new'`.
  - `'new'` uses A's existing single-parent family if there is exactly one with A as the only partner, else creates `F(A, null)`.
  - B is added at position = max+1.
  - **Cycle check:** B must not be an ancestor-or-self of any partner of P. B becomes a child of every partner of P.
- **sibling:**
  - Let P be `familyId`, which must be one of A's parent families, else A's only parent family.
  - If A has no parent family, that is invalid: the UI disables "+ Sibling" with the hint "Add a parent first".
  - B is added at position = max+1, with the same cycle check as for child.
- **Child or sibling already in P:** invalid.
- **An existing B who already has parents** may still be linked as a child or sibling. They then have two parent families, which GEDCOM allows. The dialog warns "Rose already has parents; she will have two sets of parents".
- **Cleanup** after `unlink` and `delete_person`:
  - A family left with no partners is deleted, along with its child links. Removing the last parent therefore also removes the sibling link between their children, and the confirmation says so.
  - A family left with one partner and no children is also deleted, because otherwise it would show an "Unknown" spouse.
- **Partner order** follows the existing convention (partner1 ≈ HUSB): when B is male and the other partner is not, B goes in partner1, otherwise in the free slot. This is cosmetic.

**Validation:**
- `sex` is M, F or U.
- Single-line text fields are at most 500 characters. Today's maximum is 64.
- `facts` is validated leniently, so that every existing row can be saved unchanged:
  - **Keys** may be from the full-facts model or its predecessor (`notes`, `occupations`, `censusRecords`, `residences`, `birthNotes`, `baptismNotes`, `deathNotes`, `burialNotes`, `causeOfDeath`, `otherFacts`, `email`, `phone`, `religion`, `education`).
  - **Values** are strings, string arrays, or arrays of objects whose values are strings, null or string arrays.
  - **Sizes:** each string is at most 100,000 characters, and the whole object at most 500 KB as JSON. The largest real person is about 30 KB after the backfill.
- A test asserts that every existing person on the `editing` branch passes validation.
- Empty `given_name` and `surname` together are allowed, because GEDCOM has unnamed children.

## Front end

| File | Responsibility |
|---|---|
| `src/auth.js` (new) | Creates the `@neondatabase/auth` client (`createAuthClient(VITE_NEON_AUTH_URL)`). Provides `sendEmailCode(email)` (`emailOtp.sendVerificationOtp({email, type: 'sign-in'})`), `verifyEmailCode(email, otp)` (`signIn.emailOtp`), `signInWithGoogle()` (`signIn.social({provider: 'google', callbackURL: location.href})`), a dev-only `signInWithPassword`, `signOut()`, `onChange(listener)`, and `getToken()`. `getToken()` returns `session.token` from `getSession()`, forcing a fresh fetch (`fetchOptions.headers['X-Force-Fetch']`) when the cached JWT's `exp` is within 60 s. On load, it restores the session and calls `GET /me` to learn the role. |
| `src/editApi.js` (new) | `authedFetch` adds the bearer token and maps errors to `ApiError {status, code, blocking}`. Exposes `runChange(kind, params)`, `revert(id)`, `undo()`, `redo()`, `listChanges({before, person})`, `search(q)`, and the editors calls. |
| `src/dataLoader.js` | Sends the bearer token when signed in as an editor, so it gets unmasked views. Adds `invalidateAll()`: it clears the cache and `prefetched`, and bumps a generation counter so in-flight responses from before the call are discarded. It is called on sign-in, sign-out and after every change. Adds a 5-minute TTL on cached views. |
| `src/signIn.js` (new) | Header button, sign-in dialog (email → code; Google), and account menu (History, Editors, Sign out). |
| `src/personEditor.js` (new) | Edit form for the selected person: core fields, the four life events with notes, cause of death, person notes, a facts list, email and phone. It also has Delete. It builds `update_person` and `delete_person`. **Facts list rows** have a kind (Occupation, Residence, Census, or Other with a `tag` chosen from `factLabels`' list plus free text), value, date, place, notes, and for Other also `type` and `cause`. Old-shape values (plain occupation strings, `religion`/`education`) are shown and saved back in their original shape unless edited. It refuses to open a view with `masked: true`, reloading it with the token first. |
| `src/relativeDialog.js` (new) | + Parent / Spouse / Child / Sibling dialog with "New person" and "Existing person" (search) tabs. It asks for the family ("with which partner?") when there is more than one candidate, and builds `add_relative` and `link_existing`. |
| `src/familyEditor.js` (new) | Edits marriage and divorce details from a marriage row, building `update_family`. |
| `src/historyPanel.js` (new) | Slide-over list with infinite scroll, a person filter, Revert and Restore buttons, conflict messages that link to the blocking change, and person links. |
| `src/editorsDialog.js` (new) | Admin list of editors, with add and remove. |
| `src/toast.js` (new) | Transient messages with an optional action (Undo). |
| `src/personDetails.js` | When `canEdit`, shows an Edit button, the + relative buttons, × on relationship rows, and a "History of this person" link. |
| `src/main.js` | Wires sign-in state and keyboard shortcuts. After any change it calls `invalidateAll()` and re-renders. After a command it uses the returned `view`. After an undo, redo, revert or restore it reloads the current person. If that person no longer exists, it opens the change's first `personIds` entry that still exists, else the default person. It shows a toast with Undo after a command. |

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
  - `toggle_change` undo and redo for each command kind, including deleting a person with partners, children and photos
  - conflict detection and the reported blocking ids
  - restore (revert of a revert)
  - `undo_last` and `redo_last` stack semantics, including "a new edit clears redo", and undo → redo → undo → undo
  - a History revert of a redone change
  - per-column conflicts (a later notes edit doesn't block undoing a birth-date edit; a later birth-date edit does)
  - cascade conflicts (undoing a family creation after a later child link)
  - missing referenced rows (undoing an unlink after the partner was deleted)
  - `media` identity and `family.sort_key` handling
  - the TRUNCATE guard, the `no_change` rollback, and the global lock (two concurrent commands serialise)
  - the sequences
  - `person_record`'s new fields
  - search
- **Command tests** (`tests/db/commands.test.js`, against the `test` branch): every linking rule and its invalid cases, cycle refusal, stale detection, summaries, and `person_ids`.
- **API unit tests:** routing, CORS and preflight, and auth with locally signed EdDSA tokens (valid, expired, wrong issuer, unverified email, not an editor, admin-only routes), using fake DB functions. Masking applies only to anonymous callers.
- **Front-end unit tests (jsdom):** `editApi` error mapping, token refresh, the relative dialog's family choice, the history panel's rendering and button states, and `dataLoader` invalidation discarding in-flight responses.
- **Facts round trip:** for every real person on the `editing` branch, facts → form → facts is the identity, and the result passes validation.
- **Fixtures:** existing DB test fixtures (`tests/db/personView.test.js`) wrap their inserts in `begin_change(…, via = 'script')`.
- **`verify-neon`** skips people touched by any change (`person_ids`), since the legacy baseline no longer applies to them.
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
   1. Run `npm run db:migrate` (006). It is additive and compatible with the old Function, which only reads.
   2. `neon deploy` with `auth: true`: Auth already exists on production, and the Function is redeployed.
   3. Check that email code and Google are available; Google uses shared credentials until the developer's OAuth client exists. Disable email/password with `neon neon-auth config email-password update`.
   4. Add the trusted domain `https://robacourt.github.io`.
   5. Run `npm run verify-neon`. The read path must be unchanged.
   6. Smoke-test `/me` and one `update_person` plus revert against production with the developer's account. This leaves no net change, and both changes stay in history.
   7. **Developer's manual test on real devices:**
      - email-code sign-in (checks delivery and `emailVerified`)
      - Google sign-in
      - iPhone Safari: sign in, reload, then edit
      Relatives are invited only after this passes.
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
