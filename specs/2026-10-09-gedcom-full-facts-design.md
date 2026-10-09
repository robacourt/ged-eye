# Parse the GEDCOM fully and show notes and events: design

**Date:** 2026-10-09
**Status:** Approved in brainstorming (scope, data model, backfill and UI sections each approved by the developer).
**Follows:** [2026-10-08-neon-migration-design.md](2026-10-08-neon-migration-design.md), whose non-goals deferred "parsing fields the current parser drops".

## Background

`scripts/gedParser.js` keeps only the tags the site displays, and it has four bugs. Measured on the archived `acourt.ged` (sha256 `2e68efeb…`, 3,063,220 bytes, 2,994 people, 1,029 families):

1. **CONT/CONC lines are ignored.** 160 people's notes are cut to their first line (for example I1). Brother's Keeper splits long lines mid-word at about 250 characters, and all 352 CONC splits fall inside a word, so CONC joins with no separator.
2. **Non-INDI/FAM level-0 records bleed into the last family.** The parser never clears `currentRecord`, so the lines of all 211 SOUR and 77 REPO records land on F1029. This has no visible effect today, because nothing reads `FAM.NOTE` or `FAM.PHON`.
3. **Children of untracked level-1 tags bleed onto the person.** When a level-1 tag has no frame pushed for it (OCCU, EVEN, _MILT, PROB, EMIG, EDUC, CREM…), its level-2 lines are applied to the person itself. As a result, 92 people show event notes as their own notes (I23's militia-list note "Parish of Marnhull", for example), and the 873 occupation dates are lost.
4. **`line.trim()` strips leading spaces** from values. Some notes are pasted web pages whose indentation carries meaning.

What is dropped today:

| Data | Count | Characters |
|---|---|---|
| Person-level NOTE (full text) | 420 notes, one each on 420 people (today 483 people show notes, 63 of them only bled ones) | 160K |
| Census transcriptions (CENS.NOTE) | 1,706 | 1.2M |
| Notes on other facts (BIRT, DEAT, OCCU, _MILT…) | ~400 | 154K |
| Untracked facts (EVEN 79, _MILT 40, PROB 22, NCHI 19, EMIG 16, CREM 12, CHR 11, …) | ~240 | — |
| Occupation dates | 873 | — |
| Source citations (all pointers to 211 SOUR records) | 4,754 | — |

Per person, all notes together come to: median 0, p90 1.6 KB, p99 5 KB, maximum 30 KB (I777).

Production state, checked read-only on 2026-10-09: for all 2,994 people, `person.facts` equals what today's parser derives from `gedcom_archive`, and no row has `updated_at <> created_at`. Nothing has been edited since the import. `facts` totals 259 kB and the database 11 MB.

## Goals

- Fix the four parser bugs.
- Store and show, for every person:
  - full person notes
  - census transcriptions
  - the notes on every fact
  - occupation dates and places
  - every other level-1 fact the parser drops today
- Backfill production's `person.facts` from `gedcom_archive`, touching only `facts` and `updated_at`, with a reviewed plan, compare-and-swap writes, and a rollback.
- Escape every data value the details panel interpolates into HTML.

## Non-goals

- **Sources:** SOUR records, citations (PAGE, QUAY, DATA.TEXT) and citation notes. They need their own model, so they get a later phase.
- **Family-level data:** marriage notes (63), FAM NCHI/RESI/_SEPR, and media on families. These need a `family.facts` migration.
- **Photo titles and notes** (1,081 OBJE.TITL). They belong to `media`/`person_media`.
- **Name variants** (NAME._AKAN, NICK, _OTHN…), ASSO, REFN and CHAN.
- **Any change to the `person` columns, families, children or media rows.** The new parser must derive them identically, and the backfill checks this.
- **Re-running `import-ged --replace`**, which is still never to be used against production.

## Decisions

| Topic | Decision |
|---|---|
| Scope | Notes plus facts (the "all notes + events" tier). No sources and no family facts. |
| Parser | Two stages: a generic node tree, then today's `data` shape derived from it (approach A). |
| Storage | `person.facts` jsonb, which `person_record` already merges into the person. No migration. |
| `religion`, `education` | Folded into `otherFacts` (RELI and EDUC carry dates and notes; only 3 and 4 people have them). |
| Long text | Collapsed by default: census and fact notes go behind `<details>`; long person notes get "Show more". |
| Backfill | A reviewed plan file, then a compare-and-swap apply in one transaction, with rollback from the same plan (approach A). Production is branched first as a safety net. |
| Rollout | The front end (which accepts both old and new shapes) ships before the backfill. |

## Parser (`scripts/gedParser.js`)

### Stage 1: `parseGedcomTree(text)` (new export)

- Split on `\n` and strip a trailing `\r` from each line. Skip lines that are empty or only whitespace.
- Match each line with `^\s*(\d+) (?:(@[^@]+@) )?(\S+)(?: (.*))?$`. Lines that don't match are skipped, as today.
- **Node shape:** `{ level, xref, tag, value, children }`.
  - `xref` has its `@` signs removed, or is `null`.
  - `value` is everything after the single delimiter space, verbatim, or `''`.
- **Placement:** a node becomes a child of the nearest open node one level up. A level-0 node starts a new root. A node whose level jumps by more than one is attached to the deepest open node; GEDCOM forbids such jumps and the file has none.
- **CONT and CONC** are folded into their parent's `value` and do not become children. CONT appends `'\n' + value`; CONC appends `value`.
- **Returns** the array of level-0 roots, in file order.

### Stage 2: `parseGedcom(text)` (same signature and return shape as today)

- **Records.** Only INDI and FAM roots become records. Every other root (HEAD, SOUR, REPO, NOTE, OBJE, SUBM, TRLR…) is ignored, which fixes bug 2.
- **`data` objects.** Each record's `data` is built from its node tree with today's keys and today's rules, so existing callers (`gedToRows`, `uploadMedia`, the tests) don't change:
  - `NAME`, `SEX`, `EMAIL`, `PHON`
  - `BIRT`, `DEAT`, `BAPM`, `BURI`, `MARR`, `DIV`: last occurrence wins, with `DATE` and `PLAC` read from that node's children
  - `CENS[]`, `RESI[]`, `OBJE[].FILES[]`, `FAMS[]`, `FAMC[]`, `HUSB`, `WIFE`, `CHIL[]`, `NOTE[]`, `OCCU[]`
- **Trimming.** Scalar values used for columns (names, dates, places, file paths, xref pointers) are trimmed exactly as today. Note text is not (see Facts).
- Because `data` is read from each node's own children, a line can never land on the wrong parent, which fixes bug 3.
- **`node` property.** Each record also gets `node`, its stage-1 tree, which `extractPersonData` reads for the new fields.

### `extractPersonData(parsedGed, id)`

- **Unchanged:** `id`, `name`, `givenName`, `surname`, `sex`, the birth, death, baptism and burial date and place, `photos`, `spouseIds`, `childIds`, `parentIds`, `marriages`, `email`, `phone`.
- **Changed or new:** the facts fields below. `religion` and `education` are no longer returned.

## Facts model (`person.facts`)

**`Fact`** = `{ value?, date?, place?, notes? }`. Each key is present only when non-empty:

- `value` is the fact node's own value, trimmed.
- `date` and `place` come from the node's first `DATE` and `PLAC` children, trimmed.
- `notes` is a `string[]` built from the node's direct `NOTE` children. NOTEs under SOUR citations are not included, because sources are out of scope.

**Note text** is the folded NOTE value, kept verbatim (leading spaces, internal spacing and blank lines), with only `trimEnd()` applied to the whole note. A note that is empty after that is dropped.

| Key | Shape | Source |
|---|---|---|
| `notes` | `string[]` | Level-1 `NOTE` nodes of the INDI only. |
| `occupations` | `Fact[]` (was `string[]`) | Each level-1 `OCCU`. Entries where every field is empty are dropped. |
| `censusRecords` | `Fact[]` | Each level-1 `CENS`, kept if it has a date, place or notes. Old entries always had `date` and `place` (null when absent); now those keys are omitted when absent. |
| `residences` | `Fact[]` | Each level-1 `RESI`, with the same rule. |
| `birthNotes`, `baptismNotes`, `deathNotes`, `burialNotes` | `string[]` | Notes of the last `BIRT`, `BAPM`, `DEAT` and `BURI`, the same occurrence whose date and place fill the columns. |
| `causeOfDeath` | `string` | `CAUS` of the last `DEAT`, trimmed. |
| `otherFacts` | `(Fact & { tag, type? })[]` | See below. |
| `email`, `phone` | `string` | Unchanged. |

**`otherFacts`.** In document order, one entry for each level-1 INDI node that is neither handled above nor ignored.

- **Handled:** NAME, SEX, BIRT, BAPM, DEAT, BURI, CENS, RESI, OCCU, NOTE, OBJE, FAMS, FAMC, EMAIL, PHON.
- **Ignored:** CHAN, SOUR, REFN, ASSO.
- **Earlier occurrences of a repeated BIRT, BAPM, DEAT or BURI** (5 people have one) also go to `otherFacts` under their own tag, so their data is no longer lost.
- **Entry fields:**
  - `tag` is the GEDCOM tag, for example `_MILT`.
  - `type` is the trimmed `TYPE` child, if any.
  - `cause` (the trimmed `CAUS` child) is stored for a repeated DEAT.
  - The rest of the entry is the `Fact`.
- **Empty entries are kept.** An entry with only a tag (for example `_ADPF`, adopted by father) is still a fact.

`person_record` merges `facts` before the core fields, so none of these keys can override a core field. None of them collides with one.

**`scripts/neon/gedToRows.js`** exports `personFacts(p)`, which turns `extractPersonData` output into the `facts` object (keys present only when non-empty). `gedToRows` uses it, so `import-ged` and the backfill can never disagree.

**Size.** `facts` grows from 259 kB to about 1.6 MB in total. A typical `/person/:id` response grows by under 1 KB; the largest (I777) by about 30 KB.

## Backfill (`scripts/neon/backfillFacts.js`, `npm run backfill-facts`)

This is a pure module plus a thin CLI, like `gedToRows` and `importGed`.

### Pure part: `planFacts(dbRows, derived)`

**Inputs:**
- `dbRows`: `[{ id, facts, ...coreColumns }]` from the database.
- `derived`: the `gedToRows` people rows from the archive.

**Returns** `{ rows, summary }`:
- `rows` is `[{ id, before, after }]`, only for people whose facts differ (compared with `canonical()` from `verifyCompare.js`).
- `summary` contains:
  - `unchanged`, `changed`
  - `onlyInDb` and `onlyInGed`: id lists; those people are never written
  - `keys`: `{ [factKey]: { added, removed, changed } }`
  - `columnDrift`: people whose non-facts columns differ between the database and the new parser. These are reported only, never written.

### CLI

**Connection.** Uses `DATABASE_URL_UNPOOLED`, or `--database-url <url>` for the rehearsal branch and tests. `host` is that URL's hostname.

**Plan (the default; read-only).**
1. Load `gedcom_archive`. Exactly one row is required unless `--sha <sha256>` picks one. Recompute the sha256 of `content` and abort if it differs from the stored value.
2. Parse the archive with the new parser, call `gedToRows(parsed, { files: {}, avatars: {} }, new Map())`, and read `id, facts` plus the core columns for every person.
3. Call `planFacts` and write `.neon-import/facts-backfill-plan.json`, containing `{ createdAt, host, archiveSha, summary, rows }`.
4. Print the summary and three sample before/after diffs. I1, I23 and I443 are used when they are in the plan.

**Apply** (`--apply <planPath> --confirm <host>`).
- Abort unless `--confirm` equals both the connection host and the plan's `host`.
- In one transaction, in batches of 500, run:
  ```sql
  update person p set facts = r.after, updated_at = now()
  from jsonb_to_recordset($1::jsonb) as r (id text, before jsonb, after jsonb)
  where p.id = r.id and p.facts = r.before
  ```
- If a batch updates fewer rows than it contains, roll back and exit 1, listing the ids whose `facts` no longer match `before`.
- After commit, re-read every planned row and check `facts = after`. Print the count, or the mismatching ids and exit 1.

**Rollback** (`--rollback <planPath> --confirm <host>`). The same as apply, with `before` and `after` swapped.

**Guarantees:**
- It never inserts, deletes, or writes any column but `facts` and `updated_at`.
- An apply writes exactly the reviewed plan or nothing.
- Re-planning after an apply produces zero rows.

### `verify-neon`

`scripts/neon/verifyCompare.js` drops `notes`, `occupations`, `censusRecords`, `residences`, `religion` and `education` from `SCALAR_KEYS`, with a comment. Those keys are re-derived by `backfill-facts` and checked by its own verification, so the old-parser JSON baseline no longer applies to them. Relationships, photos, avatars and the core fields are still compared.

## Front end

| File | Change |
|---|---|
| `src/html.js` (new) | `escapeHtml(text)`, moved from `src/main.js`, which now imports it. |
| `src/factLabels.js` (new) | `factLabel(fact)`: EVEN with a `type` → the type. Known tags map to labels: `_MILT` Military service, `PROB` Probate, `EMIG` Emigration, `IMMI` Immigration, `CHR` Christening, `CREM` Cremation, `WILL` Will, `DSCR` Description, `NCHI` Number of children, `EDUC` Education, `RELI` Religion, `_HEIG` Height, `_WEIG` Weight, `_EYEC` Eye colour, `_HAIR` Hair colour, `_MEDC` Medical condition, `_INTE` Interment, `_ADPF` Adopted by father, `_ADPM` Adopted by mother, `_BRTM` Brit milah, `_MEMR` Memorial, `_NMAR` Never married, `EVEN` Event, `BIRT` Birth, `BAPM` Baptism, `DEAT` Death, `BURI` Burial. Any other tag drops a leading `_` and is shown capitalised (`_FOO` → "Foo"). |
| `src/personDetails.js` | Every interpolated data value goes through `escapeHtml`. The `mailto:`/`tel:` schemes stay literal. See the sections list below. |
| `src/style.css` | `.note-text { white-space: pre-wrap; overflow-wrap: anywhere; }`, the clamp style, and `details`/`summary` styles that match `.detail-item`, including at the existing mobile breakpoint. |

**Sections in `personDetails.js`:**

- **Life Events.** Each row gains its notes (`birthNotes` and so on) in a `<details>`. Death also shows `Cause: …`.
- **Occupations.** Each entry is shown as `value • date • place`, plus its notes. A string entry (the old shape) renders as its value.
- **Census Records and Residences.** Each entry gains its notes in a `<details>` whose summary is "Transcription" for census entries and "Note" or "Notes (n)" for residences.
- **Other details** (replaces "Personal"). Each entry is shown as `label: value • date • place` (plus `Cause: …` when present) with its notes. Legacy `religion`/`education` strings, if present, are shown here as Religion and Education.
- **Notes.** Each note is shown in full in `.note-text`. A note over 6 lines or 500 characters is clamped to about 6 lines with a "Show more"/"Show less" button. The button toggles a class and is wired up after `innerHTML` is set, like the photo thumbnails.
- **Empty sections are omitted**, as today.

`photoViewer.js` already uses `textContent` and needs no change. `familyTreeView.js` draws names in Cytoscape (canvas), not HTML.

## Rollout

1. **PR.** It contains the parser, `personFacts`, `backfillFacts`, the `verifyCompare` change, the front end, tests, `npm run build` output in `docs/`, and README notes on `backfill-facts`. The developer approves the merge. Once merged, Pages serves the new front end against the still-old data. That renders as today, except that note line breaks are now kept.
2. **Rehearsal.**
   - Create the Neon branch `facts-backfill-rehearsal` from `production`.
   - Run plan, then `--apply`, then plan again (expect zero rows) with `--database-url`.
   - Expect `columnDrift` = 0, `onlyInDb` = `onlyInGed` = 0, and changed counts consistent with the Background table.
   - Run `api/handler.js` locally against the branch, point `npm run dev` at it, and check I1, I23, I443 and I777, including mobile width.
   - Delete the branch.
3. **Production.**
   - Create the branch `pre-facts-backfill-2026-10-09` from `production` as the restore point.
   - Plan against production and check that the summary matches the rehearsal.
   - With the developer's OK, run `--apply … --confirm <host>`.
   - Spot-check the same people through the live API. Responses carry `max-age=300`, so browsers may show old data for up to 5 minutes.
4. **Rollback:** `--rollback <plan> --confirm <host>`, or restore from `pre-facts-backfill-2026-10-09`. Delete that branch once the developer is happy.

## Error handling

| Situation | Behaviour |
|---|---|
| No archive row, several rows without `--sha`, or a sha mismatch | The plan aborts with a message; nothing is written. |
| `--confirm` missing or different from the connection or plan host | Apply/rollback aborts before connecting for writes. |
| Facts changed between plan and apply | That batch updates fewer rows than planned, the transaction rolls back, the stale ids are printed, and the script exits 1. |
| Post-commit re-read differs | The mismatching ids are printed and the script exits 1. The plan file still allows `--rollback`. |
| A malformed GEDCOM line | It is skipped, as today. |
| A data value containing HTML | It is shown as text. |

## Testing

- **`tests/gedParser.test.js`** keeps its existing cases and adds:
  - CONC joining with no separator, and CONT joining with `\n`, including blank CONT lines
  - leading spaces in note text preserved, and CRLF input
  - SOUR and REPO records after the last FAM leaving that family's `data` untouched
  - OCCU.DATE and OCCU.NOTE, and _MILT.NOTE, staying on their own fact rather than the person
  - census entries with only a note being kept
  - birth and death notes, and cause of death
  - `otherFacts` order, EVEN TYPE, RELI/EDUC, a tag-only entry, and a repeated DEAT going to `otherFacts`
  - SOUR-citation notes being excluded
- **`tests/gedToRows.test.js`**: the existing facts expectation moves to the new occupations shape; `personFacts` omits empty keys.
- **`tests/backfillFacts.test.js`** (new, pure): `planFacts` covering unchanged and changed people, `onlyInDb`/`onlyInGed`, per-key added/removed/changed counts, `columnDrift`, and key-order-insensitive comparison.
- **`tests/db/backfillFacts.test.js`** (new, test branch):
  - apply writes `after` and bumps `updated_at`
  - a single stale row rolls back the whole apply
  - rollback restores `before`
  - no other column changes
- **`tests/personDetails.test.js`** (new, jsdom):
  - `<img src=x onerror=…>` in the name, a note, a place, an occupation and the email renders as text, with no `img` element
  - note newlines are preserved in `textContent`
  - census notes sit inside `<details>`
  - Show more appears only on long notes and toggles
  - both occupation shapes render
  - legacy `religion`/`education` strings render
  - `otherFacts` labels render, including the EVEN type and the unknown-tag fallback
- **`tests/realGed.test.js`** skips when `acourt.ged` is absent, as it is in a worktree. When the file is present it checks:
  - 2,994 people and 1,029 families
  - I1's note is the full multi-line thread
  - I23's notes do not contain "Parish of Marnhull", and its `_MILT` fact does
  - F1029's `data` has no `NOTE`
  - no folded value contains a CONT/CONC line
- **`tests/verifyCompare.test.js`** is updated for the reduced `SCALAR_KEYS`.

## Follow-ups (not in this change)

- Sources: a `source` table from the SOUR and REPO records, with citations attached to facts.
- `family.facts`: marriage notes, FAM NCHI/RESI/_SEPR.
- Photo titles and notes on `person_media`.
- Name variants (_AKAN, NICK).
- The editing phase must bump `updated_at` on every write and keep the facts shapes above.
