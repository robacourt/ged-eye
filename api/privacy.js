/**
 * Note text in the GEDCOM includes pasted email threads. The stored facts keep it verbatim
 * (Neon is the master copy); the public API never serves addresses found in note text, or in
 * photo captions, which editors write and may paste into the same way.
 */
// Bounded to the RFC length limits (local part 64, domain 253, TLD 63) so a long run of address
// characters cannot make the match quadratic. Unicode letters/digits cover internationalised addresses.
// `@@?` also catches the GEDCOM-escaped form, in case a stored value was never decoded.
const EMAIL = /[\p{L}\p{M}\p{N}._%+-]{1,64}@@?[\p{L}\p{M}\p{N}.-]{1,253}\.\p{L}{2,63}/gu;
export const EMAIL_MASK = '[email hidden]';

const isNoteKey = (key) => key === 'notes' || key.endsWith('Notes') || key === 'caption';

/** Copies `value`, masking addresses in every string under a note key (`inNote` once inside one). */
function mask(value, inNote = false) {
  if (typeof value === 'string') return inNote ? value.replace(EMAIL, EMAIL_MASK) : value;
  if (Array.isArray(value)) return value.map(item => mask(item, inNote));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mask(item, inNote || isNoteKey(key))]));
  }
  return value;
}

/** A copy of a person_view() document with email addresses in note text and captions, anywhere in the view, masked. */
export function maskNoteEmails(view) {
  return view ? mask(view) : view;
}

/*
 * Living people (migration 010 puts a `living` flag on every record in a view) are shown to the public by name
 * only. Redacted records are built from whitelists, so a field added later stays hidden until it is listed
 * here. Anything not flagged `living: false` counts as living: a missing flag fails closed.
 */
const isLiving = (record) => record?.living !== false;

/** What the public sees of a living person's own record, besides `private: true` and an empty photo row. */
const LIVING_PERSON_KEYS = ['id', 'name', 'givenName', 'surname', 'sex', 'parentIds', 'spouseIds', 'childIds', 'parentFamilies'];
/** What the public sees of a living relative in `view.family`. */
const LIVING_RELATIVE_KEYS = ['id', 'name', 'sex', 'parentIds'];
/** What the public sees of a marriage involving a living person: who, and the children, never when or where. */
const PRIVATE_MARRIAGE_KEYS = ['spouseId', 'familyId', 'childIds'];
/** Editors' own fields, never served to the public. */
const EDITOR_ONLY_KEYS = ['livingEstimate', 'livingOverride'];

const pick = (record, keys) => Object.fromEntries(keys.filter((key) => key in record).map((key) => [key, record[key]]));
const omit = (record, keys) => Object.fromEntries(Object.entries(record).filter(([key]) => !keys.includes(key)));
const privateMarriage = (marriage) => pick(marriage, PRIVATE_MARRIAGE_KEYS);
// A photo with no people list can't be shown to be free of living people.
const showsLiving = (photo) => !Array.isArray(photo?.people) || photo.people.some(isLiving);

function redactPerson(person, family) {
  if (!person) return person;
  if (isLiving(person)) {
    const record = { ...pick(person, LIVING_PERSON_KEYS), photos: [], avatarKey: null, living: true, private: true };
    if (Array.isArray(person.marriages)) record.marriages = person.marriages.map(privateMarriage);
    return record;
  }
  const record = omit(person, EDITOR_ONLY_KEYS);
  if (Array.isArray(person.photos)) record.photos = person.photos.filter((photo) => !showsLiving(photo));
  if (Array.isArray(person.marriages)) {
    // A spouse not in the view can't be shown to be deceased.
    const deceased = new Set(family.filter((relative) => !isLiving(relative)).map((relative) => relative.id));
    record.marriages = person.marriages.map((marriage) =>
      (marriage.spouseId == null || deceased.has(marriage.spouseId) ? marriage : privateMarriage(marriage)));
  }
  return record;
}

const redactRelative = (relative) => (isLiving(relative)
  ? { ...pick(relative, LIVING_RELATIVE_KEYS), avatarKey: null, living: true, private: true }
  : relative);

/**
 * A copy of a person_view() document for the public: living people keep their names and relationships, and lose
 * everything else (dates, places, notes, facts, photos, avatars); photos showing a living person are dropped from
 * every record; and a deceased person's marriage to a living (or unknown) spouse loses its dates and places.
 */
export function redactLiving(view) {
  if (!view) return view;
  const family = Array.isArray(view.family) ? view.family : [];
  return { ...view, person: redactPerson(view.person, family), family: family.map(redactRelative) };
}

/** A search result ({ id, name, birthYear, deathYear, living }) for the public: a living person's years hidden. */
export function redactSearchResult(result) {
  return isLiving(result) ? { id: result.id, name: result.name, birthYear: null, deathYear: null, living: true } : result;
}
