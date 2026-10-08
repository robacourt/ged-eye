// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { extOf, contentTypeFor, isDisplayable, contentDisposition, objectKeyFor } from '../scripts/neon/mediaTypes.js';

describe('mediaTypes', () => {
  it('extracts lower-case extensions', () => {
    expect(extOf('Folio 14 page 20.JPG')).toBe('jpg');
    expect(extOf('HO 107 1931 149 80 29jpg')).toBe('');
  });
  it('maps content types with an octet-stream fallback', () => {
    expect(contentTypeFor('a.jpeg')).toBe('image/jpeg');
    expect(contentTypeFor('a.docx')).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(contentTypeFor('a.tif')).toBe('image/tiff');
    expect(contentTypeFor('noext')).toBe('application/octet-stream');
  });
  it('treats only browser-displayable images as displayable', () => {
    expect(isDisplayable('a.png')).toBe(true);
    expect(isDisplayable('a.jfif')).toBe(true);
    expect(isDisplayable('a.tif')).toBe(false);
    expect(isDisplayable('a.htm')).toBe(false);
  });
  it('builds inline or attachment dispositions with an encoded filename', () => {
    expect(contentDisposition('Folio 14.jpg')).toBe("inline; filename*=UTF-8''Folio%2014.jpg");
    expect(contentDisposition("Ian's notes.docx")).toBe("attachment; filename*=UTF-8''Ian's%20notes.docx");
  });
  it('builds content-addressed object keys', () => {
    expect(objectKeyFor('abc', 'x.JPG')).toBe('originals/abc.jpg');
    expect(objectKeyFor('abc', 'noext')).toBe('originals/abc');
  });
});
