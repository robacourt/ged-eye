# Full GEDCOM Facts Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the GEDCOM parser so it keeps full notes, census transcriptions, fact notes and every other level-1 fact, backfill production's `person.facts` from `gedcom_archive`, and show the new data safely in the details panel.

**Architecture:**
- `scripts/gedTree.js` turns GEDCOM lines into a node tree, with CONT/CONC folded into values.
- `scripts/gedParser.js` derives today's `data` shape from that tree, with exact parity with the old parser, proven against a frozen copy. `extractPersonData` adds facts from `scripts/gedFacts.js`.
- `scripts/neon/backfillFacts.js` plans and compare-and-swaps the new `facts` into Postgres.
- `api/privacy.js` masks email addresses in note text before the Function responds.
- `src/personDetails.js` escapes everything and renders notes with `<details>` and "Show more".

**Tech Stack:** Node 24 ESM, `pg`, Postgres 18 (Neon), Neon Functions, Vite + vanilla JS, Vitest 3 (jsdom by default).

**Spec:** `specs/2026-10-09-gedcom-full-facts-design.md`. Read it first; it is the source of truth for every rule below.

**Conventions for every task:**
- **Style.** ESM, 2-space indent, semicolons, single quotes, terse JSDoc where the surrounding code has it.
- **Test environment.** Node-side test files start with `// @vitest-environment node`. Front-end tests use the default `jsdom`.
- **Running tests.**
  - Run them with `npx vitest run <path>`; `npm test` is watch mode.
  - The real-file tests need `GED_PATH=/Users/rob/src/ged_eye/acourt.ged`, because this worktree has no `acourt.ged`.
  - The DB tests need: `node --env-file=/Users/rob/src/ged_eye/.env.local --env-file=/Users/rob/src/ged_eye/.env.test.local node_modules/vitest/vitest.mjs run tests/db --no-file-parallelism`
- **Working directory.** The repo root is the worktree `/Users/rob/src/ged_eye/.claude/worktrees/great-proskuriakova-4710ff`. Run every command from there.
- **Never commit** `.env*.local`, `.neon`, `.neon-import/`, `ignore/` or `.claude/`.
- **Commit messages** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Never** run `import-ged --replace`. Never write to production before Task 16 and the developer's OK.

## File map

| File | Responsibility |
|---|---|
| `scripts/gedTree.js` (new) | `parseGedcomTree`, `lastChild`, `text`: GEDCOM lines → node tree |
| `scripts/gedFacts.js` (new) | `individualFacts(indiNode)`: the `person.facts` fields for one INDI node |
| `scripts/gedParser.js` (rewrite) | `parseGedcom` (records with `data` + `node`), `extractPersonData`; re-exports `parseGedcomTree` |
| `tests/fixtures/legacyGedParser.js` (new) | Frozen copy of the old parser, for parity tests only |
| `scripts/neon/gedToRows.js` | Adds `FACT_KEYS`, `personFacts(p)` and an injectable `extract` parameter |
| `scripts/neon/backfillFacts.js` (new) | `planFacts`, `formatSummary`, `describeRow`, `checkConfirm`, `loadArchive`, `readDbRows`, `applyPlan`, `verifyPlan`, `StalePlanError`, and the CLI |
| `api/privacy.js` (new) | `maskNoteEmails(view)` |
| `api/handler.js` | Masks 200 `/person/:id` bodies |
| `scripts/neon/verifyCompare.js` | Smaller `SCALAR_KEYS`; `apiMatchesView(body, view)` |
| `scripts/neon/verify.js` | Uses `apiMatchesView` |
| `src/html.js` (new) | `escapeHtml` (moved from `src/main.js`) |
| `src/factLabels.js` (new) | `factLabel(fact)` |
| `src/personDetails.js` | Escaped rendering, notes, new sections |
| `src/style.css` | Note, disclosure and clamp styles |
| `tests/db/testDatabase.js` (new) | Production-host guard and `resetTestDatabase()` shared by DB tests |
| `package.json` | `backfill-facts` script; `test:db` gets `--no-file-parallelism` |

---

## Chunk 1: Parser

### Task 1: Frozen legacy parser and the real-file test harness

**Files:**
- Create: `tests/fixtures/legacyGedParser.js`
- Rewrite: `tests/realGed.test.js`

- [ ] **Step 1: Freeze the current parser**

```bash
mkdir -p tests/fixtures
{ printf '%s\n' \
  '// Frozen copy of scripts/gedParser.js as of e9c07c1 (2026-10-09), before the two-stage rewrite.' \
  '// Used only by tests/realGed.test.js to prove the new parser derives the same non-facts output.' \
  '// Do not edit.' ''; cat scripts/gedParser.js; } > tests/fixtures/legacyGedParser.js
```

- [ ] **Step 2: Replace `tests/realGed.test.js`**

The current file throws when `acourt.ged` is missing and only logs. Replace it with:

```js
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
```

- [ ] **Step 3: Run it both ways**

Run: `GED_PATH=/Users/rob/src/ged_eye/acourt.ged npx vitest run tests/realGed.test.js`
Expected: 1 passed.

Run: `npx vitest run tests/realGed.test.js`
Expected: 1 skipped. No failure.

- [ ] **Step 4: Commit**

```bash
git add tests/fixtures/legacyGedParser.js tests/realGed.test.js
git commit -m "Freeze the legacy GEDCOM parser for parity tests; skip real-file tests without acourt.ged

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: Stage 1, `parseGedcomTree`

**Files:**
- Create: `scripts/gedTree.js`
- Test: `tests/gedTree.test.js` (new), `tests/realGed.test.js`

- [ ] **Step 1: Write the failing tests** in `tests/gedTree.test.js`

```js
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
```

- [ ] **Step 2: Run it to check that it fails**

Run: `npx vitest run tests/gedTree.test.js`
Expected: FAIL, because `scripts/gedTree.js` is not found.

- [ ] **Step 3: Implement `scripts/gedTree.js`**

```js
/**
 * Stage 1 of the GEDCOM parser: lines → node tree.
 * CONT and CONC lines are folded into their parent's value (CONT adds a newline, CONC joins
 * directly) and never appear as nodes. Values are kept verbatim apart from the line ending.
 */

const LINE = /^\s*(\d+) (?:(@[^@]+@) )?(\S+)(?: (.*))?$/;

/**
 * @returns {{level: number, xref: string|null, tag: string, value: string, children: object[]}[]}
 *   the level-0 nodes, in file order
 */
export function parseGedcomTree(gedcomText) {
  const roots = [];
  const open = [];
  for (const raw of gedcomText.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (!line.trim()) continue;
    const match = LINE.exec(line);
    if (!match) continue;
    const level = Number(match[1]);
    const tag = match[3];
    const value = match[4] ?? '';
    while (open.length && open[open.length - 1].level >= level) open.pop();
    const parent = open[open.length - 1];
    if (level > 0 && !parent) continue;
    if (parent && (tag === 'CONT' || tag === 'CONC')) {
      parent.value += (tag === 'CONT' ? '\n' : '') + value;
      continue;
    }
    const node = { level, xref: match[2] ? match[2].replace(/@/g, '') : null, tag, value, children: [] };
    if (parent) parent.children.push(node);
    else roots.push(node);
    open.push(node);
  }
  return roots;
}

/** The last direct child with this tag, or undefined. */
export const lastChild = (node, tag) => node.children.findLast(child => child.tag === tag);

/** A node's value with surrounding whitespace removed: names, dates, places, pointers. */
export const text = (node) => node.value.trim();
```

- [ ] **Step 4: Run it to check that it passes**

Run: `npx vitest run tests/gedTree.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Add real-file checks** to `tests/realGed.test.js`

Add `import { parseGedcomTree } from '../scripts/gedTree.js';`, then add inside the `describe`:

```js
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
```

Run: `GED_PATH=/Users/rob/src/ged_eye/acourt.ged npx vitest run tests/realGed.test.js`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add scripts/gedTree.js tests/gedTree.test.js tests/realGed.test.js
git commit -m "Add GEDCOM stage-1 tree parser with CONT/CONC folding

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3: `individualFacts` (`scripts/gedFacts.js`)

**Files:**
- Create: `scripts/gedFacts.js`
- Test: `tests/gedFacts.test.js` (new)

- [ ] **Step 1: Write the failing tests** in `tests/gedFacts.test.js`

```js
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
```

- [ ] **Step 2: Run it to check that it fails**

Run: `npx vitest run tests/gedFacts.test.js`
Expected: FAIL, because the module is not found.

- [ ] **Step 3: Implement `scripts/gedFacts.js`**

```js
/**
 * The person.facts fields for one INDI node (see specs/2026-10-09-gedcom-full-facts-design.md).
 */
import { lastChild, text } from './gedTree.js';

/** Level-1 INDI tags read elsewhere (columns, photos, relationships) or by the dedicated facts below. */
const HANDLED = new Set(['NAME', 'SEX', 'BIRT', 'BAPM', 'DEAT', 'BURI', 'CENS', 'RESI', 'OCCU', 'NOTE', 'OBJE', 'FAMS', 'FAMC', 'EMAIL', 'PHON']);
/** Level-1 INDI tags deliberately not surfaced: change stamps, sources (a later phase), BK reference numbers, associations. */
const IGNORED = new Set(['CHAN', 'SOUR', 'REFN', 'ASSO']);
const LIFE_EVENT_NOTES = new Map([['BIRT', 'birthNotes'], ['BAPM', 'baptismNotes'], ['DEAT', 'deathNotes'], ['BURI', 'burialNotes']]);

/** A node's own notes (not those on its source citations), verbatim apart from trailing whitespace. */
function noteTexts(node) {
  return node.children.filter(child => child.tag === 'NOTE').map(note => note.value.trimEnd()).filter(Boolean);
}

/** {value?, date?, place?, notes?} for one fact node; each key only when non-empty. */
function factOf(node) {
  const fact = {};
  const value = text(node);
  const date = lastChild(node, 'DATE');
  const place = lastChild(node, 'PLAC');
  const notes = noteTexts(node);
  if (value) fact.value = value;
  if (date && text(date)) fact.date = text(date);
  if (place && text(place)) fact.place = text(place);
  if (notes.length) fact.notes = notes;
  return fact;
}

function otherFact(node) {
  const entry = { tag: node.tag };
  const type = lastChild(node, 'TYPE');
  const cause = lastChild(node, 'CAUS');
  if (type && text(type)) entry.type = text(type);
  if (cause && text(cause)) entry.cause = text(cause);
  return Object.assign(entry, factOf(node));
}

/**
 * Keys appear only when non-empty: notes, occupations, censusRecords, residences, birthNotes,
 * baptismNotes, deathNotes, burialNotes, causeOfDeath, otherFacts.
 */
export function individualFacts(indi) {
  const occupations = [];
  const censusRecords = [];
  const residences = [];
  const otherFacts = [];
  const lastLifeEvent = new Map();
  for (const child of indi.children) {
    if (LIFE_EVENT_NOTES.has(child.tag)) lastLifeEvent.set(child.tag, child);
  }

  for (const child of indi.children) {
    const { tag } = child;
    if (tag === 'OCCU') {
      const fact = factOf(child);
      if (Object.keys(fact).length) occupations.push(fact);
    } else if (tag === 'CENS' || tag === 'RESI') {
      const fact = factOf(child);
      if (fact.date || fact.place || fact.notes) (tag === 'CENS' ? censusRecords : residences).push(fact);
    } else if (LIFE_EVENT_NOTES.has(tag)) {
      // The last occurrence fills the columns; earlier ones would otherwise be lost.
      if (child !== lastLifeEvent.get(tag)) otherFacts.push(otherFact(child));
    } else if (!HANDLED.has(tag) && !IGNORED.has(tag)) {
      otherFacts.push(otherFact(child));
    }
  }

  const facts = {};
  const notes = noteTexts(indi);
  if (notes.length) facts.notes = notes;
  if (occupations.length) facts.occupations = occupations;
  if (censusRecords.length) facts.censusRecords = censusRecords;
  if (residences.length) facts.residences = residences;
  for (const [tag, key] of LIFE_EVENT_NOTES) {
    const event = lastLifeEvent.get(tag);
    const eventNotes = event ? noteTexts(event) : [];
    if (eventNotes.length) facts[key] = eventNotes;
  }
  const death = lastLifeEvent.get('DEAT');
  const cause = death && lastChild(death, 'CAUS');
  if (cause && text(cause)) facts.causeOfDeath = text(cause);
  if (otherFacts.length) facts.otherFacts = otherFacts;
  return facts;
}
```

