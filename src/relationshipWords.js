/**
 * How one person is related to another, in words, from the path GET /relationship gives (the search page; spec:
 * specs/2026-10-18-relationship-search-design.md): "Clement Bernard A'Court is Robert Michael A'Court's
 * grandfather." Pure, so it can be tested on its own.
 *
 * A path is `[{ name, sex, step }]` from the relative to the person, each `step` how that person is related to the
 * one before: 'parent', 'child', 'sibling', 'halfSibling' or 'spouse' (null for the first).
 */
import { nameOf } from './familyLinks.js';

const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];

/** "first" … "tenth", then "11th", "12th", "21st"… */
function ordinal(n) {
  if (n <= ORDINALS.length) return ORDINALS[n - 1];
  const teen = n % 100 >= 11 && n % 100 <= 13;
  const suffix = teen ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' })[n % 10] ?? 'th';
  return `${n}${suffix}`;
}

const removed = (n) => (n === 1 ? 'once removed' : n === 2 ? 'twice removed' : `${n} times removed`);

/** The word for someone of sex `sex`: `male` for M, `female` for F, `neutral` otherwise. */
const bySex = (sex, male, female, neutral) => (sex === 'M' ? male : sex === 'F' ? female : neutral);

/** "", "great-", "great-great-", then "3× great-"… */
const greats = (n) => (n <= 0 ? '' : n <= 2 ? 'great-'.repeat(n) : `${n}× great-`);

/**
 * The name of a blood relation `up` generations up to the nearest common ancestor and `down` back down (a
 * brother or sister is one of each), for a person of sex `sex`; `half` for one through a half-brother or sister.
 * → the word, or null for the person themselves
 */
export function bloodTerm(up, down, sex, half = false) {
  const h = half ? 'half-' : '';
  if (up === 0 && down === 0) return null;
  if (down === 0) {
    const parent = bySex(sex, 'father', 'mother', 'parent');
    return up === 1 ? parent : `${greats(up - 2)}grand${parent}`;
  }
  if (up === 0) {
    const child = bySex(sex, 'son', 'daughter', 'child');
    return down === 1 ? child : `${greats(down - 2)}grand${child}`;
  }
  if (up === 1 && down === 1) return h + bySex(sex, 'brother', 'sister', 'sibling');
  if (up === 1) {
    const prefix = h + (down === 2 ? '' : `${greats(down - 3)}grand`);
    return bySex(sex, `${prefix}nephew`, `${prefix}niece`, `${prefix}niece or ${prefix}nephew`);
  }
  if (down === 1) {
    const prefix = h + greats(up - 2);
    return bySex(sex, `${prefix}uncle`, `${prefix}aunt`, `${prefix}aunt or ${prefix}uncle`);
  }
  const degree = Math.min(up, down) - 1;
  const apart = Math.abs(up - down);
  return `${h}${ordinal(degree)} cousin${apart ? ` ${removed(apart)}` : ''}`;
}

/** One step's own word, for a path no other name fits: "mother", "husband", "half-brother"… */
function stepNoun(step, sex) {
  switch (step) {
    case 'parent': return bySex(sex, 'father', 'mother', 'parent');
    case 'child': return bySex(sex, 'son', 'daughter', 'child');
    case 'sibling': return bySex(sex, 'brother', 'sister', 'sibling');
    case 'halfSibling': return bySex(sex, 'half-brother', 'half-sister', 'half-sibling');
    default: return bySex(sex, 'husband', 'wife', 'spouse');
  }
}

/** In-laws and step-relations, by the steps of the whole path. */
const NAMED = {
  'spouse,parent': (sex) => bySex(sex, 'father-in-law', 'mother-in-law', 'parent-in-law'),
  'spouse,sibling': (sex) => bySex(sex, 'brother-in-law', 'sister-in-law', 'sibling-in-law'),
  'sibling,spouse': (sex) => bySex(sex, 'brother-in-law', 'sister-in-law', 'sibling-in-law'),
  'child,spouse': (sex) => bySex(sex, 'son-in-law', 'daughter-in-law', 'child-in-law'),
  'parent,spouse': (sex) => bySex(sex, 'stepfather', 'stepmother', 'step-parent'),
  'spouse,child': (sex) => bySex(sex, 'stepson', 'stepdaughter', 'stepchild')
};

/** A stretch of blood relation of the shape parent* (sibling | halfSibling)? child* → { up, down, half }, else null. */
function shapeOf(steps) {
  const text = steps.join(' ');
  if (!/^(parent ?)*((sibling|halfSibling) ?)?(child ?)*$/.test(text)) return null;
  const across = steps.some(step => step === 'sibling' || step === 'halfSibling') ? 1 : 0;
  return {
    up: steps.filter(step => step === 'parent').length + across,
    down: steps.filter(step => step === 'child').length + across,
    half: steps.includes('halfSibling')
  };
}

/**
 * What the last person on `path` is to the first: "grandfather", "first cousin once removed", "father-in-law",
 * "wife's first cousin", "mother's husband's son". → the words, or null for the same person
 */
export function relationTerm(path) {
  const people = path.slice(1);
  if (!people.length) return null;
  const last = people[people.length - 1];
  const named = NAMED[people.map(person => person.step).join(',')];
  if (named) return named(last.sex);

  // Stretches of blood relation, named as one, with each marriage between them: "wife's first cousin".
  const words = [];
  let stretch = [];
  const flush = () => {
    if (!stretch.length) return;
    const shape = shapeOf(stretch.map(person => person.step));
    const end = stretch[stretch.length - 1];
    if (shape) words.push(bloodTerm(shape.up, shape.down, end.sex, shape.half));
    else words.push(...stretch.map(person => stepNoun(person.step, person.sex)));
    stretch = [];
  };
  for (const person of people) {
    if (person.step === 'spouse') {
      flush();
      words.push(stepNoun('spouse', person.sex));
    } else {
      stretch.push(person);
    }
  }
  flush();
  return words.join("'s ");
}

/**
 * The sentence for the search page: "Clement Bernard A'Court is Robert Michael A'Court's grandfather." → text
 * (null for an empty path)
 */
export function describeRelationship(path) {
  if (!path?.length) return null;
  const relative = nameOf(path[0]);
  const term = relationTerm(path);
  if (term === null) return `That's ${relative}.`;
  return `${nameOf(path[path.length - 1])} is ${relative}'s ${term}.`;
}
