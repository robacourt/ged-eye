# Neon Migration Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve the GED-Eye family tree from Neon: Postgres for people and relationships, Object Storage for media, and one Neon Function as the read API. Then publish the updated GitHub Pages site.

**Architecture:**
- The GEDCOM is imported once into normalized tables (`person`, `family`, `family_child`, `media`, `person_media`).
- A SQL function `person_view(id)` returns the person plus immediate family as one JSON document.
- A Neon Function (`api/`) exposes it as `GET /person/:id`.
- Media and avatars are uploaded once to the `public_read` bucket `ged-eye-media`, keyed by SHA-256.
- The static front end fetches one `/person/:id` per page and loads images from the bucket.

**Tech Stack:** Node 24 ESM scripts, `pg`, `@aws-sdk/client-s3`, `sharp`, Postgres 18 SQL, Neon Functions (`@neon/functions`), Vite + vanilla JS + Cytoscape front end, Vitest.

**Spec:** `specs/2026-10-08-neon-migration-design.md` (revision 3). Read it first.

**Conventions for every task:**
- **Imports.** ESM (`import`), 2-space indent, semicolons, single quotes. These match the existing code.
- **Test environment.** Node-side test files start with `// @vitest-environment node`, because the default Vitest environment is `jsdom`.
- **Running tests.** Run them with `npx vitest run <path>`. Plain `npm test` starts watch mode.
- **Commits.** Never commit `.env.local`, `.env.test.local`, `.neon`, or anything in `.neon-import/` or `ignore/`.
- **Shell.** Use absolute paths, or run from the repo root `/Users/rob/src/ged_eye`.
- **Secrets.** Secrets live in `.env.local`, which is written by the Neon CLI. Scripts load it with `node --env-file=.env.local`.

**Known values:**
- **Project:** `calm-band-80930621`, branch `production`.
- **Bucket:** `ged-eye-media`.
- **Function URL:** `https://br-green-bonus-b26abimr-api.compute.c-6.eu-central-1.aws.neon.tech`
- **Media base URL:** `https://br-green-bonus-b26abimr.storage.c-6.eu-central-1.aws.neon.tech/ged-eye-media`

## File map

| File | Responsibility |
|---|---|
| `scripts/neon/cli.js` | Tiny shared helpers: repo `ROOT`, `argValue`, `hasFlag`, `isMain`, `readJson`, `writeJson` |
| `scripts/neon/mediaTypes.js` | Pure: content type, displayability and `Content-Disposition` for a file name |
| `scripts/neon/legacyData.js` | Reads legacy per-person JSON: avatar map, full people map |
| `scripts/neon/gedToRows.js` | Pure GEDCOM → table rows transform, plus warnings |
| `scripts/neon/uploadMedia.js` | Uploads originals, thumbnails and avatars; writes the media manifest |
| `scripts/neon/migrate.js` | Applies `db/migrations/*.sql` |
| `scripts/neon/importGed.js` | Loads rows into Postgres in one transaction |
| `scripts/neon/verifyCompare.js` | Pure: old-loader expectations plus a diff against `person_view` |
| `scripts/neon/verify.js` | Parity check, bucket check and API sample check |
| `db/migrations/001_schema.sql` | Tables and indexes |
| `db/migrations/002_person_view.sql` | `parent_ids`, `spouse_ids`, `child_ids`, `relative_record`, `person_record`, `person_view` |
| `api/handler.js` | Pure request router (`createHandler`) |
| `api/index.js` | Function entry: `pg` pool plus handler |
| `src/media.js` | `mediaUrl`, `thumbUrl` |
| `src/dataLoader.js` | Fetch, cache and prefetch of `/person/:id` |
| `src/familyTreeView.js`, `src/personDetails.js`, `src/photoViewer.js`, `src/main.js`, `src/style.css` | UI wiring and error overlay |
| `tests/gedToRows.test.js`, `tests/mediaTypes.test.js`, `tests/apiHandler.test.js`, `tests/dataLoader.test.js`, `tests/verifyCompare.test.js`, `tests/db/personView.test.js` | Tests |

---

## Chunk 1: Backend and data

### Task 1: Repo setup and test branch (DONE in commit b1a97e0; the test branch is `br-old-art-b21zk390`)

**Files:**
- Modify: `.gitignore`, `package.json`
- Create: `scripts/neon/cli.js`, `.env.test.local` (gitignored)

- [ ] **Step 1: Extend `.gitignore`.** Append:

```
.env*.local
.neon-import/
ignore/
```

- [ ] **Step 2: Update `package.json` scripts.**
  - Remove `"process-ged"`.
  - Add:

```json
"upload-media": "node --env-file=.env.local scripts/neon/uploadMedia.js",
"db:migrate": "node --env-file=.env.local scripts/neon/migrate.js",
"import-ged": "node --env-file=.env.local scripts/neon/importGed.js",
"verify-neon": "node --env-file=.env.local scripts/neon/verify.js",
"test:db": "node --env-file=.env.local --env-file=.env.test.local node_modules/vitest/vitest.mjs run tests/db"
```

- [ ] **Step 3: Create `scripts/neon/cli.js`.**

```js
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

export function hasFlag(name) {
  return process.argv.includes(name);
}

export function isMain(moduleUrl) {
  return process.argv[1] && moduleUrl === pathToFileURL(path.resolve(process.argv[1])).href;
}

export function readJson(file, fallback) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : fallback;
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}
```

- [ ] **Step 4: Create the `test` Neon branch and record its URL.**

```bash
neon branches create --name test
echo "DATABASE_URL_TEST=$(neon connection-string test)" > .env.test.local
```

Expected: the branch is created, and `.env.test.local` holds a `postgresql://…` URL whose host differs from the one in `DATABASE_URL` in `.env.local`. Use `neon branches create`, not `neon checkout`: `checkout` would deploy the Function to the branch.

- [ ] **Step 5: Commit.** `git add .gitignore package.json scripts/neon/cli.js && git commit -m "Add Neon script scaffolding"`

### Task 2: Media type helpers

**Files:** Create `scripts/neon/mediaTypes.js`; Test `tests/mediaTypes.test.js`

- [ ] **Step 1: Write the failing test.**

```js
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { extOf, contentTypeFor, isDisplayable, contentDisposition, objectKeyFor } from '../scripts/neon/mediaTypes.js';

describe('mediaTypes', () => {
  it('extracts lower-case extensions', () => {
    expect(extOf('Folio 14 page 20.JPG')).toBe('jpg');
    expect(extOf('HO 107 1931 149 80 29jpg')).toBe('');
  });
  it('maps content types with an octet-stream fallback', () => {
    expect(contentTypeFor('a.jpeg')).toBe('image/jpeg');
    expect(contentTypeFor('a.docx')).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(contentTypeFor('a.tif')).toBe('image/tiff');
    expect(contentTypeFor('noext')).toBe('application/octet-stream');
  });
  it('treats only browser-displayable images as displayable', () => {
    expect(isDisplayable('a.png')).toBe(true);
    expect(isDisplayable('a.jfif')).toBe(true);
    expect(isDisplayable('a.tif')).toBe(false);
    expect(isDisplayable('a.htm')).toBe(false);
  });
  it('builds inline or attachment dispositions with an encoded filename', () => {
    expect(contentDisposition('Folio 14.jpg')).toBe("inline; filename*=UTF-8''Folio%2014.jpg");
    expect(contentDisposition("Ian's notes.docx")).toBe("attachment; filename*=UTF-8''Ian's%20notes.docx");
  });
  it('builds content-addressed object keys', () => {
    expect(objectKeyFor('abc', 'x.JPG')).toBe('originals/abc.jpg');
    expect(objectKeyFor('abc', 'noext')).toBe('originals/abc');
  });
});
```

- [ ] **Step 2: Run it.** `npx vitest run tests/mediaTypes.test.js`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement.**

```js
const TYPES = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff',
  pdf: 'application/pdf', doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  htm: 'text/html', html: 'text/html', mht: 'message/rfc822', txt: 'text/plain'
};

const DISPLAYABLE = new Set(['jpg', 'jpeg', 'jfif', 'png', 'gif', 'webp', 'bmp']);

export function extOf(fileName) {
  const match = /\.([A-Za-z0-9]+)$/.exec(fileName);
  return match ? match[1].toLowerCase() : '';
}

export function contentTypeFor(fileName) {
  return TYPES[extOf(fileName)] ?? 'application/octet-stream';
}

export function isDisplayable(fileName) {
  return DISPLAYABLE.has(extOf(fileName));
}

export function contentDisposition(fileName) {
  const mode = isDisplayable(fileName) ? 'inline' : 'attachment';
  return `${mode}; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export function objectKeyFor(sha256, fileName) {
  const ext = extOf(fileName);
  return `originals/${sha256}${ext ? `.${ext}` : ''}`;
}
```

- [ ] **Step 4: Run the test again.** Expected: PASS.
- [ ] **Step 5: Commit.** `git add scripts/neon/mediaTypes.js tests/mediaTypes.test.js && git commit -m "Add media type helpers"`

### Task 3: Legacy data reader and GEDCOM-to-rows transform

**Files:** Create `scripts/neon/legacyData.js`, `scripts/neon/gedToRows.js`; Test `tests/gedToRows.test.js`

- [ ] **Step 1: Create `scripts/neon/legacyData.js`** (no test; it is a thin file reader).

```js
import fs from 'fs';
import path from 'path';

// Legacy per-person JSON lives at <legacyRoot>/data/people/I*.json; avatars at <legacyRoot>/<avatar>.
export function readLegacyPeople(legacyRoot) {
  const dir = path.join(legacyRoot, 'data', 'people');
  const people = new Map();
  for (const name of fs.readdirSync(dir)) {
    if (!/^I[^/]*\.json$/.test(name)) continue; // skips index.json and dotfiles
    const person = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf-8'));
    people.set(person.id, person);
  }
  return people;
}

export function readLegacyAvatars(legacyRoot) {
  const avatars = new Map();
  for (const [id, person] of readLegacyPeople(legacyRoot)) {
    if (person.avatar) avatars.set(id, person.avatar);
  }
  return avatars;
}
```

- [ ] **Step 2: Write the failing test `tests/gedToRows.test.js`.**

```js
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { parseGedcom } from '../scripts/gedParser.js';
import { gedToRows } from '../scripts/neon/gedToRows.js';

