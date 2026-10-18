/**
 * Where the family tree puts everyone, and the lines between them (familyTreeView.js draws it): pure data, so it
 * can be tested without drawing. It replaces a general graph layout (dagre), which didn't know that a couple
 * belongs side by side or that children hang from the couple, and so drew long, crossing and doubled-back lines.
 *
 * Up to three rows:
 *   - the parents, over the person, with any other partner a parent had children with beside that parent, away
 *     from the other (the parent with more of those on the right);
 *   - the person, their brothers and sisters (half ones on the side of the parent they share) and their partners,
 *     all on their right in order, so no partner sits between them and their family;
 *   - the person's children, under the couple they are the children of.
 * A couple is joined by a marriage line, with a dot in the gap between them; a later partner's line runs a little
 * higher, behind the partners before them. Children hang from the dot (or from a lone parent): one line down to a
 * bar above them, and one short line down from the bar to each child. Every line is horizontal or vertical.
 */

/** Outer widths (graph units) of a person, the highlighted person and an editor's "+" node, with their borders. */
export const SIZES = { person: 140, selected: 186, add: 114 };

const GAP = 45;          // between brothers and sisters, and between children
const COUPLE_GAP = 90;   // between partners: room for the dot, and the line down from it
const ADD_GAP = 40;      // between the person and the "+" node
const GROUP_GAP = 100;   // between families in a row
const ROW = 330;         // between the rows' centres
/** Room below a circle for its name and year (two or three lines). */
const LABEL_ROOM = 60;
/**
 * The extent (graph units) of a full tree, three rows deep, with the person's row at 0: the tree is always fitted
 * to this, not to who is shown, so people are the same size whoever they are and however many rows they have.
 */
export const FRAME = { top: -ROW - SIZES.person / 2, bottom: ROW + SIZES.person / 2 + LABEL_ROOM };
// A family's bar, below the row above: under its labels, above the next row's circles.
const BAR_BELOW_PARENTS = 190;
const BAR_BELOW_PERSON = 215;
const LEVEL = 14;        // between bars that would otherwise overlap
const OFFSET = 22;       // how much higher each later partner's marriage line runs, with few partners
const MAX_OFFSET = 60;   // the highest a marriage line runs: inside every circle, below the bar over the row
const DOT_MARGIN = 24;   // a dot's least distance from a partner's circle
const LONE_SHIFT = 40;   // how far a lone parent's line down may start from their centre, still behind them
const CLEAR = 24;        // the least distance between a family's line down and another family's lines down

/**
 * @param selected       the person's record (person_record): id, parentFamilies, marriages
 * @param family         their relatives' records: id, parentIds
 * @param relationships  `{ parents, spouses, children, siblings }`, each a list of relative records, in order
 * @param withAdd        whether to make room for an editor's "+" node beside the person
 * @returns `{ people: [{ id, x, y }], add: { x, y } | null, dots: [{ id, x, y, color }], joints: [{ id, x, y }],
 *   lines: [{ id, source, target, color, kind }], links: [{ id, source, target, turn, color }] }`. `color` is a
 *   palette index. `lines` is every straight piece, between dots and joints (invisible points): marriage lines
 *   (`kind` 'marriage') and the lines down to the children ('descent'). `links` are those lines down again, one per
 *   child, from their family's dot (or joint, for a lone parent) to the child: down `turn` units to the bar, across
 *   and down, which the tree draws as one rounded elbow per child.
 */
