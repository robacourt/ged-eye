// @vitest-environment node
import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import { MAX_UPLOAD_BYTES, TYPES, sniff } from '../media/types.js';
import { CropError } from '../media/crop.js';
import {
  AVATAR_SIZE, DISPLAY_SIZE, ImagingError, LIMIT_PIXELS, THUMB_SIZE,
  derivatives, hasGps, hasLocation, inspect, processFile, reencodeWithoutMetadata, renderAvatar, sha256Hex
} from '../media/imaging.js';

/** A minimal uncompressed 8-bit greyscale TIFF, one page per { width, height }. */
function multiPageTiff(pages) {
  const entries = 9;
  const ifdSize = 2 + entries * 12 + 4;
  let size = 8;
  const layout = pages.map(({ width, height }) => {
    const ifd = size;
    const data = ifd + ifdSize;
    size = data + width * height;
    return { width, height, ifd, data };
  });
  const b = Buffer.alloc(size);
  b.write('II', 0, 'latin1');
  b.writeUInt16LE(42, 2);
  b.writeUInt32LE(layout[0].ifd, 4);
  layout.forEach(({ width, height, ifd, data }, i) => {
    const tags = [[256, 3, width], [257, 3, height], [258, 3, 8], [259, 3, 1], [262, 3, 1],
      [273, 4, data], [277, 3, 1], [278, 3, height], [279, 4, width * height]];
    b.writeUInt16LE(entries, ifd);
    tags.forEach(([tag, type, value], j) => {
      const o = ifd + 2 + j * 12;
      b.writeUInt16LE(tag, o);
      b.writeUInt16LE(type, o + 2);
      b.writeUInt32LE(1, o + 4);
      if (type === 3) b.writeUInt16LE(value, o + 8); else b.writeUInt32LE(value, o + 8);
    });
    b.writeUInt32LE(layout[i + 1]?.ifd ?? 0, ifd + 2 + entries * 12);
    b.fill(i === 0 ? 64 : 192, data, data + width * height);
  });
  return b;
}

/**
 * A minimal uncompressed 8-bit greyscale TIFF, one page per { width, height, gps, orientation }, laid out the way a
 * camera or scanner writes it. `gps` gives that page's IFD a GPSInfo pointer (0x8825) to a GPS IFD holding
 * GPSLatitudeRef 'N', and `orientation` an Orientation tag. sharp can't write either: its TIFF output drops EXIF.
 */
function tiffByHand(pages) {
  const gpsIfdSize = 2 + 12 + 4;
  let size = 8;
  const layout = pages.map((page) => {
    const entries = 9 + (page.orientation ? 1 : 0) + (page.gps ? 1 : 0);
    const ifd = size;
    const gpsIfd = ifd + 2 + entries * 12 + 4;
    const data = gpsIfd + (page.gps ? gpsIfdSize : 0);
    size = data + page.width * page.height;
    return { ...page, ifd, gpsIfd, data };
  });
  const b = Buffer.alloc(size);
  b.write('II', 0, 'latin1');
  b.writeUInt16LE(42, 2);
  b.writeUInt32LE(layout[0].ifd, 4);
  layout.forEach(({ width, height, gps, orientation, ifd, gpsIfd, data }, i) => {
    const tags = [[256, 3, width], [257, 3, height], [258, 3, 8], [259, 3, 1], [262, 3, 1], [273, 4, data],
      ...(orientation ? [[274, 3, orientation]] : []), [277, 3, 1], [278, 3, height], [279, 4, width * height],
      ...(gps ? [[0x8825, 4, gpsIfd]] : [])];
    b.writeUInt16LE(tags.length, ifd);
    tags.forEach(([tag, type, value], j) => {
      const o = ifd + 2 + j * 12;
      b.writeUInt16LE(tag, o);
      b.writeUInt16LE(type, o + 2);
      b.writeUInt32LE(1, o + 4);
      if (type === 3) b.writeUInt16LE(value, o + 8); else b.writeUInt32LE(value, o + 8);
    });
    b.writeUInt32LE(layout[i + 1]?.ifd ?? 0, ifd + 2 + tags.length * 12);
    if (gps) {
      // One entry: GPSLatitudeRef (1), ASCII (2), 2 characters 'N\0' held inline. The next-IFD offset stays 0.
      b.writeUInt16LE(1, gpsIfd);
      b.writeUInt16LE(1, gpsIfd + 2);
      b.writeUInt16LE(2, gpsIfd + 4);
      b.writeUInt32LE(2, gpsIfd + 6);
      b.write('N', gpsIfd + 10, 'latin1');
    }
    b.fill(i === 0 ? 64 : 192, data, data + width * height);
  });
  return b;
}

