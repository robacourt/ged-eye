import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// jsdom can't draw, so Cytoscape is a stub: it keeps the elements it was given and the listeners it was handed,
// and says where the add node is drawn (`fake.rendered`, which the tests move).
const fake = vi.hoisted(() => ({ cy: null, rendered: { x: 0, y: 0, size: 0 } }));

vi.mock('cytoscape', () => {
  function cytoscape(options) {
    let elements = [];
    const listeners = new Map(); // event name -> handlers
    const cy = {
      options,
      listeners,
      added: () => elements,
      on(events, selectorOrHandler, handler) {
        for (const name of events.split(' ')) listeners.set(name, [...(listeners.get(name) ?? []), handler ?? selectorOrHandler]);
      },
      off(events, handler) {
        for (const name of events.split(' ')) listeners.set(name, (listeners.get(name) ?? []).filter(h => h !== handler));
      },
      emit(name, event = {}) {
        for (const handler of listeners.get(name) ?? []) handler(event);
      },
      add(added) { elements = added; },
      elements: () => ({ remove() { elements = []; }, boundingBox: () => ({ x1: 0, y1: 0, w: 400, h: 400 }) }),
      layout(layoutOptions) {
        cy.layoutOptions = layoutOptions;
        return { run() {} };
      },
      nodes: () => ({ length: 0, forEach() {} }),
      width: () => 800,
      height: () => 500,
      viewport() {},
      getElementById(id) {
        const present = elements.some(element => element.data.id === id);
        return {
          empty: () => !present,
          renderedPosition: () => ({ x: fake.rendered.x, y: fake.rendered.y }),
          renderedOuterWidth: () => fake.rendered.size,
          renderedOuterHeight: () => fake.rendered.size
        };
      }
    };
    fake.cy = cy;
    return cy;
  }
  cytoscape.use = () => {};
  return { default: cytoscape };
});
vi.mock('cytoscape-dagre', () => ({ default: () => {} }));
vi.mock('../src/dataLoader.js', () => ({ loadPersonWithFamily: vi.fn(), prefetchFamily: vi.fn() }));

const { FamilyTreeView } = await import('../src/familyTreeView.js');
const { loadPersonWithFamily } = await import('../src/dataLoader.js');

const XSS = '<img src=x onerror="window.__xss = 1">';
const RELS = { parents: [], spouses: [], children: [], siblings: [] };
const person = (id, name, extra = {}) => ({ id, name, sex: 'F', parentIds: [], spouseIds: [], parentFamilies: [], marriages: [], ...extra });

let people;
let container;
let view;

const addNode = () => fake.cy.added().find(element => element.data.id === 'add-relative');
const addEdge = () => fake.cy.added().find(element => element.group === 'edges' && element.data.type === 'add');
const button = () => container.querySelector('.tree-add-relative');
/** Cytoscape's tap on a node with this data. */
const tapNode = (data) => fake.cy.emit('tap', { target: { data: (key) => data[key] } });
const viewportListeners = () => ['pan', 'zoom', 'resize'].map(name => (fake.cy.listeners.get(name) ?? []).length);

beforeEach(() => {
  document.body.innerHTML = '<div id="cy"></div><div id="details"></div>';
  container = document.getElementById('cy');
  people = new Map([
    ['I7', person('I7', 'Rose Smith', { parentIds: ['I1'] })],
    ['I8', person('I8', 'Jack Smith')],
    ['I1', person('I1', 'Ada Smith')]
  ]);
  loadPersonWithFamily.mockImplementation(async (id) => ({
    person: people.get(id),
    family: id === 'I7' ? [people.get('I1')] : [],
    relationships: id === 'I7' ? { ...RELS, parents: [people.get('I1')] } : RELS
  }));
  fake.rendered = { x: 200, y: 300, size: 60 };
  view = new FamilyTreeView(container);
});