- [ ] **Step 4: Run it to check that it passes**

Run: `npx vitest run tests/gedFacts.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/gedFacts.js tests/gedFacts.test.js
git commit -m "Derive person facts (notes, occupations, census, other facts) from the GEDCOM tree

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4: Stage 2, rewrite `parseGedcom` and switch `extractPersonData` to the tree

**Files:**
- Modify: `scripts/gedParser.js` (everything above `extractPersonData`, plus the optional-fields block inside it)
- Modify: `tests/gedToRows.test.js:91` (the occupations shape)
- Test: `tests/gedParser.test.js`, `tests/realGed.test.js`

- [ ] **Step 1: Write the failing parser tests.** Append to `tests/gedParser.test.js`, inside a new `describe('GEDCOM parser stage 2', ...)`:

```js
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
```

- [ ] **Step 2: Run it to check that it fails**

Run: `npx vitest run tests/gedParser.test.js`
Expected: 4 failed, 5 passed.
- The 3 original tests pass.
- The photo-rule and last-occurrence tests also pass, because they pin legacy behaviour and so pass both before and after.
- The SOUR/REPO, untracked-tag, `node` and multi-line-notes tests fail.

- [ ] **Step 3: Replace the top of `scripts/gedParser.js`** (from the file header through the end of `parseGedcom`) with:

```js
/**
 * GEDCOM parser, stage 2: INDI and FAM records with the `data` the import reads, plus each
 * record's node tree (stage 1, scripts/gedTree.js) for the facts.
 */
import { parseGedcomTree, lastChild, text } from './gedTree.js';
import { individualFacts } from './gedFacts.js';

export { parseGedcomTree };

const pointer = (node) => text(node).replace(/@/g, '');

// Level-1 tags whose subtree the legacy parser kept to itself, so an OBJE inside never became a photo.
const NO_PHOTO_TAGS = new Set(['BIRT', 'BAPM', 'DEAT', 'BURI', 'CENS', 'RESI', 'MARR', 'DIV']);

function eventData(node) {
  const out = {};
  const date = lastChild(node, 'DATE');
  const place = lastChild(node, 'PLAC');
  if (date) out.DATE = text(date);
  if (place) out.PLAC = text(place);
  return out;
}

function firstDescendant(node, tag) {
  for (const child of node.children) {
    if (child.tag === tag) return child;
    const found = firstDescendant(child, tag);
    if (found) return found;
  }
  return null;
}

/**
 * The OBJE nodes the legacy parser treated as photos: each level-1 OBJE, plus the first OBJE
 * anywhere under any other level-1 node it opened no frame for (in practice an OBJE on a source
 * citation of an EVEN, OCCU or _MILT). That OBJE stayed open on the legacy stack until the next
 * level-1 line, so later OBJEs in the same subtree nested inside it and were not photos.
 */
function photoNodes(indi) {
  const out = [];
  for (const child of indi.children) {
    if (child.tag === 'OBJE') {
      out.push(child);
    } else if (!NO_PHOTO_TAGS.has(child.tag)) {
      const obje = firstDescendant(child, 'OBJE');
      if (obje) out.push(obje);
    }
  }
  return out;
}

function individualData(node) {
  const data = {};
  for (const child of node.children) {
    switch (child.tag) {
      case 'NAME': case 'SEX': case 'EMAIL': case 'PHON':
        data[child.tag] = text(child);
        break;
      case 'BIRT': case 'DEAT': case 'BAPM': case 'BURI':
        data[child.tag] = eventData(child);
        break;
      case 'FAMS': case 'FAMC':
        (data[child.tag] ??= []).push(pointer(child));
        break;
    }
  }
  const photos = photoNodes(node).map(obje => {
    const files = obje.children.filter(child => child.tag === 'FILE').map(text);
    return files.length ? { FILES: files } : {};
  });
  if (photos.length) data.OBJE = photos;
  return data;
}

function familyData(node) {
  const data = {};
  for (const child of node.children) {
    switch (child.tag) {
      case 'HUSB': case 'WIFE':
        data[child.tag] = pointer(child);
        break;
      case 'CHIL':
        (data.CHIL ??= []).push(pointer(child));
        break;
      case 'MARR': case 'DIV':
        data[child.tag] = eventData(child);
        break;
    }
  }
  return data;
}

export function parseGedcom(gedcomText) {
  const individuals = new Map();
  const families = new Map();
  for (const node of parseGedcomTree(gedcomText)) {
    if (node.tag === 'INDI') {
      individuals.set(node.xref, { id: node.xref, type: 'INDI', data: individualData(node), node });
    } else if (node.tag === 'FAM') {
      families.set(node.xref, { id: node.xref, type: 'FAM', data: familyData(node), node });
    }
  }
  return { individuals, families };
}
```

- [ ] **Step 4: Replace the optional-fields block of `extractPersonData`**, from `// Add optional fields if they exist` to just before `return result;`, with:

```js
  // Add optional fields if they exist
  if (data.BAPM?.DATE) result.baptismDate = data.BAPM.DATE;
  if (data.BAPM?.PLAC) result.baptismPlace = data.BAPM.PLAC;

  if (data.BURI?.DATE) result.burialDate = data.BURI.DATE;
  if (data.BURI?.PLAC) result.burialPlace = data.BURI.PLAC;

  if (data.EMAIL) result.email = data.EMAIL;
  if (data.PHON) result.phone = data.PHON;

  // Marriages
  if (marriages.length > 0) {
    result.marriages = marriages;
  }

  // Notes, occupations, census records, residences, life-event notes and other facts
  Object.assign(result, individualFacts(individual.node));
```

Leave the rest of `extractPersonData` and `convertPath` unchanged.

- [ ] **Step 5: Update the `gedToRows` expectation for the new occupations shape.** In `tests/gedToRows.test.js`, change `facts: { occupations: ['Farmer'] }` to `facts: { occupations: [{ value: 'Farmer' }] }`.

- [ ] **Step 6: Run the unit tests**

Run: `npx vitest run tests/gedParser.test.js tests/gedTree.test.js tests/gedFacts.test.js tests/gedToRows.test.js`
Expected: all pass.

- [ ] **Step 7: Add the real-file parity and spot checks.** In `tests/realGed.test.js`, add `import { isDeepStrictEqual } from 'util';` and these helpers above the `describe`:

```js
const LEGACY_FACT_KEYS = ['occupations', 'notes', 'email', 'phone', 'religion', 'education', 'censusRecords', 'residences'];
const NEW_FACT_KEYS = ['occupations', 'notes', 'email', 'phone', 'censusRecords', 'residences',
  'birthNotes', 'baptismNotes', 'deathNotes', 'burialNotes', 'causeOfDeath', 'otherFacts'];
const omit = (object, keys) => Object.fromEntries(Object.entries(object).filter(([key]) => !keys.includes(key)));
const pick = (object, keys) => Object.fromEntries(keys.filter(key => object[key] !== undefined).map(key => [key, object[key]]));
const eventOf = (event) => event && pick(event, ['DATE', 'PLAC']);
const familyLinks = (d) => ({ HUSB: d.HUSB, WIFE: d.WIFE, CHIL: d.CHIL, MARR: eventOf(d.MARR), DIV: eventOf(d.DIV) });
```

Then add these tests inside the `describe`:

```js
  it('derives every non-facts person field exactly as the legacy parser did', () => {
    const differing = [...legacyParsed.individuals.keys()].filter(id => !isDeepStrictEqual(
      omit(current.extractPersonData(parsed, id), NEW_FACT_KEYS),
      omit(legacy.extractPersonData(legacyParsed, id), LEGACY_FACT_KEYS)
    ));
    expect(differing).toEqual([]);
    // email and phone are facts in both; they must not change either.
    const contactDiffers = [...legacyParsed.individuals.keys()].filter(id => !isDeepStrictEqual(
      pick(current.extractPersonData(parsed, id), ['email', 'phone']),
      pick(legacy.extractPersonData(legacyParsed, id), ['email', 'phone'])
    ));
    expect(contactDiffers).toEqual([]);
  }, 30_000);

  it('reads the same family links and FAMS/FAMC lists as the legacy parser', () => {
    const familiesDiffering = [...legacyParsed.families.keys()].filter(id =>
      !isDeepStrictEqual(familyLinks(parsed.families.get(id).data), familyLinks(legacyParsed.families.get(id).data)));
    expect(familiesDiffering).toEqual([]);
    const listsDiffering = [...legacyParsed.individuals.keys()].filter(id => !isDeepStrictEqual(
      pick(parsed.individuals.get(id).data, ['FAMS', 'FAMC']), pick(legacyParsed.individuals.get(id).data, ['FAMS', 'FAMC'])));
    expect(listsDiffering).toEqual([]);
  });

  it('fixes the legacy bleed: notes stay with their facts and F1029 gets no source lines', () => {
    expect(Object.keys(parsed.families.get('F1029').data).sort()).toEqual(['CHIL', 'HUSB', 'MARR', 'WIFE']);
    const i23 = current.extractPersonData(parsed, 'I23');
    expect((i23.notes ?? []).some(note => note.includes('Parish of Marnhull'))).toBe(false);
    expect(i23.otherFacts.find(f => f.tag === '_MILT').notes[0]).toMatch(/^Parish of Marnhull/);
    const i1 = current.extractPersonData(parsed, 'I1');
    expect(i1.notes).toHaveLength(1);
    expect(i1.notes[0]).toContain('Copyright © 1998-2001 MyFamily.com');
    const i1423Photos = current.extractPersonData(parsed, 'I1423').photos;
    expect(i1423Photos).toContain('Data/Picture/Picture/Barnett 1.jpg');
    expect(i1423Photos).not.toContain('Data/Picture/Picture/Barnett 1A.jpg');
  });
```

- [ ] **Step 8: Run the real-file tests**

Run: `GED_PATH=/Users/rob/src/ged_eye/acourt.ged npx vitest run tests/realGed.test.js`
Expected: PASS (5 tests).
- If a parity test lists ids, the new `data` derivation disagrees with the legacy parser for those people or families.
- Diff one with `console.log` of both sides, fix `scripts/gedParser.js`, and never loosen the test.
- The photo rule in particular must reproduce I1423, which keeps `Barnett 1.jpg` but not `Barnett 1A.jpg`.

- [ ] **Step 9: Run the whole unit suite**

Run: `npx vitest run`
Expected: everything passes. `realGed` is skipped without `GED_PATH`, and `tests/db/personView.test.js` is skipped without `DATABASE_URL_TEST`.

- [ ] **Step 10: Commit**

```bash
git add scripts/gedParser.js tests/gedParser.test.js tests/gedToRows.test.js tests/realGed.test.js
git commit -m "Derive GEDCOM records from the node tree: fix CONT/CONC, record and sub-tag bleed

Person columns, photos and family links match the legacy parser exactly on the real file;
facts now come from scripts/gedFacts.js.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Chunk 2: Storage and backfill

### Task 5: `personFacts`, `FACT_KEYS` and an injectable extractor in `gedToRows`

**Files:**
- Modify: `scripts/neon/gedToRows.js:1-30`
- Test: `tests/gedToRows.test.js`, `tests/realGed.test.js`

- [ ] **Step 1: Write the failing test.** Append to the `describe('gedToRows', ...)` in `tests/gedToRows.test.js` (and add `personFacts` to its import):

```js
  it('personFacts keeps exactly the facts keys a person has', () => {
    expect(personFacts({ id: 'I1', name: 'A', notes: ['n'], otherFacts: [{ tag: '_MILT' }], causeOfDeath: 'Fever', religion: 'old key' }))
      .toEqual({ notes: ['n'], otherFacts: [{ tag: '_MILT' }], causeOfDeath: 'Fever' });
    expect(personFacts({ id: 'I2', name: 'B' })).toEqual({});
  });
