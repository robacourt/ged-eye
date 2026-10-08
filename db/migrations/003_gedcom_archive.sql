-- The original GEDCOM, byte for byte. The structured tables hold only what
-- scripts/gedParser.js understands, and Neon is now the master copy.
create table gedcom_archive (
  id          bigint generated always as identity primary key,
  file_name   text not null,
  sha256      text not null unique,
  imported_at timestamptz not null default now(),
  content     bytea not null
);