export function layoutFamily({ selected, family = [], relationships = {}, withAdd = false, sizes = SIZES }) {
  const records = new Map([[selected.id, selected], ...family.map(member => [member.id, member])]);
  const isHere = (id) => id !== null && id !== undefined && records.has(id);
  // A relative is anyone here but the person (whom odd data can list as their own relative).
  const isRelative = (id) => isHere(id) && id !== selected.id;
  const widthOf = (id) => (id === selected.id ? sizes.selected : sizes.person);
  const idsOf = (list) => [...new Set((list ?? []).map(entry => entry?.id).filter(isRelative))];
  const siblingIds = idsOf(relationships.siblings);
  const spouseIds = idsOf(relationships.spouses);
  const childIds = idsOf(relationships.children);

  const out = { people: [], add: null, dots: [], joints: [], lines: [], links: [] };
  const placed = new Map(); // id → { x, y }
  // The first place wins: lines are drawn to people where they are, so nobody moves once placed.
  const place = (id, x, y) => {
    if (!placed.has(id)) placed.set(id, { x, y });
  };
  let nextId = 0;
  const joint = (x, y) => {
    const id = `joint-${nextId++}`;
    out.joints.push({ id, x, y });
    return id;
  };
  const line = (source, target, color, kind = 'descent') => out.lines.push({ id: `line-${nextId++}`, source, target, color, kind });

  // --- Families -----------------------------------------------------------------------------------------------

  // The person's parents' families: the first is theirs; any other (two sets of parents) is drawn like a half one.
  const parentFamilies = (selected.parentFamilies ?? [])
    .map(entry => ({ partners: (entry.partnerIds ?? []).filter(isRelative), children: (entry.childIds ?? []).filter(isHere) }))
    .filter(entry => entry.partners.length > 0);
  const primary = parentFamilies[0] ?? null;
  const parents = primary ? [...primary.partners] : [];
  const fullGroup = primary ? primary.children.filter(id => id === selected.id || siblingIds.includes(id)) : [];
  if (!fullGroup.includes(selected.id)) fullGroup.push(selected.id);
  const inRow = new Set(fullGroup);

  // Half brothers and sisters, by their parents; each family on the side of the parent it shares.
  const halfFamilies = new Map(); // key → { partners, children, shared, others }
  const halfFamily = (partners) => {
    const key = [...partners].sort().join('+');
    if (!halfFamilies.has(key)) {
      const shared = parents.find(id => partners.includes(id)) ?? null;
      halfFamilies.set(key, { partners, children: [], shared, others: partners.filter(id => id !== shared) });
    }
    return halfFamilies.get(key);
  };
  // The person's parents again (the same couple recorded twice): their children are full brothers and sisters.
  const isParents = (partners) => parents.length > 0 && partners.length === parents.length && partners.every(id => parents.includes(id));
  for (const extra of parentFamilies.slice(1)) {
    const children = extra.children.filter(id => !inRow.has(id));
    children.forEach(id => inRow.add(id));
    if (isParents(extra.partners)) fullGroup.push(...children);
    else halfFamily(extra.partners).children.push(...children);
  }
  for (const id of siblingIds) {
    if (inRow.has(id)) continue;
    const partners = (records.get(id).parentIds ?? []).filter(isRelative);
    if (isParents(partners)) fullGroup.push(id);
    else halfFamily(partners).children.push(id);
    inRow.add(id);
  }
  // With one parent here, their other children with no other partner here hang from them with the person's
  // family, on one bar: two lines straight down from the same parent would lie on top of each other.
  const halves = [...halfFamilies.values()].filter(entry => {
    if (parents.length !== 1 || entry.shared !== parents[0] || entry.others.length) return true;
    fullGroup.push(...entry.children);
    return false;
  });
  // The parent with more half brothers and sisters goes on the right: the tree shows the person near its left
  // edge when it is wider than the screen (familyTreeView.js), so the right is where there is room to see them.
  const halfCount = (parent) => halves.filter(entry => entry.shared === parent).reduce((sum, entry) => sum + entry.children.length, 0);
  if (parents.length === 2 && halfCount(parents[0]) > halfCount(parents[1])) parents.reverse();
  const sideOf = (entry) => (parents.length === 2 && entry.shared === parents[0] ? 'left' : 'right');
  // Nearest the full family first: a parent's children with no other partner here (they hang straight from the
  // parent), then those with another partner, then (on the right) any sharing no parent here.
  const nearestFirst = (list) => [
    ...list.filter(entry => entry.shared && !entry.others.length),
    ...list.filter(entry => entry.shared && entry.others.length),
    ...list.filter(entry => !entry.shared)
  ];
  const leftHalves = nearestFirst(halves.filter(entry => sideOf(entry) === 'left'));
  const rightHalves = nearestFirst(halves.filter(entry => sideOf(entry) === 'right'));

  // The person's own families: one per partner, in order, and one for children with no partner here.
  const childSet = new Set(childIds);
  const ofSpouse = new Map(spouseIds.map(id => [id, new Set()]));
  const assigned = new Set(); // a child listed in two marriages hangs from the first
  for (const marriage of selected.marriages ?? []) {
    const set = ofSpouse.get(marriage.spouseId);
    if (!set) continue;
    for (const id of marriage.childIds ?? []) {
      if (childSet.has(id) && !assigned.has(id)) { set.add(id); assigned.add(id); }
    }
  }
  const withSpouse = new Set([...ofSpouse.values()].flatMap(set => [...set]));
  const ownFamilies = spouseIds.map(id => ({ partner: id, children: childIds.filter(child => ofSpouse.get(id).has(child)) }));
  const alone = childIds.filter(id => !withSpouse.has(id));

  // --- The person's row ---------------------------------------------------------------------------------------

  const row = []; // { id, width, gap (before it) }
  const push = (id, width, gap) => {
    if (row.some(entry => entry.id === id)) return; // listed twice (a brother who is also a partner, in odd data)
    row.push({ id, width, gap: row.length === 0 ? 0 : gap });
  };
  for (const entry of [...leftHalves].reverse()) {
    entry.children.forEach((id, i) => push(id, widthOf(id), i === 0 ? GROUP_GAP : GAP));
  }
  // With partners (all on the right), the person ends their brothers' and sisters' group.
  const siblingsInOrder = spouseIds.length > 0 ? [...fullGroup.filter(id => id !== selected.id), selected.id] : fullGroup;
  siblingsInOrder.forEach((id, i) => {
    if (id === selected.id && withAdd && spouseIds.length > 0) push('add', sizes.add, i === 0 ? GROUP_GAP : GAP);
    const afterAdd = id === selected.id && withAdd && spouseIds.length > 0;
    push(id, widthOf(id), afterAdd ? ADD_GAP : i === 0 ? GROUP_GAP : GAP);
    if (id === selected.id && withAdd && spouseIds.length === 0) push('add', sizes.add, ADD_GAP);
  });
  for (const id of spouseIds) push(id, widthOf(id), COUPLE_GAP);
  for (const entry of rightHalves) {
    entry.children.forEach((id, i) => push(id, widthOf(id), i === 0 ? GROUP_GAP : GAP));
  }
  // Anyone else in the row (data that fits none of the above) at its end, without lines.
  for (const id of [...siblingIds, ...spouseIds]) if (!row.some(entry => entry.id === id)) push(id, widthOf(id), GROUP_GAP);

  let x = 0;
  row.forEach((entry, i) => {
    if (i > 0) x += row[i - 1].width / 2 + entry.gap + entry.width / 2;
    entry.x = x;
  });
  const shift = row.find(entry => entry.id === selected.id).x;
  for (const entry of row) {
    if (entry.id === 'add') out.add = { x: entry.x - shift, y: 0 };
    else place(entry.id, entry.x - shift, 0);
  }
  const at = (id) => placed.get(id);
  const span = (ids) => {
    if (!ids.length) return null;
    const xs = ids.map(id => at(id).x);
    return { min: Math.min(...xs), max: Math.max(...xs), centre: (Math.min(...xs) + Math.max(...xs)) / 2 };
  };

  // --- Couples ------------------------------------------------------------------------------------------------

  // Each family's line down starts at its couple's dot, anywhere in the gap between them, or at a lone parent,
  // anywhere behind their circle: `x` is where it would like to be, `range` where it may go. Where exactly is
  // chosen once everyone is placed, clear of the other families' lines (Lines down to the children).
  // { partners, x, range: [lo, hi], y, children, color, bar: 'parents' | 'person' }
  const families = [];
  const lone = (parent, children, color, bar) => ({
    partners: [parent], x: at(parent).x, range: [at(parent).x - LONE_SHIFT, at(parent).x + LONE_SHIFT], y: at(parent).y,
    children, color, bar
  });

  /**
   * A couple: a dot at (dotX, y), and a marriage line from each partner's centre to it, at that height.
   * → the dot's id
   */
  function couple(partners, dotX, y, color) {
    const id = `dot-${nextId++}`;
    out.dots.push({ id, x: dotX, y, color });
    for (const partner of partners) line(joint(at(partner).x, y), id, color, 'marriage');
    return id;
  }
  /** A family with children waits for its line down to be placed; a couple without any is drawn now. */
  const addFamily = (entry) => {
    if (entry.children.length) families.push(entry);
    else if (entry.partners.length === 2) couple(entry.partners, entry.x, entry.y, entry.color);
  };

  /** How much higher each later partner's line runs, when there are `count`: closer together for many. */
  const stepFor = (count) => Math.min(OFFSET, MAX_OFFSET / Math.max(1, count - 1));

  // The person's partners, left to right: each later one's line a little higher, its dot in the gap before them.
  const ownStep = stepFor(ownFamilies.length);
  ownFamilies.forEach((entry, k) => {
    const before = k === 0 ? selected.id : ownFamilies[k - 1].partner;
    const left = at(before).x + widthOf(before) / 2;
    const right = at(entry.partner).x - widthOf(entry.partner) / 2;
    const y = k === 0 ? 0 : -ownStep * k;
    addFamily({
      partners: [selected.id, entry.partner], x: (left + right) / 2, range: [left + DOT_MARGIN, right - DOT_MARGIN], y,
      children: entry.children, color: k, bar: 'person'
    });
  });
  if (alone.length) families.push(lone(selected.id, alone, ownFamilies.length, 'person'));

  // --- The children's row -------------------------------------------------------------------------------------

  const groups = families.filter(entry => entry.bar === 'person').map(entry => ({ ...entry, ids: entry.children }));
  placeGroups(groups, sizes.person).forEach(({ ids, xs }) => ids.forEach((id, i) => place(id, xs[i], ROW)));
  // Any child not placed (data that fits none of the above) at the end of the row, without lines.
  let childEnd = Math.max(0, ...childIds.filter(id => placed.has(id)).map(id => at(id).x));
  for (const id of childIds) if (!placed.has(id)) { childEnd += sizes.person + GAP; place(id, childEnd, ROW); }

  // --- The parents' row ---------------------------------------------------------------------------------------

  const parentY = -ROW;
  const w = sizes.person;
  if (parents.length) {
    // Over the person (at 0), so they stay in view, with the bar reaching across to the brothers and sisters.
    const centre = 0;
    if (parents.length === 2) {
      place(parents[0], centre - COUPLE_GAP / 2 - w / 2, parentY);
      place(parents[1], centre + COUPLE_GAP / 2 + w / 2, parentY);
      const range = [at(parents[0]).x + w / 2 + DOT_MARGIN, at(parents[1]).x - w / 2 - DOT_MARGIN];
      addFamily({ partners: parents, x: centre, range, y: parentY, children: fullGroup, color: 0, bar: 'parents' });
    } else {
      place(parents[0], centre, parentY);
      families.push(lone(parents[0], fullGroup, 0, 'parents'));
    }
  }

  /**
   * Another partner of `parent`, on one side (-1 left, +1 right), as near the parent as the room allows but over
   * their children if it can be; or, for a parent's children with no other partner here, a line from the parent.
   */
  let color = 1;
  function otherFamilies(entries, parent, side) {
    // An other partner already placed (with children by both parents) is drawn once: their children with this
    // parent hang from the parent alone, as children with no other partner here do.
    const otherOf = (entry) => entry.others.find(id => !placed.has(id)) ?? null;
    const withOther = entries.filter(otherOf);
    const step = stepFor(withOther.length);
    let previous = parent;
    let k = 0;
    for (const entry of entries) {
      const other = otherOf(entry);
      if (!other) {
        if (entry.children.length) families.push(lone(parent, entry.children, color++, 'parents'));
        continue;
      }
      // Over their children if there is room; a partner with no children here (a step-parent) beside the last.
      const desired = span(entry.children)?.centre ?? null;
      const nearest = at(previous).x + side * (w + COUPLE_GAP);
      const over = desired === null ? nearest : desired + side * (COUPLE_GAP / 2 + w / 2);
      place(other, side < 0 ? Math.min(nearest, over) : Math.max(nearest, over), parentY);
      const inner = at(previous).x + side * (w / 2 + DOT_MARGIN);
      const outer = at(other).x - side * (w / 2 + DOT_MARGIN);
      const target = desired ?? (inner + outer) / 2;
      const range = [Math.min(inner, outer), Math.max(inner, outer)];
      const y = k === 0 ? parentY : parentY - step * k;
      addFamily({
        partners: [parent, other], x: Math.min(Math.max(target, range[0]), range[1]), range, y,
        children: entry.children, color, bar: 'parents'
      });
      color++;
      previous = other;
      k++;
    }
  }
  if (parents.length) {
    otherFamilies(leftHalves.filter(entry => entry.shared), parents[0], -1);
    otherFamilies(rightHalves.filter(entry => entry.shared), parents[parents.length - 1], 1);
  }
  // Half families sharing no parent here (unusual data): their parents at the right end, over their children.
  let parentEnd = Math.max(0, ...[...placed].filter(([, p]) => p.y === parentY).map(([, p]) => p.x));
  for (const entry of rightHalves.filter(item => !item.shared && item.children.length)) {
    const desired = span(entry.children).centre;
    const partners = entry.partners.filter(id => !placed.has(id));
    if (!partners.length) continue;
    const first = Math.max(parentEnd + w + GROUP_GAP, desired - (partners.length - 1) * (w + COUPLE_GAP) / 2);
    partners.forEach((id, i) => place(id, first + i * (w + COUPLE_GAP), parentY));
    parentEnd = first + (partners.length - 1) * (w + COUPLE_GAP);
    if (partners.length === 2) {
      const range = [first + w / 2 + DOT_MARGIN, first + w / 2 + COUPLE_GAP - DOT_MARGIN];
      addFamily({ partners, x: first + (w + COUPLE_GAP) / 2, range, y: parentY, children: entry.children, color: color++, bar: 'parents' });
    } else {
      families.push(lone(partners[0], entry.children, color++, 'parents'));
    }
  }
  // Anyone else (data that fits none of the above) at the end of the parents' row, without lines.
  for (const member of family) {
    if (!placed.has(member.id)) { parentEnd += w + GAP; place(member.id, parentEnd, parentY); }
  }

  // --- Lines down to the children -----------------------------------------------------------------------------

  for (const bar of ['parents', 'person']) {
    const hanging = families.filter(entry => entry.bar === bar && entry.children.length);
    const base = bar === 'parents' ? parentY + BAR_BELOW_PARENTS : BAR_BELOW_PERSON;
    // Each line down where it would like to be, unless that is next to another family's lines down (to their
    // children, or from their dot), which would read as one line: then the nearest place in its range clear of them.
    const chosen = [];
    for (const entry of hanging) {
      const others = hanging.filter(other => other !== entry).flatMap(other => other.children.map(id => at(id).x));
      entry.x = clearOf(entry.range, entry.x, [...others, ...chosen]);
      chosen.push(entry.x);
      entry.anchor = entry.partners.length === 2
        ? couple(entry.partners, entry.x, entry.y, entry.color)
        : joint(entry.x, entry.y);
    }
    for (const entry of hanging) {
      entry.childXs = entry.children.map(id => at(id).x);
      entry.min = Math.min(entry.x, ...entry.childXs);
      entry.max = Math.max(entry.x, ...entry.childXs);
    }
    assignLevels(hanging).forEach((level, i) => {
      hanging[i].barY = base + level * LEVEL;
    });
    for (const entry of hanging) {
      const top = joint(entry.x, entry.barY);
      line(entry.anchor, top, entry.color);
      const stops = [...new Set(entry.children.map(id => at(id).x))].filter(stop => stop !== entry.x);
      const points = [{ x: entry.x, id: top }, ...stops.map(stop => ({ x: stop, id: joint(stop, entry.barY) }))]
        .sort((a, b) => a.x - b.x);
      for (let i = 1; i < points.length; i++) line(points[i - 1].id, points[i].id, entry.color);
      for (const id of entry.children) {
        const point = points.find(item => item.x === at(id).x);
        line(point.id, joint(at(id).x, at(id).y), entry.color);
        out.links.push({ id: `link-${nextId++}`, source: entry.anchor, target: id, turn: entry.barY - entry.y, color: entry.color });
      }
    }
  }

  out.people = [...placed].map(([id, position]) => ({ id, ...position }));
  return out;
}

