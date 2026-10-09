# Parse the GEDCOM fully and show notes and events: design

**Date:** 2026-10-09
**Status:** Revision 2, after spec review. The developer approved the scope, data model, backfill and UI sections, and chose to mask email addresses in notes.
**Follows:** [2026-10-08-neon-migration-design.md](2026-10-08-neon-migration-design.md), whose non-goals deferred "parsing fields the current parser drops".

## Background

`scripts/gedParser.js` keeps only the tags the site displays, and it has four bugs. Measured on the archived `acourt.ged` (sha256 `2e68efeb…`, 3,063,220 bytes, 2,994 people, 1,029 families):

1. **CONT/CONC lines are ignored.** 160 people's own notes lose text: 150 have CONT lines and 10 have only CONC lines. I1 is one example. Brother's Keeper splits long lines mid-word at about 250 characters, and all 352 CONC splits fall inside a word, so CONC joins with no separator.
2. **Non-INDI/FAM level-0 records bleed into the last family.** The parser never clears `currentRecord`, so the lines of all 211 SOUR and 77 REPO records land on F1029 as `NAME`, `EMAIL`, `PHON` and `NOTE`. This has no visible effect today.
3. **Children of untracked level-1 tags bleed onto the person.** When a level-1 tag has no frame pushed for it (OCCU, EVEN, _MILT, PROB, EMIG, EDUC, CREM…), its descendants are applied to the person itself.
   - 92 people show event notes as their own notes. For example, I23's militia-list note "Parish of Marnhull".
   - 6 of those leaked notes are citation notes (OCCU>SOUR>NOTE ×3 and PROB>SOUR>NOTE ×3, on I86, I208, I726, I793, I824 among others).
   - The 873 occupation dates are lost.
   - **Media leak too.** 13 files attached to citations of such tags (`1 EVEN` > `2 SOUR` > `3 OBJE` > `4 FILE`), on 11 people (I114, I118, I377, I417, I418, I422, I423, I458, I459, I1423, I2009), become those people's photos: 1,262 photos in total, against 1,249 from level-1 OBJE.
     - There are 14 such OBJE nodes. The leaked OBJE stays open on the parser's stack until the next level-1 line, so I1423's second one (`Barnett 1A.jpg`) nests inside its first and is not a photo.
     - These photos are in production's `person_media` and shown on the live site. This change **keeps** them; see the photo rule below.
4. **`line.trim()` strips leading spaces** from values. Some notes are pasted web pages whose indentation carries meaning.

What is dropped today:

| Data | Count | Characters |
|---|---|---|
| Person-level NOTE (full text) | 420 notes, one each on 420 people. Today 483 people show notes, 63 of them only leaked ones. | 160K |
| Census transcriptions (CENS.NOTE) | 1,706 | 1.2M |
| Notes on other facts (BIRT, DEAT, OCCU, _MILT…) | 332 | 154K |
| Untracked facts (EVEN 79, _MILT 40, PROB 22, NCHI 19, EMIG 16, CREM 12, CHR 11, …) | ~240 | — |
| Occupation dates | 873 | — |
| Source citations (all pointers to 211 SOUR records) | 4,754 | — |

Per person, all notes together come to: median 0, p90 1.6 KB, p99 5 KB, maximum 30 KB (I777).

In the facts this change stores, 18 notes on 18 people contain 16 distinct email addresses, mostly in pasted email threads. On the live site today, I508 and I1388 already show an address in plain text, the browser swallows I711's (`<a@b.c>`) as a tag, and the rest are hidden by truncation.

Production state, checked read-only on 2026-10-09: for all 2,994 people, `person.facts` equals what today's parser derives from `gedcom_archive`, and every row has `updated_at = created_at`. `facts` is about 209 KB as compact JSON (259 kB as stored jsonb); the database is 11 MB.

## Goals

- Fix the four parser bugs, without changing any person column, photo list, family or child row.
- Store and show, for every person:
  - full person notes
  - census transcriptions
  - the notes on every fact
  - occupation dates and places
  - every other level-1 fact the parser drops today