```

Run: `npx vitest run tests/gedToRows.test.js`
Expected: FAIL, because `personFacts` is not exported.

- [ ] **Step 2: Implement.** In `scripts/neon/gedToRows.js`, replace the module-level `FACT_KEYS` constant with these two module-level declarations:

```js
/** The extractPersonData() keys stored in person.facts (spec: Facts model). */
export const FACT_KEYS = ['occupations', 'notes', 'email', 'phone', 'censusRecords', 'residences',
  'birthNotes', 'baptismNotes', 'deathNotes', 'burialNotes', 'causeOfDeath', 'otherFacts'];

/** person.facts for one extractPersonData() result: the facts keys it has, nothing else. */
export function personFacts(p) {
  const facts = {};
  for (const key of FACT_KEYS) {
    if (p[key] !== undefined) facts[key] = p[key];
  }
  return facts;
}
```

Change the signature to `export function gedToRows(parsedGed, manifest, avatarMap, extract = extractPersonData)`. Add `@param extract  person extractor; the parity test passes the legacy parser's` to its JSDoc. Inside, use `const p = extract(parsedGed, id);` and `const facts = personFacts(p);`, and delete the old inline loop.

- [ ] **Step 3: Run the tests**

Run: `npx vitest run tests/gedToRows.test.js`
Expected: PASS.

- [ ] **Step 4: Add row parity on the real file.** In `tests/realGed.test.js`, import `{ gedToRows }` from `'../scripts/neon/gedToRows.js'` and add this helper above the `describe`:

```js
// Every photo path the parsers produce, mapped to a unique fake object, so personMedia positions are compared too.
function syntheticManifest(parsedGeds) {
  const files = {};
  for (const [ged, extract] of parsedGeds) {
    for (const id of ged.individuals.keys()) {
      for (const photo of extract(ged, id).photos) {
        files[photo] = { sha256: `sha-${photo}`, objectKey: `originals/${photo}`, thumbKey: null,
          contentType: 'application/octet-stream', byteSize: 1, fileName: path.basename(photo) };
      }
    }
  }
  return { files, avatars: {} };
}
```

Then add this test inside the `describe`:

```js
  it('builds the same rows as the legacy parser, apart from facts', () => {
    const manifest = syntheticManifest([[parsed, current.extractPersonData], [legacyParsed, legacy.extractPersonData]]);
    const after = gedToRows(parsed, manifest, new Map());
    const before = gedToRows(legacyParsed, manifest, new Map(), legacy.extractPersonData);
    const withoutFacts = (rows) => rows.people.map(({ facts, ...row }) => row);
    expect(withoutFacts(after)).toEqual(withoutFacts(before));
    for (const key of ['families', 'familyChildren', 'media', 'personMedia', 'warnings']) {
      expect(after[key], key).toEqual(before[key]);
    }
    const photos = [...parsed.individuals.keys()].reduce((n, id) => n + current.extractPersonData(parsed, id).photos.length, 0);
    expect(photos).toBe(1262);
    // I417 and I2616 each list one path twice; gedToRows keeps the first and warns duplicate_media.
    expect(after.personMedia).toHaveLength(1260);
    expect(after.warnings.filter(w => w.type === 'duplicate_media').map(w => w.personId)).toEqual(['I417', 'I2616']);
  }, 30_000);
```

Run: `GED_PATH=/Users/rob/src/ged_eye/acourt.ged npx vitest run tests/realGed.test.js`
Expected: PASS (6 tests). The 1,262 photo paths are the spec's 1,249 level-1 plus 13 citation photos. If a count differs, find out why before changing anything.

- [ ] **Step 5: Commit**

```bash
git add scripts/neon/gedToRows.js tests/gedToRows.test.js tests/realGed.test.js
git commit -m "Export personFacts/FACT_KEYS from gedToRows; prove row parity on the real GEDCOM

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 6: `planFacts` and the pure backfill helpers

**Files:**
- Create: `scripts/neon/backfillFacts.js` (pure part only in this task)
- Test: `tests/backfillFacts.test.js` (new), `tests/realGed.test.js`

- [ ] **Step 1: Write the failing tests** in `tests/backfillFacts.test.js`

```js
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { planFacts, formatSummary, describeRow, checkConfirm, CORE_COLUMNS } from '../scripts/neon/backfillFacts.js';

const CORE = Object.fromEntries(CORE_COLUMNS.map(column => [column, null]));
const dbRow = (id, facts, extra = {}) => ({ id, facts, edited: false, ...CORE, given_name: 'A', ...extra });
const derivedRow = (id, facts, extra = {}) => ({ id, facts, ...CORE, given_name: 'A', avatar_key: null, ...extra });

describe('planFacts', () => {
  it('treats facts with the same content in a different key order as unchanged', () => {
    const { rows, summary } = planFacts(
      [dbRow('I1', { notes: ['n'], occupations: [{ value: 'Miller', date: '1881' }] })],
      [derivedRow('I1', { occupations: [{ date: '1881', value: 'Miller' }], notes: ['n'] })]
    );
    expect(rows).toEqual([]);
    expect(summary).toMatchObject({ unchanged: 1, changed: 0 });
  });

  it('plans changed people with before and after, and counts each key', () => {
    const { rows, summary } = planFacts(
      [dbRow('I1', { notes: ['short'], occupations: ['Miller'], religion: 'Protestant' }), dbRow('I2', {})],
      [derivedRow('I1', { notes: ['short\nand long'], occupations: [{ value: 'Miller' }], otherFacts: [{ tag: 'RELI', value: 'Protestant' }] }), derivedRow('I2', {})]
    );
    expect(rows).toEqual([{
      id: 'I1',
      before: { notes: ['short'], occupations: ['Miller'], religion: 'Protestant' },
      after: { notes: ['short\nand long'], occupations: [{ value: 'Miller' }], otherFacts: [{ tag: 'RELI', value: 'Protestant' }] }
    }]);
    expect(summary).toMatchObject({ unchanged: 1, changed: 1 });
    expect(summary.keys).toEqual({
      notes: { added: 0, removed: 0, changed: 1 },
      occupations: { added: 0, removed: 0, changed: 1 },
      otherFacts: { added: 1, removed: 0, changed: 0 },
      religion: { added: 0, removed: 1, changed: 0 }
    });
  });

  it('never plans an edited person whose facts would change', () => {
    const { rows, summary } = planFacts(
      [dbRow('I1', { notes: ['edited by hand'] }, { edited: true }), dbRow('I2', { notes: ['x'] }, { edited: true })],
      [derivedRow('I1', { notes: ['from the GEDCOM'] }), derivedRow('I2', { notes: ['x'] })]
    );
    expect(rows).toEqual([]);
    expect(summary).toMatchObject({ unchanged: 1, changed: 0, edited: ['I1'] });
  });

  it('lists people found on only one side, and never plans them', () => {
    const { rows, summary } = planFacts([dbRow('I1', {}), dbRow('I9', {})], [derivedRow('I1', {}), derivedRow('I5', { notes: ['n'] })]);
    expect(rows).toEqual([]);
    expect(summary).toMatchObject({ onlyInDb: ['I9'], onlyInGed: ['I5'] });
  });

  it('reports core-column drift without writing it, ignoring avatar_key', () => {
    const { rows, summary } = planFacts(
      [dbRow('I1', {}, { birth_date: '1900', avatar_key: 'avatars/x.jpg' })],
      [derivedRow('I1', {}, { birth_date: 'ABT 1900' })]
    );
    expect(rows).toEqual([]);
    expect(summary.columnDrift).toEqual([{ id: 'I1', column: 'birth_date', db: '1900', derived: 'ABT 1900' }]);
  });
});

describe('backfill reporting and guards', () => {
  it('formats a summary', () => {
    const { summary } = planFacts([dbRow('I1', { notes: ['a'] })], [derivedRow('I1', { notes: ['b'] })]);
    expect(formatSummary(summary)).toEqual([
      'unchanged 0, changed 1, edited 0, only in database 0, only in GEDCOM 0, column drift 0',
      '  notes: added 0, removed 0, changed 1'
    ]);
  });

  it('describes one planned row key by key, truncating long values', () => {
    expect(describeRow({ id: 'I1', before: { notes: ['a'], phone: '1' }, after: { notes: ['b'.repeat(200)], phone: '1' } }, 20)).toEqual([
      'I1:',
      '  notes before ["a"]',
      `  notes after  ${JSON.stringify(['b'.repeat(200)]).slice(0, 19)}…`
    ]);
  });

  it('refuses to write unless --confirm and the plan both name this host', () => {
    expect(() => checkConfirm({ host: 'h', planHost: 'h', confirm: 'h', direction: 'apply' })).not.toThrow();
    expect(() => checkConfirm({ host: 'h', planHost: 'h', confirm: undefined, direction: 'apply' })).toThrow('pass --confirm h');
    expect(() => checkConfirm({ host: 'h', planHost: 'other', confirm: 'h', direction: 'rollback' })).toThrow('made against other');
  });
});
```

- [ ] **Step 2: Run it to check that it fails**

Run: `npx vitest run tests/backfillFacts.test.js`
Expected: FAIL, because the module is not found.

- [ ] **Step 3: Implement the pure part of `scripts/neon/backfillFacts.js`**

```js
/**
 * One-off backfill of person.facts from gedcom_archive with the full GEDCOM parser.
 * See specs/2026-10-09-gedcom-full-facts-design.md (Backfill).
 *
 *   npm run backfill-facts                                     # plan (read-only) → .neon-import/facts-backfill-plan-<host>.json
 *   npm run backfill-facts -- --apply <plan> --confirm <host>  # compare-and-swap the plan in
 *   npm run backfill-facts -- --rollback <plan> --confirm <host>
 * Options: --database-url <url> (default DATABASE_URL_UNPOOLED), --sha <sha256>, --out <path>.
 */
import { canonical } from './verifyCompare.js';

export const CORE_COLUMNS = ['given_name', 'surname', 'display_name', 'sex', 'birth_date', 'birth_place',
  'death_date', 'death_place', 'baptism_date', 'baptism_place', 'burial_date', 'burial_place'];

function countKeys(keys, before, after) {
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const kind = !(key in before) ? 'added' : !(key in after) ? 'removed'
      : canonical(before[key]) !== canonical(after[key]) ? 'changed' : null;
    if (!kind) continue;
    keys[key] ??= { added: 0, removed: 0, changed: 0 };
    keys[key][kind]++;
  }
}

/**
 * @param dbRows  [{ id, facts, edited, ...CORE_COLUMNS }] from readDbRows()
 * @param derived people rows from gedToRows() on the archive
 * @returns {{ rows: {id, before, after}[], summary }}
 */
export function planFacts(dbRows, derived) {
  const ged = new Map(derived.map(row => [row.id, row]));
  const ids = new Set(dbRows.map(row => row.id));
  const rows = [];
  const summary = { unchanged: 0, changed: 0, edited: [], onlyInDb: [], onlyInGed: [], keys: {}, columnDrift: [] };
  for (const current of dbRows) {
    const next = ged.get(current.id);
    if (!next) {
      summary.onlyInDb.push(current.id);
      continue;
    }
    for (const column of CORE_COLUMNS) {
      const db = current[column] ?? null;
      const fromGed = next[column] ?? null;
      if (db !== fromGed) summary.columnDrift.push({ id: current.id, column, db, derived: fromGed });
    }
    if (canonical(current.facts) === canonical(next.facts)) {
      summary.unchanged++;
    } else if (current.edited) {
      summary.edited.push(current.id);
    } else {
      summary.changed++;
      rows.push({ id: current.id, before: current.facts, after: next.facts });
      countKeys(summary.keys, current.facts, next.facts);
    }
  }
  for (const id of ged.keys()) if (!ids.has(id)) summary.onlyInGed.push(id);
  summary.keys = Object.fromEntries(Object.entries(summary.keys).sort(([a], [b]) => a.localeCompare(b)));
  return { rows, summary };
}

const listIds = (ids) => `${ids.slice(0, 20).join(' ')}${ids.length > 20 ? ` … (${ids.length})` : ''}`;

