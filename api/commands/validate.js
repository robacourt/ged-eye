/**
 * Parameter validation shared by the edit commands. Each check throws
 * ApiError(400, 'invalid', { field, message }) and returns the value normalised for storage.
 *
 * Fields are named by their column (`birth_place`), facts by `facts.<key>`, and other parameters by
 * their name (`anchorId`, `familyId`, `expected.marriage_date`), with a list item's index
 * (`photos.0.caption`).
 */
import { invalid, isObject } from '../http.js';
import { FIELD_LABELS, FACT_LABELS, capitalise } from './summary.js';

/** The person columns update_person and add_relative may set, in summary order. */
export const PERSON_FIELDS = ['given_name', 'surname', 'sex', 'birth_date', 'birth_place', 'death_date', 'death_place',
  'baptism_date', 'baptism_place', 'burial_date', 'burial_place'];

/** The family columns update_family may set. */
export const FAMILY_FIELDS = ['marriage_date', 'marriage_place', 'divorce_date', 'divorce_place'];

/**
 * person.facts keys: the full-facts model's, plus `religion` and `education` from its predecessor,
 * so every existing row can be saved unchanged.
 */
export const FACT_KEYS = Object.keys(FACT_LABELS);

export const MAX_LINE = 500;
export const MAX_FACT_STRING = 100_000;
export const MAX_FACTS_BYTES = 500 * 1024;

const NAME_FIELDS = new Set(['given_name', 'surname']); // never null in the table: '' when empty
const SEXES = new Set(['M', 'F', 'U']);
const ID = /^[A-Za-z0-9_-]{1,32}$/;
const MAX_STAMP = 64;
const LINE_BREAK = /[\r\n]/;
// Text Postgres can't store: NUL anywhere, and (in jsonb, where params and facts go) unpaired UTF-16 surrogates.
const UNSTORABLE = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Throws unless `text` can be stored (no NUL, no unpaired surrogate). */
function requireStorable(text, field, what) {
  if (UNSTORABLE.test(text)) throw invalid(field, `${what} contains an invalid character.`);
}

/** The command's params: an object with only `allowed` keys, so a misspelt key is an error, not silently ignored. */
export function requireParams(params, allowed) {
  if (!isObject(params)) throw invalid('params', 'params must be an object.');
  return requireKeys(params, allowed, 'params');
}

export function requireId(value, field) {
  if (typeof value !== 'string' || !ID.test(value)) throw invalid(field, `${field} must be an id.`);
  return value;
}

/** An id, or null when absent. */
export function optionalId(value, field) {
  return value === undefined || value === null ? null : requireId(value, field);
}

export function requireOneOf(value, allowed, field) {
  if (!allowed.includes(value)) throw invalid(field, `${field} must be one of ${allowed.join(', ')}.`);
  return value;
}

/** updatedAt as person_record sent it: compared as text, so any other string is simply stale. */
export function requireStamp(value, field = 'expectedUpdatedAt') {
  if (typeof value !== 'string' || value === '' || value.length > MAX_STAMP) {
    throw invalid(field, `${field} must be the updatedAt the person was read with.`);
  }
  requireStorable(value, field, field);
  return value;
}

/** Throws unless `value` is an object with only `allowed` keys; an unknown key is named `<prefix><key>`. */
export function requireKeys(value, allowed, field, prefix = '') {
  if (!isObject(value)) throw invalid(field, `${field} must be an object.`);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw invalid(prefix + key, `${key} can't be set here.`);
  }
  return value;
}

/**
 * Optional single-line text: trimmed, at most `max` characters, storable; '' and absent → null.
 * Messages name it by `label` (capitalised), errors by `field`. Throws ApiError 400 invalid.
 */
export function optionalLine(value, field, { max = MAX_LINE, label: name = field } = {}) {
  if (value === null || value === undefined) return null;
  const what = capitalise(name);
  if (typeof value !== 'string') throw invalid(field, `${what} must be text.`);
  const text = value.trim();
  if (LINE_BREAK.test(text)) throw invalid(field, `${what} must be a single line.`);
  requireStorable(text, field, what);
  if (text.length > max) throw invalid(field, `${what} must be at most ${max} characters.`);
  return text === '' ? null : text;
}

/**
 * A single-line text column: trimmed, at most 500 characters. Empty is '' for the name columns
 * and null for the rest.
 */
function line(value, field) {
  const text = optionalLine(value, field, { label: FIELD_LABELS[field] ?? field });
  return text === null && NAME_FIELDS.has(field) ? '' : text;
}

function sex(value) {
  if (value === undefined || value === null || value === '') return null;
  if (!SEXES.has(value)) throw invalid('sex', 'Sex must be M, F, U or empty.');
  return value;
}