- Backfill production's `person.facts` from `gedcom_archive`, touching only `facts`. Use a reviewed plan and compare-and-swap writes, never overwrite a row edited since the import, and keep a rollback.
- Escape every data value the details panel interpolates into HTML.
- Never publish email addresses found in note text.

## Non-goals

- **Sources:** SOUR records, citations (PAGE, QUAY, DATA.TEXT), citation notes, and citation media other than the 13 legacy photos above (for example the 68 CENS>SOUR>OBJE census images). They need their own model, so they get a later phase. The 6 leaked citation notes therefore leave `notes` and come back with sources.
- **Family-level data:** marriage notes (63), FAM NCHI/RESI/_SEPR, and media on families. These need a `family.facts` migration.
- **Photo titles and notes** (1,081 OBJE.TITL). They belong to `media`/`person_media`.
- **Name variants** (NAME._AKAN, NICK, _OTHN…), ASSO, REFN and CHAN.
- **Re-running `import-ged --replace`**, which is still never to be used against production.
- **Re-deriving facts after the editing phase starts.** That needs an audit trail, which this one-off doesn't have.

## Decisions

| Topic | Decision |
|---|---|
| Scope | Notes plus facts (the "all notes + events" tier). No sources and no family facts. |
| Parser | Two stages: a generic node tree, then today's `data` shape derived from it. Parity with today's output is proven by a test against a frozen copy of today's parser. |
| Storage | `person.facts` jsonb, which `person_record` already merges into the person. No migration. |
| `religion`, `education` | Folded into `otherFacts` (RELI and EDUC carry dates and notes; only 3 and 4 people have them). |
| Long text | Collapsed by default: fact notes go behind `<details>`; long person notes get "Show more". |
| Email addresses in notes | Masked as `[email hidden]` by the API Function, so they never leave the server. The stored facts keep the full text. |
| Backfill | A reviewed plan file, then a compare-and-swap apply in one transaction, with rollback from the same plan. Edited rows are excluded. Production is branched first as a safety net. |
| `updated_at` | It marks human edits. Import and backfill are re-derivations from the archive and leave it alone, so `updated_at <> created_at` always means "edited". Nothing reads it today. |
| Rollout | The front end (which accepts both old and new shapes) and the masking Function ship before the backfill. |

## Parser (`scripts/gedParser.js`)

### Stage 1: `parseGedcomTree(text)` (new export)

- Split on `\n` and strip a trailing `\r` from each line. Skip lines that are empty or only whitespace.
- Match each line with `^\s*(\d+) (?:(@[^@]+@) )?(\S+)(?: (.*))?$`. Lines that don't match are skipped, as today.
- **Node shape:** `{ level, xref, tag, value, children }`.
  - `xref` has its `@` signs removed, or is `null`.
  - `value` is everything after the single delimiter space, verbatim, or `''`.
- **Placement:**
  - A level-0 node starts a new root.
  - Any other node becomes a child of the nearest open node with a lower level. GEDCOM forbids level jumps and the file has none.
  - A level >0 line before the first root is skipped.
- **CONT and CONC** are folded into their parent's `value` and never become children. CONT appends `'\n' + value`; CONC appends `value`.
- **Returns** the array of level-0 roots, in file order.

### Stage 2: `parseGedcom(text)` (same signature and return shape as today)

