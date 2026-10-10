-- 009: edit access requests (spec: specs/2026-10-10-access-requests-design.md). Someone signed in who
-- isn't in `editor` can ask for edit rights, with an optional note; admins grant or dismiss it. At most
-- one request per email is pending (access_request_one_pending); the (email, created_at) index serves
-- the per-email rate limit and the latest-request lookup. access_request is not a tree table, so,
-- like `editor`, it is written without begin_change. resolved_by is the resolving admin's email.
create table access_request (
  id          bigint generated always as identity primary key,
  email       text not null check (email = lower(email)),
  name        text,
  note        text check (char_length(note) <= 500),
  created_at  timestamptz not null default now(),
  status      text not null default 'pending' check (status in ('pending', 'granted', 'dismissed')),
  resolved_by text,
  resolved_at timestamptz,
  check ((status = 'pending') = (resolved_at is null)),
  check (char_length(name) <= 100)
);
create unique index access_request_one_pending on access_request (email) where status = 'pending';
create index access_request_email_created on access_request (email, created_at);
