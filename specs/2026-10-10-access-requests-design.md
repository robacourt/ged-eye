# Edit access requests: design

**Date:** 2026-10-10
**Status:** Approved by the developer in conversation. Email goes through a dedicated Gmail account, and the requester is notified when access is granted.
**Follows:** [2026-10-09-editing-design.md](2026-10-09-editing-design.md), for the `editor` table, admins and the Editors dialog.

## Goal

Someone signed in without edit rights can ask for them, with an optional note. Every admin is emailed. Any admin can grant the request in one tap from a link in that email, or from the app. When access is granted, the requester is emailed.

## Behaviour

**Requester** (signed in, verified email, not in `editor`):
- The account menu's "…ask Rob to add you" note becomes a **Request edit access** button.
- It opens a small dialog with:
  - an optional note: single or multi-line, at most 500 characters, trimmed;
  - Send and Cancel.
- **Sending:**
  - On success the dialog closes with a toast: "Request sent. You'll get an email when an admin grants it."
  - The menu then shows "You asked for edit access on 10 Oct.", with no button while the request is pending.
- **Limits:**
  - There is at most one pending request per email. Sending again while one is pending is a no-op, shown as already requested.
  - After a request is dismissed, the person can ask again, at most 3 requests per email in any 24 hours (`429 too_many_requests`).
- **Already an editor** (granted meanwhile): the request route returns `409 already_an_editor`, and the menu refreshes to show the edit controls.

**Admins:**
- **Email:** every admin gets a plain-text email.
  - Subject: "Edit access request from <name or email>".
  - Body: the requester's name (if any), email, note and time, and a **Review requests** link to `<site>/?access-requests`.
- **The link:** opens the site, asks for sign-in if needed, then opens the Editors dialog. A non-admin who follows it sees nothing special.
- **Editors dialog:** a **Requests** section at the top lists pending requests (name, email, note, date), each with **Grant** and **Dismiss**.
  - **Grant** adds the person as an `editor` (role `editor`, `added_by` the admin) and marks the request granted, in one transaction.
  - If another admin got there first, the response is `409 already_resolved`, with who resolved it and how. The row then shows "Granted by Rob" or "Dismissed by Rob".
  - Dismiss marks it dismissed and sends no email.
- **Account menu:** admins see "Access requests (N)" when N > 0. It opens the Editors dialog.

**Requester on grant:** a plain-text email, "You can now edit the A'Court family tree", with a link to the site.

## Data (migration `009_access_requests.sql`)

```sql
create table access_request (
  id          bigint generated always as identity primary key,
  email       text not null check (email = lower(email)),
  name        text,
  note        text check (char_length(note) <= 500),
  created_at  timestamptz not null default now(),
  status      text not null default 'pending' check (status in ('pending', 'granted', 'dismissed')),
  resolved_by text,
  resolved_at timestamptz
);
create unique index access_request_one_pending on access_request (email) where status = 'pending';
create index access_request_email_created on access_request (email, created_at);
```

`access_request` is not a tree table, so writes need no `begin_change`, the same as `editor`.

## API (Function `api`)

| Method & path | Who | Result |
|---|---|---|
| `GET /me` | signed in | As today, plus `accessRequest: { status, createdAt } \| null` (the latest request) for non-editors, and `pendingRequests: N` for admins. |
| `POST /access-requests` | signed in, not an editor | Body `{ note? }`. Returns `201 { request }`, or `200 { request }` with the existing request when one is already pending. Errors: `409 already_an_editor`, `429 too_many_requests`, `400 invalid` (note). After commit, emails every admin. |
| `GET /access-requests` | admin | `{ requests: [{ id, email, name, note, createdAt }] }`, the pending ones, oldest first. |
| `POST /access-requests/:id/grant` | admin | One transaction: lock the row, insert the editor (`on conflict do nothing`), set granted. Returns `{ request, editor }`, or `409 already_resolved { status, resolvedBy }` or `404`. After commit, emails the requester. |
| `POST /access-requests/:id/dismiss` | admin | As grant, without adding an editor or sending email. |

