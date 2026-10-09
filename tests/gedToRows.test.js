// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { parseGedcom } from '../scripts/gedParser.js';
import { gedToRows, personFacts } from '../scripts/neon/gedToRows.js';

const GED = String.raw`0 HEAD
0 @I1@ INDI
1 NAME Adam /Smith/
1 SEX M
1 BIRT
2 DATE 1900
1 OCCU Farmer
1 OBJE
2 FILE C:\BK\Data\Media\a.jpg
1 OBJE
2 FILE C:\BK\Data\Media\a.jpg
1 OBJE
2 FILE C:\BK\Data\Media\a-copy.jpg
1 OBJE
2 FILE C:\BK\Data\Media\missing.jpg
1 FAMS @F1@
1 FAMS @F2@
0 @I2@ INDI
1 NAME Beth /Jones/
1 SEX F
1 FAMS @F1@
0 @I3@ INDI
1 NAME Carl /Smith/
1 SEX M
1 OBJE
2 FILE C:\BK\Data\Media\b.jpg
1 FAMC @F1@
0 @I4@ INDI
1 NAME Dora /Smith/
1 SEX F
1 OBJE
2 FILE C:\BK\Data\Media\b.jpg
1 FAMC @F1@
0 @I5@ INDI
1 NAME Erin /Brown/
1 SEX F
1 FAMS @F2@
0 @I6@ INDI
1 NAME Fred /Smith/
1 SEX M
1 FAMC @F2@
0 @I7@ INDI
1 NAME Gail /Gray/
1 SEX U
0 @F1@ FAM
1 HUSB @I1@
1 WIFE @I2@
1 CHIL @I3@
1 CHIL @I4@
1 MARR
2 DATE 1925
2 PLAC Yeovil
0 @F2@ FAM
1 HUSB @I1@
1 WIFE @I5@
1 CHIL @I6@
1 CHIL @I99@
0 TRLR`;

const file = (sha256, fileName) => ({
  sha256, fileName, objectKey: `originals/${sha256}.jpg`, thumbKey: `thumbs/${sha256}.webp`,
  contentType: 'image/jpeg', byteSize: 10
});

const MANIFEST = {
  files: {
    'Data/Media/a.jpg': file('sha-a', 'a.jpg'),
    'Data/Media/a-copy.jpg': file('sha-a', 'a-copy.jpg'),
    'Data/Media/b.jpg': file('sha-b', 'b.jpg')
  },
  avatars: { 'avatars/I1_0.jpg': 'avatars/sha-av.jpg' }
};

const AVATARS = new Map([['I1', 'avatars/I1_0.jpg'], ['I2', 'avatars/gone.jpg']]);

const rows = () => gedToRows(parseGedcom(GED), MANIFEST, AVATARS);

