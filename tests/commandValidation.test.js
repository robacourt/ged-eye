// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { ApiError } from '../api/http.js';
import {
  validateFacts, validatePersonFields, validateFamilyFields, optionalLine, MAX_LINE, MAX_FACT_STRING, MAX_FACTS_BYTES
} from '../api/commands/validate.js';
import { nameOf, relationPhrase, relationWord, possessive, listNames, UNNAMED } from '../api/commands/summary.js';
import { commandFor, COMMANDS } from '../api/commands/index.js';
import { mapDbError, runChange } from '../api/changes.js';
import { avatarKeyFor } from '../media/crop.js';

/** The ApiError a call throws, as { status, code, ...extra }. */
function failure(call) {
  try {
    call();
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return { status: error.status, code: error.code, ...error.extra };
  }
  throw new Error('expected the call to throw');
}
const invalidAt = (call) => {
  const result = failure(call);
  expect(result).toMatchObject({ status: 400, code: 'invalid' });
  expect(typeof result.message).toBe('string');
  return result.field;
};

describe('validatePersonFields', () => {
  it('accepts every core field, trimming text and storing empty optional fields as null', () => {
    expect(validatePersonFields({
      given_name: ' Rose ', surname: 'Smith', sex: 'F', birth_date: '1 JAN 1900', birth_place: '',
      death_date: null, death_place: '  ', baptism_date: 'ABT 1900', baptism_place: 'Leeds',
      burial_date: '1980', burial_place: 'Hull'
    })).toEqual({
      given_name: 'Rose', surname: 'Smith', sex: 'F', birth_date: '1 JAN 1900', birth_place: null,
      death_date: null, death_place: null, baptism_date: 'ABT 1900', baptism_place: 'Leeds',
      burial_date: '1980', burial_place: 'Hull'
    });
  });

  it('allows empty given name and surname together (stored as empty strings, never null)', () => {
    expect(validatePersonFields({ given_name: '', surname: null })).toEqual({ given_name: '', surname: '' });
  });

  it('accepts sex M, F, U or null, and an empty sex as null', () => {
    for (const sex of ['M', 'F', 'U', null]) expect(validatePersonFields({ sex })).toEqual({ sex });
    expect(validatePersonFields({ sex: '' })).toEqual({ sex: null });
  });

  it('refuses any other sex', () => {
    for (const sex of ['X', 'm', 'male', 1, true]) expect(invalidAt(() => validatePersonFields({ sex }))).toBe('sex');
  });

  it('refuses unknown fields, including the generated display_name', () => {
    expect(invalidAt(() => validatePersonFields({ display_name: 'X' }))).toBe('display_name');
    expect(invalidAt(() => validatePersonFields({ facts: {} }))).toBe('facts');
    expect(invalidAt(() => validatePersonFields({ updated_at: 'x' }))).toBe('updated_at');
  });

  it('refuses a non-object', () => {
    for (const fields of [null, 'x', [], 3]) expect(invalidAt(() => validatePersonFields(fields))).toBe('fields');
    expect(invalidAt(() => validatePersonFields([], 'person.fields'))).toBe('person.fields');
  });

  it('allows single-line text up to 500 characters', () => {
    expect(MAX_LINE).toBe(500);
    expect(validatePersonFields({ birth_place: 'x'.repeat(500) })).toEqual({ birth_place: 'x'.repeat(500) });
    expect(invalidAt(() => validatePersonFields({ birth_place: 'x'.repeat(501) }))).toBe('birth_place');
    expect(invalidAt(() => validatePersonFields({ given_name: 'x'.repeat(501) }))).toBe('given_name');
  });

  it('refuses line breaks, NUL characters and non-text values', () => {
    expect(invalidAt(() => validatePersonFields({ birth_place: 'Leeds\nYorkshire' }))).toBe('birth_place');
    expect(invalidAt(() => validatePersonFields({ surname: 'Smith\r' + 'x' }))).toBe('surname');
    expect(invalidAt(() => validatePersonFields({ surname: 'Sm\u0000ith' }))).toBe('surname');
    expect(invalidAt(() => validatePersonFields({ surname: 'Sm\ud83dith' }))).toBe('surname');
    expect(validatePersonFields({ surname: 'Smith 😀' })).toEqual({ surname: 'Smith 😀' });
    for (const value of [3, true, ['a'], { a: 1 }]) expect(invalidAt(() => validatePersonFields({ death_date: value }))).toBe('death_date');
  });
});

describe('validateFamilyFields', () => {
  it('accepts the four marriage fields, normalised like person fields', () => {
    expect(validateFamilyFields({ marriage_date: ' 1920 ', marriage_place: '', divorce_date: null, divorce_place: 'Hull' }))
      .toEqual({ marriage_date: '1920', marriage_place: null, divorce_date: null, divorce_place: 'Hull' });
  });

  it('refuses other fields, long or multi-line text', () => {
    expect(invalidAt(() => validateFamilyFields({ partner1_id: 'I1' }))).toBe('partner1_id');
    expect(invalidAt(() => validateFamilyFields({ marriage_place: 'x'.repeat(501) }))).toBe('marriage_place');
    expect(invalidAt(() => validateFamilyFields({ marriage_place: 'a\nb' }))).toBe('marriage_place');
    expect(invalidAt(() => validateFamilyFields('x'))).toBe('fields');
  });
});

describe('optionalLine', () => {
  it('trims text, and stores empty, blank or absent as null', () => {
    expect(optionalLine('  At the beach ', 'caption')).toBe('At the beach');
    for (const value of ['', '   ', null, undefined]) expect(optionalLine(value, 'caption')).toBeNull();
    expect(optionalLine('Emoji 😀 and é', 'caption')).toBe('Emoji 😀 and é');
  });

  it('allows at most `max` characters after trimming, 500 by default', () => {
    expect(optionalLine('x'.repeat(500), 'caption')).toBe('x'.repeat(500));
    expect(invalidAt(() => optionalLine('x'.repeat(501), 'caption'))).toBe('caption');
    expect(optionalLine(` ${'x'.repeat(100)} `, 'date', { max: 100 })).toBe('x'.repeat(100));
    expect(invalidAt(() => optionalLine('x'.repeat(101), 'date', { max: 100 }))).toBe('date');
  });

  it('refuses non-text, line breaks, NUL characters and unpaired surrogates', () => {
    for (const value of [3, true, ['a'], { a: 1 }]) expect(invalidAt(() => optionalLine(value, 'caption'))).toBe('caption');
    expect(invalidAt(() => optionalLine('On the\npier', 'caption'))).toBe('caption');
    expect(invalidAt(() => optionalLine('a\u0000b', 'caption'))).toBe('caption');
    expect(invalidAt(() => optionalLine('a\ud800', 'caption'))).toBe('caption');
  });

  it('names the field, and words its messages with the label', () => {
    expect(failure(() => optionalLine(3, 'photos.0.caption', { label: 'caption' })))
      .toEqual({ status: 400, code: 'invalid', field: 'photos.0.caption', message: 'Caption must be text.' });
    expect(failure(() => optionalLine('x'.repeat(101), 'photos.2.date', { max: 100, label: 'date' })))
      .toEqual({ status: 400, code: 'invalid', field: 'photos.2.date', message: 'Date must be at most 100 characters.' });
    expect(failure(() => optionalLine('a\nb', 'caption')).message).toBe('Caption must be a single line.');
  });
});

