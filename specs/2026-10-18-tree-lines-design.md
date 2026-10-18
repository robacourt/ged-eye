# Tidy tree lines: design

**Date:** 2026-10-18
**Status:** Asked for by the developer: the lines joining people looked janky on some people's trees. Not to be released until they have checked it.

## The problem

The tree was a Cytoscape graph laid out by dagre, a general layered graph layout, with "taxi" edges routed through small partnership nodes. dagre doesn't know that partners belong side by side, or that children hang from the couple. On many people's trees this produced:

- lines that looped out and doubled back;
- lines that crossed;
- a line running through a row of people;
- a partnership dot hidden behind another line, so a spouse looked unconnected;
- parents placed far from the person, so their line ran across the whole tree.

## The approach

Cytoscape stays, because touch, pan, tap and mobile already work well. dagre goes, replaced by a layout written for this view, `src/treeLayout.js`. It is pure data, so it is tested without drawing.

**Rows:** there are three.

- **Parents,** directly over the person. Any other partner a parent had children with sits beside that parent, away from the other. The parent with more of those goes on the right, because the tree keeps the person near its left edge when it is wider than the screen.
- **The person's row:**
  - their brothers and sisters;
  - half ones beside the parent they share, a lone parent's other children nearest that parent;
  - their partners, all on the right in order, so a partner never sits between them and their family.
- **Children,** under the couple they belong to. Each family is centred under its couple and pushed apart only as much as needed.

**Lines:**

- A couple is joined by a marriage line, with a dot in the gap between them. Each later partner's line runs 22 units higher, behind the partners before.
- Children hang from the dot, or straight from a lone parent: one line down to a bar above them, then one short line down to each child.
- Every line is horizontal or vertical. Lines run between invisible "joint" nodes, so they are straight Cytoscape edges drawn under the people, without arrows.
- Bars that would overlap or cross go at different heights. A bar goes below another when it reaches across that family's line down, or when the other bar reaches across one of its children.

**Colours:** each couple keeps its colour from the old palette, on its dot and every line of its family.

**The "+" node** is part of the layout. It goes on the person's left when they have partners, and on their right otherwise, the same rule as before.

## Testing

- **`tests/treeLayout.test.js`:** fixtures for the shapes that looked wrong (two marriages, four marriages, half brothers and sisters on both sides, lone parents), plus 500 random families. Each layout is checked for:
  - everyone placed once;
  - every line horizontal or vertical;
  - no lines crossing or lying on top of each other;
  - no two people overlapping;
  - every child reachable from its couple's dot.
  
  A one-off run of 5,000 random families passed.
- **`tests/familyTreeLayout.test.js`:** the real Cytoscape, headless, draws what the layout says, with straight lines, invisible joints and the "+" node on the right side.
- **By eye:** screenshots on desktop and mobile of the people that looked wrong before, and of random people.
