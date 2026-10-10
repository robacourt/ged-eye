# Edit access requests: design

**Date:** 2026-10-10
**Status:** Revision 2, after a spec review. Approved by the developer in conversation. Email goes through a dedicated Gmail account, and the requester is notified when access is granted.
**Follows:** [2026-10-09-editing-design.md](2026-10-09-editing-design.md), for the `editor` table, admins and the Editors dialog.

## Goal

Someone signed in without edit rights can ask for them, with an optional note. Every admin is emailed. Any admin can follow the email's link and grant the request with one tap, or grant it from the app. When access is granted, the requester is emailed.

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
  - Across everyone, at most 10 new requests are accepted in any hour (`429 too_many_requests`). Email-code sign-in can mint a verified identity for any address, so this stops throwaway addresses from flooding admins and the Gmail account.
- **Menu states** (from `/me`'s `accessRequest`, the latest request):
  - none, or `dismissed`: the request button, with no mention of the dismissal;
  - `pending`: "You asked for edit access on <date>.";
  - `granted` while the role is still null (a brief race): the menu refreshes once.
- **Already an editor** (granted meanwhile): the request route returns `409 already_an_editor`, and the menu refreshes to show the edit controls.

**Admins:**
- **Email:** every admin gets a plain-text email, sent one message per admin.
  - Subject: "Edit access request from <verified email>". Names can be edited by the user, so they never go in headers.
  - Body: the requester's verified email, their name (if any; control characters stripped, at most 100 characters), the note (introduced as "Their note, as written by them:"), the time, and a **Review requests** link to `<site>/?access-requests`.
- **The link:** opens the site, asks for sign-in if needed, then opens the Editors dialog. A non-admin who follows it sees nothing special.
- **Editors dialog:** a **Requests** section at the top lists pending requests (name, email, note, date), each with **Grant** and **Dismiss**.
  - **Grant** adds the person as an `editor` (role `editor`, `added_by` the admin) and marks the request granted, in one transaction.
  - If another admin got there first, the response is `409 already_resolved`, with who resolved it and how. The row then shows "Granted by Rob" or "Dismissed by Rob".
  - Dismiss marks it dismissed and sends no email.
  - **Already an editor:** if the requester became an editor some other way, Grant still marks the request granted and returns the existing editor, but sends no email.
  - **Adding an editor directly:** `POST /editors` (the admin's add form) also marks any pending request for that email as granted, in the same transaction, so nothing is left pending.
  - After Grant or Dismiss, the dialog refreshes its list and the account menu's count (`refreshAccount`).
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
  resolved_at timestamptz,
  check ((status = 'pending') = (resolved_at is null)),
  check (char_length(name) <= 100)
);
create unique index access_request_one_pending on access_request (email) where status = 'pending';
create index access_request_email_created on access_request (email, created_at);
```

`access_request` is not a tree table, so writes need no `begin_change`, the same as `editor`.

## API (Function `api`)

| Method & path | Who | Result |
|---|---|---|
| `GET /me` | signed in | **Editors:** 200 as today, plus `pendingRequests: N` for admins. **Non-editors:** still `403 not_an_editor { email }`, whose body also carries `accessRequest: { status, createdAt } \| null` (the latest request). `editApi.me()` keeps that field when it turns the 403 into `{ role: null }`. |
| `POST /access-requests` | signed in, not an editor | Body `{ note? }`. Checks, in this order: (1) already an editor → `409 already_an_editor`; (2) a pending request → `200 { request }`, no mail; (3) the per-email and global rate limits → `429 too_many_requests`; (4) insert with `on conflict (email) where status = 'pending' do nothing`. A race there also gives `200` with the existing request. Returns `201 { request }`. Mail is sent **only on 201**, to every admin. |
| `GET /access-requests` | admin | `{ requests: [{ id, email, name, note, createdAt }] }`: pending ones whose email is not already an editor, oldest first, at most 100. |
| `POST /access-requests/:id/grant` | admin | `:id` must match `^[1-9][0-9]{0,14}$` (otherwise `400 invalid`). One transaction: re-check that the caller is still an admin (`403 not_an_admin` if not, as `removeEditor` does), lock the request `for update`, insert the editor (`on conflict do nothing`), and set it granted. Returns `{ request, editor }`, or `409 already_resolved { status, resolvedBy }`, or `404`. After commit, emails the requester, unless they were already an editor. |
| `POST /access-requests/:id/dismiss` | admin | As grant, without adding an editor or sending email. |
| `GET /health` | public | `{ ok: true, mail: 'smtp' \| 'log' }`. It says only whether SMTP credentials are configured, never what they are, so the secrets setup can be checked. |

- **Name:** the requester's `name` comes from the token, which may be null for email-code sign-ins.
- **Escaping:** all email text is plain text (`text/plain; charset=utf-8`), and the note goes in as written.
  - Headers are built only from fixed text and validated addresses: `EMAIL`, with no `,;<>"` or whitespace.
- **Note validation:** at most 500 code points after trimming, with no NUL characters (`400 invalid`, field `note`).
- **Wiring:** `createHandler` takes injected `mailer` and `waitUntil` (`@neon/functions`'s `waitUntil` in `index.js`), so tests can check what is sent and that it is never awaited.

## Mail (`api/mailer.js`)

- **`createMailer(env, { log })`** returns `{ mode, send({ to, subject, text }) }`.
- **With credentials:** when `SMTP_USER` and `SMTP_PASS` are set, it sends with nodemailer (a new dependency) through `smtp.gmail.com:465` (TLS), with 10 s connection and socket timeouts. The sender is `"GED-Eye" <SMTP_USER>`.
- **Without them** (dev branches, or before setup): it logs `mail (not sent): to, subject` and returns.
- **Never blocks a response:** sending runs after the response through `waitUntil` from `@neon/functions`. Failures are logged and never change the response.
- **Message builders:** `requestEmail` and `grantedEmail` are pure functions, unit-tested for content and header safety.
- **Site URL:** a constant in code, `https://robacourt.github.io/ged-eye/`, not a Function env var. That way a deploy without secrets sends no `env` at all.
- **Secrets:**
  - `neon.ts` declares `env: { SMTP_USER, SMTP_PASS }` for `api` **only when both are present** in `process.env`.
  - They live in their own gitignored file, `.env.mail.local` in the main checkout, not in `.env.local`. `neon env pull` writes `.env.local`, and a dev-branch deploy must never pick up the real credentials: a branch copies the real admin list, so real admins would be emailed.
  - Neither value is ever printed, committed or seen by Claude.
  - **Checked (2026-10-10, on `photos`):** a later deploy without `--env .env.mail.local` **keeps** the live keys. After a deploy with dummy values (`/health`: `mail: 'smtp'`), a plain `neon deploy --no-env-pull` still gave `smtp` five minutes later (deployment 12). So the secrets are deployed once, and the README says so. Deploying empty values deletes them, which is how the dummies were cleared.
- **Spike (2026-10-10):** a Neon Function on the `photos` branch reached `smtp.gmail.com` on 465 (TLS) and 587, and both answered `220`.

## Front end

| File | Change |
|---|---|
| `src/editApi.js` | `requestAccess(note)`, `listAccessRequests()`, `grantAccessRequest(id)`, `dismissAccessRequest(id)`. `me()` passes through `accessRequest` and `pendingRequests`. |
| `src/signIn.js` | **Non-editors:** the menu shows the request button, or the "asked on" line. The dialog itself is a small `accessRequestDialog.js`, in the main bundle because non-editors never load the editing chunk. **Admins:** "Access requests (N)", which calls the existing "Editors" opener. |
| `src/editorsDialog.js` | A Requests section above the editors list, with Grant and Dismiss, inline errors, `already_resolved` handling, and a refresh of the list after Grant. |
| `src/main.js` | `?access-requests`: the intent is read once at start and held in memory, and the parameter is removed straight away. Only that one parameter is deleted from a `URL` object, keeping `person` and `neon_auth_session_verifier`, and the URL is updated with `history.replaceState`, so it never sticks to later URLs. **After `auth.init()` resolves:** for an admin, the Editors dialog opens; if signed out, sign-in opens, and the dialog opens after sign-in only if the person turns out to be an admin; for anyone else, or if sign-in is cancelled, the intent is dropped quietly. Google sign-in returns to `location.href`, so the intent is read again on return. |
| `tests/mainEditing.test.js` | Its watched-API list (around line 455) gains the four new `editApi` calls. |

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
4. Pull `main` into the main checkout.
5. **The developer:**
   1. creates the site's Gmail account;
   2. turns on 2-Step Verification;
   3. creates an app password;
   4. writes `SMTP_USER=…` and `SMTP_PASS=…` to `/Users/rob/src/ged_eye/.env.mail.local`;
   5. runs `neon deploy --branch production --no-env-pull --env .env.mail.local` from the main checkout.
6. Check `/health` shows `mail: 'smtp'`, then send a real test request.
