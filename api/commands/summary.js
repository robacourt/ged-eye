/** Words for change summaries ("Added Rose Smith as a daughter of Tom Smith"). */

export const UNNAMED = 'Unnamed person';

/** A person row's display name, or "Unnamed person" when it is empty. */
export function nameOf(person) {
  return (person?.display_name ?? '').trim() || UNNAMED;
}

// What B is to A, by B's sex where known.
const RELATION_WORDS = {
  parent: { F: 'the mother', M: 'the father', other: 'a parent' },
  child: { F: 'a daughter', M: 'a son', other: 'a child' },
  spouse: { F: 'the wife', M: 'the husband', other: 'the spouse' },
  sibling: { F: 'a sister', M: 'a brother', other: 'a sibling' }
};

/** "the mother", "a son", "the spouse", ... for `relation` ('parent' | 'child' | 'spouse' | 'sibling'). */
export function relationPhrase(relation, sex) {
  const words = RELATION_WORDS[relation];
  return sex === 'F' || sex === 'M' ? words[sex] : words.other;
}

/** "A", "A and B", "A, B and C", or "A, B and 2 others" beyond three. */
export function listNames(names) {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length > 3) return `${names.slice(0, 2).join(', ')} and ${names.length - 2} others`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** Lower-case labels for person and family columns. */
export const FIELD_LABELS = {
  given_name: 'given name',
  surname: 'surname',
  sex: 'sex',
  birth_date: 'birth date',
  birth_place: 'birth place',
  death_date: 'death date',
  death_place: 'death place',
  baptism_date: 'baptism date',
  baptism_place: 'baptism place',
  burial_date: 'burial date',
  burial_place: 'burial place',
  marriage_date: 'marriage date',
  marriage_place: 'marriage place',
  divorce_date: 'divorce date',
  divorce_place: 'divorce place'
};

/** Lower-case labels for person.facts keys, in summary order (full-facts model, then its predecessor's extras). */
export const FACT_LABELS = {
  notes: 'notes',
  occupations: 'occupations',
  censusRecords: 'census records',
  residences: 'residences',
  birthNotes: 'birth notes',
  baptismNotes: 'baptism notes',
  deathNotes: 'death notes',
  burialNotes: 'burial notes',
  causeOfDeath: 'cause of death',
  otherFacts: 'other facts',
  email: 'email',
  phone: 'phone',
  religion: 'religion',
  education: 'education'
};

/** Capitalises a label for the start of a validation message ("Birth place must be ..."). */
export const capitalise = (text) => text.charAt(0).toUpperCase() + text.slice(1);
