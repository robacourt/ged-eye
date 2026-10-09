import { describe, it, expect } from 'vitest';
import {
  FACT_KEYS, factsFromPerson, factsToForm, formToFacts, factsEqual, emptyForm, newRow
} from '../src/factsForm.js';

const roundTrip = (facts) => formToFacts(factsToForm(facts));

// Pre-backfill shapes, as on the `editing` branch today.
const OLD = {
  notes: ['A note', ''],
  occupations: ['Farmer', '', 'Miller'],
  censusRecords: [{ date: '1881', place: 'Leeds' }, { date: null, place: 'Hull' }, { date: '1901', place: null }],
  residences: [{ date: null, place: 'York' }],
  religion: 'Methodist',
  education: 'Grammar school'
};

// The full-facts model.
const NEW = {
  notes: ['  Verbatim\n\nnote', 'Second'],
  occupations: [{ value: 'Farmer', date: '1881', place: 'Leeds', notes: ['n1', 'n2'] }, { value: 'Miller' }],
  censusRecords: [{ date: '1881' }, { notes: ['only a transcription'] }, { value: 'Head', date: '1891', place: 'Hull' }],
  residences: [{ place: 'Hull' }, { value: '1 High St', date: '1900', notes: ['n'] }],
  birthNotes: ['b'],
  baptismNotes: ['c1', 'c2'],
  deathNotes: ['Died as an infant'],
  burialNotes: ['e'],
  causeOfDeath: 'Fever',
  otherFacts: [
    { tag: '_MILT', type: 'Army', value: 'Private', cause: 'War', date: '1916', place: 'France', notes: ['n'] },
    { tag: '_ADPF' },
    { tag: 'EVEN', type: 'Court case', date: '1920' },
    { tag: 'BIRT', date: '1850', place: 'Leeds' }
  ],
  email: 'a@b.example',
  phone: '0123'
};

const rowsOf = (form, kind) => form.rows.filter(row => row.kind === kind);

describe('factsFromPerson', () => {
  it('picks the facts keys out of a person record, leaving the core fields and view keys', () => {
    const person = {
      id: 'I1', name: 'Rose Smith', givenName: 'Rose', surname: 'Smith', sex: 'F', birthDate: '1900', birthPlace: 'Leeds',
      deathDate: null, deathPlace: null, baptismDate: '1900', burialPlace: 'Hull', photos: [], parentIds: [], spouseIds: [],
      childIds: [], avatarKey: null, updatedAt: '2026-10-09T12:00:00.123456Z', parentFamilies: [], marriages: [], masked: false,
      ...NEW, religion: 'Methodist', education: 'School'
    };
    expect(factsFromPerson(person)).toEqual({ ...NEW, religion: 'Methodist', education: 'School' });
    expect(factsFromPerson({ id: 'I2', name: 'X' })).toEqual({});
  });

  it('knows every key of the facts model and its predecessor', () => {
    expect([...FACT_KEYS].sort()).toEqual([
      'baptismNotes', 'birthNotes', 'burialNotes', 'causeOfDeath', 'censusRecords', 'deathNotes', 'education', 'email',
      'notes', 'occupations', 'otherFacts', 'phone', 'religion', 'residences'
    ]);
  });
});

describe('factsToForm', () => {
  it('gives an empty form for no facts', () => {
    for (const facts of [undefined, null, {}]) expect(factsToForm(facts)).toEqual(emptyForm());
    expect(formToFacts(emptyForm())).toEqual({});
  });

  it('splits new-shape facts into notes, life event notes, cause, rows and contact', () => {
    const form = factsToForm(NEW);
    expect(form.notes).toEqual(NEW.notes);
    expect(form.lifeEvents).toEqual({
      birth: { notes: ['b'] }, baptism: { notes: ['c1', 'c2'] }, death: { notes: ['Died as an infant'] }, burial: { notes: ['e'] }
    });
    expect(form.causeOfDeath).toBe('Fever');
    expect(form.email).toBe('a@b.example');
    expect(form.phone).toBe('0123');
    expect(form.legacy).toEqual({});
    // Rows in the details panel's order: occupations, other details, census records, residences.
    expect(form.rows.map(row => row.kind)).toEqual([
      'occupation', 'occupation', 'other', 'other', 'other', 'other', 'census', 'census', 'census', 'residence', 'residence'
    ]);
    expect(form.rows[0]).toMatchObject({
      kind: 'occupation', value: 'Farmer', date: '1881', place: 'Leeds', notes: ['n1', 'n2'], tag: '', type: '', cause: ''
    });
    expect(rowsOf(form, 'other')[0]).toMatchObject({
      tag: '_MILT', type: 'Army', value: 'Private', cause: 'War', date: '1916', place: 'France', notes: ['n']
    });
    expect(rowsOf(form, 'other')[1]).toMatchObject({ tag: '_ADPF', type: '', value: '', date: '', place: '', notes: [] });
  });

  it('shows old-shape values as rows: plain occupation strings, null dates and places, religion and education', () => {
    const form = factsToForm(OLD);
    expect(rowsOf(form, 'occupation').map(row => row.value)).toEqual(['Farmer', '', 'Miller']);
    expect(rowsOf(form, 'census').map(row => [row.date, row.place])).toEqual([['1881', 'Leeds'], ['', 'Hull'], ['1901', '']]);
    expect(rowsOf(form, 'other').map(row => [row.tag, row.value])).toEqual([['RELI', 'Methodist'], ['EDUC', 'Grammar school']]);
    expect(form.legacy).toEqual({});
  });

  it('does not share arrays with the facts it was given', () => {
    const facts = structuredClone(NEW);
    const form = factsToForm(facts);
    form.notes.push('x');
    form.rows[0].notes.push('x');
    form.lifeEvents.birth.notes.push('x');
    expect(facts).toEqual(NEW);
  });
});

