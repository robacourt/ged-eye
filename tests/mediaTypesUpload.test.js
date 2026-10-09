// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  MAX_UPLOAD_BYTES, TYPES, UUID, SHA256, sniff, declaredType, cleanFileName, inlineDisposition
} from '../media/types.js';

const ascii = (text) => [...text].map((c) => c.charCodeAt(0));
const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const bytes = (...parts) => Uint8Array.from(parts.flatMap((p) => (typeof p === 'string' ? ascii(p) : p)));

/** An ISO-BMFF file: an `ftyp` box (size overridable) followed by `tail`. */
function isoFile(major, compatible = [], { size, tail = [] } = {}) {
  const body = [...ascii('ftyp'), ...ascii(major), ...u32(0), ...compatible.flatMap(ascii)];
  return bytes(u32(size ?? body.length + 4), body, tail);
}

const codeOf = (fn) => {
  try {
    fn();
  } catch (e) {
    return e.code;
  }
  return undefined;
};

describe('media/types TYPES', () => {
  it('lists the seven accepted types by their stored extension', () => {
    expect(MAX_UPLOAD_BYTES).toBe(50 * 1024 * 1024);
    expect([...TYPES.keys()]).toEqual(['jpg', 'png', 'webp', 'gif', 'tif', 'avif', 'pdf']);
    for (const [ext, type] of TYPES) expect(type.ext).toBe(ext);
    expect(TYPES.get('jpg')).toEqual({ ext: 'jpg', contentType: 'image/jpeg', image: true });
    expect(TYPES.get('tif').contentType).toBe('image/tiff');
    expect(TYPES.get('pdf')).toEqual({ ext: 'pdf', contentType: 'application/pdf', image: false });
    expect([...TYPES.values()].filter((t) => !t.image).map((t) => t.ext)).toEqual(['pdf']);
  });
});

describe('media/types sniff', () => {
  const ext = (data) => sniff(data)?.ext;

  it('recognises each format by its magic numbers', () => {
    expect(sniff(bytes([0xff, 0xd8, 0xff, 0xe0], 'JFIF'))).toBe(TYPES.get('jpg'));
    expect(ext(bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]))).toBe('png');
    expect(ext(bytes('GIF87a', [1, 0, 1, 0]))).toBe('gif');
    expect(ext(bytes('GIF89a', [1, 0, 1, 0]))).toBe('gif');
    expect(ext(bytes('RIFF', [0x24, 0, 0, 0], 'WEBPVP8 '))).toBe('webp');
    expect(ext(bytes('II*', [0], [8, 0, 0, 0]))).toBe('tif');
    expect(ext(bytes('MM', [0], '*', [0, 0, 0, 8]))).toBe('tif');
    expect(ext(bytes('%PDF-1.7\n'))).toBe('pdf');
  });

  it('accepts a Buffer as well as a Uint8Array', () => {
    expect(ext(Buffer.from('%PDF-1.4'))).toBe('pdf');
  });

  it('refuses near misses', () => {
    expect(sniff(bytes('RIFF', [0, 0, 0, 0], 'WAVEfmt '))).toBeNull();
    expect(sniff(bytes('RIFF', [0, 0, 0, 0], 'WEB'))).toBeNull();
    expect(sniff(bytes('GIF88a'))).toBeNull();
    expect(sniff(bytes('II', [0, 0]))).toBeNull();
    expect(sniff(bytes('MM*', [0]))).toBeNull();
    expect(sniff(bytes(' %PDF-1.4'))).toBeNull();
    expect(sniff(bytes('%PDF'))).toBeNull();
    expect(sniff(bytes('<html><body>'))).toBeNull();
  });

  it('handles empty and very short input without reading past the end', () => {
    expect(sniff(new Uint8Array(0))).toBeNull();
    expect(sniff(bytes([0xff, 0xd8, 0xff]))).toBe(TYPES.get('jpg')); // three bytes is enough for a JPEG
    expect(sniff(bytes([0x89, 0x50, 0x4e]))).toBeNull(); // but not for a PNG
    expect(sniff(bytes([0, 0, 0]))).toBeNull();
    expect(sniff(bytes(u32(16), 'ftyp'))).toBeNull(); // ftyp with no brand at all
    expect(sniff(bytes(u32(24), 'ftypav'))).toBeNull(); // a truncated brand
  });

  it('reads AVIF from the major brand', () => {
    expect(sniff(isoFile('avif'))).toBe(TYPES.get('avif'));
    expect(ext(isoFile('avis'))).toBe('avif');
  });

  it('reads AVIF from the compatible brands, even when the major brand is mif1', () => {
    expect(ext(isoFile('mif1', ['miaf', 'mif1', 'avif']))).toBe('avif');
    expect(ext(isoFile('mif1', ['avis']))).toBe('avif');
    expect(ext(isoFile('isom', ['iso2', 'avif']))).toBe('avif');
  });

  it("returns 'heic' for the HEIF family when no AVIF brand is present", () => {
    for (const brand of ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1']) {
      expect(sniff(isoFile(brand))).toBe('heic');
    }
    expect(sniff(isoFile('mif1', ['heic']))).toBe('heic');
    expect(sniff(isoFile('isom', ['iso2', 'msf1']))).toBe('heic');
  });

  it('refuses other ISO-BMFF files, such as MP4 video', () => {
    expect(sniff(isoFile('isom', ['iso2', 'avc1', 'mp41']))).toBeNull();
    expect(sniff(isoFile('M4A ', ['mp42']))).toBeNull();
  });

  it('reads brands only inside the ftyp box', () => {
    // The box is 16 bytes (major brand only); the "avif" after it is the next box's data.
    expect(sniff(isoFile('isom', [], { size: 16, tail: ascii('avif') }))).toBeNull();
    // A size below 16 means no compatible brands either.
    expect(sniff(isoFile('isom', ['avif'], { size: 8 }))).toBeNull();
    expect(sniff(isoFile('heic', ['avif'], { size: 12 }))).toBe('heic');
    // A size past the end of the bytes given is clamped to what is there.
    expect(ext(isoFile('mif1', ['avif'], { size: 4096 }))).toBe('avif');
  });
});

