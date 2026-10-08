-- Ordered, de-duplicated relationship id lists for one person.
create or replace function parent_ids(p_id text) returns text[]
language sql stable as $$
  select coalesce(array_agg(pid order by first_ord), '{}')
  from (
    select pid, min(ord) as first_ord
    from (
      select x.pid, row_number() over (order by f.sort_key, f.id, x.slot) as ord
      from family_child fc
      join family f on f.id = fc.family_id
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
             row_number() over (order by f.sort_key, f.id) as ord
      from family f
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
      select fc.child_id as cid, row_number() over (order by f.sort_key, f.id, fc.position) as ord
      from family f
      join family_child fc on fc.family_id = f.id
      where f.partner1_id = p_id or f.partner2_id = p_id
    ) s
    group by cid
  ) t
$$;

-- What the graph needs to draw a relative.
create or replace function relative_record(p_id text) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'id', p.id,
    'name', p.display_name,
    'sex', p.sex,
    'birthDate', p.birth_date,
    'avatarKey', p.avatar_key,
    'parentIds', to_jsonb(parent_ids(p.id))
  )
  from person p
  where p.id = p_id
$$;

-- Full record for the selected person, in the legacy per-person JSON shape.
create or replace function person_record(p_id text) returns jsonb
language sql stable as $$
  select
    jsonb_build_object(
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
    || p.facts
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
             order by f.sort_key, f.id) as list
    from family f
    where f.partner1_id = p.id or f.partner2_id = p.id
  ) mar
  where p.id = p_id
$$;

-- The selected person plus immediate family, in one document. Null if the id is unknown.
create or replace function person_view(p_id text) returns jsonb
language sql stable as $$
  with
  parent_list as (select id, ord from unnest(parent_ids(p_id)) with ordinality as t (id, ord)),
  spouse_list as (select id, ord from unnest(spouse_ids(p_id)) with ordinality as t (id, ord)),
  child_list as (select id, ord from unnest(child_ids(p_id)) with ordinality as t (id, ord)),
  sibling_list as (
    select id, min(ord) as ord
    from (
      select fc.child_id as id, row_number() over (order by f.sort_key, f.id, fc.position) as ord
      from family f
      join family_child fc on fc.family_id = f.id
      where (f.partner1_id in (select id from parent_list) or f.partner2_id in (select id from parent_list))
        and fc.child_id <> p_id
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
