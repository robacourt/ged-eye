import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mediaUrl, thumbUrl, displayUrl, avatarUrl, isImage } from '../src/media.js';

describe('media urls', () => {
  beforeEach(() => vi.stubEnv('VITE_MEDIA_BASE_URL', 'https://media.test/bucket'));
  afterEach(() => vi.unstubAllEnvs());

  describe('displayUrl', () => {
    it('uses the display image', () => {
      const photo = { key: 'originals/a.jpg', displayKey: 'display/a.webp', thumbKey: 'thumbs/a.webp' };
      expect(displayUrl(photo)).toBe('https://media.test/bucket/display/a.webp');
    });

    it('falls back to the original for an image without a display image yet', () => {
      expect(displayUrl({ key: 'originals/a b.jpg', displayKey: null, thumbKey: 'thumbs/a.webp' }))
        .toBe('https://media.test/bucket/originals/a%20b.jpg');
      expect(displayUrl({ key: 'originals/a.jpg', thumbKey: 'thumbs/a.webp' }))
        .toBe('https://media.test/bucket/originals/a.jpg');
    });

    it('is null for a document with no display image, or for no photo', () => {
      expect(displayUrl({ key: 'originals/a.pdf', displayKey: null, thumbKey: null })).toBeNull();
      expect(displayUrl({ key: 'originals/a.pdf' })).toBeNull();
      expect(displayUrl(null)).toBeNull();
      expect(displayUrl(undefined)).toBeNull();
    });
  });

  describe('isImage', () => {
    it('is true with a thumbnail or a display image', () => {
      expect(isImage({ thumbKey: 'thumbs/a.webp' })).toBe(true);
      expect(isImage({ displayKey: 'display/a.webp' })).toBe(true);
      expect(isImage({ thumbKey: 'thumbs/a.webp', displayKey: 'display/a.webp' })).toBe(true);
    });

    it('is false for a document, and always a boolean', () => {
      expect(isImage({ key: 'originals/a.pdf', thumbKey: null, displayKey: null })).toBe(false);
      expect(isImage({ key: 'originals/a.pdf' })).toBe(false);
      expect(isImage({ thumbKey: '', displayKey: '' })).toBe(false);
    });
  });

  describe('avatarUrl', () => {
    it('uses the person\'s avatar', () => {
      expect(avatarUrl({ avatarKey: 'avatars/abc-0123456789ab.webp', sex: 'F' }))
        .toBe('https://media.test/bucket/avatars/abc-0123456789ab.webp');
    });

    it('falls back to the placeholder for the person\'s sex', () => {
      const base = import.meta.env.BASE_URL;
      expect(avatarUrl({ sex: 'F' })).toBe(`${base}placeholders/woman.png`);
      expect(avatarUrl({ sex: 'M', avatarKey: null })).toBe(`${base}placeholders/man.png`);
      expect(avatarUrl({ sex: 'U' })).toBe(`${base}placeholders/man.png`);
      expect(avatarUrl({})).toBe(`${base}placeholders/man.png`);
    });
  });

  it('keeps the existing url builders', () => {
    expect(mediaUrl('originals/a b.jpg')).toBe('https://media.test/bucket/originals/a%20b.jpg');
    expect(thumbUrl({ thumbKey: 'thumbs/x.webp' })).toBe('https://media.test/bucket/thumbs/x.webp');
  });
});
