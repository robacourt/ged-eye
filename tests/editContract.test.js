// @vitest-environment node
// The relative dialog's, unlink confirmation's and photo commands' params, run through the API's own command
// validators (api/commands), so the front end and the server can't drift apart on names, keys or familyId rules.
import { describe, it, expect } from 'vitest';
import { commandFor } from '../api/commands/index.js';
import { avatarKeyFor, validateCrop } from '../media/crop.js';
import { TYPES } from '../media/types.js';
import { familyChoice, relativeParams } from '../src/relativeDialog.js';
import { unlinkParams } from '../src/unlinkConfirm.js';
import {
  photoItem, addPhotosParams, updatePhotoParams, removePhotoParams, setAvatarParams, clearAvatarParams
} from '../src/photoParams.js';

const validate = (kind, params) => commandFor(kind).validate(params);

const person = (extra = {}) => ({ id: 'I7', name: 'Rose Smith', parentFamilies: [], marriages: [], ...extra });
const RELS = {
  parents: [{ id: 'I1', name: 'Tom Smith' }, { id: 'I2', name: 'Ann Jones' }, { id: 'I4', name: 'Mary Brown' }],
  spouses: [{ id: 'I3', name: 'John Brown' }, { id: 'I5', name: 'Paul White' }],
  children: [{ id: 'I11', name: 'Lily Brown' }],
  siblings: []
};

// Every shape of family the dialog chooses among.
const PEOPLE = {
  'no families': person(),
  'one full parent family': person({ parentFamilies: [{ familyId: 'F1', partnerIds: ['I1', 'I2'], childIds: ['I7'] }] }),
  'one open parent family': person({ parentFamilies: [{ familyId: 'F2', partnerIds: ['I2'], childIds: ['I7'] }] }),
  'two open parent families': person({ parentFamilies: [
    { familyId: 'F2', partnerIds: ['I2'], childIds: ['I7'] }, { familyId: 'F3', partnerIds: ['I4'], childIds: ['I7'] }
  ] }),
  'one spouse': person({ marriages: [{ spouseId: 'I3', familyId: 'F5', marriageDate: '1920', childIds: ['I11'] }] }),
  'two spouses and a family without one': person({ marriages: [
    { spouseId: 'I3', familyId: 'F5', childIds: ['I11'] }, { spouseId: 'I5', familyId: 'F6', childIds: [] },
    { spouseId: null, familyId: 'F7', childIds: [] }
  ] })
};

const FIELDS = {
  given_name: ' Tom ', surname: 'Smith', sex: 'M', birth_date: 'ABT 1850', birth_place: 'Leeds', death_date: '1901'
};

/** Every params the dialog can send: each relation, tab, family it may choose, and empty or full fields. */
function dialogCases() {
  const cases = [];
  for (const [who, anchor] of Object.entries(PEOPLE)) {
    for (const relation of ['parent', 'spouse', 'child', 'sibling']) {
      const choice = familyChoice(anchor, RELS, relation);
      if (choice.blocked) continue; // the dialog can't submit
      const families = choice.ask ? choice.options.map(option => option.value) : [choice.value];
      for (const familyId of families) {
        for (const fields of [{}, FIELDS]) {
          cases.push([`${relation} for ${who}, new, family ${familyId}`, relativeParams({ person: anchor, relation, tab: 'new', fields, familyId })]);
        }
        cases.push([`${relation} for ${who}, existing, family ${familyId}`,
          relativeParams({ person: anchor, relation, tab: 'existing', otherId: 'I20', familyId })]);
      }
    }
  }
  return cases;
}

describe('relative dialog params', () => {
  const cases = dialogCases();

  it('covers every relation, both tabs and the family choices', () => {
    expect(cases.length).toBeGreaterThan(50);
    const sent = cases.map(([, { kind, params }]) => `${kind} ${params.relation} ${params.familyId ?? 'none'}`);
    for (const expected of ['add_relative parent none', 'add_relative parent F2', 'add_relative parent F3', 'link_existing spouse none',
      'add_relative child new', 'add_relative child F5', 'link_existing child F6', 'add_relative sibling F1', 'link_existing sibling F3']) {
      expect(sent).toContain(expected);
    }
  });

  it.each(cases)('passes the API validator: %s', (_, { kind, params }) => {
    const clean = validate(kind, params);
    expect(clean.relation).toBe(params.relation);
    expect(clean.anchorId).toBe('I7');
    expect(clean.familyId).toBe(params.familyId ?? null);
    if (kind === 'link_existing') expect(clean.otherId).toBe('I20');
    else expect(clean.person.fields).toEqual(params.person.fields);
  });

  it('sends the new person exactly as the validator stores it', () => {
    const { params } = relativeParams({ person: person(), relation: 'spouse', tab: 'new', fields: FIELDS });
    expect(validate('add_relative', params).person.fields).toEqual({
      given_name: 'Tom', surname: 'Smith', sex: 'M', birth_date: 'ABT 1850', birth_place: 'Leeds', death_date: '1901'
    });
  });

  it('is checked against validators that do refuse what the dialog must never send', () => {
    const spouse = relativeParams({ person: person(), relation: 'spouse', tab: 'existing', otherId: 'I20' }).params;
    expect(() => validate('link_existing', { ...spouse, familyId: 'F5' })).toThrow(/spouse/i);
    const child = relativeParams({ person: person(), relation: 'child', tab: 'new', familyId: 'new' }).params;
    const { familyId, ...withoutFamily } = child;
    expect(familyId).toBe('new');
    expect(() => validate('add_relative', withoutFamily)).toThrow();
    expect(() => validate('add_relative', { ...child, extra: 1 })).toThrow();
    expect(() => validate('add_relative', { ...child, person: { fields: { nickname: 'x' } } })).toThrow();
  });
});

