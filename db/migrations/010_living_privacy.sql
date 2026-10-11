-- 010: privacy for living people (specs/2026-10-10-living-privacy-design.md).
--
-- person.living_override lets an editor say "living" or "deceased"; null means work it out.
-- person_living_estimate(id) works it out, ignoring the override:
--   deceased if there is any death or burial record (columns, or the death/burial notes and cause of death
--   in facts); else by year: the person's birth or baptism year, or else an estimate from the nearest
--   relatives with one (breadth-first, up to 3 steps over parents, children, partners and siblings, half-
--   siblings included), estimate = relative's year + 25 x the generations the relative is above them, the
--   latest at the nearest level that has any; deceased when that year is before (current year - 100);
--   living otherwise, including when no year can be found.
-- person_is_living(id) is the override if set, else the estimate.
--
-- person_record is 008's and relative_record 002's, copied verbatim, plus: `living` on both,
-- `livingEstimate` and `livingOverride` (omitted when null) on person_record, and `living` on each
-- photo's people. The api Function redacts living people for anyone who isn't an editor (api/privacy.js).

alter table person add column living_override text check (living_override in ('living', 'deceased'));

-- Whether a jsonb value (a string or a list of notes) has anything in it.
create or replace function jsonb_has_content(j jsonb) returns boolean
language sql immutable as $$
  select case jsonb_typeof(j)
    when 'string' then length(btrim(j #>> '{}')) > 0
    when 'array' then jsonb_array_length(j) > 0
    when 'object' then j <> '{}'::jsonb
    else false
  end
$$;

create or replace function person_living_estimate(p_id text) returns boolean
language plpgsql stable as $$
declare
  r person%rowtype;
  cutoff int := extract(year from now())::int - 100;
  known int;
  estimate int;
  visited text[] := array[p_id];
  cur_ids text[] := array[p_id];
  cur_gens int[] := array[0];
  next_ids text[];
  next_gens int[];
begin
  select * into r from person where id = p_id;
  if not found then
    return null;
  end if;

  if r.death_date is not null or r.death_place is not null or r.burial_date is not null or r.burial_place is not null
     or jsonb_has_content(r.facts -> 'causeOfDeath') or jsonb_has_content(r.facts -> 'deathNotes')
     or jsonb_has_content(r.facts -> 'burialNotes') then
    return false;
  end if;

  known := coalesce(gedcom_year(r.birth_date), gedcom_year(r.baptism_date));
  if known is not null then
    return known >= cutoff;
  end if;

  for depth in 1..3 loop
    -- One step out from the current level: (relative, generations above the person).
    with cur as (
      select c.id, c.gen from unnest(cur_ids, cur_gens) as c (id, gen)
    ),
    step as (
      -- parents: partners of a family the person is a child of
      select x.pid as id, c.gen + 1 as gen
      from cur c
      join family_child fc on fc.child_id = c.id
      join family f on f.id = fc.family_id
      cross join lateral (values (f.partner1_id), (f.partner2_id)) as x (pid)
      where x.pid is not null
      union
      -- children
      select fc.child_id, c.gen - 1
      from cur c
      join family f on c.id in (f.partner1_id, f.partner2_id)
      join family_child fc on fc.family_id = f.id
      union
      -- partners
      select case when f.partner1_id = c.id then f.partner2_id else f.partner1_id end, c.gen
      from cur c
      join family f on c.id in (f.partner1_id, f.partner2_id)
      where f.partner1_id is not null and f.partner2_id is not null
      union
      -- siblings, half-siblings included: other children of any family the person is a child of
      select fc2.child_id, c.gen
      from cur c
      join family_child fc on fc.child_id = c.id
      join family_child fc2 on fc2.family_id = fc.family_id
      where fc2.child_id <> c.id
    ),
    fresh as (
      select id, gen from step where not (id = any (visited))
    )
    select array_agg(id), array_agg(gen) into next_ids, next_gens from fresh;

    exit when next_ids is null;

    select max(coalesce(gedcom_year(p.birth_date), gedcom_year(p.baptism_date)) + 25 * n.gen)
    into estimate
    from unnest(next_ids, next_gens) as n (id, gen)
    join person p on p.id = n.id;

    if estimate is not null then
      return estimate >= cutoff;
    end if;

    visited := visited || next_ids;
    cur_ids := next_ids;
    cur_gens := next_gens;
  end loop;

  return true; -- nothing to go on: counted as living
end
$$;

create or replace function person_is_living(p_id text) returns boolean
language sql stable as $$
  select case p.living_override
           when 'living' then true
           when 'deceased' then false
           else person_living_estimate(p.id)
         end
  from person p
  where p.id = p_id
$$;

create or replace function relative_record(p_id text) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'id', p.id,
    'name', p.display_name,
    'sex', p.sex,
    'birthDate', p.birth_date,
    'avatarKey', p.avatar_key,
    'parentIds', to_jsonb(parent_ids(p.id)),
    'living', person_is_living(p.id)
  )
  from person p
  where p.id = p_id
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
                 'id', m.id, 'key', m.object_key, 'thumbKey', m.thumb_key, 'displayKey', m.display_key,
                 'fileName', m.file_name, 'contentType', m.content_type,
                 'caption', m.caption, 'date', m.date, 'width', m.width, 'height', m.height,
                 'people', coalesce((
                   select jsonb_agg(jsonb_build_object('id', q.id, 'name', q.display_name, 'living', person_is_living(q.id))
                                    order by q.display_name, q.id)
                   from person_media pq join person q on q.id = pq.person_id
                   where pq.media_id = m.id), '[]'::jsonb))
               order by pm.position, pm.media_id)
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
      ), '[]'::jsonb),
      'living', case p.living_override when 'living' then true when 'deceased' then false else est.living end,
      'livingEstimate', est.living
    )
    || jsonb_strip_nulls(jsonb_build_object(
      'baptismDate', p.baptism_date,
      'baptismPlace', p.baptism_place,
      'burialDate', p.burial_date,
      'burialPlace', p.burial_place,
      'avatarSource', p.avatar_source,
      'livingOverride', p.living_override
    ))
    || case when mar.list is null then '{}'::jsonb else jsonb_build_object('marriages', mar.list) end
  from person p
  cross join lateral (select person_living_estimate(p.id) as living) est
  cross join lateral (
    select jsonb_agg(
             jsonb_build_object(
               'spouseId', case when f.partner1_id = p.id then f.partner2_id else f.partner1_id end,
               'familyId', f.id,
               'childIds', coalesce((select jsonb_agg(fc.child_id order by fc.position)
                                     from family_child fc where fc.family_id = f.id), '[]'::jsonb)
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
