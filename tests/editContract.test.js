// @vitest-environment node
// The relative dialog's and unlink confirmation's params, run through the API's own command validators
// (api/commands), so the front end and the server can't drift apart on names, keys or familyId rules.
import { describe, it, expect } from 'vitest';
import { commandFor } from '../api/commands/index.js';
import { familyChoice, relativeParams } from '../src/relativeDialog.js';
import { unlinkParams } from '../src/unlinkConfirm.js';

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