describe('validateFacts', () => {
  it('accepts the old (pre-backfill) shapes', () => {
    const facts = {
      notes: ['A note'],
      occupations: ['Farmer', 'Miller'],
      censusRecords: [{ date: '1881', place: 'Leeds' }, { date: null, place: null }],
      residences: [{ date: '1900', place: null }],
      religion: 'Methodist',
      education: 'Grammar school',
      email: 'a@b.example',
      phone: '0123'
    };
    expect(validateFacts(facts)).toBe(facts);
  });

  it('accepts the full-facts shapes', () => {
    const facts = {
      notes: ['  Verbatim\n\nnote  '],
      occupations: [{ value: 'Farmer', date: '1881', place: 'Leeds', notes: ['n1', 'n2'] }],
      censusRecords: [{ date: '1881' }, { notes: ['only a note'] }],
      residences: [{ place: 'Hull' }],
      birthNotes: ['b'], baptismNotes: ['c'], deathNotes: ['d'], burialNotes: ['e'],
      causeOfDeath: 'Fever',
      otherFacts: [{ tag: '_MILT', type: 'Army', value: 'Private', cause: 'War', date: '1916', place: 'France', notes: [] }, { tag: '_ADPF' }],
      email: 'a@b.example',
      phone: '0123'
    };
    expect(validateFacts(facts)).toBe(facts);
    expect(validateFacts({})).toEqual({});
  });

  it('accepts an array mixing old string entries and edited object entries', () => {
    expect(() => validateFacts({ occupations: ['Farmer', { value: 'Miller', date: '1890' }] })).not.toThrow();
  });

  it('refuses unknown keys', () => {
    expect(invalidAt(() => validateFacts({ hobbies: ['x'] }))).toBe('facts.hobbies');
    expect(invalidAt(() => validateFacts({ __proto__: null, constructor: 'x' }))).toBe('facts.constructor');
    expect(invalidAt(() => validateFacts(JSON.parse('{"__proto__": "x"}')))).toBe('facts.__proto__');
  });

  it('refuses a non-object', () => {
    for (const facts of [null, [], 'x', 3]) expect(invalidAt(() => validateFacts(facts))).toBe('facts');
  });

  it('refuses values that are not strings, string arrays or arrays of flat objects', () => {
    for (const value of [null, 3, true, { a: 'b' }, [3], [null], [['a']], [{ a: 3 }], [{ a: { b: 'c' } }], [{ a: [3] }], [{ a: [null] }]]) {
      expect(invalidAt(() => validateFacts({ notes: value }))).toBe('facts.notes');
    }
  });

  it('allows null values inside fact objects', () => {
    expect(() => validateFacts({ censusRecords: [{ date: null, place: null, notes: ['x'] }] })).not.toThrow();
  });

  it('limits each string to 100,000 characters, wherever it is', () => {
    expect(MAX_FACT_STRING).toBe(100000);
    const ok = 'x'.repeat(100000);
    const long = 'x'.repeat(100001);
    expect(() => validateFacts({ causeOfDeath: ok })).not.toThrow();
    expect(invalidAt(() => validateFacts({ causeOfDeath: long }))).toBe('facts.causeOfDeath');
    expect(invalidAt(() => validateFacts({ notes: [long] }))).toBe('facts.notes');
    expect(invalidAt(() => validateFacts({ otherFacts: [{ value: long }] }))).toBe('facts.otherFacts');
    expect(invalidAt(() => validateFacts({ otherFacts: [{ notes: [long] }] }))).toBe('facts.otherFacts');
  });

  it('limits the whole object to 500 KB of JSON', () => {
    expect(MAX_FACTS_BYTES).toBe(500 * 1024);
    const chunk = 'x'.repeat(99000);
    expect(() => validateFacts({ notes: [chunk, chunk, chunk, chunk, chunk] })).not.toThrow();
    expect(invalidAt(() => validateFacts({ notes: [chunk, chunk, chunk, chunk, chunk, chunk] }))).toBe('facts');
    // Bytes, not characters: 270,000 two-byte characters are 540,000 bytes.
    const wide = 'é'.repeat(90000);
    expect(invalidAt(() => validateFacts({ notes: [wide, wide, wide] }))).toBe('facts');
  });

  it('refuses NUL characters and unpaired surrogates, which Postgres cannot store, in values and entry keys', () => {
    expect(invalidAt(() => validateFacts({ notes: ['a\u0000b'] }))).toBe('facts.notes');
    expect(invalidAt(() => validateFacts({ causeOfDeath: 'x\ud800' }))).toBe('facts.causeOfDeath');
    expect(invalidAt(() => validateFacts({ otherFacts: [{ value: '\udc00x' }] }))).toBe('facts.otherFacts');
    expect(invalidAt(() => validateFacts({ otherFacts: [{ ['ta\u0000g']: 'x' }] }))).toBe('facts.otherFacts');
    expect(invalidAt(() => validateFacts({ otherFacts: [{ ['\ud800']: null }] }))).toBe('facts.otherFacts');
    expect(() => validateFacts({ notes: ['Emoji 😀 and é are fine'] })).not.toThrow();
  });
});

