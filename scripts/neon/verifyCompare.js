import { maskNoteEmails } from '../../api/privacy.js';

// notes, occupations, censusRecords, residences, religion and education are left out: since the
// 2026-10 facts backfill they are re-derived from gedcom_archive by the full parser and checked by
// backfill-facts itself, so the old-parser JSON is no longer their baseline.
const SCALAR_KEYS = ['id', 'name', 'givenName', 'surname', 'sex', 'birthDate', 'birthPlace', 'deathDate', 'deathPlace',
  'baptismDate', 'baptismPlace', 'burialDate', 'burialPlace', 'email', 'phone'];

/** Prefix of the one difference line that import warnings can explain (the photo sha list). */
export const PHOTOS_DIFF_PREFIX = 'photos: ';
/** Import warning types that justify a PHOTOS_DIFF_PREFIX difference, and nothing else. */
const PHOTO_WARNINGS = ['missing_media', 'duplicate_media'];

/** Arrays whose order is compared once their members are known to match. */
export const ORDER_FIELDS = ['parents', 'spouses', 'children', 'siblings', 'person.parentIds', 'person.spouseIds', 'person.childIds'];
const LEGACY_ID_ARRAYS = ['parentIds', 'spouseIds', 'childIds'];

// Same list as the old UI's isImageFile() (git show 9a0655a:src/personDetails.js).
const LEGACY_IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg'];

export const canonical = (value) => JSON.stringify(value, (_, v) =>
  v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);

/** Whether an API body is what the Function should serve for this person_view() document. */
export function apiMatchesView(body, view) {
  return canonical(body) === canonical(maskNoteEmails(view));
}

const unique = (items) => [...new Set(items)];
const duplicatesIn = (items) => unique(items.filter((item, i) => items.indexOf(item) !== i));
const naturalCompare = (a, b) => String(a).localeCompare(String(b), 'en', { numeric: true });

/** Fisher-Yates shuffle. Returns a new array; `random` is injectable for tests. */
export function shuffled(items, random = Math.random) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** The old UI's image test, verbatim: decided from the legacy path's extension only. */
export function legacyIsImage(filePath) {
  const extension = filePath.toLowerCase().substring(filePath.lastIndexOf('.'));
  return LEGACY_IMAGE_EXTENSIONS.includes(extension);
}

/** What the legacy loadPersonWithFamily() would show for `id`, from the legacy JSON files. */
export function legacyExpected(people, id) {
  const person = people.get(id);
  const known = (pid) => people.has(pid);
  // The old loader collected ids in Sets, so its relationship lists never repeat an id.
  const parentIds = unique(person.parentIds);
  const parents = parentIds.filter(known);
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
      spouses: unique(person.spouseIds).filter(known),
      children: unique(person.childIds).filter(known),
      siblings
    },
    familyIds
  };
}

const photoSha = (photo) => /^originals\/([0-9a-f]{64})/.exec(photo.key)?.[1] ?? photo.key;

/**
 * The photos the old UI listed for a person, collapsed the way the importer collapses them:
 * one entry per distinct sha256, first path wins. A path the manifest lacks gets a `missing:` sha.
 */
