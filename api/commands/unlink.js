/** unlink: remove a partner or a child from a family, then clean the family up. */
import { optionalId, requireId, requireOneOf, requireParams } from './validate.js';
import { listNames, nameOf, relationPhrase } from './summary.js';
import { cleanupFamilies, existingPersonOr, familyMembers, findFamily, findPerson, partnersOf, peopleByIds, stale, unique } from './linking.js';

export const kind = 'unlink';

const ROLES = ['partner', 'child'];

/**
 * params: { familyId, personId, role: 'partner' | 'child', focusId? }
 * focusId (optional, not in the spec's table) picks whose view to return; by default (or when that
 * person doesn't exist) the person unlinked. A link or family that no longer exists is stale: someone
 * else has changed it.
 */
export function validate(params) {
  requireParams(params, ['familyId', 'personId', 'role', 'focusId']);
  return {
    familyId: requireId(params.familyId, 'familyId'),
    personId: requireId(params.personId, 'personId'),
    role: requireOneOf(params.role, ROLES, 'role'),
    focusId: optionalId(params.focusId, 'focusId')
  };
}

const gone = (what) => stale(`${what} Reload to see the latest.`);

/** "Removed Rose Smith as a daughter of Tom Smith and Ann Jones", "Removed Ann Jones as the wife of Tom Smith", ... */
async function summarise(tx, family, person, role) {
  const otherPartners = await peopleByIds(tx, partnersOf(family).filter((id) => id !== person.id));
  if (role === 'child') {
    if (otherPartners.length === 0) return `Removed ${nameOf(person)} from family ${family.id}`;
    return `Removed ${nameOf(person)} as ${relationPhrase('child', person.sex)} of ${listNames(otherPartners.map(nameOf))}`;
  }
  if (otherPartners.length > 0) {
    return `Removed ${nameOf(person)} as ${relationPhrase('spouse', person.sex)} of ${listNames(otherPartners.map(nameOf))}`;
  }
  const { rows } = await tx.query('select child_id from family_child where family_id = $1 order by position', [family.id]);
  const children = await peopleByIds(tx, rows.map((row) => row.child_id));
  if (children.length === 0) return `Removed ${nameOf(person)} from family ${family.id}`;
  return `Removed ${nameOf(person)} as ${relationPhrase('parent', person.sex)} of ${listNames(children.map(nameOf))}`;
}

export async function run(tx, { familyId, personId, role, focusId }) {
  const family = await findFamily(tx, familyId);
  if (!family) throw gone('That family no longer exists.');
  const person = await findPerson(tx, personId);
  const members = await familyMembers(tx, [familyId]);
  const summary = person ? await summarise(tx, family, person, role) : null;

  if (role === 'partner') {
    if (!person || !partnersOf(family).includes(personId)) throw gone('They are no longer a partner in that family.');
    await tx.query(
      `update family set partner1_id = nullif(partner1_id, $2), partner2_id = nullif(partner2_id, $2) where id = $1`,
      [familyId, personId]);
  } else {
    const { rowCount } = await tx.query('delete from family_child where family_id = $1 and child_id = $2', [familyId, personId]);
    if (rowCount === 0) throw gone('They are no longer a child in that family.');
  }
  await cleanupFamilies(tx, [familyId]);

  return { summary, personIds: unique([personId, ...members]), focusId: await existingPersonOr(tx, focusId, personId) };
}
