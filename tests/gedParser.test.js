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