function legacyPhotos(person, manifest) {
  const seen = new Set();
  const out = [];
  for (const path of person.photos) {
    const file = manifest.files[path] ?? null;
    const sha = file ? file.sha256 : `missing:${path}`;
    if (seen.has(sha)) continue;
    seen.add(sha);
    out.push({ path, sha, file });
  }
  return out;
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
    // Legacy duplicates are an intended fix (reported as notes); the new data must not repeat an id.
    const repeated = duplicatesIn([...b]);
    if (repeated.length) diffs.push(`${label}: duplicate ids in actual [${repeated.sort()}]`);
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

  const expectedPhotos = legacyPhotos(p, manifest);
  const expectedShas = expectedPhotos.map(e => e.sha);
  const actualShas = q.photos.map(photoSha);
  if (canonical(expectedShas) !== canonical(actualShas)) {
    diffs.push(`${PHOTOS_DIFF_PREFIX}expected ${canonical(expectedShas)} got ${canonical(actualShas)}`);
  }
  // Per-photo metadata, matched by sha so one missing/reordered photo does not mask the rest.
  // A sha with no legacy counterpart was already reported above.
  const expectedBySha = new Map(expectedPhotos.map(e => [e.sha, e]));
  q.photos.forEach((photo, i) => {
    const file = expectedBySha.get(actualShas[i])?.file;
    if (!file) return;
    for (const key of ['fileName', 'contentType']) {
      if ((photo[key] ?? null) !== (file[key] ?? null)) {
        diffs.push(`photo[${i}].${key}: expected ${canonical(file[key] ?? null)} got ${canonical(photo[key] ?? null)}`);
      }
    }
  });

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

/**
 * Split diffView() output into what import warnings explain and what they do not.
 * Only the photo sha-list difference can be explained, and only by a missing_media or
 * duplicate_media warning for that person; every other line is unexplained whatever the warnings.
 * @param {string[]} diffs
 * @param {Set<string>|undefined} warningTypes import warning types recorded for the person
 */
export function splitDiffs(diffs, warningTypes) {
  const mayExplain = PHOTO_WARNINGS.some(type => warningTypes?.has(type));
  const explained = [];
  const unexplained = [];
  for (const diff of diffs) {
    (mayExplain && diff.startsWith(PHOTOS_DIFF_PREFIX) ? explained : unexplained).push(diff);
  }
  return { explained, unexplained };
}

/**
 * Intended changes for one person: things that differ from the legacy view on purpose.
 * Informational only; never part of the pass/fail result.
 * @returns {{duplicates: {field: string, ids: string[]}[], order: string[], images: {fileName: string, oldImage: boolean, newImage: boolean}[]}}
 */
export function noteView(expected, actual, manifest) {
  const notes = { duplicates: [], order: [], images: [] };
  const p = expected.person;

  for (const field of LEGACY_ID_ARRAYS) {
    const ids = duplicatesIn(p[field]);
    if (ids.length) notes.duplicates.push({ field, ids });
  }
  if (!actual) return notes;

  // Order only counts when the members already match (after legacy de-dup); anything else is a failure in diffView.
  const orderOnly = (label, legacyList, actualList) => {
    const want = unique(legacyList);
    const sameMembers = want.length === actualList.length && want.every(x => actualList.includes(x));
    if (sameMembers && want.some((x, i) => x !== actualList[i])) notes.order.push(label);
  };
  for (const key of ['parents', 'spouses', 'children', 'siblings']) {
    orderOnly(key, expected.relationships[key], actual.relationships[key]);
  }
  for (const key of LEGACY_ID_ARRAYS) orderOnly(`person.${key}`, p[key], actual.person[key]);

  const expectedBySha = new Map(legacyPhotos(p, manifest).map(e => [e.sha, e]));
  for (const photo of actual.person.photos) {
    const legacy = expectedBySha.get(photoSha(photo));
    if (!legacy) continue;
    const oldImage = legacyIsImage(legacy.path);
    const newImage = Boolean(photo.thumbKey);
    if (oldImage !== newImage) notes.images.push({ fileName: photo.fileName, oldImage, newImage });
  }
  return notes;
}

/** Accumulator for noteView() results across all people. */
export function createNotes() {
  return {
    duplicates: [], // { id, field, ids }
    order: Object.fromEntries(ORDER_FIELDS.map(field => [field, []])), // person ids
    images: [] // { id, fileName, oldImage, newImage }
  };
}

export function collectNotes(total, id, personNotes) {
  for (const d of personNotes.duplicates) total.duplicates.push({ id, ...d });
  for (const field of personNotes.order) total.order[field].push(id);
  for (const image of personNotes.images) total.images.push({ id, ...image });
}

/** Counts only, for the one-line summary JSON. */
export function summarizeNotes(total) {
  return {
    duplicatesRemoved: total.duplicates.length,
    orderDifferences: Object.fromEntries(ORDER_FIELDS.map(field => [field, total.order[field].length])),
    imageClassificationChanges: {
      photos: total.images.length,
      files: new Set(total.images.map(i => i.fileName)).size
    }
  };
}

/** Human-readable notes section (stable order, so runs diff cleanly). */
export function formatNotes(total, maxExamples = 10) {
  const sortedIds = (ids) => [...ids].sort(naturalCompare);
  const lines = ['Notes (informational; never affect the exit code)'];

  const dupes = [...total.duplicates].sort((a, b) => naturalCompare(a.id, b.id) || a.field.localeCompare(b.field));
  lines.push(`  duplicates removed: ${dupes.length} legacy array(s) on ${new Set(dupes.map(d => d.id)).size} people`);
  for (const d of dupes) lines.push(`    ${d.id}.${d.field}: repeated ${d.ids.join(', ')}`);

  lines.push('  order differences (same members, different order):');
  for (const field of ORDER_FIELDS) {
    const ids = sortedIds(total.order[field]);
    const more = ids.length > maxExamples ? ', ...' : '';
    lines.push(`    ${field}: ${ids.length}${ids.length ? ` (e.g. ${ids.slice(0, maxExamples).join(', ')}${more})` : ''}`);
  }

  const files = new Map();
  for (const image of total.images) {
    const key = `${image.fileName}\u0000${image.oldImage}\u0000${image.newImage}`;
    files.set(key, { ...image, photos: (files.get(key)?.photos ?? 0) + 1 });
  }
  const changed = [...files.values()].sort((a, b) => String(a.fileName).localeCompare(String(b.fileName)));
  lines.push(`  image classification changes: ${total.images.length} photo(s), ${changed.length} file name(s)`);
  for (const c of changed) {
    lines.push(`    ${c.fileName}: ${c.oldImage ? 'image' : 'file'} -> ${c.newImage ? 'image' : 'file'} (${c.photos} photo(s))`);
  }
  return lines;
}