- **Records.** Only INDI and FAM roots become records, keyed by xref; if an xref repeats, the last one wins, as with today's `Map.set`. Every other root (HEAD, SOUR, REPO, NOTE, OBJE, SUBM, TRLR…) is ignored, which fixes bug 2.
- **`node` property.** Each record also gets `node`, its stage-1 tree.
- **`data`.** Each record's `data` keeps only the keys that callers read. Values are trimmed, as today. Where a key can occur more than once, the last occurrence wins, as today's assignments do.

  | Record | `data` key | Derived from |
  |---|---|---|
  | INDI | `NAME`, `SEX`, `EMAIL`, `PHON` | The last level-1 node with that tag. |
  | INDI | `BIRT`, `DEAT`, `BAPM`, `BURI` | `{DATE?, PLAC?}` from the last level-1 node with that tag; `DATE`/`PLAC` come from that node's last direct child of that tag. |
  | INDI | `FAMS[]`, `FAMC[]` | Level-1 pointers, `@` removed. |
  | INDI | `OBJE[]` (`{FILES[]}`) | **Photo rule**, in document order of the level-1 nodes. Each level-1 OBJE is a photo. For every other level-1 node except BIRT, BAPM, DEAT, BURI, CENS, RESI, MARR and DIV, the **first** OBJE descendant in document order (if any) is a photo; later OBJE descendants of that same level-1 node are not. `FILES` holds the values of the chosen OBJE's direct FILE children. This reproduces today's photos exactly, including the 13 citation files of bug 3, as verified on the real file. |
  | FAM | `HUSB`, `WIFE`, `CHIL[]` | Level-1 pointers, `@` removed. |
  | FAM | `MARR`, `DIV` | Like BIRT. |

- **Removed keys.** `NOTE`, `OCCU`, `CENS`, `RESI`, `RELI`, `EDUC` and the stray keys leaked by bugs 2 and 3 are no longer put in `data`. Nothing outside `extractPersonData` reads them, and `extractPersonData` reads facts from `node`.

### `extractPersonData(parsedGed, id)`

- **Unchanged:** `id`, `name`, `givenName`, `surname`, `sex`, the birth, death, baptism and burial date and place, `photos` (from `data.OBJE`, as today), `spouseIds`, `childIds`, `parentIds`, `marriages`, `email`, `phone`.
- **Changed or new:** the facts fields below. `religion` and `education` are no longer returned.

## Facts model (`person.facts`)

**`Fact`** = `{ value?, date?, place?, notes? }`. Each key is present only when non-empty:

- `value` is the fact node's own value, trimmed.
- `date` and `place` come from the node's last direct `DATE` and `PLAC` children, trimmed.
- `notes` is a `string[]` built from the node's direct `NOTE` children. NOTEs under SOUR citations are excluded.

**Note text** is the folded NOTE value, kept verbatim (leading spaces, internal spacing and blank lines), with only `trimEnd()` applied to the whole note. A note that is empty after that is dropped.

| Key | Shape | Source |
|---|---|---|
| `notes` | `string[]` | Level-1 `NOTE` nodes of the INDI only. |
| `occupations` | `Fact[]` (was `string[]`) | Each level-1 `OCCU`. Entries where every field is empty are dropped. |
| `censusRecords` | `Fact[]` | Each level-1 `CENS`, kept if it has a date, place or notes. Old entries always had `date` and `place` (null when absent); now those keys are omitted when absent. |
| `residences` | `Fact[]` | Each level-1 `RESI`, with the same rule. |
| `birthNotes`, `baptismNotes`, `deathNotes`, `burialNotes` | `string[]` | Notes of the last `BIRT`, `BAPM`, `DEAT` and `BURI`, the same occurrence whose date and place fill the columns. |
| `causeOfDeath` | `string` | The last `CAUS` child of the last `DEAT`, trimmed. |
| `otherFacts` | `(Fact & { tag, type?, cause? })[]` | See below. |
| `email`, `phone` | `string` | Unchanged. |

**`otherFacts`.** In document order, one entry for each level-1 INDI node that is neither handled above nor ignored.

- **Handled:** NAME, SEX, BIRT, BAPM, DEAT, BURI, CENS, RESI, OCCU, NOTE, OBJE, FAMS, FAMC, EMAIL, PHON.
- **Ignored:** CHAN, SOUR, REFN, ASSO.
- **Earlier occurrences of a repeated BIRT, BAPM, DEAT or BURI** (5 people have one) also go to `otherFacts` under their own tag, so their data is no longer lost.
- **Entry fields:**
  - `tag` is the GEDCOM tag, for example `_MILT`.
  - `type` is the trimmed last `TYPE` child, if any.
  - `cause` is the trimmed last `CAUS` child, if any.
  - The rest of the entry is the `Fact`.
