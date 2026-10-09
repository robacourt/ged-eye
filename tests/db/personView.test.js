// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { ROOT } from '../../scripts/neon/cli.js';
import { migrate, migrationChecksum } from '../../scripts/neon/migrate.js';
import { TEST_DATABASE_URL as url, resetTestDatabase, withChange } from './testDatabase.js';

// Tests that roll back can't use withChange (it commits): they open their own change after begin.
const BEGIN_CHANGE = `select begin_change('test@example.test', 'Test', 'fixture', 'script', 'Test', '{}', '{}')`;

const FIXTURE = `
insert into person (id, given_name, surname, sex, birth_date, burial_date, facts, avatar_key) values
  ('I1', 'Adam', 'Smith', 'M', '1900', '1980', '{}', null),
  ('I2', 'Beth', 'Jones', 'F', null, null, '{}', null),
  ('I3', 'Carl', 'Smith', 'M', 'ABT 1930', null, '{"occupations": ["Farmer"], "notes": ["A note"]}', 'avatars/c.jpg'),
  ('I4', 'Dora', 'Smith', 'F', null, null, '{}', null),
  ('I5', 'Erin', 'Brown', 'F', null, null, '{}', null),
  ('I6', 'Fred', 'Smith', 'M', null, null, '{}', null),
  ('I7', 'Gina', 'Green', 'F', null, null, '{}', null),
  ('I8', 'Hugo', 'Smith', 'M', null, null, '{}', null),
  ('I9', 'Iris', 'White', 'F', null, null, '{}', null),
  ('I10', 'Jack', 'Black', 'M', null, null, '{}', null),
  ('I11', 'Kate', 'Black', 'F', null, null, '{}', null),
  ('I12', 'Liam', 'Gray', 'U', null, null, '{}', null);
insert into family (id, partner1_id, partner2_id, marriage_date, marriage_place, divorce_date) values
  ('F1', 'I1', 'I2', '1925', 'Yeovil', null),
  ('F2', 'I1', 'I5', null, null, '1935'),
  ('F10', 'I3', 'I7', '1955', null, null),
  ('F9', 'I3', 'I9', null, null, null),
  ('F5', 'I10', null, null, null, null);
insert into family_child (family_id, child_id, position) values
  ('F1', 'I4', 0), ('F1', 'I3', 1), ('F2', 'I6', 0), ('F10', 'I8', 0), ('F5', 'I11', 0);
insert into media (sha256, original_path, file_name, content_type, byte_size, object_key, thumb_key) values
  ('aaa', 'Data/Media/a.jpg', 'a.jpg', 'image/jpeg', 10, 'originals/aaa.jpg', 'thumbs/aaa.webp'),
  ('bbb', 'Data/Media/b.docx', 'b.docx', 'application/msword', 20, 'originals/bbb.docx', null);
insert into person_media (person_id, media_id, position)
  select 'I3', id, case sha256 when 'bbb' then 0 else 1 end from media;
`;

