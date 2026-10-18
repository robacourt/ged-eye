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

**Look:**

- **Children's lines:** each child's line is drawn as one elbow from their family's dot: down to the family's bar, across, and down to them. The bends are rounded (Cytoscape `round-taxi`, radius 18), so a family's lines fork smoothly where the line down reaches the bar.
- **Marriage lines** are straight.
- **Dots:** a couple's dot is ringed in the background colour, so the lines meeting it stop just short of it.
- **Colours:** each family has its own colour on its dot and every one of its lines, from a softer palette (pink, violet, green, amber, sky, rose). The colours are opaque, so the lines a family's children share don't brighten where they overlap.
- **Motion:** the lines fade in over 240 ms when someone is shown, unless the reader prefers reduced motion.

**The "+" node** is part of the layout. It goes on the person's left when they have partners, and on their right otherwise, the same rule as before.

## Review changes

- **Placement is final.** The first place someone is given wins, so a line is never left pointing at where they used to be.
- **Edge cases in the data:**
  - The parents recorded twice count as one family.
  - A child in two marriages hangs from the first.
  - A partner who had children with both of the person's parents is drawn once; their children with the second parent hang from that parent alone.
  - A second set of parents with no other children here doesn't break the layout: a step-parent sits beside the parent, joined, and a parent with no partner here is placed without lines.
  - The person listed as their own relative is ignored.
- **Each line down picks its exact position once everyone is placed.** A couple's dot can go anywhere in the gap between the partners, and a lone parent's line can start anywhere behind their circle. It takes the nearest position at least 24 units from other families' lines down, so two families' lines never run side by side as one.
- **Many partners:** the marriage lines step closer together, staying within 60 units of the centre, inside every circle and below the bar over the row.

## Testing

- **`tests/treeLayout.test.js`:** fixtures for the shapes that looked wrong (two marriages, four marriages, half brothers and sisters on both sides, lone parents) and for the unusual data above, plus 500 random families. The random families include extra parent families, shared partners, shared children and up to ten partners. Each layout is checked for:
  - everyone placed once, at a real position;
  - every line horizontal or vertical;
  - no lines crossing, lying on top of each other, or running side by side from different families;
  - no line ending in empty space;
  - no two people overlapping;
  - every child reachable from its couple's dot.
  
  A one-off run of 5,000 random families passed.
- **All 2,995 people in the `photos` copy of the tree,** with and without the "+", pass the same checks (a one-off script).
- **`tests/familyTreeLayout.test.js`:** the real Cytoscape, headless, draws what the layout says, with straight lines, invisible joints and the "+" node on the right side.
- **By eye:** screenshots on desktop and mobile of the people that looked wrong before, and of random people.