/**
 * The x in `range` nearest `preferred` at least CLEAR from every x in `avoid`; if there is none, the one in range
 * farthest from its nearest.
 */
function clearOf([lo, hi], preferred, avoid) {
  const distance = (x) => Math.min(Infinity, ...avoid.map(other => Math.abs(other - x)));
  const start = Math.min(Math.max(preferred, lo), hi);
  if (distance(start) >= CLEAR) return start;
  const candidates = [lo, hi, ...avoid.flatMap(other => [other - CLEAR, other + CLEAR])].filter(x => x >= lo && x <= hi);
  const clear = candidates.filter(x => distance(x) >= CLEAR);
  if (clear.length) return clear.reduce((best, x) => (Math.abs(x - start) < Math.abs(best - start) ? x : best));
  return [start, ...candidates].reduce((best, x) => (distance(x) > distance(best) ? x : best));
}

/**
 * The level of each family's bar (0 nearest the row above, each next one LEVEL lower), so that no line crosses
 * another: a family's bar goes below another's when it reaches across that family's line down from its dot, or
 * when the other's bar reaches across one of its children (the line down to that child would cross it); bars
 * that would overlap go at different levels. Families are `{ x, min, max, children xs }`. → [level]
 */
function assignLevels(families) {
  const inside = (x, entry) => x > entry.min + 0.5 && x < entry.max - 0.5;
  // a below b: a's bar reaches across b's line down, or b's bar reaches across the line down to one of a's children.
  const below = (a, b) => inside(b.x, a) || a.childXs.some(x => inside(x, b));
  const levels = families.map(() => 0);
  const limit = families.length;
  for (let pass = 0; pass <= limit * limit; pass++) {
    let changed = false;
    families.forEach((a, i) => families.forEach((b, j) => {
      if (i === j) return;
      const need = below(a, b) ? levels[j] + 1 : null;
      if (need !== null && levels[i] < need && need <= limit) { levels[i] = need; changed = true; }
      // Bars that overlap at the same level: the one starting further right goes lower.
      const overlap = a.min <= b.max + GAP && b.min <= a.max + GAP;
      if (overlap && levels[i] === levels[j] && (a.min > b.min || (a.min === b.min && i > j)) && levels[i] < limit) {
        levels[i] += 1;
        changed = true;
      }
    }));
    if (!changed) break;
  }
  return levels;
}

