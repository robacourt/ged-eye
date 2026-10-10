// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { CropError, validateCrop, cropPixels, avatarKeyFor } from '../media/crop.js';

const GOOD = { x: 0.25, y: 0.1, w: 0.5, h: 0.5 };
const SHA = 'ab'.repeat(32);

/** The CropError thrown by `fn`, or undefined. */
function failure(fn) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(CropError);
    return e;
  }
  return undefined;
}

describe('media/crop CropError', () => {
  it('is an Error carrying the field', () => {
    const e = new CropError('crop.x', 'bad');
    expect(e).toBeInstanceOf(Error);
    expect(e.field).toBe('crop.x');
    expect(e.message).toBe('bad');
  });
});

describe('media/crop validateCrop', () => {
  it('returns the four fractions', () => {
    expect(validateCrop(GOOD)).toEqual(GOOD);
    expect(validateCrop({ x: 0, y: 0, w: 1, h: 1 })).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it('rounds to four decimal places and drops other keys', () => {
    expect(validateCrop({ x: 0.123456, y: 0.00004, w: 0.55555, h: 0.2, extra: 1 })).toEqual({ x: 0.1235, y: 0, w: 0.5556, h: 0.2 });
  });

  it('never returns a negative zero', () => {
    const c = validateCrop({ x: -0, y: -0.00004, w: 0.5, h: 0.5 });
    expect(Object.is(c.x, 0)).toBe(true);
    expect(Object.is(c.y, 0)).toBe(true);
  });

  it('accepts a tiny negative x or y that rounds to zero', () => {
    expect(validateCrop({ ...GOOD, x: -0.00004 }).x).toBe(0);
  });

  it('accepts a crop that touches the edge, to within 1.0001', () => {
    expect(validateCrop({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 })).toEqual({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
    expect(validateCrop({ x: 0.5001, y: 0, w: 0.5, h: 1.0001 })).toEqual({ x: 0.5001, y: 0, w: 0.5, h: 1.0001 });
  });

  it('refuses anything that is not an object', () => {
    for (const value of ['0.5,0.5,0.5,0.5', 7, null, undefined, true, [0.1, 0.1, 0.5, 0.5]]) {
      expect(failure(() => validateCrop(value))?.field).toBe('crop');
    }
  });

  it('refuses a missing key, naming it', () => {
    for (const key of ['x', 'y', 'w', 'h']) {
      const crop = { ...GOOD };
      delete crop[key];
      expect(failure(() => validateCrop(crop))?.field).toBe(`crop.${key}`);
    }
  });

  it('refuses NaN, Infinity and strings, naming the field', () => {
    for (const key of ['x', 'y', 'w', 'h']) {
      for (const bad of [NaN, Infinity, -Infinity, '0.5', null, undefined, {}]) {
        expect(failure(() => validateCrop({ ...GOOD, [key]: bad }))?.field).toBe(`crop.${key}`);
      }
    }
  });

  it('refuses a negative x or y', () => {
    expect(failure(() => validateCrop({ ...GOOD, x: -0.1 }))?.field).toBe('crop.x');
    expect(failure(() => validateCrop({ ...GOOD, y: -0.0001 }))?.field).toBe('crop.y');
  });

  it('refuses a zero or negative width or height', () => {
    expect(failure(() => validateCrop({ ...GOOD, w: 0 }))?.field).toBe('crop.w');
    expect(failure(() => validateCrop({ ...GOOD, h: 0 }))?.field).toBe('crop.h');
    expect(failure(() => validateCrop({ ...GOOD, w: -0.5 }))?.field).toBe('crop.w');
    expect(failure(() => validateCrop({ ...GOOD, h: -0.5 }))?.field).toBe('crop.h');
  });

  it('refuses a width or height that rounds to nothing', () => {
    expect(failure(() => validateCrop({ ...GOOD, w: 0.00004 }))?.field).toBe('crop.w');
    expect(failure(() => validateCrop({ ...GOOD, h: 0.00004 }))?.field).toBe('crop.h');
  });

  it('refuses a crop that overflows the image beyond 1.0001', () => {
    expect(failure(() => validateCrop({ ...GOOD, x: 0.6 }))?.field).toBe('crop.w');
    expect(failure(() => validateCrop({ ...GOOD, y: 0.6 }))?.field).toBe('crop.h');
    expect(failure(() => validateCrop({ x: 0, y: 0, w: 1.0002, h: 1 }))?.field).toBe('crop.w');
    expect(failure(() => validateCrop({ x: 0, y: 0, w: 1, h: 1.0002 }))?.field).toBe('crop.h');
  });

  it('names x or y when it alone is out of range', () => {
    expect(failure(() => validateCrop({ x: 2, y: 0, w: 0.1, h: 0.1 }))?.field).toBe('crop.x');
    expect(failure(() => validateCrop({ x: 0, y: 2, w: 0.1, h: 0.1 }))?.field).toBe('crop.y');
    expect(failure(() => validateCrop({ ...GOOD, x: 1.0002 }))?.field).toBe('crop.x');
  });

  it('copes with huge finite numbers, which overflow when rounded', () => {
    expect(failure(() => validateCrop({ ...GOOD, x: 1e305 }))?.field).toBe('crop.x');
    expect(failure(() => validateCrop({ ...GOOD, y: 1e305 }))?.field).toBe('crop.y');
    expect(failure(() => validateCrop({ ...GOOD, x: -1e305 }))?.field).toBe('crop.x');
    expect(failure(() => validateCrop({ ...GOOD, w: 1e305 }))?.field).toBe('crop.w');
    expect(failure(() => validateCrop({ ...GOOD, h: 1e305 }))?.field).toBe('crop.h');
    expect(failure(() => validateCrop({ ...GOOD, w: Number.MAX_VALUE }))?.field).toBe('crop.w');
    expect(failure(() => validateCrop({ ...GOOD, x: 1e300 }))?.field).toBe('crop.x');
  });

  it('gives each failure a readable message', () => {
    expect(failure(() => validateCrop({ ...GOOD, x: -1 })).message).toMatch(/crop/i);
  });
});

describe('media/crop cropPixels', () => {
  it('takes the largest square from a 4000x3000 image', () => {
    expect(cropPixels({ x: 0.25, y: 0, w: 0.75, h: 1 }, 4000, 3000)).toEqual({ left: 1000, top: 0, size: 3000 });
  });

  it('works out the side from the smaller of w*W and h*H', () => {
    expect(cropPixels({ x: 0.1, y: 0.2, w: 0.4, h: 0.5333 }, 1000, 750)).toEqual({ left: 100, top: 150, size: 400 });
  });

  it('allows the two sides to differ by up to 1%', () => {
    // 1000 x 1005: 0.5% apart; the side is the smaller, 1000.
    expect(cropPixels({ x: 0, y: 0, w: 0.5, h: 0.5025 }, 2000, 2000)).toEqual({ left: 0, top: 0, size: 1000 });
  });

  it('puts the 1% tolerance between h = 0.5050 and 0.5051 on a 2000x2000 image', () => {
    expect(cropPixels({ x: 0, y: 0, w: 0.5, h: 0.505 }, 2000, 2000)).toEqual({ left: 0, top: 0, size: 1000 });
    expect(cropPixels({ x: 0, y: 0, w: 0.505, h: 0.5 }, 2000, 2000)).toEqual({ left: 0, top: 0, size: 1000 });
    expect(failure(() => cropPixels({ x: 0, y: 0, w: 0.5, h: 0.5051 }, 2000, 2000))?.field).toBe('crop');
    expect(failure(() => cropPixels({ x: 0, y: 0, w: 0.5051, h: 0.5 }, 2000, 2000))?.field).toBe('crop');
  });

  it('refuses a crop that is more than 1% off square', () => {
    const e = failure(() => cropPixels({ x: 0, y: 0, w: 0.5, h: 0.5 }, 4000, 3000));
    expect(e?.field).toBe('crop');
    expect(e.message).toMatch(/square/i);
    expect(failure(() => cropPixels({ x: 0, y: 0, w: 0.5, h: 0.5102 }, 2000, 2000))?.field).toBe('crop');
  });

  it('refuses a crop under 32 pixels', () => {
    const e = failure(() => cropPixels({ x: 0, y: 0, w: 0.005, h: 0.005 }, 4000, 4000)); // 20px
    expect(e?.field).toBe('crop');
    expect(e.message).toMatch(/small|32/i);
    expect(failure(() => cropPixels({ x: 0, y: 0, w: 0.0077, h: 0.0077 }, 4000, 4000))).toBeDefined(); // 30.8px
  });

  it('accepts exactly 32 pixels', () => {
    expect(cropPixels({ x: 0.5, y: 0.5, w: 0.008, h: 0.008 }, 4000, 4000)).toEqual({ left: 2000, top: 2000, size: 32 });
  });

  it('throws a RangeError, not a CropError, for an image size that is not positive whole numbers', () => {
    const crop = { x: 0, y: 0, w: 0.5, h: 0.5 };
    for (const [width, height] of [[0, 100], [100, 0], [-100, 100], [100.5, 100], [NaN, 100], [100, Infinity], ['100', 100], [undefined, 100]]) {
      expect(() => cropPixels(crop, width, height)).toThrow(RangeError);
    }
    expect(() => cropPixels(crop, 0, 100)).toThrow(/width and height.*0 x 100/);
  });

  it('validates the crop first', () => {
    expect(failure(() => cropPixels({ x: 0, y: 0, w: 0, h: 1 }, 100, 100))?.field).toBe('crop.w');
    expect(failure(() => cropPixels(null, 100, 100))?.field).toBe('crop');
  });

  it('keeps the square inside the image when the crop overshoots by the 0.0001 allowance', () => {
    expect(cropPixels({ x: 0, y: 0, w: 1.0001, h: 1.0001 }, 1000, 1000)).toEqual({ left: 0, top: 0, size: 1000 });
    const c = cropPixels({ x: 0.5001, y: 0.5001, w: 0.5, h: 0.5 }, 1000, 1000);
    expect(c.left + c.size).toBeLessThanOrEqual(1000);
    expect(c.top + c.size).toBeLessThanOrEqual(1000);
  });

  it('rounds the offsets and the side to whole pixels', () => {
    // x rounds to 0.1235 (123.6px), y to 0.0001 (0.1px), and the side is 500.5px.
    expect(cropPixels({ x: 0.12345, y: 0.0001, w: 0.5, h: 0.5 }, 1001, 1001)).toEqual({ left: 124, top: 0, size: 501 });
  });
});

describe('media/crop avatarKeyFor', () => {
  const digest12 = (text) => createHash('sha256').update(text).digest('hex').slice(0, 12);

  it('is avatars/<sha>-<12 hex of the crop>.webp', () => {
    expect(avatarKeyFor(SHA, { x: 0.25, y: 0, w: 0.75, h: 1 })).toBe(`avatars/${SHA}-${digest12('0.2500,0.0000,0.7500,1.0000')}.webp`);
    expect(avatarKeyFor(SHA, GOOD)).toMatch(new RegExp(`^avatars/${SHA}-[0-9a-f]{12}\\.webp$`));
  });

  it('is deterministic', () => {
    expect(avatarKeyFor(SHA, GOOD)).toBe(avatarKeyFor(SHA, { ...GOOD }));
  });

  it('gives the same key for crops that round to the same four decimal places', () => {
    expect(avatarKeyFor(SHA, { x: 0.25, y: 0.1, w: 0.5, h: 0.5 })).toBe(avatarKeyFor(SHA, { x: 0.250004, y: 0.1, w: 0.49999, h: 0.5 }));
  });

  it('changes with any field of the crop', () => {
    const base = avatarKeyFor(SHA, GOOD);
    const keys = [
      avatarKeyFor(SHA, { ...GOOD, x: 0.2501 }),
      avatarKeyFor(SHA, { ...GOOD, y: 0.1001 }),
      avatarKeyFor(SHA, { ...GOOD, w: 0.4999 }),
      avatarKeyFor(SHA, { ...GOOD, h: 0.4999 })
    ];
    for (const key of keys) expect(key).not.toBe(base);
    expect(new Set([base, ...keys]).size).toBe(5);
  });

  it('changes with the photo', () => {
    expect(avatarKeyFor('cd'.repeat(32), GOOD)).not.toBe(avatarKeyFor(SHA, GOOD));
  });

  it('refuses an invalid crop', () => {
    expect(failure(() => avatarKeyFor(SHA, { x: 0, y: 0, w: 0, h: 1 }))?.field).toBe('crop.w');
  });

  it('refuses a sha256 that is not 64 lower-case hex digits', () => {
    for (const bad of ['', 'ab', 'AB'.repeat(32), `${SHA}0`, `${'ab'.repeat(31)}zz`, '../etc/passwd', undefined, null, 7]) {
      expect(failure(() => avatarKeyFor(bad, GOOD))?.field).toBe('sha256');
    }
  });
});
