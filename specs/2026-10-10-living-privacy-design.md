# Privacy for living people: design

**Date:** 2026-10-10
**Status:** Revision 2, after a spec review. Approved by the developer in conversation. Names stay visible; details are hidden. The 100-year rule is applied cautiously, and editors can override it.
**Follows:** the editing design (`api/privacy.js` masking, `masked` views, `VIEW_VERSION`) and the photos design.

## Goal

The public, meaning anyone who is not an editor (anonymous visitors and signed-in non-editors alike), must not see personal details of living people. Editors see everything, as now.

## Who is living (database function `person_is_living(p_id) returns boolean`)

1. **Override:** `person.living_override` (new column, `'living' | 'deceased' | null`) wins when set.
2. **Death record:** any of `death_date`, `death_place`, `burial_date` or `burial_place`, or a non-empty `facts.causeOfDeath`, `facts.deathNotes` or `facts.burialNotes`, means deceased. A GEDCOM `DEAT Y` with no date or place was imported as notes or nothing, so the facts keys catch what they can.
3. **Year:**
   - **Known:** `coalesce(gedcom_year(birth_date), gedcom_year(baptism_date))`, as `dated_family` does.
   - **Otherwise, estimated** from the nearest relatives with a known year, up to 3 steps away. The walk goes over `family` and `family_child` directly, not through `parent_ids()` and the other helpers, which sort through `dated_family`.
     - Steps: parents, children, spouses (partners in the same family), and siblings (children of any family the person is a child of, so half-siblings count).
     - **Formula:** estimate = relative's year + 25 × (the generations the relative is above the person). A parent counts +1, a child −1, and spouses and siblings 0, summed along the path.
     - The walk is breadth-first, as plpgsql or a recursive CTE over (id, depth, generations), bounded at depth 3, so cycles terminate.
     - It stops at the first level that has a year. Among the candidates at that level, it uses the **latest** estimate, the cautious choice.
   - **Short-circuit:** the walk runs only when there is no override, no death record and no known year.
4. **Decision:** deceased if the year, known or estimated, is strictly less than `extract(year from now()) - 100`. Otherwise living, **including when no year can be found**.
5. **Fail closed:** in the API, anything without `living === false` is treated as living.

A second function, `person_living_estimate(p_id)`, applies rules 2 to 4 and ignores the override. It is used only for the editor's label.

Migration 010 redefines two functions, each a verbatim copy of its latest version apart from these additions:
- **`person_record`** (from 008) gains:
  - `living`, a boolean;
  - `livingEstimate`, the boolean without the override;
  - `livingOverride`, which is `'living'`, `'deceased'` or null, and is omitted when null;
  - `living` on each `photos[].people` entry.
- **`relative_record`** (from 002, never redefined since) gains `living`. Relatives in `view.family[]` come from this function, not from `person_record`. They carry `birthDate` and `avatarKey`.

So every record in a view carries `living`: the focus, their relatives, and the people tagged in photos.

**Revision 3 (code review, 2026-10-11), migration 011:** for the 100-year line, a date's year is its **latest** year (`living_year()`: 'BET 1920 AND 1935' gives 1935), and a date that is only a lower bound ('AFT 1920', 'FROM 1920') gives no year, so relatives decide. Half-siblings from a parent's other family count at the **first** step, with the parents. `gedcom_year()` (earliest year) still orders families.

## What the public sees

The `api` Function applies a new `redactLiving(view)` in `api/privacy.js` to every non-editor response, after `maskNoteEmails`.

- **For a living person's record:**
  - **Kept:** `id`, `name`, `givenName`, `surname`, `sex`, `parentIds`, `spouseIds`, `childIds`, `parentFamilies`, and `living: true`.
  - **Changed:**
    - `marriages` keep only `spouseId`, `familyId` and `childIds`;
    - `photos` becomes `[]`;
    - `avatarKey` becomes `null`;
    - `private: true` is added.
  - **Dropped:** everything else, including dates, places, notes, all facts keys, `causeOfDeath`, email, phone, `updatedAt` and `livingOverride`.
