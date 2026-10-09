// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { parseGedcomTree, lastChild, text } from '../scripts/gedTree.js';

describe('parseGedcomTree', () => {
  it('builds nested nodes with xref, tag and value', () => {
    const [head, indi] = parseGedcomTree('0 HEAD\n0 @I1@ INDI\n1 NAME Ann /Ash/\n1 BIRT\n2 DATE 1900\n1 SEX F');
    expect(head).toEqual({ level: 0, xref: null, tag: 'HEAD', value: '', children: [] });
    expect(indi.xref).toBe('I1');
    expect(indi.children.map(c => [c.tag, c.value])).toEqual([['NAME', 'Ann /Ash/'], ['BIRT', ''], ['SEX', 'F']]);
    expect(indi.children[1].children).toEqual([{ level: 2, xref: null, tag: 'DATE', value: '1900', children: [] }]);
  });

  it('folds CONC with no separator and CONT with a newline, including blank CONT lines', () => {
    const [indi] = parseGedcomTree('0 @I1@ INDI\n1 NOTE He was a mil\n2 CONC ler.\n2 CONT \n2 CONT\n2 CONT Second para');
    expect(indi.children).toHaveLength(1);
    expect(indi.children[0].value).toBe('He was a miller.\n\n\nSecond para');
    expect(indi.children[0].children).toEqual([]);
  });

  it('keeps values verbatim apart from the line ending', () => {
    const [indi] = parseGedcomTree('0 @I1@ INDI\r\n1 NOTE  Message Boards  Login\r\n2 CONT       Search:\r\n');
    expect(indi.children[0].value).toBe(' Message Boards  Login\n      Search:');
  });

  it('folds a continuation into its parent even after a sibling subtree', () => {
    const [indi] = parseGedcomTree('0 @I1@ INDI\n1 NOTE a\n2 SOUR @S1@\n3 PAGE p\n2 CONT b');
    expect(indi.children[0].value).toBe('a\nb');
    expect(indi.children[0].children.map(c => c.tag)).toEqual(['SOUR']);
  });

  it('skips blank, malformed and orphan lines', () => {
    const roots = parseGedcomTree('1 NAME Orphan\n\n   \nnot gedcom\n0 @I1@ INDI\n1 NAME A /B/');
    expect(roots.map(r => r.xref)).toEqual(['I1']);
    expect(roots[0].children).toHaveLength(1);
  });
});

describe('tree helpers', () => {
  it('lastChild finds the last direct child with a tag, and text trims', () => {
    const [indi] = parseGedcomTree('0 @I1@ INDI\n1 NAME  First \n1 NAME Second\n2 NAME Nested');
    expect(text(lastChild(indi, 'NAME'))).toBe('Second');
    expect(lastChild(indi, 'SEX')).toBeUndefined();
  });
});