const GED = String.raw`0 HEAD
0 @I1@ INDI
1 NAME Adam /Smith/
1 SEX M
1 BIRT
2 DATE 1900
1 OCCU Farmer
1 OBJE
2 FILE C:\BK\Data\Media\a.jpg
1 OBJE
2 FILE C:\BK\Data\Media\a.jpg
1 OBJE
2 FILE C:\BK\Data\Media\a-copy.jpg
1 OBJE
2 FILE C:\BK\Data\Media\missing.jpg
1 FAMS @F1@
1 FAMS @F2@
0 @I2@ INDI
1 NAME Beth /Jones/
1 SEX F
1 FAMS @F1@
0 @I3@ INDI
1 NAME Carl /Smith/
1 SEX M
1 OBJE
2 FILE C:\BK\Data\Media\b.jpg
1 FAMC @F1@
0 @I4@ INDI
1 NAME Dora /Smith/
1 SEX F
1 OBJE
2 FILE C:\BK\Data\Media\b.jpg
1 FAMC @F1@
0 @I5@ INDI
1 NAME Erin /Brown/
1 SEX F
1 FAMS @F2@
0 @I6@ INDI
1 NAME Fred /Smith/
1 SEX M
1 FAMC @F2@
0 @I7@ INDI
1 NAME Gail /Gray/
1 SEX U
0 @F1@ FAM
1 HUSB @I1@
1 WIFE @I2@
1 CHIL @I3@
1 CHIL @I4@
1 MARR
2 DATE 1925
2 PLAC Yeovil
0 @F2@ FAM
1 HUSB @I1@
1 WIFE @I5@
1 CHIL @I6@
1 CHIL @I99@
0 TRLR`;

const file = (sha256, fileName) => ({
  sha256, fileName, objectKey: `originals/${sha256}.jpg`, thumbKey: `thumbs/${sha256}.webp`,
  contentType: 'image/jpeg', byteSize: 10
});

const MANIFEST = {
  files: {
    'Data/Media/a.jpg': file('sha-a', 'a.jpg'),
    'Data/Media/a-copy.jpg': file('sha-a', 'a-copy.jpg'),
    'Data/Media/b.jpg': file('sha-b', 'b.jpg')
  },
  avatars: { 'avatars/I1_0.jpg': 'avatars/sha-av.jpg' }
};

const AVATARS = new Map([['I1', 'avatars/I1_0.jpg'], ['I2', 'avatars/gone.jpg']]);

const rows = () => gedToRows(parseGedcom(GED), MANIFEST, AVATARS);

describe('gedToRows', () => {
  it('builds person rows with facts and avatar keys', () => {
    const { people } = rows();
    expect(people).toHaveLength(7);
    expect(people.find(p => p.id === 'I1')).toEqual({
      id: 'I1', given_name: 'Adam', surname: 'Smith', display_name: 'Adam Smith', sex: 'M',
      birth_date: '1900', birth_place: null, death_date: null, death_place: null,
      baptism_date: null, baptism_place: null, burial_date: null, burial_place: null,
      facts: { occupations: ['Farmer'] }, avatar_key: 'avatars/sha-av.jpg'
    });
    expect(people.find(p => p.id === 'I7').sex).toBe('U');
  });

  it('builds families and ordered children, skipping dangling children', () => {
    const { families, familyChildren, warnings } = rows();
    expect(families.find(f => f.id === 'F1')).toEqual({
      id: 'F1', partner1_id: 'I1', partner2_id: 'I2', marriage_date: '1925', marriage_place: 'Yeovil',
      divorce_date: null, divorce_place: null
    });
    expect(familyChildren).toEqual([
      { family_id: 'F1', child_id: 'I3', position: 0 },
      { family_id: 'F1', child_id: 'I4', position: 1 },
      { family_id: 'F2', child_id: 'I6', position: 0 }
    ]);
    expect(warnings).toContainEqual({ type: 'dangling_child', familyId: 'F2', detail: 'I99' });
  });

  it('de-duplicates media per person and shares media rows across people', () => {
    const { media, personMedia, warnings } = rows();
    expect(media.map(m => m.sha256).sort()).toEqual(['sha-a', 'sha-b']);
    expect(media.find(m => m.sha256 === 'sha-a')).toEqual({
      sha256: 'sha-a', original_path: 'Data/Media/a.jpg', file_name: 'a.jpg', content_type: 'image/jpeg',
      byte_size: 10, object_key: 'originals/sha-a.jpg', thumb_key: 'thumbs/sha-a.webp'
    });
    expect(personMedia).toEqual([
      { person_id: 'I1', sha256: 'sha-a', position: 0 },
      { person_id: 'I3', sha256: 'sha-b', position: 0 },
      { person_id: 'I4', sha256: 'sha-b', position: 0 }
    ]);
    expect(warnings).toContainEqual({ type: 'duplicate_media', personId: 'I1', detail: 'Data/Media/a.jpg' });
    expect(warnings).toContainEqual({ type: 'duplicate_media', personId: 'I1', detail: 'Data/Media/a-copy.jpg' });
    expect(warnings).toContainEqual({ type: 'missing_media', personId: 'I1', detail: 'Data/Media/missing.jpg' });
  });

  it('warns when a legacy avatar is not in the manifest', () => {
    const { people, warnings } = rows();
    expect(people.find(p => p.id === 'I2').avatar_key).toBeNull();
    expect(warnings).toContainEqual({ type: 'missing_avatar', personId: 'I2', detail: 'avatars/gone.jpg' });
  });

  it('handles a single-parent family', () => {
    const ged = String.raw`0 @I1@ INDI
1 NAME Jack /Black/
1 FAMS @F5@
0 @I2@ INDI
1 NAME Kate /Black/
1 FAMC @F5@
0 @F5@ FAM
1 HUSB @I1@
1 CHIL @I2@
0 TRLR`;
    const { families, familyChildren, warnings } = gedToRows(parseGedcom(ged), { files: {}, avatars: {} }, new Map());
    expect(families).toEqual([{ id: 'F5', partner1_id: 'I1', partner2_id: null, marriage_date: null, marriage_place: null, divorce_date: null, divorce_place: null }]);
    expect(familyChildren).toEqual([{ family_id: 'F5', child_id: 'I2', position: 0 }]);
    expect(warnings).toEqual([]);
  });

  it('reports FAMS/FAMC lists that disagree with family records', () => {
    const ged = String.raw`0 @I1@ INDI
1 NAME A /B/
1 FAMS @F1@
1 FAMC @F2@
0 @F1@ FAM
0 @F2@ FAM
0 TRLR`;
    const { warnings } = gedToRows(parseGedcom(ged), { files: {}, avatars: {} }, new Map());
    expect(warnings).toContainEqual({ type: 'fams_mismatch', personId: 'I1', detail: 'FAMS F1; family records ' });
    expect(warnings).toContainEqual({ type: 'famc_mismatch', personId: 'I1', detail: 'FAMC F2; family records ' });
  });
});
```

- [ ] **Step 3: Run it.** `npx vitest run tests/gedToRows.test.js`. Expected: FAIL (module not found).

- [ ] **Step 4: Implement `scripts/neon/gedToRows.js`.**

```js
import { extractPersonData } from '../gedParser.js';

const FACT_KEYS = ['occupations', 'notes', 'email', 'phone', 'religion', 'education', 'censusRecords', 'residences'];
const SEXES = new Set(['M', 'F', 'U']);

/**
 * Pure transform from a parsed GEDCOM to table rows.
 * @param parsedGed result of parseGedcom()
 * @param manifest  { files: { [originalPath]: {sha256, objectKey, thumbKey, contentType, byteSize, fileName} }, avatars: { [avatarPath]: objectKey } }
 * @param avatarMap Map<personId, avatarPath>
 */
export function gedToRows(parsedGed, manifest, avatarMap) {
  const warnings = [];
  const people = [];
  const personMedia = [];
  const mediaBySha = new Map();
  const individuals = parsedGed.individuals;

  for (const [id] of individuals) {
    const p = extractPersonData(parsedGed, id);

    const facts = {};
    for (const key of FACT_KEYS) {
      if (p[key] !== undefined) facts[key] = p[key];
    }

    let sex = p.sex;
    if (sex !== null && !SEXES.has(sex)) {
      warnings.push({ type: 'unknown_sex', personId: id, detail: sex });
      sex = null;
    }

    let avatarKey = null;
    const avatarPath = avatarMap.get(id);
    if (avatarPath) {
      avatarKey = manifest.avatars[avatarPath] ?? null;
      if (!avatarKey) warnings.push({ type: 'missing_avatar', personId: id, detail: avatarPath });
    }

    people.push({
      id,
      given_name: p.givenName,
      surname: p.surname,
      display_name: p.name,
      sex,
      birth_date: p.birthDate,
      birth_place: p.birthPlace,
      death_date: p.deathDate,
      death_place: p.deathPlace,
      baptism_date: p.baptismDate ?? null,
      baptism_place: p.baptismPlace ?? null,
      burial_date: p.burialDate ?? null,
      burial_place: p.burialPlace ?? null,
      facts,
      avatar_key: avatarKey
    });

    const seenShas = new Set();
    for (const photoPath of p.photos) {
      const file = manifest.files[photoPath];
      if (!file) {
        warnings.push({ type: 'missing_media', personId: id, detail: photoPath });
        continue;
      }
      if (seenShas.has(file.sha256)) {
        warnings.push({ type: 'duplicate_media', personId: id, detail: photoPath });
        continue;
      }
      seenShas.add(file.sha256);
      if (!mediaBySha.has(file.sha256)) {
        mediaBySha.set(file.sha256, {
          sha256: file.sha256,
          original_path: photoPath,
          file_name: file.fileName,
          content_type: file.contentType,
          byte_size: file.byteSize,
          object_key: file.objectKey,
          thumb_key: file.thumbKey ?? null
        });
      }
      personMedia.push({ person_id: id, sha256: file.sha256, position: seenShas.size - 1 });
    }
  }

  const families = [];
  const familyChildren = [];
  const partnerFamilies = new Map();
  const childFamilies = new Map();
  const note = (map, personId, familyId) => {
    if (!map.has(personId)) map.set(personId, new Set());
    map.get(personId).add(familyId);
  };

  for (const [familyId, family] of parsedGed.families) {
    const d = family.data;
    const partner = (personId) => {
      if (!personId) return null;
      if (!individuals.has(personId)) {
        warnings.push({ type: 'dangling_partner', familyId, detail: personId });
        return null;
      }
      note(partnerFamilies, personId, familyId);
      return personId;
    };

    families.push({
      id: familyId,
      partner1_id: partner(d.HUSB),
      partner2_id: partner(d.WIFE),
      marriage_date: d.MARR?.DATE ?? null,
      marriage_place: d.MARR?.PLAC ?? null,
      divorce_date: d.DIV?.DATE ?? null,
      divorce_place: d.DIV?.PLAC ?? null
    });

    const seenChildren = new Set();
    for (const childId of d.CHIL || []) {
      if (!individuals.has(childId)) {
        warnings.push({ type: 'dangling_child', familyId, detail: childId });
        continue;
      }
      if (seenChildren.has(childId)) {
        warnings.push({ type: 'duplicate_child', familyId, detail: childId });
        continue;
      }
      seenChildren.add(childId);
      note(childFamilies, childId, familyId);
      familyChildren.push({ family_id: familyId, child_id: childId, position: seenChildren.size - 1 });
    }
  }

  const sameSet = (a, b) => a.size === b.size && [...a].every(x => b.has(x));
  for (const [id, individual] of individuals) {
    const fams = new Set(individual.data.FAMS || []);
    const famc = new Set(individual.data.FAMC || []);
    const asPartner = partnerFamilies.get(id) || new Set();
    const asChild = childFamilies.get(id) || new Set();
    if (!sameSet(fams, asPartner)) {
      warnings.push({ type: 'fams_mismatch', personId: id, detail: `FAMS ${[...fams].join(',')}; family records ${[...asPartner].join(',')}` });
    }
    if (!sameSet(famc, asChild)) {
      warnings.push({ type: 'famc_mismatch', personId: id, detail: `FAMC ${[...famc].join(',')}; family records ${[...asChild].join(',')}` });
    }
  }

  return { people, families, familyChildren, media: [...mediaBySha.values()], personMedia, warnings };
}
```

- [ ] **Step 5: Run the test again.** Expected: PASS. If the parser stores a bare `0 @F1@ FAM` without data, `families` may get partners `null`; the mismatch test expects exactly that.
- [ ] **Step 6: Commit.** `git add scripts/neon/legacyData.js scripts/neon/gedToRows.js tests/gedToRows.test.js && git commit -m "Add GEDCOM to rows transform"`

### Task 4: Media upload script, then run it

**Files:** Create `scripts/neon/uploadMedia.js`

There is no unit test, because it is I/O glue over the tested helpers. It is verified by running it and by `verify-neon`.

- [ ] **Step 1: Implement.**

```js
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import sharp from 'sharp';
import { S3Client, PutObjectCommand, HeadObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { parseGedcom, extractPersonData } from '../gedParser.js';
import { ROOT, argValue, isMain, readJson, writeJson } from './cli.js';
import { readLegacyAvatars } from './legacyData.js';
import { contentTypeFor, contentDisposition, isDisplayable, objectKeyFor } from './mediaTypes.js';

export const BUCKET = process.env.MEDIA_BUCKET || 'ged-eye-media';
export const MANIFEST_PATH = path.join(ROOT, '.neon-import', 'media-manifest.json');
const IMMUTABLE = 'public, max-age=31536000, immutable';
const CONCURRENCY = 6;

const s3 = new S3Client({ forcePathStyle: true });

async function withRetry(label, fn) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= 3) throw new Error(`${label}: ${error.message}`);
      await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt));
    }
  }
}

