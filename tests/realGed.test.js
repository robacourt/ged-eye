// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { isDeepStrictEqual } from 'util';
import { ROOT } from '../scripts/neon/cli.js';
import * as current from '../scripts/gedParser.js';
import * as legacy from './fixtures/legacyGedParser.js';
import { parseGedcomTree } from '../scripts/gedTree.js';
import { gedToRows } from '../scripts/neon/gedToRows.js';
import { planFacts } from '../scripts/neon/backfillFacts.js';
import { maskNoteEmails } from '../api/privacy.js';

// The real tree is gitignored, so worktrees lack it:
// GED_PATH=/Users/rob/src/ged_eye/acourt.ged npx vitest run tests/realGed.test.js
const GED_PATH = process.env.GED_PATH || path.join(ROOT, 'acourt.ged');

const LEGACY_FACT_KEYS = ['occupations', 'notes', 'email', 'phone', 'religion', 'education', 'censusRecords', 'residences'];
const NEW_FACT_KEYS = ['occupations', 'notes', 'email', 'phone', 'censusRecords', 'residences',
  'birthNotes', 'baptismNotes', 'deathNotes', 'burialNotes', 'causeOfDeath', 'otherFacts'];
const omit = (object, keys) => Object.fromEntries(Object.entries(object).filter(([key]) => !keys.includes(key)));
const pick = (object, keys) => Object.fromEntries(keys.filter(key => object[key] !== undefined).map(key => [key, object[key]]));
const eventOf = (event) => event && pick(event, ['DATE', 'PLAC']);
const familyLinks = (d) => ({ HUSB: d.HUSB, WIFE: d.WIFE, CHIL: d.CHIL, MARR: eventOf(d.MARR), DIV: eventOf(d.DIV) });

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

  it('plans the production backfill exactly (production facts equal the legacy parser output)', () => {
    const empty = { files: {}, avatars: {} };
    const production = gedToRows(legacyParsed, empty, new Map(), legacy.extractPersonData).people.map(row => ({
      ...row, edited: false, facts: pick(legacy.extractPersonData(legacyParsed, row.id), LEGACY_FACT_KEYS)
    }));
    const { rows, summary } = planFacts(production, gedToRows(parsed, empty, new Map()).people);
    expect(summary).toMatchObject({ unchanged: 1602, changed: 1392, edited: [], onlyInDb: [], onlyInGed: [], columnDrift: [] });
    expect(rows).toHaveLength(1392);

    // The supported sequences, in memory, with jsonb-like round trips: apply, then rollback.
    const people = gedToRows(parsed, empty, new Map()).people;
    const roundTrip = (value) => JSON.parse(JSON.stringify(value));
    const planned = new Map(rows.map(row => [row.id, row]));
    const withFacts = (dbRows, side) => dbRows.map(row => planned.has(row.id) ? { ...row, facts: roundTrip(planned.get(row.id)[side]) } : row);
    const applied = withFacts(production, 'after');
    const afterApply = planFacts(applied, people);
    expect(afterApply.rows).toHaveLength(0);
    expect(afterApply.summary).toMatchObject({ unchanged: 2994, changed: 0, edited: [], columnDrift: [] });
    const afterRollback = planFacts(withFacts(applied, 'before'), people);
    expect(afterRollback.rows).toEqual(rows);
    expect(afterRollback.summary).toMatchObject({ unchanged: 1602, changed: 1392 });
  }, 30_000);

  it('leaves no email address in any served string', () => {
    // Every string in the served person except the deliberate `email` contact field.
    const servedStrings = (v, key) => typeof v === 'string' ? (key === 'email' ? [] : [v])
      : Array.isArray(v) ? v.flatMap(x => servedStrings(x, key))
      : v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => servedStrings(x, k)) : [];
    const addressLike = /[\p{L}\p{M}\p{N}]@[\p{L}\p{M}\p{N}]/u;
    // `current` is the post-backfill shape; `legacy` is what production serves until the backfill.
    for (const [label, ged, extract] of [['current', parsed, current.extractPersonData], ['legacy', legacyParsed, legacy.extractPersonData]]) {
      const leaks = [...ged.individuals.keys()].filter(id =>
        servedStrings(maskNoteEmails({ person: extract(ged, id) }).person).some(s => addressLike.test(s)));
      expect(leaks, label).toEqual([]);
    }
  });
});
