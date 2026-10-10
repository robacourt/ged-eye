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
      elements: () => ({
        remove() { elements = []; },
        boundingBox: () => ({ x1: 0, y1: 0, w: 400, h: 400 }),
        // Only what the tree uses: all but the elements of one type, to lay out (recorded as `laidOut`).
        not(selector) {
          const type = /^\[type="(\w+)"\]$/.exec(selector)[1];
          const kept = elements.filter(element => element.data.type !== type);
          return { layout: () => ({ run() { cy.laidOut = kept; } }) };
        }
      }),
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

const { FamilyTreeView, placeBeside, horizontalPan } = await import('../src/familyTreeView.js');
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
  it('is not in the tree without a handler (viewers), and there is no button', async () => {
    await view.loadPerson('I7');
    expect(fake.cy.added().length).toBeGreaterThan(0);
    expect(fake.cy.laidOut).toEqual(fake.cy.added()); // the whole tree is laid out, as before
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

  it('is laid out apart: dagre lays out the tree without the node and its edge', async () => {
    view.setAddRelative(vi.fn());
    await view.loadPerson('I7');
    expect(addNode()).toBeDefined();
    expect(fake.cy.laidOut.some(element => element.data.type === 'add')).toBe(false);
    expect(fake.cy.laidOut).toEqual(fake.cy.added().filter(element => element.data.type !== 'add'));
    expect(fake.cy.laidOut.some(element => element.data.id === 'I7')).toBe(true);
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

describe('placeBeside', () => {
  // Rose at 0, 186 wide with her border; the "+" 114 wide; a relative either side of her in her row.
  const selected = { x: 0, y: 100, width: 186 };
  const row = [{ id: 'L', x: -250 }, { id: 'R', x: 250 }];
  const place = (spouseXs) => placeBeside({ selected, addWidth: 114, spouseXs, row });
  // 93 + 40 + 57 from her centre; the row on that side moves out by 114 + 40.

  it('puts the "+" on the right of someone without a spouse, moving the right of the row out', () => {
    expect(place([])).toEqual({ add: { x: 190, y: 100 }, moves: [{ id: 'R', x: 404 }] });
  });

  it('puts it on the left when the spouses are all on the right, so it isn\'t between the couple', () => {
    expect(place([250])).toEqual({ add: { x: -190, y: 100 }, moves: [{ id: 'L', x: -404 }] });
  });

  it('puts it on the right when a spouse is on the left', () => {
    expect(place([-250])).toEqual({ add: { x: 190, y: 100 }, moves: [{ id: 'R', x: 404 }] });
  });

  it('puts it on the right when there are spouses on both sides', () => {
    expect(place([-250, 250])).toEqual({ add: { x: 190, y: 100 }, moves: [{ id: 'R', x: 404 }] });
  });

  it('moves every node on that side of the row, and only those', () => {
    const wide = [{ id: 'L2', x: -500 }, { id: 'L1', x: -250 }, { id: 'R1', x: 250 }, { id: 'R2', x: 600 }];
    expect(placeBeside({ selected, addWidth: 114, spouseXs: [], row: wide }).moves)
      .toEqual([{ id: 'R1', x: 404 }, { id: 'R2', x: 754 }]);
    expect(placeBeside({ selected, addWidth: 114, spouseXs: [250], row: wide }).moves)
      .toEqual([{ id: 'L2', x: -654 }, { id: 'L1', x: -404 }]);
  });
});

describe('horizontalPan', () => {
  const wide = { x1: 0, w: 2000 }; // 1000px wide at zoom 0.5: wider than a 375px phone

  it('centres a tree that fits, wherever the "+" is', () => {
    const bb = { x1: -100, w: 400 };
    expect(horizontalPan({ bb, zoom: 0.5, width: 375, selectedX: 0, add: { x: -190, width: 114 } })).toBe(137.5);
    expect(horizontalPan({ bb, zoom: 0.5, width: 375, selectedX: 0 })).toBe(137.5);
  });

  it('keeps the selected person 100px from the left of a wider tree, for viewers and a "+" on the right', () => {
    expect(horizontalPan({ bb: wide, zoom: 0.5, width: 375, selectedX: 400 })).toBe(-100);
    expect(horizontalPan({ bb: wide, zoom: 0.5, width: 375, selectedX: 400, add: { x: 590, width: 114 } })).toBe(-100);
  });

  it('moves the tree right so a "+" on the left keeps its button 16px in', () => {
    // At pan -100 the "+" (centre 210) would start at 105 - 100 - 28.5 = -23.5px: 39.5px more.
    expect(horizontalPan({ bb: wide, zoom: 0.5, width: 375, selectedX: 400, add: { x: 210, width: 114 } })).toBe(-60.5);
  });

  it('leaves a "+" on the left alone when it is already far enough in, counting the 44px button', () => {
    // zoom 0.2: pan 20; the button is 44px (the node only 22.8), so it starts at 42 + 20 - 22 = 40px.
    expect(horizontalPan({ bb: wide, zoom: 0.2, width: 375, selectedX: 400, add: { x: 210, width: 114 } })).toBe(20);
  });
});
