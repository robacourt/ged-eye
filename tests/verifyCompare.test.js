// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  legacyExpected, diffView, splitDiffs, noteView, createNotes, collectNotes, summarizeNotes, formatNotes,
  legacyIsImage, shuffled, canonical, ORDER_FIELDS, apiMatchesView
} from '../scripts/neon/verifyCompare.js';

const person = (id, extra) => ({
  id, name: id, givenName: id, surname: '', sex: 'M', birthDate: null, birthPlace: null,
  deathDate: null, deathPlace: null, photos: [], spouseIds: [], childIds: [], parentIds: [], ...extra
});

const unique = (items) => [...new Set(items)];
const sha = (char) => char.repeat(64);
const entry = (char, fileName, contentType, { thumb = true } = {}) => ({
  sha256: sha(char),
  objectKey: `originals/${sha(char)}.${fileName.split('.').pop().toLowerCase()}`,
  thumbKey: thumb ? `thumbs/${sha(char)}.webp` : null,
  contentType,
  byteSize: 1,
  fileName
});

const MANIFEST = {
  files: {
    'Data/a.jpg': entry('a', 'a.jpg', 'image/jpeg'),
    'Data/copy of a.jpg': entry('a', 'a.jpg', 'image/jpeg'), // same content as a.jpg
    'Data/b.pdf': entry('b', 'b.pdf', 'application/pdf', { thumb: false }),
    'Data/c.JPG': entry('c', 'c.JPG', 'image/jpeg'),
    'Data/d.svg': entry('d', 'd.svg', 'application/octet-stream', { thumb: false }), // old UI: image, new: no thumbnail
    'Data/e.jfif': entry('e', 'e.jfif', 'image/jpeg') // old UI: not an image, new: has a thumbnail
  },
  avatars: {
    'avatars/C1.jpg': `avatars/${sha('1')}.jpg`,
    'avatars/P1.jpg': `avatars/${sha('2')}.jpg`
  }
};

const peopleMap = (overrides = {}) => new Map([
  ['P1', person('P1', { spouseIds: ['P2', 'P5'], childIds: ['C1', 'C2', 'H1'], avatar: 'avatars/P1.jpg' })],
  ['P2', person('P2', { spouseIds: ['P1'], childIds: ['C1', 'C2'] })],
  ['P5', person('P5', { spouseIds: ['P1'], childIds: ['H1'] })],
  ['C1', person('C1', { parentIds: ['P1', 'P2'], photos: ['Data/a.jpg', 'Data/b.pdf'], avatar: 'avatars/C1.jpg' })],
  ['C2', person('C2', { parentIds: ['P1', 'P2'] })],
  ['H1', person('H1', { parentIds: ['P1', 'P5'] })]
].map(([id, p]) => [id, { ...p, ...overrides[id] }]));

const PEOPLE = peopleMap();

/** A person_view() result as the SQL should produce it: de-duplicated ids, photos collapsed by sha. */
const actualFor = (e, people = PEOPLE, manifest = MANIFEST) => {
  const seen = new Set();
  const photos = [];
  for (const path of e.person.photos) {
    const file = manifest.files[path];
    if (seen.has(file.sha256)) continue;
    seen.add(file.sha256);
    photos.push({ key: file.objectKey, thumbKey: file.thumbKey, fileName: file.fileName, contentType: file.contentType });
  }
  const avatarKey = (legacy) => (legacy.avatar ? manifest.avatars[legacy.avatar] : null);
  return {
    person: {
      ...e.person,
      parentIds: unique(e.person.parentIds),
      spouseIds: unique(e.person.spouseIds),
      childIds: unique(e.person.childIds),
      photos,
      avatarKey: avatarKey(e.person)
    },
    family: [...e.familyIds].map(id => {
      const legacy = people.get(id);
      return {
        id, name: legacy.name, sex: legacy.sex, birthDate: legacy.birthDate ?? null,
        avatarKey: avatarKey(legacy), parentIds: unique(legacy.parentIds)
      };
    }),
    relationships: structuredClone(e.relationships)
  };
};

const diffsFor = (id, mutate, people = PEOPLE) => {
  const e = legacyExpected(people, id);
  const actual = actualFor(e, people);
  mutate?.(actual);
  return diffView(e, actual, MANIFEST, people);
};

