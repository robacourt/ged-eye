// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TEST_DATABASE_URL as url, resetTestDatabase, withChange } from './testDatabase.js';

// Deceased when the (known or estimated) year is before this; 010 reads the year from now().
const CUTOFF = new Date().getFullYear() - 100;

// [id, columns]: everyone is named after their id; columns are person columns, facts as an object.
const PEOPLE = [
  // Override, both ways, against the estimate.
  ['OVL', { birth_date: '1800', living_override: 'living' }],
  ['OVD', { birth_date: String(CUTOFF + 50), living_override: 'deceased' }],
  // Death records.
  ['DD', { birth_date: String(CUTOFF + 30), death_date: String(CUTOFF + 80) }],
  ['DP', { death_place: 'Hull' }],
  ['BD', { burial_date: 'ABT 1990' }],
  ['BP', { burial_place: 'Leeds' }],
  ['CD', { facts: { causeOfDeath: 'Fever' } }],
  ['DN', { facts: { deathNotes: ['Died at home'] } }],
  ['BN', { facts: { burialNotes: 'Churchyard' } }],
  ['EMPTYNOTES', { facts: { deathNotes: [], burialNotes: '  ', causeOfDeath: '' } }],
  // Known years either side of the line; baptism when there's no birth.
  ['Y0', { birth_date: `ABT ${CUTOFF - 1}` }],
  ['Y1', { birth_date: `1 JAN ${CUTOFF}` }],
  ['BAP', { baptism_date: String(CUTOFF - 1) }],
  // No data, and nobody near.
  ['NONE', {}],
  // Estimates at distance 1: parent (+25), child (-25), spouse and sibling (0).
  ['PAR0', { birth_date: String(CUTOFF - 26) }], ['KID0', {}],
  ['PAR1', { birth_date: String(CUTOFF - 25) }], ['KID1', {}],
  ['OLD0', {}], ['YOUNG0', { birth_date: String(CUTOFF + 24) }],
  ['OLD1', {}], ['YOUNG1', { birth_date: String(CUTOFF + 25) }],
  ['HUS', {}], ['WIFE', { birth_date: String(CUTOFF - 1) }],
  ['SIB', {}], ['SIBY', { birth_date: String(CUTOFF + 3) }],
  // Distance 2 and 3 up a line of ancestors: great-grandparent at 3 (+75).
  ['GG', { birth_date: String(CUTOFF - 76) }], ['G', {}], ['P', {}], ['ME3', {}],
  ['GG1', { birth_date: String(CUTOFF - 75) }], ['G1', {}], ['P1', {}], ['ME3L', {}],
  // Beyond 3 steps doesn't count.
  ['GGG', { birth_date: '1700' }], ['GG4', {}], ['G4', {}], ['P4', {}], ['ME4', {}],
  // Latest at the nearest level: one parent old, the other recent.
  ['MUM', { birth_date: '1800' }], ['DAD', { birth_date: String(CUTOFF - 20) }], ['LATE', {}],
  // The nearest level wins over a later year further out.
  ['NPAR', { birth_date: '1850' }], ['NEAR', {}], ['NSIB', {}], ['NNIECE', { birth_date: '2000' }],
  // Half-sibling (other child of a parent's other family), found at distance 2.
  ['HP', {}], ['HM1', {}], ['HM2', {}], ['HALF', {}], ['HALFSIB', { birth_date: String(CUTOFF - 1) }],
  // Photo people and relatives in a view.
  ['PH', { birth_date: '1850', death_date: '1920' }]
];

// [id, partner1, partner2, children]
const FAMILIES = [
  ['F_PAR0', 'PAR0', null, ['KID0']],
  ['F_PAR1', 'PAR1', null, ['KID1']],
  ['F_OLD0', 'OLD0', null, ['YOUNG0']],
  ['F_OLD1', 'OLD1', null, ['YOUNG1']],
  ['F_HUS', 'HUS', 'WIFE', []],
  ['F_SIB', null, null, ['SIB', 'SIBY']],
  ['F_GG', 'GG', null, ['G']], ['F_G', 'G', null, ['P']], ['F_P', 'P', null, ['ME3']],
  ['F_GG1', 'GG1', null, ['G1']], ['F_G1', 'G1', null, ['P1']], ['F_P1', 'P1', null, ['ME3L']],
  ['F_GGG', 'GGG', null, ['GG4']], ['F_GG4', 'GG4', null, ['G4']], ['F_G4', 'G4', null, ['P4']], ['F_P4', 'P4', null, ['ME4']],
  ['F_LATE', 'DAD', 'MUM', ['LATE']],
  ['F_NEAR', 'NPAR', null, ['NEAR', 'NSIB']], ['F_NSIB', 'NSIB', null, ['NNIECE']],
  ['F_H1', 'HP', 'HM1', ['HALF']], ['F_H2', 'HP', 'HM2', ['HALFSIB']]
];

