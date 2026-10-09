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