describe('unlink confirmation params', () => {
  const anchor = PEOPLE['two spouses and a family without one'];

  it.each([
    ['parent', 'I1', 'F1', 'partner'],
    ['spouse', 'I3', 'F5', 'partner'],
    ['child', 'I11', 'F5', 'child']
  ])('passes the API validator: %s', (relation, personId, familyId, role) => {
    const params = unlinkParams({ person: anchor, relation, personId, familyId });
    expect(validate('unlink', params)).toEqual({ familyId, personId, role, focusId: 'I7' });
  });
});

// The five photo commands' params, as photoParams.js builds them for the Add photos sheet, the photo editor,
// Change avatar and main.js's Remove: each runs through the API's validator, which must keep exactly what was sent.
describe('photo command params', () => {
  const SHA = 'ab'.repeat(32);
  const OTHER_SHA = 'cd'.repeat(32);
  const CROP = { x: 0.1, y: 0.2, w: 0.5, h: 0.375 };

  /** A processed upload, as mediaApi.processUpload gives it: new, or (`mediaId`) already in the tree. */
  const media = (extra = {}) => ({
    mediaId: null, sha256: SHA, ext: 'jpg', objectKey: `originals/${SHA}.jpg`, displayKey: `display/${SHA}.webp`,
    thumbKey: `thumbs/${SHA}.webp`, contentType: 'image/jpeg', byteSize: 1234, width: 400, height: 300,
    fileName: 'Wedding day.jpg', caption: null, date: null, ...extra
  });

  /** A photo as person_record gives it. */
  const PHOTO = {
    id: 42, key: `originals/${SHA}.jpg`, thumbKey: `thumbs/${SHA}.webp`, displayKey: `display/${SHA}.webp`,
    fileName: 'Wedding day.jpg', contentType: 'image/jpeg', caption: 'At the church', date: null, width: 400, height: 300,
    people: [{ id: 'I7', name: 'Rose Smith' }, { id: 'I1', name: 'Tom Smith' }]
  };

  /** What validatePhoto keeps of a photoItem: exactly what was sent. */
  const kept = (item) => ({
    upload: item.upload ?? null, mediaId: item.mediaId ?? null, caption: item.caption, date: item.date, personIds: item.personIds
  });

  describe('add_photos', () => {
    const cases = [
      ['a new upload, with no caption or date', [photoItem(media(), { personIds: ['I7'] })]],
      ['a new upload with a caption, a date and more people', [
        photoItem(media(), { caption: '  The wedding ', date: ' ABT 1923 ', personIds: ['I7', 'I1', 'I3'] })
      ]],
      ['a file already in the tree, with blank fields', [photoItem(media({ mediaId: 17 }), { caption: ' ', date: '', personIds: ['I7'] })]],
      ...[...TYPES.keys()].map((ext) => [`a new .${ext}`, [
        photoItem(media({ ext, fileName: `scan.${ext}` }), { caption: 'Scan', personIds: ['I7'] })
      ]]),
      ['a full batch of 20, new and existing', Array.from({ length: 20 }, (_, i) => (i % 4 === 0
        ? photoItem(media({ mediaId: i + 1 }), { personIds: ['I7'] })
        : photoItem(media({ sha256: i.toString(16).padStart(64, '0'), fileName: `photo ${i}.jpg` }), { personIds: ['I7', 'I1'] })))]
    ];

    it.each(cases)('passes the API validator: %s', (_, items) => {
      const params = addPhotosParams('I7', items);
      expect(validate('add_photos', params)).toEqual({ personId: 'I7', photos: items.map(kept) });
    });

    it('sends captions and dates trimmed, with blank as null', () => {
      const [{ caption, date }] = validate('add_photos', addPhotosParams('I7', [
        photoItem(media(), { caption: '  The wedding ', date: '   ', personIds: ['I7'] })
      ])).photos;
      expect({ caption, date }).toEqual({ caption: 'The wedding', date: null });
    });
  });

  describe('update_photo', () => {
    /** As the photo editor opens a photo from an older view: shown for the person whose viewer it is in. */
    const older = { id: 43, key: `originals/${OTHER_SHA}.jpg`, thumbKey: `thumbs/${OTHER_SHA}.webp`, people: [{ id: 'I7', name: 'Rose Smith' }] };

    it.each([
      ['a new caption and date, and another person', PHOTO, { caption: ' New caption ', date: '1923', personIds: ['I7', 'I1', 'I3'] }, 'I7'],
      ['clearing the caption, and a person removed', PHOTO, { caption: '', date: '', personIds: ['I1'] }, 'I7'],
      ['no focus', PHOTO, { caption: 'At the church', date: 'JUN 1923', personIds: ['I7', 'I1'] }, undefined],
      ['a photo from an older view', older, { caption: 'Found it', date: null, personIds: ['I7'] }, 'I7'],
      ['a photo whose people were never read', { id: 44 }, { caption: 'x', date: null, personIds: ['I7'] }, 'I7']
    ])('passes the API validator: %s', (_, photo, fields, focusId) => {
      const params = updatePhotoParams(photo, fields, focusId);
      expect(validate('update_photo', params)).toEqual({
        mediaId: photo.id, caption: params.caption, date: params.date, personIds: params.personIds,
        expected: params.expected, focusId: focusId ?? null
      });
    });

    it('expects exactly the values the photo was opened with', () => {
      const { expected } = validate('update_photo', updatePhotoParams(PHOTO, { caption: 'x', date: null, personIds: ['I7'] }, 'I7'));
      expect(expected).toEqual({ caption: 'At the church', date: null, personIds: ['I7', 'I1'] });
    });
  });

  it('remove_photo passes the API validator', () => {
    expect(validate('remove_photo', removePhotoParams('I7', PHOTO))).toEqual({ personId: 'I7', mediaId: 42 });
  });

  describe('set_avatar', () => {
    const cropperCrop = { x: 0.123456, y: 0.2, w: 0.499999, h: 0.375 }; // fractions as the cropper gives them

    it.each([
      ['one of their photos', { mediaId: 42 }, CROP, SHA],
      ['one of their photos, with unrounded fractions', { mediaId: 42 }, cropperCrop, SHA],
      ['a new upload', { media: media() }, CROP, SHA],
      ['a new upload, with unrounded fractions', { media: media() }, cropperCrop, SHA],
      ['an upload already in the tree', { media: media({ mediaId: 17 }) }, CROP, SHA],
      ...[...TYPES.values()].filter((type) => type.image).map((type) =>
        [`a new .${type.ext}`, { media: media({ ext: type.ext, sha256: OTHER_SHA, fileName: `face.${type.ext}` }) }, CROP, OTHER_SHA])
    ])('passes the API validator: %s', (_, source, crop, sha) => {
      const avatarKey = avatarKeyFor(sha, crop);
      const params = setAvatarParams('I7', source, crop, avatarKey);
      const clean = validate('set_avatar', params);
      expect(clean).toEqual({
        personId: 'I7', mediaId: source.mediaId ?? null, photo: params.photo ? kept(params.photo) : null,
        crop: validateCrop(crop), avatarKey
      });
      if (source.media) expect(clean.photo.personIds).toEqual(['I7']);
    });
  });

  it('clear_avatar passes the API validator', () => {
    expect(validate('clear_avatar', clearAvatarParams('I7'))).toEqual({ personId: 'I7' });
  });

  it('is checked against validators that do refuse what the dialogs must never send', () => {
    const item = photoItem(media(), { personIds: ['I1'] });
    expect(() => validate('add_photos', addPhotosParams('I7', [item]))).toThrow(/personId/);
    const twice = photoItem(media(), { personIds: ['I7'] });
    expect(() => validate('add_photos', addPhotosParams('I7', [twice, { ...twice }]))).toThrow(/twice/);
    expect(() => validate('add_photos', addPhotosParams('I7', []))).toThrow();
    expect(() => validate('update_photo', updatePhotoParams(PHOTO, { caption: null, date: null, personIds: [] }, 'I7'))).toThrow();
    const pdf = media({ ext: 'pdf', contentType: 'application/pdf', displayKey: null, thumbKey: null });
    expect(() => validate('set_avatar', setAvatarParams('I7', { media: pdf }, CROP, avatarKeyFor(SHA, CROP)))).toThrow(/PDF/);
    const otherCrop = { ...CROP, x: 0.2 };
    expect(() => validate('set_avatar', setAvatarParams('I7', { media: media() }, CROP, avatarKeyFor(SHA, otherCrop)))).toThrow(/crop/);
    expect(() => validate('remove_photo', removePhotoParams('I7', { key: 'originals/x.jpg' }))).toThrow(/mediaId/);
  });
});