/** The tag numbers of every IFD in a TIFF's chain (either byte order), one array per IFD. */
function tiffTags(b) {
  const le = b.toString('latin1', 0, 2) === 'II';
  const u16 = (o) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o));
  const u32 = (o) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
  const ifds = [];
  for (let ifd = u32(4); ifd !== 0 && ifds.length < 64; ifd = u32(ifd + 2 + u16(ifd) * 12)) {
    ifds.push(Array.from({ length: u16(ifd) }, (_, i) => u16(ifd + 2 + i * 12)));
  }
  return ifds;
}

/** `buffer` as a plain Uint8Array over the same bytes, as a caller might pass it. */
const asUint8Array = (buffer) => new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);

/** `jpeg` with an XMP packet spliced in after SOI, as an APP1 segment (sharp 0.33 can't write XMP). */
function jpegWithXmp(jpeg, xmp) {
  const payload = Buffer.concat([Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'latin1'), Buffer.from(xmp, 'utf8')]);
  const marker = Buffer.alloc(4);
  marker.writeUInt16BE(0xffe1, 0);
  marker.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), marker, payload, jpeg.subarray(2)]);
}

/**
 * `gif` with an XMP packet in an "XMP DataXMP" application extension after the global colour table, followed by the
 * 258-byte "magic trailer" that lets GIF readers skip the packet as sub-blocks.
 */
function gifWithXmp(gif, xmp) {
  const flags = gif[10];
  const end = 13 + (flags & 0x80 ? 3 * 2 ** ((flags & 7) + 1) : 0);
  const trailer = Buffer.from([1, ...Array.from({ length: 256 }, (_, i) => 255 - i), 0]);
  const extension = Buffer.concat([Buffer.from([0x21, 0xff, 0x0b]), Buffer.from('XMP DataXMP', 'latin1'), Buffer.from(xmp, 'utf8'), trailer]);
  return Buffer.concat([gif.subarray(0, end), extension, gif.subarray(end)]);
}

/** A PNG chunk: length, type, data and CRC. */
function pngChunk(type, data) {
  const typeAndData = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

/** A greyscale PNG that claims to be width × height but holds a single row of pixel data. */
function pngHeader(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth; colour type 0 (greyscale), compression, filter and interlace all 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(Buffer.alloc(width + 1))),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

/** The ImagingError that `fn` throws or rejects with; fails the test if there is none. */
async function imagingError(fn) {
  try {
    await fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ImagingError);
    return e;
  }
  throw new Error('expected an ImagingError');
}

const metadata = (buffer, options) => sharp(buffer, options).metadata();
const longEdge = ({ width, height }) => Math.max(width, height);

