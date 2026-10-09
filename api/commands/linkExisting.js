/** link_existing: link two existing people as parent, child, spouse or sibling. */
import { invalid } from '../http.js';
import { RELATIONS, requireId, requireOneOf, requireParams, validateFamilyChoice } from './validate.js';
import { nameOf, relationPhrase } from './summary.js';
import { familyMembers, linkPeople, requirePerson, unique } from './linking.js';

export const kind = 'link_existing';

/** params: { relation, anchorId, otherId, familyId? } */
export function validate(params) {
  requireParams(params, ['relation', 'anchorId', 'otherId', 'familyId']);
  const relation = requireOneOf(params.relation, RELATIONS, 'relation');
  const anchorId = requireId(params.anchorId, 'anchorId');
  const otherId = requireId(params.otherId, 'otherId');
  if (otherId === anchorId) throw invalid('otherId', "A person can't be linked to themselves.");
  return { relation, anchorId, otherId, familyId: validateFamilyChoice(params.familyId, relation) };
}

export async function run(tx, { relation, anchorId, otherId, familyId }) {
  const anchor = await requirePerson(tx, anchorId, 'anchorId');
  const other = await requirePerson(tx, otherId, 'otherId');
  const linkedFamilyId = await linkPeople(tx, { relation, anchor, other, familyId, field: 'otherId' });
  return {
    summary: `Linked ${nameOf(other)} as ${relationPhrase(relation, other.sex)} of ${nameOf(anchor)}`,
    personIds: unique([other.id, anchor.id, ...await familyMembers(tx, [linkedFamilyId])]),
    focusId: anchor.id
  };
}