async function exists(key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return true;
  } catch (error) {
    if (error.$metadata?.httpStatusCode === 404 || error.name === 'NotFound') return false;
    throw error;
  }
}

async function putOnce(key, body, headers) {
  if (await withRetry(`head ${key}`, () => exists(key))) return 'skipped';
  await withRetry(`put ${key}`, () => s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ...headers })));
  return 'uploaded';
}

async function runPool(items, worker) {
  let next = 0;
  const runners = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await worker(item);
    }
  });
  await Promise.all(runners);
}

export function referencedMediaPaths(parsedGed) {
  const paths = new Set();
  for (const [id] of parsedGed.individuals) {
    for (const photoPath of extractPersonData(parsedGed, id).photos) paths.add(photoPath);
  }
  return [...paths];
}

async function main() {
  const legacyRoot = path.resolve(ROOT, argValue('--legacy-root', 'public'));
  const parsed = parseGedcom(fs.readFileSync(path.join(ROOT, 'acourt.ged'), 'utf-8'));
  const manifest = readJson(MANIFEST_PATH, { files: {}, avatars: {} });
  const stats = { uploaded: 0, skipped: 0, missing: 0, failed: 0, thumbFailed: 0 };
  const failures = [];
  let sinceSave = 0;
  const save = (force = false) => {
    if (force || ++sinceSave >= 25) {
      writeJson(MANIFEST_PATH, manifest);
      sinceSave = 0;
    }
  };

  const mediaPaths = referencedMediaPaths(parsed);
  console.log(`Media: ${mediaPaths.length} referenced paths`);

  await runPool(mediaPaths, async (mediaPath) => {
    const fullPath = path.join(ROOT, mediaPath);
    if (!fs.existsSync(fullPath)) {
      stats.missing++;
      return;
    }
    try {
      const body = fs.readFileSync(fullPath);
      const sha256 = crypto.createHash('sha256').update(body).digest('hex');
      const fileName = path.basename(mediaPath);
      const objectKey = objectKeyFor(sha256, fileName);
      const result = await putOnce(objectKey, body, {
        ContentType: contentTypeFor(fileName),
        CacheControl: IMMUTABLE,
        ContentDisposition: contentDisposition(fileName)
      });
      stats[result]++;

      let thumbKey = null;
      if (isDisplayable(fileName)) {
        try {
          const key = `thumbs/${sha256}.webp`;
          if (!(await withRetry(`head ${key}`, () => exists(key)))) {
            const thumb = await sharp(body).rotate().resize(320, 320, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 75 }).toBuffer();
            await withRetry(`put ${key}`, () => s3.send(new PutObjectCommand({
              Bucket: BUCKET, Key: key, Body: thumb, ContentType: 'image/webp', CacheControl: IMMUTABLE
            })));
          }
          thumbKey = key;
        } catch (error) {
          stats.thumbFailed++;
          console.warn(`Thumbnail failed for ${mediaPath}: ${error.message}`);
        }
      }

      manifest.files[mediaPath] = {
        sha256, objectKey, thumbKey, contentType: contentTypeFor(fileName), byteSize: body.length, fileName
      };
      save();
    } catch (error) {
      stats.failed++;
      failures.push(`${mediaPath}: ${error.message}`);
    }
  });

  const avatarPaths = [...new Set(readLegacyAvatars(legacyRoot).values())];
  console.log(`Avatars: ${avatarPaths.length} in use`);
  await runPool(avatarPaths, async (avatarPath) => {
    const fullPath = path.join(legacyRoot, avatarPath);
    if (!fs.existsSync(fullPath)) {
      stats.missing++;
      return;
    }
    try {
      const body = fs.readFileSync(fullPath);
      const sha256 = crypto.createHash('sha256').update(body).digest('hex');
      const key = `avatars/${sha256}.jpg`;
      stats[await putOnce(key, body, { ContentType: 'image/jpeg', CacheControl: IMMUTABLE })]++;
      manifest.avatars[avatarPath] = key;
      save();
    } catch (error) {
      stats.failed++;
      failures.push(`${avatarPath}: ${error.message}`);
    }
  });

  save(true);
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: 'spike/test.jpg' })).catch(() => {});

  console.log(JSON.stringify(stats));
  if (failures.length) {
    console.error(failures.join('\n'));
    process.exit(1);
  }
}

if (isMain(import.meta.url)) {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
```

- [ ] **Step 2: Smoke-check it.** `node --check scripts/neon/uploadMedia.js`. Expected: no output.
- [ ] **Step 3: Commit.** `git add scripts/neon/uploadMedia.js && git commit -m "Add media upload script"`
- [ ] **Step 4: Run it.**

  ```bash
  mkdir -p .neon-import
  set -o pipefail
  npm run upload-media 2>&1 | tee .neon-import/upload.log
  ```

  This can take 10–30 minutes. Thumbnails are not counted in the totals. Expected final line, roughly: `{"uploaded":~1229,"skipped":0,"missing":~75,"failed":0,"thumbFailed":<small>}`, which is 558 originals plus about 671 avatars. The exit code must be 0. Re-running it should report everything as skipped.

### Task 5: Schema, `person_view`, migration runner and DB tests

**Files:** Create `db/migrations/001_schema.sql`, `db/migrations/002_person_view.sql`, `scripts/neon/migrate.js`; Test `tests/db/personView.test.js`

- [ ] **Step 1: Write `scripts/neon/migrate.js`.**

```js
import fs from 'fs';
import path from 'path';
import pg from 'pg';
import { ROOT, argValue, isMain } from './cli.js';

const MIGRATIONS_DIR = path.join(ROOT, 'db', 'migrations');

export async function migrate(databaseUrl, { log = console.log } = {}) {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(`create table if not exists schema_migrations (
      filename text primary key,
      applied_at timestamptz not null default now()
    )`);
    const applied = new Set((await client.query('select filename from schema_migrations')).rows.map(r => r.filename));
    const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into schema_migrations (filename) values ($1)', [file]);
        await client.query('commit');
        log(`applied ${file}`);
      } catch (error) {
        await client.query('rollback');
        throw new Error(`${file}: ${error.message}`);
      }
    }
  } finally {
    await client.end();
  }
}

if (isMain(import.meta.url)) {
  const url = argValue('--database-url', process.env.DATABASE_URL_UNPOOLED);
  if (!url) {
    console.error('No database URL: set DATABASE_URL_UNPOOLED (npm run db:migrate loads .env.local) or pass --database-url');
    process.exit(1);
  }
  migrate(url).catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}
```

- [ ] **Step 2: Write `db/migrations/001_schema.sql`.**

```sql
create table person (
  id            text primary key,
  given_name    text not null default '',
  surname       text not null default '',
  display_name  text not null,
  sex           text check (sex in ('M', 'F', 'U')),
  birth_date    text,
  birth_place   text,
  death_date    text,
  death_place   text,
  baptism_date  text,
  baptism_place text,
  burial_date   text,
  burial_place  text,
  facts         jsonb not null default '{}',
  avatar_key    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table family (
  id             text primary key,
  partner1_id    text references person (id) on delete set null,
  partner2_id    text references person (id) on delete set null,
  marriage_date  text,
  marriage_place text,
  divorce_date   text,
  divorce_place  text,
  -- numeric part of the GEDCOM id (F12 -> 12); orders a person's families
  sort_key       bigint generated always as (coalesce(nullif(regexp_replace(id, '\D', '', 'g'), '')::bigint, 0)) stored
);
create index family_partner1_idx on family (partner1_id);
create index family_partner2_idx on family (partner2_id);

create table family_child (
  family_id text not null references family (id) on delete cascade,
  child_id  text not null references person (id) on delete cascade,
  position  int  not null,
  primary key (family_id, child_id)
);
create index family_child_child_idx on family_child (child_id);

create table media (
  id            bigint generated always as identity primary key,
  sha256        text not null unique,
  original_path text not null,
  file_name     text not null,
  content_type  text not null,
  byte_size     bigint not null,
  object_key    text not null,
  thumb_key     text
);

create table person_media (
  person_id text   not null references person (id) on delete cascade,
  media_id  bigint not null references media (id) on delete cascade,
  position  int    not null,
  primary key (person_id, media_id)
);
```

- [ ] **Step 3: Write `db/migrations/002_person_view.sql`.**

```sql
-- Ordered, de-duplicated relationship id lists for one person.
create or replace function parent_ids(p_id text) returns text[]
language sql stable as $$
  select coalesce(array_agg(pid order by first_ord), '{}')
  from (
    select pid, min(ord) as first_ord
    from (
      select x.pid, row_number() over (order by f.sort_key, f.id, x.slot) as ord
      from family_child fc
      join family f on f.id = fc.family_id
      cross join lateral (values (1, f.partner1_id), (2, f.partner2_id)) as x (slot, pid)
      where fc.child_id = p_id and x.pid is not null
    ) s
    group by pid
  ) t
$$;

create or replace function spouse_ids(p_id text) returns text[]
language sql stable as $$
  select coalesce(array_agg(sid order by first_ord), '{}')
  from (
    select sid, min(ord) as first_ord
    from (
      select case when f.partner1_id = p_id then f.partner2_id else f.partner1_id end as sid,
             row_number() over (order by f.sort_key, f.id) as ord
      from family f
      where f.partner1_id = p_id or f.partner2_id = p_id
    ) s
    where sid is not null
    group by sid
  ) t
$$;

create or replace function child_ids(p_id text) returns text[]
language sql stable as $$
  select coalesce(array_agg(cid order by first_ord), '{}')
  from (
    select cid, min(ord) as first_ord
    from (
      select fc.child_id as cid, row_number() over (order by f.sort_key, f.id, fc.position) as ord
      from family f
      join family_child fc on fc.family_id = f.id
      where f.partner1_id = p_id or f.partner2_id = p_id
    ) s
    group by cid
  ) t
$$;

-- What the graph needs to draw a relative.
create or replace function relative_record(p_id text) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'id', p.id,
    'name', p.display_name,
    'sex', p.sex,
    'birthDate', p.birth_date,
    'avatarKey', p.avatar_key,
    'parentIds', to_jsonb(parent_ids(p.id))
  )
  from person p
  where p.id = p_id
