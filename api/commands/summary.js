/** Words for change summaries ("Added Rose Smith as a daughter of Tom Smith"). */

export const UNNAMED = 'Unnamed person';

/** A person row's display name, or "Unnamed person" when it is empty. */
export function nameOf(person) {
  return (person?.display_name ?? '').trim() || UNNAMED;
}

// What B is to A, by B's sex where known, and the article a summary uses with it.
const RELATION_WORDS = {
  parent: { F: 'mother', M: 'father', other: 'parent', article: 'a' },
  child: { F: 'daughter', M: 'son', other: 'child', article: 'a' },
  spouse: { F: 'wife', M: 'husband', other: 'spouse', article: 'the' },
  sibling: { F: 'sister', M: 'brother', other: 'sibling', article: 'a' }
};

/** "mother", "son", "spouse", ... for `relation` ('parent' | 'child' | 'spouse' | 'sibling'). */
export function relationWord(relation, sex) {
  const words = RELATION_WORDS[relation];
  return sex === 'F' || sex === 'M' ? words[sex] : words.other;
}

/** "the mother", "a son", "the spouse", ...: a parent or spouse of known sex takes "the". */
export function relationPhrase(relation, sex) {
  const known = sex === 'F' || sex === 'M';
  const article = relation === 'parent' && known ? 'the' : RELATION_WORDS[relation].article;
  return `${article} ${relationWord(relation, sex)}`;
}

/** "his", "her" or "their", by sex. */
export function possessive(sex) {
  return sex === 'M' ? 'his' : sex === 'F' ? 'her' : 'their';
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
