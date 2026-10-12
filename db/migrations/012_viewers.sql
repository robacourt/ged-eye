-- 012: a viewer access level (specs/2026-10-12-viewers-design.md). Viewers see everything, including living
-- people's details, but can't edit; the api and media Functions let only editors and admins edit
-- (api/auth.js requireEditor). The table keeps its name: it is the list of everyone with access.
alter table editor drop constraint editor_role_check;
alter table editor add constraint editor_role_check check (role in ('admin', 'editor', 'viewer'));
