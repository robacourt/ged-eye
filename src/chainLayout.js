/**
 * Where the search page draws a relationship path (chainView.js; spec:
 * specs/2026-10-18-relationship-search-design.md): each generation a row, a parent above, a child below, and a
 * brother, sister or partner beside, to the right; nobody but the people on the path. Pure, so it can be tested
 * without drawing.
 *
 * A path is `[{ id, step }]` from the relative to the person found (GET /relationship), each `step` how that
 * person is related to the one before: 'parent', 'child', 'sibling', 'halfSibling' or 'spouse' (null first).
 */

/** Between columns, and between rows (graph units, as the tree: treeLayout.js). */
export const COLUMN = 230;
export const ROW = 330;
/** How far above brothers and sisters the bracket joining them runs. */
const BRACKET = 125;

/**
 * @returns `{ people: [{ id, x, y }], dots: [{ id, x, y }], joints: [{ id, x, y }], links: [{ id, source, target,
 *   kind, turn? }] }`. `kind` is 'descent' (a parent's line down to a child: an elbow turning `turn` below the
 *   parent when they aren't in line), 'siblings' or 'halfSiblings' (from a joint over the two, down to one of
 *   them), or 'marriage' (a partner to the couple's dot).
 */
export function layoutChain(path) {
  const out = { people: [], dots: [], joints: [], links: [] };
  const taken = new Set();
  let column = 0;
  let generation = 0;
  path.forEach((person, i) => {
    if (i > 0) {
      if (person.step === 'parent') generation -= 1;
      else if (person.step === 'child') generation += 1;
      else column += 1;
    }
    // Someone already there (a path that turns back on itself): the next free place to the right.
    while (taken.has(`${column},${generation}`)) column += 1;
    taken.add(`${column},${generation}`);
    out.people.push({ id: person.id, x: column * COLUMN, y: generation * ROW });
  });

  let next = 0;
  const id = (prefix) => `${prefix}-${next++}`;
  for (let i = 1; i < path.length; i++) {
    const before = out.people[i - 1];
    const here = out.people[i];
    const step = path[i].step;
    if (step === 'parent' || step === 'child') {
      const [parent, child] = step === 'parent' ? [here, before] : [before, here];
      const link = { id: id('link'), source: parent.id, target: child.id, kind: 'descent' };
      if (parent.x !== child.x) link.turn = (child.y - parent.y) / 2;
      out.links.push(link);
    } else if (step === 'spouse') {
      const dot = { id: id('dot'), x: (before.x + here.x) / 2, y: here.y };
      out.dots.push(dot);
      for (const partner of [before, here]) out.links.push({ id: id('link'), source: partner.id, target: dot.id, kind: 'marriage' });
    } else {
      const joint = { id: id('joint'), x: (before.x + here.x) / 2, y: Math.min(before.y, here.y) - BRACKET };
      out.joints.push(joint);
      const kind = step === 'halfSibling' ? 'halfSiblings' : 'siblings';
      for (const sibling of [before, here]) out.links.push({ id: id('link'), source: joint.id, target: sibling.id, kind });
    }
  }
  return out;
}