afterEach(() => {
  delete window.__xss;
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('FamilyTreeView: the add node', () => {
  it('is not in the tree without a handler, and there is no button', async () => {
    await view.loadPerson('I7');
    expect(fake.cy.added().length).toBeGreaterThan(0);
    expect(addNode()).toBeUndefined();
    expect(addEdge()).toBeUndefined();
    expect(button()).toBeNull();
    view.setAddRelative(null);
    expect(addNode()).toBeUndefined();
    expect(button()).toBeNull();
  });

  it('is in the tree with a handler: a node, and an edge from the person to it', async () => {
    view.setAddRelative(vi.fn());
    await view.loadPerson('I7');
    expect(addNode()).toEqual({ group: 'nodes', data: expect.objectContaining({ id: 'add-relative', type: 'add' }) });
    expect(addEdge()).toEqual({ group: 'edges', data: expect.objectContaining({ source: 'I7', target: 'add-relative', type: 'add' }) });
  });

  it('appears and goes with the handler on the person already shown', async () => {
    await view.loadPerson('I7');
    view.setAddRelative(vi.fn());
    expect(addNode()).toBeDefined();
    expect(addEdge().data.source).toBe('I7');
    expect(fake.cy.added().some(element => element.data.id === 'I1')).toBe(true); // the rest of the tree is still there
    view.setAddRelative(null);
    expect(addNode()).toBeUndefined();
    expect(addEdge()).toBeUndefined();
    expect(fake.cy.added().some(element => element.data.id === 'I7')).toBe(true);
  });

  it('follows the highlighted person', async () => {
    view.setAddRelative(vi.fn());
    await view.loadPerson('I7');
    await view.loadPerson('I8');
    expect(addEdge().data.source).toBe('I8');
    expect(fake.cy.added().filter(element => element.data.id === 'add-relative')).toHaveLength(1);
  });

  it('goes two ranks down, into the children\'s row, when the person has a partnership row below them', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {}); // buildGraph logs the partnerships it makes
    people.set('I9', person('I9', 'Tom Brown'));
    people.set('I7', person('I7', 'Rose Smith', { spouseIds: ['I9'] }));
    loadPersonWithFamily.mockImplementation(async (id) => ({
      person: people.get(id), family: id === 'I7' ? [people.get('I9')] : [], relationships: RELS
    }));
    view.setAddRelative(vi.fn());
    await view.loadPerson('I7');
    expect(fake.cy.added().some(element => element.data.type === 'partnership')).toBe(true);
    expect(addEdge().data.minLen).toBe(2);

    // A partnership made from a child's parents, though the partner isn't among the person's spouses.
    people.set('I10', person('I10', 'Amy Smith', { parentIds: ['I8', 'I12'] }));
    people.set('I12', person('I12', 'Ann Jones'));
    loadPersonWithFamily.mockImplementation(async (id) => ({
      person: people.get(id),
      family: id === 'I8' ? [people.get('I10'), people.get('I12')] : [],
      relationships: id === 'I8' ? { ...RELS, children: [people.get('I10')] } : RELS
    }));
    await view.loadPerson('I8');
    expect(addEdge().data.minLen).toBe(2);
  });

  it('stays in the next rank for a person without a partnership row: no spouse, or one not in the tree', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    view.setAddRelative(vi.fn());
    await view.loadPerson('I7'); // parents above (their partnership is above her), no spouse
    expect(addEdge().data).not.toHaveProperty('minLen');
    people.set('I8', person('I8', 'Jack Smith', { spouseIds: ['I99'] })); // spouse not loaded, no children
    await view.loadPerson('I8');
    expect(fake.cy.added().some(element => element.data.type === 'partnership')).toBe(false);
    expect(addEdge().data).not.toHaveProperty('minLen');
  });

  it('passes each edge\'s minLen to dagre, 1 by default', async () => {
    await view.loadPerson('I7');
    const { name, minLen } = fake.cy.layoutOptions;
    expect(name).toBe('dagre');
    const edge = (data) => ({ data: (key) => data[key] });
    expect(minLen(edge({ minLen: 2 }))).toBe(2);
    expect(minLen(edge({}))).toBe(1);
  });

  it('is never selected: taps on it do nothing, as on partnership nodes', async () => {
    const onSelect = vi.fn();
    view.onPersonSelect(onSelect);
    view.setAddRelative(vi.fn());
    await view.loadPerson('I7');
    tapNode({ id: 'add-relative', type: 'add' });
    tapNode({ id: 'partnership-I1-I2', type: 'partnership' });
    expect(onSelect).not.toHaveBeenCalled();
    tapNode({ id: 'I1', type: 'family' });
    expect(onSelect).toHaveBeenCalledWith('I1');
    expect(loadPersonWithFamily).toHaveBeenCalledTimes(1);
  });
});

