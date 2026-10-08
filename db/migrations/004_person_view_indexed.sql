-- Follow-up to 002 (applied migrations are never edited).
--
-- person_view: 002 found siblings with two ORed IN-subqueries against family,
-- which Postgres can only run as a seq scan of family. The parent ids are now
-- computed once as an array and compared with = any(...), so each lookup is a
-- BitmapOr over the two partner indexes. Same output and ordering as 002.
--
-- person_record: facts are merged first, so a stray key in facts can never
-- overwrite a core field, and facts must be a JSON object.

alter table person add constraint person_facts_is_object check (jsonb_typeof(facts) = 'object');

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
             order by f.sort_key, f.id) as list
    from family f
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
      select fc.child_id as id, row_number() over (order by f.sort_key, f.id, fc.position) as ord
      from pids
      join family f on f.partner1_id = any (pids.a) or f.partner2_id = any (pids.a)
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