/**
 * Places groups of children (each `{ x: the point they hang from, ids }`) in a row, left to right in the order of
 * their points: each centred under its point where there is room, else pushed apart as little as possible.
 * → `[{ ids, xs }]`
 */
function placeGroups(groups, width) {
  const widthOf = (count) => count * width + (count - 1) * GAP;
  const blocks = [];
  for (const group of [...groups].sort((a, b) => a.x - b.x)) {
    blocks.push({ groups: [group] });
    for (;;) {
      const block = blocks[blocks.length - 1];
      // The block's left edge that best centres each group under its point (least squares).
      let offset = 0;
      const wanted = block.groups.map(item => {
        const own = widthOf(item.ids.length);
        const value = item.x - own / 2 - offset;
        offset += own + GROUP_GAP;
        return value;
      });
      block.left = wanted.reduce((sum, value) => sum + value, 0) / wanted.length;
      block.width = offset - GROUP_GAP;
      const previous = blocks[blocks.length - 2];
      if (!previous || previous.left + previous.width + GROUP_GAP <= block.left) break;
      previous.groups.push(...block.groups);
      blocks.pop();
    }
  }
  return blocks.flatMap(block => {
    let left = block.left;
    return block.groups.map(item => {
      const xs = item.ids.map((_, i) => left + width / 2 + i * (width + GAP));
      left += widthOf(item.ids.length) + GROUP_GAP;
      return { ids: item.ids, xs };
    });
  });
}
