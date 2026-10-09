// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  photoItem, addPhotosParams, updatePhotoParams, removePhotoParams, setAvatarParams, clearAvatarParams
} from '../src/photoParams.js';

const SHA = 'a'.repeat(64);
const CROP = { x: 0.1, y: 0.2, w: 0.5, h: 0.4 };
const AVATAR_KEY = `avatars/${SHA}-0123456789ab.webp`;

/** A processed upload, as mediaApi.processUpload gives it. */
const media = (extra = {}) => ({
  mediaId: null,
  sha256: SHA,
  ext: 'jpg',
  objectKey: `originals/${SHA}.jpg`,
  displayKey: `display/${SHA}.webp`,
  thumbKey: `thumbs/${SHA}.webp`,
  contentType: 'image/jpeg',
  byteSize: 1234,
  width: 400,
  height: 300,
  fileName: 'Wedding.jpg',
  caption: null,
  date: null,
  ...extra
});

/** A photo as person_record gives it. */
const PHOTO = {
  id: 42,
  key: `originals/${SHA}.jpg`,
  thumbKey: `thumbs/${SHA}.webp`,
  displayKey: `display/${SHA}.webp`,
  caption: 'At the church',
  date: null,
  people: [{ id: 'I7', name: 'Rose Smith' }, { id: 'I1', name: 'Tom Smith' }]
};

describe('photoItem', () => {
  it('describes a new upload by its sha256, extension and file name, never by object keys', () => {
    expect(photoItem(media(), { caption: 'The wedding', date: '1923', personIds: ['I7', 'I1'] })).toEqual({
      upload: { sha256: SHA, ext: 'jpg', fileName: 'Wedding.jpg' },
      caption: 'The wedding',
      date: '1923',
      personIds: ['I7', 'I1']
    });
  });

  it('sends the media id for a file already in the tree (a dedupe hit), with no upload', () => {
    const item = photoItem(media({ mediaId: 9, caption: 'Shared' }), { caption: null, date: null, personIds: ['I7'] });
    expect(item).toEqual({ mediaId: 9, caption: null, date: null, personIds: ['I7'] });
    expect(item).not.toHaveProperty('upload');
  });

  it('trims the caption and date, and sends empty or missing ones as null', () => {
    expect(photoItem(media(), { caption: '  A picnic ', date: ' ', personIds: ['I7'] }))
      .toMatchObject({ caption: 'A picnic', date: null });
    expect(photoItem(media(), { personIds: ['I7'] })).toMatchObject({ caption: null, date: null });
  });

  it('copies personIds, so a later change to the list given is not sent', () => {
    const personIds = ['I7'];
    const item = photoItem(media(), { caption: null, date: null, personIds });
    personIds.push('I1');
    expect(item.personIds).toEqual(['I7']);
  });
});

describe('addPhotosParams', () => {
  it('sends the person and the photos in order', () => {
    const items = [
      photoItem(media(), { caption: null, date: null, personIds: ['I7'] }),
      photoItem(media({ mediaId: 3 }), { caption: null, date: null, personIds: ['I7', 'I1'] })
    ];
    expect(addPhotosParams('I7', items)).toEqual({ personId: 'I7', photos: items });
  });
});

describe('updatePhotoParams', () => {
  it('sends the new values, the values the photo was opened with as expected, and the focus person', () => {
    expect(updatePhotoParams(PHOTO, { caption: ' At St Mary\'s ', date: 'ABT 1923', personIds: ['I7'] }, 'I7')).toEqual({
      mediaId: 42,
      caption: "At St Mary's",
      date: 'ABT 1923',
      personIds: ['I7'],
      expected: { caption: 'At the church', date: null, personIds: ['I7', 'I1'] },
      focusId: 'I7'
    });
  });

  it('sends expected exactly as read (untrimmed), and missing values as null so they are never dropped', () => {
    const photo = { id: 5, caption: ' spaced ', people: undefined };
    expect(updatePhotoParams(photo, { caption: '', date: '', personIds: ['I2'] }).expected)
      .toEqual({ caption: ' spaced ', date: null, personIds: [] });
  });

  it('sends an emptied caption or date as null', () => {
    expect(updatePhotoParams(PHOTO, { caption: '  ', date: '', personIds: ['I7'] }, 'I7'))
      .toMatchObject({ caption: null, date: null });
  });

  it('leaves out focusId when none is given', () => {
    expect(updatePhotoParams(PHOTO, { caption: null, date: null, personIds: ['I7'] })).not.toHaveProperty('focusId');
  });
});

describe('removePhotoParams', () => {
  it('sends the person and the media id', () => {
    expect(removePhotoParams('I7', PHOTO)).toEqual({ personId: 'I7', mediaId: 42 });
  });
});

describe('setAvatarParams', () => {
  it('sends the media id of an existing photo', () => {
    expect(setAvatarParams('I7', { mediaId: 42 }, CROP, AVATAR_KEY))
      .toEqual({ personId: 'I7', mediaId: 42, crop: CROP, avatarKey: AVATAR_KEY });
  });

  it('sends a fresh upload as one add_photos photo, shown for the person, with no caption or date', () => {
    expect(setAvatarParams('I7', { media: media() }, CROP, AVATAR_KEY)).toEqual({
      personId: 'I7',
      photo: { upload: { sha256: SHA, ext: 'jpg', fileName: 'Wedding.jpg' }, caption: null, date: null, personIds: ['I7'] },
      crop: CROP,
      avatarKey: AVATAR_KEY
    });
  });

  it("sends an upload that was already in the tree as a photo by its media id, so it is linked if it isn't yet", () => {
    expect(setAvatarParams('I7', { media: media({ mediaId: 9, caption: 'Shared' }) }, CROP, AVATAR_KEY)).toEqual({
      personId: 'I7',
      photo: { mediaId: 9, caption: null, date: null, personIds: ['I7'] },
      crop: CROP,
      avatarKey: AVATAR_KEY
    });
  });

  it('throws for a source that is neither a photo nor an upload', () => {
    expect(() => setAvatarParams('I7', {}, CROP, AVATAR_KEY)).toThrow(TypeError);
  });
});

describe('clearAvatarParams', () => {
  it('sends the person', () => {
    expect(clearAvatarParams('I7')).toEqual({ personId: 'I7' });
  });
});
