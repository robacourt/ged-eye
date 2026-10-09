// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ROOT } from '../scripts/neon/cli.js';
import * as current from '../scripts/gedParser.js';
import * as legacy from './fixtures/legacyGedParser.js';

// The real tree is gitignored, so worktrees lack it:
// GED_PATH=/Users/rob/src/ged_eye/acourt.ged npx vitest run tests/realGed.test.js
const GED_PATH = process.env.GED_PATH || path.join(ROOT, 'acourt.ged');

describe.skipIf(!fs.existsSync(GED_PATH))('real GEDCOM file', () => {
  let text;
  let parsed;
  let legacyParsed;

  beforeAll(() => {
    text = fs.readFileSync(GED_PATH, 'utf-8');
    parsed = current.parseGedcom(text);
    legacyParsed = legacy.parseGedcom(text);
  });

  it('parses every person and family', () => {
    expect(parsed.individuals.size).toBe(2994);
    expect(parsed.families.size).toBe(1029);
    expect(legacyParsed.individuals.size).toBe(2994);
  });
});