export function formatSummary(summary) {
  const lines = [`unchanged ${summary.unchanged}, changed ${summary.changed}, edited ${summary.edited.length}, ` +
    `only in database ${summary.onlyInDb.length}, only in GEDCOM ${summary.onlyInGed.length}, column drift ${summary.columnDrift.length}`];
  for (const [key, c] of Object.entries(summary.keys)) lines.push(`  ${key}: added ${c.added}, removed ${c.removed}, changed ${c.changed}`);
  if (summary.edited.length) lines.push(`edited since import (skipped): ${listIds(summary.edited)}`);
  if (summary.onlyInDb.length) lines.push(`only in database: ${listIds(summary.onlyInDb)}`);
  if (summary.onlyInGed.length) lines.push(`only in GEDCOM: ${listIds(summary.onlyInGed)}`);
  for (const d of summary.columnDrift.slice(0, 20)) {
    lines.push(`column drift ${d.id}.${d.column}: database ${JSON.stringify(d.db)}, GEDCOM ${JSON.stringify(d.derived)}`);
  }
  return lines;
}

/** Human-readable before/after for the keys that change in one planned row. */
export function describeRow(row, width = 160) {
  const show = (value) => {
    const s = value === undefined ? '(absent)' : JSON.stringify(value);
    return s.length > width ? `${s.slice(0, width - 1)}…` : s;
  };
  const keys = [...new Set([...Object.keys(row.before), ...Object.keys(row.after)])]
    .filter(key => canonical(row.before[key]) !== canonical(row.after[key])).sort();
  return [`${row.id}:`, ...keys.flatMap(key => [`  ${key} before ${show(row.before[key])}`, `  ${key} after  ${show(row.after[key])}`])];
}

/** Throws unless the plan was made against `host` and --confirm names it too. */
export function checkConfirm({ host, planHost, confirm, direction }) {
  if (planHost !== host) throw new Error(`The plan was made against ${planHost}, but this connection is ${host}`);
  if (confirm !== host) throw new Error(`Refusing to ${direction} on ${host}: pass --confirm ${host}`);
}
```

`describeRow` truncates a value to `width - 1` characters plus `…`, so a shown value is at most `width` characters.

- [ ] **Step 4: Run it to check that it passes**

Run: `npx vitest run tests/backfillFacts.test.js`
Expected: PASS (8 tests).

- [ ] **Step 5: Add the offline production plan to the real-file test.** In `tests/realGed.test.js`, import `{ planFacts }` from `'../scripts/neon/backfillFacts.js'` and add:

```js
  it('plans the production backfill exactly (production facts equal the legacy parser output)', () => {
    const empty = { files: {}, avatars: {} };
    const production = gedToRows(legacyParsed, empty, new Map(), legacy.extractPersonData).people.map(row => ({
      ...row, edited: false, facts: pick(legacy.extractPersonData(legacyParsed, row.id), LEGACY_FACT_KEYS)
    }));
    const { rows, summary } = planFacts(production, gedToRows(parsed, empty, new Map()).people);
    expect(summary).toMatchObject({ unchanged: 1602, changed: 1392, edited: [], onlyInDb: [], onlyInGed: [], columnDrift: [] });
    expect(rows).toHaveLength(1392);
  }, 30_000);
```

Run: `GED_PATH=/Users/rob/src/ged_eye/acourt.ged npx vitest run tests/realGed.test.js`
Expected: PASS (7 tests).
- 1,392 and 1,602 come from the spec review's independent simulation. If they differ, find out why from `summary.keys` and a few `describeRow` outputs before touching the constants.
- If the difference is justified, update the constants **and** the spec's Rollout section in the same commit.

- [ ] **Step 6: Commit**

```bash
git add scripts/neon/backfillFacts.js tests/backfillFacts.test.js tests/realGed.test.js
git commit -m "Add planFacts and backfill reporting; assert the offline production plan

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 7: Database helpers (`loadArchive`, `readDbRows`, `applyPlan`, `verifyPlan`)

**Files:**
- Modify: `scripts/neon/backfillFacts.js`
- Create: `tests/db/testDatabase.js`, `tests/db/backfillFacts.test.js`
- Modify: `tests/db/personView.test.js:1-17` and its `beforeAll`, `package.json` (`test:db`)

- [ ] **Step 1: Extract the shared DB test guard.** Create `tests/db/testDatabase.js`, moving the guard verbatim from `tests/db/personView.test.js`:

```js
/**
 * Shared setup for tests that need a real database: the dedicated Neon `test` branch in
 * DATABASE_URL_TEST, never production. Run via npm run test:db.
 */
import pg from 'pg';
import { migrate } from '../../scripts/neon/migrate.js';

export const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST;

const host = (u) => new URL(u).hostname.replace('-pooler', '');
const productionHosts = [process.env.DATABASE_URL, process.env.DATABASE_URL_UNPOOLED].filter(Boolean).map(host);
if (TEST_DATABASE_URL && productionHosts.length === 0) {
  throw new Error('DATABASE_URL_TEST is set but DATABASE_URL and DATABASE_URL_UNPOOLED are not, so it cannot be checked against production; run via npm run test:db');
}
if (TEST_DATABASE_URL && productionHosts.includes(host(TEST_DATABASE_URL))) {
  throw new Error('DATABASE_URL_TEST points at the production branch; refusing to reset it');
}

/** Connects to the test branch and gives it a freshly migrated, empty public schema. */
export async function resetTestDatabase() {
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  await client.query('drop schema public cascade; create schema public;');
  await migrate(TEST_DATABASE_URL, { log: () => {} });
  return client;
}
```

In `tests/db/personView.test.js`:
- Delete the `host`/`productionHosts` lines and the two `if (url && …) throw` blocks.
- Replace `const url = process.env.DATABASE_URL_TEST;` with `import { TEST_DATABASE_URL as url, resetTestDatabase } from './testDatabase.js';`, placed with the other imports.
- In `beforeAll`, replace the four lines from `client = new pg.Client(...)` through `await migrate(url, ...)` with `client = await resetTestDatabase();`. Keep `await client.query(FIXTURE);`.
- Remove the `pg` import, whose only use was the replaced `new pg.Client` line. Keep every other import (`crypto`, `fs`, `path`, `ROOT`, `migrate`, `migrationChecksum`), because the migration tests use them.

In `package.json`, append ` --no-file-parallelism` to the `test:db` script, because both DB test files reset the same schema:

```json
"test:db": "node --env-file=.env.local --env-file=.env.test.local node_modules/vitest/vitest.mjs run tests/db --no-file-parallelism"
```

Run the DB suite to confirm the refactor:
`node --env-file=/Users/rob/src/ged_eye/.env.local --env-file=/Users/rob/src/ged_eye/.env.test.local node_modules/vitest/vitest.mjs run tests/db --no-file-parallelism`
Expected: personView tests all pass, as before.

- [ ] **Step 2: Write the failing DB tests** in `tests/db/backfillFacts.test.js`

```js
// @vitest-environment node
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import crypto from 'crypto';
import { TEST_DATABASE_URL as url, resetTestDatabase } from './testDatabase.js';
import { applyPlan, verifyPlan, readDbRows, loadArchive, StalePlanError } from '../../scripts/neon/backfillFacts.js';

const PEOPLE = `
insert into person (id, given_name, surname, display_name, sex, birth_date, facts) values
  ('I1', 'Adam', 'Smith', 'Adam Smith', 'M', '1900', '{"notes": ["old 1"]}'),
  ('I2', 'Beth', 'Jones', 'Beth Jones', 'F', null, '{"occupations": ["Miller"]}'),
  ('I3', 'Carl', 'Smith', 'Carl Smith', 'M', null, '{}');
`;
const PLAN = {
  host: 'test',
  rows: [
    { id: 'I1', before: { notes: ['old 1'] }, after: { notes: ['new 1\nline 2'] } },
    { id: 'I2', before: { occupations: ['Miller'] }, after: { occupations: [{ value: 'Miller', date: '1881' }] } },
    { id: 'I3', before: {}, after: { otherFacts: [{ tag: '_MILT' }] } }
  ]
};

describe.skipIf(!url)('backfillFacts (database)', () => {
  let client;
  const snapshot = async () => (await client.query('select * from person order by id')).rows;
  const factsOf = async () => Object.fromEntries((await client.query('select id, facts from person order by id')).rows.map(r => [r.id, r.facts]));

  beforeAll(async () => {
    client = await resetTestDatabase();
  }, 60000);

  beforeEach(async () => {
    await client.query('truncate person cascade; truncate gedcom_archive;');
    await client.query(PEOPLE);
  });

  afterAll(async () => {
    await client?.end();
  });

  it('applies the plan, touching nothing but facts', async () => {
    const before = await snapshot();
    expect(await applyPlan(client, PLAN)).toEqual({ updated: 3 });
    const after = await snapshot();
    expect(after.map(r => r.facts)).toEqual(PLAN.rows.map(r => r.after));
    expect(after.map(({ facts, ...rest }) => rest)).toEqual(before.map(({ facts, ...rest }) => rest));
    expect(await verifyPlan(client, PLAN)).toEqual([]);
  });

  it('refuses a row edited since the import even when its facts still match', async () => {
    await client.query(`update person set updated_at = updated_at + interval '1 second' where id = 'I2'`);
    const error = await applyPlan(client, PLAN).catch(e => e);
    expect(error).toBeInstanceOf(StalePlanError);
    expect(error.ids).toEqual(['I2']);
    expect(await factsOf()).toEqual({ I1: { notes: ['old 1'] }, I2: { occupations: ['Miller'] }, I3: {} });
  });

  it('rolls the whole apply back when a later batch is stale', async () => {
    await client.query(`update person set facts = '{"notes": ["edited"]}' where id = 'I3'`);
    const error = await applyPlan(client, PLAN, { batchSize: 1 }).catch(e => e);
    expect(error).toBeInstanceOf(StalePlanError);
    expect(error.ids).toEqual(['I3']);
    expect(await factsOf()).toEqual({ I1: { notes: ['old 1'] }, I2: { occupations: ['Miller'] }, I3: { notes: ['edited'] } });
  });

  it('rolls back to before, and verifyPlan checks the requested side', async () => {
    await applyPlan(client, PLAN);
    expect(await verifyPlan(client, PLAN, { direction: 'rollback' })).toEqual(['I1', 'I2', 'I3']);
    expect(await applyPlan(client, PLAN, { direction: 'rollback' })).toEqual({ updated: 3 });
    expect(await factsOf()).toEqual({ I1: { notes: ['old 1'] }, I2: { occupations: ['Miller'] }, I3: {} });
    expect(await verifyPlan(client, PLAN, { direction: 'rollback' })).toEqual([]);
    expect(await verifyPlan(client, PLAN)).toEqual(['I1', 'I2', 'I3']);
  });

  it('flags only rows whose updated_at moved as edited', async () => {
    await client.query(`update person set updated_at = updated_at + interval '1 second' where id = 'I2'`);
    const rows = await readDbRows(client);
    expect(rows.map(r => [r.id, r.edited])).toEqual([['I1', false], ['I2', true], ['I3', false]]);
    expect(rows[0]).toMatchObject({ given_name: 'Adam', birth_date: '1900', facts: { notes: ['old 1'] } });
  });

  it('loads the single archive row and checks its hash', async () => {
    const content = Buffer.from('0 HEAD\n0 TRLR\n');
    const sha = crypto.createHash('sha256').update(content).digest('hex');
    try {
      await expect(loadArchive(client)).rejects.toThrow('found 0');
      await client.query('insert into gedcom_archive (file_name, sha256, content) values ($1, $2, $3)', ['t.ged', sha, content]);
      expect((await loadArchive(client)).content.equals(content)).toBe(true);
      expect((await loadArchive(client, sha)).sha256).toBe(sha);
      await client.query('insert into gedcom_archive (file_name, sha256, content) values ($1, $2, $3)', ['u.ged', 'f'.repeat(64), content]);
      await expect(loadArchive(client)).rejects.toThrow('pass --sha');
      await expect(loadArchive(client, 'f'.repeat(64))).rejects.toThrow('hashes to');
    } finally {
      // Leave the test branch with no archive, so the Task 8 smoke test sees "found 0".
      await client.query('truncate gedcom_archive');
    }
  });
});
```

