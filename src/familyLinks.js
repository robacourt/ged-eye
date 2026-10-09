/**
 * Pure helpers about the selected person's links, shared by the details panel's edit controls, the relative
 * dialog and the unlink confirmation. `person` is a person record (person view `person`), `relationships` the
 * loader's `{ parents, spouses, children, siblings }` of relatives `{ id, name, sex, parentIds, ... }`.
 */

export const UNNAMED = 'Unnamed person';

/** A person's or relative's name, or "Unnamed person". */
export function nameOf(someone) {
  return String(someone?.name ?? '').trim() || UNNAMED;
}

/** "A", "A and B", "A, B and C" (every name, for confirmations). */
export function listNames(names) {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The relative with `id` among the person's parents, spouses, children and siblings, or null. */
export function relativeById(relationships, id) {
  if (!id) return null;
  for (const group of ['parents', 'spouses', 'children', 'siblings']) {
    const found = (relationships?.[group] ?? []).find(relative => relative.id === id);
    if (found) return found;
  }
  return null;
}

/** The name of `id`: the person themselves, or one of their relatives. */
export function nameById(person, relationships, id) {
  return nameOf(id === person?.id ? person : relativeById(relationships, id));
}

/**
 * Which of the person's own families (`marriages`) `child` is in. The view doesn't say, so it is worked out
 * from the child's `parentIds`: the family with a spouse who is also the child's parent, else the person's
 * family without a spouse, else their only family. Null when it can't be told.
 */
export function familyOfChild(person, child) {
  const marriages = person?.marriages ?? [];
  const parentIds = child?.parentIds ?? [];
  const withSpouse = marriages.find(marriage => marriage.spouseId && parentIds.includes(marriage.spouseId));
  if (withSpouse) return withSpouse.familyId;
  const alone = marriages.find(marriage => !marriage.spouseId);
  if (alone) return alone.familyId;
  return marriages.length === 1 ? marriages[0].familyId : null;
}

/** The person's children who are in their family `familyId`. */
export function childrenInFamily(person, relationships, familyId) {
  return (relationships?.children ?? []).filter(child => familyOfChild(person, child) === familyId);
}

const parentFamiliesOf = (person) => person?.parentFamilies ?? [];

/**
 * Why "+ Parent" or "+ Sibling" can't be used for this person, or null when it can:
 * a sibling needs a parent family (with a parent in it); a parent needs a parent family with a free slot,
 * unless there is none yet (then a new family is made).
 */
export function relativeBlocked(person, relation) {
  const families = parentFamiliesOf(person);
  if (relation === 'sibling' && !families.some(family => (family.partnerIds ?? []).length > 0)) {
    return 'Add a parent first';
  }
  if (relation === 'parent' && families.length > 0 && families.every(family => (family.partnerIds ?? []).length >= 2)) {
    return 'Already has two parents';
  }
  return null;
}