describe('gedToRows', () => {
  it('builds person rows with facts and avatar keys', () => {
    const { people } = rows();
    expect(people).toHaveLength(7);
    expect(people.find(p => p.id === 'I1')).toEqual({
      id: 'I1', given_name: 'Adam', surname: 'Smith', display_name: 'Adam Smith', sex: 'M',
      birth_date: '1900', birth_place: null, death_date: null, death_place: null,
      baptism_date: null, baptism_place: null, burial_date: null, burial_place: null,
      facts: { occupations: [{ value: 'Farmer' }] }, avatar_key: 'avatars/sha-av.jpg'
    });
    expect(people.find(p => p.id === 'I7').sex).toBe('U');
  });

  it('builds families and ordered children, skipping dangling children', () => {
    const { families, familyChildren, warnings } = rows();
    expect(families.find(f => f.id === 'F1')).toEqual({
      id: 'F1', partner1_id: 'I1', partner2_id: 'I2', marriage_date: '1925', marriage_place: 'Yeovil',
      divorce_date: null, divorce_place: null
    });
    expect(familyChildren).toEqual([
      { family_id: 'F1', child_id: 'I3', position: 0 },
      { family_id: 'F1', child_id: 'I4', position: 1 },
      { family_id: 'F2', child_id: 'I6', position: 0 }
    ]);
    expect(warnings).toContainEqual({ type: 'dangling_child', familyId: 'F2', detail: 'I99' });
  });

  it('de-duplicates media per person and shares media rows across people', () => {
    const { media, personMedia, warnings } = rows();
    expect(media.map(m => m.sha256).sort()).toEqual(['sha-a', 'sha-b']);
    expect(media.find(m => m.sha256 === 'sha-a')).toEqual({
      sha256: 'sha-a', original_path: 'Data/Media/a.jpg', file_name: 'a.jpg', content_type: 'image/jpeg',
      byte_size: 10, object_key: 'originals/sha-a.jpg', thumb_key: 'thumbs/sha-a.webp'
    });
    expect(personMedia).toEqual([
      { person_id: 'I1', sha256: 'sha-a', position: 0 },
      { person_id: 'I3', sha256: 'sha-b', position: 0 },
      { person_id: 'I4', sha256: 'sha-b', position: 0 }
    ]);
    expect(warnings).toContainEqual({ type: 'duplicate_media', personId: 'I1', detail: 'Data/Media/a.jpg' });
    expect(warnings).toContainEqual({ type: 'duplicate_media', personId: 'I1', detail: 'Data/Media/a-copy.jpg' });
    expect(warnings).toContainEqual({ type: 'missing_media', personId: 'I1', detail: 'Data/Media/missing.jpg' });
  });

  it('warns when a legacy avatar is not in the manifest', () => {
    const { people, warnings } = rows();
    expect(people.find(p => p.id === 'I2').avatar_key).toBeNull();
    expect(warnings).toContainEqual({ type: 'missing_avatar', personId: 'I2', detail: 'avatars/gone.jpg' });
  });

  it('handles a single-parent family', () => {
    const ged = String.raw`0 @I1@ INDI
1 NAME Jack /Black/
1 FAMS @F5@
0 @I2@ INDI
1 NAME Kate /Black/
1 FAMC @F5@
0 @F5@ FAM
1 HUSB @I1@
1 CHIL @I2@
0 TRLR`;
    const { families, familyChildren, warnings } = gedToRows(parseGedcom(ged), { files: {}, avatars: {} }, new Map());
    expect(families).toEqual([{ id: 'F5', partner1_id: 'I1', partner2_id: null, marriage_date: null, marriage_place: null, divorce_date: null, divorce_place: null }]);
    expect(familyChildren).toEqual([{ family_id: 'F5', child_id: 'I2', position: 0 }]);
    expect(warnings).toEqual([]);
  });

  it('reports FAMS/FAMC lists that disagree with family records', () => {
    const ged = String.raw`0 @I1@ INDI
1 NAME A /B/
1 FAMS @F1@
1 FAMC @F2@
0 @F1@ FAM
0 @F2@ FAM
0 TRLR`;
    const { warnings } = gedToRows(parseGedcom(ged), { files: {}, avatars: {} }, new Map());
    expect(warnings).toContainEqual({ type: 'fams_mismatch', personId: 'I1', detail: 'FAMS F1; family records ' });
    expect(warnings).toContainEqual({ type: 'famc_mismatch', personId: 'I1', detail: 'FAMC F2; family records ' });
  });

  it('personFacts keeps exactly the facts keys a person has', () => {
    expect(personFacts({ id: 'I1', name: 'A', notes: ['n'], otherFacts: [{ tag: '_MILT' }], causeOfDeath: 'Fever', religion: 'old key' }))
      .toEqual({ notes: ['n'], otherFacts: [{ tag: '_MILT' }], causeOfDeath: 'Fever' });
    expect(personFacts({ id: 'I2', name: 'B' })).toEqual({});
  });
});
