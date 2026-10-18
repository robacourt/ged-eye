import { describe, it, expect } from 'vitest';
import { layoutFamily, SIZES } from '../src/treeLayout.js';

// Records as the API sends them: the person's own (person_record) and their relatives' (relative_record).
const relative = (id, parentIds = []) => ({ id, name: id, sex: 'U', parentIds });

/**
 * A person's view from a compact description: `parents` (their parents' family), `siblings` (full ones),
 * `halves` ([{ shared, other, children }]), `spouses` ([{ id, children }]), `alone` (children with no partner).
 */
function view({ id = 'P', parents = [], siblings = [], halves = [], spouses = [], alone = [] } = {}) {
  const fullChildren = [id, ...siblings];
  const selected = {
    id, name: id, sex: 'U', parentIds: parents,
    parentFamilies: parents.length ? [{ familyId: 'F0', partnerIds: parents, childIds: fullChildren }] : [],
    marriages: [
      ...spouses.map((spouse, i) => ({ spouseId: spouse.id, familyId: `M${i}`, childIds: spouse.children ?? [] })),
      ...(alone.length ? [{ spouseId: null, familyId: 'M-alone', childIds: alone }] : [])
    ],
    spouseIds: spouses.map(spouse => spouse.id)
  };
  const parentRecords = parents.map(parent => relative(parent));
  const spouseRecords = spouses.map(spouse => relative(spouse.id));
  const childRecords = [
    ...spouses.flatMap(spouse => (spouse.children ?? []).map(child => relative(child, [id, spouse.id]))),
    ...alone.map(child => relative(child, [id]))
  ];
  const siblingRecords = [
    ...siblings.map(sibling => relative(sibling, parents)),
    ...halves.flatMap(half => half.children.map(child => relative(child, [half.shared, half.other].filter(Boolean))))
  ];
  const others = halves.filter(half => half.other).map(half => relative(half.other));
  const family = [...parentRecords, ...spouseRecords, ...childRecords, ...siblingRecords, ...others];
  return {
    selected,
    family,
    relationships: { parents: parentRecords, spouses: spouseRecords, children: childRecords, siblings: siblingRecords }
  };
}

const IAN = view({
  id: 'I122', parents: ['I120', 'I121'], siblings: ['I123'],
  spouses: [{ id: 'I124', children: ['I125', 'I126'] }, { id: 'I127', children: ['I128'] }]
});
const ELEANOR = view({
  id: 'I778', parents: ['I700', 'I701'], siblings: ['S1', 'S2'],
  spouses: [
    { id: 'W1', children: ['C1', 'C2', 'C3'] }, { id: 'W2', children: ['C4', 'C5', 'C6', 'C7', 'C8', 'C9'] },
    { id: 'W3', children: ['C10'] }, { id: 'W4', children: ['C11', 'C12'] }
  ]
});
const ELIZABETH = view({
  id: 'I70', parents: ['I23', 'I69'],
  halves: [{ shared: 'I23', other: 'I71', children: ['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7', 'H8'] }]
});
const BOTH_SIDES = view({
  id: 'P', parents: ['A', 'B'], siblings: ['S1', 'S2'],
  halves: [
    { shared: 'A', other: 'OA', children: ['HA1', 'HA2'] },
    { shared: 'B', other: 'OB', children: ['HB1', 'HB2', 'HB3'] },
    { shared: 'B', other: null, children: ['HB4'] }
  ],
  spouses: [{ id: 'W', children: ['K1', 'K2'] }],
  alone: ['K3']
});

/** Each line as { x1, y1, x2, y2 }, from the layout's ends (dots and joints). */
function segments(layout) {
  const points = new Map([...layout.dots, ...layout.joints].map(point => [point.id, point]));
  return layout.lines.map(({ id, source, target }) => {
    const a = points.get(source);
    const b = points.get(target);
    return { id, x1: a.x, y1: a.y, x2: b.x, y2: b.y };
  });
}

/** Pairs of lines that cross (not merely meet at an end, or touch end to side as a T). */
function crossings(layout) {
  const lines = segments(layout);
  const isH = (s) => Math.abs(s.y1 - s.y2) < 1e-6;
  const between = (v, a, b) => v > Math.min(a, b) + 1e-6 && v < Math.max(a, b) - 1e-6;
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const [h, v] = isH(lines[i]) && !isH(lines[j]) ? [lines[i], lines[j]] : !isH(lines[i]) && isH(lines[j]) ? [lines[j], lines[i]] : [];
      if (!h) continue;
      if (between(v.x1, h.x1, h.x2) && between(h.y1, v.y1, v.y2)) found.push([lines[i].id, lines[j].id]);
    }
  }
  return found;
}

