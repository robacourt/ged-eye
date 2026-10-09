/**
 * Avatar crops: validation, pixel maths and the storage key. Pure, so the media Function (which renders the
 * crop) and the api Function (which checks the key it is given) agree exactly.
 */
import { createHash } from 'node:crypto';
import { SHA256 } from './types.js';

/** Thrown for an invalid crop; `field` is 'crop' or 'crop.<x|y|w|h>'. */
export class CropError extends Error {
  constructor(field, message) {
    super(message);
    this.field = field;
  }
}

const MAX_EXTENT = 1.0001; // x + w and y + h may overshoot 1 by a rounding error
const MIN_SIDE_PX = 32;
const MAX_SIDE_DIFFERENCE = 0.01;

const round4 = (n) => Math.round(n * 10_000) / 10_000 + 0; // + 0 turns -0 into 0

/**
 * The crop { x, y, w, h } as finite fractions of the oriented image, rounded to 4 decimal places (with no other
 * keys) and then checked: 0 <= x, y <= 1.0001; w, h > 0; x + w <= 1.0001; y + h <= 1.0001.
 * Throws CropError (field 'crop' or 'crop.<key>') for anything else.
 */
export function validateCrop(crop) {
  if (crop === null || typeof crop !== 'object' || Array.isArray(crop)) {
    throw new CropError('crop', 'The crop must be an object with x, y, w and h.');
  }
  for (const key of ['x', 'y', 'w', 'h']) {
    if (typeof crop[key] !== 'number' || !Number.isFinite(crop[key])) {
      throw new CropError(`crop.${key}`, `The crop's ${key} must be a number.`);
    }
  }
  // Rounding a huge finite value (1e305) overflows to Infinity, which the checks below catch.
  const { x, y, w, h } = { x: round4(crop.x), y: round4(crop.y), w: round4(crop.w), h: round4(crop.h) };
  if (!(x >= 0 && x <= MAX_EXTENT)) throw new CropError('crop.x', "The crop's x must be between 0 and 1.");
  if (!(y >= 0 && y <= MAX_EXTENT)) throw new CropError('crop.y', "The crop's y must be between 0 and 1.");
  if (!(w > 0)) throw new CropError('crop.w', "The crop's w must be greater than 0.");
  if (!(h > 0)) throw new CropError('crop.h', "The crop's h must be greater than 0.");
  if (!(round4(x + w) <= MAX_EXTENT)) throw new CropError('crop.w', 'The crop extends past the right edge of the photo.');
  if (!(round4(y + h) <= MAX_EXTENT)) throw new CropError('crop.h', 'The crop extends past the bottom edge of the photo.');
  return { x, y, w, h };
}

/**
 * The square crop in pixels of a width x height oriented image: side = round(min(w*W, h*H)). Returns
 * { left, top, size }, clamped inside the image. Throws CropError ('crop') unless w*W and h*H differ by at most 1%
 * and the side is at least 32; a crop that fails validateCrop throws its error. Throws RangeError (a caller bug,
 * not a bad request) unless `width` and `height` are positive finite integers.
 */
export function cropPixels(crop, width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError(`The image width and height must be positive whole numbers, not ${width} x ${height}.`);
  }
  const { x, y, w, h } = validateCrop(crop);
  const across = w * width;
  const down = h * height;
  if (!(Math.abs(across - down) <= MAX_SIDE_DIFFERENCE * Math.max(across, down))) {
    throw new CropError('crop', 'The crop must be square.');
  }
  const size = Math.min(Math.round(Math.min(across, down)), width, height);
  if (!(size >= MIN_SIDE_PX)) throw new CropError('crop', `The crop is too small: it must be at least ${MIN_SIDE_PX} pixels.`);
  return {
    left: Math.min(Math.round(x * width), width - size),
    top: Math.min(Math.round(y * height), height - size),
    size
  };
}

/**
 * The key of the avatar rendered from the original with `sha256`:
 * avatars/<sha>-<first 12 hex of sha256("x,y,w,h" with 4 decimal places each)>.webp.
 * Throws CropError ('sha256') unless `sha256` is 64 lower-case hex digits, and CropError for an invalid crop.
 */
export function avatarKeyFor(sha256, crop) {
  if (typeof sha256 !== 'string' || !SHA256.test(sha256)) {
    throw new CropError('sha256', "The photo's sha256 must be 64 lower-case hex digits.");
  }
  const c = validateCrop(crop);
  const digest = createHash('sha256').update([c.x, c.y, c.w, c.h].map((n) => n.toFixed(4)).join(',')).digest('hex');
  return `avatars/${sha256}-${digest.slice(0, 12)}.webp`;
}
