# Editing Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Invited family members can sign in (email code or Google) and edit people and relationships on the website, with every change recorded and revertible forever (History panel + per-user Undo/Redo).

**Architecture:**
- **Data:** Postgres records every write to the tree tables in `change`/`change_row`, via triggers inside `begin_change()`, which holds a global advisory write lock. Undo and redo are `toggle_change()`, which re-applies a base change's net row diff in either direction, per column, with conflict, FK, cascade, structure and cycle checks.
- **API:** the Neon Function `api` verifies Neon Auth JWTs (`jose`), checks the `editor` table, and runs commands.
- **Front end:** the static site gains sign-in, edit forms, a relative dialog and a History panel.

**Tech Stack:** Postgres 18 (plpgsql), Node 24 Neon Function, `pg`, `jose`, `@neondatabase/auth` (0.5.0-beta), Vite + vanilla JS, Vitest (jsdom and node).

**Spec:** `specs/2026-10-09-editing-design.md` (revision 3 or later). Read it before every task: it is the source of truth for behaviour; this plan gives the order, the interfaces, and code for the subtle parts.

## Ground rules for every task

- **Work only in the worktree** `/Users/rob/src/ged_eye/.claude/worktrees/editing` (git branch `editing`, stacked on PR #3's branch).
  - Its `.neon` points at the Neon branch **`editing`**, and its `.env.local` holds `editing`'s credentials.
  - **Never run anything against production.** Never edit `/Users/rob/src/ged_eye/.neon` or other worktrees.
- **DB tests** run against the Neon branch **`test-editing`**, via `.env.test.local` (`DATABASE_URL_TEST`), with `npm run test:db`. The shared `test` branch belongs to other sessions.
- **Conventions:**
  - ESM, 2-space indent, semicolons, single quotes.
  - Node-side tests start with `// @vitest-environment node`.
  - Run tests with `npx vitest run <path>`.
  - Escape every interpolated string with `escapeHtml` from `src/html.js`, or set it with `textContent`.
- **Commits:** end every message with a blank line, then `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
  - Stage only the task's files.
  - Never stage `.env*` (except the committed `.env.development`/`.env.production`), `.neon`, `spike/`, `skills-lock.json`, or `docs/`. `docs/` is the build output, rebuilt only in the release task.
- **Migrations** are append-only and checksummed. Never edit 001–005. All new SQL goes in `006_editing.sql`, plus later numbers if needed.

---

## Chunk 1: Database

### Task 1: Test branch and fixtures

**Files:** `.env.test.local` (not committed), `tests/db/testDatabase.js`, `tests/db/personView.test.js`, `tests/db/backfillFacts.test.js`

- [ ] **Step 1: Create the DB-test branch and point the tests at it.**

  ```bash
  neon branches create --name test-editing --parent editing
  echo "DATABASE_URL_TEST=$(neon connection-string test-editing)" > .env.test.local
  ```

  `.env.test.local` is gitignored. Check that the host differs from `DATABASE_URL`'s in `.env.local`.

- [ ] **Step 2: Add `withChange` to `tests/db/testDatabase.js`.** Fixtures and tests use it to wrap writes once 006 exists. After seeding, fixtures also call `select sync_id_sequences()` (defined in 006), so new ids don't collide with fixture ids:

  ```js
  /** Runs `sql` (one or more statements) inside a recorded change, as tests and scripts must after 006. */
  export async function withChange(client, sql, params = []) {
    await client.query('begin');
    try {
      await client.query(`select begin_change('test@example.test', 'Test', 'fixture', 'script', 'Test fixture', '{}', '{}')`);
      const result = await client.query(sql, params);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  }
  ```

  Notes:
  - `pg` can't take params with multi-statement SQL, so call `withChange` once per statement when using params.
  - **Tests that rely on `begin … rollback`** must not use `withChange`, because it commits. Instead they add `select begin_change('test@example.test','Test','fixture','script','Test','{}','{}')` right after their own `begin`. This applies to `personView.test.js`'s facts-overwrite, half-siblings and remarriages tests.
  - **All of this code is READ COMMITTED.** It never uses REPEATABLE READ: the global lock relies on each statement taking a fresh snapshot after the lock.

- [ ] **Step 3: Leave the fixtures as they are for now.** They are updated in Task 2, Step 5, once 006 exists. Until then `withChange` is unused.

- [ ] **Step 4: Commit** `tests/db/testDatabase.js` with the message "DB tests: withChange helper".

### Task 2: Migration 006, part 1 (schema, capture, editors, sequences, search, person_record)

**Files:** Create `db/migrations/006_editing.sql`. Test `tests/db/editingSchema.test.js`.

- [ ] **Step 1: Write the failing test `tests/db/editingSchema.test.js`.** Use `resetTestDatabase()` from `testDatabase.js` and seed a small fixture with `withChange`, using **no** `display_name` column. Assert:
  - **The trigger refuses unrecorded writes:** a plain `insert into person (id, given_name, surname) values ('X1','A','B')` outside `begin_change` fails with SQLSTATE `GE005`.
  - **`begin_change`:** inside a transaction it returns an id, and `current_setting('ged.change_id')` equals that id. A `change` row exists with `via = 'script'`.
  - **Capture:**
    - An insert, update and delete of a person each write one `change_row` with the right `op`, `row_key` (`{"id":"X1"}`), and `before`/`after`.
    - `after` lacks `display_name` (generated) and `family` snapshots lack `sort_key`.
    - An update that only changes `updated_at` writes nothing.
    - `delete from person` of someone with a family and a child link records the cascaded `family` update (partner set null) and the `family_child` delete under the same `change_id`.
  - **Truncate guard:** `truncate person cascade` fails with `GE006`, even inside a change.
  - **`display_name`** is generated: inserting `given_name 'Ann', surname 'Lee'` gives `'Ann Lee'`; an empty surname gives `'Ann'`.
  - **Sequences:** after seeding and `select sync_id_sequences()`, `nextval('person_number_seq')` is greater than the largest numeric part of existing person ids; the same for families.
  - **Primary keys can't change:** `update person set id = 'X2' where id = 'X1'` inside a change fails with `GE007`.
  - **The display-name guard:** in a scratch transaction, before 006 (or by re-running the guard `do` block), a mismatching row makes the guard raise.
  - **`editor`** contains `saintderanged@gmail.com` as `admin`.
  - **`person_record`** has:
    - `updatedAt` matching `^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$`
    - `parentFamilies: [{familyId, partnerIds, childIds}]`, ordered by `start_year nulls last, sort_key, id`. Assert it with a two-family fixture.
  - **The search index** `person_name_trgm_idx` exists, and `select id from person where display_name % 'Ann Le'` finds Ann Lee.
  - **Ancestry helpers:** `ancestors_of`/`descendants_of` return the right sets on a 3-generation fixture, and terminate on a deliberately cyclic fixture (inserted under `begin_change`).

- [ ] **Step 2: Run it.** `npm run test:db -- tests/db/editingSchema.test.js` fails, because the functions don't exist yet.

- [ ] **Step 3: Write `db/migrations/006_editing.sql`** with this content (part 1; Task 3 appends part 2 to the same file):

```sql
-- Editing (spec: specs/2026-10-09-editing-design.md).
-- Every write to the five tree tables must happen inside begin_change(): a capture trigger
-- records before/after snapshots per row in change_row, and toggle_change() (part 2) uses
-- them to undo or redo any change.

-- display_name is derived from the name parts. Every existing row already equals this; check
-- before dropping, since Neon is the master copy.
do $$
begin
  if exists (select 1 from person where display_name is distinct from btrim(given_name || ' ' || surname)) then
    raise exception '006: display_name differs from btrim(given_name || '' '' || surname) for some people';
  end if;
end $$;
alter table person drop column display_name;
alter table person add column display_name text
  generated always as (btrim(given_name || ' ' || surname)) stored;

create table editor (
  email     text primary key check (email = lower(email)),
  name      text,
  role      text not null check (role in ('admin', 'editor')),
  added_by  text,
  added_at  timestamptz not null default now()
);
insert into editor (email, name, role, added_by)
values ('saintderanged@gmail.com', 'Rob A''Court', 'admin', 'migration 006');

create table change (
  id              bigint generated always as identity primary key,
  created_at      timestamptz not null default now(),
  author_email    text not null,
  author_name     text,
  kind            text not null,
  via             text not null check (via in ('edit', 'history', 'keyboard', 'script')),
  summary         text not null,
  params          jsonb not null default '{}',
  person_ids      text[] not null default '{}',
  base_change_id  bigint references change (id),
  undone          boolean not null default false
);
create index change_author_idx on change (author_email, id desc);
create index change_person_ids_idx on change using gin (person_ids);
create index change_base_idx on change (base_change_id, id desc);

create table change_row (
  id         bigint generated always as identity primary key,
  change_id  bigint not null references change (id),
  table_name text not null,
  row_key    jsonb not null,
  op         text not null check (op in ('insert', 'update', 'delete')),
  before     jsonb,
  after      jsonb
);
create index change_row_change_idx on change_row (change_id);
create index change_row_key_idx on change_row (table_name, row_key, change_id desc);

-- Catalog helpers. Table names only ever come from tree_tables(), via the capture trigger.
create function tree_assert_table(p_table text) returns void
language plpgsql stable as $$
begin
  if p_table is null or p_table <> all (array['person', 'family', 'family_child', 'media', 'person_media']) then
    raise exception 'not a tree table: %', p_table;
  end if;
end $$;

create function tree_columns(p_table text) returns text[]
language sql stable as $$
  select coalesce(array_agg(attname::text order by attnum), '{}')
  from pg_attribute
  where attrelid = p_table::regclass and attnum > 0 and not attisdropped and attgenerated = ''
$$;

create function tree_generated_columns(p_table text) returns text[]
language sql stable as $$
  select coalesce(array_agg(attname::text), '{}')
  from pg_attribute
  where attrelid = p_table::regclass and attnum > 0 and not attisdropped and attgenerated <> ''
$$;

create function tree_identity_columns(p_table text) returns text[]
language sql stable as $$
  select coalesce(array_agg(attname::text), '{}')
  from pg_attribute
  where attrelid = p_table::regclass and attnum > 0 and not attisdropped and attidentity <> ''
$$;

create function tree_key_columns(p_table text) returns text[]
language sql stable as $$
  select array_agg(a.attname::text order by array_position(i.indkey::int2[], a.attnum))
  from pg_index i
  join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any (i.indkey)
  where i.indrelid = p_table::regclass and i.indisprimary
$$;

create function tree_foreign_keys(p_table text) returns table (col text, ref_table text, ref_col text)
language sql stable as $$
  select a.attname::text, cl.relname::text, ra.attname::text
  from pg_constraint c
  join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
  join pg_class cl on cl.oid = c.confrelid
  join pg_attribute ra on ra.attrelid = c.confrelid and ra.attnum = c.confkey[1]
  where c.conrelid = p_table::regclass and c.contype = 'f' and cardinality(c.conkey) = 1
$$;

create function tree_table_rank(p_table text) returns int
language sql immutable as $$
  select case p_table when 'person' then 1 when 'media' then 1 when 'family' then 2 else 3 end
$$;

create function tree_snapshot(p_table text, p_row jsonb) returns jsonb
language sql stable as $$
  select p_row - tree_generated_columns(p_table)
$$;

create function tree_row_key(p_table text, p_row jsonb) returns jsonb
language sql stable as $$
  select jsonb_object_agg(k, p_row -> k) from unnest(tree_key_columns(p_table)) as k
$$;

-- SQL predicate selecting the row with this key; p_alias qualifies the columns.
create function tree_key_predicate(p_table text, p_key jsonb, p_alias text default null) returns text
language sql stable as $$
  select string_agg(
           format('%s%I = %L::%s',
                  case when p_alias is null then '' else quote_ident(p_alias) || '.' end,
                  k, p_key ->> k, format_type(a.atttypid, a.atttypmod)),
           ' and ')
  from unnest(tree_key_columns(p_table)) as k
  join pg_attribute a on a.attrelid = p_table::regclass and a.attname = k
$$;

create function tree_current(p_table text, p_key jsonb) returns jsonb
language plpgsql stable set timezone = 'UTC' as $$
declare v jsonb;
begin
  perform tree_assert_table(p_table);
  execute format('select to_jsonb(t) from %I t where %s', p_table, tree_key_predicate(p_table, p_key, 't')) into v;
  return case when v is null then null else tree_snapshot(p_table, v) end;
end $$;

-- Open a recorded change: global write lock, change row, ged.change_id for the triggers.
create function begin_change(p_author_email text, p_author_name text, p_kind text, p_via text,
                             p_summary text, p_params jsonb, p_person_ids text[]) returns bigint
language plpgsql volatile as $$
declare v_id bigint;
begin
  perform pg_advisory_xact_lock(7262021);
  insert into change (author_email, author_name, kind, via, summary, params, person_ids)
  values (lower(p_author_email), p_author_name, p_kind, p_via, p_summary,
          coalesce(p_params, '{}'), coalesce(p_person_ids, '{}'))
  returning id into v_id;
  perform set_config('ged.change_id', v_id::text, true);
  return v_id;
end $$;

create function capture_change() returns trigger
language plpgsql set timezone = 'UTC' as $$
declare
  v_change text := current_setting('ged.change_id', true);
  v_old jsonb;
  v_new jsonb;
begin
  if v_change is null or v_change = '' then
    raise exception 'tree tables can only be changed inside a recorded change (call begin_change)'
      using errcode = 'GE005';
  end if;
  if tg_op in ('UPDATE', 'DELETE') then v_old := tree_snapshot(tg_table_name, to_jsonb(old)); end if;
  if tg_op in ('UPDATE', 'INSERT') then v_new := tree_snapshot(tg_table_name, to_jsonb(new)); end if;
  if tg_op = 'UPDATE' and (v_old - 'updated_at') = (v_new - 'updated_at') then
    return null;
  end if;
  if tg_op = 'UPDATE' and tree_row_key(tg_table_name, v_old) <> tree_row_key(tg_table_name, v_new) then
    raise exception 'primary keys of tree tables cannot change' using errcode = 'GE007';
  end if;
  insert into change_row (change_id, table_name, row_key, op, before, after)
  values (v_change::bigint, tg_table_name, tree_row_key(tg_table_name, coalesce(v_new, v_old)),
          lower(tg_op), v_old, v_new);
  return null;
end $$;

create function refuse_truncate() returns trigger
language plpgsql as $$
begin
  raise exception 'tree tables cannot be truncated: every change is recorded (Neon is the master copy)'
    using errcode = 'GE006';
end $$;

create trigger capture_change after insert or update or delete on person for each row execute function capture_change();
create trigger capture_change after insert or update or delete on family for each row execute function capture_change();
create trigger capture_change after insert or update or delete on family_child for each row execute function capture_change();
create trigger capture_change after insert or update or delete on media for each row execute function capture_change();
create trigger capture_change after insert or update or delete on person_media for each row execute function capture_change();
create trigger refuse_truncate before truncate on person for each statement execute function refuse_truncate();
create trigger refuse_truncate before truncate on family for each statement execute function refuse_truncate();
create trigger refuse_truncate before truncate on family_child for each statement execute function refuse_truncate();
create trigger refuse_truncate before truncate on media for each statement execute function refuse_truncate();
create trigger refuse_truncate before truncate on person_media for each statement execute function refuse_truncate();

create sequence person_number_seq;
create sequence family_number_seq;
-- Moves both sequences past the largest existing numeric id. Called here and by test fixtures after seeding.
create function sync_id_sequences() returns void
language plpgsql volatile as $$
begin
  perform setval('person_number_seq', coalesce((select max(substring(id from '[0-9]+')::bigint) from person), 0) + 1, false);
  perform setval('family_number_seq', coalesce((select max(substring(id from '[0-9]+')::bigint) from family), 0) + 1, false);
end $$;
select sync_id_sequences();

create extension if not exists pg_trgm;
create index person_name_trgm_idx on person using gin (display_name gin_trgm_ops);

-- Cycle-safe ancestry (UNION, not UNION ALL, so a corrupt cycle still terminates).
create function ancestors_of(p_id text) returns table (id text)
language sql stable as $$
  with recursive anc(id) as (
    select x.pid
    from family_child fc
    join family f on f.id = fc.family_id
    cross join lateral (values (f.partner1_id), (f.partner2_id)) as x (pid)
    where fc.child_id = p_id and x.pid is not null
    union
    select x.pid
    from anc
    join family_child fc on fc.child_id = anc.id
    join family f on f.id = fc.family_id
    cross join lateral (values (f.partner1_id), (f.partner2_id)) as x (pid)
    where x.pid is not null
  )
  select id from anc
$$;

create function descendants_of(p_id text) returns table (id text)
language sql stable as $$
  with recursive des(id) as (
    select fc.child_id
    from family f
    join family_child fc on fc.family_id = f.id
    where f.partner1_id = p_id or f.partner2_id = p_id
    union
    select fc.child_id
    from des
    join family f on f.partner1_id = des.id or f.partner2_id = des.id
    join family_child fc on fc.family_id = f.id
  )
  select id from des
$$;
```

Then append the replacement for `person_record`: copy the whole `create or replace function person_record` from `005_family_chronological_order.sql` verbatim, and add two keys to its `jsonb_build_object`. Add a **comma after `'avatarKey', p.avatar_key`**, then:

```sql
      'updatedAt', to_char(p.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'parentFamilies', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'familyId', f.id,
                 'partnerIds', to_jsonb(array_remove(array[f.partner1_id, f.partner2_id], null)),
                 'childIds', coalesce((select jsonb_agg(c.child_id order by c.position)
                                       from family_child c where c.family_id = f.id), '[]'::jsonb))
               order by f.start_year nulls last, f.sort_key, f.id)
        from family_child fc
        join dated_family f on f.id = fc.family_id
        where fc.child_id = p.id
      ), '[]'::jsonb)
