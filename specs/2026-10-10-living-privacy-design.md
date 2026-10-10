# Privacy for living people: design

**Date:** 2026-10-10
**Status:** Approved by the developer in conversation. Names stay visible; details are hidden. The 100-year rule is applied cautiously, and editors can override it.
**Follows:** the editing design (`api/privacy.js` masking, `masked` views, `VIEW_VERSION`) and the photos design.

## Goal

The public, meaning anyone who is not an editor (anonymous visitors and signed-in non-editors alike), must not see personal details of living people. Editors see everything, as now.

## Who is living (database function `person_is_living(p_id) returns boolean`)

1. **Override:** `person.living_override` (new column, `'living' | 'deceased' | null`) wins when set.
2. **Death record:** any of `death_date`, `death_place`, `burial_date` or `burial_place` means deceased.
3. **Birth year:**
   - **Known:** `gedcom_year(birth_date)`.
   - **Otherwise, estimated** from the nearest relatives with a known birth year, up to 3 steps away (a recursive walk over parents, children, spouses and siblings).
     - Going to a parent adds 25 years; going to a child subtracts 25; spouses and siblings add nothing.
     - Among the candidates at the smallest distance, the **latest** estimate is used, which is the cautious choice.
4. **Decision:** deceased if the year, known or estimated, is more than 100 years before the current year (`extract(year from now()) - 100`). Otherwise living, **including when no year can be found**.

`person_record` (redefined in migration 010, a verbatim copy of 008's apart from these additions) gains:
- `living`, a boolean;
- `livingOverride`, which is `'living'`, `'deceased'` or null, and is omitted when null.

Every person record in a view, the focus and their relatives, carries `living`.

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
- **A deceased person's marriages** to a living spouse lose their dates and places too.
  - The spouse's `living` flag is in the view, because spouses are relatives.
  - If a spouse's record isn't in the view, the marriage's details are dropped, the cautious choice.
- **Search:** results gain a `living` flag. For non-editors, living people keep `id` and `name`, with `birthYear` and `deathYear` set to null.
- **Cache:** `VIEW_VERSION` is bumped to 4. The ETag already includes it, so cached public views refresh.

## Editors

- **View:** they get the unmasked view, with `living` and `livingOverride`.
- **Person editor:** it gains a **Living status** select, with three options:
  - "Work it out (currently: Living/Deceased)", which is null;
  - "Living";
  - "Deceased".
- **Saving:** `update_person` accepts a new field, `living_override` (validated as one of the two values or null). It is recorded and undoable like any person field. The front-end contract test covers it.

## Front end (public)

- **Details panel:** for a record with `private: true`, it shows "Details of living people are private." under the header. Sections with no data are already left out, and the photo row is empty.
- **Elsewhere:** tree labels already build birth years from `birthDate`, and avatars fall back to the placeholder, so no change is needed. Search-result years already show only when present.

## Verification and data

- **`scripts/neon/verify.js`:** its API sample compares the API's public view with the database's view. It must apply `redactLiving` to the expected view first (sharing the function), or else compare only deceased people. Either way, verification stays at 0 unexplained.
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

## Rollout

1. Apply migration 010 to production. It is additive (a new column and functions). The old Function ignores the new fields.
2. Deploy `api`.
3. Run `verify-neon`.
4. Build `docs/` and merge.