Run the DB suite (command above).
Expected: the new file FAILS, because the exports don't exist yet; personView still passes.

- [ ] **Step 3: Implement the DB helpers.** Append to `scripts/neon/backfillFacts.js` (and add `import crypto from 'crypto';` at the top):

```js
// Compare-and-swap: only rows whose facts still equal the side being replaced, and that nobody has
// edited since the import (the backfill itself never touches updated_at).
const UPDATE_SQL = `
  update person p set facts = r.replacement
  from jsonb_to_recordset($1::jsonb) as r (id text, expected jsonb, replacement jsonb)
  where p.id = r.id and p.facts = r.expected and p.updated_at = p.created_at
  returning p.id`;

export class StalePlanError extends Error {
  constructor(ids) {
    super(`${ids.length} people changed or were edited since the plan (${ids.join(', ')}); nothing was written`);
    this.name = 'StalePlanError';
    this.ids = ids;
  }
}

const sides = (direction) => {
  if (direction === 'apply') return { from: 'before', to: 'after' };
  if (direction === 'rollback') return { from: 'after', to: 'before' };
  throw new Error(`direction must be apply or rollback, not ${direction}`);
};

/** The gedcom_archive row (the only one, or the one with `sha`), with its content hash checked. */
export async function loadArchive(client, sha) {
  const { rows } = sha
    ? await client.query('select sha256, content from gedcom_archive where sha256 = $1', [sha])
    : await client.query('select sha256, content from gedcom_archive');
  if (rows.length !== 1) {
    throw new Error(sha ? `No gedcom_archive row has sha256 ${sha}` : `Expected exactly one gedcom_archive row, found ${rows.length}; pass --sha <sha256>`);
  }
  const [{ sha256, content }] = rows;
  const actual = crypto.createHash('sha256').update(content).digest('hex');
  if (actual !== sha256) throw new Error(`gedcom_archive content hashes to ${actual}, but its row says ${sha256}`);
  return { sha256, content };
}

/** Every person's facts, edited flag (updated_at moved since the import) and CORE_COLUMNS. */
export async function readDbRows(client) {
  const { rows } = await client.query(
    `select id, facts, updated_at <> created_at as edited, ${CORE_COLUMNS.join(', ')} from person order by id`);
  return rows;
}

/**
 * Compare-and-swap the plan into person.facts in one transaction. Leaves updated_at alone: the
 * backfill re-derives the import, it is not an edit. Throws StalePlanError (and writes nothing)
 * if any row's facts no longer match the side being replaced, or the row was edited since the import.
 */
export async function applyPlan(client, plan, { direction = 'apply', batchSize = 500 } = {}) {
  const { from, to } = sides(direction);
  const pairs = plan.rows.map(row => ({ id: row.id, expected: row[from], replacement: row[to] }));
  await client.query('begin');
  try {
    let updated = 0;
    for (let i = 0; i < pairs.length; i += batchSize) {
      const batch = pairs.slice(i, i + batchSize);
      const { rows } = await client.query(UPDATE_SQL, [JSON.stringify(batch)]);
      if (rows.length !== batch.length) {
        const done = new Set(rows.map(row => row.id));
        throw new StalePlanError(batch.map(pair => pair.id).filter(id => !done.has(id)));
      }
      updated += rows.length;
    }
    await client.query('commit');
    return { updated };
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  }
}

/** Planned ids whose facts don't equal the side the given direction writes. */
export async function verifyPlan(client, plan, { direction = 'apply' } = {}) {
  const { to } = sides(direction);
  const ids = plan.rows.map(row => row.id);
  const { rows } = await client.query('select id, facts from person where id = any($1)', [ids]);
  const actual = new Map(rows.map(row => [row.id, row.facts]));
  return plan.rows.filter(row => !actual.has(row.id) || canonical(actual.get(row.id)) !== canonical(row[to])).map(row => row.id);
}
```

- [ ] **Step 4: Run the DB suite**

Run: `node --env-file=/Users/rob/src/ged_eye/.env.local --env-file=/Users/rob/src/ged_eye/.env.test.local node_modules/vitest/vitest.mjs run tests/db --no-file-parallelism`
Expected: PASS, both files.

Also run `npx vitest run` and confirm the DB files are skipped there, because `DATABASE_URL_TEST` is unset.

- [ ] **Step 5: Commit**

```bash
git add scripts/neon/backfillFacts.js tests/db/testDatabase.js tests/db/backfillFacts.test.js tests/db/personView.test.js package.json
git commit -m "Add compare-and-swap applyPlan/verifyPlan and archive loading for the facts backfill

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 8: The `backfill-facts` CLI

**Files:**
- Modify: `scripts/neon/backfillFacts.js` (add `main`)
- Modify: `package.json` (add the script)

- [ ] **Step 1: Add the CLI.** Add these imports at the top of `scripts/neon/backfillFacts.js`:

```js
import fs from 'fs';
import path from 'path';
import pg from 'pg';
import { parseGedcom } from '../gedParser.js';
import { gedToRows } from './gedToRows.js';
import { ROOT, argValue, isMain, readJson, writeJson } from './cli.js';
```

Then append:

```js
const SAMPLE_IDS = ['I1', 'I23', 'I443'];

async function plan(client, host) {
  const out = path.resolve(argValue('--out') ?? path.join(ROOT, '.neon-import', `facts-backfill-plan-${host}.json`));
  // An earlier plan may be the only rollback for an apply already made, so never overwrite one.
  if (fs.existsSync(out)) throw new Error(`${out} already exists (it may be the rollback for an apply); move it or pass --out <path>`);
  // One snapshot for the archive and the people, read-only.
  await client.query('begin isolation level repeatable read, read only');
  let archive;
  let dbRows;
  try {
    archive = await loadArchive(client, argValue('--sha'));
    dbRows = await readDbRows(client);
  } finally {
    await client.query('rollback');
  }
  const { people } = gedToRows(parseGedcom(archive.content.toString('utf-8')), { files: {}, avatars: {} }, new Map());
  const { rows, summary } = planFacts(dbRows, people);
  writeJson(out, { createdAt: new Date().toISOString(), host, archiveSha: archive.sha256, summary, rows });
  console.log(formatSummary(summary).join('\n'));
  for (const row of rows.filter(r => SAMPLE_IDS.includes(r.id))) console.log(describeRow(row).join('\n'));
  console.log(`plan: ${out} (${rows.length} rows)`);
}

async function write(client, planFile, direction) {
  if (planFile.rows.length === 0) {
    console.log(`The plan has no rows; nothing to ${direction}.`);
    return;
  }
  const { updated } = await applyPlan(client, planFile, { direction });
  const mismatched = await verifyPlan(client, planFile, { direction });
  if (mismatched.length) throw new Error(`${direction} committed ${updated} rows, but ${mismatched.length} don't match the plan: ${mismatched.join(', ')}`);
  console.log(JSON.stringify({ direction, updated, verified: planFile.rows.length }));
}

async function main() {
  const url = argValue('--database-url', process.env.DATABASE_URL_UNPOOLED);
  if (!url) throw new Error('DATABASE_URL_UNPOOLED is not set (run via npm run backfill-facts, or pass --database-url)');
  const host = new URL(url).hostname;
  const applyPath = argValue('--apply');
  const rollbackPath = argValue('--rollback');
  if (applyPath && rollbackPath) throw new Error('Pass --apply or --rollback, not both');
  const direction = applyPath ? 'apply' : rollbackPath ? 'rollback' : null;
  let planFile = null;
  if (direction) {
    const planPath = path.resolve(applyPath ?? rollbackPath);
    planFile = readJson(planPath, null);
    if (!planFile) throw new Error(`No plan at ${planPath}`);
    checkConfirm({ host, planHost: planFile.host, confirm: argValue('--confirm'), direction });
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    if (direction) await write(client, planFile, direction);
    else await plan(client, host);
  } finally {
    await client.end();
  }
}

if (isMain(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    if (error.detail) console.error(`detail: ${error.detail}`);
    process.exit(1);
  });
}
```

`--confirm` is checked before the script connects. `--out`, `--apply` and `--rollback` paths resolve against the current directory; the default plan path is under the repo root.

- [ ] **Step 2: Add the npm script** to `package.json`, after `verify-neon`:

```json
"backfill-facts": "node --env-file=.env.local scripts/neon/backfillFacts.js",
```

- [ ] **Step 3: Smoke-test against the test branch.** After Task 7's DB tests, the test branch has people and no archive. This command loads only the test env file and passes its URL to the CLI:

```bash
node --env-file=/Users/rob/src/ged_eye/.env.test.local -e "process.argv.splice(1, 0, 'scripts/neon/backfillFacts.js', '--database-url', process.env.DATABASE_URL_TEST); import('./scripts/neon/backfillFacts.js')"; echo "exit $?"
```

Expected:
- `Expected exactly one gedcom_archive row, found 0; pass --sha <sha256>`, then `exit 1`. That proves the CLI wiring and the read-only plan path. The full run happens in the rehearsal (Task 15).
- `node scripts/neon/backfillFacts.js --apply /nonexistent.json --database-url postgres://u:p@example.invalid/db; echo "exit $?"` prints `No plan at /nonexistent.json` and `exit 1` without trying to connect.
- `npx vitest run tests/backfillFacts.test.js` still passes, and `node -e "import('./scripts/neon/backfillFacts.js')"` imports cleanly and does nothing.

- [ ] **Step 4: Commit**

```bash
git add scripts/neon/backfillFacts.js package.json
git commit -m "Add the backfill-facts CLI: read-only plan, confirmed apply and rollback

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Chunk 3: API masking and verify-neon

### Task 9: `maskNoteEmails` in the Function

**Files:**
- Create: `api/privacy.js`
- Modify: `api/handler.js`
- Test: `tests/apiHandler.test.js`

- [ ] **Step 1: Write the failing tests.** Append to `tests/apiHandler.test.js` (add `import { maskNoteEmails } from '../api/privacy.js';`):

```js
describe('email masking', () => {
  const person = {
    id: 'I1', email: 'keep@example.com', birthPlace: 'x@y.com',
    notes: ['From: Jo <jo.smith@example.co.uk>\nSent: Monday'],
    deathNotes: ['mail a.b@c.org'],
    censusRecords: [{ date: '1851', notes: ['c@d.net and e@f.io'] }],
    otherFacts: [{ tag: 'EVEN', value: 'v@w.com', notes: ['g@h.com'] }]
  };
  const view = { person, family: [{ id: 'I2', name: 'n@o.com' }], relationships: { parents: [], spouses: [], children: [], siblings: [] } };

  it('masks addresses in note text only', async () => {
    const res = await call(createHandler(vi.fn().mockResolvedValue(view)), '/person/I1');
    const body = await res.json();
    expect(body.person).toEqual({
      ...person,
      notes: ['From: Jo <[email hidden]>\nSent: Monday'],
      deathNotes: ['mail [email hidden]'],
      censusRecords: [{ date: '1851', notes: ['[email hidden] and [email hidden]'] }],
      otherFacts: [{ tag: 'EVEN', value: 'v@w.com', notes: ['[email hidden]'] }]
    });
    expect(body.family).toEqual(view.family);
  });

  it('does not modify its input', () => {
    const copy = structuredClone(view);
    maskNoteEmails(view);
    expect(view).toEqual(copy);
  });
});
```

Run: `npx vitest run tests/apiHandler.test.js`
Expected: FAIL, because the module is not found.

- [ ] **Step 2: Implement `api/privacy.js`**

```js
/**
 * Note text in the GEDCOM includes pasted email threads. The stored facts keep it verbatim
 * (Neon is the master copy); the public API never serves the addresses.
 */
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
export const EMAIL_MASK = '[email hidden]';

const isNoteKey = (key) => key === 'notes' || key.endsWith('Notes');

function mapDeep(value, mapString) {
  if (typeof value === 'string') return mapString(value);
  if (Array.isArray(value)) return value.map(item => mapDeep(item, mapString));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapDeep(item, mapString)]));
  }
  return value;
}

