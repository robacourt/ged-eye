/**
 * Image processing for the media Function and the backfill script: upload checks, location stripping, display
 * images, thumbnails and avatars. Pure functions of a buffer, with no S3 and no HTTP.
 */
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { MAX_UPLOAD_BYTES, sniff } from './types.js';
import { cropPixels, validateCrop } from './crop.js';

// Spec "Memory rules": no operation cache (it held decoded images across requests), two libvips threads.
sharp.cache(false);
sharp.concurrency(2);

export const LIMIT_PIXELS = 100_000_000;
export const DISPLAY_SIZE = 2000;
export const THUMB_SIZE = 320;
export const AVATAR_SIZE = 400;

/**
 * Re-encode every TIFF, whether or not location data is found. sharp 0.33.5 (libvips 8.15.3) never puts a TIFF's
 * EXIF in metadata().exif: a TIFF whose IFD0 has a GPSInfo pointer (0x8825) reads as `exif: undefined`, so
 * hasLocation can't see its GPS (tests/mediaImaging.test.js builds one by hand to show this). The LZW re-encode
 * writes no EXIF, so the stored original has no GPS IFD.
 */
export const ALWAYS_REENCODE_TIFF = true;

/** A file we refuse. `status` 400 (413 for too_large); `permanent` means re-trying the same bytes can't help. */
export class ImagingError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
    this.permanent = true;
  }
}

/** The hex sha256 of `buffer`. */
export const sha256Hex = (buffer) => createHash('sha256').update(buffer).digest('hex');

/** Does sharp's metadata().exif (with or without its "Exif\0\0" prefix) have a GPSInfo pointer (0x8825) in IFD0? */
export function hasGps(exif) {
  try {
    if (!exif || exif.length < 8) return false;
    let b = exif;
    if (b.subarray(0, 6).toString('latin1') === 'Exif\0\0') b = b.subarray(6);
    const order = b.subarray(0, 2).toString('latin1');
    if (order !== 'II' && order !== 'MM') return false;
    const le = order === 'II';
    const u16 = (o) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o));
    const u32 = (o) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
    const ifd0 = u32(4);
    const count = u16(ifd0);
    for (let i = 0; i < count; i++) if (u16(ifd0 + 2 + i * 12) === 0x8825) return true;
    return false;
  } catch {
    return false; // a truncated block (RangeError) has no readable GPS pointer
  }
}

/** Does sharp's metadata show location data: a GPSInfo pointer in the EXIF, or XMP that mentions GPSLatitude? */
export const hasLocation = (meta) => hasGps(meta.exif) || Boolean(meta.xmp && meta.xmp.toString('latin1').includes('GPSLatitude'));

/**
 * Size and type checks plus the sha, without decoding. → { sha256, type } (type is a TYPES entry, sniffed from the
 * bytes). Throws ImagingError 'empty', 'too_large' (413), 'heic_unsupported' or 'unsupported_type'.
 */
export function inspect(buffer) {
  if (buffer.length === 0) throw new ImagingError('empty');
  if (buffer.length > MAX_UPLOAD_BYTES) throw new ImagingError('too_large', 413);
  const type = sniff(buffer);
  if (type === 'heic') throw new ImagingError('heic_unsupported');
  if (!type) throw new ImagingError('unsupported_type');
  return { sha256: sha256Hex(buffer), type };
}

/**
 * Runs `operation`, a sharp pipeline. Its failure is the file's fault, and permanent: ImagingError('too_many_pixels')
 * when the input is over limitInputPixels, else ImagingError('unreadable') (sharp can't decode or re-encode it).
 * The sharp error is kept as `cause`.
 */
async function mapSharpErrors(operation) {
  try {
    return await operation();
  } catch (error) {
    const code = /exceeds pixel limit/.test(error?.message) ? 'too_many_pixels' : 'unreadable';
    throw Object.assign(new ImagingError(code), { cause: error });
  }
}

/** sharp's metadata of `buffer`, read under the pixel limit. Throws ImagingError 'too_many_pixels' or 'unreadable'. */
const readMetadata = (buffer, limitInputPixels) => mapSharpErrors(() => sharp(buffer, { limitInputPixels }).metadata());

/** The size as shown: EXIF orientations 5–8 swap the width and height. → { width, height } */
function orientedSize(meta) {
  return (meta.orientation ?? 1) >= 5 ? { width: meta.height, height: meta.width } : { width: meta.width, height: meta.height };
}