$$;

-- Full record for the selected person, in the legacy per-person JSON shape.
create or replace function person_record(p_id text) returns jsonb
language sql stable as $$
  select
    jsonb_build_object(
      'id', p.id,
      'name', p.display_name,
      'givenName', p.given_name,
      'surname', p.surname,
      'sex', p.sex,
      'birthDate', p.birth_date,
      'birthPlace', p.birth_place,
      'deathDate', p.death_date,
      'deathPlace', p.death_place,
      'photos', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'key', m.object_key, 'thumbKey', m.thumb_key,
                 'fileName', m.file_name, 'contentType', m.content_type)
               order by pm.position)
        from person_media pm
        join media m on m.id = pm.media_id
        where pm.person_id = p.id
      ), '[]'::jsonb),
      'parentIds', to_jsonb(parent_ids(p.id)),
      'spouseIds', to_jsonb(spouse_ids(p.id)),
      'childIds', to_jsonb(child_ids(p.id)),
      'avatarKey', p.avatar_key
    )
    || jsonb_strip_nulls(jsonb_build_object(
      'baptismDate', p.baptism_date,
      'baptismPlace', p.baptism_place,
      'burialDate', p.burial_date,
      'burialPlace', p.burial_place
    ))
    || case when mar.list is null then '{}'::jsonb else jsonb_build_object('marriages', mar.list) end
    || p.facts
  from person p
  cross join lateral (
    select jsonb_agg(
             jsonb_build_object(
               'spouseId', case when f.partner1_id = p.id then f.partner2_id else f.partner1_id end,
               'familyId', f.id
             )
             || jsonb_strip_nulls(jsonb_build_object(
               'marriageDate', f.marriage_date,
               'marriagePlace', f.marriage_place,
               'divorceDate', f.divorce_date,
               'divorcePlace', f.divorce_place
             ))
             order by f.sort_key, f.id) as list
    from family f
    where f.partner1_id = p.id or f.partner2_id = p.id
  ) mar
  where p.id = p_id
$$;

-- The selected person plus immediate family, in one document. Null if the id is unknown.
create or replace function person_view(p_id text) returns jsonb
language sql stable as $$
  with
  parent_list as (select id, ord from unnest(parent_ids(p_id)) with ordinality as t (id, ord)),
  spouse_list as (select id, ord from unnest(spouse_ids(p_id)) with ordinality as t (id, ord)),
  child_list as (select id, ord from unnest(child_ids(p_id)) with ordinality as t (id, ord)),
  sibling_list as (
    select id, min(ord) as ord
    from (
      select fc.child_id as id, row_number() over (order by f.sort_key, f.id, fc.position) as ord
      from family f
      join family_child fc on fc.family_id = f.id
      where (f.partner1_id in (select id from parent_list) or f.partner2_id in (select id from parent_list))
        and fc.child_id <> p_id
    ) s
    group by id
  ),
  other_parent_list as (
    select distinct x.pid as id
    from sibling_list s
    join family_child fc on fc.child_id = s.id
    join family f on f.id = fc.family_id
    cross join lateral (values (f.partner1_id), (f.partner2_id)) as x (pid)
    where x.pid is not null and x.pid <> p_id and x.pid not in (select id from parent_list)
  ),
  candidates as (
    select id, 1 as grp, ord from parent_list
    union all select id, 2, ord from spouse_list
    union all select id, 3, ord from child_list
    union all select id, 4, ord from sibling_list
    union all select id, 5, 0 from other_parent_list
  ),
  members as (
    select distinct on (id) id, grp, ord
    from candidates
    where id <> p_id
    order by id, grp, ord
  )
  select case when not exists (select 1 from person where id = p_id) then null else
    jsonb_build_object(
      'person', person_record(p_id),
      'family', coalesce((select jsonb_agg(relative_record(m.id) order by m.grp, m.ord, m.id) from members m), '[]'::jsonb),
      'relationships', jsonb_build_object(
        'parents', coalesce((select jsonb_agg(id order by ord) from parent_list), '[]'::jsonb),
        'spouses', coalesce((select jsonb_agg(id order by ord) from spouse_list), '[]'::jsonb),
        'children', coalesce((select jsonb_agg(id order by ord) from child_list), '[]'::jsonb),
        'siblings', coalesce((select jsonb_agg(id order by ord) from sibling_list), '[]'::jsonb)
      )
    )
  end
$$;
```

- [ ] **Step 4: Write the DB test `tests/db/personView.test.js`.**

```js
// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { migrate } from '../../scripts/neon/migrate.js';

const url = process.env.DATABASE_URL_TEST;
const host = (u) => new URL(u).hostname.replace('-pooler', '');
const productionHosts = [process.env.DATABASE_URL, process.env.DATABASE_URL_UNPOOLED].filter(Boolean).map(host);
if (url && productionHosts.includes(host(url))) {
  throw new Error('DATABASE_URL_TEST points at the production branch; refusing to reset it');
}

const FIXTURE = `
insert into person (id, given_name, surname, display_name, sex, birth_date, facts, avatar_key) values
  ('I1', 'Adam', 'Smith', 'Adam Smith', 'M', '1900', '{}', null),
  ('I2', 'Beth', 'Jones', 'Beth Jones', 'F', null, '{}', null),
  ('I3', 'Carl', 'Smith', 'Carl Smith', 'M', 'ABT 1930', '{"occupations": ["Farmer"], "notes": ["A note"]}', 'avatars/c.jpg'),
  ('I4', 'Dora', 'Smith', 'Dora Smith', 'F', null, '{}', null),
  ('I5', 'Erin', 'Brown', 'Erin Brown', 'F', null, '{}', null),
  ('I6', 'Fred', 'Smith', 'Fred Smith', 'M', null, '{}', null),
  ('I7', 'Gina', 'Green', 'Gina Green', 'F', null, '{}', null),
  ('I8', 'Hugo', 'Smith', 'Hugo Smith', 'M', null, '{}', null),
  ('I9', 'Iris', 'White', 'Iris White', 'F', null, '{}', null),
  ('I10', 'Jack', 'Black', 'Jack Black', 'M', null, '{}', null),
  ('I11', 'Kate', 'Black', 'Kate Black', 'F', null, '{}', null),
  ('I12', 'Liam', 'Gray', 'Liam Gray', 'U', null, '{}', null);
insert into family (id, partner1_id, partner2_id, marriage_date, marriage_place) values
  ('F1', 'I1', 'I2', '1925', 'Yeovil'),
  ('F2', 'I1', 'I5', null, null),
  ('F10', 'I3', 'I7', '1955', null),
  ('F9', 'I3', 'I9', null, null),
  ('F5', 'I10', null, null, null);
insert into family_child (family_id, child_id, position) values
  ('F1', 'I4', 0), ('F1', 'I3', 1), ('F2', 'I6', 0), ('F10', 'I8', 0), ('F5', 'I11', 0);
insert into media (sha256, original_path, file_name, content_type, byte_size, object_key, thumb_key) values
  ('aaa', 'Data/Media/a.jpg', 'a.jpg', 'image/jpeg', 10, 'originals/aaa.jpg', 'thumbs/aaa.webp'),
  ('bbb', 'Data/Media/b.docx', 'b.docx', 'application/msword', 20, 'originals/bbb.docx', null);
insert into person_media (person_id, media_id, position)
  select 'I3', id, case sha256 when 'bbb' then 0 else 1 end from media;
`;

