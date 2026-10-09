// @vitest-environment node
/**
 * Every real person's facts survive the person editor's form unchanged: formToFacts(factsToForm(f)) equals f.
 *
 * - The `editing` branch (DATABASE_URL, from .env.local), read-only. person_view is called directly in SQL,
 *   because the public API masks email addresses in notes. Today these are the pre-backfill shapes.
 *     node --env-file=.env.local node_modules/vitest/vitest.mjs run tests/db/factsRoundTrip.test.js
 * - The real GEDCOM (gitignored, so worktrees lack it), in the full-facts shapes the backfill will store.
 *     GED_PATH=/Users/rob/src/ged_eye/acourt.ged npx vitest run tests/db/factsRoundTrip.test.js
 *
 * Each part is skipped without its source.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import pg from 'pg';
import { ROOT } from '../../scripts/neon/cli.js';
import { parseGedcom, extractPersonData } from '../../scripts/gedParser.js';
import { personFacts } from '../../scripts/neon/gedToRows.js';
import { factsFromPerson, factsToForm, formToFacts, factsEqual } from '../../src/factsForm.js';

const DATABASE_URL = process.env.DATABASE_URL;
const GED_PATH = process.env.GED_PATH || path.join(ROOT, 'acourt.ged');

/** The ids whose facts don't survive the round trip. */
function roundTripFailures(people) {
  return people
    .filter(({ facts }) => !factsEqual(formToFacts(factsToForm(facts)), facts))
    .map(({ id }) => id);
}

describe.skipIf(!DATABASE_URL)('every person on the database branch in DATABASE_URL (read-only)', () => {
  it('reads facts back out of person_view, and round-trips them through the form', async () => {
    const client = new pg.Client({ connectionString: DATABASE_URL, options: '-c default_transaction_read_only=on' });
    await client.connect();
    let rows;
    try {
      ({ rows } = await client.query(`select id, facts, person_view(id) -> 'person' as person from person order by id`));
    } finally {
      await client.end();
    }
    expect(rows.length).toBeGreaterThan(2000);

    // factsFromPerson finds exactly the stored facts in the merged person record.
    const extracted = rows.filter(row => !factsEqual(factsFromPerson(row.person), row.facts)).map(row => row.id);
    expect(extracted).toEqual([]);

    const people = rows.map(row => ({ id: row.id, facts: factsFromPerson(row.person) }));
    expect(roundTripFailures(people)).toEqual([]);
    // Nothing the form shows is set aside as legacy, so all of it is editable.
    expect(people.filter(({ facts }) => Object.keys(factsToForm(facts).legacy).length).map(({ id }) => id)).toEqual([]);
    console.log(`facts round trip: ${people.length} people from the database`);
  }, 120_000);
});

describe.skipIf(!fs.existsSync(GED_PATH))('every person in the real GEDCOM, in the full-facts shapes', () => {
  it('round-trips their facts through the form', () => {
    const parsed = parseGedcom(fs.readFileSync(GED_PATH, 'utf-8'));
    const people = [...parsed.individuals.keys()].map(id => ({ id, facts: personFacts(extractPersonData(parsed, id)) }));
    expect(people.length).toBe(2994);
    expect(people.some(({ facts }) => facts.otherFacts?.length)).toBe(true);
    expect(roundTripFailures(people)).toEqual([]);
    expect(people.filter(({ facts }) => Object.keys(factsToForm(facts).legacy).length).map(({ id }) => id)).toEqual([]);
    console.log(`facts round trip: ${people.length} people from the GEDCOM`);
  }, 120_000);
});
