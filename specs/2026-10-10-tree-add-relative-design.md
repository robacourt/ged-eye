# Add a relative from the tree: design

**Date:** 2026-10-10
**Status:** Approved by the developer in conversation (option A, a "+" relative node).
**Follows:** [2026-10-09-editing-design.md](2026-10-09-editing-design.md). The relative dialog and its commands are unchanged.

## Goal

Make adding a person easy to find. Until now it has been reached only through the details panel's "+ Parent / + Spouse / + Child / + Sibling" buttons.

For editors, the family tree shows a "+" node joined to the highlighted person, like another direct relative. Tapping it opens a small menu (Parent, Spouse, Child, Sibling), and each choice opens the existing relative dialog.

## Behaviour

- **Who sees it:** editors only, once the editing chunk has loaded. Viewers' trees are unchanged.
- **The node:**
  - id `add-relative`, `type: 'add'`;
  - a dashed circle with a "+", slightly smaller than a relative node;
  - joined to the highlighted person by a dashed edge (`type: 'add'`), from the person to the node.
- **Layout:** the node and edge are part of the dagre layout, so the node takes a place of its own in the row below the person. It moves with whoever is highlighted, and it is rebuilt whenever the tree is rebuilt.
- **The control:** an HTML `<button>` sits over the node, kept in step with the node's rendered position on every pan, zoom, resize and layout.
  - It is at least 44×44px, whatever the zoom.
  - It can take keyboard focus.
  - Its label is `Add a relative to <name>`.
  - It has `aria-haspopup="menu"` and `aria-expanded`.
  - Tapping it never selects the node, and taps on the canvas node itself do nothing.
- **The menu:** `role="menu"`, opened next to the button and kept inside the viewport on phones.
  - **Items:** Parent, Spouse, Child, Sibling, each at least 44px tall.
  - **Blocked items:** an item `relativeBlocked(person, relation)` blocks (`src/familyLinks.js`, the rule the details panel uses) is `aria-disabled` and shows its reason, for example "Add a parent first".
  - **Keyboard:** arrow keys, Home and End move between items; Enter or Space chooses. Escape, Tab or a tap outside closes the menu and returns focus to the button.
  - **Choosing:** calls the same path as the details panel's buttons, `detailsOptions().onAddRelative(relation, person)`, which opens `openRelativeDialog` and, after saving, `afterCommand` with the toast and Undo.
  - **Viewer:** the menu closes when the highlighted person changes, or when the tree is rebuilt.

## Units

| Unit | Responsibility |
|---|---|
| `src/familyTreeView.js` (main bundle) | `setAddRelative(handler \| null)`. When it's set, the graph includes the add node and edge, and the overlay button is shown and kept in place. The button's click calls `handler({ anchor: button, person })`. With null (viewers, signed out), there is no node and no button. |
| `src/addRelativeMenu.js` (new, in the editing chunk) | `openAddRelativeMenu({ anchor, person, onChoose })` returns `{ close, isOpen }`. It builds the menu, positions it, and handles keyboard and outside taps. It has no knowledge of the tree. |
| `src/editing.js` | Exports `openAddRelativeMenu`. |
| `src/main.js` | When editing is available and the user can edit, it calls `treeView.setAddRelative(({ anchor, person }) => editing.openAddRelativeMenu({ anchor, person, onChoose: (relation) => detailsOptions().onAddRelative(relation, person) }))`. Otherwise it calls `setAddRelative(null)`. It is kept in step with sign-in and sign-out, as the details panel's options are. |
| Styles | The node and edge styles go in the tree's cytoscape style. The overlay button goes in `style.css`, because it's in the main bundle but only shown to editors. The menu goes in `editingStyles.css`. |

## Testing

- **`familyTreeView`:** with a handler, the elements include the add node and edge; with none, they don't. The overlay button's label is right, its click calls the handler with the person, and it is removed when the handler is cleared. Mock or stub cytoscape as needed; jsdom has no layout.
- **`addRelativeMenu`:**
  - the items, roles and labels;
  - a blocked Sibling item with its reason;
  - choosing by click and by keyboard;
  - Escape, Tab and an outside tap closing it, with focus returning;
  - text is escaped.
- **`mainEditing`:** editors get `setAddRelative(fn)`, and viewers and signed-out users get `setAddRelative(null)`. Choosing from the menu opens the relative dialog through `onAddRelative`.
- **Browser:** a harness with the live read-only API, at 375px and on desktop. Check the node's placement, the button's position as you pan, and the menu staying on screen.