const red = () => sharp({ create: { width: 400, height: 200, channels: 3, background: '#c33' } });
const GPS = { IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '51/1 30/1 0/1' } };
const gpsJpeg = await red().jpeg().withMetadata({ orientation: 6 }).withExif(GPS).toBuffer();
const plainJpeg = await red().jpeg().withMetadata({ orientation: 6 }).toBuffer();
const iccGpsJpeg = await red().jpeg().withIccProfile('p3').withExif(GPS).toBuffer();
const gpsPng = await red().png().withExif(GPS).toBuffer();
// sharp's TIFF output drops EXIF, so despite withExif this TIFF has no GPS; gpsTiff is the TIFF with GPS.
const plainTiff = await red().tiff().withExif(GPS).toBuffer();
const gpsTiff = tiffByHand([{ width: 4, height: 4, gps: true }]);
const gpsOnPage2Tiff = tiffByHand([{ width: 40, height: 30 }, { width: 40, height: 30, gps: true }]);
const turnedGpsTiff = tiffByHand([{ width: 40, height: 30, gps: true, orientation: 6 }, { width: 40, height: 30 }]);
const pdf = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n'
  + '2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n', 'latin1');
const plainPng = await red().png().toBuffer();
const locationXmp = '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF '
  + 'xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description '
  + 'xmlns:exif="http://ns.adobe.com/exif/1.0/" exif:GPSLatitude="51,30.0N"/></rdf:RDF></x:xmpmeta>';
const xmpJpeg = jpegWithXmp(await red().jpeg().toBuffer(), locationXmp);
const twoPageTiff = multiPageTiff([{ width: 40, height: 30 }, { width: 40, height: 30 }]);
const mixedTiff = multiPageTiff([{ width: 40, height: 30 }, { width: 20, height: 10 }]);
// sharp 0.33.5's `create` has no pages or pageHeight option, so the two frames come from a two-page TIFF read
// with `pages: -1`, which sharp writes as an animated GIF.
const animatedGif = await sharp(twoPageTiff, { pages: -1 }).gif().toBuffer();
const xmpGif = gifWithXmp(animatedGif, locationXmp);
const heic = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic\0\0\0\0mif1heic', 'latin1')]);
const notAnImage = Buffer.from('These bytes are not any type of file we accept.', 'latin1');
const brokenJpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('then nothing but garbage', 'latin1')]);
const gpsExif = (await metadata(gpsJpeg)).exif;

/**
 * A 400×200 JPEG, blue on the left half and green on the right, with orientation 6 (turn 90° clockwise to show).
 * Shown upright it is 200×400: blue on top, green below.
 */
