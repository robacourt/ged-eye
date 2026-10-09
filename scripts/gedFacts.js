/**
 * The person.facts fields for one INDI node (see specs/2026-10-09-gedcom-full-facts-design.md).
 */
import { lastChild, text } from './gedTree.js';

/** Level-1 INDI tags read elsewhere (columns, photos, relationships) or by the dedicated facts below. */
const HANDLED = new Set(['NAME', 'SEX', 'BIRT', 'BAPM', 'DEAT', 'BURI', 'CENS', 'RESI', 'OCCU', 'NOTE', 'OBJE', 'FAMS', 'FAMC', 'EMAIL', 'PHON']);
/** Level-1 INDI tags deliberately not surfaced: change stamps, sources (a later phase), BK reference numbers, associations. */
const IGNORED = new Set(['CHAN', 'SOUR', 'REFN', 'ASSO']);
const LIFE_EVENT_NOTES = new Map([['BIRT', 'birthNotes'], ['BAPM', 'baptismNotes'], ['DEAT', 'deathNotes'], ['BURI', 'burialNotes']]);

// Brother's Keeper stored Windows-1252 punctuation as C1 code points (U+0091-U+0097): quotes, bullet, dashes.
const CP1252_PUNCTUATION = new Map([['\u0091', '\u2018'], ['\u0092', '\u2019'], ['\u0093', '\u201C'], ['\u0094', '\u201D'],
  ['\u0095', '\u2022'], ['\u0096', '\u2013'], ['\u0097', '\u2014']]);
const C1_PUNCTUATION = /[\u0091-\u0097]/g;

/** A node's own notes (not those on its source citations), verbatim apart from trailing whitespace and C1 punctuation. */
function noteTexts(node) {
  return node.children.filter(child => child.tag === 'NOTE')
    .map(note => note.value.trimEnd().replace(C1_PUNCTUATION, char => CP1252_PUNCTUATION.get(char)))
    .filter(Boolean);
}

/** {value?, date?, place?, notes?} for one fact node; each key only when non-empty. */
function factOf(node) {
  const fact = {};
  const value = text(node);
  const date = lastChild(node, 'DATE');
  const place = lastChild(node, 'PLAC');
  const notes = noteTexts(node);
  if (value) fact.value = value;
  if (date && text(date)) fact.date = text(date);
  if (place && text(place)) fact.place = text(place);
  if (notes.length) fact.notes = notes;
  return fact;
}

function otherFact(node) {
  const entry = { tag: node.tag };
  const type = lastChild(node, 'TYPE');
  const cause = lastChild(node, 'CAUS');
  if (type && text(type)) entry.type = text(type);
  if (cause && text(cause)) entry.cause = text(cause);
  return Object.assign(entry, factOf(node));
}

/**
 * Keys appear only when non-empty: notes, occupations, censusRecords, residences, birthNotes,
 * baptismNotes, deathNotes, burialNotes, causeOfDeath, otherFacts.
 */
export function individualFacts(indi) {
  const occupations = [];
  const censusRecords = [];
  const residences = [];
  const otherFacts = [];
  const lastLifeEvent = new Map();
  for (const child of indi.children) {
    if (LIFE_EVENT_NOTES.has(child.tag)) lastLifeEvent.set(child.tag, child);
  }

  for (const child of indi.children) {
    const { tag } = child;
    if (tag === 'OCCU') {
      const fact = factOf(child);
      if (Object.keys(fact).length) occupations.push(fact);
    } else if (tag === 'CENS' || tag === 'RESI') {
      const fact = factOf(child);
      if (fact.date || fact.place || fact.notes) (tag === 'CENS' ? censusRecords : residences).push(fact);
    } else if (LIFE_EVENT_NOTES.has(tag)) {
      // The last occurrence fills the columns; earlier ones would otherwise be lost.
      if (child !== lastLifeEvent.get(tag)) otherFacts.push(otherFact(child));
    } else if (!HANDLED.has(tag) && !IGNORED.has(tag)) {
      otherFacts.push(otherFact(child));
    }
  }

  const facts = {};
  const notes = noteTexts(indi);
  if (notes.length) facts.notes = notes;
  if (occupations.length) facts.occupations = occupations;
  if (censusRecords.length) facts.censusRecords = censusRecords;
  if (residences.length) facts.residences = residences;
  for (const [tag, key] of LIFE_EVENT_NOTES) {
    const event = lastLifeEvent.get(tag);
    const eventNotes = event ? noteTexts(event) : [];
    if (eventNotes.length) facts[key] = eventNotes;
  }
  const death = lastLifeEvent.get('DEAT');
  const cause = death && lastChild(death, 'CAUS');
  if (cause && text(cause)) facts.causeOfDeath = text(cause);
  if (otherFacts.length) facts.otherFacts = otherFacts;
  return facts;
}
