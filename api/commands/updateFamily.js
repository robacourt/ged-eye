/** update_family: edit a couple's marriage and divorce details. */
import { FAMILY_FIELDS, optionalId, requireId, requireParams, validateExpectedFamily, validateFamilyFields } from './validate.js';
import { listNames, nameOf } from './summary.js';
import { existingPersonOr, familyMembers, findFamily, noChange, partnersOf, peopleByIds, stale } from './linking.js';

export const kind = 'update_family';

/**
 * params: { id, expected: { the four fields as seen }, fields: { any of the four }, focusId? }
 * focusId (optional, not in the spec's table) picks whose view to return; by default (or when that
 * person doesn't exist) the first partner. A family that no longer exists is stale, like any failed
 * compare-and-swap.
 */
export function validate(params) {
  requireParams(params, ['id', 'expected', 'fields', 'focusId']);
  return {
    id: requireId(params.id, 'id'),
    expected: validateExpectedFamily(params.expected),
    fields: validateFamilyFields(params.fields),
    focusId: optionalId(params.focusId, 'focusId')
  };
}

// Compare-and-swap: '' and null are the same "nothing".
const same = (stored, seen) => (stored || null) === (seen || null);

export async function run(tx, { id, expected, fields, focusId }) {
  const family = await findFamily(tx, id);
  if (!family) throw stale('That family no longer exists. Reload to see the latest.');
  const partners = await peopleByIds(tx, partnersOf(family));
  const couple = partners.length > 0 ? listNames(partners.map(nameOf)) : 'an empty family'; // no partners: legacy only
  if (!FAMILY_FIELDS.every((name) => same(family[name], expected[name]))) {
    throw stale(`Someone else changed the marriage of ${couple} since you opened it. Reload to see their changes.`);
  }
  const changed = FAMILY_FIELDS.filter((name) => name in fields && !same(family[name], fields[name]));
  if (changed.length === 0) throw noChange();

  // Column names come from FAMILY_FIELDS only.
  await tx.query(`update family set ${changed.map((name, i) => `${name} = $${i + 2}`).join(', ')} where id = $1`,
    [id, ...changed.map((name) => fields[name])]);
  return {
    summary: `Edited the marriage of ${couple}`,
    // The children too: the marriage year orders their parents' families and their siblings.
    personIds: await familyMembers(tx, [id]),
    focusId: await existingPersonOr(tx, focusId, partners[0]?.id ?? null)
  };
}