- **Empty entries are kept.** An entry with only a tag (for example `_ADPF`, adopted by father) is still a fact.

`person_record` merges `facts` before the core fields, so none of these keys can override a core field. None of them collides with one.

**`scripts/neon/gedToRows.js`** exports `personFacts(p)`, which turns `extractPersonData` output into the `facts` object (keys present only when non-empty). `gedToRows` uses it, so `import-ged` and the backfill can never disagree.

**Size.** `facts` grows from about 209 KB to about 1.8 MB of compact JSON. A typical `/person/:id` response grows by under 1 KB; the largest (I777) by about 30 KB.

## Email masking (`api/privacy.js`)

- `maskNoteEmails(view)` returns a copy of the view. In it, every string inside a `notes` key or any key ending in `Notes`, at any depth under `view.person`, has each match of `/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g` replaced with `[email hidden]`.
- Nothing else is changed. The `email` contact field is a deliberate, separate field and is left alone.
- `createHandler` applies it to every 200 response from `/person/:id`.
- The stored data is never masked.

## Backfill (`scripts/neon/backfillFacts.js`, `npm run backfill-facts`)

This is pure functions plus thin DB helpers and a CLI, like `gedToRows` and `importGed`.

### `planFacts(dbRows, derived)` (pure)

**Inputs:**
- `dbRows`: `[{ id, facts, edited, ...CORE_COLUMNS }]`. `edited` is a boolean the plan's SQL computes as `updated_at <> created_at`, so no timestamps reach JS.
- `derived`: the `gedToRows` people rows from the archive.

**`CORE_COLUMNS`** = `given_name`, `surname`, `display_name`, `sex`, `birth_date`, `birth_place`, `death_date`, `death_place`, `baptism_date`, `baptism_place`, `burial_date`, `burial_place`.

**Classification, in this order,** for each id in both inputs, comparing facts with `canonical()` from `verifyCompare.js`:
1. **unchanged:** the facts are equal.
2. **edited:** `edited` is true. The row is excluded and listed, because it may hold a human edit.
3. **changed:** everything else.

**Returns** `{ rows, summary }`:
- `rows` is `[{ id, before, after }]` for the changed people only.
- `summary` contains:
  - `unchanged`, `changed`
  - `edited`, `onlyInDb` and `onlyInGed`: id lists; those people are never written
  - `keys`: `{ [factKey]: { added, removed, changed } }` over the changed rows
  - `columnDrift`: `[{ id, column, db, derived }]` for any `CORE_COLUMNS` that differ. These are reported only, never written.

### `applyPlan(client, plan, { direction = 'apply', batchSize = 500 })`

- `client` is a connected `pg` client. The function owns the transaction.
- `direction` is `'apply'` (write `after` where `facts = before`) or `'rollback'` (write `before` where `facts = after`).
- It runs `begin`, then for each batch:
  ```sql
  update person p set facts = r.new
  from jsonb_to_recordset($1::jsonb) as r (id text, old jsonb, new jsonb)
  where p.id = r.id and p.facts = r.old
  returning p.id
  ```
- `updated_at` is deliberately left unchanged (see Decisions).
- If any batch returns fewer ids than it sent, it rolls back and throws `StalePlanError`, with `.ids` listing the batch's ids that were not returned. Otherwise it commits and returns `{ updated }`.

### `verifyPlan(client, plan, { direction = 'apply' })`

Re-reads the planned ids and returns the ids whose `facts` don't equal the expected side: `after` for an apply, `before` for a rollback.

### Supported sequences (all before the editing phase)

- **plan → apply → plan:** the second plan has zero rows.
- **plan → apply → rollback → plan:** the second plan's `rows` and `summary` equal the first's.
- **plan → apply → parser fix → plan:** the new plan moves the applied rows from the old `after` to the corrected facts. No row counts as edited, because the backfill never touches `updated_at`.

### CLI

**Connection.** Uses `DATABASE_URL_UNPOOLED`, or `--database-url <url>` for the rehearsal branch. `host` is that URL's hostname.