function maskInNotes(value) {
  if (Array.isArray(value)) return value.map(maskInNotes);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      isNoteKey(key) ? mapDeep(item, s => s.replace(EMAIL, EMAIL_MASK)) : maskInNotes(item)]));
  }
  return value;
}

/** A copy of a person_view() document with email addresses in view.person's note text masked. */
export function maskNoteEmails(view) {
  if (!view?.person) return view;
  return { ...view, person: maskInNotes(view.person) };
}
```

- [ ] **Step 3: Use it in `api/handler.js`.** Add `import { maskNoteEmails } from './privacy.js';` at the top and change the success line to:

```js
      return json(200, maskNoteEmails(view), 'public, max-age=300');
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/apiHandler.test.js`
Expected: PASS, including the existing route tests.

Then add a real-file check to `tests/realGed.test.js` (import `{ maskNoteEmails }` from `'../api/privacy.js'`):

```js
  it('leaves no email address in any served note', () => {
    const noteStrings = (value, inNote = false) => Array.isArray(value) ? value.flatMap(v => noteStrings(v, inNote))
      : value && typeof value === 'object' ? Object.entries(value).flatMap(([k, v]) => noteStrings(v, inNote || k === 'notes' || k.endsWith('Notes')))
      : inNote && typeof value === 'string' ? [value] : [];
    const leaks = [...parsed.individuals.keys()].filter(id =>
      noteStrings(maskNoteEmails({ person: current.extractPersonData(parsed, id) }).person).some(note => /\w@\w/.test(note)));
    expect(leaks).toEqual([]);
  });
```

Run: `GED_PATH=/Users/rob/src/ged_eye/acourt.ged npx vitest run tests/realGed.test.js`
Expected: PASS (8 tests). On 2026-10-09 no note had a `word@word` left after masking.

- [ ] **Step 5: Commit**

```bash
git add api/privacy.js api/handler.js tests/apiHandler.test.js tests/realGed.test.js
git commit -m "Mask email addresses in note text before the API serves a person

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 10: verify-neon follows the masking and the re-derived facts

**Files:**
- Modify: `scripts/neon/verifyCompare.js:1-3` (`SCALAR_KEYS`), add `apiMatchesView`
- Modify: `scripts/neon/verify.js:6-9` (import), `:99` (comparison)
- Test: `tests/verifyCompare.test.js`

- [ ] **Step 1: Write the failing test.** Append to `tests/verifyCompare.test.js` (add `apiMatchesView` to the existing import from `'../scripts/neon/verifyCompare.js'`):

```js
describe('apiMatchesView', () => {
  const view = { person: { id: 'I1', notes: ['Write to jo@example.com'] }, family: [], relationships: {} };

  it('accepts the masked body the Function serves', () => {
    expect(apiMatchesView({ ...view, person: { id: 'I1', notes: ['Write to [email hidden]'] } }, view)).toBe(true);
  });

  it('rejects a real difference, and an unmasked body', () => {
    expect(apiMatchesView({ ...view, person: { id: 'I1', notes: ['Something else'] } }, view)).toBe(false);
    expect(apiMatchesView(view, view)).toBe(false);
  });
});
```

Also add this inside the existing `describe('diffView', ...)`, which already has a `diffsFor` helper:

```js
  it('ignores the re-derived facts keys but still compares email and phone', () => {
    const diffs = diffsFor('C1', actual => {
      actual.person = { ...actual.person, notes: ['new'], occupations: [{ value: 'Miller' }], censusRecords: [{ date: '1851' }],
        residences: [{ place: 'X' }], religion: 'Y', education: 'Z', email: 'new@example.com' };
    });
    expect(diffs).toEqual(['email: expected null got "new@example.com"']);
  });
```

Run: `npx vitest run tests/verifyCompare.test.js`
Expected: FAIL. `apiMatchesView` is not exported, and the new diffView test reports the six removed keys.

- [ ] **Step 2: Implement.** In `scripts/neon/verifyCompare.js`, replace `SCALAR_KEYS` with:

```js
// notes, occupations, censusRecords, residences, religion and education are left out: since the
// 2026-10 facts backfill they are re-derived from gedcom_archive by the full parser and checked by
// backfill-facts itself, so the old-parser JSON is no longer their baseline.
const SCALAR_KEYS = ['id', 'name', 'givenName', 'surname', 'sex', 'birthDate', 'birthPlace', 'deathDate', 'deathPlace',
  'baptismDate', 'baptismPlace', 'burialDate', 'burialPlace', 'email', 'phone'];
```

Add `import { maskNoteEmails } from '../../api/privacy.js';` at the top, and add after `canonical`:

```js
/** Whether an API body is what the Function should serve for this person_view() document. */
export function apiMatchesView(body, view) {
  return canonical(body) === canonical(maskNoteEmails(view));
}
```

In `scripts/neon/verify.js`, add `apiMatchesView` to the import from `./verifyCompare.js`, and replace

```js
      if (canonical(body) !== canonical(views.get(id))) problems.push(`api ${id}: body differs from database`);
```

with

```js
      if (!apiMatchesView(body, views.get(id))) problems.push(`api ${id}: body differs from database`);
```

`canonical` is then unused in `verify.js`; remove it from that import (lines 6-8).

- [ ] **Step 3: Run the tests**

Run: `npx vitest run tests/verifyCompare.test.js`
Expected: PASS, including every existing test. If an existing test relied on a removed key such as `notes` in `SCALAR_KEYS`, move it to a key that's still compared (e.g. `email`) rather than deleting it.

- [ ] **Step 4: Commit**

```bash
git add scripts/neon/verifyCompare.js scripts/neon/verify.js tests/verifyCompare.test.js
git commit -m "verify-neon: compare API bodies after masking; stop comparing re-derived facts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Chunk 4: Front end

### Task 11: `src/html.js`

**Files:**
- Create: `src/html.js`
- Modify: `src/main.js:12-14`
- Test: `tests/html.test.js` (new)

- [ ] **Step 1: Write the failing test** in `tests/html.test.js`

```js
import { describe, it, expect } from 'vitest';
import { escapeHtml } from '../src/html.js';

