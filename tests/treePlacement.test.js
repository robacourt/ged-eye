import { describe, it, expect } from 'vitest';
import { horizontalPan, chooseZoom, verticalPan } from '../src/treePlacement.js';

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
  // A phone's tree: 541 high, 20px margins. A frame 1000 high fits at (541 - 40) / 1000 = 0.501.
  const frame = { top: -400, bottom: 600 };

  it('fits the frame (a full tree) to the height, whoever is shown', () => {
    expect(chooseZoom({ frame, height: 541, margin: 20, maxZoom: 1 })).toBeCloseTo(0.501);
  });

  it('never zooms in past the maximum, on a tall screen', () => {
    expect(chooseZoom({ frame, height: 2000, margin: 20, maxZoom: 1 })).toBe(1);
  });
});

describe('verticalPan', () => {
  const frame = { top: -400, bottom: 600 };

  it('puts the top of the frame at the margin, so the person\'s row is always in the same place', () => {
    const zoom = 0.501;
    const pan = verticalPan({ frame, zoom, height: 541, margin: 20 });
    expect(pan + frame.top * zoom).toBeCloseTo(20);
    expect(pan).toBeCloseTo(20 + 400 * 0.501); // the person's row (y 0) is there
  });

  it('centres the frame when it is shorter than the room', () => {
    const pan = verticalPan({ frame, zoom: 1, height: 2000, margin: 20 });
    expect(pan + frame.top).toBeCloseTo(500); // (2000 - 1000) / 2
  });
});