describe('legacyExpected', () => {
  it('reproduces the old loader: siblings incl. half siblings and their other parent', () => {
    const e = legacyExpected(PEOPLE, 'C1');
    expect(e.relationships.parents).toEqual(['P1', 'P2']);
    expect(new Set(e.relationships.siblings)).toEqual(new Set(['C2', 'H1']));
    expect(e.familyIds).toEqual(new Set(['P1', 'P2', 'C2', 'H1', 'P5']));
  });

  it('never repeats an id in its relationship lists, like the old loader', () => {
    const people = peopleMap({ C1: { parentIds: ['P1', 'P2', 'P2'] }, P1: { spouseIds: ['P2', 'P5', 'P2'], childIds: ['C1', 'C1', 'C2', 'H1'] } });
    expect(legacyExpected(people, 'C1').relationships.parents).toEqual(['P1', 'P2']);
    expect(legacyExpected(people, 'P1').relationships.spouses).toEqual(['P2', 'P5']);
    expect(legacyExpected(people, 'P1').relationships.children).toEqual(['C1', 'C2', 'H1']);
  });
});

describe('diffView', () => {
  it('reports no differences for a matching view (photos, avatars and relatives included)', () => {
    const e = legacyExpected(PEOPLE, 'C1');
    const actual = actualFor(e);
    // The fixture must actually exercise the photo, avatar and relative paths.
    expect(actual.person.photos).toHaveLength(2);
    expect(actual.person.avatarKey).toBe(MANIFEST.avatars['avatars/C1.jpg']);
    expect(actual.family.find(m => m.id === 'P1').avatarKey).toBe(MANIFEST.avatars['avatars/P1.jpg']);
    expect(diffView(e, actual, MANIFEST, PEOPLE)).toEqual([]);
  });

  it('reports set and field differences', () => {
    const diffs = diffsFor('C1', actual => {
      actual.relationships = { ...actual.relationships, siblings: ['C2'] };
      actual.person = { ...actual.person, birthDate: '1900' };
    });
    expect(diffs.some(d => d.startsWith('siblings'))).toBe(true);
    expect(diffs.some(d => d.startsWith('birthDate'))).toBe(true);
  });

  it('reports an id repeated in the new data', () => {
    const diffs = diffsFor('C1', actual => {
      actual.relationships.parents = ['P1', 'P2', 'P2'];
    });
    expect(diffs).toEqual(['parents: duplicate ids in actual [P2]']);
  });

  it('ignores the re-derived facts keys but still compares email and phone', () => {
    const diffs = diffsFor('C1', actual => {
      actual.person = { ...actual.person, notes: ['new'], occupations: [{ value: 'Miller' }], censusRecords: [{ date: '1851' }],
        residences: [{ place: 'X' }], religion: 'Y', education: 'Z', email: 'new@example.com' };
    });
    expect(diffs).toEqual(['email: expected null got "new@example.com"']);
  });

  describe('photos', () => {
    it('collapses legacy paths with the same sha256 like the importer (first path wins)', () => {
      const people = peopleMap({ C1: { photos: ['Data/a.jpg', 'Data/copy of a.jpg', 'Data/b.pdf'] } });
      expect(diffsFor('C1', null, people)).toEqual([]);
    });

    it('reports a different sha order as a photos difference', () => {
      const diffs = diffsFor('C1', actual => actual.person.photos.reverse());
      expect(diffs).toHaveLength(1);
      expect(diffs[0]).toBe(`photos: expected ${canonical([sha('a'), sha('b')])} got ${canonical([sha('b'), sha('a')])}`);
    });

    it('reports a missing photo as a photos difference', () => {
      const diffs = diffsFor('C1', actual => actual.person.photos.pop());
      expect(diffs).toEqual([`photos: expected ${canonical([sha('a'), sha('b')])} got ${canonical([sha('a')])}`]);
    });

    it('reports a legacy path the manifest does not know as a photos difference', () => {
      const people = peopleMap({ C1: { photos: ['Data/a.jpg', 'Data/gone.jpg'] } });
      const e = legacyExpected(people, 'C1');
      const actual = actualFor({ ...e, person: { ...e.person, photos: ['Data/a.jpg'] } }, people);
      const diffs = diffView(e, actual, MANIFEST, people);
      expect(diffs).toHaveLength(1);
      expect(diffs[0]).toContain('missing:Data/gone.jpg');
      expect(diffs[0].startsWith('photos: ')).toBe(true);
    });

    it('fails when a photo fileName differs from the manifest', () => {
      const diffs = diffsFor('C1', actual => { actual.person.photos[1].fileName = 'other.pdf'; });
      expect(diffs).toEqual(['photo[1].fileName: expected "b.pdf" got "other.pdf"']);
    });

    it('fails when a photo contentType differs from the manifest', () => {
      const diffs = diffsFor('C1', actual => { actual.person.photos[0].contentType = 'image/png'; });
      expect(diffs).toEqual(['photo[0].contentType: expected "image/jpeg" got "image/png"']);
    });

    it('still checks fileName of the photos that match when another photo is missing', () => {
      const diffs = diffsFor('C1', actual => {
        actual.person.photos.shift();
        actual.person.photos[0].fileName = 'wrong.pdf';
      });
      expect(diffs.some(d => d.startsWith('photos: '))).toBe(true);
      expect(diffs).toContain('photo[0].fileName: expected "b.pdf" got "wrong.pdf"');
    });
  });

  describe('avatars', () => {
    it('reports a different avatar key', () => {
      const diffs = diffsFor('C1', actual => { actual.person.avatarKey = 'avatars/other.jpg'; });
      expect(diffs).toEqual([`avatarKey: expected ${MANIFEST.avatars['avatars/C1.jpg']} got avatars/other.jpg`]);
    });

    it('reports a missing avatar', () => {
      const diffs = diffsFor('C1', actual => { actual.person.avatarKey = null; });
      expect(diffs).toEqual([`avatarKey: expected ${MANIFEST.avatars['avatars/C1.jpg']} got null`]);
    });

    it('reports a legacy avatar the manifest does not know', () => {
      const people = peopleMap({ C2: { avatar: 'avatars/unknown.jpg' } });
      const diffs = diffsFor('C2', actual => { actual.person.avatarKey = null; }, people);
      expect(diffs).toEqual(['avatarKey: expected missing:avatars/unknown.jpg got null']);
    });

    it('reports an avatar for someone who has none', () => {
      const diffs = diffsFor('C2', actual => { actual.person.avatarKey = 'avatars/x.jpg'; });
      expect(diffs).toEqual(['avatarKey: expected null got avatars/x.jpg']);
    });
  });

  describe('relatives', () => {
    const memberDiffs = (mutate) => diffsFor('C1', actual => mutate(actual.family.find(m => m.id === 'P1')));

    it('reports a relative whose name, sex or birth date differs', () => {
      expect(memberDiffs(m => { m.name = 'Renamed'; })).toEqual(['family P1.name: expected P1 got Renamed']);
      expect(memberDiffs(m => { m.sex = 'F'; })).toEqual(['family P1.sex: expected M got F']);
      expect(memberDiffs(m => { m.birthDate = '1800'; })).toEqual(['family P1.birthDate: expected null got 1800']);
    });

    it('reports a relative whose parents differ', () => {
      expect(memberDiffs(m => { m.parentIds = ['P9']; })).toEqual(['family P1.parentIds: expected [] got [P9]']);
    });

    it('reports a relative whose avatar differs', () => {
      expect(memberDiffs(m => { m.avatarKey = null; }))
        .toEqual([`family P1.avatarKey: expected ${MANIFEST.avatars['avatars/P1.jpg']} got null`]);
    });

    it('reports a relative that is not in the legacy data', () => {
      const diffs = diffsFor('C1', actual => actual.family.push({ id: 'ZZ', name: 'ZZ', sex: 'M', birthDate: null, avatarKey: null, parentIds: [] }));
      expect(diffs.some(d => d === 'family ZZ: not in legacy data')).toBe(true);
    });
  });
});