describe('media/types declaredType', () => {
  it('signs the accepted content types as they are', () => {
    for (const { contentType } of TYPES.values()) expect(declaredType(contentType)).toBe(contentType);
  });

  it("treats the non-standard 'image/jpg' as image/jpeg", () => {
    expect(declaredType('image/jpg')).toBe('image/jpeg');
  });

  it('is not fussy about case or surrounding space', () => {
    expect(declaredType(' IMAGE/PNG ')).toBe('image/png');
  });

  it("signs application/octet-stream for '' (the browser doesn't know the type)", () => {
    expect(declaredType('')).toBe('application/octet-stream');
  });

  it('refuses HEIC and HEIF with heic_unsupported', () => {
    expect(codeOf(() => declaredType('image/heic'))).toBe('heic_unsupported');
    expect(codeOf(() => declaredType('image/heif'))).toBe('heic_unsupported');
    expect(codeOf(() => declaredType('IMAGE/HEIC'))).toBe('heic_unsupported');
  });

  it('refuses everything else with unsupported_type', () => {
    for (const value of ['text/html', 'image/svg+xml', 'video/mp4', 'application/octet-stream', 'image/bmp', 'garbage']) {
      expect(codeOf(() => declaredType(value))).toBe('unsupported_type');
    }
    expect(codeOf(() => declaredType(undefined))).toBe('unsupported_type');
    expect(codeOf(() => declaredType(7))).toBe('unsupported_type');
  });

  it('throws errors that carry a 400 status, like the other upload rejections', () => {
    try {
      declaredType('text/html');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect(e).toMatchObject({ code: 'unsupported_type', status: 400 });
    }
  });
});

