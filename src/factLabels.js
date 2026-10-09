/**
 * Display labels for person.facts.otherFacts entries, keyed by GEDCOM tag (Brother's Keeper's
 * own tags start with an underscore). A Map, not an object, so a tag like "constructor" or "__proto__"
 * is never mistaken for a known label (and no Object.hasOwn, which Safari 15.0 lacks).
 */
const LABELS = new Map(Object.entries({
  EVEN: 'Event', _MILT: 'Military service', PROB: 'Probate', EMIG: 'Emigration', IMMI: 'Immigration',
  CHR: 'Christening', CREM: 'Cremation', WILL: 'Will', DSCR: 'Description', NCHI: 'Number of children',
  EDUC: 'Education', RELI: 'Religion', _HEIG: 'Height', _WEIG: 'Weight', _EYEC: 'Eye colour',
  _HAIR: 'Hair colour', _MEDC: 'Medical condition', _INTE: 'Interment', _ADPF: 'Adopted by father',
  _ADPM: 'Adopted by mother', _BRTM: 'Brit milah', _MEMR: 'Memorial', _NMAR: 'Never married',
  BIRT: 'Birth', BAPM: 'Baptism', DEAT: 'Death', BURI: 'Burial'
}));

export function factLabel(fact) {
  if (fact.tag === 'EVEN' && fact.type) return fact.type;
  const known = LABELS.get(fact.tag);
  if (known) return known;
  const bare = String(fact.tag ?? '').replace(/^_/, '');
  return bare ? bare.charAt(0).toUpperCase() + bare.slice(1).toLowerCase() : 'Other';
}

/** The tags with a known label, for picking one in the person editor. */
export const KNOWN_FACT_TAGS = Object.freeze([...LABELS.keys()]);