describe.skipIf(!url)('person_view (database)', () => {
  let client;
  const view = async (id) => (await client.query('select person_view($1) as v', [id])).rows[0].v;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: url });
    await client.connect();
    await client.query('drop schema public cascade; create schema public;');
    await migrate(url, { log: () => {} });
    await client.query(FIXTURE);
  }, 60000);

  afterAll(async () => {
    await client?.end();
  });

  it('returns null for an unknown id', async () => {
    expect(await view('I999')).toBeNull();
  });

  it('returns relationships in order, including half siblings and their other parent', async () => {
    const v = await view('I3');
    expect(v.relationships).toEqual({
      parents: ['I1', 'I2'],
      spouses: ['I9', 'I7'],
      children: ['I8'],
      siblings: ['I4', 'I6']
    });
    expect(v.family.map(m => m.id)).toEqual(['I1', 'I2', 'I9', 'I7', 'I8', 'I4', 'I6', 'I5']);
  });

  it('returns the full person record with facts, photos, avatar and marriages', async () => {
    const { person } = await view('I3');
    expect(person).toEqual({
      id: 'I3', name: 'Carl Smith', givenName: 'Carl', surname: 'Smith', sex: 'M',
      birthDate: 'ABT 1930', birthPlace: null, deathDate: null, deathPlace: null,
      photos: [
        { key: 'originals/bbb.docx', thumbKey: null, fileName: 'b.docx', contentType: 'application/msword' },
        { key: 'originals/aaa.jpg', thumbKey: 'thumbs/aaa.webp', fileName: 'a.jpg', contentType: 'image/jpeg' }
      ],
      parentIds: ['I1', 'I2'],
      spouseIds: ['I9', 'I7'],
      childIds: ['I8'],
      avatarKey: 'avatars/c.jpg',
      marriages: [
        { spouseId: 'I9', familyId: 'F9' },
        { spouseId: 'I7', familyId: 'F10', marriageDate: '1955' }
      ],
      occupations: ['Farmer'],
      notes: ['A note']
    });
  });

  it('returns slim relative records', async () => {
    const { family } = await view('I3');
    expect(family.find(m => m.id === 'I6')).toEqual({
      id: 'I6', name: 'Fred Smith', sex: 'M', birthDate: null, avatarKey: null, parentIds: ['I1', 'I5']
    });
  });

  it('handles single-parent families and people with no family', async () => {
    const kate = await view('I11');
    expect(kate.relationships).toEqual({ parents: ['I10'], spouses: [], children: [], siblings: [] });
    expect(kate.person.marriages).toBeUndefined();

    const jack = await view('I10');
    expect(jack.relationships.children).toEqual(['I11']);
    expect(jack.relationships.spouses).toEqual([]);
    expect(jack.person.marriages).toEqual([{ spouseId: null, familyId: 'F5' }]);

    const liam = await view('I12');
    expect(liam.family).toEqual([]);
    expect(liam.person.parentIds).toEqual([]);
  });
});
```

- [ ] **Step 5: Run it.** `npm run test:db`. Expected: all tests PASS. Before the SQL files existed this would have failed. If a test fails, fix the SQL rather than the expectations, unless the expectation contradicts the spec.
- [ ] **Step 6: Apply the migrations to production.** `npm run db:migrate`. Expected output: `applied 001_schema.sql` and `applied 002_person_view.sql`.
- [ ] **Step 7: Commit.** `git add db scripts/neon/migrate.js tests/db && git commit -m "Add schema, person_view and migration runner"`

### Task 6: GEDCOM archive, import script, then run it

**Files:** Create `db/migrations/003_gedcom_archive.sql`, `scripts/neon/importGed.js`

**Why the archive (added after code review).** `scripts/gedParser.js` keeps only the tags the site shows. It drops CONT/CONC continuation lines (160 notes are cut short), census transcription notes, several event types and source citations. Neon becomes the master copy, so the original file must be kept verbatim. Then a better parser can re-derive those fields later without Brother's Keeper. The archive table is never exposed: the Function only calls `person_view`.

- [ ] **Step 0a: Write `db/migrations/003_gedcom_archive.sql`.**

```sql
-- The original GEDCOM, byte for byte. The structured tables hold only what
-- scripts/gedParser.js understands, and Neon is now the master copy.
create table gedcom_archive (
  id          bigint generated always as identity primary key,
  file_name   text not null,
  sha256      text not null unique,
  imported_at timestamptz not null default now(),
  content     bytea not null
);
```

- [ ] **Step 0b: Apply it.** Run `npm run test:db` (all tests still pass; the reset re-applies every migration), then `npm run db:migrate`. Expected: `applied 003_gedcom_archive.sql`.

- [ ] **Step 1: Implement.**

```js
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import pg from 'pg';
import { parseGedcom } from '../gedParser.js';
import { ROOT, argValue, hasFlag, isMain, readJson, writeJson } from './cli.js';
import { readLegacyAvatars } from './legacyData.js';
import { gedToRows } from './gedToRows.js';
import { MANIFEST_PATH } from './uploadMedia.js';

export const WARNINGS_PATH = path.join(ROOT, '.neon-import', 'import-warnings.json');
const BATCH = 500;

async function insertRows(client, table, columns, rows, returning) {
  const out = [];
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const params = [];
    const tuples = chunk.map((row, r) => {
      columns.forEach(column => params.push(row[column]));
      return `(${columns.map((_, c) => `$${r * columns.length + c + 1}`).join(', ')})`;
    });
    const sql = `insert into ${table} (${columns.join(', ')}) values ${tuples.join(', ')}${returning ? ` returning ${returning}` : ''}`;
    out.push(...(await client.query(sql, params)).rows);
  }
  return out;
}

