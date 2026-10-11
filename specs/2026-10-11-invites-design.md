# Invites and access levels: design

**Date:** 2026-10-11
**Status:** Delegated by the developer ("just implement it and release it").
**Follows:** the editing design (the `editor` list, Editors dialog) and the access requests design (mail, `?access-requests`).

## Goal

Admins invite someone by email, choosing their access level, and the person is emailed. Admins can also change an editor's level.

The levels are the existing roles: **Editor** (can edit the tree) and **Admin** (can also manage editors and invites). Being on the `editor` list is what gives access, since sign-in checks it, so an invite adds the person straight away and the email tells them how to sign in. No migration is needed.

## Inviting

- **Editors dialog:** "Add an editor" becomes **Invite someone**, with these fields:
  - Email;
  - Name (optional);
  - Access (Editor or Admin);
  - Message (optional, up to 500 characters).
  
  The button is **Send invite**. On success, a toast says "Invited ann@example.com as an editor. They've been emailed."
- **`POST /editors`** (admin only) also takes an optional `message`, validated like an access request's note: trimmed, at most 500 characters, no NUL, and empty means none.
  - The address must also pass the mailer's `isSafeAddress`, so an address the mailer would refuse is a 400, not an invite that is never sent.
  - Once the editor is added (201), the invite is sent after the response through `sendLater`, as the access request mail is. A failure is logged.
  - The response is unchanged: `{ editor }`.
  - An address already on the list is still 409 `already_an_editor`, and no mail is sent. The dialog says the person already has access and that their level can be changed in the list.
  - A pending access request from the same address is still marked granted, as now. Only the invite is sent.
- **The email** (`inviteEmail` in `api/mailer.js`), plain text:
  - **Subject:** "You're invited to the A'Court family tree".
  - **Body:**
    - the inviter (their editor name if they have one, then their email), and the level, with what it allows;
    - their message, introduced as written by them, if there is one;
    - the sign-in instructions: sign in as the invited address, with Google if it's a Google account, or with a code sent to that address;
    - the link `<site>/?invite`.
  - The name is cleaned with `sanitizeName`, and addresses must pass `isSafeAddress`.
- **The `?invite` link:** the front end removes the parameter, as it does `?access-requests`. Once the session has been restored, it opens the sign-in dialog if nobody is signed in, and otherwise does nothing. After sign-in, the editing controls appear as usual.

## Changing someone's level

- **`POST /editors/:email/role`** (admin only) takes `{ role }` and returns 200 `{ editor }`. It refuses with:
  - 400 `invalid` for a role other than `editor` or `admin`;
  - 404 `not_found` when the address isn't on the list;
  - 403 `not_an_admin` when the caller is no longer an admin;
  - 409 `cannot_change_self`, "You can't change your own access.", which matches the rule that you can't remove yourself;
  - 409 `last_admin`, "The last admin can't be made an editor."

  The same role as now is a 200 with nothing changed.
- **`changeEditorRole(email, role, by)` in `api/db.js`** locks the admin rows in a fixed order, as `removeEditor` does, so two admins can't demote each other at once.
- **No email** is sent for a change of level.
- **Editors dialog:**
  - **The control:** every row except your own has an Access select (Editor or Admin) in place of the role label. A change is saved straight away, with the dialog busy.
  - **On success**, a toast says "ann@example.com is now an admin."
  - **On failure**, the select goes back to the old value and the error is shown in the row.

## Review changes

- **The inviter is re-checked inside the invite's transaction.** `addEditor` takes a share lock on the inviter's own admin row first, as `resolveAccessRequest` does. It returns `{ outcome: 'added' | 'listed' | 'not_an_admin', editor }`, so an admin demoted mid-invite can't create an admin, and a 403 is sent.
- **A demoted admin's account is re-read.** The front end re-reads the account quietly on a 403 `not_an_admin`, as it does on `not_an_editor`, so the admin menu items go away.
- **Unknown routes have their own code.** They answer 404 `no_route`, not `not_found`, so an old Function instance (or a mangled path) can't look like "editor removed".
- **Invites are capped.** Each admin may send 20 an hour, counted per Function instance, which is a brake rather than a quota. Above that the answer is 429 `too_many_invites`.
- **Message text is cleaned.** Invite messages and access request notes go through `sanitizeText`: line breaks are kept, other control characters become spaces, and direction overrides are dropped.
- **Hint for the wrong account.** When `?invite` is followed by someone signed in with an account that isn't on the list, a toast says to sign out and sign in with the address the invite went to.

## Testing

- **Unit tests:** `inviteEmail`; the handler's invite mail, validation, and the role route's outcomes and admin check; `editApi`'s two calls; the dialog's invite form and Access select; and `?invite` in `main.js`.
- **DB tests:** `changeEditorRole`'s outcomes.
- **Live, on the `photos` branch** (mail is only logged there): `scripts/neon/smokeInvites.js`. As the dev admin it:
  - invites a fresh address;
  - checks the logged invite line;
  - changes the address's level both ways;
  - checks the refusals for the admin's own level;
  - removes the address.

## Rollout

Deploy `api`, then build `docs/` and merge. There is no migration.