/** Pairs of horizontal (or vertical) lines on the same line that overlap: one would hide the other. */
function overlaps(layout) {
  const lines = segments(layout);
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const a = lines[i];
      const b = lines[j];
      const sameRow = a.y1 === a.y2 && b.y1 === b.y2 && a.y1 === b.y1;
      const sameColumn = a.x1 === a.x2 && b.x1 === b.x2 && a.x1 === b.x1;
      const [a1, a2, b1, b2] = sameRow ? [a.x1, a.x2, b.x1, b.x2] : sameColumn ? [a.y1, a.y2, b.y1, b.y2] : [];
      if (a1 === undefined) continue;
      const overlap = Math.min(Math.max(a1, a2), Math.max(b1, b2)) - Math.max(Math.min(a1, a2), Math.min(b1, b2));
      if (overlap > 1e-6) found.push([a.id, b.id]);
    }
  }
  return found;
}

/** Whether `from` (a dot or joint) reaches the joint at `child`'s centre through the lines. */
function reaches(layout, from, child) {
  const at = layout.people.find(person => person.id === child);
  const targets = new Set(layout.joints.filter(point => point.x === at.x && point.y === at.y).map(point => point.id));
  const next = new Map();
  for (const { source, target: end } of layout.lines) {
    next.set(source, [...(next.get(source) ?? []), end]);
    next.set(end, [...(next.get(end) ?? []), source]);
  }
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length) {
    const id = queue.shift();
    if (targets.has(id)) return true;
    for (const other of next.get(id) ?? []) if (!seen.has(other)) { seen.add(other); queue.push(other); }
  }
  return false;
}

const positions = (layout) => Object.fromEntries(layout.people.map(({ id, x, y }) => [id, { x, y }]));

function expectTidy(layout, data, label) {
  const ids = layout.people.map(person => person.id);
  expect(new Set(ids).size, `${label}: each person once`).toBe(ids.length);
  expect(ids.sort(), `${label}: everyone placed`).toEqual([data.selected.id, ...data.family.map(member => member.id)].sort());
  for (const line of segments(layout)) {
    expect(line.x1 === line.x2 || line.y1 === line.y2, `${label}: ${line.id} is horizontal or vertical`).toBe(true);
  }
  expect(crossings(layout), `${label}: no crossings`).toEqual([]);
  expect(overlaps(layout), `${label}: no lines on top of each other`).toEqual([]);
  // No two people overlap: in a row, at least the narrower gap apart.
  const rows = new Map();
  for (const person of layout.people) rows.set(person.y, [...(rows.get(person.y) ?? []), person]);
  for (const row of rows.values()) {
    const sorted = [...row].sort((a, b) => a.x - b.x);
    for (let i = 1; i < sorted.length; i++) {
      const width = (id) => (id === data.selected.id ? SIZES.selected : SIZES.person);
      const room = width(sorted[i - 1].id) / 2 + width(sorted[i].id) / 2 + 40;
      expect(sorted[i].x - sorted[i - 1].x, `${label}: ${sorted[i - 1].id} and ${sorted[i].id} apart`).toBeGreaterThanOrEqual(room);
    }
  }
}

