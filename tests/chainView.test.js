import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The real Cytoscape, headless (jsdom can't draw): the chain's elements and styles, as familyTreeLayout.test.js does.
vi.mock('cytoscape', async (importOriginal) => {
  const { default: cytoscape } = await importOriginal();
  const headless = (options) => cytoscape({ ...options, container: undefined, headless: true, styleEnabled: true });
  headless.use = (extension) => cytoscape.use(extension);
  return { default: headless };
});

const { ChainView } = await import('../src/chainView.js');
const { layoutChain } = await import('../src/chainLayout.js');

const person = (id, step, extra = {}) => ({ id, name: `Person ${id}`, sex: 'M', birthDate: null, avatarKey: null, step, ...extra });
const COUSIN = [person('R', null), person('F', 'parent', { birthDate: '1 JAN 1900' }), person('U', 'sibling'), person('C', 'child')];

let view;
let onPersonSelect;

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  document.body.innerHTML = '<div id="chain"></div>';
  onPersonSelect = vi.fn();
  view = new ChainView(document.getElementById('chain'), { onPersonSelect });
});

afterEach(() => {
  view.destroy();
  vi.restoreAllMocks();
});

describe('ChainView', () => {
  it('draws the people where the layout says, the person found larger, with their name and year', () => {
    view.show(COUSIN);
    const layout = layoutChain(COUSIN);
    for (const { id, x, y } of layout.people) expect(view.cy.getElementById(id).position(), id).toEqual({ x, y });
    expect(view.cy.getElementById('C').data('type')).toBe('selected');
    for (const id of ['R', 'F', 'U']) expect(view.cy.getElementById(id).data('type')).toBe('family');
    expect(view.cy.getElementById('F').data('label')).toBe('Person F\nb. 1900');
    expect(view.cy.nodes().filter(node => node.data('type') === 'joint')).toHaveLength(1); // the bracket's middle
  });

  it('draws a line down from a parent, and brothers and sisters joined by a rounded bracket', () => {
    view.show(COUSIN);
    const descent = view.cy.edges('[type="descent"]');
    expect(descent.map(edge => [edge.source().id(), edge.target().id()])).toEqual([['F', 'R'], ['U', 'C']]);
    expect(descent[0].style('curve-style')).toBe('straight'); // in line: straight down
    const bracket = view.cy.edges('[type="siblings"]');
    expect(bracket.map(edge => edge.target().id())).toEqual(['F', 'U']);
    expect(bracket[0].style('curve-style')).toBe('round-taxi');
    expect(bracket[0].style('taxi-direction')).toBe('horizontal');
    expect(bracket[0].style('line-style')).toBe('solid');
  });

  it('dashes the bracket of half brothers and sisters, and joins partners with a dot', () => {
    view.show([person('R', null), person('H', 'halfSibling'), person('W', 'spouse', { sex: 'F' })]);
    expect(view.cy.edges('[type="halfSiblings"]')[0].style('line-style')).toBe('dashed');
    expect(view.cy.nodes('[type="partnership"]')).toHaveLength(1);
    expect(view.cy.edges('[type="marriage"]').map(edge => edge.source().id())).toEqual(['H', 'W']);
  });

  it('draws someone again from scratch', () => {
    view.show(COUSIN);
    view.show([person('R', null)]);
    expect(view.cy.nodes().map(node => node.id())).toEqual(['R']);
    expect(view.cy.getElementById('R').data('type')).toBe('selected');
    view.clear();
    expect(view.cy.elements()).toHaveLength(0);
  });

  it('calls back with whoever is tapped, but not for a dot or a joint', () => {
    view.show([person('R', null), person('W', 'spouse')]);
    view.cy.getElementById('R').emit('tap');
    view.cy.getElementById('W').emit('tap');
    view.cy.nodes('[type="partnership"]').emit('tap');
    expect(onPersonSelect.mock.calls).toEqual([['R'], ['W']]);
  });
});