describe('splitDiffs', () => {
  const photos = 'photos: expected ["a"] got []';
  const fileName = 'photo[0].fileName: expected "a" got "b"';
  const scalar = 'birthDate: expected null got "1900"';

  it('explains only a photos difference, and only with a missing_media or duplicate_media warning', () => {
    expect(splitDiffs([photos], new Set(['missing_media']))).toEqual({ explained: [photos], unexplained: [] });
    expect(splitDiffs([photos], new Set(['duplicate_media']))).toEqual({ explained: [photos], unexplained: [] });
  });

  it('leaves a photos difference unexplained without such a warning', () => {
    expect(splitDiffs([photos], undefined).unexplained).toEqual([photos]);
    expect(splitDiffs([photos], new Set()).unexplained).toEqual([photos]);
    expect(splitDiffs([photos], new Set(['unknown_sex', 'fams_mismatch', 'missing_avatar'])).unexplained).toEqual([photos]);
  });

  it('never lets a warning mask an unrelated difference', () => {
    const warned = new Set(['missing_media', 'duplicate_media', 'fams_mismatch']);
    const result = splitDiffs([scalar, photos, fileName, 'siblings: expected [A] got []', 'person_view returned null'], warned);
    expect(result.explained).toEqual([photos]);
    expect(result.unexplained).toEqual([scalar, fileName, 'siblings: expected [A] got []', 'person_view returned null']);
  });
});