describe('escapeHtml', () => {
  it('escapes the five HTML-special characters and stringifies', () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&</a>`)).toBe('&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
    expect(escapeHtml(1881)).toBe('1881');
  });
});
```

Run: `npx vitest run tests/html.test.js`. Expected: FAIL.

- [ ] **Step 2: Create `src/html.js`**, moving the function verbatim from `src/main.js`:

```js
/** Escapes text for interpolation into HTML (element content or a quoted attribute). */
export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
```

In `src/main.js`, delete the local `escapeHtml` function and add `import { escapeHtml } from './html.js';` with the other imports.

- [ ] **Step 3: Run the tests**

Run: `npx vitest run tests/html.test.js tests/dataLoader.test.js && node --check src/main.js`. Expected: PASS, with no syntax error. Nothing tests `main.js` directly; Task 14's build also covers it.

- [ ] **Step 4: Commit**

```bash
git add src/html.js src/main.js tests/html.test.js
git commit -m "Move escapeHtml into src/html.js

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 12: `src/factLabels.js`

**Files:**
- Create: `src/factLabels.js`
- Test: `tests/factLabels.test.js` (new)

- [ ] **Step 1: Write the failing test** in `tests/factLabels.test.js`

```js
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
```

Run: `npx vitest run tests/factLabels.test.js`. Expected: FAIL.

- [ ] **Step 2: Create `src/factLabels.js`**

```js
/**
 * Display labels for person.facts.otherFacts entries, keyed by GEDCOM tag (Brother's Keeper's
 * own tags start with an underscore).
 */
const LABELS = {
  EVEN: 'Event', _MILT: 'Military service', PROB: 'Probate', EMIG: 'Emigration', IMMI: 'Immigration',
  CHR: 'Christening', CREM: 'Cremation', WILL: 'Will', DSCR: 'Description', NCHI: 'Number of children',
  EDUC: 'Education', RELI: 'Religion', _HEIG: 'Height', _WEIG: 'Weight', _EYEC: 'Eye colour',
  _HAIR: 'Hair colour', _MEDC: 'Medical condition', _INTE: 'Interment', _ADPF: 'Adopted by father',
  _ADPM: 'Adopted by mother', _BRTM: 'Brit milah', _MEMR: 'Memorial', _NMAR: 'Never married',
  BIRT: 'Birth', BAPM: 'Baptism', DEAT: 'Death', BURI: 'Burial'
};

export function factLabel(fact) {
  if (fact.tag === 'EVEN' && fact.type) return fact.type;
  if (Object.hasOwn(LABELS, fact.tag ?? '')) return LABELS[fact.tag];
  const bare = String(fact.tag ?? '').replace(/^_/, '');
  return bare ? bare.charAt(0).toUpperCase() + bare.slice(1).toLowerCase() : 'Other';
}
```

- [ ] **Step 3: Run the test**

Run: `npx vitest run tests/factLabels.test.js`. Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/factLabels.js tests/factLabels.test.js
git commit -m "Add display labels for other facts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 13: The details panel

**Files:**
- Rewrite: `src/personDetails.js` (`showPerson` and the new module-level helpers; `createPanel`, `openPhotoViewer` and `clear` are unchanged)
- Modify: `src/style.css` (after the `.detail-place` rule, about line 520)
- Test: `tests/personDetails.test.js` (new)

- [ ] **Step 1: Write the failing tests** in `tests/personDetails.test.js`

```js
import { describe, it, expect } from 'vitest';
import { PersonDetails } from '../src/personDetails.js';

const XSS = '<img src=x onerror="window.__xss = 1">';

async function render(person, relationships = null) {
  document.body.innerHTML = '<div id="details"></div>';
  const details = new PersonDetails(document.getElementById('details'));
  await details.showPerson({ id: 'I1', name: 'Test Person', sex: 'M', photos: [], ...person }, relationships);
  return document.getElementById('details');
}
const sectionText = (el, title) =>
  [...el.querySelectorAll('.person-details-section')].find(s => s.querySelector('h3').textContent === title)?.textContent;

describe('PersonDetails', () => {
  it('renders every data value as text', async () => {
    const el = await render({
      name: XSS, birthDate: XSS, birthPlace: XSS, causeOfDeath: XSS, deathNotes: [XSS], notes: [XSS],
      occupations: [{ value: XSS, notes: [XSS] }], censusRecords: [{ place: XSS, notes: [XSS] }],
      residences: [{ date: XSS }], otherFacts: [{ tag: XSS, value: XSS }], email: XSS, phone: XSS,
      marriages: [{ spouseId: 'I2', marriagePlace: XSS }]
    }, { spouses: [{ id: 'I2', name: XSS }] });
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('[onerror]')).toBeNull();
    expect(el.querySelector('h2').textContent).toBe(XSS);
    expect(el.textContent.split(XSS).length - 1).toBeGreaterThanOrEqual(15);
  });

  it('never takes a label or summary word from the data', async () => {
    const el = await render({ residences: [{ place: 'p', notes: ['n'], label: XSS, summaryWord: XSS }] });
    expect(el.querySelector('img')).toBeNull();
    expect(sectionText(el, 'Residences')).not.toContain(XSS);
    expect(el.querySelector('details summary').textContent).toBe('Note');
  });

  it('keeps note line breaks and indentation', async () => {
    const el = await render({ notes: ['Line one\n  indented'] });
    expect(el.querySelector('.note-text').textContent).toBe('Line one\n  indented');
  });

  it('puts census transcriptions and fact notes behind a disclosure', async () => {
    const el = await render({
      censusRecords: [{ date: '1851', place: 'Marnhull', notes: ['Age 59'] }, { date: '1861', notes: ['a', 'b'] }],
      residences: [{ place: 'Prison', notes: ['3 months'] }]
    });
    expect([...el.querySelectorAll('details > summary')].map(s => s.textContent)).toEqual(['Transcription', 'Transcriptions (2)', 'Note']);
    expect(el.querySelector('details').open).toBe(false);
    expect(el.querySelector('details .note-text').textContent).toBe('Age 59');
  });

  it('clamps only long person notes, with a working Show more', async () => {
    const el = await render({ notes: ['short', Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n')] });
    const buttons = el.querySelectorAll('.note-toggle');
    expect(buttons).toHaveLength(1);
    const text = buttons[0].previousElementSibling;
    expect(text.classList.contains('note-clamped')).toBe(true);
    buttons[0].click();
    expect(text.classList.contains('note-clamped')).toBe(false);
    expect(buttons[0].textContent).toBe('Show less');
    expect(buttons[0].getAttribute('aria-expanded')).toBe('true');
    buttons[0].click();
    expect(text.classList.contains('note-clamped')).toBe(true);
    expect(buttons[0].textContent).toBe('Show more');
  });

  it('shows a life event that has only notes or a cause', async () => {
    const el = await render({ deathNotes: ['Died as an infant'], causeOfDeath: 'Fever' });
    const lifeEvents = sectionText(el, 'Life Events');
    expect(lifeEvents).toContain('Death:');
    expect(lifeEvents).toContain('Cause: Fever');
    expect(lifeEvents).toContain('Died as an infant');
  });

  it('renders old and new occupation shapes', async () => {
    expect(sectionText(await render({ occupations: ['Miller'] }), 'Occupations')).toContain('Miller');
    const el = await render({ occupations: [{ value: 'Miller', date: '1881', place: 'Stalbridge', notes: ['Employs 2'] }] });
    expect(sectionText(el, 'Occupations')).toContain('Miller • 1881 • Stalbridge');
    expect(el.querySelector('details summary').textContent).toBe('Note');
  });

  it('labels other facts, and still shows legacy religion and education', async () => {
    const el = await render({
      otherFacts: [{ tag: '_MILT', value: 'Militia List', date: '1799' }, { tag: 'EVEN', type: 'Court case', place: 'Dorset' }, { tag: '_FOO' }],
      religion: 'Protestant', education: 'Grammar school'
    });
    const other = sectionText(el, 'Other details');
    for (const text of ['Military service:', 'Militia List • 1799', 'Court case:', 'Dorset', 'Foo:', 'Religion:', 'Protestant', 'Education:', 'Grammar school']) {
      expect(other).toContain(text);
    }
    expect(sectionText(el, 'Personal')).toBeUndefined();
  });

  it('omits empty sections', async () => {
    const el = await render({});
    expect(el.querySelectorAll('h3')).toHaveLength(0);
  });
});
```

Run: `npx vitest run tests/personDetails.test.js`
Expected: FAIL. Escaping, disclosures and the new sections are all missing.

- [ ] **Step 2: Rewrite `src/personDetails.js`.** Keep the class name, the constructor, `createPanel`, `openPhotoViewer` and `clear` exactly as they are. Replace the imports, add the helpers above the class, and replace `showPerson`:

```js
import { PhotoViewer } from './photoViewer.js';
import { thumbUrl } from './media.js';
import { escapeHtml } from './html.js';
import { factLabel } from './factLabels.js';

// Person notes longer than this are clamped to about NOTE_CLAMP_LINES lines behind "Show more".
const NOTE_CLAMP_LINES = 6;
const NOTE_CLAMP_CHARS = 500;

/** A fact's notes behind a native disclosure; summaryWord is "Note" or "Transcription". */
function notesDisclosure(notes, summaryWord = 'Note') {
  if (!notes?.length) return '';
  const summary = notes.length === 1 ? summaryWord : `${summaryWord}s (${notes.length})`;
  const bodies = notes.map(note => `<div class="note-text">${escapeHtml(note)}</div>`).join('');
  return `<details class="detail-notes"><summary>${escapeHtml(summary)}</summary>${bodies}</details>`;
}

/**
 * One fact: "label: value • date • place", an optional cause, and its notes. Every field is optional.
 * The fact is data (it may be a stored object spread in); label and summaryWord are the caller's own.
 */
function factRow({ value, date, place, cause, notes }, { label, summaryWord } = {}) {
  const parts = [];
  if (value) parts.push(`<span class="detail-fact">${escapeHtml(value)}</span>`);
  if (date) parts.push(`<span class="detail-date">${escapeHtml(date)}</span>`);
  if (place) parts.push(`<span class="detail-place">${escapeHtml(place)}</span>`);
  let html = '<div class="detail-item">';
  if (label) html += `<span class="detail-label">${escapeHtml(label)}:</span>`;
  html += `<div class="detail-value">${parts.join(' • ')}`;
  if (cause) html += `<div class="detail-cause">Cause: ${escapeHtml(cause)}</div>`;
  html += notesDisclosure(notes, summaryWord);
  html += '</div></div>';
  return html;
}

function personNote(note) {
  const long = note.length > NOTE_CLAMP_CHARS || note.split('\n').length > NOTE_CLAMP_LINES;
  if (!long) return `<div class="detail-note"><div class="note-text">${escapeHtml(note)}</div></div>`;
  return `<div class="detail-note"><div class="note-text note-clamped">${escapeHtml(note)}</div>` +
    '<button type="button" class="note-toggle" aria-expanded="false">Show more</button></div>';
}

function section(title, rows) {
  return rows.length ? `<div class="person-details-section"><h3>${title}</h3>${rows.join('')}</div>` : '';
}

// Occupations were plain strings before the 2026-10 facts backfill.
const asFact = (entry) => (typeof entry === 'string' ? { value: entry } : entry);
```

```js
  /**
   * Display details for a person
   */
  async showPerson(personData, relationships = null) {
    this.currentPerson = personData;
    this.relationships = relationships;
    this.emptyState.style.display = 'none';

    // Reset scroll position to top
    this.content.scrollTop = 0;

    let html = `
      <div class="person-details-header">
        <h2>${escapeHtml(personData.name || 'Unknown')}</h2>
        ${personData.sex ? `<span class="person-sex">${personData.sex === 'M' ? 'Male' : 'Female'}</span>` : ''}
      </div>
    `;

    // Add photo thumbnails if available (max 4)
    if (personData.photos && personData.photos.length > 0) {
      const maxThumbnails = Math.min(4, personData.photos.length);
      html += '<div class="person-photos-row">';
      for (let i = 0; i < maxThumbnails; i++) {
        const photo = personData.photos[i];
        if (photo.thumbKey) {
          html += `
            <div class="person-photo-thumbnail" data-photo-index="${i}">
              <img src="${escapeHtml(thumbUrl(photo))}" alt="Photo ${i + 1}" />
            </div>
          `;
        } else {
          html += `
            <div class="person-photo-thumbnail person-photo-file" data-photo-index="${i}">
              <div class="file-icon">📄</div>
            </div>
          `;
        }
      }
      html += '</div>';
    }

    html += '<div class="person-details-sections">';

    const lifeEvents = [
      { label: 'Birth', date: personData.birthDate, place: personData.birthPlace, notes: personData.birthNotes },
      { label: 'Baptism', date: personData.baptismDate, place: personData.baptismPlace, notes: personData.baptismNotes },
      { label: 'Death', date: personData.deathDate, place: personData.deathPlace, notes: personData.deathNotes, cause: personData.causeOfDeath },
      { label: 'Burial', date: personData.burialDate, place: personData.burialPlace, notes: personData.burialNotes }
    ].filter(event => event.date || event.place || event.notes?.length || event.cause);
    html += section('Life Events', lifeEvents.map(event => factRow(event, { label: event.label })));

    if (personData.marriages?.length && this.relationships?.spouses) {
      const rows = [];
      for (const marriage of personData.marriages) {
        const spouse = this.relationships.spouses.find(s => s.id === marriage.spouseId);
        rows.push('<div class="detail-item"><span class="detail-label">Spouse:</span>' +
          `<span class="detail-value"><strong>${escapeHtml(spouse?.name || 'Unknown')}</strong></span></div>`);
        if (marriage.marriageDate || marriage.marriagePlace) {
          rows.push(factRow({ date: marriage.marriageDate, place: marriage.marriagePlace }, { label: 'Married' }));
        }
        if (marriage.divorceDate || marriage.divorcePlace) {
          rows.push(factRow({ date: marriage.divorceDate, place: marriage.divorcePlace }, { label: 'Divorced' }));
        }
      }
      html += section('Marriages', rows);
    }

    html += section('Occupations', (personData.occupations ?? []).map(entry => factRow(asFact(entry))));

    const otherRows = (personData.otherFacts ?? []).map(fact => factRow(fact, { label: factLabel(fact) }));
    if (personData.religion) otherRows.push(factRow({ value: personData.religion }, { label: 'Religion' }));
    if (personData.education) otherRows.push(factRow({ value: personData.education }, { label: 'Education' }));
    html += section('Other details', otherRows);

    html += section('Census Records', (personData.censusRecords ?? []).map(census => factRow(census, { summaryWord: 'Transcription' })));
    html += section('Residences', (personData.residences ?? []).map(residence => factRow(residence)));
    html += section('Notes', (personData.notes ?? []).map(personNote));

    const contact = [];
    if (personData.email) {
      contact.push('<div class="detail-item"><span class="detail-label">Email:</span>' +
        `<span class="detail-value"><a href="mailto:${escapeHtml(personData.email)}">${escapeHtml(personData.email)}</a></span></div>`);
    }
    if (personData.phone) {
      contact.push('<div class="detail-item"><span class="detail-label">Phone:</span>' +
        `<span class="detail-value"><a href="tel:${escapeHtml(personData.phone)}">${escapeHtml(personData.phone)}</a></span></div>`);
    }
    html += section('Contact', contact);

    html += '</div>'; // Close sections

    this.content.innerHTML = html;

    // Add click handlers to photo thumbnails
    const thumbnails = this.content.querySelectorAll('.person-photo-thumbnail');
    thumbnails.forEach(thumbnail => {
      thumbnail.addEventListener('click', () => {
        const photoIndex = parseInt(thumbnail.getAttribute('data-photo-index'));
        this.openPhotoViewer(photoIndex);
      });
    });

    this.content.querySelectorAll('.note-toggle').forEach(button => {
      button.addEventListener('click', () => {
        const expanded = !button.previousElementSibling.classList.toggle('note-clamped');
        button.textContent = expanded ? 'Show less' : 'Show more';
        button.setAttribute('aria-expanded', String(expanded));
      });
    });
  }
```

- [ ] **Step 3: Add the styles** to `src/style.css`, directly after the `.detail-place { … }` rule:

```css
.detail-cause {
  color: rgba(255, 255, 255, 0.7);
}

.detail-notes {
  margin-top: 4px;
}

.detail-notes summary {
  cursor: pointer;
  color: #00d4ff;
  font-size: 13px;
}

.detail-notes .note-text {
  margin-top: 6px;
  padding: 8px 10px;
  background: rgba(0, 0, 0, 0.25);
  border-radius: 6px;
}

.detail-note {
  margin-bottom: 12px;
}

.detail-note:last-child {
  margin-bottom: 0;
}

.note-text {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 13px;
  line-height: 1.5;
  color: rgba(255, 255, 255, 0.85);
}

.note-clamped {
  max-height: calc(1.5em * 6);
  overflow: hidden;
  -webkit-mask-image: linear-gradient(to bottom, #000 60%, transparent);
  mask-image: linear-gradient(to bottom, #000 60%, transparent);
}

.note-toggle {
  margin-top: 4px;
  padding: 0;
  border: none;
  background: none;
  color: #00d4ff;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}
```

Inside the existing `@media (max-width: 768px)` block, after its `.detail-value` rule, add:

```css
  .detail-notes .note-text {
    padding: 6px 8px;
  }
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/personDetails.test.js`
Expected: PASS (9 tests).

Run: `npx vitest run`
Expected: everything passes.

- [ ] **Step 5: Commit**

```bash
git add src/personDetails.js src/style.css tests/personDetails.test.js
git commit -m "Details panel: escape all data, show full notes, transcriptions and other facts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Chunk 5: Finish, rehearse, ship

### Task 14: README, build, full verification, review, PR

**Files:**
- Modify: `README.md`
- Rebuild: `docs/`

- [ ] **Step 1: Update `README.md`.**
  - **Project Structure:** add:
    - `gedTree.js` (stage-1 tree) and `gedFacts.js` (person facts), next to `gedParser.js`
    - `api/privacy.js` (masks emails in notes)
    - `neon/backfillFacts.js`
    - `src/html.js` (escaping) and `src/factLabels.js`
  - **Testing:** mention `GED_PATH`, which the real-file parity tests need when `acourt.ged` is not at the repo root.
  - **"How it Works":** item 2 gains one sentence: the Function masks email addresses found in note text.
  - **New subsection** after "Importing the tree (one-off)", titled `### Backfilling facts (one-off, 2026-10)`, explaining:
    - `npm run backfill-facts` writes a read-only plan to `.neon-import/facts-backfill-plan-<host>.json` and prints a summary.
    - `-- --apply <plan> --confirm <host>` compare-and-swaps it in.
    - `-- --rollback <plan> --confirm <host>` undoes it.
    - It only writes `person.facts`, and skips anyone edited since the import.
    - Rollback has the same guard, so once editing starts, rows edited after the backfill can only be restored from the `pre-facts-backfill-2026-10-09` branch.
    - The CLI never overwrites an existing plan file; pass `--out <path>` for a new one.
  - **Last paragraph of "How it Works"** ("anything the parser skips today can be recovered later"): say that sources, family facts and photo titles are still only in the archive.

- [ ] **Step 2: Full verification**

```bash
npx vitest run
GED_PATH=/Users/rob/src/ged_eye/acourt.ged npx vitest run tests/realGed.test.js
node --env-file=/Users/rob/src/ged_eye/.env.local --env-file=/Users/rob/src/ged_eye/.env.test.local node_modules/vitest/vitest.mjs run tests/db --no-file-parallelism
npm run build
```

Expected: all pass. `npm run build` rewrites `docs/` (new hashed asset names).

- [ ] **Step 3: Commit**

```bash
git add README.md docs
git commit -m "README for the facts backfill; rebuild docs/

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 4: Final whole-branch code review.** Use superpowers:requesting-code-review against `origin/main`, with the spec as the requirements. Fix anything important, re-run Step 2, and amend or add commits.

- [ ] **Step 5: Push and open the PR** (`gh pr create` against `main`). The body should cover:
  - a summary
  - the parity evidence (test names and counts)
  - the rollout steps from the spec
  - a note that `neon deploy` runs from the approved PR head just before the merge, and the backfill runs after it, both only with the developer's OK

  End it with the Claude Code attribution line. Don't merge.

### Task 15: Rehearsal on a Neon branch

No commits. Scratch files go in the session scratchpad, written below as `<scratch>`. Never print a connection string in chat or logs.

- [ ] **Step 1: Create the branch.** Use the Neon MCP `create_branch` tool: project `calm-band-80930621`, parent `production`, name `facts-backfill-rehearsal`, with an expiry a few days out if the tool supports one.
  - Get its direct (unpooled) connection string with `get_connection_string`.
  - Write `<scratch>/rehearsal.env` (mode 600) with two lines, `DATABASE_URL=<url>` and `DATABASE_URL_UNPOOLED=<url>`, both the same direct URL. The scripts read these names, so no `--database-url` is needed.
- [ ] **Step 2: Plan.** Run:

```bash
node --env-file=<scratch>/rehearsal.env scripts/neon/backfillFacts.js --out <scratch>/plan-rehearsal.json
```

Expect `unchanged 1602, changed 1392, edited 0, only in database 0, only in GEDCOM 0, column drift 0`, with I1, I23 and I443 samples that look right.

Read the host with `node -p "require('<scratch>/plan-rehearsal.json').host"`. Before Step 3, confirm that it equals the endpoint host from `get_connection_string`, and that it differs from production's host, `node --env-file=/Users/rob/src/ged_eye/.env.local -p "new URL(process.env.DATABASE_URL_UNPOOLED).hostname"`.
- [ ] **Step 3: Apply.** Run:

```bash
node --env-file=<scratch>/rehearsal.env scripts/neon/backfillFacts.js --apply <scratch>/plan-rehearsal.json --confirm <rehearsal host>
```

Expect `{"direction":"apply","host":"<host>","updated":1392,"verified":1392}`.
- [ ] **Step 4: Exercise the supported sequences.** Each re-plan writes its own file, so the Step 2 plan, which is the rollback, is never overwritten.
  1. Re-plan with `--out <scratch>/replan-after-apply.json`. Expect `unchanged 2994, changed 0`.
  2. Run `--rollback <scratch>/plan-rehearsal.json --confirm <rehearsal host>`. Expect `updated 1392, verified 1392`.
  3. Re-plan with `--out <scratch>/replan-after-rollback.json`. Its `summary` and `rows` must equal `plan-rehearsal.json`'s; compare with `node -e` using `canonical`, ignoring `createdAt`.
  4. Apply `<scratch>/plan-rehearsal.json` again. Expect `updated 1392`.
- [ ] **Step 5: Run verify-neon against the backfilled branch.**
  - Copy the import artifacts it needs into the worktree's gitignored `.neon-import/`:

```bash
mkdir -p .neon-import && cp /Users/rob/src/ged_eye/.neon-import/media-manifest.json /Users/rob/src/ged_eye/.neon-import/import-warnings.json .neon-import/
```

  - Then run:

```bash
node --env-file=/Users/rob/src/ged_eye/.env.local --env-file=<scratch>/rehearsal.env scripts/neon/verify.js --api-sample 0 --legacy-root /Users/rob/src/ged_eye/ignore/legacy-data
```

  - Later `--env-file` files override earlier ones, so the branch URL wins. First confirm with `node --env-file=/Users/rob/src/ged_eye/.env.local --env-file=<scratch>/rehearsal.env -p "new URL(process.env.DATABASE_URL).hostname"`; it must be the rehearsal host, not production.
  - Expect 0 unexplained differences. That proves relationships, photos, avatars and core fields survive the backfill.
- [ ] **Step 6: Visual check.**
  - Write `<scratch>/devApi.mjs`:

```js
import http from 'node:http';
import { createRequire } from 'node:module';
const WORKTREE = '/Users/rob/src/ged_eye/.claude/worktrees/great-proskuriakova-4710ff';
const { Pool } = createRequire(`${WORKTREE}/package.json`)('pg');
const { createHandler } = await import(`${WORKTREE}/api/handler.js`);
if (!process.env.DATABASE_URL_UNPOOLED) throw new Error('DATABASE_URL_UNPOOLED is not set');
const pool = new Pool({ connectionString: process.env.DATABASE_URL_UNPOOLED, max: 5 });
const handle = createHandler(async (id) => (await pool.query('select person_view($1) as view', [id])).rows[0].view);
const port = Number(process.env.PORT ?? 8787);
http.createServer(async (req, res) => {
  const response = await handle(new Request(`http://localhost:${port}${req.url}`, { method: req.method }));
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(port, () => console.log(`rehearsal api on :${port}`));
```

  - Add two entries to `.claude/launch.json` (gitignored; keep any existing entries):
    - `rehearsal-api`: runtimeExecutable `node`, args `["--env-file=<scratch>/rehearsal.env", "<scratch>/devApi.mjs"]`, port 8787
    - `web-rehearsal`: runtimeExecutable `env`, args `["VITE_API_URL=http://localhost:8787", "npm", "run", "dev", "--", "--port", "5174", "--strictPort"]`, port 5174
  - Start both with `preview_start`.
  - Open `http://localhost:5174/ged-eye/?person=I1` and confirm with `read_network_requests` that `/person/` calls go to `localhost:8787`.
  - Then check:
    - I1: the full note, clamped, with Show more working
    - I23: Military service under Other details, and notes free of "Parish of Marnhull"
    - I443: census transcription disclosures
    - I711: `[email hidden]`
    - I248: `[email hidden]` for an address the GEDCOM wrote with `@@`
    - I777: a long note
    - I1208: the death row showing only a note
    - mobile width via `resize_window`. If notes or disclosures look wrong there, fix the CSS in a follow-up commit and re-run Task 14 Step 2.
  - Take screenshots as evidence.
  - If anything needed a fix, commit it, re-run Task 14 Step 2 (which rebuilds `docs/`), and push to the PR before Task 16.
- [ ] **Step 7: Clean up.**
  - Stop both preview servers and remove the two `launch.json` entries.
  - Delete `<scratch>/rehearsal.env`.
  - Leave the rehearsal branch for the developer to delete (or let it expire). Deleting is destructive, so ask first.

### Task 16: Production (only after the developer says yes)

Every command below runs from this worktree. The worktree has no `.env.local`, so the commands name `/Users/rob/src/ged_eye/.env.local` explicitly; the npm scripts would not find it.

- [ ] **Step 1: Ask the developer** to approve, in one message:
  - deploying the masking Function
  - merging the PR
  - the production backfill

  Show the rehearsal numbers and screenshots.
- [ ] **Step 2: Deploy the Function first, from the approved PR head.** If the PR merged first, Pages could serve the new bundle, which escapes `<…>`, while the old unmasking Function is still live, so I711's address would show.
  - Confirm `git status --short` is empty, and that `git rev-parse HEAD` equals `gh pr view --json headRefOid -q .headRefOid`.
  - Run `cp /Users/rob/src/ged_eye/.neon .`. It is gitignored and links project `calm-band-80930621`, branch `production`.
  - Run `neon deploy`.
  - Check that `curl -s https://br-green-bonus-b26abimr-api.compute.c-6.eu-central-1.aws.neon.tech/person/I711` returns `[email hidden]` in its notes, and that `/health` is OK.
- [ ] **Step 3: Merge the PR** with `gh pr merge --squash`, as PR #2 was.
  - Run `git fetch origin` and confirm `git diff HEAD origin/main -- api/` is empty, so the deployed Function equals `main`.
  - Wait for Pages to publish.
- [ ] **Step 4: Run verify-neon against production, before the backfill.** The `.neon-import` artifacts were copied in Task 15:

```bash
node --env-file=/Users/rob/src/ged_eye/.env.local scripts/neon/verify.js --legacy-root /Users/rob/src/ged_eye/ignore/legacy-data
```

Expect 0 unexplained differences, with the API sample comparing masked bodies.
- [ ] **Step 5: Create the safety branch.** Use the Neon MCP to create `pre-facts-backfill-2026-10-09` from `production`, with no expiry.
- [ ] **Step 6: Plan against production.** Write the plan outside the worktree, so it survives worktree clean-up:

```bash
node --env-file=/Users/rob/src/ged_eye/.env.local scripts/neon/backfillFacts.js --out /Users/rob/src/ged_eye/.neon-import/facts-backfill-plan-production-2026-10-09.json
```

**Stop rule:** the summary must equal the rehearsal's Step 2 summary: the same counts, the same per-key numbers, and empty `edited`, `onlyInDb`, `onlyInGed` and `columnDrift`. If anything differs, stop and report to the developer. Do not apply.
- [ ] **Step 7: Apply.** Run:

```bash
node --env-file=/Users/rob/src/ged_eye/.env.local scripts/neon/backfillFacts.js --apply /Users/rob/src/ged_eye/.neon-import/facts-backfill-plan-production-2026-10-09.json --confirm <production host>
```

Expect `{"direction":"apply","host":"<host>","updated":1392,"verified":1392}`.
- [ ] **Step 8: Verify after the backfill.** Responses are `public, max-age=300`. If a curl or the verify-neon API sample shows pre-backfill data, wait 5 minutes and re-run before treating it as a failure.
  - Re-plan with `--out <scratch>/replan-production.json`. Expect `unchanged 2994, changed 0`.
  - Re-run the Step 4 verify-neon. Expect 0 unexplained.
  - `curl` the live API for `/person/I1`, `I23`, `I443`, `I711`, `I248` and `I777`, and check the new keys and the masking (no `@` outside `email`).
  - Look at the live site (`https://robacourt.github.io/ged-eye/?person=I1`) after Pages deploys.
- [ ] **Step 9: Summarise.** Report what changed and the evidence. Give the rollback options:

```bash
node --env-file=/Users/rob/src/ged_eye/.env.local scripts/neon/backfillFacts.js --rollback /Users/rob/src/ged_eye/.neon-import/facts-backfill-plan-production-2026-10-09.json --confirm <production host>
```

  or restoring from `pre-facts-backfill-2026-10-09`. Also list the branches left for the developer to delete.