describe('round trip', () => {
  it('returns new-shape facts unchanged', () => {
    expect(roundTrip(NEW)).toEqual(NEW);
  });

  it('returns old-shape facts unchanged, keeping strings, nulls, blank occupations, religion and education', () => {
    expect(roundTrip(OLD)).toEqual(OLD);
    expect(roundTrip(OLD).censusRecords[1]).toEqual({ date: null, place: 'Hull' }); // not { place: 'Hull' }
  });

  it('returns arrays mixing old strings and edited objects unchanged', () => {
    const facts = { occupations: ['Farmer', { value: 'Miller', date: '1890' }], otherFacts: ['odd', { tag: '_NMAR' }] };
    expect(roundTrip(facts)).toEqual(facts);
  });

  it('keeps entry keys the form does not know about', () => {
    const facts = { occupations: [{ value: 'Farmer', source: 'S1' }], otherFacts: [{ tag: 'X', extra: ['a'] }] };
    expect(roundTrip(facts)).toEqual(facts);
  });

  it('keeps legacy keys: unknown keys, empty values and shapes the form cannot edit', () => {
    const facts = {
      hobbies: ['chess'],
      notes: [],
      causeOfDeath: '',
      email: '  ',
      residences: [{ place: ['not', 'a', 'string'] }],
      otherFacts: [{ notes: 'a string, not a list' }],
      religion: { odd: 'shape' }
    };
    const form = factsToForm(facts);
    expect(form.legacy).toEqual(facts);
    expect(form.rows).toEqual([]);
    expect(formToFacts(form)).toEqual(facts);
  });

  it('keeps a __proto__ key as data', () => {
    const facts = JSON.parse('{"__proto__": ["x"], "occupations": [{"value": "A", "__proto__": "y"}]}');
    const result = roundTrip(facts);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(JSON.stringify(result)).toBe(JSON.stringify(facts));
  });
});