async function main() {
  const legacyRoot = path.resolve(ROOT, argValue('--legacy-root', 'public'));
  const replace = hasFlag('--replace');
  const manifest = readJson(MANIFEST_PATH, null);
  if (!manifest) throw new Error(`No media manifest at ${MANIFEST_PATH}; run npm run upload-media first`);

  const gedBytes = fs.readFileSync(path.join(ROOT, 'acourt.ged'));
  const parsed = parseGedcom(gedBytes.toString('utf-8'));
  const rows = gedToRows(parsed, manifest, readLegacyAvatars(legacyRoot));
  const people = rows.people.map(p => ({ ...p, facts: JSON.stringify(p.facts) }));

  const client = new pg.Client({ connectionString: process.env.DATABASE_URL_UNPOOLED });
  await client.connect();
  try {
    const { rows: [{ count }] } = await client.query('select count(*)::int as count from person');
    if (count > 0 && !replace) throw new Error(`person already has ${count} rows; pass --replace to wipe and reload`);

    await client.query('begin');
    if (replace) await client.query('truncate person_media, media, family_child, family, person restart identity cascade');
    await insertRows(client, 'person', ['id', 'given_name', 'surname', 'display_name', 'sex', 'birth_date', 'birth_place',
      'death_date', 'death_place', 'baptism_date', 'baptism_place', 'burial_date', 'burial_place', 'facts', 'avatar_key'], people);
    await insertRows(client, 'family', ['id', 'partner1_id', 'partner2_id', 'marriage_date', 'marriage_place',
      'divorce_date', 'divorce_place'], rows.families);
    await insertRows(client, 'family_child', ['family_id', 'child_id', 'position'], rows.familyChildren);
    const mediaIds = new Map((await insertRows(client, 'media', ['sha256', 'original_path', 'file_name', 'content_type',
      'byte_size', 'object_key', 'thumb_key'], rows.media, 'id, sha256')).map(r => [r.sha256, r.id]));
    await insertRows(client, 'person_media', ['person_id', 'media_id', 'position'],
      rows.personMedia.map(pm => ({ person_id: pm.person_id, media_id: mediaIds.get(pm.sha256), position: pm.position })));
    await client.query(
      'insert into gedcom_archive (file_name, sha256, content) values ($1, $2, $3) on conflict (sha256) do nothing',
      ['acourt.ged', crypto.createHash('sha256').update(gedBytes).digest('hex'), gedBytes]
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }

  writeJson(WARNINGS_PATH, rows.warnings);
  const byType = rows.warnings.reduce((acc, w) => ({ ...acc, [w.type]: (acc[w.type] || 0) + 1 }), {});
  console.log(JSON.stringify({
    people: rows.people.length, families: rows.families.length, familyChildren: rows.familyChildren.length,
    media: rows.media.length, personMedia: rows.personMedia.length, warnings: byType
  }));
}

if (isMain(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}
```

Importing `MANIFEST_PATH` from `uploadMedia.js` creates an `S3Client` at import time, which is harmless: it needs no network until used. Because `uploadMedia.js` guards its `main()` with `isMain`, importing it does not run the upload.

- [ ] **Step 2: Run it.** This requires Task 4's upload to have finished. Run `npm run import-ged`. Expected: `{"people":2994,"families":1029,…}` with exit code 0.
- [ ] **Step 3: Spot-check it.** `node --env-file=.env.local -e "const pg=require('pg');const c=new pg.Client({connectionString:process.env.DATABASE_URL});c.connect().then(()=>c.query(\"select person_view('I122') v\")).then(r=>{console.log(JSON.stringify(r.rows[0].v.relationships));return c.end()})"`. Expected: I122's parents, spouses, children and siblings as ID arrays.
- [ ] **Step 4: Check the archive.** Query `select file_name, sha256, length(content) from gedcom_archive` (using the same node one-liner style as Step 3). Expected: one row of about 3,063,220 bytes, whose `sha256` equals `shasum -a 256 acourt.ged`.
- [ ] **Step 5: Commit.** `git add db/migrations/003_gedcom_archive.sql scripts/neon/importGed.js && git commit -m "Archive the GEDCOM and add the import script"`

### Task 7: API Function

**Files:** Create `api/handler.js`; Modify `api/index.js` (currently the spike); Test `tests/apiHandler.test.js`

- [ ] **Step 1: Write the failing test.**

```js
// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { createHandler } from '../api/handler.js';

const VIEW = { person: { id: 'I1' }, family: [], relationships: { parents: [], spouses: [], children: [], siblings: [] } };
const call = (handler, path, method = 'GET') => handler(new Request(`https://api.test${path}`, { method }));

describe('api handler', () => {
  it('returns a person view with caching and CORS headers', async () => {
    const query = vi.fn().mockResolvedValue(VIEW);
    const res = await call(createHandler(query), '/person/I1');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(VIEW);
    expect(query).toHaveBeenCalledWith('I1');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');
    expect(res.headers.get('content-type')).toBe('application/json');
  });

  it('returns 404 for an unknown person', async () => {
    const res = await call(createHandler(vi.fn().mockResolvedValue(null)), '/person/I999');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('rejects malformed ids without querying', async () => {
    const query = vi.fn();
    const res = await call(createHandler(query), '/person/' + encodeURIComponent('I1; drop table'));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'bad_id' });
    expect(query).not.toHaveBeenCalled();
  });

  it('answers health checks, unknown routes and preflight', async () => {
    const handler = createHandler(vi.fn());
    expect(await (await call(handler, '/health')).json()).toEqual({ ok: true });
    expect((await call(handler, '/nope')).status).toBe(404);
    expect((await call(handler, '/person/I1', 'POST')).status).toBe(404);
    const preflight = await call(handler, '/person/I1', 'OPTIONS');
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('returns 500 and logs when the query fails', async () => {
    const log = vi.fn();
    const res = await createHandler(vi.fn().mockRejectedValue(new Error('boom')), { log })(new Request('https://api.test/person/I1'));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal' });
    expect(log).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it.** `npx vitest run tests/apiHandler.test.js`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement `api/handler.js`.**

```js
const ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const PERSON_PATH = /^\/person\/([^/]+)$/;
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS'
};

function json(status, body, cacheControl = 'no-store') {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'content-type': 'application/json', 'cache-control': cacheControl }
  });
}

/**
 * @param queryPersonView (id) => Promise<object|null>
 */
export function createHandler(queryPersonView, { log = console.error } = {}) {
  return async function handle(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { ...CORS, 'access-control-max-age': '86400' } });
    }
    if (request.method !== 'GET') return json(404, { error: 'not_found' });

    const { pathname } = new URL(request.url);
    if (pathname === '/health') return json(200, { ok: true });

    const match = PERSON_PATH.exec(pathname);
    if (!match) return json(404, { error: 'not_found' });

    let id;
    try {
      id = decodeURIComponent(match[1]);
    } catch {
      return json(400, { error: 'bad_id' });
    }
    if (!ID_PATTERN.test(id)) return json(400, { error: 'bad_id' });

    try {
      const view = await queryPersonView(id);
      if (!view) return json(404, { error: 'not_found' });
      return json(200, view, 'public, max-age=300');
    } catch (error) {
      log('person_view failed', id, error);
      return json(500, { error: 'internal' });
    }
  };
}
```

- [ ] **Step 4: Replace `api/index.js`.**

```js
import { Pool } from 'pg';
import { attachDatabasePool } from '@neon/functions';
import { createHandler } from './handler.js';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
attachDatabasePool(pool);

const handle = createHandler(async (id) => {
  const { rows } = await pool.query('select person_view($1) as view', [id]);
  return rows[0].view;
});

export default { fetch: handle };
```

- [ ] **Step 5: Run the test again.** Expected: PASS.
- [ ] **Step 6: Deploy and smoke-test.** Run `neon deploy`, then:

```bash
curl -s -w "\n%{http_code} %{time_total}s\n" https://br-green-bonus-b26abimr-api.compute.c-6.eu-central-1.aws.neon.tech/person/I122 | tail -c 300
```

Expected: JSON ending in `…}` followed by `200 <time>`. Also check `/person/I999999`, which should return 404.

- [ ] **Step 7: Commit.** `git add api tests/apiHandler.test.js && git commit -m "Add person API function"`

### Task 8: Parity verification

**Files:** Create `scripts/neon/verifyCompare.js`, `scripts/neon/verify.js`; Test `tests/verifyCompare.test.js`

- [ ] **Step 1: Write the failing test.**

```js
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { legacyExpected, diffView } from '../scripts/neon/verifyCompare.js';

const person = (id, extra) => ({
  id, name: id, givenName: id, surname: '', sex: 'M', birthDate: null, birthPlace: null,
  deathDate: null, deathPlace: null, photos: [], spouseIds: [], childIds: [], parentIds: [], ...extra
});

const PEOPLE = new Map([
  ['P1', person('P1', { spouseIds: ['P2', 'P5'], childIds: ['C1', 'C2', 'H1'] })],
  ['P2', person('P2', { spouseIds: ['P1'], childIds: ['C1', 'C2'] })],
  ['P5', person('P5', { spouseIds: ['P1'], childIds: ['H1'] })],
  ['C1', person('C1', { parentIds: ['P1', 'P2'] })],
  ['C2', person('C2', { parentIds: ['P1', 'P2'] })],
  ['H1', person('H1', { parentIds: ['P1', 'P5'] })]
]);

describe('legacyExpected', () => {
  it('reproduces the old loader: siblings incl. half siblings and their other parent', () => {
    const e = legacyExpected(PEOPLE, 'C1');
    expect(e.relationships.parents).toEqual(['P1', 'P2']);
    expect(new Set(e.relationships.siblings)).toEqual(new Set(['C2', 'H1']));
    expect(e.familyIds).toEqual(new Set(['P1', 'P2', 'C2', 'H1', 'P5']));
  });
});

describe('diffView', () => {
  const manifest = { files: {}, avatars: {} };
  const actualFor = (e) => ({
    person: { ...e.person, photos: [], avatarKey: null },
    family: [...e.familyIds].map(id => ({ id, name: id, sex: 'M', birthDate: null, avatarKey: null, parentIds: PEOPLE.get(id).parentIds })),
    relationships: e.relationships
  });

  it('reports no differences for a matching view', () => {
    const e = legacyExpected(PEOPLE, 'C1');
    expect(diffView(e, actualFor(e), manifest, PEOPLE)).toEqual([]);
  });

  it('reports set and field differences', () => {
    const e = legacyExpected(PEOPLE, 'C1');
    const actual = actualFor(e);
    actual.relationships = { ...actual.relationships, siblings: ['C2'] };
    actual.person = { ...actual.person, birthDate: '1900' };
    const diffs = diffView(e, actual, manifest, PEOPLE);
    expect(diffs.some(d => d.startsWith('siblings'))).toBe(true);
    expect(diffs.some(d => d.startsWith('birthDate'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run it.** `npx vitest run tests/verifyCompare.test.js`. Expected: FAIL.

- [ ] **Step 3: Implement `scripts/neon/verifyCompare.js`.**

```js
const SCALAR_KEYS = ['id', 'name', 'givenName', 'surname', 'sex', 'birthDate', 'birthPlace', 'deathDate', 'deathPlace',
  'baptismDate', 'baptismPlace', 'burialDate', 'burialPlace', 'occupations', 'notes', 'email', 'phone', 'religion',
  'education', 'censusRecords', 'residences'];

const canonical = (value) => JSON.stringify(value, (_, v) =>
  v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);

/** What the legacy loadPersonWithFamily() would show for `id`, from the legacy JSON files. */
export function legacyExpected(people, id) {
  const person = people.get(id);
  const known = (pid) => people.has(pid);
  const parents = person.parentIds.filter(known);
  const candidates = new Set();
  for (const pid of parents) {
    for (const cid of people.get(pid).childIds) if (cid !== id) candidates.add(cid);
  }
  const siblings = [...candidates].filter(known)
    .filter(sid => person.parentIds.some(pid => people.get(sid).parentIds.includes(pid)));
  const otherParents = new Set();
  for (const sid of siblings) {
    for (const spid of people.get(sid).parentIds) if (!person.parentIds.includes(spid)) otherParents.add(spid);
  }
  const familyIds = new Set([...person.parentIds, ...person.spouseIds, ...person.childIds, ...candidates, ...otherParents].filter(known));
  familyIds.delete(id);
  return {
    person,
    relationships: {
      parents,
      spouses: person.spouseIds.filter(known),
      children: person.childIds.filter(known),
      siblings
    },
    familyIds
  };
}

/** Differences between the legacy expectation and a person_view() result. Empty array = match. */
export function diffView(expected, actual, manifest, people) {
  if (!actual) return ['person_view returned null'];
  const diffs = [];
  const sameSet = (label, a, b) => {
    const A = new Set(a);
    const B = new Set(b);
    if (A.size !== B.size || [...A].some(x => !B.has(x))) {
      diffs.push(`${label}: expected [${[...A].sort()}] got [${[...B].sort()}]`);
    }
  };

  for (const key of ['parents', 'spouses', 'children', 'siblings']) {
    sameSet(key, expected.relationships[key], actual.relationships[key]);
  }
  sameSet('family', expected.familyIds, actual.family.map(m => m.id));

  const p = expected.person;
  const q = actual.person;
  for (const key of SCALAR_KEYS) {
    if (canonical(p[key] ?? null) !== canonical(q[key] ?? null)) {
      diffs.push(`${key}: expected ${canonical(p[key] ?? null)} got ${canonical(q[key] ?? null)}`);
    }
  }
  sameSet('parentIds', p.parentIds, q.parentIds);
  sameSet('spouseIds', p.spouseIds, q.spouseIds);
  sameSet('childIds', p.childIds, q.childIds);
  sameSet('marriages', (p.marriages ?? []).map(canonical), (q.marriages ?? []).map(canonical));

  const expectedShas = [...new Set(p.photos.map(path => manifest.files[path]?.sha256 ?? `missing:${path}`))];
  const actualShas = q.photos.map(photo => /^originals\/([0-9a-f]{64})/.exec(photo.key)?.[1] ?? photo.key);
  if (canonical(expectedShas) !== canonical(actualShas)) {
    diffs.push(`photos: expected ${canonical(expectedShas)} got ${canonical(actualShas)}`);
  }

  const expectedAvatar = p.avatar ? (manifest.avatars[p.avatar] ?? `missing:${p.avatar}`) : null;
  if (expectedAvatar !== q.avatarKey) diffs.push(`avatarKey: expected ${expectedAvatar} got ${q.avatarKey}`);

  for (const member of actual.family) {
    const legacy = people.get(member.id);
    if (!legacy) {
      diffs.push(`family ${member.id}: not in legacy data`);
      continue;
    }
    for (const key of ['name', 'sex', 'birthDate']) {
      if ((legacy[key] ?? null) !== (member[key] ?? null)) diffs.push(`family ${member.id}.${key}: expected ${legacy[key]} got ${member[key]}`);
    }
    sameSet(`family ${member.id}.parentIds`, legacy.parentIds, member.parentIds);
    const memberAvatar = legacy.avatar ? (manifest.avatars[legacy.avatar] ?? `missing:${legacy.avatar}`) : null;
    if (memberAvatar !== member.avatarKey) diffs.push(`family ${member.id}.avatarKey: expected ${memberAvatar} got ${member.avatarKey}`);
  }
  return diffs;
}
```

- [ ] **Step 4: Run the test again.** Expected: PASS.

- [ ] **Step 5: Implement `scripts/neon/verify.js`.**

```js
import path from 'path';
import pg from 'pg';
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { ROOT, argValue, isMain, readJson } from './cli.js';
import { readLegacyPeople } from './legacyData.js';
import { legacyExpected, diffView } from './verifyCompare.js';
import { BUCKET, MANIFEST_PATH } from './uploadMedia.js';
import { WARNINGS_PATH } from './importGed.js';

const canonical = (value) => JSON.stringify(value, (_, v) =>
  v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);

async function listKeys(s3) {
  const keys = new Set();
  let token;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, ContinuationToken: token }));
    for (const object of page.Contents ?? []) keys.add(object.Key);
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

async function main() {
  const legacyRoot = path.resolve(ROOT, argValue('--legacy-root', 'public'));
  const apiSample = Number(argValue('--api-sample', '25'));
  const manifest = readJson(MANIFEST_PATH, null);
  const warnings = readJson(WARNINGS_PATH, []);
  const warnedPeople = new Set(warnings.map(w => w.personId).filter(Boolean));
  const people = readLegacyPeople(legacyRoot);
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
  const problems = [];

  const { rows: [{ count }] } = await pool.query('select count(*)::int as count from person');
  if (count !== people.size) problems.push(`person count ${count} != legacy ${people.size}`);

  const ids = [...people.keys()];
  const views = new Map();
  let explained = 0;
  let next = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (next < ids.length) {
      const id = ids[next++];
      const { rows } = await pool.query('select person_view($1) as v', [id]);
      views.set(id, rows[0].v);
      const diffs = diffView(legacyExpected(people, id), rows[0].v, manifest, people);
      if (!diffs.length) continue;
      if (warnedPeople.has(id)) {
        explained++;
        console.log(`[explained] ${id}: ${diffs.join(' | ')}`);
      } else {
        problems.push(`${id}: ${diffs.join(' | ')}`);
      }
    }
  }));

  const s3 = new S3Client({ forcePathStyle: true });
  const keys = await listKeys(s3);
  const { rows: keyRows } = await pool.query(`
    select object_key as key from media
    union all select thumb_key from media where thumb_key is not null
    union all select avatar_key from person where avatar_key is not null`);
  const missingKeys = keyRows.map(r => r.key).filter(key => !keys.has(key));
  if (missingKeys.length) problems.push(`missing bucket objects: ${missingKeys.slice(0, 20).join(', ')} (${missingKeys.length} total)`);

  const apiBase = (process.env.NEON_FUNCTION_API_BASE_URL || 'https://br-green-bonus-b26abimr-api.compute.c-6.eu-central-1.aws.neon.tech').replace(/\/$/, '');
  const timings = [];
  if (apiSample > 0) {
    const sample = [...ids].sort(() => Math.random() - 0.5).slice(0, apiSample);
    for (const id of sample) {
      const started = Date.now();
      const res = await fetch(`${apiBase}/person/${encodeURIComponent(id)}`);
      timings.push(Date.now() - started);
      const body = await res.json();
      if (res.status !== 200 || canonical(body) !== canonical(views.get(id))) problems.push(`api ${id}: status ${res.status} or body differs from database`);
    }
  }
  await pool.end();

  console.log(JSON.stringify({
    people: ids.length, explained, unexplained: problems.length, bucketObjects: keys.size,
    apiSample: timings.length, apiMedianMs: timings.sort((a, b) => a - b)[Math.floor(timings.length / 2)] ?? null
  }));
  if (problems.length) {
    console.error(problems.join('\n'));
    process.exit(1);
  }
}

if (isMain(import.meta.url)) {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
```

- [ ] **Step 6: Run it.** `npm run verify-neon`. Expected: last line `{"people":2994,"explained":<n>,"unexplained":0,…}` with exit code 0. Every unexplained difference must be investigated and fixed at its source (SQL or transform) before moving on. Do not weaken the comparison to make it pass. The one exception is a difference the spec explicitly calls intended.
- [ ] **Step 7: Commit.** `git add scripts/neon/verifyCompare.js scripts/neon/verify.js tests/verifyCompare.test.js && git commit -m "Add Neon parity verification"`

---

## Chunk 2: Front end and publish

### Task 9: `media.js` and `dataLoader.js`

**Files:** Create `src/media.js`; Rewrite `src/dataLoader.js`; Test `tests/dataLoader.test.js`; Create `.env.development` and `.env.production`

- [ ] **Step 1: Create the env files.** `.env.development` and `.env.production` get identical contents:

```
VITE_API_URL=https://br-green-bonus-b26abimr-api.compute.c-6.eu-central-1.aws.neon.tech
VITE_MEDIA_BASE_URL=https://br-green-bonus-b26abimr.storage.c-6.eu-central-1.aws.neon.tech/ged-eye-media
```

Do **not** create a plain `.env`. The Neon CLI writes secrets into `.env` whenever that file exists.

- [ ] **Step 2: Write the failing test `tests/dataLoader.test.js`.**

```js
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadPersonWithFamily, prefetchFamily, PersonNotFoundError, resetDataLoaderForTests } from '../src/dataLoader.js';
import { mediaUrl, thumbUrl } from '../src/media.js';

const view = (id, familyIds = []) => ({
  person: { id, name: id, parentIds: [], spouseIds: [], childIds: [], photos: [] },
  family: familyIds.map(fid => ({ id: fid, name: fid, sex: 'M', birthDate: null, avatarKey: null, parentIds: [] })),
  relationships: { parents: familyIds.slice(0, 1), spouses: [], children: familyIds.slice(1), siblings: [] }
});
const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe('dataLoader', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_API_URL', 'https://api.test');
    vi.stubEnv('VITE_MEDIA_BASE_URL', 'https://media.test/bucket');
    resetDataLoaderForTests();
    globalThis.requestIdleCallback = (cb) => cb();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('loads a view and maps relationship ids to records', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok(view('I1', ['I2', 'I3'])));
    vi.stubGlobal('fetch', fetchMock);
    const result = await loadPersonWithFamily('I1');
    expect(fetchMock).toHaveBeenCalledWith('https://api.test/person/I1');
    expect(result.person.id).toBe('I1');
    expect(result.relationships.parents.map(p => p.id)).toEqual(['I2']);
    expect(result.relationships.children.map(p => p.id)).toEqual(['I3']);
    expect(result.family).toHaveLength(2);
  });

  it('caches views', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok(view('I1')));
    vi.stubGlobal('fetch', fetchMock);
    await loadPersonWithFamily('I1');
    await loadPersonWithFamily('I1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws PersonNotFoundError on 404 and on a malformed id (400)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({ error: 'not_found' }) }));
    await expect(loadPersonWithFamily('I9')).rejects.toBeInstanceOf(PersonNotFoundError);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: 'bad_id' }) }));
    await expect(loadPersonWithFamily('a.b')).rejects.toBeInstanceOf(PersonNotFoundError);
  });

  it('retries once after a network error', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError('offline')).mockResolvedValue(ok(view('I1')));
    vi.stubGlobal('fetch', fetchMock);
    await expect(loadPersonWithFamily('I1')).resolves.toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after a second server error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) }));
    await expect(loadPersonWithFamily('I1')).rejects.toThrow('HTTP 503');
  });

  it('prefetches uncached relatives only once', async () => {
    const fetchMock = vi.fn((url) => Promise.resolve(ok(view(url.split('/').pop()))));
    vi.stubGlobal('fetch', fetchMock);
    const result = await loadPersonWithFamily('I1');
    await loadPersonWithFamily('I2');
    fetchMock.mockClear();
    const withFamily = { ...result, family: [{ id: 'I2' }, { id: 'I3' }, { id: 'I4' }] };
    prefetchFamily(withFamily);
    prefetchFamily(withFamily);
    await flush();
    expect(fetchMock.mock.calls.map(([url]) => url).sort()).toEqual(['https://api.test/person/I3', 'https://api.test/person/I4']);
  });

  it('does not prefetch a person whose view is already being loaded', async () => {
    let resolveI5;
    const fetchMock = vi.fn((url) => url.endsWith('/I5')
      ? new Promise(resolve => { resolveI5 = () => resolve(ok(view('I5'))); })
      : Promise.resolve(ok(view(url.split('/').pop()))));
    vi.stubGlobal('fetch', fetchMock);
    const pending = loadPersonWithFamily('I5');
    prefetchFamily({ family: [{ id: 'I5' }] });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolveI5();
    await pending;
  });
});

