// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import pg from 'pg';
import { ROOT } from '../../scripts/neon/cli.js';
import { migrate, migrationChecksum } from '../../scripts/neon/migrate.js';

const url = process.env.DATABASE_URL_TEST;
const host = (u) => new URL(u).hostname.replace('-pooler', '');
const productionHosts = [process.env.DATABASE_URL, process.env.DATABASE_URL_UNPOOLED].filter(Boolean).map(host);
if (url && productionHosts.length === 0) {
  throw new Error('DATABASE_URL_TEST is set but DATABASE_URL and DATABASE_URL_UNPOOLED are not, so it cannot be checked against production; run via npm run test:db');
}
if (url && productionHosts.includes(host(url))) {
  throw new Error('DATABASE_URL_TEST points at the production branch; refusing to reset it');
}

const FIXTURE = `
insert into person (id, given_name, surname, display_name, sex, birth_date, burial_date, facts, avatar_key) values
  ('I1', 'Adam', 'Smith', 'Adam Smith', 'M', '1900', '1980', '{}', null),
  ('I2', 'Beth', 'Jones', 'Beth Jones', 'F', null, null, '{}', null),
  ('I3', 'Carl', 'Smith', 'Carl Smith', 'M', 'ABT 1930', null, '{"occupations": ["Farmer"], "notes": ["A note"]}', 'avatars/c.jpg'),
  ('I4', 'Dora', 'Smith', 'Dora Smith', 'F', null, null, '{}', null),
  ('I5', 'Erin', 'Brown', 'Erin Brown', 'F', null, null, '{}', null),
  ('I6', 'Fred', 'Smith', 'Fred Smith', 'M', null, null, '{}', null),
  ('I7', 'Gina', 'Green', 'Gina Green', 'F', null, null, '{}', null),
  ('I8', 'Hugo', 'Smith', 'Hugo Smith', 'M', null, null, '{}', null),
  ('I9', 'Iris', 'White', 'Iris White', 'F', null, null, '{}', null),
  ('I10', 'Jack', 'Black', 'Jack Black', 'M', null, null, '{}', null),
  ('I11', 'Kate', 'Black', 'Kate Black', 'F', null, null, '{}', null),
  ('I12', 'Liam', 'Gray', 'Liam Gray', 'U', null, null, '{}', null);
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
    client = new pg.Client({ connectionString: url });
    await client.connect();
    await client.query('drop schema public cascade; create schema public;');
    await migrate(url, { log: () => {} });
    await client.query(FIXTURE);
  }, 60000);

  afterAll(async () => {
    await client?.end();
  });

  it('returns null for an unknown id', async () => {
    expect(await view('I999')).toBeNull();
  });

  it('returns relationships in order, including half siblings and their other parent', async () => {
    const v = await view('I3');
    expect(v.relationships).toEqual({
      parents: ['I1', 'I2'],
      spouses: ['I9', 'I7'],
      children: ['I8'],
      siblings: ['I4', 'I6']
    });
    expect(v.family.map(m => m.id)).toEqual(['I1', 'I2', 'I9', 'I7', 'I8', 'I4', 'I6', 'I5']);
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
      spouseIds: ['I9', 'I7'],
      childIds: ['I8'],
      avatarKey: 'avatars/c.jpg',
      marriages: [
        { spouseId: 'I9', familyId: 'F9' },
        { spouseId: 'I7', familyId: 'F10', marriageDate: '1955' }
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
      await client.query(`update person set facts = '{"id": "X", "name": "Bogus", "parentIds": ["I1"], "occupations": ["Smith"]}' where id = 'I12'`);
      const { person } = await view('I12');
      expect(person).toMatchObject({ id: 'I12', name: 'Liam Gray', parentIds: [], occupations: ['Smith'] });
    } finally {
      await client.query('rollback');
    }
    await expect(client.query(`update person set facts = '[]' where id = 'I12'`)).rejects.toThrow(/person_facts_is_object/);
  });

  it('finds maternal half siblings and their other parent', async () => {
    await client.query('begin');
    try {
      // F3 reaches I3 only through partner2 (I2, I3's mother).
      await client.query(`
        insert into person (id, display_name, sex) values ('I13', 'Mark Hill', 'M'), ('I14', 'Nora Hill', 'F');
        insert into family (id, partner1_id, partner2_id) values ('F3', 'I13', 'I2');
        insert into family_child (family_id, child_id, position) values ('F3', 'I14', 0);
      `);
      const carl = await view('I3');
      expect(carl.relationships.siblings).toEqual(['I4', 'I6', 'I14']);
      expect(carl.family.map(m => m.id)).toEqual(['I1', 'I2', 'I9', 'I7', 'I8', 'I4', 'I6', 'I14', 'I13', 'I5']);
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
