import { describe, it, expect } from 'vitest';
import { toFractions, fromFractions, defaultCrop, zoomLimits, sliderValue, sliderRatio } from '../src/avatarCropper.js';

/** Whether every value of `actual` is within `tolerance` of the same key in `expected`. */
function expectClose(actual, expected, tolerance) {
  expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
  for (const key of Object.keys(expected)) expect(Math.abs(actual[key] - expected[key])).toBeLessThanOrEqual(tolerance);
}

const decimals = (n) => (String(n).split('.')[1] ?? '').length;

describe('toFractions', () => {
  it("turns Cropper's crop in pixels of the loaded image into fractions of its size", () => {
    expect(toFractions({ x: 400, y: 150, width: 1000, height: 1000 }, 2000, 1500))
      .toEqual({ x: 0.2, y: 0.1, w: 0.5, h: 0.6667 });
  });

  it('rounds every fraction to 4 decimal places', () => {
    const crop = toFractions({ x: 333, y: 77, width: 777, height: 777 }, 1999, 1333);
    for (const value of Object.values(crop)) expect(decimals(value)).toBeLessThanOrEqual(4);
    expect(crop).toEqual({ x: 0.1666, y: 0.0578, w: 0.3887, h: 0.5829 });
  });

  it("keeps the crop square: a side made a pixel longer by Cropper's rounding takes the shorter", () => {
    expect(toFractions({ x: 10, y: 20, width: 101, height: 100 }, 1000, 500)).toEqual({ x: 0.01, y: 0.04, w: 0.1, h: 0.2 });
    expect(toFractions({ x: 10, y: 20, width: 100, height: 101 }, 1000, 500)).toEqual({ x: 0.01, y: 0.04, w: 0.1, h: 0.2 });
  });

  it('is square in pixels of the original, to within the server’s 1%, for a small crop of a large photo', () => {
    // The display image (2000 x 1333) of a 6000 x 4000 original, cropped to 32 display pixels.
    const crop = toFractions({ x: 1234, y: 567, width: 32, height: 32 }, 2000, 1333);
    const across = crop.w * 6000;
    const down = crop.h * 4000;
    expect(Math.abs(across - down)).toBeLessThanOrEqual(0.01 * Math.max(across, down));
  });

  it('never goes past the right or bottom edge by more than rounding', () => {
    const crop = toFractions({ x: 1001, y: 0, width: 999, height: 999 }, 2000, 999);
    expect(crop.x + crop.w).toBeLessThanOrEqual(1.0001);
    expect(crop.y + crop.h).toBeLessThanOrEqual(1.0001);
  });

  it('turns -0 into 0, and clamps a crop starting a hair outside the image to the edge', () => {
    expect(toFractions({ x: -0, y: -0.4, width: 50, height: 50 }, 100, 100)).toEqual({ x: 0, y: 0, w: 0.5, h: 0.5 });
    expect(Object.is(toFractions({ x: -0, y: 0, width: 50, height: 50 }, 100, 100).x, 0)).toBe(true);
  });
});

describe('fromFractions', () => {
  it('turns fractions back into pixels of an image', () => {
    expect(fromFractions({ x: 0.2, y: 0.1, w: 0.5, h: 0.6 }, 2000, 1500)).toEqual({ x: 400, y: 150, width: 1000, height: 900 });
  });

  it('round-trips toFractions to within a pixel, at any size of the same photo', () => {
    const pixels = { x: 333, y: 77, width: 777, height: 777 };
    const crop = toFractions(pixels, 1999, 1333);
    expectClose(fromFractions(crop, 1999, 1333), pixels, 0.2);
    // The same crop of the original, three times the size of the display image.
    expectClose(fromFractions(crop, 5997, 3999), { x: 999, y: 231, width: 2331, height: 2331 }, 0.6);
  });
});

describe('defaultCrop', () => {
  it('is a centred square of 80% of the shorter side, as fractions: landscape', () => {
    expect(defaultCrop(2000, 1000)).toEqual({ x: 0.3, y: 0.1, w: 0.4, h: 0.8 });
  });

  it('is a centred square of 80% of the shorter side, as fractions: portrait and square', () => {
    expect(defaultCrop(1000, 2000)).toEqual({ x: 0.1, y: 0.3, w: 0.8, h: 0.4 });
    expect(defaultCrop(500, 500)).toEqual({ x: 0.1, y: 0.1, w: 0.8, h: 0.8 });
  });

  it('is square in pixels', () => {
    const crop = defaultCrop(1999, 1333);
    const { width, height } = fromFractions(crop, 1999, 1333);
    expect(Math.abs(width - height)).toBeLessThan(0.2);
  });
});

describe('zoomLimits', () => {
  it('zooms out until the photo just covers the circle, and in until the circle covers 32 pixels of it', () => {
    // A 300px circle over a 2000 x 1500 photo: its 1500px height must cover the circle.
    expect(zoomLimits({ width: 300, height: 300 }, 2000, 1500)).toEqual({ min: 0.2, max: 300 / 32 });
    expect(zoomLimits({ width: 300, height: 300 }, 1500, 2000)).toEqual({ min: 0.2, max: 300 / 32 });
  });

  it("never lets the most zoomed in be less than the least, for a photo under 32 pixels", () => {
    const { min, max } = zoomLimits({ width: 300, height: 300 }, 30, 20);
    expect(min).toBe(15);
    expect(max).toBe(15);
  });
});

describe('sliderValue and sliderRatio', () => {
  it('map the zoom ratio onto 0..100, evenly in steps of the same factor', () => {
    expect(sliderValue(0.2, 0.2, 20)).toBe(0);
    expect(sliderValue(20, 0.2, 20)).toBe(100);
    expect(sliderValue(2, 0.2, 20)).toBeCloseTo(50, 10);
    expect(sliderRatio(50, 0.2, 20)).toBeCloseTo(2, 10);
    expect(sliderRatio(0, 0.2, 20)).toBeCloseTo(0.2, 10);
    expect(sliderRatio(100, 0.2, 20)).toBeCloseTo(20, 10);
  });

  it('are inverses', () => {
    for (const value of [0, 12.5, 33, 99.9]) expect(sliderValue(sliderRatio(value, 0.15, 7), 0.15, 7)).toBeCloseTo(value, 10);
  });

  it('clamp to the ends, and sit at 0 when there is no room to zoom', () => {
    expect(sliderValue(0.1, 0.2, 20)).toBe(0);
    expect(sliderValue(30, 0.2, 20)).toBe(100);
    expect(sliderValue(5, 5, 5)).toBe(0);
    expect(sliderRatio(70, 5, 5)).toBe(5);
    expect(sliderRatio(-5, 0.2, 20)).toBeCloseTo(0.2, 10);
    expect(sliderRatio(150, 0.2, 20)).toBeCloseTo(20, 10);
  });
});
