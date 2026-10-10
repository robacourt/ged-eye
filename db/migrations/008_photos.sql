-- 008: photos. media gains a display image, its oriented size, a caption and a free-text date;
-- person gains avatar_source ({"mediaId", "crop"}: which photo and crop made the avatar). 006's
-- capture trigger and toggle_change read columns from the catalogue, so the new columns are recorded
-- and undoable with no change there. person_record is 007's, copied verbatim, except for 'photos'
-- (every field always present, plus the people tagged in each photo, ordered by position then id)
-- and 'avatarSource' (omitted when null).
alter table media
  add column display_key text,
  add column width   int,
  add column height  int,
  add column caption text,
  add column date    text;
alter table person add column avatar_source jsonb;
-- person_record's 'people' and verify.js look links up by media.
create index person_media_media_idx on person_media (media_id);

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
                   select jsonb_agg(jsonb_build_object('id', q.id, 'name', q.display_name)
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
      ), '[]'::jsonb)
    )
    || jsonb_strip_nulls(jsonb_build_object(
      'baptismDate', p.baptism_date,
      'baptismPlace', p.baptism_place,
      'burialDate', p.burial_date,
      'burialPlace', p.burial_place,
      'avatarSource', p.avatar_source
    ))
    || case when mar.list is null then '{}'::jsonb else jsonb_build_object('marriages', mar.list) end
  from person p
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
