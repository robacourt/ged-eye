import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseGedcom, extractPersonData } from './gedParser.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, '..');

// Configuration
const GED_FILE = path.join(rootDir, 'acourt.ged');
const OUTPUT_DIR = path.join(rootDir, 'public', 'data', 'people');
const MEDIA_DIR = path.join(rootDir, 'Data', 'Media');

async function processGedcomFile() {
  console.log('Reading GEDCOM file...');
  const gedcomText = fs.readFileSync(GED_FILE, 'utf-8');

  console.log('Parsing GEDCOM...');
  const parsed = parseGedcom(gedcomText);

  console.log(`Found ${parsed.individuals.size} individuals and ${parsed.families.size} families`);

  // Ensure output directory exists
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // Process each individual
  let count = 0;
  let missingPhotoCount = 0;
  const allIds = [];

  for (const [id] of parsed.individuals) {
    const personData = extractPersonData(parsed, id);
    if (!personData) continue;

    // Filter out missing photos
    const existingPhotos = personData.photos.filter(photoPath => {
      const fullPath = path.join(rootDir, photoPath);
      const exists = fs.existsSync(fullPath);
      if (!exists) {
        missingPhotoCount++;
      }
      return exists;
    });

    personData.photos = existingPhotos;

    allIds.push(id);

    // Write JSON file for this person
    const outputFile = path.join(OUTPUT_DIR, `${id}.json`);
    fs.writeFileSync(outputFile, JSON.stringify(personData, null, 2));

    count++;
    if (count % 100 === 0) {
      console.log(`Processed ${count} people...`);
    }
  }

  // Create an index file with all IDs
  const indexFile = path.join(OUTPUT_DIR, 'index.json');
  fs.writeFileSync(indexFile, JSON.stringify({
    totalPeople: allIds.length,
    firstPersonId: allIds[0] || null,
    allIds
  }, null, 2));

  console.log(`\n✓ Successfully processed ${count} people`);
  console.log(`✓ JSON files written to ${OUTPUT_DIR}`);
  console.log(`✓ First person ID: ${allIds[0]}`);
  console.log(`✓ Excluded ${missingPhotoCount} missing photo references`);
}

// Run the script
processGedcomFile().catch(error => {
  console.error('Error processing GEDCOM file:', error);
  process.exit(1);
});