describe('noteView', () => {
  const PEOPLE_WITH_DUPES = peopleMap({
    C1: { parentIds: ['P1', 'P2', 'P2'] },
    P1: { spouseIds: ['P2', 'P5', 'P2'] },
    P2: { childIds: ['C1', 'C1', 'C2'] }
  });
  const notesFor = (id, people, mutate) => {
    const e = legacyExpected(people, id);
    const actual = actualFor(e, people);
    mutate?.(actual);
    return { diffs: diffView(e, actual, MANIFEST, people), notes: noteView(e, actual, MANIFEST) };
  };

  it('reports duplicate legacy ids as notes, not failures', () => {
    const c1 = notesFor('C1', PEOPLE_WITH_DUPES);
    expect(c1.diffs).toEqual([]);
    expect(c1.notes.duplicates).toEqual([{ field: 'parentIds', ids: ['P2'] }]);
    const p1 = notesFor('P1', PEOPLE_WITH_DUPES);
    expect(p1.diffs).toEqual([]);
    expect(p1.notes.duplicates).toEqual([{ field: 'spouseIds', ids: ['P2'] }]);
    const p2 = notesFor('P2', PEOPLE_WITH_DUPES);
    expect(p2.diffs).toEqual([]);
    expect(p2.notes.duplicates).toEqual([{ field: 'childIds', ids: ['C1'] }]);
    expect(notesFor('C2', PEOPLE_WITH_DUPES).notes.duplicates).toEqual([]);
  });

  it('reports an order-only difference as a note, not a failure', () => {
    const { diffs, notes } = notesFor('C1', PEOPLE, actual => {
      actual.relationships.parents.reverse();
      actual.relationships.siblings.reverse();
      actual.person.parentIds.reverse();
    });
    expect(diffs).toEqual([]);
    expect(notes.order).toEqual(['parents', 'siblings', 'person.parentIds']);
  });

  it('reports no order note when the order matches', () => {
    expect(notesFor('C1', PEOPLE).notes.order).toEqual([]);
  });

  it('compares order after the legacy de-dup', () => {
    // Legacy [P2, P5, P2] collapses to [P2, P5]; the new data lists the same two in the same order.
    const people = peopleMap({ P1: { spouseIds: ['P2', 'P5', 'P2'] } });
    expect(notesFor('P1', people).notes.order).toEqual([]);
  });

  it('does not call a membership change an order difference (that is a failure)', () => {
    const { diffs, notes } = notesFor('C1', PEOPLE, actual => { actual.relationships.parents = ['P1']; });
    expect(diffs.some(d => d.startsWith('parents'))).toBe(true);
    expect(notes.order).not.toContain('parents');
  });

  it('reports image classification changes against the old extension test, not as failures', () => {
    const people = new Map([['X', person('X', {
      photos: ['Data/a.jpg', 'Data/b.pdf', 'Data/c.JPG', 'Data/d.svg', 'Data/e.jfif']
    })]]);
    const { diffs, notes } = notesFor('X', people);
    expect(diffs).toEqual([]);
    expect(notes.images).toEqual([
      { fileName: 'd.svg', oldImage: true, newImage: false },
      { fileName: 'e.jfif', oldImage: false, newImage: true }
    ]);
  });

  it('survives a null person_view', () => {
    const e = legacyExpected(PEOPLE, 'C1');
    expect(noteView(e, null, MANIFEST)).toEqual({ duplicates: [], order: [], images: [] });
  });
});

