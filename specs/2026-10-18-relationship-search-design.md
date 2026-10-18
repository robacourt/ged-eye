# Relationship search, and a menu button: design

**Date:** 2026-10-18
**Status:** Asked for by the developer, who set out the design below. It is to be built, then checked by them before the front end is released.

## Menu

- **The button:** the header's account button, or "Sign in" when signed out, becomes a hamburger button. It is always there, in the same top-right place.
- **The menu,** in this order, each item with an icon. Only items that apply are shown.
  - **Search:** opens the search page for the person on screen.
  - **History:** editors and admins.
  - **Access requests (N):** admins with pending requests.
  - **Manage access:** admins. This was "Editors and viewers", and the dialog's title changes with it.
  - **Request edit access:** signed in, but not an editor.
  - **Sign in** when signed out, **Sign out** when signed in.
- **Header:** a signed-in person's email and role stay at the top of the menu, with the notes and "Try again" as now.

## The search page

- **URL:** `?relative=<id>`, for the person who was on screen. Once someone is chosen it gains `&person=<id>`. Back and forward move between these as with any page, and a link to them opens the page.
- **Display:** it opens over the tree, which stays drawn underneath so that going back is instant. The menu button stays usable.
- **Top of the page:** a Back button (to the tree, with the relative selected) and "Find how someone is related to <relative's name>".
  - Below that is the existing search box (`personSearch.js`), with the results listed by name and years.
  - Choosing someone sets `person` in the URL and shows the chain.
- **The chain:**
  - **What it shows:** everyone on the shortest path from the relative to the chosen person, and nobody else. It is drawn in the tree's style.
  - **Positions:** generations are rows (parents above, children below). A sibling or partner stands beside, to the right.
  - **Sizes:** the chosen person is drawn larger, as the highlighted person is on the tree.
  - **Lines:**
    - parent to child: the tree's line down, an elbow when the two aren't in line;
    - brothers and sisters: a bracket above them, dashed for half-siblings;
    - partners: the marriage line with its dot.
  - **Zoom:** it is fitted to the room, up to natural size; long chains get small circles.
  - **Tapping someone** opens the tree with them selected.
- **In words,** below the chain: "Clement Bernard A'Court is Robert Michael A'Court's grandfather." The chosen person comes first, then the relative's name, then the relationship. "No family connection found" if there is no path.

## The path: `GET /relationship?from=<relative>&to=<person>` (api)

- **Access:** public. A signed-in caller is optional.
- **Validation:** ids are checked as for `/person`. An unknown id is 404 `not_found`.
- **The graph** comes from `family` and `family_child`:
  - parent and child links;
  - a partner link for each couple;
  - a sibling link between any two people who share a parent. It is a full sibling link when they have the same parents, else a half-sibling link.
- **Choosing the path:** the cheapest by Dijkstra, at weight 10 per step, 12 per partner step and 13 per half-sibling step (so a wife's son from an earlier marriage comes out as a stepson, not as one's son's half-brother). The shortest chain wins, and among equal ones, blood relations win over marriage. So a cousin comes as parent, their sibling, then their child.
- **The answer:**
  - **Found:** `{ path: [{ id, name, sex, birthDate, avatarKey, living, step }] }`. The records come from `relative_record`, in order from the relative to the person.
    - Each `step` says how that person relates to the one before: `parent`, `child`, `sibling`, `halfSibling` or `spouse`. The first person's `step` is null.
  - **Not connected:** `{ path: null }`.
- **Privacy:** for anyone not on the list, living people's records are redacted as relatives' are in a person view (`api/privacy.js`). They keep their name and sex, and lose their birth date and avatar.
- **Caching:** `no-store`, with `Vary: Authorization`.

## Wording: `src/relationshipWords.js`

The path is split into stretches of blood relation, separated by partner steps.

**A blood stretch** of the shape `parent* (sibling|halfSibling)? child*` counts up U generations and down D generations, with a sibling step counting as one of each. It is named by U and D:

| U, D | Name |
|---|---|
| U=0, D=0 | the same person |
| U only | father, grandfather, great-grandfather, great-great-grandfather, then "3× great-grandfather" |
| D only | son, grandson, great-grandson… |
| U=1, D=1 | brother or sister |
| U=1, D≥2 | nephew, grandnephew, great-grandnephew… |
| U≥2, D=1 | uncle, great-uncle, great-great-uncle… |
| U≥2, D≥2 | cousins: "first cousin", "second cousin once removed" |

- **Half relations:** a stretch with a half-sibling step is "half-" (half-brother, half-uncle).
- **Gender:** words follow the sex of the person they name. Unknown sex gives neutral words: parent, child, sibling, "aunt or uncle", "niece or nephew".

**In-laws and step-relations** have their own names:

| Path | Name |
|---|---|
| spouse | husband or wife |
| spouse, parent | father-in-law |
| spouse, sibling | brother-in-law |
| sibling, spouse | brother-in-law |
| child, spouse | son-in-law |
| parent, spouse | stepfather |
| spouse, child | stepson |

**Anything else** is a chain of possessives, which is always right: "Robert's wife's first cousin", "Robert's mother's husband's son".

## Testing

- **Unit tests:**
  - the path finder: shortest path, ties, full and half siblings, no path;
  - the handler: the route, validation, redaction for the public and not for people on the list;
  - the wording: every name in the tables, gender, half, in-law, step, possessive chains;
  - the chain layout: positions, no two people in one place, lines;
  - the page: search, choose, URL, sentence, a tap opening the tree, back;
  - the menu: the hamburger and its items for each kind of user;
  - main.js routing.
- **Live, on the `photos` branch:** the route, with checks by eye in the preview against live data.