describe.skipIf(!url)('person_view (database)', () => {
  let client;
  const view = async (id) => (await client.query('select person_view($1) as v', [id])).rows[0].v;

  beforeAll(async () => {
    client = await resetTestDatabase();
    await withChange(client, FIXTURE);
    await client.query('select sync_id_sequences()');
  }, 60000);

  afterAll(async () => {
    await client?.end();
  });

  it('returns null for an unknown id', async () => {
    expect(await view('I999')).toBeNull();
  });

  it('returns relationships in order, including half siblings and their other parent', async () => {
    const v = await view('I3');
    // F10 (married 1955) comes before F9 (undated), although F9 has the lower id.
    expect(v.relationships).toEqual({
      parents: ['I1', 'I2'],
      spouses: ['I7', 'I9'],
      children: ['I8'],
      siblings: ['I4', 'I6']
    });
    expect(v.family.map(m => m.id)).toEqual(['I1', 'I2', 'I7', 'I9', 'I8', 'I4', 'I6', 'I5']);
  });

  it('returns the full person record with facts, photos, avatar and marriages', async () => {
    const { person } = await view('I3');
    expect(person).toEqual({
      id: 'I3', name: 'Carl Smith', givenName: 'Carl', surname: 'Smith', sex: 'M',
      birthDate: 'ABT 1930', birthPlace: null, deathDate: null, deathPlace: null,
      photos: [
        { key: 'originals/bbb.docx', thumbKey: null, fileName: 'b.docx', contentType: 'application/msword' },
        { key: 'originals/aaa.jpg', thumbKey: 'thumbs/aaa.webp', fileName: 'a.jpg', contentType: 'image/jpeg' }
      ],
      parentIds: ['I1', 'I2'],
      spouseIds: ['I7', 'I9'],
      childIds: ['I8'],
      avatarKey: 'avatars/c.jpg',
      updatedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/),
      parentFamilies: [{ familyId: 'F1', partnerIds: ['I1', 'I2'], childIds: ['I4', 'I3'] }],
      marriages: [
        { spouseId: 'I7', familyId: 'F10', marriageDate: '1955' },
        { spouseId: 'I9', familyId: 'F9' }
      ],
      occupations: ['Farmer'],
      notes: ['A note']
    });
  });

  it('returns slim relative records', async () => {
    const { family } = await view('I3');
    expect(family.find(m => m.id === 'I6')).toEqual({
      id: 'I6', name: 'Fred Smith', sex: 'M', birthDate: null, avatarKey: null, parentIds: ['I1', 'I5']
    });
  });

  it('handles single-parent families and people with no family', async () => {
    const kate = await view('I11');
    expect(kate.relationships).toEqual({ parents: ['I10'], spouses: [], children: [], siblings: [] });
    expect(kate.person.marriages).toBeUndefined();

    const jack = await view('I10');
    expect(jack.relationships.children).toEqual(['I11']);
    expect(jack.relationships.spouses).toEqual([]);
    expect(jack.person.marriages).toEqual([{ spouseId: null, familyId: 'F5' }]);

    const liam = await view('I12');
    expect(liam.family).toEqual([]);
    expect(liam.person.parentIds).toEqual([]);
  });

  it('groups children per family and omits absent optional fields', async () => {
    const adam = await view('I1');
    expect(adam.relationships.children).toEqual(['I4', 'I3', 'I6']);
    expect(adam.relationships.spouses).toEqual(['I2', 'I5']);
    expect(adam.person.burialDate).toBe('1980');
    expect('baptismDate' in adam.person).toBe(false);
    expect(adam.person.marriages).toEqual([
      { spouseId: 'I2', familyId: 'F1', marriageDate: '1925', marriagePlace: 'Yeovil' },
      { spouseId: 'I5', familyId: 'F2', divorceDate: '1935' }
    ]);
  });

  it('finds spouses and children for someone who is only ever partner2', async () => {
    const beth = await view('I2');
    expect(beth.relationships).toEqual({ parents: [], spouses: ['I1'], children: ['I4', 'I3'], siblings: [] });
    expect(beth.family.map(m => m.id)).toEqual(['I1', 'I4', 'I3']);
    expect(beth.person.marriages).toEqual([
      { spouseId: 'I1', familyId: 'F1', marriageDate: '1925', marriagePlace: 'Yeovil' }
    ]);
  });

  it('never lets facts overwrite core fields, and requires facts to be an object', async () => {
    await client.query('begin');
    try {
      await client.query(BEGIN_CHANGE);
      await client.query(`update person set facts = '{"id": "X", "name": "Bogus", "parentIds": ["I1"], "parentFamilies": ["F1"], "occupations": ["Smith"]}' where id = 'I12'`);
      const { person } = await view('I12');
      expect(person).toMatchObject({ id: 'I12', name: 'Liam Gray', parentIds: [], parentFamilies: [], occupations: ['Smith'] });
    } finally {
      await client.query('rollback');
    }
    await expect(withChange(client, `update person set facts = '[]' where id = 'I12'`)).rejects.toThrow(/person_facts_is_object/);
  });

  it('finds maternal half siblings and their other parent', async () => {
    await client.query('begin');
    try {
      await client.query(BEGIN_CHANGE);
      // F3 reaches I3 only through partner2 (I2, I3's mother).
      await client.query(`
        insert into person (id, given_name, surname, sex) values ('I13', 'Mark', 'Hill', 'M'), ('I14', 'Nora', 'Hill', 'F');
        insert into family (id, partner1_id, partner2_id) values ('F3', 'I13', 'I2');
        insert into family_child (family_id, child_id, position) values ('F3', 'I14', 0);
      `);
      const carl = await view('I3');
      expect(carl.relationships.siblings).toEqual(['I4', 'I6', 'I14']);
      expect(carl.family.map(m => m.id)).toEqual(['I1', 'I2', 'I7', 'I9', 'I8', 'I4', 'I6', 'I14', 'I13', 'I5']);
    } finally {
      await client.query('rollback');
    }
  });

  it('reads the year from GEDCOM date text', async () => {
    const years = {
      '28 SEP 1940': 1940, 'ABT 1850': 1850, 'BEF 1900': 1900, '21 MAR1813': 1813, '12.2.1877': 1877,
      '11 FEB 1671/72': 1671, 'BET. 1924 - 1939': 1924, 'BEF 30 MAY 185': null, '18 ___ 19 ?': null, 'yes': null,
      '１９４０': null // fullwidth digits: no year rather than a failed cast
    };
    const { rows } = await client.query('select d, gedcom_year(d) as year from unnest($1::text[]) as d', [Object.keys(years)]);
    expect(Object.fromEntries(rows.map(r => [r.d, r.year]))).toEqual(years);
    expect((await client.query('select gedcom_year(null) as year')).rows[0].year).toBeNull();
  });

  // Paul (I20) married seven times; his family ids are not in chronological order.
  // F97 has no marriage date; its children were born 1860 and baptised 1850, so it dates from 1850.
  // F101's marriage date has no year ('yes'), so its child's 1870 birth dates it (not his 1890 adult baptism).
  // F96 and F102 have no marriage year and no dated children, so they go last.
  const REMARRIAGES = `
    insert into person (id, given_name, surname, sex, birth_date, baptism_date) values
      ('I20', 'Paul', 'Long', 'M', null, null), ('I21', 'Ann', 'Long', 'F', null, null), ('I22', 'Bea', 'Long', 'F', null, null),
      ('I23', 'Cleo', 'Long', 'F', null, null), ('I24', 'Dee', 'Long', 'F', null, null), ('I25', 'Eve', 'Long', 'F', '1849', null),
      ('I26', 'Finn', 'Long', 'M', null, null), ('I27', 'Gus', 'Long', 'M', null, null), ('I28', 'Hal', 'Long', 'M', '1860', null),
      ('I29', 'Ida', 'Long', 'F', null, null), ('I30', 'Jo', 'Long', 'F', null, null), ('I31', 'Kit', 'Long', 'M', null, null),
      ('I32', 'Lou', 'Long', 'M', null, '3 MAR 1850'), ('I33', 'Max', 'Long', 'M', '2 JAN 1870', '1890'), ('I34', 'Nan', 'Long', 'F', null, null);
    insert into family (id, partner1_id, partner2_id, marriage_date) values
      ('F96', 'I20', 'I30', null),
      ('F97', 'I20', 'I23', null),
      ('F98', 'I20', 'I21', '22 JUL 1885'),
      ('F99', 'I20', 'I22', 'BEF 1856'),
      ('F100', 'I20', 'I24', '29 SEP 1856'),
      ('F101', 'I20', 'I29', 'yes'),
      ('F102', 'I20', 'I34', null);
    insert into family_child (family_id, child_id, position) values
      ('F96', 'I31', 0), ('F97', 'I28', 0), ('F97', 'I32', 1), ('F98', 'I25', 0), ('F99', 'I26', 0), ('F100', 'I27', 0),
      ('F101', 'I33', 0);
  `;

  it('orders a person\'s families by marriage year, else eldest child\'s birth year, then undated by family id', async () => {
    await client.query('begin');
    try {
      await client.query(BEGIN_CHANGE);
      await client.query(REMARRIAGES);
      const paul = await view('I20');
      // F99 and F100 are both 1856, and F96 and F102 are both undated, so the numeric id decides
      // (as text, 'F100' < 'F99' and 'F102' < 'F96').
      // F98 stays at 1885 although Eve (I25) was born in 1849: a marriage year always wins.
      expect(paul.person.marriages.map(m => m.familyId)).toEqual(['F97', 'F99', 'F100', 'F101', 'F98', 'F96', 'F102']);
      expect(paul.relationships.spouses).toEqual(['I23', 'I22', 'I24', 'I29', 'I21', 'I30', 'I34']);
      expect(paul.person.spouseIds).toEqual(['I23', 'I22', 'I24', 'I29', 'I21', 'I30', 'I34']);
      expect(paul.relationships.children).toEqual(['I28', 'I32', 'I26', 'I27', 'I33', 'I25', 'I31']);
      expect(paul.person.childIds).toEqual(['I28', 'I32', 'I26', 'I27', 'I33', 'I25', 'I31']);
      expect(paul.family.map(m => m.id)).toEqual([
        'I23', 'I22', 'I24', 'I29', 'I21', 'I30', 'I34', 'I28', 'I32', 'I26', 'I27', 'I33', 'I25', 'I31'
      ]);
    } finally {
      await client.query('rollback');
    }
  });

  it('orders siblings by their parents\' families, chronologically', async () => {
    await client.query('begin');
    try {
      await client.query(BEGIN_CHANGE);
      await client.query(REMARRIAGES);
      const eve = await view('I25');
      expect(eve.relationships.siblings).toEqual(['I28', 'I32', 'I26', 'I27', 'I33', 'I31']);
    } finally {
      await client.query('rollback');
    }
  });

  it('orders parents from several families chronologically', async () => {
    await client.query('begin');
    try {
      await client.query(BEGIN_CHANGE);
      // Hugo (I8) is also recorded as a child of F9 (I3 + I9, undated); F10 (I3 + I7) was 1955.
      await client.query(`insert into family_child (family_id, child_id, position) values ('F9', 'I8', 0)`);
      const hugo = await view('I8');
      expect(hugo.relationships.parents).toEqual(['I3', 'I7', 'I9']);
      expect(hugo.person.parentIds).toEqual(['I3', 'I7', 'I9']);
      const carl = await view('I3');
      expect(carl.family.find(m => m.id === 'I8').parentIds).toEqual(['I3', 'I7', 'I9']);
    } finally {
      await client.query('rollback');
    }
  });

  const migrationsDir = path.join(ROOT, 'db', 'migrations');
  const fileSha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(path.join(migrationsDir, file))).digest('hex');
  const storedChecksum = async (file) =>
    (await client.query('select checksum from schema_migrations where filename = $1', [file])).rows[0]?.checksum;

  it('records migration checksums, backfills missing ones and ignores CRLF line endings', async () => {
    const file = '002_person_view.sql';
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    expect(sql).not.toContain('\r');
    expect(await storedChecksum(file)).toBe(fileSha256(file));
    expect(migrationChecksum(sql.replace(/\n/g, '\r\n'))).toBe(fileSha256(file));

    await client.query('update schema_migrations set checksum = null where filename = $1', [file]);
    await migrate(url, { log: () => {} });
    expect(await storedChecksum(file)).toBe(fileSha256(file));
  });

  it('checks every applied migration before applying a pending one', async () => {
    const pending = '003_gedcom_archive.sql';
    const edited = '004_person_view_indexed.sql';
    await client.query('delete from schema_migrations where filename = $1', [pending]);
    await client.query(`update schema_migrations set checksum = 'edited' where filename = $1`, [edited]);
    try {
      await expect(migrate(url, { log: () => {} })).rejects.toThrow(`Migration ${edited} has changed since it was applied`);
      expect(await storedChecksum(pending)).toBeUndefined();
    } finally {
      await client.query('insert into schema_migrations (filename, checksum) values ($1, $2)', [pending, fileSha256(pending)]);
      await client.query('update schema_migrations set checksum = $2 where filename = $1', [edited, fileSha256(edited)]);
    }
  });

  it('refuses to run when an applied migration file is missing', async () => {
    await client.query(`insert into schema_migrations (filename, checksum) values ('000_removed.sql', 'x')`);
    try {
      await expect(migrate(url, { log: () => {} }))
        .rejects.toThrow('Migration 000_removed.sql was applied but its file is missing from db/migrations');
    } finally {
      await client.query(`delete from schema_migrations where filename = '000_removed.sql'`);
    }
    await migrate(url, { log: () => {} });
  });
});
