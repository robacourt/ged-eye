// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { ApiError } from '../api/http.js';
import {
  validateFacts, validatePersonFields, validateFamilyFields, MAX_LINE, MAX_FACT_STRING, MAX_FACTS_BYTES
} from '../api/commands/validate.js';
import { nameOf, relationPhrase, listNames, UNNAMED } from '../api/commands/summary.js';
import { commandFor, COMMANDS } from '../api/commands/index.js';
import { mapDbError, runChange } from '../api/changes.js';

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

  it('lists names', () => {
    expect(listNames([])).toBe('');
    expect(listNames(['A'])).toBe('A');
    expect(listNames(['A', 'B'])).toBe('A and B');
    expect(listNames(['A', 'B', 'C'])).toBe('A, B and C');
    expect(listNames(['A', 'B', 'C', 'D'])).toBe('A, B and 2 others');
  });
});

describe('command registry', () => {
  it('registers the six commands by kind', () => {
    expect([...COMMANDS.keys()].sort()).toEqual(['add_relative', 'delete_person', 'link_existing', 'unlink', 'update_family', 'update_person']);
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
    expect(mapped(pg('23505'))).toEqual({ status: 409, code: 'conflict', reason: 'constraint', blocking: [] });
    expect(mapped(pg('23503'))).toEqual({ status: 409, code: 'conflict', reason: 'constraint', blocking: [] });
    const other = pg('57014');
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
});