- **Name:** the requester's `name` comes from the token, which may be null for email-code sign-ins.
- **Escaping:** all email text is plain text (`text/plain; charset=utf-8`). The note goes in as written, and headers are built only from fixed text and validated addresses, with CR and LF stripped from names.

## Mail (`api/mailer.js`)

- **`createMailer(env, { log })`** returns `{ send({ to, subject, text }) }`.
- **With credentials:** when `SMTP_USER` and `SMTP_PASS` are set, it sends with nodemailer through `smtp.gmail.com:465` (TLS). The sender is `"GED-Eye" <SMTP_USER>`.
- **Without them** (dev branches, or before setup): it logs `mail (not sent): to, subject` and returns.
- **Never blocks a response:** sending runs after the response through `waitUntil` from `@neon/functions`. Failures are logged and never change the response.
- **Message builders:** `requestEmail` and `grantedEmail` are pure functions, unit-tested for content and header safety.
- **Site URL:** a new non-secret Function env var, `SITE_URL`, defaulting to `https://robacourt.github.io/ged-eye/`.
- **Secrets:** `neon.ts` declares `env: { SMTP_USER, SMTP_PASS }` for `api` **only when both are present** in `process.env`, so deploys without the secrets file leave the live keys untouched. The developer puts the values in a gitignored file and deploys with `--env`. Neither value is ever printed, committed or seen by Claude.
- **Spike (2026-10-10):** a Neon Function on the `photos` branch reached `smtp.gmail.com` on 465 (TLS) and 587, and both answered `220`.

## Front end

| File | Change |
|---|---|
| `src/editApi.js` | `requestAccess(note)`, `listAccessRequests()`, `grantAccessRequest(id)`, `dismissAccessRequest(id)`. `me()` passes through `accessRequest` and `pendingRequests`. |
| `src/signIn.js` | **Non-editors:** the menu shows the request button, or the "asked on" line. The dialog itself is a small `accessRequestDialog.js`, in the main bundle because non-editors never load the editing chunk. **Admins:** "Access requests (N)", which calls the existing "Editors" opener. |
| `src/editorsDialog.js` | A Requests section above the editors list, with Grant and Dismiss, inline errors, `already_resolved` handling, and a refresh of the list after Grant. |
| `src/main.js` | `?access-requests` in the URL: once signed in as an admin, open the Editors dialog, then remove the parameter from the URL with `history.replaceState`. If not signed in, open sign-in first. |

## Testing

- **DB tests:**
  - the one-pending partial index;
  - grant in one transaction (editor added, request granted);
  - two grants racing: one wins, the other gets `already_resolved`;
  - dismiss;
  - the rate-limit query.
- **Handler tests:** each route's auth (anonymous 401, non-editor vs admin 403), validation, the responses above, and that mail is scheduled with the right recipients and is never awaited.
- **Mailer tests:** the builders' text, header safety (CR/LF), the log-only mode without credentials, and nodemailer called with the right options (mocked).
- **Front-end tests:** the menu states (request button, asked, admin count), the request dialog, the Editors dialog's Requests section, and the `?access-requests` link flow.
- **Live, on the `photos` branch** with dev accounts, with mail logged:
  - a non-editor requests;
  - the admin lists and grants;
  - `/me` reflects each step;
  - the logs show both mails.
- **After the developer adds the Gmail secrets:** one real request and grant on production, to check delivery.

## Rollout

1. Apply migration 009 to production. It is additive.
2. Deploy `api`. Without the secrets, mail is logged.
3. Build `docs/` and merge the PR.
4. **The developer:**
   1. creates the site's Gmail account;
   2. turns on 2-Step Verification;
   3. creates an app password;
   4. adds `SMTP_USER` and `SMTP_PASS` to `/Users/rob/src/ged_eye/.env.local`;
   5. runs `neon deploy --branch production --no-env-pull --env .env.local` from the main checkout.
5. Send a real test request.
