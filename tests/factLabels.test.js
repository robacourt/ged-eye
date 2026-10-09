import { describe, it, expect } from 'vitest';
import { factLabel } from '../src/factLabels.js';

describe('factLabel', () => {
  it('uses the EVEN type, then the known label, then a tidied tag', () => {
    expect(factLabel({ tag: 'EVEN', type: 'Court case' })).toBe('Court case');
    expect(factLabel({ tag: 'EVEN' })).toBe('Event');
    expect(factLabel({ tag: '_MILT', type: 'ignored' })).toBe('Military service');
    expect(factLabel({ tag: 'PROB' })).toBe('Probate');
    expect(factLabel({ tag: 'DEAT' })).toBe('Death');
    expect(factLabel({ tag: '_FOO' })).toBe('Foo');
    expect(factLabel({ tag: 'XYZW' })).toBe('Xyzw');
    expect(factLabel({})).toBe('Other');
  });
});