describe('media urls', () => {
  beforeEach(() => vi.stubEnv('VITE_MEDIA_BASE_URL', 'https://media.test/bucket'));
  afterEach(() => vi.unstubAllEnvs());

  it('builds encoded media and thumbnail urls', () => {
    expect(mediaUrl('originals/a b.jpg')).toBe('https://media.test/bucket/originals/a%20b.jpg');
    expect(mediaUrl(null)).toBeNull();
    expect(thumbUrl({ thumbKey: 'thumbs/x.webp' })).toBe('https://media.test/bucket/thumbs/x.webp');
    expect(thumbUrl({ thumbKey: null })).toBeNull();
  });
});
```

- [ ] **Step 3: Run it.** `npx vitest run tests/dataLoader.test.js`. Expected: FAIL.

- [ ] **Step 4: Create `src/media.js`.**

```js
/**
 * URLs for objects in the public media bucket.
 */
export function mediaUrl(key) {
  if (!key) return null;
  const base = import.meta.env.VITE_MEDIA_BASE_URL;
  return `${base}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

export function thumbUrl(photo) {
  return photo?.thumbKey ? mediaUrl(photo.thumbKey) : null;
}
```

- [ ] **Step 5: Rewrite `src/dataLoader.js`.**

```js
/**
 * Loads person views (a person plus immediate family) from the Neon API, with an in-memory cache.
 */

const PREFETCH_CONCURRENCY = 4;

const cache = new Map();      // personId -> view
const inflight = new Map();   // personId -> Promise<view>
const prefetched = new Set(); // personIds already queued for prefetch

export class PersonNotFoundError extends Error {
  constructor(personId) {
    super(`Person ${personId} not found`);
    this.name = 'PersonNotFoundError';
    this.personId = personId;
  }
}

async function requestView(personId) {
  const url = `${import.meta.env.VITE_API_URL}/person/${encodeURIComponent(personId)}`;
  for (let attempt = 1; ; attempt++) {
    let response;
    try {
      response = await fetch(url);
    } catch (error) {
      if (attempt < 2) continue;
      throw error;
    }
    if (response.status === 404 || response.status === 400) throw new PersonNotFoundError(personId);
    if (response.ok) return response.json();
    if (response.status >= 500 && attempt < 2) continue;
    throw new Error(`Failed to load person ${personId}: HTTP ${response.status}`);
  }
}

function getView(personId) {
  if (cache.has(personId)) return Promise.resolve(cache.get(personId));
  if (inflight.has(personId)) return inflight.get(personId);
  const promise = requestView(personId)
    .then(view => {
      cache.set(personId, view);
      return view;
    })
    .finally(() => inflight.delete(personId));
  inflight.set(personId, promise);
  return promise;
}

/**
 * Load a person and their immediate family.
 * @returns {Promise<{person, family, relationships: {parents, spouses, children, siblings}}>}
 */
export async function loadPersonWithFamily(personId) {
  const view = await getView(personId);
  const byId = new Map(view.family.map(member => [member.id, member]));
  const pick = ids => ids.map(id => byId.get(id)).filter(Boolean);
  return {
    person: view.person,
    family: view.family,
    relationships: {
      parents: pick(view.relationships.parents),
      spouses: pick(view.relationships.spouses),
      children: pick(view.relationships.children),
      siblings: pick(view.relationships.siblings)
    }
  };
}

/**
 * Quietly fetch the views of everyone in `result.family` so clicking them is instant.
 */
export function prefetchFamily(result) {
  const ids = result.family
    .map(member => member.id)
    .filter(id => !cache.has(id) && !inflight.has(id) && !prefetched.has(id));
  if (ids.length === 0) return;
  ids.forEach(id => prefetched.add(id));

  const whenIdle = globalThis.requestIdleCallback ?? (callback => setTimeout(callback, 200));
  whenIdle(() => {
    let next = 0;
    const worker = async () => {
      while (next < ids.length) {
        const id = ids[next++];
        try {
          await getView(id);
        } catch {
          // Prefetch is best effort; a real click will retry and report errors.
        }
      }
    };
    for (let i = 0; i < Math.min(PREFETCH_CONCURRENCY, ids.length); i++) worker();
  });
}

export function resetDataLoaderForTests() {
  cache.clear();
  inflight.clear();
  prefetched.clear();
}
```

- [ ] **Step 6: Run the test again.** Expected: PASS.
- [ ] **Step 7: Commit.** `git add .env.development .env.production src/media.js src/dataLoader.js tests/dataLoader.test.js && git commit -m "Load person views from the Neon API"`

### Task 10: UI wiring and error overlay

**Files:** Modify `src/familyTreeView.js`, `src/personDetails.js`, `src/photoViewer.js`, `src/main.js`, `src/style.css`; Create `public/placeholders/man.png`, `public/placeholders/woman.png`

- [ ] **Step 1: Placeholders.** `mkdir -p public/placeholders && cp public/avatars/man.png public/avatars/woman.png public/placeholders/`

- [ ] **Step 2: Update `src/familyTreeView.js`.**
  - **Imports.** Replace `import { loadPersonWithFamily } from './dataLoader.js';` and `import { PhotoViewer } from './photoViewer.js';` with:

    ```js
    import { loadPersonWithFamily, prefetchFamily } from './dataLoader.js';
    import { mediaUrl } from './media.js';
    ```

  - **Constructor.** Delete `this.photoViewer = new PhotoViewer();` and `this.personDataCache = new Map(); …`.
  - **`loadPerson`.** Replace the method with:

    ```js
    /**
     * Load and display a person and their immediate family.
     * Returns null if a newer loadPerson() call started while this one was in flight.
     */
    async loadPerson(personId) {
      this.pendingPersonId = personId;
      const result = await loadPersonWithFamily(personId);
      if (this.pendingPersonId !== personId) return null;

      this.selectedPersonId = personId;
      this.buildGraph(result.person, result.family, result.relationships);
      prefetchFamily(result);
      return { person: result.person, relationships: result.relationships };
    }
    ```

  - **`selectPerson`.** Replace it so that `main.js` owns loading and error handling:

    ```js
    /**
     * Select a different person (main.js loads and renders them)
     */
    selectPerson(personId) {
      this.onPersonSelectCallback?.(personId);
    }
    ```

    Then `grep -n "selectPerson" src/familyTreeView.js` and make sure no caller relies on it awaiting a load.
  - **`getAvatarPath`.** Replace its body with:

    ```js
    if (person.avatarKey) {
      return mediaUrl(person.avatarKey);
    }
    const placeholder = person.sex === 'F' ? 'woman.png' : 'man.png';
    return `${import.meta.env.BASE_URL}placeholders/${placeholder}`;
    ```

- [ ] **Step 3: Update `src/personDetails.js`.**
  - **Thumbnail loop.** Make it use photo objects:

    ```js
    const photo = personData.photos[i];
    if (photo.thumbKey) {
      html += `
        <div class="person-photo-thumbnail" data-photo-index="${i}">
          <img src="${thumbUrl(photo)}" alt="Photo ${i + 1}" />
        </div>
      `;
    } else {
      // existing file-icon branch unchanged
    }
    ```

  - **Import.** Add `import { thumbUrl } from './media.js';`.
  - **`isImageFile`.** Delete the method, and check with grep that nothing else uses it.
  - **`openPhotoViewer`.** Pass the photo objects straight through: `this.photoViewer.open(this.currentPerson.name, this.currentPerson.photos);`.

- [ ] **Step 4: Update `src/photoViewer.js`.**
  - Add `import { mediaUrl } from './media.js';`.
  - In `open()`, change the placeholder to `[{ key: null, message: 'No photos available' }]`.
  - In `updateDisplay()`:
    - Replace the `!currentPhoto.path` check with `!currentPhoto.key`.
    - Set the file name with `const fileName = currentPhoto.fileName;`, replacing the path-splitting code.
    - Set `const isImage = Boolean(currentPhoto.thumbKey);`, replacing the extension check.
    - Use `mediaUrl(currentPhoto.key)` for both `this.image.src` and `this.downloadButton.href`.

- [ ] **Step 5: Replace `src/main.js`.**

```js
import { FamilyTreeView } from './familyTreeView.js';
import { PersonDetails } from './personDetails.js';
import { PersonNotFoundError } from './dataLoader.js';

const DEFAULT_PERSON_ID = 'I122';
const SLOW_LOAD_MS = 300;

function personIdFromUrl() {
  return new URLSearchParams(window.location.search).get('person') || DEFAULT_PERSON_ID;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function initApp() {
  const loadingEl = document.getElementById('loading');
  const treeView = new FamilyTreeView(document.getElementById('cy'));
  const personDetails = new PersonDetails(document.getElementById('details'));

  const overlay = {
    hide() {
      loadingEl.classList.add('hidden');
      loadingEl.classList.remove('interactive');
    },
    loading(text = 'Loading...') {
      loadingEl.textContent = text;
      loadingEl.classList.remove('hidden', 'interactive');
    },
    message(html) {
      loadingEl.innerHTML = html;
      loadingEl.classList.remove('hidden');
      loadingEl.classList.add('interactive');
    }
  };

  let currentRequest = 0;
  let requestedPersonId = null;

  async function showPerson(personId) {
    const request = ++currentRequest;
    const isCurrent = () => request === currentRequest;
    requestedPersonId = personId;
    const slowTimer = setTimeout(() => {
      if (isCurrent() && loadingEl.classList.contains('hidden')) overlay.loading();
    }, SLOW_LOAD_MS);
    try {
      const result = await treeView.loadPerson(personId);
      if (!result || !isCurrent()) return; // superseded by a newer selection
      personDetails.showPerson(result.person, result.relationships);
      overlay.hide();
    } catch (error) {
      if (!isCurrent()) return;
      console.error('Failed to load person', personId, error);
      if (error instanceof PersonNotFoundError) {
        overlay.message(`<p>Person not found.</p><p><a href="?person=${DEFAULT_PERSON_ID}">Go to the start of the tree</a></p>`);
      } else {
        overlay.message(`<p>Couldn't load this person.</p><p class="loading-error-detail">${escapeHtml(error.message)}</p><button type="button" class="loading-retry">Retry</button>`);
        loadingEl.querySelector('.loading-retry').addEventListener('click', () => {
          overlay.loading();
          showPerson(personId);
        });
      }
    } finally {
      clearTimeout(slowTimer);
    }
  }

  treeView.onPersonSelect(personId => {
    if (personId === requestedPersonId) return; // double tap on the person already being shown
    const newUrl = new URL(window.location);
    newUrl.searchParams.set('person', personId);
    window.history.pushState({}, '', newUrl);
    showPerson(personId);
  });

  window.addEventListener('popstate', () => showPerson(personIdFromUrl()));

  overlay.loading('Loading family tree...');
  showPerson(personIdFromUrl());
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}
```

- [ ] **Step 6: Add the overlay styles** to `src/style.css` after the `.loading.hidden` rule:

```css
.loading.interactive {
  pointer-events: auto;
  text-align: center;
  font-size: 18px;
  max-width: min(90vw, 420px);
}

