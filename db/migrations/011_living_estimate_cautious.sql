-- 011: two cautious fixes to 010's person_living_estimate, from its review.
--
-- 1. Years for the 100-year line come from living_year(), not gedcom_year(): the latest year in the date, so
--    'BET 1920 AND 1935' gives 1935 (gedcom_year, which dated_family keeps using, gives the earliest), and no year
--    at all for a date that is only a lower bound ('AFT 1920', 'FROM 1920'), which could be any later year: the
--    person's year is then estimated from relatives instead.
-- 2. Half-siblings count at the first step, with parents: other children of any family either parent is a partner
--    in, not only of the person's own family (which found a half-sibling only at the second step, via the parent).
--
-- The rest of person_living_estimate is 010's, unchanged. person_is_living and person_record call it by name.

-- The latest standalone run of four ASCII digits in raw GEDCOM date text, or null when there is none or the date
-- is only a lower bound (AFT, or FROM with no TO).
create or replace function living_year(d text) returns int
language sql immutable as $$
  select case
    when upper(btrim(d)) ~ '^(AFT|FROM)\M' and upper(d) !~ '\mTO\M' then null
    else (select max(m[1]::int) from regexp_matches(d, '(?<![0-9])([0-9]{4})(?![0-9])', 'g') as m)
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

  known := coalesce(living_year(r.birth_date), living_year(r.baptism_date));
  if known is not null then
    return known >= cutoff;
  end if;

  for depth in 1..3 loop
    -- One step out from the current level: (relative, generations above the person).
    with cur as (
      select c.id, c.gen from unnest(cur_ids, cur_gens) as c (id, gen)
    ),
    parents as (
      -- partners of a family the person is a child of
      select c.id as of_id, c.gen, x.pid as id
      from cur c
      join family_child fc on fc.child_id = c.id
      join family f on f.id = fc.family_id
      cross join lateral (values (f.partner1_id), (f.partner2_id)) as x (pid)
      where x.pid is not null
    ),
    step as (
      select id, gen + 1 as gen from parents
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
      -- siblings: other children of the person's own families (which may have no partners)
      select fc2.child_id, c.gen
      from cur c
      join family_child fc on fc.child_id = c.id
      join family_child fc2 on fc2.family_id = fc.family_id
      where fc2.child_id <> c.id
      union
      -- half-siblings: other children of any family a parent is a partner in
      select fc.child_id, p.gen
      from parents p
      join family f on p.id in (f.partner1_id, f.partner2_id)
      join family_child fc on fc.family_id = f.id
      where fc.child_id <> p.of_id
    ),
    fresh as (
      select id, gen from step where not (id = any (visited))
    )
    select array_agg(id), array_agg(gen) into next_ids, next_gens from fresh;

    exit when next_ids is null;

    select max(coalesce(living_year(p.birth_date), living_year(p.baptism_date)) + 25 * n.gen)
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
