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

-- 005's person_record, plus updatedAt (for optimistic concurrency) and parentFamilies (the
-- families where this person is a child, chronologically, for "+ Sibling" and "+ Parent").
create or replace function person_record(p_id text) returns jsonb
language sql stable as $$
  select
    p.facts
    || jsonb_build_object(
      'id', p.id,
      'name', p.display_name,
      'givenName', p.given_name,
      'surname', p.surname,
      'sex', p.sex,
      'birthDate', p.birth_date,
      'birthPlace', p.birth_place,
      'deathDate', p.death_date,
      'deathPlace', p.death_place,
      'photos', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'key', m.object_key, 'thumbKey', m.thumb_key,
                 'fileName', m.file_name, 'contentType', m.content_type)
               order by pm.position)
        from person_media pm
        join media m on m.id = pm.media_id
        where pm.person_id = p.id
      ), '[]'::jsonb),
      'parentIds', to_jsonb(parent_ids(p.id)),
      'spouseIds', to_jsonb(spouse_ids(p.id)),
      'childIds', to_jsonb(child_ids(p.id)),
      'avatarKey', p.avatar_key,
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
    )
    || jsonb_strip_nulls(jsonb_build_object(
      'baptismDate', p.baptism_date,
      'baptismPlace', p.baptism_place,
      'burialDate', p.burial_date,
      'burialPlace', p.burial_place
    ))
    || case when mar.list is null then '{}'::jsonb else jsonb_build_object('marriages', mar.list) end
  from person p
  cross join lateral (
    select jsonb_agg(
             jsonb_build_object(
               'spouseId', case when f.partner1_id = p.id then f.partner2_id else f.partner1_id end,
               'familyId', f.id
             )
             || jsonb_strip_nulls(jsonb_build_object(
               'marriageDate', f.marriage_date,
               'marriagePlace', f.marriage_place,
               'divorceDate', f.divorce_date,
               'divorcePlace', f.divorce_place
             ))
             order by f.start_year nulls last, f.sort_key, f.id) as list
    from dated_family f
    where f.partner1_id = p.id or f.partner2_id = p.id
  ) mar
  where p.id = p_id
$$;

-- Undo and redo: toggle_change() undoes or redoes one base change from its change_row
-- snapshots and records that as its own undo/redo change; undo_last()/redo_last() are the
-- per-user Ctrl+Z / Ctrl+Shift+Z stack. Custom SQLSTATEs: GE001 not_found, GE002 wrong_state,
-- GE003 conflict (detail: {"reason", "blocking": [{id, action}]}).
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
