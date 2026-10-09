/**
 * Note text in the GEDCOM includes pasted email threads. The stored facts keep it verbatim
 * (Neon is the master copy); the public API never serves addresses found in note text.
 */
// Bounded to the RFC length limits (local part 64, domain 253, TLD 63) so a long run of address
// characters cannot make the match quadratic. Unicode letters/digits cover internationalised addresses.
const EMAIL = /[\p{L}\p{N}._%+-]{1,64}@[\p{L}\p{N}.-]{1,253}\.[\p{L}]{2,63}/gu;
export const EMAIL_MASK = '[email hidden]';

const isNoteKey = (key) => key === 'notes' || key.endsWith('Notes');

/** Copies `value`, masking addresses in every string under a note key (`inNote` once inside one). */
function mask(value, inNote = false) {
  if (typeof value === 'string') return inNote ? value.replace(EMAIL, EMAIL_MASK) : value;
  if (Array.isArray(value)) return value.map(item => mask(item, inNote));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mask(item, inNote || isNoteKey(key))]));
  }
  return value;
}

/** A copy of a person_view() document with email addresses in note text, anywhere in the view, masked. */
export function maskNoteEmails(view) {
  return view ? mask(view) : view;
}
