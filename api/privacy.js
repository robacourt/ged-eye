/**
 * Note text in the GEDCOM includes pasted email threads. The stored facts keep it verbatim
 * (Neon is the master copy); the public API never serves the addresses.
 */
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
export const EMAIL_MASK = '[email hidden]';

const isNoteKey = (key) => key === 'notes' || key.endsWith('Notes');

function mapDeep(value, mapString) {
  if (typeof value === 'string') return mapString(value);
  if (Array.isArray(value)) return value.map(item => mapDeep(item, mapString));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapDeep(item, mapString)]));
  }
  return value;
}

function maskInNotes(value) {
  if (Array.isArray(value)) return value.map(maskInNotes);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      isNoteKey(key) ? mapDeep(item, s => s.replace(EMAIL, EMAIL_MASK)) : maskInNotes(item)]));
  }
  return value;
}

/** A copy of a person_view() document with email addresses in view.person's note text masked. */
export function maskNoteEmails(view) {
  if (!view?.person) return view;
  return { ...view, person: maskInNotes(view.person) };
}