.loading a {
  color: #9dc4ff;
}

.loading-error-detail {
  font-size: 13px;
  opacity: 0.7;
  margin: 8px 0;
}

.loading-retry {
  margin-top: 8px;
  padding: 8px 20px;
  font-size: 16px;
  border: none;
  border-radius: 8px;
  cursor: pointer;
}
```

- [ ] **Step 7: Run the whole test suite.** `npx vitest run`. Expected: all PASS, with the DB tests skipped.
- [ ] **Step 8: Check in the browser.**
  - Start the dev server (`npm run dev`, via the preview tool) and open `http://localhost:5173/ged-eye/?person=I122`.
  - Confirm the graph renders with avatars from the bucket.
  - Click a relative. The Network tab should show at most one `/person/` request, and none if it was prefetched.
  - Open a person's photo and check that the thumbnail and the full image load.
  - Check a non-image file shows the download panel.
  - Check `?person=NOPE` shows "Person not found".
  - With DevTools network throttling at "Slow 3G", click an uncached relative and check the "Loading..." overlay appears and then clears.
  - Go offline, click an uncached relative, and check the "Couldn't load this person." panel with Retry. Go back online and press Retry: the person loads.
  - Check at mobile width (375 px).
  - Check that the console has no errors.
- [ ] **Step 9: Commit.** `git add src public/placeholders && git commit -m "Wire UI to the Neon API and bucket"`

### Task 11: Cleanup, README and build

**Files:** Delete `scripts/processGed.js`; Modify `README.md`; Rebuild `docs/`

- [ ] **Step 1: Retire the old pipeline.**
  - `git rm scripts/processGed.js`.
  - Remove the `generate-avatars` npm script from `package.json`. `scripts/generateAvatars.js` reads `public/data/people` and writes `public/avatars`, so running it would republish avatars in `docs/`. Leave the file itself; the editing phase reworks it.
- [ ] **Step 2: Rewrite the README.** Rewrite the "Features", "Quick Start", "Project Structure", "How it Works" and "Changing the Default Person" sections of `README.md` to describe:
  - Neon setup (`neon link`, `neon deploy`)
  - the four npm scripts and the order to run them
  - the `api/` Function
  - the `db/migrations` folder
  - the `.env.development` / `.env.production` URLs
  - the default person constant in `src/main.js`

  Keep the logo header, the intro and the Tech Stack section, adding Neon to the stack. Remove mentions of `process-ged` and `public/data/people`. In "Testing", mention `npm run test:db`, which needs `DATABASE_URL_TEST` in `.env.test.local`. Say to build with `npm run build` (the `./build` wrapper is not tracked).
- [ ] **Step 3: Move the legacy data out of `public/`.**

```bash
mkdir -p ignore/legacy-data/data
mv public/data/people ignore/legacy-data/data/people
mv public/avatars ignore/legacy-data/avatars
rm -rf public/data
```

`public/data/Media` and `public/data/Picture` are symlinks into `Data/`, so removing them deletes nothing real.

- [ ] **Step 4: Re-verify against the moved baseline.** `npm run verify-neon -- --legacy-root ignore/legacy-data --api-sample 5`. Expected: exit 0.
- [ ] **Step 5: Build.** `npm run build`. Expected:
  - The Vite build succeeds.
  - `docs/` has no `Data`, `data` or `avatars` folders, and does contain `docs/placeholders/`.
  - `du -sh docs` is a few MB.
  - `grep -o "br-green-bonus-b26abimr-api[^\"]*" docs/assets/*.js | head -1` finds the API URL.
- [ ] **Step 6: Preview the production build.** Run `npm run preview` and open `http://localhost:4173/ged-eye/?person=I122`. Repeat the main checks from Task 10 Step 8.
- [ ] **Step 7: Commit.** `git add -A README.md scripts docs package.json && git commit -m "Publish Neon-backed build; remove static data pipeline"`. Check `git status` first: it must not stage `.env.local`, `.neon`, `ignore/` or `.neon-import/`.

### Task 12: Publish

The developer explicitly asked (2026-10-08, before going to bed) for the site to be published once the data is uploaded. So no extra approval checkpoint is needed: proceed only when every earlier verification step has passed.


- [ ] **Step 1: Find how Pages deploys.** `gh api repos/robacourt/ged-eye/pages --jq '{source: .source, url: .html_url}'`. Expected: branch `main`, path `/docs`.
- [ ] **Step 2: Measure cold start.** Wait until the API has had no traffic for 6 or more minutes, then `curl -s -o /dev/null -w "%{time_total}\n" https://br-green-bonus-b26abimr-api.compute.c-6.eu-central-1.aws.neon.tech/person/I122` twice. Record both times.
- [ ] **Step 3: Push and open a PR.** `git push -u origin neon-backend`, then `gh pr create`. The title is "Serve the family tree from Neon". The body summarises:
  - the changes
  - the verify output
  - the cold and warm timings
  - the rollback plan (revert the merge commit)
  - the follow-ups: move `preview.buckets` to `buckets`, and revoke the MCP-minted API key if it's unwanted
- [ ] **Step 4: Merge.** `gh pr merge --merge --delete-branch=false`. Use a merge commit so it can be reverted in one step.
- [ ] **Step 5: Wait for the Pages build.** Poll `gh api repos/robacourt/ged-eye/pages/builds/latest --jq .status` until it reads `built`.
- [ ] **Step 6: Check the live site.** Open `https://robacourt.github.io/ged-eye/?person=I122` in the browser.
  - Confirm the graph, avatars and details render.
  - Confirm the Network tab shows requests to the Function and the bucket, and none to `Data/` or `data/people`.
  - Click two relatives.
  - Open one photo.
