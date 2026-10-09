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
