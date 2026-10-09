// @vitest-environment node
// The person.facts keys are listed in four places that can't import each other (the server, the edit form, the
// error slots of the person editor and the GEDCOM importer). This keeps them in step.
import { describe, it, expect } from 'vitest';
import { FACT_KEYS as SERVER_KEYS } from '../api/commands/validate.js';
import { FACT_LABELS } from '../api/commands/summary.js';
import { FACT_KEYS as FORM_KEYS } from '../src/factsForm.js';
import { FACT_ERROR_SLOTS } from '../src/personEditor.js';
import { FACT_KEYS as IMPORT_KEYS } from '../scripts/neon/gedToRows.js';

const sorted = (keys) => [...keys].sort();

// Keys from the first, lossy import's parser. Rows keep them until edited, so the server accepts them and the
// form shows them (as Religion and Education rows); the importer's parser no longer produces them.
const LEGACY_KEYS = ['education', 'religion'];

describe('person.facts keys', () => {
  it('have no duplicates in any list', () => {
    for (const keys of [SERVER_KEYS, FORM_KEYS, IMPORT_KEYS]) expect(new Set(keys).size).toBe(keys.length);
  });

  it('are the same on the server and in the edit form', () => {
    expect(sorted(FORM_KEYS)).toEqual(sorted(SERVER_KEYS));
  });

  it('each have a summary label on the server', () => {
    expect(sorted(Object.keys(FACT_LABELS))).toEqual(sorted(SERVER_KEYS));
  });

  it('each have an error slot in the person editor', () => {
    expect(sorted(Object.keys(FACT_ERROR_SLOTS))).toEqual(sorted(SERVER_KEYS));
  });

  it('are all written by the importer, apart from the legacy ones, and it writes no others', () => {
    expect(SERVER_KEYS).toEqual(expect.arrayContaining(IMPORT_KEYS));
    expect(sorted(SERVER_KEYS.filter(key => !IMPORT_KEYS.includes(key)))).toEqual(LEGACY_KEYS);
  });
});
