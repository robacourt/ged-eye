// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ROOT } from '../scripts/neon/cli.js';
import * as current from '../scripts/gedParser.js';
import * as legacy from './fixtures/legacyGedParser.js';
import { parseGedcomTree } from '../scripts/gedTree.js';

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

  it('folds every CONT and CONC line into its parent', () => {
    const stray = [];
    const walk = (node) => {
      if (node.tag === 'CONT' || node.tag === 'CONC') stray.push(node);
      node.children.forEach(walk);
    };
    const roots = parseGedcomTree(text);
    roots.forEach(root => root.children.forEach(walk));
    expect(stray).toEqual([]);
    const i1Note = roots.find(r => r.xref === 'I1').children.find(c => c.tag === 'NOTE').value;
    expect(i1Note.startsWith(' Message Boards  Login\n')).toBe(true);
    expect(i1Note).toContain('Copyright © 1998-2001 MyFamily.com');
  });
});
