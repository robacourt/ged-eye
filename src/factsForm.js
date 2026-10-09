/**
 * person.facts ↔ the person editor's form, both ways. Pure: no DOM, no I/O.
 *
 * The form:
 *   {
 *     notes: string[],                                   // facts.notes
 *     lifeEvents: { birth, baptism, death, burial: { notes: string[] } },  // facts.birthNotes, …
 *     causeOfDeath: string, email: string, phone: string, // '' when absent
 *     rows: Row[],                                       // occupations, otherFacts (+ religion, education), census, residences
 *     legacy: {}                                         // whatever the form can't edit, saved back as it was
 *   }
 *   Row = { kind: 'occupation'|'residence'|'census'|'other', tag, type, cause, value, date, place: string,
 *           notes: string[], original?: { key, entry } }
 *
 * `formToFacts(factsToForm(facts))` equals `facts` exactly, whatever the shape:
 *   - A row keeps the stored entry it came from (`original`). Unless one of its fields was edited, that entry is
 *     saved back verbatim, so old shapes (plain occupation strings, `{date: null, place}` census records, and
 *     the `religion` / `education` strings, shown as Religion and Education rows) survive until edited.
 *     An edited row is saved in the full-facts shape: text trimmed, empty fields left out, plus any entry keys
 *     the form doesn't know about.
 *   - Values the form can't show (unknown keys, empty values, entries of an unexpected shape) go to `legacy`.
 *     When the form also has something for such a key, an array is appended to and anything else replaced.
 *
 * Notes are kept verbatim here, blank ones included: dropping notes left blank is the editor's job, since only
 * it knows which ones the person touched (11 real occupations are stored as '').
 */

/** person.facts keys: the full-facts model's, and `religion` / `education` from its predecessor. */
export const FACT_KEYS = ['notes', 'occupations', 'censusRecords', 'residences', 'birthNotes', 'baptismNotes',
  'deathNotes', 'burialNotes', 'causeOfDeath', 'otherFacts', 'email', 'phone', 'religion', 'education'];

/** Row kinds, in the order the details panel shows them, with the facts key each is saved under. */
export const ROW_KINDS = ['occupation', 'other', 'census', 'residence'];
const KIND_KEYS = { occupation: 'occupations', other: 'otherFacts', census: 'censusRecords', residence: 'residences' };

export const LIFE_EVENTS = ['birth', 'baptism', 'death', 'burial'];
const LIFE_EVENT_KEYS = { birth: 'birthNotes', baptism: 'baptismNotes', death: 'deathNotes', burial: 'burialNotes' };

const STRING_KEYS = ['causeOfDeath', 'email', 'phone'];

// Pre-backfill single values, shown as "other" rows with these tags.
const LEGACY_TAGS = { religion: 'RELI', education: 'EDUC' };

const TEXT_FIELDS = ['tag', 'type', 'value', 'date', 'place', 'cause'];
const MODEL_FIELDS = new Set([...TEXT_FIELDS, 'notes']);