/** The display image (first frame, upright, at most DISPLAY_SIZE) and its thumbnail. → { display, thumb, width, height } */
async function displayAndThumb(buffer, meta, limitInputPixels) {
  const display = await mapSharpErrors(() => sharp(buffer, { limitInputPixels }).rotate()
    .resize(DISPLAY_SIZE, DISPLAY_SIZE, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }).toBuffer());
  // From the display image, not the original, which saves decoding the original again (spec "Memory rules").
  const thumb = await mapSharpErrors(() => sharp(display)
    .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 75 }).toBuffer());
  return { display, thumb, ...orientedSize(meta) };
}

/**
 * `buffer` re-encoded in its own format, upright, keeping the ICC profile and no other metadata (so no location).
 * `type` is its TYPES entry and `meta` its sharp metadata. A TIFF keeps every page unless it must be rotated, and a
 * GIF keeps every frame. Throws ImagingError 'too_many_pixels' or 'unreadable' (such as a multi-page TIFF whose
 * pages differ in size), and TypeError for a type that isn't an image.
 */
export async function reencodeWithoutMetadata(buffer, type, meta, limitInputPixels = LIMIT_PIXELS) {
  const open = (options) => sharp(buffer, { limitInputPixels, ...options });
  const upright = () => open().rotate().keepIccProfile();
  const encoders = {
    jpg: () => upright().jpeg({ quality: 92 }),
    webp: () => upright().webp({ quality: 92 }),
    png: () => upright().png(),
    avif: () => upright().avif({ quality: 70 }),
    // .rotate() can't turn a multi-page image, so a TIFF that needs rotating keeps only its first page.
    tif: () => (meta.orientation > 1 ? upright() : open({ pages: -1 }).keepIccProfile()).tiff({ compression: 'lzw' }),
    // GIFs have no EXIF orientation.
    gif: () => open({ animated: true }).gif()
  };
  const encoder = encoders[type.ext];
  if (!encoder) throw new TypeError(`media/imaging: no re-encoder for .${type.ext}`);
  return mapSharpErrors(() => encoder().toBuffer());
}

/**
 * Checks and processes an upload. → { sha256, type, original: { body, reencoded }, display, thumb, width, height }
 * - `original.body` is `buffer` itself unless it has location data (or is a TIFF), when it is re-encoded without it.
 * - `display` and `thumb` are WebP; `width` and `height` are the oriented size. All four are null for PDFs.
 * Throws ImagingError: inspect's codes, 'too_many_pixels', or 'unreadable'.
 */
export async function processFile(buffer, { limitInputPixels = LIMIT_PIXELS } = {}) {
  const { sha256, type } = inspect(buffer);
  if (!type.image) return { sha256, type, original: { body: buffer, reencoded: false }, display: null, thumb: null, width: null, height: null };
  const meta = await readMetadata(buffer, limitInputPixels);
  const reencode = hasLocation(meta) || (type.ext === 'tif' && ALWAYS_REENCODE_TIFF);
  const original = reencode
    ? { body: await reencodeWithoutMetadata(buffer, type, meta, limitInputPixels), reencoded: true }
    : { body: buffer, reencoded: false };
  const { display, thumb, width, height } = await displayAndThumb(buffer, meta, limitInputPixels);
  return { sha256, type, original, display, thumb, width, height };
}

/**
 * The display image and thumbnail of an existing original, for the backfill: no type checks beyond sharp being able
 * to read it. → { display, thumb, width, height } (oriented size). Throws ImagingError 'too_many_pixels' or 'unreadable'.
 */
export async function derivatives(buffer, { limitInputPixels = LIMIT_PIXELS } = {}) {
  const meta = await readMetadata(buffer, limitInputPixels);
  return displayAndThumb(buffer, meta, limitInputPixels);
}

/**
 * The avatar for `crop` (fractions of the oriented image) of the original in `buffer`: an AVATAR_SIZE square WebP
 * with no metadata. Throws CropError for an invalid or non-square crop (the handler answers 400 invalid), and
 * ImagingError 'too_many_pixels' or 'unreadable'.
 */
export async function renderAvatar(buffer, crop, { limitInputPixels = LIMIT_PIXELS } = {}) {
  validateCrop(crop);
  const { width, height } = orientedSize(await readMetadata(buffer, limitInputPixels));
  const { left, top, size } = cropPixels(crop, width, height);
  return mapSharpErrors(() => sharp(buffer, { limitInputPixels }).rotate()
    .extract({ left, top, width: size, height: size }).resize(AVATAR_SIZE, AVATAR_SIZE).webp({ quality: 85 }).toBuffer());
}
