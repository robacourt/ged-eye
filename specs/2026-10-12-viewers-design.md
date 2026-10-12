# Viewer access level: design

**Date:** 2026-10-12
**Status:** Asked for by the developer ("yes, add the viewer level"), after invites and access levels (#13).
**Follows:** the living-privacy design (non-editors see living people by name only), and the invites design.

## Goal

A third access level, **Viewer**, for relatives who should see everything, including living people's details, without being able to edit. Admins invite viewers and change levels as they do for editors.

## Levels

| Level | Sees living people's details | Edits, uploads, history | Manages access |
|---|---|---|---|
| (public, or signed in and not listed) | no | no | no |
| Viewer | yes | no | no |
| Editor | yes | yes | no |
| Admin | yes | yes | yes |

## Server

- **Migration 012** widens the `editor.role` check to `('admin', 'editor', 'viewer')`. The table keeps its name: it is the list of people with access.
- **`requireEditor` (api/auth.js)** lets through only editors and admins, allow-listed so that an unknown role is refused. Everyone else on the list, viewers included, is refused 403 `not_an_editor`, as someone not listed is. This one gate covers every editing route (commands, undo and redo, revert, history), the admin routes, and the `media` Function's uploads, which share it.
- **`GET /person/:id` and `GET /search`** already serve the full view to anyone on the list, so viewers get it with no change. Their responses are `private, no-store`, as editors' are.
- **`GET /me`** answers 200 `{ email, name, role: 'viewer', accessRequest }` for a viewer. `accessRequest` is their latest request for edit access, as non-editors get in the 403.
- **Access requests:**
  - A viewer may ask for edit access, so only editors and admins get `already_an_editor`.
  - Admins see viewers' requests in the list and the count.
  - Granting one makes the viewer an editor. In SQL that is `on conflict … do update set role = 'editor' where role = 'viewer'`, and the "you can now edit" email goes as usual.
- **Invites:**
  - `role` may be `viewer`.
  - Inviting someone as a viewer leaves any pending request of theirs for edit access pending, so admins can still grant it. Inviting someone as an editor or admin still marks it granted.
  - The email describes the level: "You can see everything in the tree, including details of living people, which are hidden from the public."
- **Changing access:** `POST /editors/:email/role` accepts `viewer`. The rules for the last admin and for your own access are unchanged.

## Front end

- **Roles:** "can edit" (editor or admin) is now distinct from "is on the list" (any role).
  - The data loader asks for full views for any listed role.
  - Edit controls, history and the tree's "+" stay for editors and admins (`canEdit` in main.js already lists only those).
- **Account menu:**
  - It shows "Viewer".
  - It offers **Request edit access**, or says a request is pending, as for someone not listed. The note reads: "You can see everything, including living people's details."
  - There is no History.
- **Editors dialog:**
  - **Title:** it becomes **Editors and viewers**, and so does its menu item.
  - **Intro:** it explains the three levels.
  - **Invite form:** the Access options become Viewer, Editor (the default) and Admin.
  - **Each row:** the Access select gains Viewer.
  - **Toasts** use the right article ("a viewer", "an editor", "an admin").

## Testing

- **Unit tests:**
  - `requireEditor` refuses viewers and unknown roles;
  - `/me` for a viewer;
  - person and search views are unmasked for viewers;
  - the editing routes and the `media` Function's uploads refuse viewers;
  - invites and role changes accept viewers;
  - the mail text;
  - the menu, the dialog and the loader.
- **DB tests:**
  - 012's check;
  - a viewer's access request: created, listed and counted, then granted, which upgrades them;
  - a viewer invite leaves a pending request pending.
- **Live on `photos`:** `scripts/neon/smokeViewers.js`. The dev admin invites the dev viewer as a viewer, and the script checks:
  - the viewer's `/me`;
  - a living person's full view;
  - edits and uploads refused;
  - a request for edit access, granted, which makes them an editor.

  Then it removes them.

## Rollout

1. Migrate production (012), which is additive. The old Function treats a viewer as an editor, so no one is made a viewer until the new Function is live.
2. Deploy the Functions.
3. Build `docs/`, merge, and check the live site.