describe('summary words', () => {
  it('names people by display name, or "Unnamed person"', () => {
    expect(nameOf({ display_name: 'Rose Smith' })).toBe('Rose Smith');
    expect(nameOf({ display_name: '' })).toBe(UNNAMED);
    expect(nameOf({ display_name: '  ' })).toBe('Unnamed person');
    expect(nameOf(null)).toBe('Unnamed person');
  });

  it('chooses relation words by sex where known', () => {
    const table = {
      parent: ['the mother', 'the father', 'a parent', 'a parent'],
      child: ['a daughter', 'a son', 'a child', 'a child'],
      spouse: ['the wife', 'the husband', 'the spouse', 'the spouse'],
      sibling: ['a sister', 'a brother', 'a sibling', 'a sibling']
    };
    for (const [relation, words] of Object.entries(table)) {
      expect(['F', 'M', 'U', null].map((sex) => relationPhrase(relation, sex))).toEqual(words);
    }
  });

  it('has bare relation words and possessives by sex, for validation messages', () => {
    expect(['F', 'M', 'U', null].map((sex) => relationWord('child', sex))).toEqual(['daughter', 'son', 'child', 'child']);
    expect(['F', 'M', 'U', null].map((sex) => relationWord('spouse', sex))).toEqual(['wife', 'husband', 'spouse', 'spouse']);
    expect(['F', 'M', 'U', null].map(possessive)).toEqual(['her', 'his', 'their', 'their']);
  });

  it('lists names', () => {
    expect(listNames([])).toBe('');
    expect(listNames(['A'])).toBe('A');
    expect(listNames(['A', 'B'])).toBe('A and B');
    expect(listNames(['A', 'B', 'C'])).toBe('A, B and C');
    expect(listNames(['A', 'B', 'C', 'D'])).toBe('A, B and 2 others');
  });
});

describe('command registry', () => {
  it('registers the eleven commands by kind', () => {
    expect([...COMMANDS.keys()].sort()).toEqual([
      'add_photos', 'add_relative', 'clear_avatar', 'delete_person', 'link_existing', 'remove_photo', 'set_avatar',
      'unlink', 'update_family', 'update_person', 'update_photo'
    ]);
    for (const [kind, command] of COMMANDS) {
      expect(command.kind).toBe(kind);
      expect(typeof command.validate).toBe('function');
      expect(typeof command.run).toBe('function');
    }
  });

  it('never treats an Object.prototype name as a command', () => {
    expect(commandFor('constructor')).toBeNull();
    expect(commandFor('__proto__')).toBeNull();
    expect(commandFor('toString')).toBeNull();
  });
});

