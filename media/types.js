/**
 * The file types, name rules, identifier patterns and refusal error shared by the media Function and the api Function.
 * Pure, with no dependencies, so both can import it.
 */

export const MAX_UPLOAD_BYTES = 52_428_800;

/** The Cache-Control of every stored key but incoming/: immutable keys are written once and cached for a year. */
export const IMMUTABLE = 'public, max-age=31536000, immutable';

/** The accepted types, by the extension stored in originals/<sha>.<ext>. */
export const TYPES = new Map([
  ['jpg', { ext: 'jpg', contentType: 'image/jpeg', image: true }],
  ['png', { ext: 'png', contentType: 'image/png', image: true }],
  ['webp', { ext: 'webp', contentType: 'image/webp', image: true }],
  ['gif', { ext: 'gif', contentType: 'image/gif', image: true }],
  ['tif', { ext: 'tif', contentType: 'image/tiff', image: true }],
  ['avif', { ext: 'avif', contentType: 'image/avif', image: true }],
  ['pdf', { ext: 'pdf', contentType: 'application/pdf', image: false }]
]);

for (const type of TYPES.values()) Object.freeze(type);

/** A file we refuse. `status` 400 (413 for too_large); `permanent` means re-trying the same bytes can't help. */
export class ImagingError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
    this.permanent = true;
  }
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const SHA256 = /^[0-9a-f]{64}$/;

const ACCEPTED_CONTENT_TYPES = new Set([...TYPES.values()].map((type) => type.contentType));
const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1']);
const AVIF_BRANDS = new Set(['avif', 'avis']);
// Text Postgres can't store in jsonb and encodeURIComponent can't encode: unpaired UTF-16 surrogates.
const UNPAIRED_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const FORBIDDEN_IN_NAME = /[/\\\u0000-\u001f\u007f-\u009f]/;
const MAX_FILE_NAME = 255;
const MAX_FTYP_SCAN = 256; // real ftyp boxes are a few dozen bytes; don't walk a bogus size through a 50 MB file

/** True when `bytes` has `signature` (an array of byte values) at `offset`. */
function hasBytes(bytes, signature, offset = 0) {
  return bytes.length >= offset + signature.length && signature.every((value, i) => bytes[offset + i] === value);
}

const text = (value) => [...value].map((c) => c.charCodeAt(0));
const brandAt = (bytes, offset) => String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);

/**
 * The brands of an ISO-BMFF file's `ftyp` box: the major brand, then the compatible brands up to the box's
 * end (the big-endian u32 at 0, clamped to the bytes given and to the first 256 bytes). [] when `bytes` doesn't
 * start with an `ftyp` box.
 */
function isoBrands(bytes) {
  if (bytes.length < 12 || !hasBytes(bytes, text('ftyp'), 4)) return [];
  const size = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
  const end = Math.min(size, bytes.length, MAX_FTYP_SCAN);
  const brands = [brandAt(bytes, 8)];
  for (let offset = 16; offset + 4 <= end; offset += 4) brands.push(brandAt(bytes, offset));
  return brands;
}

/**
 * The type of `bytes` (a Buffer or Uint8Array) from its magic numbers: a TYPES entry, 'heic' for the HEIF
 * family (which isn't accepted), or null. An ISO-BMFF file is AVIF if any brand in its `ftyp` box is `avif`
 * or `avis`, even when the major brand is `mif1`. Returns null for null or undefined. Never throws.
 */
export function sniff(bytes) {
  if (bytes === null || bytes === undefined) return null;
  if (hasBytes(bytes, [0xff, 0xd8, 0xff])) return TYPES.get('jpg');
  if (hasBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return TYPES.get('png');
  if (hasBytes(bytes, text('GIF87a')) || hasBytes(bytes, text('GIF89a'))) return TYPES.get('gif');
  if (hasBytes(bytes, text('RIFF')) && hasBytes(bytes, text('WEBP'), 8)) return TYPES.get('webp');
  if (hasBytes(bytes, [0x49, 0x49, 0x2a, 0x00]) || hasBytes(bytes, [0x4d, 0x4d, 0x00, 0x2a])) return TYPES.get('tif');
  if (hasBytes(bytes, text('%PDF-'))) return TYPES.get('pdf');
  const brands = isoBrands(bytes);
  if (brands.some((brand) => AVIF_BRANDS.has(brand))) return TYPES.get('avif');
  if (brands.some((brand) => HEIC_BRANDS.has(brand))) return 'heic';
  return null;
}

/** An Error with the `code` and HTTP `status` of an upload rejection. */
function rejection(code) {
  return Object.assign(new Error(code), { code, status: 400 });
}

/**
 * What /uploads may be told: one of TYPES' content types, 'image/jpg', or '' (the browser doesn't know).
 * Returns the content type to sign: 'image/jpg' becomes 'image/jpeg' and '' becomes 'application/octet-stream'.
 * Throws an Error with `code` 'heic_unsupported' (image/heic, image/heif) or 'unsupported_type' (anything else,
 * including a value that isn't a string) and `status` 400.
 */
export function declaredType(contentType) {
  if (contentType === '') return 'application/octet-stream';
  const type = typeof contentType === 'string' ? contentType.trim().toLowerCase() : '';
  if (type === 'image/jpg') return 'image/jpeg';
  if (ACCEPTED_CONTENT_TYPES.has(type)) return type;
  throw rejection(type === 'image/heic' || type === 'image/heif' ? 'heic_unsupported' : 'unsupported_type');
}

/**
 * A file name as stored: trimmed, 1-255 characters, no / \ or control characters, no unpaired surrogate.
 * Returns the trimmed name, or null when `value` isn't acceptable (including when it isn't a string).
 */
export function cleanFileName(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  if (name === '' || name.length > MAX_FILE_NAME) return null;
  if (FORBIDDEN_IN_NAME.test(name) || UNPAIRED_SURROGATE.test(name)) return null;
  return name;
}

/**
 * The Content-Disposition for a stored original: `inline; filename*=UTF-8''<percent-encoded name>` (RFC 5987),
 * so the header is always ASCII. Throws URIError if `fileName` has an unpaired surrogate; cleanFileName rules those out.
 */
export function inlineDisposition(fileName) {
  // encodeURIComponent leaves ' ( ) * alone, but ' ends the value's language field and the others aren't RFC 5987 characters.
  const encoded = encodeURIComponent(fileName).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `inline; filename*=UTF-8''${encoded}`;
}
