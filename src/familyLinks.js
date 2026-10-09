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

/** Whether every one of the person's families lists its children (person views since migration 007). */
const listsChildren = (marriages) => marriages.length > 0 && marriages.every(marriage => Array.isArray(marriage.childIds));

/**
 * Without `childIds` (an older view), whether `marriage` could hold `child`: a family with a spouse only
 * holds children who have that spouse as a parent; one without a spouse could hold any of the person's.
 */
const couldHold = (marriage, child) =>
  !marriage.spouseId || !Array.isArray(child.parentIds) || child.parentIds.includes(marriage.spouseId);

/**
 * Which of the person's own families (`marriages`) `child` is in, from each family's `childIds`. An older
 * view without them is answered only when exactly one family could hold the child. Null when it can't be
 * told (or the child is in several of them): the caller must not guess a family to unlink.
 */
export function familyOfChild(person, child) {
  const marriages = person?.marriages ?? [];
  if (!child?.id) return null;
  const candidates = listsChildren(marriages)
    ? marriages.filter(marriage => marriage.childIds.includes(child.id))
    : marriages.filter(marriage => couldHold(marriage, child));
  return candidates.length === 1 ? candidates[0].familyId : null;
}

/**
 * The children in the person's family `familyId`, in order, as relatives (`{ id, name }` for one not among
 * `relationships`). Null when an older view can't tell; [] for an unknown family.
 */
export function childrenInFamily(person, relationships, familyId) {
  const marriage = (person?.marriages ?? []).find(candidate => candidate.familyId === familyId);
  if (!marriage) return [];
  if (Array.isArray(marriage.childIds)) {
    return marriage.childIds.map(id => relativeById(relationships, id) ?? { id, name: '' });
  }
  const children = relationships?.children ?? [];
  if (children.some(child => familyOfChild(person, child) === null)) return null;
  return children.filter(child => familyOfChild(person, child) === familyId);
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