```

- [ ] **Step 4: Run it.** `npm run test:db -- tests/db/editingSchema.test.js` passes.

- [ ] **Step 5: Update the existing DB fixtures for 006.**
  - **Names:** in `tests/db/personView.test.js` and `tests/db/backfillFacts.test.js`, replace `display_name` in every `insert into person` with `given_name, surname`, splitting the names (for example `'Mark', 'Hill'`). Removing only the column would break the value counts and the name assertions.
  - **Truncates:** `backfillFacts.test.js`'s `truncate person cascade` becomes `withChange(client, 'delete from person_media; delete from media; delete from family_child; delete from family; delete from person')`. Keep `truncate gedcom_archive`, which isn't a tree table.
  - **`scripts/neon/backfillFacts.js`:** in `applyPlan`, right after `set local lock_timeout`, add `select begin_change('backfill@ged-eye.local', 'Facts backfill', 'backfill_facts', 'script', 'Backfilled full GEDCOM facts', '{}', '{}') where to_regprocedure('begin_change(text,text,text,text,text,jsonb,text[])') is not null`. The backfill and its rollback are then recorded after 006, and still work before it. Add it to this task's commit.
  - Run every fixture or test write through `withChange(client, sql)`, or wrap a `begin; select begin_change(...); … commit;` around multi-statement fixtures. `pg` accepts multi-statement text when there are no params.
  - Tests that expect migration lists or checksums (the migrate tests in `personView.test.js`) must still pass with 006 present.
  - Run the whole DB suite: `npm run test:db` passes.

- [ ] **Step 6: Update `scripts/neon/importGed.js`.** Remove `display_name` from the `person` insert column list. The import is retired (its truncate is now refused), but the code should stay consistent. Run `npx vitest run` (unit tests) and check it passes.

- [ ] **Step 7: Commit** `db/migrations/006_editing.sql`, `tests/db/*`, `scripts/neon/importGed.js`, `scripts/neon/backfillFacts.js` with the message "006 part 1: change log capture, editors, generated display_name, sequences, search, person_record additions".

### Task 3: Migration 006, part 2 (`toggle_change`, `undo_last`, `redo_last`)

**Files:** Append to `db/migrations/006_editing.sql`. Test `tests/db/toggleChange.test.js`.

006 has not been applied anywhere persistent yet (the test branch is reset on every run), so appending to it is allowed until Task 4 applies it to the `editing` branch.

- [ ] **Step 1: Write the failing tests `tests/db/toggleChange.test.js`.** Write the scenarios as small helpers:
  - `edit(client, email, sql)` runs SQL inside `begin_change(email, 'Name', 'test_edit', 'edit', 'summary', '{}', '{person ids}')` and returns the change id.
  - `toggle(client, id, dir, email, via = 'history')` calls `select toggle_change($1, $2, $3, 'Name', $4)`.

  Required cases (all from the spec's Testing section). Assert row states and the `undone` flags after each step:
  1. **Undo, then redo, of a person update.** The values come back. `undone` flips. The toggle change's `kind` is `undo`/`redo`, its `base_change_id` is the base, its `summary` starts with `Undid: `/`Redid: `, and its `person_ids` are the base's.
  2. **Per-column conflict check.** Base B edits `birth_date`; later L edits `facts`. Undo B succeeds, and `facts` keeps L's value. If L instead edits `birth_date`, undoing B raises `GE003`. Its detail JSON has `reason: 'precondition'` and `blocking: [{id: L, action: 'revert'}]`.
  3. **A restore action in `blocking`.** Base 3 edits birth_date; base 5 edits it again. Undo 5, then undo 3, then try redo 5. It's blocked with `blocking: [{id: 3, action: 'restore'}]`.
  4. **Add relative.** Base creates `F(A,null)`, `family_child(F,B)` and person B.
     - Undo removes them all, children first: no cascade error.
     - After a later L links C into F, undoing the base raises `GE003`, with `reason` `precondition` or `cascade` and L among the blockers.
  5. **Delete a person** with two families, children and a `person_media` row.
     - Undo restores the person, the partner slots and every link, and the `media` row keeps its id.
     - Then redo deletes again.
  6. **Unlink, then delete.** Base T unlinks partner B from F; later L deletes B. Undoing T raises `GE003`, and `blocking` includes L (the missing referenced row).
  7. **Structure.** F has partner1 P1 and child K. Base B fills partner2 = P2. Later L sets partner1 = null. Undoing B raises `GE003` with `reason: 'structure'` and `blocking: [{id: L, action: 'revert'}]`.
  8. **Cycle.** F has partner1 A and child B. Base U deletes `family_child(F,B)` and F (cleanup). Later L creates F′ with partner1 B and child A. Undoing U raises `reason: 'cycle'`, with L among the blockers.
  9. **State checks.**
     - `wrong_state` (`GE002`): undo an undone change, or redo one that's in effect.
     - `not_found` (`GE001`): a missing id, or toggling an undo change.
     - **No net effect:** a base whose net effect is empty (simulate it with a change whose `change_row`s you insert by hand with `before = after`) toggles without error. It records an undo change with no rows and flips `undone`, so Ctrl+Z can't get stuck.
  10. **`undo_last` / `redo_last`** for one author, with base changes E1 and E2 (`via='edit'`):
      - `undo_last` undoes E2, and again undoes E1.
      - `redo_last` redoes E1, and again redoes E2. **Undo, undo, redo, redo.**
      - Undo, then a new edit E3: `redo_last` returns null. A new edit clears redo.
      - With nothing left to do, both return null.
      - Another author's changes are never chosen.
      - `via='script'` base changes are never chosen by `undo_last`.
  11. **History revert, then Ctrl+Z.** A History revert (`via='history'`) of my E2, then `undo_last`, undoes E1, because E2 is already undone.
  12. **Undo, redo, undo, undo.** Bookkeeping stays correct: after the final undo, the base is `undone = true` and a further undo raises `GE002`.
  13. **The global lock.** Two connections each run `select begin_change(...)` inside open transactions. The second blocks until the first commits. Assert this by timing, or with `pg_locks` from a third connection.
  13b. **History revert of a redone change.** Undo E, then redo E, then a History revert (`via='history'`): E is undone, and redo by History restores it.
  13c. **Every base edit in these tests really changes data.** A no-op edit is rolled back by commands, so it never exists.
  14. **Generated and identity columns.** Undoing an insert of `media` and redoing it keeps `media.id`. Snapshots and updates never touch `display_name` or `sort_key`.

- [ ] **Step 2: Run it.** It fails, because the functions don't exist yet.

- [ ] **Step 3: Append to `006_editing.sql`:**

```sql
create function raise_toggle_conflict(p_reason text, p_blocking jsonb) returns void
language plpgsql as $$
begin
  raise exception 'conflict' using errcode = 'GE003',
    detail = jsonb_build_object(
      'reason', case when p_reason = 'precondition' and jsonb_array_length(p_blocking) = 0 then 'untracked' else p_reason end,
      'blocking', p_blocking)::text;
end $$;

-- Up to 5 changes (other than the base and its own toggles) that last touched the given
-- keys/columns after the base, each with the action that would unblock it.
-- p_bad: [{table, key, columns: [..] | null}]
create function toggle_blockers(p_base bigint, p_self bigint, p_bad jsonb) returns jsonb
language plpgsql stable as $$
declare
  v_out jsonb := '[]';
  v_seen bigint[] := '{}';
  b jsonb;
  v_hit bigint;
  v_target change%rowtype;
begin
  for b in select value from jsonb_array_elements(p_bad) loop
    select cr.change_id into v_hit
    from change_row cr
    where cr.table_name = b ->> 'table' and cr.row_key = b -> 'key'
      and cr.change_id > p_base and cr.change_id <> p_self
      and cr.change_id not in (select id from change where base_change_id = p_base)
      and (jsonb_typeof(b -> 'columns') is distinct from 'array' or cr.op <> 'update'
           or exists (select 1 from jsonb_array_elements_text(b -> 'columns') c
                      where (cr.before -> c) is distinct from (cr.after -> c)))
    order by cr.change_id desc
    limit 1;
    continue when v_hit is null;
    select * into v_target from change where id = v_hit;
    if v_target.kind in ('undo', 'redo') then
      select * into v_target from change where id = v_target.base_change_id;
    end if;
    continue when v_target.id = p_base or v_target.id = any (v_seen);
    v_seen := v_seen || v_target.id;
    v_out := v_out || jsonb_build_object('id', v_target.id,
                                         'action', case when v_target.undone then 'restore' else 'revert' end);
    exit when jsonb_array_length(v_out) >= 5;
  end loop;
  return v_out;
end $$;

create function toggle_change(p_base bigint, p_direction text, p_email text, p_name text, p_via text)
returns bigint
language plpgsql volatile set timezone = 'UTC' as $$
declare
  v_id bigint;
  v_base change%rowtype;
  r record;
  v_from jsonb;
  v_to jsonb;
  v_cur jsonb;
  v_cols text[];
  v_changed text[];
  v_mismatch text[];
  v_bad jsonb := '[]';
  v_ops jsonb := '[]';
  v_creates jsonb := '{}';
  v_extra jsonb;
  op jsonb;
  fk record;
  v_ref_key jsonb;
  v_ins_cols text[];
  v_cyclic text[];
begin
  if p_direction not in ('undo', 'redo') then
    raise exception 'direction must be undo or redo';
  end if;
  v_id := begin_change(p_email, p_name, p_direction, p_via, 'pending', jsonb_build_object('base', p_base), '{}');

  select * into v_base from change where id = p_base for update;
  if not found or v_base.kind in ('undo', 'redo') then
    raise exception 'not_found' using errcode = 'GE001';
  end if;
  if (p_direction = 'undo') = v_base.undone then
    raise exception 'wrong_state' using errcode = 'GE002';
  end if;

  -- 1. Net effect per key (in change_row id order) and preconditions.
  for r in
    select table_name as tbl, row_key as key,
           (array_agg(before order by id))[1] as initial,
           (array_agg(after order by id desc))[1] as final
    from change_row
    where change_id = p_base
    group by table_name, row_key
  loop
    perform tree_assert_table(r.tbl);
    v_from := case when p_direction = 'undo' then r.final else r.initial end;
    v_to := case when p_direction = 'undo' then r.initial else r.final end;
    continue when v_from is null and v_to is null;
    v_cur := tree_current(r.tbl, r.key);
    v_cols := array(select c from unnest(tree_columns(r.tbl)) c where c <> 'updated_at');

    if v_to is null then
      -- remove: the row must still be exactly as the base left it
      if v_cur is null then
        v_bad := v_bad || jsonb_build_object('table', r.tbl, 'key', r.key, 'columns', null);
      else
        v_mismatch := array(select c from unnest(v_cols) c
                            where v_from ? c and (v_cur -> c) is distinct from (v_from -> c));
        if cardinality(v_mismatch) > 0 then
          v_bad := v_bad || jsonb_build_object('table', r.tbl, 'key', r.key, 'columns', to_jsonb(v_mismatch));
        end if;
      end if;
      v_ops := v_ops || jsonb_build_object('op', 'remove', 'table', r.tbl, 'key', r.key, 'rank', tree_table_rank(r.tbl));
    elsif v_from is null then
      -- create: nothing may occupy the key
      if v_cur is not null then
        v_bad := v_bad || jsonb_build_object('table', r.tbl, 'key', r.key, 'columns', null);
      end if;
      v_ops := v_ops || jsonb_build_object('op', 'create', 'table', r.tbl, 'key', r.key,
                                           'rank', tree_table_rank(r.tbl), 'row', v_to);
      v_creates := v_creates || jsonb_build_object(r.tbl || '|' || r.key::text, true);
    else
      -- modify: only the columns the base changed, checked against their from-values
      v_changed := array(select c from unnest(v_cols) c
                         where c <> all (tree_key_columns(r.tbl)) and c <> all (tree_identity_columns(r.tbl))
                           and v_from ? c and v_to ? c and (v_from -> c) is distinct from (v_to -> c));
      continue when cardinality(v_changed) = 0;
      if v_cur is null then
        v_bad := v_bad || jsonb_build_object('table', r.tbl, 'key', r.key, 'columns', null);
      else
        v_mismatch := array(select c from unnest(v_changed) c where (v_cur -> c) is distinct from (v_from -> c));
        if cardinality(v_mismatch) > 0 then
          v_bad := v_bad || jsonb_build_object('table', r.tbl, 'key', r.key, 'columns', to_jsonb(v_mismatch));
        end if;
      end if;
      v_ops := v_ops || jsonb_build_object('op', 'modify', 'table', r.tbl, 'key', r.key,
                                           'rank', tree_table_rank(r.tbl), 'row', v_to, 'columns', to_jsonb(v_changed));
    end if;
  end loop;

  -- An empty net effect (e.g. a later migration dropped the only changed column) still toggles,
  -- applying nothing, so Ctrl+Z can never get stuck on it.

  -- 2. Referenced rows of the to-state must exist, or be created by this toggle.
  for op in select value from jsonb_array_elements(v_ops) where value ->> 'op' in ('create', 'modify') loop
    for fk in select * from tree_foreign_keys(op ->> 'table') loop
      continue when op ->> 'op' = 'modify' and not (op -> 'columns' ? fk.col);
      continue when (op -> 'row' ->> fk.col) is null;
      v_ref_key := jsonb_build_object(fk.ref_col, op -> 'row' -> fk.col);
      if tree_current(fk.ref_table, v_ref_key) is null and not (v_creates ? (fk.ref_table || '|' || v_ref_key::text)) then
        v_bad := v_bad || jsonb_build_object('table', fk.ref_table, 'key', v_ref_key, 'columns', null);
      end if;
    end loop;
  end loop;

  if jsonb_array_length(v_bad) > 0 then
    perform raise_toggle_conflict('precondition', toggle_blockers(p_base, v_id, v_bad));
  end if;

  -- 3. Apply: creates (rank asc), modifies, removes (rank desc).
  begin
    for op in select value from jsonb_array_elements(v_ops) where value ->> 'op' = 'create'
              order by (value ->> 'rank')::int loop
      v_ins_cols := array(select c from unnest(tree_columns(op ->> 'table')) c where op -> 'row' ? c);
      execute format('insert into %I (%s) %s select %s from jsonb_populate_record(null::%I, $1)',
                     op ->> 'table',
                     (select string_agg(quote_ident(c), ', ') from unnest(v_ins_cols) c),
                     case when cardinality(tree_identity_columns(op ->> 'table')) > 0 then 'overriding system value' else '' end,
                     (select string_agg(quote_ident(c), ', ') from unnest(v_ins_cols) c),
                     op ->> 'table')
        using op -> 'row';
    end loop;
    for op in select value from jsonb_array_elements(v_ops) where value ->> 'op' = 'modify' loop
      execute format('update %I t set %s%s from jsonb_populate_record(null::%I, $1) r where %s',
                     op ->> 'table',
                     (select string_agg(format('%I = r.%I', c, c), ', ') from jsonb_array_elements_text(op -> 'columns') c),
                     case when 'updated_at' = any (tree_columns(op ->> 'table')) then ', updated_at = now()' else '' end,
                     op ->> 'table',
                     tree_key_predicate(op ->> 'table', op -> 'key', 't'))
        using op -> 'row';
    end loop;
    for op in select value from jsonb_array_elements(v_ops) where value ->> 'op' = 'remove'
              order by (value ->> 'rank')::int desc loop
      execute format('delete from %I t where %s', op ->> 'table', tree_key_predicate(op ->> 'table', op -> 'key', 't'));
    end loop;
  exception when integrity_constraint_violation then
    perform raise_toggle_conflict('constraint', '[]'::jsonb);
  end;

  -- 4. Post-apply checks.
  select coalesce(jsonb_agg(jsonb_build_object('table', cr.table_name, 'key', cr.row_key, 'columns', null)), '[]')
    into v_extra
  from change_row cr
  where cr.change_id = v_id
    and not exists (select 1 from change_row b
                    where b.change_id = p_base and b.table_name = cr.table_name and b.row_key = cr.row_key);
  if jsonb_array_length(v_extra) > 0 then
    perform raise_toggle_conflict('cascade', toggle_blockers(p_base, v_id, v_extra));
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('table', 'family', 'key', jsonb_build_object('id', f.id),
                                                'columns', jsonb_build_array('partner1_id', 'partner2_id'))), '[]')
    into v_extra
  from family f
  where f.partner1_id is null and f.partner2_id is null
    and f.id in (select cr.row_key ->> 'id' from change_row cr where cr.change_id = v_id and cr.table_name = 'family'
                 union
                 select coalesce(cr.after, cr.before) ->> 'family_id' from change_row cr
                 where cr.change_id = v_id and cr.table_name = 'family_child');
  if jsonb_array_length(v_extra) > 0 then
    perform raise_toggle_conflict('structure', toggle_blockers(p_base, v_id, v_extra));
  end if;

  select array_agg(distinct touched.id) into v_cyclic
  from (select coalesce(cr.after, cr.before) ->> 'child_id' as id
        from change_row cr where cr.change_id = v_id and cr.table_name = 'family_child'
        union
        select fc.child_id from change_row cr
        join family_child fc on fc.family_id = cr.row_key ->> 'id'
        where cr.change_id = v_id and cr.table_name = 'family') touched
  where touched.id is not null
    and exists (select 1 from ancestors_of(touched.id) a where a.id = touched.id);
  if v_cyclic is not null then
    -- Offending keys: the links among the cycle's members (P, plus ancestors of P that have P as an ancestor).
    with members as (
      select c.id as m from unnest(v_cyclic) as c (id)
      union
      select a.id from unnest(v_cyclic) as c (id) cross join lateral ancestors_of(c.id) a
      where exists (select 1 from ancestors_of(a.id) b where b.id = c.id)
    )
    select coalesce(jsonb_agg(x), '[]') into v_extra
    from (
      select jsonb_build_object('table', 'family_child',
                                'key', jsonb_build_object('family_id', fc.family_id, 'child_id', fc.child_id),
                                'columns', null) as x
      from family_child fc where fc.child_id in (select m from members)
      union all
      select jsonb_build_object('table', 'family', 'key', jsonb_build_object('id', f.id),
                                'columns', jsonb_build_array('partner1_id', 'partner2_id'))
      from family f where f.partner1_id in (select m from members) or f.partner2_id in (select m from members)
    ) s;
    perform raise_toggle_conflict('cycle', toggle_blockers(p_base, v_id, v_extra));
  end if;

  -- 5. Bookkeeping.
  update change set undone = (p_direction = 'undo') where id = p_base;
  update change
  set base_change_id = p_base,
      person_ids = v_base.person_ids,
      summary = case p_direction when 'undo' then 'Undid: ' else 'Redid: ' end || v_base.summary
  where id = v_id;
  return v_id;
end $$;

create function undo_last(p_email text, p_name text) returns bigint
language plpgsql volatile as $$
declare v_base bigint;
begin
  perform pg_advisory_xact_lock(7262021);
  select id into v_base
  from change
  where author_email = lower(p_email) and via = 'edit' and kind not in ('undo', 'redo') and not undone
  order by id desc
  limit 1;
  if v_base is null then
    return null;
  end if;
  return toggle_change(v_base, 'undo', p_email, p_name, 'keyboard');
end $$;

create function redo_last(p_email text, p_name text) returns bigint
language plpgsql volatile as $$
declare
  v_latest_base bigint;
  v_base bigint;
begin
  perform pg_advisory_xact_lock(7262021);
  select max(id) into v_latest_base
  from change
  where author_email = lower(p_email) and kind not in ('undo', 'redo');
  select u.base_change_id into v_base
  from change u
  join change b on b.id = u.base_change_id
  where u.author_email = lower(p_email) and u.kind = 'undo' and u.via = 'keyboard'
    and u.id > coalesce(v_latest_base, 0) and b.undone
    and not exists (select 1 from change r
                    where r.kind = 'redo' and r.base_change_id = u.base_change_id
                      and r.author_email = lower(p_email) and r.id > u.id)
  order by u.id desc
  limit 1;
  if v_base is null then
    return null;
  end if;
  return toggle_change(v_base, 'redo', p_email, p_name, 'keyboard');
end $$;
```

- [ ] **Step 4: Run it.** `npm run test:db` passes in full. If a scenario fails, fix the SQL rather than the test, unless the test contradicts the spec. Record any SQL change in the commit message.
- [ ] **Step 5: Commit** "006 part 2: toggle_change, undo_last, redo_last".

### Task 4: Apply 006 to the `editing` branch, plus development accounts

- [ ] **Step 1: Migrate.** `npm run db:migrate` (in the worktree; `.env.local` points at `editing`). Expected: `applied 006_editing.sql`.

- [ ] **Step 2: Check reads are unchanged.** With the `editing` `.env.local`, run `npm run verify-neon -- --api-sample 0`. It must exit 0 with `unexplained: 0`. The `editing` Function is still the old code, and the read path is unchanged.

- [ ] **Step 3: Create the development accounts.** `dev-admin@example.test`, `dev-editor@example.test` and `dev-viewer@example.test`, each with a random 20-character password.
  - Sign them up with `curl -X POST "$NEON_AUTH_BASE_URL/sign-up/email" -H "Origin: http://localhost:5174" -H 'content-type: application/json' --data '{"email":…,"password":…,"name":"Dev Admin"}'`.
  - Then, on `editing` only (the host must not be production's):

    ```sql
    update neon_auth."user" set "emailVerified" = true where email like 'dev-%@example.test';
    insert into editor (email, name, role, added_by) values
      ('dev-admin@example.test', 'Dev Admin', 'admin', 'dev setup'),
      ('dev-editor@example.test', 'Dev Editor', 'editor', 'dev setup');
    ```
  - Store the passwords in the gitignored `.env.dev-accounts.local`: `DEV_ADMIN_PASSWORD=…`, and so on.
  - Delete the spike users with SQL on `editing`:

    ```sql
    delete from neon_auth."user" where email like 'spike-%@example.com';
    ```

    Include their sessions/accounts if FKs require it.

- [ ] **Step 4: Nothing to commit** (data only).

---

## Chunk 2: API

The Function code lives in `api/`. Keep the pure request handling (routing, validation, response shaping) separate from DB access, so it can be unit-tested with fakes. DB-touching command logic gets DB tests on `test-editing`.

### Task 5: Authentication module

**Files:** Create `api/auth.js`. Test `tests/apiAuth.test.js` (node).

- [ ] **Interface:** `createAuthenticator({ jwksUrl, issuer, getKey })`.
  - It returns `authenticate(request)` → `null` when there is no `Authorization` header, else `{ email, name, sub }`. It throws `AuthError(401)` for an invalid or expired token, or for one with `emailVerified !== true`.
  - It uses `jwtVerify(token, getKey ?? createRemoteJWKSet(new URL(jwksUrl)), { issuer, audience: issuer, algorithms: ['EdDSA'] })`.
  - The email is lower-cased.
- [ ] **`requireEditor(user, lookupEditor)`:**
  - `lookupEditor(email)` → `{ email, name, role } | null`.
  - It returns `{ email, name: editor.name ?? user.name, role }`.
  - It throws `AuthError(401, 'unauthenticated')` when `user` is null, or `AuthError(403, 'not_an_editor')`.
- [ ] **Tests:** generate an Ed25519 key pair with `jose.generateKeyPair('EdDSA')` and pass `getKey` (the public key). Cases:
  - a valid token
  - expired
  - wrong issuer
  - wrong audience
  - an `HS256` token (rejected)
  - `emailVerified: false`
  - no header (null)
  - a malformed header
  - `requireEditor` for editor, admin and not-listed users
- [ ] **TDD, then commit** "API: JWT authentication".

### Task 6: Router and read routes

**Files:** Modify `api/handler.js` (it becomes the router), `api/index.js`. Create `api/http.js` (response helpers, CORS, `ApiError`). Tests: `tests/apiHandler.test.js` (extend).

- [ ] **Dependencies:** `createHandler({ db, authenticate, log })`, where `db` exposes:
  - `personView(id)` → `{ view, version }`, with `version = { changeId, migration }` from one SQL statement
  - `search(q, limit)`
  - `lookupEditor(email)`
  - `listEditors()`, `addEditor(...)`, `removeEditor(email, by)`
  - `runChange(user, kind, params)`
  - `toggle(user, id, direction, via)`, `undoLast(user)`, `redoLast(user)`
  - `listChanges({ before, limit, person })`

  `api/index.js` implements `db` with the `pg` pool. Each write runs `set local statement_timeout = '10s'; set local idle_in_transaction_session_timeout = '15s'` inside its transaction.
- [ ] **Routes and behaviour:** exactly as the spec's Routes table, including:
  - `masked` in views
  - ETag: `W/"${VIEW_VERSION}.${migration}.${changeId}.${id}"`, with `const VIEW_VERSION = 2`
  - 304 for non-editors
  - `Vary: Authorization`
  - `private, no-store` for editors
  - 401 on an invalid token, even for public GETs
  - CORS headers including `Access-Control-Max-Age`
  - the 1 MB body limit (413)
  - search `q` escaping and its ≥2 character minimum
- [ ] **Tests:** fake `db` and `authenticate`. Cover every route's success and error paths:
  - masking for anonymous and non-editor callers, but not editors
  - 304 only for non-editors, with matching `If-None-Match`
  - the ETag format
  - the preflight
  - the 413
  - search validation
  - `/me` 401/403/200
  - editors routes: admin only, can't remove self, can't remove the last admin
- [ ] **TDD, then commit** "API: router, auth-aware person view, search, me, editors".

### Task 7: Commands

**Files:** Create `api/commands/index.js` (registry), `api/commands/updatePerson.js`, `addRelative.js`, `linkExisting.js`, `updateFamily.js`, `unlink.js`, `deletePerson.js`, `api/commands/linking.js` (shared family and cycle helpers), `api/changes.js` (runner, for `index.js`'s `db.runChange`). Tests: `tests/db/commands.test.js` (against `test-editing`).

- [ ] **Runner** (`api/changes.js`): `runChange(pool, user, kind, params)`:
  1. `connect`, then `begin`, then the two `set local` timeouts
  2. `select begin_change($email, $name, $kind, 'edit', 'pending', $params, '{}')`
  3. `command.validate(params)`, which throws `ApiError(400, 'invalid', {field, message})`
  4. `command.run(tx, params, user)` → `{ summary, personIds, focusId }`
  5. If `select count(*) from change_row where change_id = $id` is 0, roll back and return `ApiError(400, 'no_change')`
  6. `update change set summary, person_ids`
  7. `commit`, then read `person_view(focusId)` (unmasked) and return `{ change: {id, summary, personIds}, view }`

  Map `GE001`–`GE007` and class `23` errors to `ApiError`s. Release the client in `finally`. It stays at the default READ COMMITTED isolation; add a comment saying never to change it, because the global lock relies on it.
- [ ] **Commands:** each module exports `{ kind, validate, run }` and implements the spec's Commands table, Linking rules (with the "Always invalid" cases), Cleanup and Validation exactly. Use the SQL helpers `ancestors_of`/`descendants_of` for cycle checks, the sequences for new ids, and `facts` validation per the spec (lenient: old and new shapes).
- [ ] **Summaries:** use display names, with "Unnamed person" when empty. Relation words are by sex where known (daughter/son/child, mother/father/parent, wife/husband/spouse, sister/brother/sibling).
- [ ] **DB tests** (`tests/db/commands.test.js`): every rule in the spec's Linking rules, Cleanup and Validation, including every invalid case. Also:
  - `stale` detection
  - `no_change` (saving identical fields)
  - the summary text for each command
  - `person_ids`
  - that each command's change can be undone and redone with `toggle_change`, returning the exact prior state
- [ ] **Facts validation test:** load every person from the `editing` branch (read-only; skip if `DATABASE_URL` isn't `editing`) and assert each passes `validateFacts`, and that the core fields pass `validate`.
- [ ] **TDD, then commit** "API: edit commands".

### Task 8: History and toggle routes, and deploy to `editing`

- [ ] **Implement in `index.js`'s `db`:**
  - `toggle` calls `toggle_change`.
  - `undoLast`/`redoLast` call the SQL functions.
  - `listChanges` pages newest first, 50 at a time, with an optional `person` filter (`person_ids @> array[$1]`).
- [ ] **Map conflict errors.** Enrich the `blocking` ids with `summary`, `authorName` and `createdAt` in one query. Map `GE003` to `409 {error: 'conflict', reason, blocking}`.
- [ ] **Unit tests** for these routes with fakes (in `tests/apiHandler.test.js`).
- [ ] **Deploy to `editing`.** Add `jose` to `dependencies`. Run `neon deploy` (`.neon` is `editing`), then smoke test with a dev account's JWT. Get the JWT the way the spike did: password sign-in, then `GET /get-session` with the cookie jar, reading `set-auth-jwt`. Check:
  - `/me`
  - one `update_person` and its undo
  - `/changes`
  - search
  - a 403 for `dev-viewer`
  - person view masking for an anonymous caller vs an editor
- [ ] **Commit** "API: history, toggles, undo/redo; deploy to editing".

---

## Chunk 3: Front end

`personDetails.js` and `style.css` come from PR #3 and are large. Put new UI in new modules, and only wire them in from `personDetails.js`/`main.js`. Unit tests use jsdom, plus stubs for `fetch` and the auth client.

### Task 9: Auth client, edit API client, data loader changes

**Files:** Create `src/auth.js`, `src/editApi.js`. Modify `src/dataLoader.js`, `.env.development`, `.env.production` (add `VITE_NEON_AUTH_URL`; the production value comes from `neon neon-auth status --branch production`, and the development value is overridden by `.env.development.local`). Tests: `tests/auth.test.js`, `tests/editApi.test.js`, `tests/dataLoader.test.js` (extend).

- [ ] **`src/auth.js`:** as in the spec's Front end table. `getToken()` reads `exp` from the cached JWT and forces `getSession({ fetchOptions: { headers: { 'X-Force-Fetch': 'true' } } })` when fewer than 60 s remain.
  - On sign-in and sign-out it calls listeners. `main.js` then runs `invalidateAll()` and re-reads `/me`.
  - If a completed sign-in is followed by an empty `getSession()`, it reports `cookieBlocked`.
  - `signInWithPassword` exists only when `import.meta.env.DEV`.
- [ ] **`src/editApi.js`:** `authedFetch` adds the bearer token and maps errors to `ApiError {status, code, reason, blocking, field}`. Exposes:
  - `runChange`
  - `revert(id, via)`, `restore(id)`
  - `undo()`, `redo()`
  - `listChanges`
  - `search`
  - `me`
  - `listEditors`, `addEditor`, `removeEditor`
- [ ] **`dataLoader.js`:** send the token when the cached role is editor. Add `invalidateAll()` (with a generation counter) and the 5-minute TTL. Keep the existing tests passing, and add tests for invalidation discarding in-flight results and for the TTL.
- [ ] **TDD, then commit.**

### Task 10: Sign-in UI, toast, account menu

**Files:** Create `src/signIn.js`, `src/toast.js`, `src/editorStyles.css`. Import it from `src/style.css` with `@import` (or from `main.js`) so PR #3's stylesheet is untouched. Tests: `tests/signIn.test.js`.

- [ ] **Header button and dialog.**
  - The sign-in dialog has an email field, then "Email me a code", then a 6-digit code field and "Sign in".
  - "Continue with Google".
  - A dev-only password form.
  - Errors are shown inline.
  - The dialog is full screen below 768 px.
- [ ] **Account menu:**
  - It shows the email and role, with links to History, Editors (admins only) and Sign out.
  - A non-editor sees the "ask Rob" note.
  - When `cookieBlocked`, it explains the browser limitation (spec Step 0).
- [ ] **Toast:** `showToast(message, { action: { label, onClick }, timeout })`.
- [ ] **Tests:** the dialog state machine (email, then code, then signed in), errors, and that the menu matches the role.
- [ ] **TDD, then commit.**

### Task 11: Person and family editors

**Files:** Create `src/personEditor.js`, `src/factsForm.js` (the facts ↔ form rows conversion, pure), `src/familyEditor.js`. Tests: `tests/factsForm.test.js`, `tests/personEditor.test.js`.

- [ ] **`factsForm.js`:** `factsToForm(facts)` → `{ notes[], lifeEvents{birth, baptism, death, burial: {notes[]}}, causeOfDeath, rows[], email, phone, legacy{} }`, and `formToFacts(form)`, its inverse.
  - Each `rows` entry is `{kind: 'occupation'|'residence'|'census'|'other', tag?, type?, cause?, value?, date?, place?, notes[], original?}`.
  - Old-shape values (plain occupation strings, `religion`, `education`) round-trip unchanged unless edited.
  - **Tests:**
    - round trip on hand-made old-shape and new-shape facts
    - **every real person**: load facts from the `editing` branch by calling `person_view` directly in SQL (the public API masks emails). Run this from a node test, skipped without `.env.local`, and assert `formToFacts(factsToForm(f))` deep-equals `f`.
- [ ] **`personEditor.js`:**
  - It renders the form into the details panel, using fields per the spec.
  - Save builds `update_person` with only the changed `fields` and, when changed, `facts`, plus `expectedUpdatedAt`.
  - Errors are inline. A 409 `stale` offers Reload.
  - Delete confirms, then sends `delete_person`.
  - It refuses a `masked: true` view, reloading it with the token.
- [ ] **`familyEditor.js`:** marriage and divorce date and place; `update_family` with `expected`.
- [ ] **TDD, then commit.**

### Task 12: Relative dialog and details-panel wiring

**Files:** Create `src/relativeDialog.js`. Modify `src/personDetails.js` (minimal hooks), `src/familyTreeView.js` only if needed. Tests: `tests/relativeDialog.test.js`, `tests/personDetails.test.js` (extend).

- [ ] **`relativeDialog.js`:** + Parent / Spouse / Child / Sibling, with tabs:
  - **New person:** given name, surname, sex, birth date and place, death date.
  - **Existing person:** search, debounced 250 ms, showing name and birth–death years.
  - **Family choice:**
    - + Child asks "with which partner?" (the person's spouses plus "Other parent unknown").
    - + Parent and + Sibling choose among `parentFamilies` when there are several.
    - + Sibling is disabled with "Add a parent first" when there are none.
  - It warns when an existing person already has parents.
  - It builds `add_relative` / `link_existing`.
- [ ] **`personDetails.js` hooks**, when `canEdit`:
  - an Edit button
  - + relative buttons
  - × on each parent, spouse and child row (sending `unlink` with a confirmation text per the spec's Cleanup)
  - Edit on each marriage row (opens `familyEditor`)
  - a "History of this person" link

  Keep PR #3's rendering untouched otherwise.
- [ ] **TDD, then commit.**

### Task 13: History panel, editors dialog, keyboard shortcuts, main wiring

**Files:** Create `src/historyPanel.js`, `src/editorsDialog.js`. Modify `src/main.js`. Tests: `tests/historyPanel.test.js`, `tests/editorsDialog.test.js`, `tests/main.test.js` (keyboard handling; extend if one exists).

- [ ] **History panel:**
  - a slide-over (full screen on phones), with infinite scroll (`before` = last id) and a person filter
  - each entry shows its summary, author and relative time, with Revert or Restore on base changes and none on undo/redo lines
  - reverted entries are greyed out
  - person ids in the entry link to those people
  - the conflict message lists blockers with their actions, linking to the blocking entry in the list and fetching more pages if needed
- [ ] **Editors dialog:** list, add, remove, with the server's errors shown.
- [ ] **`main.js`:**
  - **Sign-in state:** `canEdit` comes from `/me`; it calls `invalidateAll()` on sign-in and sign-out.
  - **Keyboard:** Ctrl/Cmd+Z → `undo()`, Ctrl/Cmd+Shift+Z or Ctrl+Y → `redo()`, ignored while focus is in a form field.
  - **After a change:** follow the spec's main.js row (re-render, focus fallback, toasts with Undo that call `revert(id, 'keyboard')`). Show "Nothing to undo" / "Nothing to redo".
- [ ] **TDD, then commit.**

### Task 14: End-to-end check on `editing`, docs, final review

- [ ] **Dev server.** Use the `editing-dev` launch configuration in the main checkout's `.claude/launch.json` (port 5174), with `.env.development.local` pointing at `editing`.
- [ ] **Browser checks, signed in as `dev-editor` (password form):**
  - every command once
  - Undo and Redo by keyboard and from the toast
  - History revert and restore
  - a forced conflict: edit a birth date in two tabs, then revert the older edit
  - `dev-viewer` sees no edit controls and the "ask" note
  - `dev-admin` adds and removes an editor
  - phone width
  - no console errors
- [ ] **`verify-neon` tweaks** from the spec's Testing section: drop `masked`; skip any person Z who is in T or whose legacy `familyIds` or current `view.family` intersect T; skip the count check once changes exist. Re-run it against `editing`.
- [ ] **README:** an "Editing" section covering sign-in, editors, History/Undo, the dev setup, and the release steps.
- [ ] **Final code review** of the whole branch (superpowers:code-reviewer), then fix the findings.
- [ ] **Stop here** and report to the developer. The release steps (spec "Rollout", step 3 onwards) need the PR #3 preconditions plus the developer's real-device tests.
