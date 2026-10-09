import { extractPersonData } from '../gedParser.js';

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

const SEXES = new Set(['M', 'F', 'U']);

/**
 * Pure transform from a parsed GEDCOM to table rows.
 * @param parsedGed result of parseGedcom()
 * @param manifest  { files: { [originalPath]: {sha256, objectKey, thumbKey, contentType, byteSize, fileName} }, avatars: { [avatarPath]: objectKey } }
 * @param avatarMap Map<personId, avatarPath>
 * @param extract  person extractor; the parity test passes the legacy parser's
 */
export function gedToRows(parsedGed, manifest, avatarMap, extract = extractPersonData) {
  const warnings = [];
  const people = [];
  const personMedia = [];
  const mediaBySha = new Map();
  const individuals = parsedGed.individuals;

  for (const [id] of individuals) {
    const p = extract(parsedGed, id);
    const facts = personFacts(p);

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