describe('command validation', () => {
  const v = (kind, params) => invalidAt(() => commandFor(kind).validate(params));
  const STAMP = '2026-10-09T12:00:00.123456Z';

  it('update_person', () => {
    expect(v('update_person', { expectedUpdatedAt: STAMP })).toBe('id');
    expect(v('update_person', { id: 'I1;drop', expectedUpdatedAt: STAMP })).toBe('id');
    expect(v('update_person', { id: 'I1' })).toBe('expectedUpdatedAt');
    expect(v('update_person', { id: 'I1', expectedUpdatedAt: 5 })).toBe('expectedUpdatedAt');
    expect(v('update_person', { id: 'I1', expectedUpdatedAt: '' })).toBe('expectedUpdatedAt');
    expect(v('update_person', { id: 'I1', expectedUpdatedAt: '2026\u0000' })).toBe('expectedUpdatedAt');
    expect(v('update_person', { id: 'I1', expectedUpdatedAt: STAMP, fact: { notes: ['x'] } })).toBe('fact'); // misspelt
    expect(v('update_person', { id: 'I1', expectedUpdatedAt: STAMP, fields: { sex: 'Q' } })).toBe('sex');
    expect(v('update_person', { id: 'I1', expectedUpdatedAt: STAMP, facts: { nope: 'x' } })).toBe('facts.nope');
    expect(v('update_person', { id: 'I1', expectedUpdatedAt: STAMP, facts: null })).toBe('facts');
    expect(commandFor('update_person').validate({ id: 'I1', expectedUpdatedAt: STAMP, fields: { birth_place: ' Leeds ' } }))
      .toEqual({ id: 'I1', expectedUpdatedAt: STAMP, fields: { birth_place: 'Leeds' }, facts: undefined });
  });

  it('add_relative', () => {
    const ok = { anchorId: 'I1', relation: 'child', familyId: 'new', person: { fields: { given_name: 'Rose' } } };
    expect(() => commandFor('add_relative').validate(ok)).not.toThrow();
    expect(v('add_relative', { ...ok, anchorId: undefined })).toBe('anchorId');
    expect(v('add_relative', { ...ok, relation: 'cousin' })).toBe('relation');
    expect(v('add_relative', { ...ok, relation: undefined })).toBe('relation');
    expect(v('add_relative', { ...ok, person: undefined })).toBe('person');
    expect(v('add_relative', { ...ok, person: 'Rose' })).toBe('person');
    expect(v('add_relative', { ...ok, person: { fields: { sex: 'x' } } })).toBe('sex');
    expect(v('add_relative', { ...ok, person: { fields: {}, facts: { bad: 'x' } } })).toBe('facts.bad');
    expect(v('add_relative', { ...ok, person: { fields: {}, extra: 1 } })).toBe('person.extra');
    expect(v('add_relative', { ...ok, familyId: 'F1 x' })).toBe('familyId');
    expect(v('add_relative', { ...ok, familyId: undefined })).toBe('familyId'); // a child needs a family (or 'new')
    expect(v('add_relative', { ...ok, relation: 'parent', familyId: 'new' })).toBe('familyId');
    expect(v('add_relative', { ...ok, relation: 'sibling', familyId: 'new' })).toBe('familyId');
    expect(v('add_relative', { ...ok, relation: 'spouse', familyId: 'F1' })).toBe('familyId');
    expect(() => commandFor('add_relative').validate({ ...ok, relation: 'parent', familyId: null })).not.toThrow();
    expect(() => commandFor('add_relative').validate({ ...ok, relation: 'spouse', familyId: undefined, person: {} })).not.toThrow();
  });

  it('link_existing, including the always-invalid self link', () => {
    const ok = { anchorId: 'I1', otherId: 'I2', relation: 'spouse' };
    expect(() => commandFor('link_existing').validate(ok)).not.toThrow();
    expect(v('link_existing', { ...ok, otherId: undefined })).toBe('otherId');
    expect(v('link_existing', { ...ok, anchorId: 7 })).toBe('anchorId');
    expect(v('link_existing', { ...ok, relation: 'friend' })).toBe('relation');
    for (const relation of ['parent', 'child', 'spouse', 'sibling']) {
      expect(v('link_existing', { anchorId: 'I1', otherId: 'I1', relation, familyId: relation === 'child' ? 'new' : undefined })).toBe('otherId');
    }
  });

  it('update_family', () => {
    const ok = { id: 'F1', expected: { marriage_date: null }, fields: { marriage_date: '1920' } };
    expect(commandFor('update_family').validate(ok)).toEqual({
      id: 'F1', focusId: null, fields: { marriage_date: '1920' },
      expected: { marriage_date: null, marriage_place: null, divorce_date: null, divorce_place: null }
    });
    expect(v('update_family', { ...ok, id: undefined })).toBe('id');
    expect(v('update_family', { ...ok, expected: undefined })).toBe('expected');
    expect(v('update_family', { ...ok, expected: { marriage_date: 3 } })).toBe('expected.marriage_date');
    expect(v('update_family', { ...ok, expected: { partner1_id: 'I1' } })).toBe('expected.partner1_id');
    expect(v('update_family', { ...ok, expected: { marriage_place: 'a\u0000' } })).toBe('expected.marriage_place');
    expect(v('update_family', { ...ok, expected: { marriage_place: '\udfff' } })).toBe('expected.marriage_place');
    expect(v('update_family', { ...ok, fields: undefined })).toBe('fields');
    expect(v('update_family', { ...ok, fields: { divorce_place: 'x'.repeat(501) } })).toBe('divorce_place');
    expect(v('update_family', { ...ok, focusId: 'a b' })).toBe('focusId');
  });

  it('unlink', () => {
    const ok = { familyId: 'F1', personId: 'I1', role: 'child' };
    expect(commandFor('unlink').validate(ok)).toEqual({ ...ok, focusId: null });
    expect(v('unlink', { ...ok, familyId: undefined })).toBe('familyId');
    expect(v('unlink', { ...ok, personId: '' })).toBe('personId');
    expect(v('unlink', { ...ok, role: 'parent' })).toBe('role');
    expect(v('unlink', { ...ok, focusId: 3 })).toBe('focusId');
  });

  it('delete_person', () => {
    expect(v('delete_person', { expectedUpdatedAt: STAMP })).toBe('id');
    expect(v('delete_person', { id: 'I1' })).toBe('expectedUpdatedAt');
  });

  describe('photo commands', () => {
    const SHA = 'a'.repeat(64);
    const SHA2 = 'b'.repeat(64);
    const upload = (sha256 = SHA, ext = 'jpg') => ({ sha256, ext, fileName: ` ${sha256.slice(0, 4)}.${ext} ` });
    const CROP = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 };
    const KEY = avatarKeyFor(SHA, CROP);
    const BAD_MEDIA_IDS = [0, -1, 1.5, '0', '07', '-3', '1e3', ' 7', '7 ', 'x', '', true, [7], { id: 7 }, Number.NaN,
      Number.MAX_SAFE_INTEGER + 1, '9007199254740993'];

    it('add_photos: accepts uploads and existing media ids, normalising them', () => {
      const params = {
        personId: 'I1',
        photos: [
          { upload: upload(), caption: ' At the beach ', date: ' about 1923 ', personIds: ['I2', 'I1'] },
          { mediaId: '12', personIds: ['I1'] },
          { mediaId: 13, caption: '', date: null, personIds: ['I1'] },
          { upload: upload(SHA2, 'pdf'), personIds: ['I1'] }
        ]
      };
      expect(commandFor('add_photos').validate(params)).toEqual({
        personId: 'I1',
        photos: [
          { upload: { sha256: SHA, ext: 'jpg', fileName: 'aaaa.jpg' }, mediaId: null, caption: 'At the beach', date: 'about 1923', personIds: ['I2', 'I1'] },
          { upload: null, mediaId: 12, caption: null, date: null, personIds: ['I1'] },
          { upload: null, mediaId: 13, caption: null, date: null, personIds: ['I1'] },
          { upload: { sha256: SHA2, ext: 'pdf', fileName: 'bbbb.pdf' }, mediaId: null, caption: null, date: null, personIds: ['I1'] }
        ]
      });
    });

    it('add_photos: 1 to 20 photos', () => {
      const photo = (i) => ({ upload: upload(i.toString(16).padStart(64, '0')), personIds: ['I1'] });
      const twenty = Array.from({ length: 20 }, (_, i) => photo(i));
      expect(commandFor('add_photos').validate({ personId: 'I1', photos: twenty }).photos).toHaveLength(20);
      for (const photos of [undefined, null, [], 'x', { 0: photo(0) }, [...twenty, photo(20)]]) {
        expect(v('add_photos', { personId: 'I1', photos })).toBe('photos');
      }
      expect(v('add_photos', { photos: [photo(0)] })).toBe('personId');
      expect(v('add_photos', { personId: 'I 1', photos: [photo(0)] })).toBe('personId');
    });

    it('add_photos: each photo has exactly one of upload and mediaId, both well formed', () => {
      const add = (photo) => v('add_photos', { personId: 'I1', photos: [{ mediaId: 5, personIds: ['I1'] }, photo] });
      expect(add({ personIds: ['I1'] })).toBe('photos.1');
      expect(add({ upload: null, mediaId: null, personIds: ['I1'] })).toBe('photos.1');
      expect(add({ upload: upload(), mediaId: 7, personIds: ['I1'] })).toBe('photos.1');
      for (const photo of [null, 'x', [], 3]) expect(add(photo)).toBe('photos.1');
      expect(add({ mediaId: 7, personIds: ['I1'], tags: [] })).toBe('photos.1.tags');
      for (const mediaId of BAD_MEDIA_IDS) expect(add({ mediaId, personIds: ['I1'] })).toBe('photos.1.mediaId');
      expect(add({ upload: 'x', personIds: ['I1'] })).toBe('photos.1.upload');
      expect(add({ upload: { ...upload(), sha256: 'A'.repeat(64) }, personIds: ['I1'] })).toBe('photos.1.upload.sha256');
      expect(add({ upload: { ...upload(), ext: 'heic' }, personIds: ['I1'] })).toBe('photos.1.upload.ext');
      expect(add({ upload: { ...upload(), fileName: 'a/b.jpg' }, personIds: ['I1'] })).toBe('photos.1.upload.fileName');
      expect(add({ upload: { ...upload(), objectKey: 'originals/x' }, personIds: ['I1'] })).toBe('photos.1.upload.objectKey');
    });

    it('add_photos: captions up to 500 characters, dates up to 100, both single lines', () => {
      const add = (photo) => commandFor('add_photos').validate({ personId: 'I1', photos: [{ mediaId: 5, personIds: ['I1'], ...photo }] });
      const bad = (photo) => v('add_photos', { personId: 'I1', photos: [{ mediaId: 5, personIds: ['I1'], ...photo }] });
      expect(add({ caption: 'x'.repeat(500), date: 'y'.repeat(100) }).photos[0]).toMatchObject({ caption: 'x'.repeat(500), date: 'y'.repeat(100) });
      expect(bad({ caption: 'x'.repeat(501) })).toBe('photos.0.caption');
      expect(bad({ date: 'y'.repeat(101) })).toBe('photos.0.date');
      expect(bad({ caption: 'a\nb' })).toBe('photos.0.caption');
      expect(bad({ date: 1923 })).toBe('photos.0.date');
      expect(bad({ caption: 'a\u0000' })).toBe('photos.0.caption');
    });

    it('add_photos: personIds is a non-empty list of distinct ids that includes personId', () => {
      const bad = (personIds) => v('add_photos', { personId: 'I1', photos: [{ mediaId: 5, personIds }] });
      for (const personIds of [undefined, null, [], 'I1', ['I1', 'I1'], ['I2'], ['I1', 'I 2'], ['I1', 3], ['I1', null]]) {
        expect(bad(personIds)).toBe('photos.0.personIds');
      }
    });

    it('caps every list of people at 100', () => {
      const people = (n) => ['I1', ...Array.from({ length: n - 1 }, (_, i) => `I${i + 2}`)];
      const add = (personIds) => ({ personId: 'I1', photos: [{ mediaId: 5, personIds }] });
      expect(commandFor('add_photos').validate(add(people(100))).photos[0].personIds).toHaveLength(100);
      expect(v('add_photos', add(people(101)))).toBe('photos.0.personIds');

      const update = { mediaId: 7, caption: null, date: null, personIds: ['I1'], expected: { caption: null, date: null, personIds: ['I1'] } };
      expect(() => commandFor('update_photo').validate({ ...update, personIds: people(100), expected: { ...update.expected, personIds: people(100) } })).not.toThrow();
      expect(v('update_photo', { ...update, personIds: people(101) })).toBe('personIds');
      expect(v('update_photo', { ...update, expected: { ...update.expected, personIds: people(101) } })).toBe('expected.personIds');

      const avatar = { personId: 'I1', crop: CROP, avatarKey: KEY, photo: { upload: upload(), personIds: people(100) } };
      expect(() => commandFor('set_avatar').validate(avatar)).not.toThrow();
      expect(v('set_avatar', { ...avatar, photo: { ...avatar.photo, personIds: people(101) } })).toBe('photo.personIds');
    });

    it('add_photos: refuses a file or media id that appears twice in one batch', () => {
      const twice = (a, b) => v('add_photos', { personId: 'I1', photos: [{ ...a, personIds: ['I1'] }, { ...b, personIds: ['I1'] }] });
      expect(twice({ upload: upload() }, { upload: { ...upload(), fileName: 'other.jpg' } })).toBe('photos');
      expect(twice({ upload: upload(SHA, 'jpg') }, { upload: upload(SHA, 'png') })).toBe('photos');
      expect(twice({ mediaId: 7 }, { mediaId: '7' })).toBe('photos');
    });

    it('update_photo', () => {
      const ok = {
        mediaId: 7, caption: ' On the pier ', date: '', personIds: ['I1', 'I2'],
        expected: { caption: 'At the beach ', date: null, personIds: ['I2'] }
      };
      expect(commandFor('update_photo').validate(ok)).toEqual({
        mediaId: 7, caption: 'On the pier', date: null, personIds: ['I1', 'I2'],
        expected: { caption: 'At the beach ', date: null, personIds: ['I2'] }, focusId: null
      });
      expect(commandFor('update_photo').validate({ ...ok, mediaId: '7', focusId: 'I2', expected: { ...ok.expected, personIds: [] } }))
        .toMatchObject({ mediaId: 7, focusId: 'I2', expected: { personIds: [] } });
      for (const mediaId of [...BAD_MEDIA_IDS, undefined]) expect(v('update_photo', { ...ok, mediaId })).toBe('mediaId');
      expect(v('update_photo', { ...ok, caption: 'x'.repeat(501) })).toBe('caption');
      expect(v('update_photo', { ...ok, date: 'x'.repeat(101) })).toBe('date');
      for (const personIds of [undefined, [], ['I1', 'I1'], ['I 1'], 'I1']) expect(v('update_photo', { ...ok, personIds })).toBe('personIds');
      expect(v('update_photo', { ...ok, focusId: 'a b' })).toBe('focusId');
      for (const expected of [undefined, null, 'x', []]) expect(v('update_photo', { ...ok, expected })).toBe('expected');
      for (const key of ['caption', 'date', 'personIds']) {
        const { [key]: _omitted, ...rest } = ok.expected;
        expect(v('update_photo', { ...ok, expected: rest })).toBe(`expected.${key}`);
      }
      expect(v('update_photo', { ...ok, expected: { ...ok.expected, people: [] } })).toBe('expected.people');
      expect(v('update_photo', { ...ok, expected: { ...ok.expected, caption: 3 } })).toBe('expected.caption');
      expect(v('update_photo', { ...ok, expected: { ...ok.expected, date: 'a\u0000' } })).toBe('expected.date');
      for (const personIds of [null, 'I1', ['I 1'], ['I1', 'I1']]) {
        expect(v('update_photo', { ...ok, expected: { ...ok.expected, personIds } })).toBe('expected.personIds');
      }
    });

    it('remove_photo', () => {
      expect(commandFor('remove_photo').validate({ personId: 'I1', mediaId: '7' })).toEqual({ personId: 'I1', mediaId: 7 });
      expect(v('remove_photo', { mediaId: 7 })).toBe('personId');
      for (const mediaId of [...BAD_MEDIA_IDS, undefined]) expect(v('remove_photo', { personId: 'I1', mediaId })).toBe('mediaId');
    });

    it('set_avatar: with mediaId or photo, a valid crop and a well-formed avatarKey', () => {
      const ok = { personId: 'I1', mediaId: 7, crop: { x: 0.10004, y: 0.2, w: 0.3, h: 0.4 }, avatarKey: KEY };
      expect(commandFor('set_avatar').validate(ok)).toEqual({ personId: 'I1', mediaId: 7, photo: null, crop: CROP, avatarKey: KEY });
      const withPhoto = { personId: 'I1', photo: { upload: upload(), caption: ' Portrait ', personIds: ['I1', 'I2'] }, crop: CROP, avatarKey: KEY };
      expect(commandFor('set_avatar').validate(withPhoto)).toEqual({
        personId: 'I1', mediaId: null, crop: CROP, avatarKey: KEY,
        photo: { upload: { sha256: SHA, ext: 'jpg', fileName: 'aaaa.jpg' }, mediaId: null, caption: 'Portrait', date: null, personIds: ['I1', 'I2'] }
      });
      expect(commandFor('set_avatar').validate({ ...withPhoto, photo: { mediaId: '9', personIds: ['I1'] } }).photo)
        .toEqual({ upload: null, mediaId: 9, caption: null, date: null, personIds: ['I1'] });

      expect(v('set_avatar', { ...ok, personId: undefined })).toBe('personId');
      expect(v('set_avatar', { ...ok, photo: withPhoto.photo })).toBe('mediaId');
      expect(v('set_avatar', { ...ok, mediaId: undefined })).toBe('mediaId');
      for (const mediaId of BAD_MEDIA_IDS) expect(v('set_avatar', { ...ok, mediaId })).toBe('mediaId');
      expect(v('set_avatar', { ...withPhoto, photo: 'x' })).toBe('photo');
      expect(v('set_avatar', { ...withPhoto, photo: { ...withPhoto.photo, personIds: ['I2'] } })).toBe('photo.personIds');
      expect(v('set_avatar', { ...withPhoto, photo: { ...withPhoto.photo, mediaId: 3 } })).toBe('photo');
      expect(v('set_avatar', { ...withPhoto, photo: { ...withPhoto.photo, upload: { ...upload(), ext: 'exe' } } })).toBe('photo.upload.ext');
    });

    it('set_avatar: refuses an upload that is not an image (a PDF) before anything is checked or stored', () => {
      const pdf = { personId: 'I1', photo: { upload: upload(SHA, 'pdf'), personIds: ['I1'] }, crop: CROP, avatarKey: KEY };
      expect(failure(() => commandFor('set_avatar').validate(pdf)))
        .toEqual({ status: 400, code: 'invalid', field: 'photo.upload.ext', message: "A PDF can't be an avatar: choose a photo." });
      for (const ext of ['jpg', 'png', 'webp', 'gif', 'tif', 'avif']) {
        expect(() => commandFor('set_avatar').validate({ ...pdf, photo: { ...pdf.photo, upload: upload(SHA, ext) } })).not.toThrow();
      }
    });

    it('set_avatar: a crop failing validateCrop is invalid, naming its field', () => {
      const ok = { personId: 'I1', mediaId: 7, crop: CROP, avatarKey: KEY };
      expect(v('set_avatar', { ...ok, crop: undefined })).toBe('crop');
      expect(v('set_avatar', { ...ok, crop: [0, 0, 1, 1] })).toBe('crop');
      expect(v('set_avatar', { ...ok, crop: { ...CROP, x: '0.1' } })).toBe('crop.x');
      expect(v('set_avatar', { ...ok, crop: { ...CROP, w: 0 } })).toBe('crop.w');
      expect(v('set_avatar', { ...ok, crop: { ...CROP, y: 0.7 } })).toBe('crop.h');
      expect(failure(() => commandFor('set_avatar').validate({ ...ok, crop: { ...CROP, w: -1 } })))
        .toEqual({ status: 400, code: 'invalid', field: 'crop.w', message: "The crop's w must be greater than 0." });
    });

    it('set_avatar: avatarKey must be an avatars/<sha>-<crop12>.webp key, and match an uploaded photo and crop', () => {
      const ok = { personId: 'I1', mediaId: 7, crop: CROP, avatarKey: KEY };
      for (const avatarKey of [undefined, null, 3, '', `avatars/${SHA}.jpg`, `avatars/${SHA}-0123456789AB.webp`,
        `avatars/${SHA}-0123456789a.webp`, `originals/${SHA}.jpg`, `avatars/${SHA}-0123456789ab.webp/x`, `/avatars/${SHA}-0123456789ab.webp`]) {
        expect(v('set_avatar', { ...ok, avatarKey })).toBe('avatarKey');
      }
      // With mediaId, the key's sha can only be checked against the media row, in run.
      expect(() => commandFor('set_avatar').validate({ ...ok, avatarKey: avatarKeyFor(SHA2, CROP) })).not.toThrow();
      // With an upload, it is checked against the upload's sha and the crop straight away.
      const withPhoto = { personId: 'I1', photo: { upload: upload(), personIds: ['I1'] }, crop: CROP };
      expect(() => commandFor('set_avatar').validate({ ...withPhoto, avatarKey: KEY })).not.toThrow();
      expect(v('set_avatar', { ...withPhoto, avatarKey: avatarKeyFor(SHA2, CROP) })).toBe('avatarKey');
      expect(v('set_avatar', { ...withPhoto, avatarKey: avatarKeyFor(SHA, { ...CROP, x: 0.2 }) })).toBe('avatarKey');
    });

    it('clear_avatar', () => {
      expect(commandFor('clear_avatar').validate({ personId: 'I1' })).toEqual({ personId: 'I1' });
      expect(v('clear_avatar', {})).toBe('personId');
      expect(v('clear_avatar', { personId: 'I1', avatarKey: null })).toBe('avatarKey');
    });
  });

  describe('photo commands: prepare', () => {
    const SHA = 'c'.repeat(64);
    const SHA2 = 'd'.repeat(64);
    const CROP = { x: 0, y: 0, w: 0.5, h: 0.5 };

    /**
     * A fake headObject: every key exists, with its extension's content type (or `stored[key]`), unless listed in
     * `missing`; records the keys asked for.
     */
    function fakeHead({ missing = [], stored = {} } = {}) {
      const keys = [];
      const types = { jpg: 'image/jpeg', pdf: 'application/pdf', webp: 'image/webp' };
      const headObject = vi.fn(async (key) => {
        keys.push(key);
        if (missing.includes(key)) return { status: 404 };
        const contentType = stored[key] ?? types[key.split('.').pop()];
        return { status: 200, contentType, contentLength: 1234, width: 4000, height: 3000 };
      });
      return { headObject, keys };
    }

    it('add_photos HEADs each upload (original and display image), giving null for media ids, in photo order', async () => {
      const command = commandFor('add_photos');
      const clean = command.validate({
        personId: 'I1',
        photos: [
          { mediaId: 4, personIds: ['I1'] },
          { upload: { sha256: SHA, ext: 'jpg', fileName: 'a.jpg' }, personIds: ['I1'] },
          { upload: { sha256: SHA2, ext: 'pdf', fileName: 'b.pdf' }, personIds: ['I1'] }
        ]
      });
      const { headObject, keys } = fakeHead();
      expect(await command.prepare(clean, { headObject })).toEqual([
        null,
        { contentType: 'image/jpeg', byteSize: 1234, width: 4000, height: 3000 },
        { contentType: 'application/pdf', byteSize: 1234, width: null, height: null }
      ]);
      expect(keys.sort()).toEqual([`display/${SHA}.webp`, `originals/${SHA}.jpg`, `originals/${SHA2}.pdf`]);
    });

    it('add_photos: a missing upload is missing_upload with the photo\'s index, field photos', async () => {
      const command = commandFor('add_photos');
      const clean = command.validate({
        personId: 'I1',
        photos: [
          { mediaId: 4, personIds: ['I1'] },
          { upload: { sha256: SHA, ext: 'jpg', fileName: 'a.jpg' }, personIds: ['I1'] }
        ]
      });
      const { headObject } = fakeHead({ missing: [`display/${SHA}.webp`] });
      await expect(command.prepare(clean, { headObject }))
        .rejects.toMatchObject({ status: 400, code: 'missing_upload', extra: { index: 1, field: 'photos' } });
    });

    it('add_photos: an upload stored as another type is invalid, naming photos.<index>.upload.ext', async () => {
      const command = commandFor('add_photos');
      const clean = command.validate({
        personId: 'I1',
        photos: [
          { upload: { sha256: SHA2, ext: 'pdf', fileName: 'b.pdf' }, personIds: ['I1'] },
          { upload: { sha256: SHA, ext: 'jpg', fileName: 'a.jpg' }, personIds: ['I1'] }
        ]
      });
      const { headObject } = fakeHead({ stored: { [`originals/${SHA}.jpg`]: 'application/pdf' } });
      await expect(command.prepare(clean, { headObject }))
        .rejects.toMatchObject({ status: 400, code: 'invalid', extra: { field: 'photos.1.upload.ext', index: 1 } });
    });

    it('add_photos with only media ids HEADs nothing', async () => {
      const command = commandFor('add_photos');
      const { headObject } = fakeHead();
      const clean = command.validate({ personId: 'I1', photos: [{ mediaId: 4, personIds: ['I1'] }] });
      expect(await command.prepare(clean, { headObject })).toEqual([null]);
      expect(headObject).not.toHaveBeenCalled();
    });

    it('set_avatar HEADs the avatar, and the photo\'s upload when there is one', async () => {
      const command = commandFor('set_avatar');
      const avatarKey = avatarKeyFor(SHA, CROP);
      const byId = command.validate({ personId: 'I1', mediaId: 4, crop: CROP, avatarKey });
      const first = fakeHead();
      expect(await command.prepare(byId, { headObject: first.headObject })).toEqual({ head: null });
      expect(first.keys).toEqual([avatarKey]);

      const withPhoto = command.validate({
        personId: 'I1', photo: { upload: { sha256: SHA, ext: 'jpg', fileName: 'a.jpg' }, personIds: ['I1'] }, crop: CROP, avatarKey
      });
      const second = fakeHead();
      expect(await command.prepare(withPhoto, { headObject: second.headObject }))
        .toEqual({ head: { contentType: 'image/jpeg', byteSize: 1234, width: 4000, height: 3000 } });
      expect(second.keys.sort()).toEqual([avatarKey, `display/${SHA}.webp`, `originals/${SHA}.jpg`]);

      const byMediaPhoto = command.validate({ personId: 'I1', photo: { mediaId: 4, personIds: ['I1'] }, crop: CROP, avatarKey });
      const third = fakeHead();
      expect(await command.prepare(byMediaPhoto, { headObject: third.headObject })).toEqual({ head: null });
      expect(third.keys).toEqual([avatarKey]);
    });

    it('set_avatar: a missing avatar is missing_upload for avatarKey, and a missing photo for photo', async () => {
      const command = commandFor('set_avatar');
      const avatarKey = avatarKeyFor(SHA, CROP);
      const clean = command.validate({ personId: 'I1', mediaId: 4, crop: CROP, avatarKey });
      await expect(command.prepare(clean, fakeHead({ missing: [avatarKey] })))
        .rejects.toMatchObject({ status: 400, code: 'missing_upload', extra: { field: 'avatarKey' } });

      const withPhoto = command.validate({
        personId: 'I1', photo: { upload: { sha256: SHA, ext: 'jpg', fileName: 'a.jpg' }, personIds: ['I1'] }, crop: CROP, avatarKey
      });
      await expect(command.prepare(withPhoto, fakeHead({ missing: [`originals/${SHA}.jpg`] })))
        .rejects.toMatchObject({ status: 400, code: 'missing_upload', extra: { index: 0, field: 'photo' } });
      await expect(command.prepare(withPhoto, fakeHead({ stored: { [`originals/${SHA}.jpg`]: 'image/png' } })))
        .rejects.toMatchObject({ status: 400, code: 'invalid', extra: { field: 'photo.upload.ext' } });
    });

    it('only add_photos and set_avatar have a prepare step', () => {
      expect([...COMMANDS.values()].filter((command) => command.prepare).map((command) => command.kind).sort())
        .toEqual(['add_photos', 'set_avatar']);
    });
  });

  it('every command refuses a non-object params, and any key it does not take', () => {
    for (const command of COMMANDS.values()) {
      for (const params of [null, [], 'x']) expect(invalidAt(() => command.validate(params))).toBe('params');
      expect(invalidAt(() => command.validate({ surprise: 1 }))).toBe('surprise');
      expect(invalidAt(() => command.validate({ ['bad\u0000key']: 1 }))).toBe('bad\u0000key');
    }
  });
});

