/** add_relative: create a person and link them to the anchor as a parent, child, spouse or sibling. */
import { PERSON_FIELDS, RELATIONS, requireId, requireOneOf, requireParams, validateFamilyChoice, validateNewPerson } from './validate.js';
import { nameOf, relationPhrase } from './summary.js';
import { familyMembers, linkPeople, nextPersonId, requirePerson, unique } from './linking.js';

export const kind = 'add_relative';

/** params: { anchorId, relation, person: { fields?, facts? }, familyId? } */
export function validate(params) {
  requireParams(params, ['anchorId', 'relation', 'person', 'familyId']);
  const relation = requireOneOf(params.relation, RELATIONS, 'relation');
  return {
    anchorId: requireId(params.anchorId, 'anchorId'),
    relation,
    person: validateNewPerson(params.person),
    familyId: validateFamilyChoice(params.familyId, relation)
  };
}

export async function run(tx, { anchorId, relation, person, familyId }) {
  const anchor = await requirePerson(tx, anchorId, 'anchorId');

  const id = await nextPersonId(tx);
  const columns = PERSON_FIELDS.filter((name) => name in person.fields);
  const { rows: [created] } = await tx.query(
    `insert into person (id, facts${columns.map((name) => `, ${name}`).join('')})
     values ($1, $2::jsonb${columns.map((_, i) => `, $${i + 3}`).join('')})
     returning id, display_name, sex`,
    [id, JSON.stringify(person.facts), ...columns.map((name) => person.fields[name])]);

  const linkedFamilyId = await linkPeople(tx, { relation, anchor, other: created, familyId, field: 'person' });
  return {
    summary: `Added ${nameOf(created)} as ${relationPhrase(relation, created.sex)} of ${nameOf(anchor)}`,
    personIds: unique([created.id, anchor.id, ...await familyMembers(tx, [linkedFamilyId])]),
    focusId: anchor.id
  };
}
