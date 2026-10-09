-- Follow-up to 004 (applied migrations are never edited).
--
-- A person's families were ordered by sort_key, the numeric part of the GEDCOM id.
-- They are now ordered by when each family started: its marriage year, or failing
-- that the birth year of its eldest child. Families with neither come last, and
-- sort_key breaks ties. That order drives parents, spouses, marriages, the
-- per-family grouping of children, and siblings. Every lookup still goes through
-- the same indexes as 004.

-- First standalone run of four ASCII digits in raw GEDCOM date text, so '28 SEP 1940',
-- 'ABT 1850', '21 MAR1813', '12.2.1877' and '11 FEB 1671/72' all give a year.
-- Null when there is none ('yes', '18 ___ 19 ?', or a truncated 'BEF 30 MAY 185').
-- Assumes Gregorian or Julian years: '@#DHEBREW@ 5 TSH 5770' would give 5770.
create function gedcom_year(d text) returns int
language sql immutable as $$
  select (regexp_match(d, '(?<![0-9])[0-9]{4}(?![0-9])'))[1]::int
$$;

-- family plus start_year: the marriage year, else the eldest child's birth year (or
-- baptism year, when the birth date has none); null when neither is known.
-- Years are read from the date text on every call rather than stored, so editing a date
-- needs nothing else updated. A view rather than a function, so the planner inlines it
-- and only reads the children when there is no marriage year (a function call per row
-- made person_view about twice as slow).
-- The functions below name it only inside their bodies, which Postgres does not track,
-- and f.* is expanded when the view is created: replace it together with them.
create view dated_family as
  select f.*, coalesce(gedcom_year(f.marriage_date), k.year) as start_year
  from family f
  cross join lateral (
    select min(coalesce(gedcom_year(c.birth_date), gedcom_year(c.baptism_date))) as year
    from family_child fc
    join person c on c.id = fc.child_id
    where fc.family_id = f.id and gedcom_year(f.marriage_date) is null
  ) k;

create or replace function parent_ids(p_id text) returns text[]
language sql stable as $$
  select coalesce(array_agg(pid order by first_ord), '{}')
  from (
    select pid, min(ord) as first_ord
    from (
      select x.pid, row_number() over (order by f.start_year nulls last, f.sort_key, f.id, x.slot) as ord
      from family_child fc
      join dated_family f on f.id = fc.family_id
      cross join lateral (values (1, f.partner1_id), (2, f.partner2_id)) as x (slot, pid)
      where fc.child_id = p_id and x.pid is not null
    ) s
    group by pid
  ) t
$$;

create or replace function spouse_ids(p_id text) returns text[]
language sql stable as $$
  select coalesce(array_agg(sid order by first_ord), '{}')
  from (
    select sid, min(ord) as first_ord
    from (
      select case when f.partner1_id = p_id then f.partner2_id else f.partner1_id end as sid,
             row_number() over (order by f.start_year nulls last, f.sort_key, f.id) as ord
      from dated_family f
      where f.partner1_id = p_id or f.partner2_id = p_id
    ) s
    where sid is not null
    group by sid
  ) t
$$;

create or replace function child_ids(p_id text) returns text[]
language sql stable as $$
  select coalesce(array_agg(cid order by first_ord), '{}')
  from (
    select cid, min(ord) as first_ord
    from (
      select fc.child_id as cid, row_number() over (order by f.start_year nulls last, f.sort_key, f.id, fc.position) as ord
      from dated_family f
      join family_child fc on fc.family_id = f.id
      where f.partner1_id = p_id or f.partner2_id = p_id
    ) s
    group by cid
  ) t
$$;

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
      'avatarKey', p.avatar_key
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

create or replace function person_view(p_id text) returns jsonb
language sql stable as $$
  with
  pids as (select parent_ids(p_id) as a),
  parent_list as (select t.id, t.ord from pids, unnest(pids.a) with ordinality as t (id, ord)),
  spouse_list as (select id, ord from unnest(spouse_ids(p_id)) with ordinality as t (id, ord)),
  child_list as (select id, ord from unnest(child_ids(p_id)) with ordinality as t (id, ord)),
  sibling_list as (
    select id, min(ord) as ord
    from (
      select fc.child_id as id, row_number() over (order by f.start_year nulls last, f.sort_key, f.id, fc.position) as ord
      from pids
      join dated_family f on f.partner1_id = any (pids.a) or f.partner2_id = any (pids.a)
      join family_child fc on fc.family_id = f.id
      where fc.child_id <> p_id
    ) s
    group by id
  ),
  other_parent_list as (
    select distinct x.pid as id
    from sibling_list s
    join family_child fc on fc.child_id = s.id
    join family f on f.id = fc.family_id
    cross join lateral (values (f.partner1_id), (f.partner2_id)) as x (pid)
    where x.pid is not null and x.pid <> p_id and x.pid not in (select id from parent_list)
  ),
  candidates as (
    select id, 1 as grp, ord from parent_list
    union all select id, 2, ord from spouse_list
    union all select id, 3, ord from child_list
    union all select id, 4, ord from sibling_list
    union all select id, 5, 0 from other_parent_list
  ),
  members as (
    select distinct on (id) id, grp, ord
    from candidates
    where id <> p_id
    order by id, grp, ord
  )
  select case when not exists (select 1 from person where id = p_id) then null else
    jsonb_build_object(
      'person', person_record(p_id),
      'family', coalesce((select jsonb_agg(relative_record(m.id) order by m.grp, m.ord, m.id) from members m), '[]'::jsonb),
      'relationships', jsonb_build_object(
        'parents', coalesce((select jsonb_agg(id order by ord) from parent_list), '[]'::jsonb),
        'spouses', coalesce((select jsonb_agg(id order by ord) from spouse_list), '[]'::jsonb),
        'children', coalesce((select jsonb_agg(id order by ord) from child_list), '[]'::jsonb),
        'siblings', coalesce((select jsonb_agg(id order by ord) from sibling_list), '[]'::jsonb)
      )
    )
  end
$$;
