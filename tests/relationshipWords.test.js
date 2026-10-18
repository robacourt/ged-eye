import { describe, it, expect } from 'vitest';
import { bloodTerm, relationTerm, describeRelationship } from '../src/relationshipWords.js';

/** A path from "Robert" through steps like 'parent:M' (step and the sex of the person reached). */
const path = (...steps) => [
  { name: 'Robert Michael A\'Court', sex: 'M', step: null },
  ...steps.map((text, i) => {
    const [step, sex] = text.split(':');
    return { name: `Person ${i + 1}`, sex, step };
  })
];
const term = (...steps) => relationTerm(path(...steps));

describe('bloodTerm', () => {
  it('names ancestors', () => {
    expect([1, 2, 3, 4, 5, 6].map(up => bloodTerm(up, 0, 'M'))).toEqual([
      'father', 'grandfather', 'great-grandfather', 'great-great-grandfather', '3× great-grandfather', '4× great-grandfather'
    ]);
    expect(bloodTerm(2, 0, 'F')).toBe('grandmother');
    expect(bloodTerm(1, 0, 'U')).toBe('parent');
  });

  it('names descendants', () => {
    expect([1, 2, 3, 4].map(down => bloodTerm(0, down, 'F'))).toEqual(['daughter', 'granddaughter', 'great-granddaughter', 'great-great-granddaughter']);
    expect(bloodTerm(0, 2, 'U')).toBe('grandchild');
  });

  it('names brothers and sisters, nephews and nieces, uncles and aunts', () => {
    expect(bloodTerm(1, 1, 'M')).toBe('brother');
    expect(bloodTerm(1, 1, 'F', true)).toBe('half-sister');
    expect([2, 3, 4].map(down => bloodTerm(1, down, 'M'))).toEqual(['nephew', 'grandnephew', 'great-grandnephew']);
    expect(bloodTerm(1, 2, 'F')).toBe('niece');
    expect(bloodTerm(1, 2, 'U')).toBe('niece or nephew');
    expect([2, 3, 4, 5].map(up => bloodTerm(up, 1, 'F'))).toEqual(['aunt', 'great-aunt', 'great-great-aunt', '3× great-aunt']);
    expect(bloodTerm(2, 1, 'M', true)).toBe('half-uncle');
    expect(bloodTerm(2, 1, 'U')).toBe('aunt or uncle');
  });

  it('names cousins, how many times removed', () => {
    expect(bloodTerm(2, 2, 'M')).toBe('first cousin');
    expect(bloodTerm(3, 3, 'F')).toBe('second cousin');
    expect(bloodTerm(2, 3, 'U')).toBe('first cousin once removed');
    expect(bloodTerm(4, 2, 'U')).toBe('first cousin twice removed');
    expect(bloodTerm(5, 2, 'U')).toBe('first cousin 3 times removed');
    expect(bloodTerm(4, 5, 'U', true)).toBe('half-third cousin once removed');
    expect(bloodTerm(12, 12, 'M')).toBe('11th cousin');
    expect(bloodTerm(22, 22, 'M')).toBe('21st cousin');
  });

  it('gives nothing for the person themselves', () => {
    expect(bloodTerm(0, 0, 'M')).toBeNull();
  });
});

describe('relationTerm', () => {
  it('names a blood relation from the path, a brother or sister counting one up and one down', () => {
    expect(term('parent:M', 'parent:M')).toBe('grandfather');
    expect(term('parent:F', 'sibling:F')).toBe('aunt');
    expect(term('parent:M', 'sibling:M', 'child:F')).toBe('first cousin');
    expect(term('parent:M', 'parent:M', 'sibling:M', 'child:M', 'child:F')).toBe('second cousin');
    expect(term('parent:M', 'sibling:M', 'child:F', 'child:F')).toBe('first cousin once removed');
    expect(term('sibling:M', 'child:F')).toBe('niece');
    expect(term('halfSibling:M')).toBe('half-brother');
    expect(term('parent:M', 'halfSibling:M')).toBe('half-uncle');
    expect(term('child:M', 'child:F')).toBe('granddaughter');
  });

  it('names in-laws and step-relations', () => {
    expect(term('spouse:F')).toBe('wife');
    expect(term('spouse:M')).toBe('husband');
    expect(term('spouse:F', 'parent:M')).toBe('father-in-law');
    expect(term('spouse:F', 'sibling:F')).toBe('sister-in-law');
    expect(term('sibling:M', 'spouse:F')).toBe('sister-in-law');
    expect(term('child:M', 'spouse:F')).toBe('daughter-in-law');
    expect(term('parent:F', 'spouse:M')).toBe('stepfather');
    expect(term('spouse:F', 'child:M')).toBe('stepson');
    expect(term('spouse:U', 'child:U')).toBe('stepchild');
  });

  it('chains anything else: each marriage between named stretches of blood relation', () => {
    expect(term('spouse:F', 'parent:M', 'sibling:F', 'child:M')).toBe("wife's first cousin");
    expect(term('spouse:F', 'parent:M', 'parent:M')).toBe("wife's grandfather");
    expect(term('parent:F', 'spouse:M', 'child:M')).toBe("mother's husband's son");
    expect(term('sibling:F', 'spouse:M', 'parent:F')).toBe("sister's husband's mother");
  });

  it('falls back to each step\'s own word for a stretch of an unusual shape', () => {
    expect(term('child:M', 'parent:F')).toBe("son's mother");
  });

  it('gives nothing for the person themselves', () => {
    expect(term()).toBeNull();
  });
});

describe('describeRelationship', () => {
  it('says who the person is to the relative, in a sentence', () => {
    const clement = [
      { name: 'Robert Michael A\'Court', sex: 'M', step: null },
      { name: 'Ian John A\'Court', sex: 'M', step: 'parent' },
      { name: 'Clement Bernard A\'Court', sex: 'M', step: 'parent' }
    ];
    expect(describeRelationship(clement)).toBe("Clement Bernard A'Court is Robert Michael A'Court's grandfather.");
  });

  it('names someone unnamed, and says so for the same person', () => {
    expect(describeRelationship([{ name: '', sex: 'U', step: null }, { name: 'Ann', sex: 'F', step: 'parent' }]))
      .toBe("Ann is Unnamed person's mother.");
    expect(describeRelationship([{ name: 'Ann', sex: 'F', step: null }])).toBe("That's Ann.");
    expect(describeRelationship(null)).toBeNull();
  });
});
