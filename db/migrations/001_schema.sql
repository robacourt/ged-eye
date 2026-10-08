create table person (
  id            text primary key,
  given_name    text not null default '',
  surname       text not null default '',
  display_name  text not null,
  sex           text check (sex in ('M', 'F', 'U')),
  birth_date    text,
  birth_place   text,
  death_date    text,
  death_place   text,
  baptism_date  text,
  baptism_place text,
  burial_date   text,
  burial_place  text,
  facts         jsonb not null default '{}',
  avatar_key    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table family (
  id             text primary key,
  partner1_id    text references person (id) on delete set null,
  partner2_id    text references person (id) on delete set null,
  marriage_date  text,
  marriage_place text,
  divorce_date   text,
  divorce_place  text,
  -- numeric part of the GEDCOM id (F12 -> 12); orders a person's families
  sort_key       bigint generated always as (coalesce(nullif(regexp_replace(id, '\D', '', 'g'), '')::bigint, 0)) stored
);
create index family_partner1_idx on family (partner1_id);
create index family_partner2_idx on family (partner2_id);

create table family_child (
  family_id text not null references family (id) on delete cascade,
  child_id  text not null references person (id) on delete cascade,
  position  int  not null,
  primary key (family_id, child_id)
);
create index family_child_child_idx on family_child (child_id);

create table media (
  id            bigint generated always as identity primary key,
  sha256        text not null unique,
  original_path text not null,
  file_name     text not null,
  content_type  text not null,
  byte_size     bigint not null,
  object_key    text not null,
  thumb_key     text
);

create table person_media (
  person_id text   not null references person (id) on delete cascade,
  media_id  bigint not null references media (id) on delete cascade,
  position  int    not null,
  primary key (person_id, media_id)
);
