import { describe, it, expect } from 'vitest';
import { parseGedcom, extractPersonData } from '../scripts/gedParser.js';

describe('GEDCOM Parser', () => {
  const exampleGedcom = `0 HEAD
1 SOUR BROSKEEP
0 @I1@ INDI
1 NAME Ian /A'Court/
1 SEX M
1 BIRT
2 DATE 1 JAN 1980
2 PLAC London, England
1 OBJE
2 FILE C:\\Brother's Keeper 7\\Data\\Media\\photo1.jpg
1 OBJE
2 FILE C:\\Brother's Keeper 7\\Data\\Media\\photo2.jpg
1 FAMS @F1@
1 FAMC @F2@
0 @I2@ INDI
1 NAME Jane /Smith/
1 SEX F
1 BIRT
2 DATE 5 MAR 1982
1 FAMS @F1@
0 @I3@ INDI
1 NAME Tom /A'Court/
1 SEX M
1 BIRT
2 DATE 10 JUN 2010
1 FAMC @F1@
0 @I4@ INDI
1 NAME John /A'Court/
1 SEX M
1 BIRT
2 DATE 15 FEB 1950
1 FAMS @F2@
0 @I5@ INDI
1 NAME Mary /Jones/
1 SEX F
1 FAMS @F2@
0 @F1@ FAM
1 HUSB @I1@
1 WIFE @I2@
1 CHIL @I3@
0 @F2@ FAM
1 HUSB @I4@
1 WIFE @I5@
1 CHIL @I1@
0 TRLR`;

  it('should parse GEDCOM and extract individuals', () => {
    const result = parseGedcom(exampleGedcom);

    expect(result.individuals).toBeDefined();
    expect(result.individuals.size).toBe(5);
    expect(result.families).toBeDefined();
    expect(result.families.size).toBe(2);
  });

  it('should extract person data with relationships', () => {
    const result = parseGedcom(exampleGedcom);
    const person = extractPersonData(result, 'I1');

    expect(person.id).toBe('I1');
    expect(person.name).toBe('Ian A\'Court');
    expect(person.givenName).toBe('Ian');
    expect(person.surname).toBe('A\'Court');
    expect(person.sex).toBe('M');
    expect(person.birthDate).toBe('1 JAN 1980');
    expect(person.birthPlace).toBe('London, England');

    // Photos
    expect(person.photos).toHaveLength(2);
    expect(person.photos[0]).toBe('Data/Media/photo1.jpg');
    expect(person.photos[1]).toBe('Data/Media/photo2.jpg');

    // Relationships
    expect(person.spouseIds).toContain('I2');
    expect(person.childIds).toContain('I3');
    expect(person.parentIds).toContain('I4');
    expect(person.parentIds).toContain('I5');
  });

  it('should handle person with no relationships', () => {
    const singlePersonGed = `0 @I99@ INDI
1 NAME Single /Person/
1 SEX F
0 TRLR`;

    const result = parseGedcom(singlePersonGed);
    const person = extractPersonData(result, 'I99');

    expect(person.spouseIds).toHaveLength(0);
    expect(person.childIds).toHaveLength(0);
    expect(person.parentIds).toHaveLength(0);
  });
});

describe('GEDCOM parser stage 2', () => {
  it('ignores SOUR, REPO and other level-0 records after the last family', () => {
    const { families } = parseGedcom([
      '0 @F1@ FAM', '1 HUSB @I1@', '1 WIFE @I2@', '1 CHIL @I3@', '1 MARR',
      '0 @S1@ SOUR', '1 TITL 1851 Census', '1 NOTE Source note',
      '0 @R1@ REPO', '1 NAME The Public Records Office', '1 PHON 0181 392 5271', '1 EMAIL a@b.c', '0 TRLR'
    ].join('\n'));
    expect(Object.keys(families.get('F1').data).sort()).toEqual(['CHIL', 'HUSB', 'MARR', 'WIFE']);
  });

  it('keeps the lines under untracked level-1 tags off the person', () => {
    const { individuals } = parseGedcom([
      '0 @I1@ INDI', '1 NAME A /B/', '1 OCCU Miller', '2 DATE 1881', '2 NOTE Occupation note',
      '1 _MILT Militia', '2 NOTE Parish of Marnhull', '0 TRLR'
    ].join('\n'));
    expect(Object.keys(individuals.get('I1').data)).toEqual(['NAME']);
    const person = extractPersonData({ individuals, families: new Map() }, 'I1');
    expect(person.notes).toBeUndefined();
    expect(person.occupations).toEqual([{ value: 'Miller', date: '1881', notes: ['Occupation note'] }]);
    expect(person.otherFacts).toEqual([{ tag: '_MILT', value: 'Militia', notes: ['Parish of Marnhull'] }]);
  });

  it('treats level-1 OBJE and the first OBJE on a citation of an untracked tag as photos, like the legacy parser', () => {
    const { individuals } = parseGedcom(String.raw`0 @I1@ INDI
1 NAME A /B/
1 EVEN
2 SOUR @S48@
3 OBJE
4 FILE C:\BK\Data\Picture\first.pdf
3 OBJE
4 FILE C:\BK\Data\Picture\second.jpg
1 CENS
2 SOUR @S1@
3 OBJE
4 FILE C:\BK\Data\Picture\census.jpg
1 BIRT
2 SOUR @S1@
3 OBJE
4 FILE C:\BK\Data\Picture\birth.jpg
1 OBJE
2 FILE C:\BK\Data\Media\photo.jpg
0 TRLR`);
    const person = extractPersonData({ individuals, families: new Map() }, 'I1');
    expect(person.photos).toEqual(['Data/Picture/first.pdf', 'Data/Media/photo.jpg']);
  });

  it('exposes each record\'s node tree', () => {
    const { individuals } = parseGedcom('0 @I1@ INDI\n1 NAME A /B/\n0 TRLR');
    expect(individuals.get('I1').node).toMatchObject({ tag: 'INDI', xref: 'I1', children: [{ tag: 'NAME' }] });
  });

  it('keeps full multi-line person notes', () => {
    const { individuals } = parseGedcom('0 @I1@ INDI\n1 NAME A /B/\n1 NOTE First\n2 CONT Second\n2 CONC  half\n0 TRLR');
    expect(extractPersonData({ individuals, families: new Map() }, 'I1').notes).toEqual(['First\nSecond half']);
  });

  it('lets the last occurrence win, as the legacy parser did', () => {
    const { individuals } = parseGedcom([
      '0 @I1@ INDI', '1 NAME First /Name/', '1 NAME Second /Name/', '1 SEX F', '1 SEX M',
      '1 BIRT', '2 DATE 1800', '2 DATE 1801', '2 PLAC Here', '2 PLAC There', '0 TRLR'
    ].join('\n'));
    const person = extractPersonData({ individuals, families: new Map() }, 'I1');
    expect(person).toMatchObject({ name: 'Second Name', sex: 'M', birthDate: '1801', birthPlace: 'There' });
  });
});