**Plan (the default).** It runs inside `begin read only` … `rollback`.
1. Load `gedcom_archive`. Exactly one row is required unless `--sha <sha256>` picks one. Recompute the sha256 of `content` and abort if it differs from the stored value.
2. Parse the archive, call `gedToRows(parsed, { files: {}, avatars: {} }, new Map())`, and read `id, facts, updated_at <> created_at as edited` plus `CORE_COLUMNS` for every person.
3. Call `planFacts` and write the plan, `{ createdAt, host, archiveSha, summary, rows }`, to `--out` (default `.neon-import/facts-backfill-plan-<host>.json`).
4. Print the summary and three sample before/after diffs. I1, I23 and I443 are used when they are in the plan.

**Apply** (`--apply <planPath> --confirm <host>`).
- Abort before writing unless `--confirm` equals both the connection host and the plan's `host`.
- Call `applyPlan`, then `verifyPlan`.
- Print the updated count, or the stale or mismatching ids, and exit 1 in that case.

**Rollback** (`--rollback <planPath> --confirm <host>`). The same, with `direction: 'rollback'`.

**Guarantees:**
- It never inserts, deletes, or writes any column but `facts`.
- An apply writes exactly the reviewed plan or nothing.
- Re-planning after an apply finds every person unchanged.

### `verify-neon`

- `scripts/neon/verifyCompare.js` drops `notes`, `occupations`, `censusRecords`, `residences`, `religion` and `education` from `SCALAR_KEYS`, with a comment. Those keys are re-derived by `backfill-facts` and checked by its own verification, so the old-parser JSON baseline no longer applies to them. Relationships, photos, avatars and the core fields are still compared.
- `scripts/neon/verify.js` compares the API body with `person_view` read from the database. That comparison moves into a helper, `apiMatchesView(body, view)` in `verifyCompare.js`, which applies `maskNoteEmails` to the database view first. Masked people (I508, I711 and I1388 today, 18 after the backfill) therefore don't report "body differs from database".

## Front end

| File | Change |
|---|---|
| `src/html.js` (new) | `escapeHtml(text)`, moved from `src/main.js`, which now imports it. |
| `src/factLabels.js` (new) | `factLabel(fact)`: EVEN with a `type` → the type. Known tags map to labels: `_MILT` Military service, `PROB` Probate, `EMIG` Emigration, `IMMI` Immigration, `CHR` Christening, `CREM` Cremation, `WILL` Will, `DSCR` Description, `NCHI` Number of children, `EDUC` Education, `RELI` Religion, `_HEIG` Height, `_WEIG` Weight, `_EYEC` Eye colour, `_HAIR` Hair colour, `_MEDC` Medical condition, `_INTE` Interment, `_ADPF` Adopted by father, `_ADPM` Adopted by mother, `_BRTM` Brit milah, `_MEMR` Memorial, `_NMAR` Never married, `EVEN` Event, `BIRT` Birth, `BAPM` Baptism, `DEAT` Death, `BURI` Burial. Any other tag drops a leading `_` and is shown capitalised (`_FOO` → "Foo"). |
| `src/personDetails.js` | Every interpolated data value goes through `escapeHtml`. The `mailto:`/`tel:` schemes stay literal. See the sections list below. |
| `src/style.css` | `.note-text { white-space: pre-wrap; overflow-wrap: anywhere; }`, the clamp style, and `details`/`summary` styles that match `.detail-item`, including at the existing mobile breakpoint. |

**Notes summary text.** A fact's notes sit in a `<details>`. Census entries use "Transcription", or "Transcriptions (n)" when there are several. Every other fact uses "Note" or "Notes (n)".

**Sections in `personDetails.js`:**