describe('media/types cleanFileName', () => {
  it('returns a good name unchanged', () => {
    expect(cleanFileName('Folio 14 page 20.JPG')).toBe('Folio 14 page 20.JPG');
  });

  it('trims surrounding white space', () => {
    expect(cleanFileName('  Ian.jpg \n')).toBe('Ian.jpg');
  });

  it('refuses empty and blank names', () => {
    expect(cleanFileName('')).toBeNull();
    expect(cleanFileName('   ')).toBeNull();
  });

  it('refuses path separators', () => {
    expect(cleanFileName('a/b.jpg')).toBeNull();
    expect(cleanFileName('a\\b.jpg')).toBeNull();
    expect(cleanFileName('../b.jpg')).toBeNull();
  });

  it('refuses control characters', () => {
    expect(cleanFileName('a\u0000.jpg')).toBeNull();
    expect(cleanFileName('a\nb.jpg')).toBeNull();
    expect(cleanFileName('a\tb.jpg')).toBeNull();
    expect(cleanFileName('a\u007f.jpg')).toBeNull();
    expect(cleanFileName('a\u0085.jpg')).toBeNull();
  });

  it('allows 255 characters but not 256', () => {
    expect(cleanFileName('a'.repeat(255))).toBe('a'.repeat(255));
    expect(cleanFileName('a'.repeat(256))).toBeNull();
    expect(cleanFileName(` ${'a'.repeat(255)} `)).toBe('a'.repeat(255));
  });

  it('allows emoji and other non-ASCII names', () => {
    expect(cleanFileName('Ian 📷 café.jpg')).toBe('Ian 📷 café.jpg');
    expect(cleanFileName('写真.png')).toBe('写真.png');
  });

  it('refuses an unpaired surrogate', () => {
    expect(cleanFileName('a\uD83D.jpg')).toBeNull();
    expect(cleanFileName('a\uDCF7.jpg')).toBeNull();
  });

  it('refuses anything that is not a string', () => {
    for (const value of [undefined, null, 7, {}, ['a.jpg']]) expect(cleanFileName(value)).toBeNull();
  });
});

describe('media/types inlineDisposition', () => {
  it('percent-encodes the name as an RFC 5987 extended value', () => {
    expect(inlineDisposition('Ian photo.jpg')).toBe("inline; filename*=UTF-8''Ian%20photo.jpg");
  });

  it("encodes the apostrophe, which would otherwise end the value's language field", () => {
    expect(inlineDisposition("Ian's photo.jpg")).toBe("inline; filename*=UTF-8''Ian%27s%20photo.jpg");
  });

  it('encodes parentheses, asterisks and percent signs too', () => {
    expect(inlineDisposition('a(1)*100%.jpg')).toBe("inline; filename*=UTF-8''a%281%29%2A100%25.jpg");
  });

  it('encodes non-ASCII characters as UTF-8, so the header stays ASCII', () => {
    expect(inlineDisposition('📷 café.pdf')).toBe("inline; filename*=UTF-8''%F0%9F%93%B7%20caf%C3%A9.pdf");
    expect(inlineDisposition('写真 (1).png')).toMatch(/^[\x20-\x7e]*$/);
  });

  it('leaves letters, digits and - _ . ~ ! alone', () => {
    expect(inlineDisposition('Abc-09_x.y~z!.pdf')).toBe("inline; filename*=UTF-8''Abc-09_x.y~z!.pdf");
  });
});

describe('media/types UUID and SHA256', () => {
  it('matches lower-case UUIDs only', () => {
    expect(UUID.test('123e4567-e89b-12d3-a456-426614174000')).toBe(true);
    expect(UUID.test('123E4567-E89B-12D3-A456-426614174000')).toBe(false);
    expect(UUID.test('123e4567-e89b-12d3-a456-42661417400')).toBe(false);
    expect(UUID.test('123e4567e89b12d3a456426614174000')).toBe(false);
    expect(UUID.test('123e4567-e89b-12d3-a456-426614174000/..')).toBe(false);
    expect(UUID.test('')).toBe(false);
  });

  it('matches 64 lower-case hex digits only', () => {
    expect(SHA256.test('a'.repeat(64))).toBe(true);
    expect(SHA256.test('0123456789abcdef'.repeat(4))).toBe(true);
    expect(SHA256.test('a'.repeat(63))).toBe(false);
    expect(SHA256.test('a'.repeat(65))).toBe(false);
    expect(SHA256.test('A'.repeat(64))).toBe(false);
    expect(SHA256.test(`${'a'.repeat(63)}g`)).toBe(false);
    expect(SHA256.test(`${'a'.repeat(64)}\n`)).toBe(false);
  });
});