describe('api/changes.js', () => {
  it('maps the GE SQLSTATEs and integrity violations to API errors', () => {
    const log = vi.fn();
    const pg = (code, detail) => Object.assign(new Error('pg'), { code, detail });
    const mapped = (error) => {
      const result = mapDbError(error, log);
      return result instanceof ApiError ? { status: result.status, code: result.code, ...result.extra } : result;
    };
    expect(mapped(pg('GE001'))).toEqual({ status: 404, code: 'not_found' });
    expect(mapped(pg('GE002'))).toEqual({ status: 409, code: 'wrong_state' });
    expect(mapped(pg('GE003', '{"reason": "cycle", "blocking": [{"id": 4, "action": "revert"}]}')))
      .toEqual({ status: 409, code: 'conflict', reason: 'cycle', blocking: [{ id: 4, action: 'revert' }] });
    expect(mapped(pg('GE003', 'not json'))).toEqual({ status: 409, code: 'conflict', reason: 'constraint', blocking: [] });
    expect(mapped(pg('GE004'))).toEqual({ status: 400, code: 'no_change' });
    expect(log).not.toHaveBeenCalled();
    for (const code of ['GE005', 'GE006', 'GE007']) expect(mapped(pg(code))).toEqual({ status: 500, code: 'internal' });
    expect(log).toHaveBeenCalledTimes(3);
    // A command can't hit an integrity violation except through a bug: every write holds the global lock.
    expect(mapped(pg('23505'))).toEqual({ status: 500, code: 'internal' });
    expect(mapped(pg('23503'))).toEqual({ status: 500, code: 'internal' });
    expect(log).toHaveBeenCalledTimes(5);
    // A statement timeout (for example while queued on the global lock) or a lock wait.
    const busy = { status: 503, code: 'busy', message: 'The family tree is busy — please try again.' };
    expect(mapped(pg('57014'))).toEqual(busy);
    expect(mapped(pg('55P03'))).toEqual(busy);
    const other = pg('08006');
    expect(mapDbError(other, log)).toBe(other);
    const api = new ApiError(400, 'no_change');
    expect(mapDbError(api, log)).toBe(api);
  });

  it('refuses an unknown kind or invalid params before touching the database', async () => {
    const pool = { connect: vi.fn(), query: vi.fn() };
    const editor = { email: 'ed@example.test', name: 'Ed', role: 'editor' };
    await expect(runChange(pool, editor, 'rename_planet', {})).rejects.toMatchObject({ status: 400, code: 'invalid', extra: { field: 'kind' } });
    await expect(runChange(pool, editor, 'constructor', {})).rejects.toMatchObject({ status: 400, code: 'invalid', extra: { field: 'kind' } });
    await expect(runChange(pool, editor, 'update_person', { id: 'I1' })).rejects.toMatchObject({ status: 400, code: 'invalid', extra: { field: 'expectedUpdatedAt' } });
    expect(pool.connect).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
  });

  describe('prepare', () => {
    const editor = { email: 'ed@example.test', name: 'Ed', role: 'editor' };
    const VIEW = { person: { id: 'I1' } };

    /** A pool whose transaction answers runChange's statements, recording 'connect', 'begin' and 'commit' in `calls`. */
    function fakePool(calls) {
      const client = {
        query: vi.fn(async (sql) => {
          if (sql === 'begin' || sql === 'commit' || sql === 'rollback') calls.push(sql);
          if (/begin_change/.test(sql)) return { rows: [{ id: '5' }] };
          if (/from change_row/.test(sql)) return { rows: [{ n: 1 }] };
          if (/person_view/.test(sql)) return { rows: [{ view: VIEW }] };
          return { rows: [] };
        }),
        release: vi.fn()
      };
      return {
        client,
        query: vi.fn(),
        connect: vi.fn(async () => {
          calls.push('connect');
          return client;
        })
      };
    }

    /** A command that records each step in `calls`; `prepare` returns `prepared`, or throws it when it is an Error. */
    function fakeCommand(calls, prepared, { withPrepare = true } = {}) {
      const command = {
        kind: 'fake',
        validate: vi.fn((params) => {
          calls.push('validate');
          return { ...params, clean: true };
        }),
        run: vi.fn(async () => {
          calls.push('run');
          return { summary: 'Did a fake thing', personIds: ['I1'], focusId: 'I1' };
        })
      };
      if (withPrepare) {
        command.prepare = vi.fn(async () => {
          calls.push('prepare');
          if (prepared instanceof Error) throw prepared;
          return prepared;
        });
      }
      return command;
    }

    it('runs prepare after validate and before the transaction, and passes its result to run', async () => {
      const calls = [];
      const pool = fakePool(calls);
      const prepared = [{ contentType: 'image/jpeg', byteSize: 10, width: 4, height: 3 }];
      const command = fakeCommand(calls, prepared);
      const context = { headObject: vi.fn() };
      const result = await runChange(pool, editor, 'fake', { a: 1 }, { commands: new Map([['fake', command]]), context });

      expect(calls).toEqual(['validate', 'prepare', 'connect', 'begin', 'run', 'commit']);
      expect(command.prepare).toHaveBeenCalledWith({ a: 1, clean: true }, context);
      expect(command.run).toHaveBeenCalledWith(pool.client, { a: 1, clean: true }, editor, prepared);
      expect(result).toEqual({ change: { id: 5, summary: 'Did a fake thing', personIds: ['I1'] }, view: VIEW });
      // The recorded params are the ones the client sent, not prepare's results.
      const beginChange = pool.client.query.mock.calls.find(([sql]) => /begin_change/.test(sql));
      expect(beginChange[1][3]).toBe(JSON.stringify({ a: 1 }));
    });

    it('gives prepare an empty context by default', async () => {
      const calls = [];
      const command = fakeCommand(calls, 'ready');
      await runChange(fakePool(calls), editor, 'fake', {}, { commands: new Map([['fake', command]]) });
      expect(command.prepare).toHaveBeenCalledWith({ clean: true }, {});
      expect(command.run.mock.calls[0][3]).toBe('ready');
    });

    it('never opens the transaction when prepare throws, and passes its error through unchanged', async () => {
      const calls = [];
      const pool = fakePool(calls);
      const missing = new ApiError(400, 'missing_upload', { index: 0, field: 'upload' });
      const command = fakeCommand(calls, missing);
      await expect(runChange(pool, editor, 'fake', {}, { commands: new Map([['fake', command]]) })).rejects.toBe(missing);
      expect(calls).toEqual(['validate', 'prepare']);
      expect(pool.connect).not.toHaveBeenCalled();
      expect(command.run).not.toHaveBeenCalled();
    });

    it('runs a command without prepare with undefined as the fourth argument', async () => {
      const calls = [];
      const pool = fakePool(calls);
      const command = fakeCommand(calls, null, { withPrepare: false });
      await runChange(pool, editor, 'fake', {}, { commands: new Map([['fake', command]]), context: { headObject: vi.fn() } });
      expect(calls).toEqual(['validate', 'connect', 'begin', 'run', 'commit']);
      expect(command.run.mock.calls[0]).toHaveLength(4);
      expect(command.run.mock.calls[0][3]).toBeUndefined();
    });
  });
});