- **Life Events.** A Birth, Baptism, Death or Burial row appears when it has a date, a place, notes, or (for death) a cause. I1208's death, for example, has only the note "Died as an infant". Each row shows its notes; Death also shows `Cause: …`.
- **Occupations.** Each entry is shown as `value • date • place`, plus its notes. A string entry (the old shape) renders as its value.
- **Census Records and Residences.** Each entry gains its notes.
- **Other details** (replaces "Personal"). Each entry is shown as `label: value • date • place` (plus `Cause: …` when present) with its notes. Legacy `religion`/`education` strings, if present, are shown here as Religion and Education.
- **Notes.** Each note is shown in full in `.note-text`. A note over 6 lines or 500 characters is clamped to about 6 lines with a "Show more"/"Show less" button. The button toggles a class and is wired up after `innerHTML` is set, like the photo thumbnails.
- **Empty sections are omitted**, as today.

`photoViewer.js` already uses `textContent` and needs no change. `familyTreeView.js` draws names in Cytoscape (canvas), not HTML.

## Rollout

1. **PR.** It contains the parser, `personFacts`, `backfillFacts`, `api/privacy.js`, the `verifyCompare` and `verify.js` changes, the front end, tests, `npm run build` output in `docs/`, and README notes on `backfill-facts`. The developer approves the merge.
2. **Deploy before the backfill.**
   - Run `neon deploy`, so the masking Function is live. Merging lets Pages serve the new front end.
   - Against the still-old data, the visible changes are:
     - double spaces in notes are kept (95 people)
     - text inside `<…>` is now shown
     - the email addresses in I508's, I711's and I1388's notes show as `[email hidden]`
     - "Personal" becomes "Other details"
   - A tab still running the old bundle during the backfill would show occupations as "[object Object]" until it is reloaded.
3. **Rehearsal.**
   - Create the Neon branch `facts-backfill-rehearsal` from `production` and run plan, `--apply`, then plan again, with `--database-url`.
   - Expect:
     - `columnDrift`, `edited`, `onlyInDb` and `onlyInGed` all empty
     - `changed` = 1,392 and `unchanged` = 1,602, the constants asserted by the offline plan in `tests/realGed.test.js`
     - a re-plan with zero rows
   - For a visual check, run a scratch `node:http` wrapper around `createHandler` with a `pg` Pool on the branch URL (not committed). Start the front end with `VITE_API_URL=http://localhost:<port> npm run dev`; process env takes priority over `.env.development`. Check I1, I23, I443, I711 and I777, including at mobile width.
   - Delete the branch.
4. **Production.**
   - Create the branch `pre-facts-backfill-2026-10-09` from `production` as the restore point.
   - Plan against production and check that the summary matches the rehearsal.
   - With the developer's OK, run `--apply … --confirm <host>`.
   - Spot-check the same people through the live API. Responses carry `max-age=300`, so browsers may show old data for up to 5 minutes.
5. **Rollback:** `--rollback <plan> --confirm <host>`, or restore from `pre-facts-backfill-2026-10-09`. Delete that branch once the developer is happy.

## Error handling

| Situation | Behaviour |
|---|---|
| No archive row, several rows without `--sha`, or a sha mismatch | The plan aborts with a message; nothing is written. |
| A row edited since the import | It is excluded from the plan and listed in `summary.edited`. |
| `--confirm` missing or different from the connection or plan host | Apply/rollback aborts before writing. |
| Facts changed between plan and apply | `StalePlanError`: the transaction rolls back, the stale ids are printed, and the script exits 1. |
| Post-commit re-read differs | The mismatching ids are printed and the script exits 1. The plan file still allows `--rollback`. |
| A malformed GEDCOM line | It is skipped, as today. |
| A data value containing HTML | It is shown as text. |

## Testing

- **`tests/fixtures/legacyGedParser.js`** (new): a verbatim, frozen copy of today's `scripts/gedParser.js`, used only by the parity test.
- **`tests/gedParser.test.js`** keeps its existing cases and adds:
  - CONC joining with no separator, and CONT joining with `\n`, including blank CONT lines
  - leading spaces in note text preserved, and CRLF input
  - SOUR and REPO records after the last FAM leaving that family's `data` untouched
  - OCCU.DATE and OCCU.NOTE, and _MILT.NOTE, staying on their own fact rather than the person
  - the photo rule: the first OBJE under `EVEN` > `SOUR` is a photo, but a second OBJE under the same `EVEN` is not, and neither is an OBJE under `CENS` > `SOUR` or `BIRT` > `SOUR`
  - census entries with only a note being kept
  - birth and death notes, and cause of death
  - `otherFacts` order, EVEN TYPE, RELI/EDUC, a tag-only entry, and a repeated DEAT going to `otherFacts`
  - SOUR-citation notes being excluded
