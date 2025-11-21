import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseGedcom } from '../scripts/gedParser.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Real GEDCOM File', () => {
  it('should parse actual acourt.ged file', () => {
    const gedPath = path.join(__dirname, '..', 'acourt.ged');
    const gedContent = fs.readFileSync(gedPath, 'utf-8');

    // Just test first 100 lines to debug
    const first100Lines = gedContent.split('\n').slice(0, 100).join('\n');

    console.log('First few lines:', gedContent.split('\n').slice(0, 20));

    const result = parseGedcom(gedContent);

    console.log('Parsed individuals:', result.individuals.size);
    console.log('Parsed families:', result.families.size);
    console.log('First 5 individual IDs:', Array.from(result.individuals.keys()).slice(0, 5));

    expect(result.individuals.size).toBeGreaterThan(0);
  });
});
