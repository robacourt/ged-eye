// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { parseGedcomTree } from '../scripts/gedTree.js';
import { individualFacts } from '../scripts/gedFacts.js';

const facts = (lines) => individualFacts(parseGedcomTree(`0 @I1@ INDI\n${lines}`)[0]);

describe('individualFacts', () => {
  it('returns nothing for a person with no facts', () => {
    expect(facts('1 NAME A /B/\n1 SEX M\n1 FAMS @F1@')).toEqual({});
  });

  it('keeps only person-level notes, in full, trimming only the end', () => {
    expect(facts([
      '1 NOTE  Indented first line', '2 CONT second', '2 CONT ', '1 NOTE   ', '1 OCCU Miller', '2 NOTE On the occupation',
      '1 SOUR @S1@', '2 NOTE On the citation'
    ].join('\n'))).toMatchObject({ notes: [' Indented first line\nsecond'] });
  });

  it('gives occupations their date, place and notes', () => {
    expect(facts('1 OCCU Miller\n2 DATE 1881\n2 PLAC Stalbridge\n2 NOTE Employs 2 men\n1 OCCU \n1 OCCU \n2 NOTE Only a note').occupations).toEqual([
      { value: 'Miller', date: '1881', place: 'Stalbridge', notes: ['Employs 2 men'] },
      { notes: ['Only a note'] }
    ]);
  });

  it('keeps census entries with a date, place or notes, and their transcriptions', () => {
    const result = facts([
      '1 CENS', '2 DATE 1851', '2 PLAC Marnhull', '2 SOUR @S1@', '3 NOTE Citation note', '2 NOTE Age 59', '3 CONT Miller',
      '1 CENS', '2 NOTE Only a transcription', '1 CENS', '2 SOUR @S2@',
      '1 RESI', '2 PLAC Prison, Poaching', '2 NOTE 3 months'
    ].join('\n'));
    expect(result.censusRecords).toEqual([
      { date: '1851', place: 'Marnhull', notes: ['Age 59\nMiller'] },
      { notes: ['Only a transcription'] }
    ]);
    expect(result.residences).toEqual([{ place: 'Prison, Poaching', notes: ['3 months'] }]);
  });

  it('collects life-event notes and cause of death from the occurrence that fills the columns', () => {
    expect(facts([
      '1 BIRT', '2 DATE 1800', '2 NOTE First birth record',
      '1 BIRT', '2 DATE ABT 1801', '2 NOTE Second birth record',
      '1 BAPM', '2 NOTE Baptised at home', '1 DEAT', '2 CAUS Consumption', '2 NOTE Died as an infant',
      '1 BURI', '2 PLAC Mile End', '2 NOTE Cemetery now a car park'
    ].join('\n'))).toEqual({
      birthNotes: ['Second birth record'],
      baptismNotes: ['Baptised at home'],
      deathNotes: ['Died as an infant'],
      causeOfDeath: 'Consumption',
      burialNotes: ['Cemetery now a car park'],
      otherFacts: [{ tag: 'BIRT', date: '1800', notes: ['First birth record'] }]
    });
  });

  it('turns every other level-1 fact into otherFacts, in document order', () => {
    expect(facts([
      '1 _MILT Marnhull, Dorset, Militia List', '2 DATE 17 NOV 1799', '2 SOUR @S21@', '2 NOTE Parish of Marnhull',
      '1 CHAN', '2 DATE 18 NOV 2024', '1 REFN 12', '1 ASSO @I2@', '2 RELA Witness',
      '1 EVEN', '2 TYPE Court case', '2 DATE 27 JUN 1837', '2 PLAC Dorset County Sessions',
      '1 RELI Protestant', '2 DATE 1838', '1 EDUC Portsmouth Grammar School', '2 NOTE Sent: Monday',
      '1 _ADPF', '2 SOUR @S173@', '1 DEAT', '2 CAUS Fever', '1 DEAT', '2 DATE 1850'
    ].join('\n')).otherFacts).toEqual([
      { tag: '_MILT', value: 'Marnhull, Dorset, Militia List', date: '17 NOV 1799', notes: ['Parish of Marnhull'] },
      { tag: 'EVEN', type: 'Court case', date: '27 JUN 1837', place: 'Dorset County Sessions' },
      { tag: 'RELI', value: 'Protestant', date: '1838' },
      { tag: 'EDUC', value: 'Portsmouth Grammar School', notes: ['Sent: Monday'] },
      { tag: '_ADPF' },
      { tag: 'DEAT', cause: 'Fever' }
    ]);
  });
});