describe('formToFacts after edits', () => {
  it('saves an edited old-shape occupation in the new shape, and leaves the others as strings', () => {
    const form = factsToForm(OLD);
    rowsOf(form, 'occupation')[2].value = 'Corn miller';
    rowsOf(form, 'occupation')[2].date = '1890';
    expect(formToFacts(form).occupations).toEqual(['Farmer', '', { value: 'Corn miller', date: '1890' }]);
  });

  it('drops nulls from an edited old census record and keeps the untouched ones as they were', () => {
    const form = factsToForm(OLD);
    rowsOf(form, 'census')[1].notes = ['Transcribed'];
    expect(formToFacts(form).censusRecords).toEqual([
      { date: '1881', place: 'Leeds' }, { place: 'Hull', notes: ['Transcribed'] }, { date: '1901', place: null }
    ]);
  });

  it('turns an edited religion into an otherFacts entry and drops the old key', () => {
    const form = factsToForm(OLD);
    rowsOf(form, 'other')[0].value = 'Quaker';
    const facts = formToFacts(form);
    expect(facts.religion).toBeUndefined();
    expect(facts.education).toBe('Grammar school');
    expect(facts.otherFacts).toEqual([{ tag: 'RELI', value: 'Quaker' }]);
  });

  it('removes a deleted row, and the key when it was the last', () => {
    const form = factsToForm(OLD);
    form.rows = form.rows.filter(row => row.kind !== 'residence' && row.value !== 'Methodist');
    const facts = formToFacts(form);
    expect(facts.residences).toBeUndefined();
    expect(facts.religion).toBeUndefined();
    expect(facts.education).toBe('Grammar school');
  });

  it('adds new rows of every kind, trimming text and leaving out empty fields', () => {
    const form = factsToForm({});
    form.rows.push(
      { ...newRow('occupation'), value: ' Weaver ', place: 'Bradford' },
      { ...newRow('residence'), value: '2 Mill Lane', date: '1891' },
      { ...newRow('census'), date: '1891', notes: ['Head of household'] },
      { ...newRow('other'), tag: '_MILT', type: ' Navy ', value: 'Rating', cause: '', date: '1915' }
    );
    expect(formToFacts(form)).toEqual({
      occupations: [{ value: 'Weaver', place: 'Bradford' }],
      residences: [{ value: '2 Mill Lane', date: '1891' }],
      censusRecords: [{ date: '1891', notes: ['Head of household'] }],
      otherFacts: [{ tag: '_MILT', type: 'Navy', value: 'Rating', date: '1915' }]
    });
  });

  it('keeps a tag-only other fact, drops empty rows, and calls an untagged other fact an Event', () => {
    const form = factsToForm({});
    form.rows.push(
      { ...newRow('other'), tag: '_NMAR' },
      { ...newRow('other'), tag: '' },
      { ...newRow('other'), tag: '', value: 'Something happened' },
      newRow('occupation'),
      { ...newRow('census'), value: '   ' }
    );
    expect(formToFacts(form)).toEqual({ otherFacts: [{ tag: '_NMAR' }, { tag: 'EVEN', value: 'Something happened' }] });
  });

  it('drops an existing row whose fields were all cleared', () => {
    const form = factsToForm({ occupations: [{ value: 'Farmer', date: '1881' }, { value: 'Miller' }] });
    Object.assign(form.rows[0], { value: '', date: '' });
    expect(formToFacts(form)).toEqual({ occupations: [{ value: 'Miller' }] });
  });

  it('keeps unknown entry keys when the entry is edited', () => {
    const form = factsToForm({ occupations: [{ value: 'Farmer', source: 'S1' }] });
    form.rows[0].value = 'Farm labourer';
    expect(formToFacts(form)).toEqual({ occupations: [{ value: 'Farm labourer', source: 'S1' }] });
  });

  it('moves a row to another kind, dropping the fields the new kind does not have', () => {
    const form = factsToForm({ otherFacts: [{ tag: 'EVEN', type: 'Job', value: 'Clerk', cause: 'x', date: '1900' }] });
    form.rows[0].kind = 'occupation';
    expect(formToFacts(form)).toEqual({ occupations: [{ value: 'Clerk', date: '1900' }] });
  });

  it('changes notes, life event notes, cause of death and contact details', () => {
    const form = factsToForm(NEW);
    form.notes = ['Only note'];
    form.lifeEvents.birth.notes = [];
    form.lifeEvents.burial.notes.push('another');
    form.causeOfDeath = '';
    form.email = 'new@b.example';
    form.phone = '';
    const facts = formToFacts(form);
    expect(facts.notes).toEqual(['Only note']);
    expect(facts.birthNotes).toBeUndefined();
    expect(facts.burialNotes).toEqual(['e', 'another']);
    expect(facts.causeOfDeath).toBeUndefined();
    expect(facts.email).toBe('new@b.example');
    expect(facts.phone).toBeUndefined();
    expect(facts.otherFacts).toEqual(NEW.otherFacts);
  });

  it('adds to a legacy value it could not show rather than replacing it', () => {
    const form = factsToForm({ notes: [], causeOfDeath: '', residences: [{ place: ['x'] }] });
    form.notes = ['New note'];
    form.causeOfDeath = 'Old age';
    form.rows.push({ ...newRow('residence'), place: 'Leeds' });
    expect(formToFacts(form)).toEqual({ notes: ['New note'], causeOfDeath: 'Old age', residences: [{ place: ['x'] }, { place: 'Leeds' }] });
  });

  it('treats rows with missing fields as empty', () => {
    const form = factsToForm({ occupations: ['Farmer'] });
    form.rows.push({ kind: 'occupation', value: 'Smith' });
    expect(formToFacts(form)).toEqual({ occupations: ['Farmer', { value: 'Smith' }] });
  });

  it('refuses an unknown row kind', () => {
    const form = emptyForm();
    form.rows.push({ ...newRow('occupation'), kind: 'hobby' });
    expect(() => formToFacts(form)).toThrow(/hobby/);
  });
});

describe('factsEqual', () => {
  it('compares deeply, ignoring key order and undefined values', () => {
    expect(factsEqual({ a: [1, { b: 'x', c: null }] }, { a: [1, { c: null, b: 'x' }] })).toBe(true);
    expect(factsEqual({ a: 'x', b: undefined }, { a: 'x' })).toBe(true);
    expect(factsEqual({ a: null }, { a: undefined })).toBe(false);
    expect(factsEqual({ a: ['x'] }, { a: ['x', 'y'] })).toBe(false);
    expect(factsEqual({ a: 'x' }, { a: 'y' })).toBe(false);
    expect(factsEqual({ a: [] }, { a: {} })).toBe(false);
    expect(factsEqual(NEW, structuredClone(NEW))).toBe(true);
    expect(factsEqual(NEW, { ...NEW, phone: '0124' })).toBe(false);
  });
});