/** Any subset of PERSON_FIELDS, normalised. Empty given name and surname together are allowed. */
export function validatePersonFields(fields, field = 'fields') {
  requireKeys(fields, PERSON_FIELDS, field);
  const clean = {};
  for (const [name, value] of Object.entries(fields)) {
    clean[name] = name === 'sex' ? sex(value) : line(value, name);
  }
  return clean;
}

/** Any subset of FAMILY_FIELDS, normalised. */
export function validateFamilyFields(fields, field = 'fields') {
  requireKeys(fields, FAMILY_FIELDS, field);
  return Object.fromEntries(Object.entries(fields).map(([name, value]) => [name, line(value, name)]));
}

/**
 * The four marriage fields as the client saw them, for update_family's compare-and-swap. Absent
 * ones mean null. They are not trimmed: they must match what is stored.
 */
export function validateExpectedFamily(expected, field = 'expected') {
  requireKeys(expected, FAMILY_FIELDS, field, `${field}.`);
  return Object.fromEntries(FAMILY_FIELDS.map((name) => [name, expectedText(expected[name], `${field}.${name}`)]));
}

/**
 * A text value as the client saw it, for a compare-and-swap: text or null (absent is null), storable, and not
 * trimmed, because it must match what is stored. Throws ApiError 400 invalid naming `field`.
 */
export function expectedText(value, field) {
  const text = value ?? null;
  if (text !== null && typeof text !== 'string') throw invalid(field, `${field} must be text or null.`);
  if (text !== null) requireStorable(text, field, field);
  return text;
}

function factString(value, field) {
  if (value.length > MAX_FACT_STRING) throw invalid(field, `Each fact text must be at most ${MAX_FACT_STRING.toLocaleString('en-GB')} characters.`);
  requireStorable(value, field, 'A fact');
}

const isStringArray = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string');

/**
 * person.facts, validated leniently so that old (pre-backfill) and full-facts shapes both pass:
 * known keys; each value a string, or an array whose items are strings or flat objects (values
 * string, null or string[]; old and edited entries may be mixed); strings of at most 100,000
 * characters; at most 500 KB of JSON in all. Returns `facts` itself.
 */
export function validateFacts(facts, field = 'facts') {
  if (!isObject(facts)) throw invalid(field, 'facts must be an object.');
  for (const [key, value] of Object.entries(facts)) {
    const at = `${field}.${key}`;
    if (!FACT_KEYS.includes(key)) throw invalid(at, `Unknown fact: ${key}.`);
    if (typeof value === 'string') {
      factString(value, at);
      continue;
    }
    const shape = `${key} must be text, or a list of texts or of facts.`;
    if (!Array.isArray(value)) throw invalid(at, shape);
    for (const item of value) {
      if (typeof item === 'string') {
        factString(item, at);
        continue;
      }
      if (!isObject(item)) throw invalid(at, shape);
      for (const [name, part] of Object.entries(item)) {
        requireStorable(name, at, 'A fact');
        if (part === null) continue;
        if (typeof part === 'string') factString(part, at);
        else if (isStringArray(part)) part.forEach((text) => factString(text, at));
        else throw invalid(at, `Each ${key} entry's values must be text, null or a list of texts.`);
      }
    }
  }
  if (new TextEncoder().encode(JSON.stringify(facts)).length > MAX_FACTS_BYTES) {
    throw invalid(field, `facts must be at most ${MAX_FACTS_BYTES / 1024} KB.`);
  }
  return facts;
}

export const RELATIONS = ['parent', 'child', 'spouse', 'sibling'];

/**
 * `familyId` by relation: a child needs a family where the anchor is a partner, or 'new'; a parent
 * or sibling may name one of the anchor's parent families; a spouse always gets a new family.
 * Returns the id, 'new', or null when absent.
 */
export function validateFamilyChoice(familyId, relation) {
  const given = familyId !== undefined && familyId !== null;
  if (relation === 'child') {
    if (!given) throw invalid('familyId', 'Choose which family the child belongs to.');
    return familyId === 'new' ? 'new' : requireId(familyId, 'familyId');
  }
  if (!given) return null;
  if (relation === 'spouse') throw invalid('familyId', 'A spouse always gets a new family: familyId is not used.');
  if (familyId === 'new') throw invalid('familyId', "familyId 'new' is only for children.");
  return requireId(familyId, 'familyId');
}

/** A new person for add_relative: `{ fields?, facts? }`. */
export function validateNewPerson(person, field = 'person') {
  requireKeys(person, ['fields', 'facts'], field, `${field}.`);
  return {
    fields: person.fields === undefined ? {} : validatePersonFields(person.fields, `${field}.fields`),
    facts: person.facts === undefined ? {} : validateFacts(person.facts)
  };
}

/** JSON with object keys sorted, so jsonb read back from Postgres compares equal to what was sent. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}
