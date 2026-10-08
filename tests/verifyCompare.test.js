// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { legacyExpected, diffView } from '../scripts/neon/verifyCompare.js';

const person = (id, extra) => ({
  id, name: id, givenName: id, surname: '', sex: 'M', birthDate: null, birthPlace: null,
  deathDate: null, deathPlace: null, photos: [], spouseIds: [], childIds: [], parentIds: [], ...extra
});

const PEOPLE = new Map([
  ['P1', person('P1', { spouseIds: ['P2', 'P5'], childIds: ['C1', 'C2', 'H1'] })],
  ['P2', person('P2', { spouseIds: ['P1'], childIds: ['C1', 'C2'] })],
  ['P5', person('P5', { spouseIds: ['P1'], childIds: ['H1'] })],
  ['C1', person('C1', { parentIds: ['P1', 'P2'] })],
  ['C2', person('C2', { parentIds: ['P1', 'P2'] })],
  ['H1', person('H1', { parentIds: ['P1', 'P5'] })]
]);

describe('legacyExpected', () => {
  it('reproduces the old loader: siblings incl. half siblings and their other parent', () => {
    const e = legacyExpected(PEOPLE, 'C1');
    expect(e.relationships.parents).toEqual(['P1', 'P2']);
    expect(new Set(e.relationships.siblings)).toEqual(new Set(['C2', 'H1']));
    expect(e.familyIds).toEqual(new Set(['P1', 'P2', 'C2', 'H1', 'P5']));
  });
});

describe('diffView', () => {
  const manifest = { files: {}, avatars: {} };
  const actualFor = (e) => ({
    person: { ...e.person, photos: [], avatarKey: null },
    family: [...e.familyIds].map(id => ({ id, name: id, sex: 'M', birthDate: null, avatarKey: null, parentIds: PEOPLE.get(id).parentIds })),
    relationships: e.relationships
  });

  it('reports no differences for a matching view', () => {
    const e = legacyExpected(PEOPLE, 'C1');
    expect(diffView(e, actualFor(e), manifest, PEOPLE)).toEqual([]);
  });

  it('reports set and field differences', () => {
    const e = legacyExpected(PEOPLE, 'C1');
    const actual = actualFor(e);
    actual.relationships = { ...actual.relationships, siblings: ['C2'] };
    actual.person = { ...actual.person, birthDate: '1900' };
    const diffs = diffView(e, actual, manifest, PEOPLE);
    expect(diffs.some(d => d.startsWith('siblings'))).toBe(true);
    expect(diffs.some(d => d.startsWith('birthDate'))).toBe(true);
  });
});
