import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The real Cytoscape and dagre, headless (jsdom can't draw): the tree's own style, buildGraph, dagre layout and
// placement of the "+" node, with real positions to check.
vi.mock('cytoscape', async (importOriginal) => {
  const { default: cytoscape } = await importOriginal();
  const headless = (options) => cytoscape({ ...options, container: undefined, headless: true, styleEnabled: true });
  headless.use = (extension) => cytoscape.use(extension);
  return { default: headless };
});
vi.mock('../src/dataLoader.js', () => ({ loadPersonWithFamily: vi.fn(), prefetchFamily: vi.fn() }));

const { FamilyTreeView } = await import('../src/familyTreeView.js');

const person = (id, name, extra = {}) => ({ id, name, sex: 'M', parentIds: [], spouseIds: [], parentFamilies: [], marriages: [], ...extra });
const RELS = { parents: [], spouses: [], children: [], siblings: [] };

let view;

/** Lays out `selected` with `family` as a viewer, then as an editor: each node's position both times. */
function layOut(selected, family, relationships) {
  const positions = () => Object.fromEntries(view.cy.nodes().map(node => [node.id(), { ...node.position() }]));
  view.setAddRelative(null);
  view.buildGraph(selected, family, relationships);
  const viewer = positions();
  view.setAddRelative(vi.fn());
  const editor = positions();
  const addWidth = view.cy.getElementById('add-relative').outerWidth();
  const selectedWidth = view.cy.getElementById(selected.id).outerWidth();
  return { viewer, editor, addWidth, selectedWidth };
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {}); // buildGraph logs the partnerships it makes
  vi.spyOn(console, 'warn').mockImplementation(() => {}); // Cytoscape's style warnings (cursor, partnership avatars)
  document.body.innerHTML = '<div id="cy"></div>';
  view = new FamilyTreeView(document.getElementById('cy'));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('FamilyTreeView layout: the "+" node beside the person', () => {
  it('goes on the left of someone whose spouse is on the right, and nothing on the left moves', () => {
    const rose = person('I7', 'Rose Smith', { sex: 'F', spouseIds: ['I9'] });
    const tom = person('I9', 'Tom Brown', { spouseIds: ['I7'] });
    const { viewer, editor, addWidth, selectedWidth } = layOut(rose, [tom], { ...RELS, spouses: [tom] });

    expect(viewer.I9.x).toBeGreaterThan(viewer.I7.x); // dagre put her husband on her right
    const add = editor['add-relative'];
    expect(add.y).toBe(editor.I7.y);
    expect(add.x).toBeCloseTo(editor.I7.x - (selectedWidth / 2 + 40 + addWidth / 2));
    for (const [id, position] of Object.entries(viewer)) expect(editor[id], id).toEqual(position); // nothing moved
  });

  it('goes on the right of someone without a spouse, moving the siblings on that side out', () => {
    const parents = [person('I1', 'Ada Smith', { sex: 'F' }), person('I2', 'Bob Smith')];
    const family = { parentIds: ['I1', 'I2'] };
    const rose = person('I7', 'Rose Smith', { sex: 'F', ...family });
    const siblings = [person('I5', 'Amy Smith', { sex: 'F', ...family }), person('I6', 'Ben Smith', family),
      person('I8', 'Cat Smith', { sex: 'F', ...family })];
    const { viewer, editor, addWidth, selectedWidth } =
      layOut(rose, [...parents, ...siblings], { ...RELS, parents, siblings });

    const add = editor['add-relative'];
    expect(add.y).toBe(editor.I7.y);
    expect(add.x).toBeCloseTo(editor.I7.x + selectedWidth / 2 + 40 + addWidth / 2);
    const right = siblings.filter(sibling => viewer[sibling.id].x > viewer.I7.x);
    const left = siblings.filter(sibling => viewer[sibling.id].x < viewer.I7.x);
    expect(right.length).toBeGreaterThan(0);
    for (const { id } of right) expect(editor[id].x, id).toBeCloseTo(viewer[id].x + addWidth + 40);
    for (const { id } of left) expect(editor[id], id).toEqual(viewer[id]);
    for (const id of ['I1', 'I2', 'I7']) expect(editor[id], id).toEqual(viewer[id]); // other rows stay put
  });

  it('goes on the left of someone whose two spouses are both on the right', () => {
    const tom = person('I7', 'Tom Brown', { spouseIds: ['I8', 'I9'] });
    const wives = [person('I8', 'Ann Brown', { sex: 'F', spouseIds: ['I7'] }), person('I9', 'Eve Brown', { sex: 'F', spouseIds: ['I7'] })];
    const { viewer, editor, addWidth, selectedWidth } = layOut(tom, wives, { ...RELS, spouses: wives });

    for (const { id } of wives) expect(viewer[id].x, id).toBeGreaterThan(viewer.I7.x);
    expect(editor['add-relative'].x).toBeCloseTo(editor.I7.x - (selectedWidth / 2 + 40 + addWidth / 2));
    for (const [id, position] of Object.entries(viewer)) expect(editor[id], id).toEqual(position);
  });
});
