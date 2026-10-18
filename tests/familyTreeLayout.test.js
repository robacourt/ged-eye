import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The real Cytoscape, headless (jsdom can't draw): the tree's own style and buildGraph, with real positions and
// styles to check against treeLayout.js.
vi.mock('cytoscape', async (importOriginal) => {
  const { default: cytoscape } = await importOriginal();
  const headless = (options) => cytoscape({ ...options, container: undefined, headless: true, styleEnabled: true });
  headless.use = (extension) => cytoscape.use(extension);
  return { default: headless };
});
vi.mock('../src/dataLoader.js', () => ({ loadPersonWithFamily: vi.fn(), prefetchFamily: vi.fn() }));

const { FamilyTreeView } = await import('../src/familyTreeView.js');
const { layoutFamily } = await import('../src/treeLayout.js');

const relative = (id, name, extra = {}) => ({ id, name, sex: 'M', parentIds: [], ...extra });
const parents = [relative('I1', 'Ada Smith', { sex: 'F' }), relative('I2', 'Bob Smith')];
const rose = {
  ...relative('I7', 'Rose Smith', { sex: 'F', parentIds: ['I1', 'I2'] }),
  spouseIds: ['I9'],
  parentFamilies: [{ familyId: 'F1', partnerIds: ['I1', 'I2'], childIds: ['I5', 'I7', 'I6'] }],
  marriages: [{ spouseId: 'I9', familyId: 'F2', childIds: ['I10'] }]
};
const tom = relative('I9', 'Tom Brown');
const siblings = [relative('I5', 'Amy Smith', { sex: 'F', parentIds: ['I1', 'I2'] }), relative('I6', 'Ben Smith', { parentIds: ['I1', 'I2'] })];
const child = relative('I10', 'Kit Brown', { parentIds: ['I7', 'I9'] });
const family = [...parents, tom, child, ...siblings];
const relationships = { parents, spouses: [tom], children: [child], siblings };

let view;

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {}); // Cytoscape's style warnings (cursor)
  document.body.innerHTML = '<div id="cy"></div>';
  view = new FamilyTreeView(document.getElementById('cy'));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('FamilyTreeView drawing (treeLayout.js)', () => {
  it('puts everyone, every dot and every line end where the layout says', () => {
    view.buildGraph(rose, family, relationships);
    const layout = layoutFamily({ selected: rose, family, relationships });
    for (const { id, x, y } of [...layout.people, ...layout.dots, ...layout.joints]) {
      expect(view.cy.getElementById(id).position(), id).toEqual({ x, y });
    }
    expect(view.cy.edges().map(edge => [edge.source().id(), edge.target().id()]))
      .toEqual(layout.lines.map(line => [line.source, line.target]));
  });

  it('draws straight lines in their family\'s colour, without arrows, under the people; line ends are invisible', () => {
    view.buildGraph(rose, family, relationships);
    const edge = view.cy.edges()[0];
    expect(edge.style('curve-style')).toBe('straight');
    expect(edge.style('target-arrow-shape')).toBe('none');
    expect(edge.style('line-color')).toMatch(/^rgb/);
    const joint = view.cy.nodes('[type="joint"]')[0];
    expect(Number(joint.style('opacity'))).toBe(0);
    expect(joint.style('events')).toBe('no');
    expect(view.cy.nodes('[type="partnership"]').length).toBe(2); // Rose's parents, and Rose and Tom
  });

  it('labels people with their name and birth year, and the highlighted person as selected', () => {
    view.buildGraph({ ...rose, birthDate: '3 MAR 1901' }, family, relationships);
    const node = view.cy.getElementById('I7');
    expect(node.data('type')).toBe('selected');
    expect(node.data('label')).toBe('Rose Smith\nb. 1901');
    expect(view.cy.getElementById('I9').data('type')).toBe('family');
  });

  describe('the "+" node', () => {
    it('goes on the left of someone with a partner, with the brothers and sisters on its left', () => {
      view.setAddRelative(vi.fn());
      view.buildGraph(rose, family, relationships);
      const add = view.cy.getElementById('add-relative').position();
      const at = (id) => view.cy.getElementById(id).position();
      expect(add.y).toBe(at('I7').y);
      expect(add.x).toBeLessThan(at('I7').x);
      expect(at('I9').x).toBeGreaterThan(at('I7').x);
      for (const id of ['I5', 'I6']) expect(at(id).x, id).toBeLessThan(add.x);
      const edge = view.cy.getElementById('add-relative-edge');
      expect([edge.source().id(), edge.target().id()]).toEqual(['I7', 'add-relative']);
    });

    it('goes on the right of someone without a partner', () => {
      const single = { ...rose, spouseIds: [], marriages: [] };
      view.setAddRelative(vi.fn());
      view.buildGraph(single, [...parents, ...siblings], { ...relationships, spouses: [], children: [] });
      expect(view.cy.getElementById('add-relative').position().x).toBeGreaterThan(view.cy.getElementById('I7').position().x);
    });
  });
});