- **A relative's record** in `view.family[]` with `living !== false` keeps `id`, `name`, `sex` and its relationship ids. Its `birthDate` is dropped, its `avatarKey` set to null, and `private: true` added. Every redaction builds the kept fields from a **whitelist**, so a field added later is hidden until someone allows it.
- **Shared photos:** any photo that tags a living person (`people[].living !== false`) is removed from every public record, including a deceased person's. Most photos of living people are group photos on a relative's page, so this matters.
- **A deceased person's marriages** to a living spouse lose their dates and places too.
  - The spouse's `living` flag is in the view, because spouses are relatives.
  - If a spouse's record isn't in the view, the marriage's details are dropped, the cautious choice.
- **Search:** results gain a `living` flag. The search route now looks up whether the caller is an editor, as `getPerson` does. For non-editors, living people keep `id` and `name`, with `birthYear` and `deathYear` set to null.
- **Unavoidable gaps:** a deceased person's notes, captions and census transcriptions may mention living relatives by name. They are not parsed or redacted.
- **Cache:** `VIEW_VERSION` is bumped to 4. The ETag already includes it, so cached public views refresh.

## Editors

- **View:** they get the unmasked view, with `living` and `livingOverride`.
- **Person editor:** it gains a **Living status** select, with three options:
  - "Work it out (currently: Living/Deceased)", which is null;
  - "Living";
  - "Deceased".
- **The label:** "Work it out (currently: Living)" or "(currently: Deceased)" comes from `livingEstimate`, never from `living`, which already includes the override.
- **Saving:** `update_person` accepts a new field, `living_override`. It gets its own enum branch in `validatePersonFields` (not `line()`), a `FIELD_LABELS` entry ("living status"), and a column CHECK constraint. It is recorded and undoable like any person field, because the capture trigger and `toggle_change` read columns from the catalogue. The front-end contract test covers it.

## Front end (public)

- **Details panel:** for a record with `private: true`, it shows "Details of living people are private." under the header. Sections with no data are already left out, and the photo row is empty.
- **Elsewhere:** tree labels already build birth years from `birthDate`, and avatars fall back to the placeholder, so no change is needed. Search-result years already show only when present.

## Verification and data

- **`scripts/neon/verify.js`:** its API sample compares the API's public view with the database's view.
  - It applies the shared `redactLiving` to the expected view in `apiMatchesView`. Comparing only deceased people won't work, because their views contain living relatives.
  - It adds an **independent check**: for sampled people whose `living` is true in the database, the public API response has no dates, notes, facts, photos or `avatarKey`. A bug in the shared function would otherwise pass on both sides.
  - Verification stays at 0 unexplained.
- **Report** from the real data: how many people end up living, how many through each rule, and how many had a year estimated. The developer gets these numbers at release.

## Testing

- **DB tests:**
  - `person_is_living` for each rule: override both ways, a death record, a birth year either side of the 100-year line, estimates through parents, children, spouses and siblings at distances 1 to 3, latest-at-nearest-distance, and no data counting as living;
  - `person_record`'s new fields;
  - `update_person` with `living_override`, and its undo.
- **Unit tests:**
  - `redactLiving`: every kept and dropped field, marriages, and spouse handling;
  - the handler: non-editors get redacted views and search, editors don't, and `VIEW_VERSION` is 4;
  - the person editor's select;
  - the details panel's private note;
  - the contract test.
- **Live, on the `photos` branch:**
  - an anonymous view of a known living person has no dates, notes or photos, and has `private: true`;
  - an editor's view of the same person is complete;
  - search hides the years;
  - `verify-neon` shows 0 unexplained.

## Out of scope (the developer decided on 2026-10-11 to leave it for now)

- **Git history:** the public GitHub repository's history holds the pre-Neon site's data, `docs/Data/people/*.json` and photos, including living people. Commit `ceefc57^` is the last one with it. Options for later: make the repository private, or purge the history with `git filter-repo` and force-push.
- **Bucket objects:** objects stay public-read at unguessable, content-addressed keys. Redaction stops new links, not files already linked.

## Rollout

1. Apply migration 010 to production. It is additive (a new column and functions). The old Function ignores the new fields.
2. Deploy `api`.
3. Run `verify-neon`.
4. Build `docs/` and merge.