async function twoToneJpeg() {
  const pixels = Buffer.alloc(400 * 200 * 3);
  for (let i = 0; i < 400 * 200; i++) pixels[i * 3 + ((i % 400) < 200 ? 2 : 1)] = 255;
  return sharp(pixels, { raw: { width: 400, height: 200, channels: 3 } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
}
const twoTone = await twoToneJpeg();

/** The mean [red, green, blue] of an image, rounded. */
const meanColour = async (buffer) => (await sharp(buffer).stats()).channels.slice(0, 3).map((c) => Math.round(c.mean));

describe('media/imaging constants and ImagingError', () => {
  it('has the sizes and pixel limit from the spec', () => {
    expect(LIMIT_PIXELS).toBe(100_000_000);
    expect(DISPLAY_SIZE).toBe(2000);
    expect(THUMB_SIZE).toBe(320);
    expect(AVATAR_SIZE).toBe(400);
  });

  it('is a permanent Error with a code and a status (400 by default)', () => {
    const e = new ImagingError('unreadable');
    expect(e).toBeInstanceOf(Error);
    expect(e).toMatchObject({ code: 'unreadable', status: 400, permanent: true, message: 'unreadable' });
    expect(new ImagingError('too_large', 413).status).toBe(413);
  });

  it('sha256Hex is the hex sha256 of the bytes', () => {
    expect(sha256Hex(plainJpeg)).toBe(createHash('sha256').update(plainJpeg).digest('hex'));
  });
});

describe('media/imaging inspect', () => {
  it('returns the sha256 and the sniffed type', () => {
    expect(inspect(plainJpeg)).toEqual({ sha256: sha256Hex(plainJpeg), type: TYPES.get('jpg') });
  });

  it('refuses an empty buffer', async () => {
    expect(await imagingError(() => inspect(Buffer.alloc(0)))).toMatchObject({ code: 'empty', status: 400 });
  });

  it('refuses more than MAX_UPLOAD_BYTES with 413 before looking at the bytes', async () => {
    const e = await imagingError(() => inspect({ length: MAX_UPLOAD_BYTES + 1 }));
    expect(e).toMatchObject({ code: 'too_large', status: 413, permanent: true });
  });

  it('refuses a HEIC header', async () => {
    expect(await imagingError(() => inspect(heic))).toMatchObject({ code: 'heic_unsupported', status: 400 });
  });

  it('refuses bytes of no accepted type', async () => {
    expect(await imagingError(() => inspect(notAnImage))).toMatchObject({ code: 'unsupported_type', status: 400 });
  });

  it('takes a Uint8Array as well as a Buffer', () => {
    expect(inspect(asUint8Array(gpsTiff))).toEqual({ sha256: sha256Hex(gpsTiff), type: TYPES.get('tif') });
  });

  it('types a PDF as a PDF whatever it was called, because only the bytes are consulted', () => {
    // An upload of x.jpg holding these bytes is stored as a PDF.
    expect(inspect(pdf).type).toBe(TYPES.get('pdf'));
  });
});

describe('media/imaging hasGps and hasLocation', () => {
  it('finds the GPSInfo pointer in IFD0, with or without the Exif\\0\\0 prefix', () => {
    expect(gpsExif.subarray(0, 6).toString('latin1')).toBe('Exif\0\0');
    expect(hasGps(gpsExif)).toBe(true);
    expect(hasGps(gpsExif.subarray(6))).toBe(true);
  });

  it('reads a whole TIFF file, which is itself a TIFF/EXIF structure', () => {
    expect(hasGps(gpsTiff)).toBe(true);
    expect(hasGps(plainTiff)).toBe(false);
  });

  it('reads a big-endian block', () => {
    const b = Buffer.alloc(26);
    b.write('MM', 0, 'latin1');
    b.writeUInt16BE(42, 2);
    b.writeUInt32BE(8, 4);
    b.writeUInt16BE(1, 8);
    b.writeUInt16BE(0x8825, 10);
    expect(hasGps(b)).toBe(true);
  });

  it('is false for EXIF without GPS, no EXIF, a short or truncated block, and a bad byte order', async () => {
    expect(hasGps((await metadata(plainJpeg)).exif)).toBe(false);
    expect(hasGps(undefined)).toBe(false);
    expect(hasGps(Buffer.from('Exif'))).toBe(false);
    expect(hasGps(gpsExif.subarray(0, 16))).toBe(false);
    expect(hasGps(Buffer.from('XX\0*\0\0\0\x08\0\0', 'latin1'))).toBe(false);
  });

  it('hasLocation also accepts XMP that mentions GPSLatitude', () => {
    expect(hasLocation({ exif: gpsExif })).toBe(true);
    expect(hasLocation({ xmp: Buffer.from('<rdf:Description exif:GPSLatitude="51,30.0N"/>') })).toBe(true);
    expect(hasLocation({ xmp: Buffer.from('<rdf:Description dc:title="Ian"/>') })).toBe(false);
    expect(hasLocation({})).toBe(false);
  });
});

describe('media/imaging processFile', () => {
  it('re-encodes a JPEG with GPS: no EXIF, upright, with WebP display and thumbnail images', async () => {
    const result = await processFile(gpsJpeg);
    expect(result.sha256).toBe(sha256Hex(gpsJpeg));
    expect(result.type).toBe(TYPES.get('jpg'));
    expect(result.original.reencoded).toBe(true);
    const original = await metadata(result.original.body);
    expect(original.format).toBe('jpeg');
    expect(original.exif).toBeUndefined();
    expect([original.width, original.height]).toEqual([200, 400]);
    expect([result.width, result.height]).toEqual([200, 400]);
    const display = await metadata(result.display);
    expect([display.format, display.width, display.height]).toEqual(['webp', 200, 400]);
    expect(display.exif).toBeUndefined();
    const thumb = await metadata(result.thumb);
    expect(thumb.format).toBe('webp');
    expect(longEdge(thumb)).toBeLessThanOrEqual(THUMB_SIZE);
  });

  it('re-encodes a JPEG whose XMP has a location, dropping the XMP', async () => {
    expect((await metadata(xmpJpeg)).xmp).toBeDefined();
    const result = await processFile(xmpJpeg);
    expect(result.original.reencoded).toBe(true);
    expect((await metadata(result.original.body)).xmp).toBeUndefined();
  });

  it('stores a JPEG without location byte for byte, with the oriented size (orientation 6 swaps it)', async () => {
    const result = await processFile(plainJpeg);
    expect(result.original.reencoded).toBe(false);
    expect(result.original.body.equals(plainJpeg)).toBe(true);
    expect([result.width, result.height]).toEqual([200, 400]);
    const display = await metadata(result.display);
    expect([display.width, display.height]).toEqual([200, 400]);
  });

  it('keeps the ICC profile when it re-encodes a JPEG with GPS', async () => {
    const icc = (await metadata(iccGpsJpeg)).icc;
    expect(icc).toBeDefined();
    const result = await processFile(iccGpsJpeg);
    expect(result.original.reencoded).toBe(true);
    const original = await metadata(result.original.body);
    expect(original.exif).toBeUndefined();
    expect(original.icc?.equals(icc)).toBe(true);
  });

  it('stores a PNG without location unchanged', async () => {
    const result = await processFile(plainPng);
    expect(result.type).toBe(TYPES.get('png'));
    expect(result.original).toEqual({ body: plainPng, reencoded: false });
    expect([result.width, result.height]).toEqual([400, 200]);
    expect((await metadata(result.display)).format).toBe('webp');
  });

  it('re-encodes a PNG with GPS EXIF, dropping the EXIF', async () => {
    expect(hasGps((await metadata(gpsPng)).exif)).toBe(true);
    const result = await processFile(gpsPng);
    expect(result.type).toBe(TYPES.get('png'));
    expect(result.original.reencoded).toBe(true);
    const original = await metadata(result.original.body);
    expect([original.format, original.width, original.height]).toEqual(['png', 400, 200]);
    expect(original.exif).toBeUndefined();
    expect(result.original.body.includes('eXIf')).toBe(false);
  });

  it('shrinks the display image to DISPLAY_SIZE on the long edge, and the thumbnail to THUMB_SIZE', async () => {
    const big = await sharp({ create: { width: 3000, height: 1500, channels: 3, background: '#36c' } }).png().toBuffer();
    const result = await processFile(big);
    expect([result.width, result.height]).toEqual([3000, 1500]);
    const display = await metadata(result.display);
    expect([display.width, display.height]).toEqual([DISPLAY_SIZE, DISPLAY_SIZE / 2]);
    const thumb = await metadata(result.thumb);
    expect([thumb.width, thumb.height]).toEqual([THUMB_SIZE, THUMB_SIZE / 2]);
  });

  it("re-encodes a TIFF with GPS, found in the file's own IFD0, and the re-encode has no GPS IFD", async () => {
    expect(tiffTags(gpsTiff)[0]).toContain(0x8825);
    // sharp's metadata never shows a TIFF's EXIF, so this has to come from the bytes.
    const meta = await metadata(gpsTiff);
    expect(meta.exif).toBeUndefined();
    expect(hasLocation(meta)).toBe(false);
    const result = await processFile(gpsTiff);
    expect(result.type).toBe(TYPES.get('tif'));
    expect(result.original.reencoded).toBe(true);
    expect(sniff(result.original.body)).toBe(TYPES.get('tif'));
    expect(tiffTags(result.original.body).flat()).not.toContain(0x8825);
    expect([result.width, result.height]).toEqual([4, 4]);
  });

  it('stores a TIFF without GPS byte for byte', async () => {
    expect(tiffTags(plainTiff).flat()).not.toContain(0x8825);
    const result = await processFile(plainTiff);
    expect(result.type).toBe(TYPES.get('tif'));
    expect(result.original).toEqual({ body: plainTiff, reencoded: false });
    expect([result.width, result.height]).toEqual([400, 200]);
    expect((await metadata(result.display)).format).toBe('webp');
  });

  it('finds GPS in any IFD of a TIFF: GPS only on page 2 is re-encoded, keeping both pages', async () => {
    expect(tiffTags(gpsOnPage2Tiff).map((tags) => tags.includes(0x8825))).toEqual([false, true]);
    expect(hasGps(gpsOnPage2Tiff)).toBe(false); // hasGps reads IFD0 only, which is right for an EXIF block
    const result = await processFile(gpsOnPage2Tiff);
    expect(result.original.reencoded).toBe(true);
    const pages = tiffTags(result.original.body);
    expect(pages).toHaveLength(2);
    expect(pages.flat()).not.toContain(0x8825);
  });

  it('stops at a loop in the IFD chain: a looping TIFF without GPS is stored unchanged', async () => {
    const looped = Buffer.from(twoPageTiff);
    const second = looped.readUInt32LE(8 + 2 + 9 * 12); // multiPageTiff's IFD0 is at 8, with 9 entries
    looped.writeUInt32LE(8, second + 2 + 9 * 12); // page 2's next IFD is page 1 again
    const result = await processFile(looped);
    expect(result.original).toEqual({ body: looped, reencoded: false });
  });

  it('re-encodes a GPS TIFF with orientation 6 upright, as its first page only', async () => {
    expect(tiffTags(turnedGpsTiff)).toHaveLength(2);
    const result = await processFile(turnedGpsTiff);
    expect(result.original.reencoded).toBe(true);
    expect([result.width, result.height]).toEqual([30, 40]);
    const original = await metadata(result.original.body, { pages: -1 });
    expect([original.width, original.height, original.orientation ?? 1]).toEqual([30, 40, 1]);
    const pages = tiffTags(result.original.body);
    expect(pages).toHaveLength(1); // .rotate() can't turn a multi-page image, so page 2 is lost
    expect(pages.flat()).not.toContain(0x8825);
  });

  it('stores a TIFF without GPS whose pages differ in size byte for byte, showing its first page', async () => {
    const result = await processFile(mixedTiff);
    expect(result.original).toEqual({ body: mixedTiff, reencoded: false });
    expect([result.width, result.height]).toEqual([40, 30]);
    const display = await metadata(result.display);
    expect([display.width, display.height]).toEqual([40, 30]);
  });

  it('re-encodes a GIF whose bytes mention GPSLatitude, keeping both frames and dropping the XMP', async () => {
    // sharp's metadata never shows a GIF's XMP, so this has to come from the bytes.
    const meta = await metadata(xmpGif);
    expect(meta.xmp).toBeUndefined();
    expect(meta.pages).toBe(2);
    expect(xmpGif.includes('GPSLatitude')).toBe(true);
    const result = await processFile(xmpGif);
    expect(result.type).toBe(TYPES.get('gif'));
    expect(result.original.reencoded).toBe(true);
    const original = await metadata(result.original.body);
    expect([original.format, original.pages, original.width, original.height]).toEqual(['gif', 2, 40, 30]);
    expect(result.original.body.includes('GPSLatitude')).toBe(false);
    expect([result.width, result.height]).toEqual([40, 30]);
  });

  it('stores an animated GIF with no XMP unchanged, and makes the display image from its first frame', async () => {
    expect((await metadata(animatedGif)).pages).toBe(2);
    const result = await processFile(animatedGif);
    expect(result.type).toBe(TYPES.get('gif'));
    expect(result.original).toEqual({ body: animatedGif, reencoded: false });
    expect([result.width, result.height]).toEqual([40, 30]);
    const display = await metadata(result.display);
    expect([display.format, display.width, display.height]).toEqual(['webp', 40, 30]);
    expect(display.pages ?? 1).toBe(1);
  });

  it('takes a Uint8Array as well as a Buffer', async () => {
    const tiff = await processFile(asUint8Array(gpsTiff));
    expect(tiff.sha256).toBe(sha256Hex(gpsTiff));
    expect(tiff.original.reencoded).toBe(true);
    expect(tiffTags(tiff.original.body).flat()).not.toContain(0x8825);
    const gifBytes = asUint8Array(xmpGif);
    expect(Buffer.isBuffer(gifBytes)).toBe(false);
    const gif = await processFile(gifBytes);
    expect(gif.sha256).toBe(sha256Hex(xmpGif));
    expect(gif.original.reencoded).toBe(true);
    expect(gif.original.body.includes('GPSLatitude')).toBe(false);
    const plain = await processFile(asUint8Array(plainJpeg));
    expect(plain.original.reencoded).toBe(false);
    expect(Buffer.isBuffer(plain.original.body) && plain.original.body.equals(plainJpeg)).toBe(true);
  });

  it('stores a PDF unchanged, with no display image, thumbnail or size', async () => {
    const result = await processFile(pdf);
    expect(result).toEqual({
      sha256: sha256Hex(pdf), type: TYPES.get('pdf'), original: { body: pdf, reencoded: false },
      display: null, thumb: null, width: null, height: null
    });
    expect(result.original.body).toBe(pdf);
  });

  it('refuses the same things inspect does', async () => {
    expect((await imagingError(() => processFile(Buffer.alloc(0)))).code).toBe('empty');
    expect((await imagingError(() => processFile(heic))).code).toBe('heic_unsupported');
    expect((await imagingError(() => processFile(notAnImage))).code).toBe('unsupported_type');
  });

  it('gives a permanent unreadable for a JPEG header followed by garbage', async () => {
    const e = await imagingError(() => processFile(brokenJpeg));
    expect(e).toMatchObject({ code: 'unreadable', status: 400, permanent: true });
  });

  it('gives too_many_pixels for a header of LIMIT_PIXELS + 1 pixels', async () => {
    const header = pngHeader(17, 5_882_353); // 17 × 5,882,353 = 100,000,001
    const e = await imagingError(() => processFile(header));
    expect(e).toMatchObject({ code: 'too_many_pixels', status: 400, permanent: true });
  });

  it('honours an injected limitInputPixels', async () => {
    const small = await sharp({ create: { width: 100, height: 100, channels: 3, background: '#000' } }).png().toBuffer();
    expect((await imagingError(() => processFile(small, { limitInputPixels: 1000 }))).code).toBe('too_many_pixels');
    await expect(processFile(small, { limitInputPixels: 10_000 })).resolves.toMatchObject({ width: 100, height: 100 });
  });
});

describe('media/imaging reencodeWithoutMetadata', () => {
  it('keeps both pages of a two-page TIFF', async () => {
    const out = await reencodeWithoutMetadata(twoPageTiff, TYPES.get('tif'), await sharp(twoPageTiff).metadata());
    expect((await sharp(out, { pages: -1 }).metadata()).pages).toBe(2);
  });

  it('gives unreadable for a TIFF whose pages differ in size', async () => {
    const e = await imagingError(async () => reencodeWithoutMetadata(mixedTiff, TYPES.get('tif'), await sharp(mixedTiff).metadata()));
    expect(e).toMatchObject({ code: 'unreadable', permanent: true });
  });

  it('keeps every frame of an animated GIF', async () => {
    const out = await reencodeWithoutMetadata(animatedGif, TYPES.get('gif'), await metadata(animatedGif));
    const meta = await metadata(out);
    expect([meta.format, meta.pages]).toEqual(['gif', 2]);
  });

  it('honours limitInputPixels', async () => {
    const e = await imagingError(async () => reencodeWithoutMetadata(plainPng, TYPES.get('png'), await metadata(plainPng), 1000));
    expect(e.code).toBe('too_many_pixels');
  });
});

describe('media/imaging derivatives', () => {
  it('makes the display image and thumbnail, with the oriented size', async () => {
    const result = await derivatives(gpsJpeg);
    expect(Object.keys(result).sort()).toEqual(['display', 'height', 'thumb', 'width']);
    expect([result.width, result.height]).toEqual([200, 400]);
    const display = await metadata(result.display);
    expect([display.format, display.width, display.height]).toEqual(['webp', 200, 400]);
    expect(longEdge(await metadata(result.thumb))).toBeLessThanOrEqual(THUMB_SIZE);
  });

  it('gives unreadable for bytes sharp cannot read', async () => {
    expect((await imagingError(() => derivatives(brokenJpeg))).code).toBe('unreadable');
    expect((await imagingError(() => derivatives(pdf))).code).toBe('unreadable');
  });
});

describe('media/imaging renderAvatar', () => {
  it('renders a square crop of the oriented image as a 400×400 WebP with no EXIF', async () => {
    // The oriented image is 200×400, so w·W = 200 and h·H = 200.
    const avatar = await renderAvatar(plainJpeg, { x: 0, y: 0.25, w: 1, h: 0.5 });
    const meta = await metadata(avatar);
    expect([meta.format, meta.width, meta.height]).toEqual(['webp', AVATAR_SIZE, AVATAR_SIZE]);
    expect(meta.exif).toBeUndefined();
  });

  it('crops the upright image: the top square of the two-tone photo is blue, the bottom one green', async () => {
    const [topRed, topGreen, topBlue] = await meanColour(await renderAvatar(twoTone, { x: 0, y: 0, w: 1, h: 0.5 }));
    expect(topBlue).toBeGreaterThan(220);
    expect(Math.max(topRed, topGreen)).toBeLessThan(30);
    const [bottomRed, bottomGreen, bottomBlue] = await meanColour(await renderAvatar(twoTone, { x: 0, y: 0.5, w: 1, h: 0.5 }));
    expect(bottomGreen).toBeGreaterThan(220);
    expect(Math.max(bottomRed, bottomBlue)).toBeLessThan(30);
  });

  it('takes a Uint8Array as well as a Buffer', async () => {
    const meta = await metadata(await renderAvatar(asUint8Array(plainJpeg), { x: 0, y: 0.25, w: 1, h: 0.5 }));
    expect([meta.width, meta.height]).toEqual([AVATAR_SIZE, AVATAR_SIZE]);
    const result = await derivatives(asUint8Array(gpsJpeg));
    expect([result.width, result.height]).toEqual([200, 400]);
  });

  it('lets CropError through, checking the crop before reading the image', async () => {
    await expect(renderAvatar(plainJpeg, { x: 0, y: 0, w: 1, h: 1 })).rejects.toBeInstanceOf(CropError); // 200×400
    await expect(renderAvatar(brokenJpeg, { x: -1, y: 0, w: 0.5, h: 0.5 })).rejects.toBeInstanceOf(CropError);
  });

  it('gives unreadable for bytes sharp cannot read', async () => {
    expect((await imagingError(() => renderAvatar(brokenJpeg, { x: 0, y: 0, w: 1, h: 1 }))).code).toBe('unreadable');
  });

  it('honours limitInputPixels', async () => {
    const e = await imagingError(() => renderAvatar(plainJpeg, { x: 0, y: 0.25, w: 1, h: 0.5 }, { limitInputPixels: 1000 }));
    expect(e.code).toBe('too_many_pixels');
  });
});
