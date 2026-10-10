import { describe, it, expect } from 'vitest';
import { placeBeside, horizontalPan, chooseZoom } from '../src/treePlacement.js';

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

describe('chooseZoom', () => {
  // A phone's tree: 375 by 541, 20px margins. A tree 1000 high fits the height at (541 - 40) / 1000 = 0.501.
  const phone = { width: 375, height: 541, margin: 20, maxZoom: 1 };
  const zoomFor = (w, hasAdd) => chooseZoom({ ...phone, bb: { w, h: 1000 }, hasAdd });

  it('leaves a tree that fits the width at the height-fitting zoom', () => {
    expect(zoomFor(300, true)).toBeCloseTo(0.501);
  });

  it('zooms an editor\'s slightly wide tree out to fit the width, inside the margins', () => {
    const zoom = zoomFor(800, true);
    expect(zoom).toBeCloseTo((375 - 40) / 800); // 0.419, above the floor of 0.376
    expect(800 * zoom).toBeLessThanOrEqual(375);
  });

  it('measures "fits" inside the margins too, so the zoom changes smoothly at the boundary', () => {
    // 335px is the room inside the margins: 668 fits at 0.501 (334.7px), 670 needs 0.5 (335px).
    expect(zoomFor(668, true)).toBeCloseTo(0.501);
    expect(zoomFor(670, true)).toBeCloseTo(0.5);
    // A tree that would draw 370px wide no longer stays at 370 while one at 380 drops to 335.
    expect(zoomFor(370 / 0.501, true) * (370 / 0.501)).toBeCloseTo(335);
    let last = { zoom: Infinity, drawn: 0 };
    for (let w = 600; w <= 1500; w += 5) {
      const zoom = zoomFor(w, true);
      expect(zoom).toBeLessThanOrEqual(last.zoom + 1e-12); // never zooms in as the tree widens
      expect(w * zoom).toBeGreaterThanOrEqual(last.drawn - 1e-9); // and is never drawn narrower
      last = { zoom, drawn: w * zoom };
    }
  });

  it('stops at 75% of the height-fitting zoom for a very wide tree, which stays wider than the screen', () => {
    const zoom = zoomFor(2000, true);
    expect(zoom).toBeCloseTo(0.75 * 0.501);
    expect(2000 * zoom).toBeGreaterThan(375);
  });

  it('never zooms in past the height-fitting zoom or the maximum', () => {
    expect(chooseZoom({ ...phone, bb: { w: 500, h: 300 }, hasAdd: true })).toBeCloseTo(0.75); // 1 (capped), then 0.75
    expect(chooseZoom({ ...phone, bb: { w: 200, h: 300 }, hasAdd: true })).toBe(1);
  });

  it('leaves viewers (no "+" node) at the height-fitting zoom, however wide', () => {
    expect(zoomFor(800, false)).toBeCloseTo(0.501);
    expect(zoomFor(2000, false)).toBeCloseTo(0.501);
    expect(chooseZoom({ ...phone, bb: { w: 500, h: 300 }, hasAdd: false })).toBe(1);
  });
});
