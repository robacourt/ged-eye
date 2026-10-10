/** update_photo: edit a photo's caption and date, and who it is shown for. */
import { invalid } from '../http.js';
import { expectedText, optionalId, requireKeys, requireParams } from './validate.js';
import { nameOf } from './summary.js';
import { noChange, peopleByIds, stale, unique } from './linking.js';
import { linkAtFront, linkedPeople, requireMedia, requireMediaId, requirePeople, requirePersonIds, validateCaption } from './photos.js';

export const kind = 'update_photo';

const EXPECTED_KEYS = ['caption', 'date', 'personIds'];

/**
 * params: { mediaId, caption, date, personIds, expected: { caption, date, personIds }, focusId? }
 * personIds is the full, non-empty set of people the photo is shown for (at most 100). `expected` holds exactly
 * the three values as the client saw them, for a compare-and-swap (not trimmed: they must match what is stored).
 * focusId picks whose view to return: that person's while they exist, even when this edit stops showing the photo
 * for them (so the editor stays on their page); else (not given, or deleted meanwhile) the first of personIds.
 */
export function validate(params) {
  requireParams(params, ['mediaId', 'caption', 'date', 'personIds', 'expected', 'focusId']);
  const mediaId = requireMediaId(params.mediaId, 'mediaId');
  const { caption, date } = validateCaption(params);
  const personIds = requirePersonIds(params.personIds, 'personIds');
  return { mediaId, caption, date, personIds, expected: validateExpected(params.expected), focusId: optionalId(params.focusId, 'focusId') };
}

function validateExpected(expected) {
  requireKeys(expected, EXPECTED_KEYS, 'expected', 'expected.');
  for (const key of EXPECTED_KEYS) {
    if (!(key in expected)) throw invalid(`expected.${key}`, `expected.${key} is missing: send the value as it was read.`);
  }
  return {
    caption: expectedText(expected.caption, 'expected.caption'),
    date: expectedText(expected.date, 'expected.date'),
    personIds: requirePersonIds(expected.personIds, 'expected.personIds', { allowEmpty: true })
  };
}

/** The person row (id, display_name, sex) whose view comes back: focusId's while they exist, else `people[0]`. */
async function focusPerson(tx, focusId, people) {
  const listed = people.find((row) => row.id === focusId);
  if (listed || focusId === null) return listed ?? people[0];
  const [row] = await peopleByIds(tx, [focusId]);
  return row ?? people[0];
}

// Compare-and-swap: '' and null are the same "nothing".
const same = (stored, seen) => (stored || null) === (seen || null);
const sameSet = (sorted, ids) => sorted.join('\u0000') === [...ids].sort().join('\u0000');

export async function run(tx, { mediaId, caption, date, personIds, expected, focusId }) {
  const media = await requireMedia(tx, mediaId);
  const linked = await linkedPeople(tx, mediaId);
  if (!same(media.caption, expected.caption) || !same(media.date, expected.date) || !sameSet(linked, expected.personIds)) {
    throw stale('Someone else changed this photo since you opened it. Reload to see their changes.');
  }
  const people = await requirePeople(tx, personIds, 'personIds');
  const added = personIds.filter((id) => !linked.includes(id));
  const removed = linked.filter((id) => !personIds.includes(id));
  const textChanged = !same(media.caption, caption) || !same(media.date, date);
  if (!textChanged && added.length === 0 && removed.length === 0) throw noChange();

  if (textChanged) await tx.query('update media set caption = $2, date = $3 where id = $1', [mediaId, caption, date]);
  if (removed.length > 0) {
    await tx.query('delete from person_media where media_id = $1 and person_id = any ($2::text[])', [mediaId, removed]);
  }
  await linkAtFront(tx, added.map((id) => ({ personId: id, mediaId })));

  const focus = await focusPerson(tx, focusId, people);
  const changed = (id) => personIds.includes(id) || linked.includes(id);
  return {
    summary: `Edited a photo of ${nameOf(focus)}`,
    // Everyone whose photos changed: the people it is shown for now, and those it no longer is; the focus first.
    personIds: unique([focus.id, ...personIds, ...linked]).filter(changed),
    focusId: focus.id
  };
}
