-- 013: who is emailed when someone asks for edit access. Only people on the list with notify_access_requests set,
-- not every admin; there is no UI for it, so it is set by hand. On production, only the owner has it:
--   update editor set notify_access_requests = true where email = 'saintderanged@gmail.com';
-- Admins still see the requests in the app (the account menu's "Access requests (N)") either way.
alter table editor add column notify_access_requests boolean not null default false;