describe('layoutFamily', () => {
  it('puts the person at the origin, the parents over them and the children below', () => {
    const layout = layoutFamily(IAN);
    const at = positions(layout);
    expect(at.I122).toEqual({ x: 0, y: 0 });
    expect(at.I120.y).toBeLessThan(0);
    expect(at.I121.y).toBe(at.I120.y);
    expect((at.I120.x + at.I121.x) / 2).toBeCloseTo(0); // over the person
    for (const child of ['I125', 'I126', 'I128']) expect(at[child].y).toBeGreaterThan(0);
  });

  it('puts partners on the right in order, and brothers and sisters on the left', () => {
    const at = positions(layoutFamily(IAN));
    expect(at.I124.x).toBeGreaterThan(at.I122.x);
    expect(at.I127.x).toBeGreaterThan(at.I124.x);
    expect(at.I123.x).toBeLessThan(at.I122.x);
    expect(at.I124.y).toBe(0);
  });

  it("joins each couple with a dot between them, each later partner's line higher, and hangs their children from it", () => {
    const layout = layoutFamily(IAN);
    const at = positions(layout);
    const [first, second] = layout.dots.filter(dot => dot.y > -300);
    expect(first.x).toBeGreaterThan(at.I122.x + SIZES.selected / 2);
    expect(first.x).toBeLessThan(at.I124.x - SIZES.person / 2);
    expect(first.y).toBe(0);
    expect(second.x).toBeGreaterThan(at.I124.x + SIZES.person / 2);
    expect(second.x).toBeLessThan(at.I127.x - SIZES.person / 2);
    expect(second.y).toBeLessThan(first.y);
    expect(reaches(layout, first.id, 'I125')).toBe(true);
    expect(reaches(layout, first.id, 'I126')).toBe(true);
    expect(reaches(layout, second.id, 'I128')).toBe(true);
    expect(first.color).not.toBe(second.color);
    // The children of each couple sit under it, in order.
    expect(at.I125.x).toBeLessThan(at.I126.x);
    expect(at.I126.x).toBeLessThan(at.I128.x);
  });

  it('hangs the person and their brothers and sisters from their parents', () => {
    const layout = layoutFamily(IAN);
    const parentsDot = layout.dots.find(dot => dot.y < -300);
    expect(reaches(layout, parentsDot.id, 'I122')).toBe(true);
    expect(reaches(layout, parentsDot.id, 'I123')).toBe(true);
  });

  it("puts the parent with half brothers and sisters on the right, with their other partner beyond, over their children", () => {
    const layout = layoutFamily(ELIZABETH);
    const at = positions(layout);
    expect(at.I23.x).toBeGreaterThan(at.I69.x); // swapped to the right
    expect(at.I71.x).toBeGreaterThan(at.I23.x);
    const halves = ['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7', 'H8'];
    for (const id of halves) expect(at[id].x, id).toBeGreaterThan(at.I70.x);
    const dot = layout.dots.find(item => item.x > at.I23.x);
    expect(dot.x).toBeLessThan(at.I71.x);
    for (const id of halves) expect(reaches(layout, dot.id, id), id).toBe(true);
  });

  it('draws every case tidily: everyone once, straight lines, no crossings or overlaps', () => {
    for (const [label, data] of [['Ian', IAN], ['Eleanor', ELEANOR], ['Elizabeth', ELIZABETH], ['both sides', BOTH_SIDES]]) {
      expectTidy(layoutFamily(data), data, label);
      expectTidy(layoutFamily({ ...data, withAdd: true }), data, `${label} with +`);
    }
  });

  it('draws someone with no family at all', () => {
    const data = view({ id: 'P' });
    const layout = layoutFamily(data);
    expect(layout).toEqual({ people: [{ id: 'P', x: 0, y: 0 }], add: null, dots: [], joints: [], lines: [] });
  });

  it('hangs children with no partner here, and a lone parent\'s children, straight from that person', () => {
    const data = view({ id: 'P', parents: ['A'], siblings: ['S1'], alone: ['K1', 'K2'] });
    const layout = layoutFamily(data);
    const at = positions(layout);
    expect(at.A.x).toBe(0);
    const fromParent = layout.joints.find(point => point.x === at.A.x && point.y === at.A.y);
    const fromPerson = layout.joints.find(point => point.x === 0 && point.y === 0 && reaches(layout, point.id, 'K1'));
    expect(reaches(layout, fromParent.id, 'S1')).toBe(true);
    expect(reaches(layout, fromPerson.id, 'K2')).toBe(true);
    expectTidy(layout, data, 'lone parents');
  });

  describe('the "+" node', () => {
    it('goes on the left of someone with partners (who are all on their right), between them and their family', () => {
      const layout = layoutFamily({ ...IAN, withAdd: true });
      const at = positions(layout);
      expect(layout.add.y).toBe(0);
      expect(layout.add.x).toBeCloseTo(-(SIZES.selected / 2 + 40 + SIZES.add / 2));
      expect(at.I123.x).toBeLessThan(layout.add.x);
    });

    it('goes on the right of someone without partners, before the brothers and sisters after them', () => {
      const data = view({ id: 'P', parents: ['A', 'B'], siblings: ['S1'] });
      // The person is the first child, so S1 comes after them.
      const layout = layoutFamily({ ...data, withAdd: true });
      expect(layout.add.x).toBeCloseTo(SIZES.selected / 2 + 40 + SIZES.add / 2);
      expect(positions(layout).S1.x).toBeGreaterThan(layout.add.x);
    });

    it('is absent without withAdd', () => {
      expect(layoutFamily(IAN).add).toBeNull();
    });
  });

  it('keeps every random family tidy', () => {
    // A small deterministic generator, so a failure can be reproduced.
    let seed = 7;
    const random = (n) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let round = 0; round < 500; round++) {
      let next = 0;
      const id = () => `R${round}-${next++}`;
      const parents = [[], [id()], [id(), id()]][random(3)];
      const siblings = parents.length ? Array.from({ length: random(5) }, id) : [];
      const halves = parents.length
        ? Array.from({ length: random(3) }, () => ({
          shared: parents[random(parents.length)], other: random(4) ? id() : null,
          children: Array.from({ length: 1 + random(4) }, id)
        }))
        : [];
      const spouses = Array.from({ length: random(4) }, () => ({ id: id(), children: Array.from({ length: random(5) }, id) }));
      const alone = random(4) ? [] : Array.from({ length: 1 + random(2) }, id);
      const data = view({ id: `R${round}-P`, parents, siblings, halves, spouses, alone });
      expectTidy(layoutFamily({ ...data, withAdd: Boolean(random(2)) }), data, `round ${round}`);
    }
  });
});