function fixtureSql() {
  const literal = (value) => (value === null ? 'null' : `'${String(value).replace(/'/g, "''")}'`);
  const people = PEOPLE.map(([id, { facts = {}, ...columns }]) => {
    const names = ['id', 'given_name', 'surname', 'facts', ...Object.keys(columns)];
    const values = [id, id, 'Test', JSON.stringify(facts), ...Object.values(columns)];
    return `insert into person (${names.join(', ')}) values (${values.map(literal).join(', ')});`;
  });
  const families = FAMILIES.flatMap(([id, p1, p2, children]) => [
    `insert into family (id, partner1_id, partner2_id) values (${[id, p1, p2].map(literal).join(', ')});`,
    ...children.map((child, i) => `insert into family_child (family_id, child_id, position) values (${literal(id)}, ${literal(child)}, ${i});`)
  ]);
  const photos = `
    insert into media (sha256, original_path, file_name, content_type, byte_size, object_key, thumb_key) values
      ('live', 'Data/Media/l.jpg', 'l.jpg', 'image/jpeg', 10, 'originals/live.jpg', 'thumbs/live.webp');
    insert into person_media (person_id, media_id, position) select p, id, 0 from media, unnest(array['PH', 'NONE']) p;`;
  return [...people, ...families, photos].join('\n');
}

describe.skipIf(!url)('living people (database)', () => {
  let client;
  const living = async (id) => (await client.query('select person_is_living($1) as v', [id])).rows[0].v;
  const estimate = async (id) => (await client.query('select person_living_estimate($1) as v', [id])).rows[0].v;
  const view = async (id) => (await client.query('select person_view($1) as v', [id])).rows[0].v;

  beforeAll(async () => {
    client = await resetTestDatabase();
    await withChange(client, fixtureSql());
  }, 60000);

  afterAll(async () => {
    await client?.end();
  });

  it('returns null for an unknown id', async () => {
    expect(await living('NOPE')).toBeNull();
    expect(await estimate('NOPE')).toBeNull();
  });

  it('follows the override both ways; the estimate ignores it', async () => {
    expect([await living('OVL'), await estimate('OVL')]).toEqual([true, false]);
    expect([await living('OVD'), await estimate('OVD')]).toEqual([false, true]);
  });

  it('counts any death or burial record as deceased, but not empty notes', async () => {
    for (const id of ['DD', 'DP', 'BD', 'BP', 'CD', 'DN', 'BN']) expect([id, await living(id)]).toEqual([id, false]);
    expect(await living('EMPTYNOTES')).toBe(true);
  });

  it('uses the birth year, or else the baptism year, against the 100-year line', async () => {
    expect(await living('Y0')).toBe(false);
    expect(await living('Y1')).toBe(true);
    expect(await living('BAP')).toBe(false);
  });

  it('counts someone with nothing to go on as living', async () => {
    expect(await living('NONE')).toBe(true);
  });

  it('estimates from a parent (+25), a child (-25), a spouse and a sibling', async () => {
    expect(await living('KID0')).toBe(false); // parent CUTOFF-26 → CUTOFF-1
    expect(await living('KID1')).toBe(true); // parent CUTOFF-25 → CUTOFF
    expect(await living('OLD0')).toBe(false); // child CUTOFF+24 → CUTOFF-1
    expect(await living('OLD1')).toBe(true); // child CUTOFF+25 → CUTOFF
    expect(await living('HUS')).toBe(false);
    expect(await living('SIB')).toBe(true);
  });

  it('estimates from up to 3 steps away, and no further', async () => {
    expect(await living('ME3')).toBe(false); // great-grandparent CUTOFF-76 → CUTOFF-1
    expect(await living('ME3L')).toBe(true); // CUTOFF-75 → CUTOFF
    expect(await living('P')).toBe(false); // grandparent at 2: CUTOFF-76 + 50
    expect(await living('ME4')).toBe(true); // 1700 is 4 steps up
  });

  it('takes the latest estimate at the nearest level that has one', async () => {
    expect(await living('LATE')).toBe(true); // parents 1800 and CUTOFF-20: the latter wins
    expect(await living('NEAR')).toBe(false); // parent 1850 at 1 beats a niece born 2000 at 2
  });

  it('reaches a half-sibling through the shared parent', async () => {
    expect(await living('HALF')).toBe(false);
  });

  it('adds living, livingEstimate and livingOverride to person_record', async () => {
    expect((await view('OVD')).person).toMatchObject({ living: false, livingEstimate: true, livingOverride: 'deceased' });
    expect((await view('OVL')).person).toMatchObject({ living: true, livingEstimate: false, livingOverride: 'living' });
    const none = (await view('NONE')).person;
    expect(none).toMatchObject({ living: true, livingEstimate: true });
    expect(none).not.toHaveProperty('livingOverride');
  });

  it('adds living to each relative and to each photo person', async () => {
    const flags = async (id) => (await view(id)).family.map(({ id: relative, living: l }) => [relative, l]);
    expect(await flags('LATE')).toEqual([['DAD', false], ['MUM', false]]); // both born before the line
    expect(await flags('OLD1')).toEqual([['YOUNG1', true]]);
    const { photos } = (await view('PH')).person;
    expect(photos[0].people).toEqual([{ id: 'NONE', name: 'NONE Test', living: true }, { id: 'PH', name: 'PH Test', living: false }]);
  });

  it('refuses any other living_override', async () => {
    await expect(withChange(client, `update person set living_override = 'alive' where id = 'NONE'`)).rejects.toThrow(/check/);
  });
});