- **`tests/realGed.test.js`** reads the GEDCOM from `GED_PATH` (default `acourt.ged` at the repo root) and now skips when that file is absent, where today it throws. In a worktree, where `acourt.ged` is absent, run it with `GED_PATH=/Users/rob/src/ged_eye/acourt.ged`. When the file is present:
  - **Parity with the frozen legacy parser:** for every person, every `extractPersonData` field except the facts keys is identical (including `photos`, in order); `gedToRows` `families`, `familyChildren` and `warnings` are identical; and every person row's columns other than `facts` are identical.
  - **Offline plan:** `planFacts` with legacy-parser rows (with `edited: false`) as `dbRows`, since production equals them, and new-parser rows as `derived`. The test asserts `changed` = 1,392, `unchanged` = 1,602, and empty `columnDrift`, `edited`, `onlyInDb` and `onlyInGed`.
  - **Spot checks:**
    - I1's note is the full multi-line thread
    - I23's notes do not contain "Parish of Marnhull", and its `_MILT` fact does
    - F1029's `data` keys are exactly HUSB, WIFE, CHIL and MARR
    - no stage-1 node has a CONT or CONC child
- **`tests/gedToRows.test.js`**: the existing facts expectation moves to the new occupations shape; `personFacts` omits empty keys.
- **`tests/backfillFacts.test.js`** (new, pure): `planFacts` covering unchanged, changed and edited people, `onlyInDb`/`onlyInGed`, per-key added/removed/changed counts, `columnDrift`, and key-order-insensitive comparison.
- **`tests/db/backfillFacts.test.js`** (new, test branch). It reuses the production-host guard from `tests/db/personView.test.js`.
  - `applyPlan` writes `after` and leaves `updated_at` unchanged
  - the plan SQL's `edited` flag is true only for a row whose `updated_at` was changed
  - with `batchSize: 1`, a stale row in a later batch rolls back the earlier batches too and throws `StalePlanError` with that id
  - rollback restores `before`
  - no other column changes
  - `verifyPlan` reports mismatches
- **`tests/apiHandler.test.js`** adds: emails are masked in `person.notes`, in `censusRecords[].notes` and in `deathNotes`; the `email` field and non-note strings are untouched.
- **`tests/verifyCompare.test.js`** covers `apiMatchesView`: a masked API body matches an unmasked database view, and a real difference still fails.
- **`tests/personDetails.test.js`** (new, jsdom). Fixtures avoid `thumbKey` photos, or the test stubs `VITE_MEDIA_BASE_URL`.
  - `<img src=x onerror=…>` in the name, a spouse name, a note, a place, an occupation, a cause, a census note, an unknown-tag label and the email renders as text, with no `img` element
  - note newlines are preserved in `textContent`
  - census notes sit inside `<details>` with the right summary text
  - Show more appears only on long notes and toggles
  - a death row with only notes appears
  - both occupation shapes render
  - legacy `religion`/`education` strings render
  - `otherFacts` labels render, including the EVEN type and the unknown-tag fallback
- **`tests/verifyCompare.test.js`** is updated for the reduced `SCALAR_KEYS`.

## Follow-ups (not in this change)

- Sources: a `source` table from the SOUR and REPO records, with citations (and their notes and media) attached to facts.
- `family.facts`: marriage notes, FAM NCHI/RESI/_SEPR.
- Photo titles and notes on `person_media`.
- Name variants (_AKAN, NICK).
- The editing phase must bump `updated_at` on every write, keep the facts shapes above, and add an audit trail before any further re-derivation from the archive.