describe('FamilyTreeView: the add button', () => {
  it('is a labelled menu button inside the tree', async () => {
    view.setAddRelative(vi.fn());
    await view.loadPerson('I7');
    const add = button();
    expect(add.tagName).toBe('BUTTON');
    expect(add.type).toBe('button');
    expect(container.contains(add)).toBe(true);
    expect(add.getAttribute('aria-label')).toBe('Add a relative to Rose Smith');
    expect(add.getAttribute('aria-haspopup')).toBe('menu');
    expect(add.getAttribute('aria-expanded')).toBe('false');
    expect(add.hidden).toBe(false);
    await view.loadPerson('I8');
    expect(button()).toBe(add);
    expect(add.getAttribute('aria-label')).toBe('Add a relative to Jack Smith');
  });

  it('says the name as text, and names an unnamed person', async () => {
    people.set('I8', person('I8', XSS));
    view.setAddRelative(vi.fn());
    await view.loadPerson('I8');
    expect(button().getAttribute('aria-label')).toBe(`Add a relative to ${XSS}`);
    expect(container.querySelector('img')).toBeNull();
    people.set('I8', person('I8', ''));
    await view.loadPerson('I8');
    expect(button().getAttribute('aria-label')).toBe('Add a relative to Unnamed person');
  });

  it('calls the handler with itself and the person shown, without selecting anyone', async () => {
    const onSelect = vi.fn();
    const handler = vi.fn();
    view.onPersonSelect(onSelect);
    view.setAddRelative(handler);
    await view.loadPerson('I7');
    button().click();
    expect(handler).toHaveBeenCalledWith({ anchor: button(), person: people.get('I7') });
    await view.loadPerson('I8');
    button().click();
    expect(handler).toHaveBeenLastCalledWith({ anchor: button(), person: people.get('I8') });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('keeps its presses from the canvas, which would otherwise take them for a tap or a pan', async () => {
    view.setAddRelative(vi.fn());
    await view.loadPerson('I7');
    const canvasSaw = vi.fn();
    for (const type of ['pointerdown', 'mousedown', 'touchstart']) container.addEventListener(type, canvasSaw);
    for (const type of ['pointerdown', 'mousedown', 'touchstart']) button().dispatchEvent(new Event(type, { bubbles: true }));
    expect(canvasSaw).not.toHaveBeenCalled();
  });

  it('sits over the node, at least 44px square, and follows it on pan, zoom and resize', async () => {
    view.setAddRelative(vi.fn());
    await view.loadPerson('I7');
    const style = () => { const { left, top, width, height } = button().style; return { left, top, width, height }; };
    expect(style()).toEqual({ left: '170px', top: '270px', width: '60px', height: '60px' });

    fake.rendered = { x: 120, y: 90, size: 20 }; // zoomed out: the node is small, the button isn't
    fake.cy.emit('zoom');
    expect(style()).toEqual({ left: '98px', top: '68px', width: '44px', height: '44px' });

    fake.rendered = { x: 400, y: 250, size: 50 };
    fake.cy.emit('pan');
    expect(style()).toEqual({ left: '375px', top: '225px', width: '50px', height: '50px' });

    fake.rendered = { x: 300, y: 150, size: 50 };
    fake.cy.emit('resize');
    expect(style().left).toBe('275px');
  });

  it('is placed after each layout', async () => {
    view.setAddRelative(vi.fn());
    await view.loadPerson('I7');
    fake.rendered = { x: 50, y: 60, size: 80 };
    await view.loadPerson('I8');
    expect(button().style.left).toBe('10px');
    expect(button().style.top).toBe('20px');
  });

  it('hides while the node is panned out of the tree', async () => {
    view.setAddRelative(vi.fn());
    await view.loadPerson('I7');
    fake.rendered = { x: 200, y: 900, size: 60 }; // the tree is 500px high
    fake.cy.emit('pan');
    expect(button().hidden).toBe(true);
    fake.rendered = { x: 200, y: 520, size: 60 }; // partly in view
    fake.cy.emit('pan');
    expect(button().hidden).toBe(false);
  });

  it('is removed, with its listeners, when the handler is cleared', async () => {
    view.setAddRelative(vi.fn());
    await view.loadPerson('I7');
    expect(viewportListeners()).toEqual([1, 1, 1]);
    view.setAddRelative(null);
    expect(button()).toBeNull();
    expect(viewportListeners()).toEqual([0, 0, 0]);
    fake.cy.emit('pan'); // nothing left to move
    view.setAddRelative(vi.fn());
    expect(container.querySelectorAll('.tree-add-relative')).toHaveLength(1);
    expect(viewportListeners()).toEqual([1, 1, 1]);
  });

  it('keeps one button, and the tree as it is, when one handler replaces another', async () => {
    view.setAddRelative(vi.fn());
    await view.loadPerson('I7');
    const added = fake.cy.added();
    const second = vi.fn();
    view.setAddRelative(second);
    expect(fake.cy.added()).toBe(added); // not rebuilt
    expect(container.querySelectorAll('.tree-add-relative')).toHaveLength(1);
    button().click();
    expect(second).toHaveBeenCalled();
  });

  it('closes the menu it opened when the tree is rebuilt or the handler cleared, and on a second press', async () => {
    const menus = [];
    const handler = vi.fn(() => {
      const menu = { open: true, close: vi.fn(() => { menu.open = false; }), isOpen: () => menu.open };
      menus.push(menu);
      return menu;
    });
    view.setAddRelative(handler);
    await view.loadPerson('I7');

    button().click();
    await view.loadPerson('I8');
    expect(menus[0].close).toHaveBeenCalled();

    button().click();
    button().click(); // the second press closes it rather than opening another
    expect(handler).toHaveBeenCalledTimes(2);
    expect(menus[1].close).toHaveBeenCalled();

    button().click();
    view.setAddRelative(null);
    expect(menus[2].close).toHaveBeenCalled();
  });
});
