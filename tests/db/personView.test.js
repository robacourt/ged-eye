// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { migrate } from '../../scripts/neon/migrate.js';

const url = process.env.DATABASE_URL_TEST;
const host = (u) => new URL(u).hostname.replace('-pooler', '');
const productionHosts = [process.env.DATABASE_URL, process.env.DATABASE_URL_UNPOOLED].filter(Boolean).map(host);
if (url && productionHosts.includes(host(url))) {
  throw new Error('DATABASE_URL_TEST points at the production branch; refusing to reset it');
}

const FIXTURE = `
insert into person (id, given_name, surname, display_name, sex, birth_date, facts, avatar_key) values
  ('I1', 'Adam', 'Smith', 'Adam Smith', 'M', '1900', '{}', null),
  ('I2', 'Beth', 'Jones', 'Beth Jones', 'F', null, '{}', null),
  ('I3', 'Carl', 'Smith', 'Carl Smith', 'M', 'ABT 1930', '{"occupations": ["Farmer"], "notes": ["A note"]}', 'avatars/c.jpg'),
  ('I4', 'Dora', 'Smith', 'Dora Smith', 'F', null, '{}', null),
  ('I5', 'Erin', 'Brown', 'Erin Brown', 'F', null, '{}', null),
  ('I6', 'Fred', 'Smith', 'Fred Smith', 'M', null, '{}', null),
  ('I7', 'Gina', 'Green', 'Gina Green', 'F', null, '{}', null),
  ('I8', 'Hugo', 'Smith', 'Hugo Smith', 'M', null, '{}', null),
  ('I9', 'Iris', 'White', 'Iris White', 'F', null, '{}', null),
  ('I10', 'Jack', 'Black', 'Jack Black', 'M', null, '{}', null),
  ('I11', 'Kate', 'Black', 'Kate Black', 'F', null, '{}', null),
  ('I12', 'Liam', 'Gray', 'Liam Gray', 'U', null, '{}', null);
insert into family (id, partner1_id, partner2_id, marriage_date, marriage_place) values
  ('F1', 'I1', 'I2', '1925', 'Yeovil'),
  ('F2', 'I1', 'I5', null, null),
  ('F10', 'I3', 'I7', '1955', null),
  ('F9', 'I3', 'I9', null, null),
  ('F5', 'I10', null, null, null);
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
});