describe('legacyIsImage', () => {
  it('matches the old isImageFile extensions, case-insensitively', () => {
    for (const name of ['a.jpg', 'a.JPEG', 'dir/a.Png', 'a.gif', 'a.bmp', 'a.webp', 'a.SVG']) expect(legacyIsImage(name)).toBe(true);
    for (const name of ['a.jfif', 'a.tif', 'a.pdf', 'a.jpg.txt', 'jpg', 'noextension']) expect(legacyIsImage(name)).toBe(false);
  });
});

describe('notes summary', () => {
  it('counts people per field and lists up to 10 example ids per field', () => {
    const notes = createNotes();
    for (let i = 1; i <= 12; i++) collectNotes(notes, `I${i}`, { duplicates: [], order: ['siblings'], images: [] });
    collectNotes(notes, 'I2', { duplicates: [], order: ['parents'], images: [] });
    collectNotes(notes, 'I628', { duplicates: [{ field: 'parentIds', ids: ['I629'] }], order: [], images: [] });
    collectNotes(notes, 'I3', { duplicates: [], order: [], images: [
      { fileName: 'd.svg', oldImage: true, newImage: false }, { fileName: 'd.svg', oldImage: true, newImage: false }
    ] });
    collectNotes(notes, 'I4', { duplicates: [], order: [], images: [{ fileName: 'e.jfif', oldImage: false, newImage: true }] });

    const summary = summarizeNotes(notes);
    expect(Object.keys(summary.orderDifferences)).toEqual(ORDER_FIELDS);
    expect(summary).toEqual({
      duplicatesRemoved: 1,
      orderDifferences: {
        parents: 1, spouses: 0, children: 0, siblings: 12, 'person.parentIds': 0, 'person.spouseIds': 0, 'person.childIds': 0
      },
      imageClassificationChanges: { photos: 3, files: 2 }
    });

    const text = formatNotes(notes).join('\n');
    expect(text).toContain('I628.parentIds: repeated I629');
    expect(text).toContain('siblings: 12 (e.g. I1, I2, I3, I4, I5, I6, I7, I8, I9, I10, ...)');
    expect(text).not.toContain('I11,');
    expect(text).toContain('parents: 1 (e.g. I2)');
    expect(text).toContain('d.svg: image -> file (2 photo(s))');
    expect(text).toContain('e.jfif: file -> image (1 photo(s))');
  });
});

describe('shuffled', () => {
  it('does not modify its input and returns a permutation', () => {
    const input = ['a', 'b', 'c', 'd', 'e'];
    const out = shuffled(input);
    expect(input).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect([...out].sort()).toEqual(input);
  });

  it('reaches every permutation exactly once over all random sequences (Fisher-Yates is unbiased)', () => {
    const seen = new Set();
    for (let a = 0; a < 3; a++) {
      for (let b = 0; b < 2; b++) {
        const draws = [(a + 0.5) / 3, (b + 0.5) / 2];
        seen.add(shuffled([1, 2, 3], () => draws.shift()).join(''));
      }
    }
    expect(seen.size).toBe(6);
  });
});

describe('apiMatchesView', () => {
  const view = { person: { id: 'I1', notes: ['Write to jo@example.com'] }, family: [], relationships: {} };

  it('accepts the masked body the Function serves', () => {
    expect(apiMatchesView({ ...view, person: { id: 'I1', notes: ['Write to [email hidden]'] } }, view)).toBe(true);
  });

  it('rejects a real difference, and an unmasked body', () => {
    expect(apiMatchesView({ ...view, person: { id: 'I1', notes: ['Something else'] } }, view)).toBe(false);
    expect(apiMatchesView(view, view)).toBe(false);
  });
});