/** The fields of each kind, in saved key order. */
export function rowFields(kind) {
  return kind === 'other'
    ? ['tag', 'type', 'value', 'date', 'place', 'cause', 'notes']
    : ['value', 'date', 'place', 'notes'];
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isStringArray = (value) => Array.isArray(value) && value.every(item => typeof item === 'string');
const isText = (value) => value === undefined || value === null || typeof value === 'string';
const isBlank = (text) => typeof text !== 'string' || text.trim() === '';
// Not Object.hasOwn, which Safari 15.0 lacks.
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

/** Sets `object[key]` as data, even for a key like `__proto__`. */
function put(object, key, value) {
  Object.defineProperty(object, key, { value, enumerable: true, writable: true, configurable: true });
}

/** A stored entry the form can show and save back: a string, or an object of text fields and a notes list. */
function isEditableEntry(entry) {
  if (typeof entry === 'string') return true;
  return isPlainObject(entry) && TEXT_FIELDS.every(field => isText(entry[field])) &&
    (entry.notes === undefined || entry.notes === null || isStringArray(entry.notes));
}

export function emptyForm() {
  return {
    notes: [],
    lifeEvents: Object.fromEntries(LIFE_EVENTS.map(event => [event, { notes: [] }])),
    causeOfDeath: '',
    rows: [],
    email: '',
    phone: '',
    legacy: {}
  };
}

/** A blank row, for the person to fill in. */
export function newRow(kind = 'occupation') {
  return { kind, tag: '', type: '', cause: '', value: '', date: '', place: '', notes: [] };
}

/** The row a stored entry is shown as; `key` is where it is stored (`religion` and `education` included). */
function rowFromEntry(entry, key) {
  const kind = kindOfKey(key);
  const fields = typeof entry === 'string' ? { value: entry } : entry;
  const text = (value) => value ?? '';
  return {
    kind,
    tag: hasOwn(LEGACY_TAGS, key) ? LEGACY_TAGS[key] : text(fields.tag),
    type: text(fields.type),
    cause: text(fields.cause),
    value: text(fields.value),
    date: text(fields.date),
    place: text(fields.place),
    notes: fields.notes ? [...fields.notes] : [],
    original: { key, entry }
  };
}

function kindOfKey(key) {
  if (hasOwn(LEGACY_TAGS, key)) return 'other';
  return ROW_KINDS.find(kind => KIND_KEYS[kind] === key);
}

/** The facts keys of a person record (person_record merges `facts` into it, under the core fields). */
export function factsFromPerson(person) {
  const facts = {};
  for (const key of FACT_KEYS) {
    if (person?.[key] !== undefined) facts[key] = person[key];
  }
  return facts;
}

export function factsToForm(facts) {
  const form = emptyForm();
  const source = isPlainObject(facts) ? facts : {};
  const used = new Set();
  const has = (key) => hasOwn(source, key);

  if (has('notes') && isStringArray(source.notes) && source.notes.length) {
    form.notes = [...source.notes];
    used.add('notes');
  }
  for (const event of LIFE_EVENTS) {
    const key = LIFE_EVENT_KEYS[event];
    if (has(key) && isStringArray(source[key]) && source[key].length) {
      form.lifeEvents[event].notes = [...source[key]];
      used.add(key);
    }
  }
  for (const key of STRING_KEYS) {
    if (has(key) && !isBlank(source[key])) {
      form[key] = source[key];
      used.add(key);
    }
  }

  const addRows = (key) => {
    const list = source[key];
    if (has(key) && Array.isArray(list) && list.length && list.every(isEditableEntry)) {
      form.rows.push(...list.map(entry => rowFromEntry(entry, key)));
      used.add(key);
    }
  };
  const addLegacyRow = (key) => {
    if (has(key) && !isBlank(source[key])) {
      form.rows.push(rowFromEntry(source[key], key));
      used.add(key);
    }
  };
  addRows('occupations');
  addRows('otherFacts');
  addLegacyRow('religion');
  addLegacyRow('education');
  addRows('censusRecords');
  addRows('residences');

  for (const [key, value] of Object.entries(source)) {
    if (!used.has(key)) put(form.legacy, key, value);
  }
  return form;
}

/** Whether a row still holds exactly what its stored entry showed. */
function isUnedited(row) {
  const { original } = row;
  if (!original || row.kind !== kindOfKey(original.key)) return false;
  const before = rowFromEntry(original.entry, original.key);
  return rowFields(row.kind).every(field => (field === 'notes'
    ? factsEqual(row.notes ?? [], before.notes)
    : (row[field] ?? '') === before[field]));
}

/** An edited or new row as a full-facts entry, or null when it is empty. */
function entryFromRow(row) {
  const entry = {};
  let hasContent = false;
  for (const field of rowFields(row.kind)) {
    if (field === 'notes') {
      if (row.notes?.length) {
        entry.notes = [...row.notes];
        hasContent = true;
      }
    } else {
      const text = (row[field] ?? '').trim();
      if (text) {
        entry[field] = text;
        if (field !== 'tag') hasContent = true;
      }
    }
  }
  if (row.kind === 'other') {
    if (!entry.tag && !hasContent) return null;
    // A tag-only fact (e.g. _NMAR, never married) is still a fact; one without a tag is an Event.
    if (!entry.tag) return withExtras({ tag: 'EVEN', ...entry }, row);
  } else if (!hasContent) {
    return null;
  }
  return withExtras(entry, row);
}

/** Adds the keys of the row's stored entry that the form doesn't know about, carried over when it is edited. */
function withExtras(entry, row) {
  const stored = row.original?.entry;
  if (isPlainObject(stored)) {
    for (const [key, value] of Object.entries(stored)) {
      if (!MODEL_FIELDS.has(key)) put(entry, key, value);
    }
  }
  return entry;
}

export function formToFacts(form) {
  const facts = { ...(form.legacy ?? {}) };
  const set = (key, value) => {
    facts[key] = Array.isArray(facts[key]) && Array.isArray(value) ? [...facts[key], ...value] : value;
  };

  if (form.notes?.length) set('notes', [...form.notes]);
  for (const event of LIFE_EVENTS) {
    const notes = form.lifeEvents?.[event]?.notes;
    if (notes?.length) set(LIFE_EVENT_KEYS[event], [...notes]);
  }
  for (const key of STRING_KEYS) {
    if (!isBlank(form[key])) set(key, form[key]);
  }

  const lists = Object.fromEntries(ROW_KINDS.map(kind => [KIND_KEYS[kind], []]));
  for (const row of form.rows ?? []) {
    if (!hasOwn(KIND_KEYS, row.kind)) throw new Error(`Unknown fact row kind: ${row.kind}`);
    if (isUnedited(row)) {
      const { key, entry } = row.original;
      if (hasOwn(LEGACY_TAGS, key)) set(key, entry);
      else lists[key].push(entry);
      continue;
    }
    const entry = entryFromRow(row);
    if (entry) lists[KIND_KEYS[row.kind]].push(entry);
  }
  for (const [key, list] of Object.entries(lists)) {
    if (list.length) set(key, list);
  }
  return facts;
}

/** Deep equality for JSON-like values: key order and undefined-valued keys don't matter. */
export function factsEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((item, i) => factsEqual(item, b[i]));
  }
  if (isPlainObject(a)) {
    if (!isPlainObject(b)) return false;
    const keysA = Object.keys(a).filter(key => a[key] !== undefined);
    const keysB = Object.keys(b).filter(key => b[key] !== undefined);
    return keysA.length === keysB.length && keysA.every(key => hasOwn(b, key) && factsEqual(a[key], b[key]));
  }
  return false;
}
