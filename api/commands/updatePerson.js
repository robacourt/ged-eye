/** update_person: edit a person's core fields and/or replace their facts. */
import { PERSON_FIELDS, FACT_KEYS, canonicalJson, requireId, requireParams, requireStamp, validateFacts, validatePersonFields } from './validate.js';
import { FIELD_LABELS, FACT_LABELS, nameOf } from './summary.js';
import { noChange, requireFreshPerson } from './linking.js';

export const kind = 'update_person';

/** params: { id, expectedUpdatedAt, fields?: { any of PERSON_FIELDS }, facts?: the whole facts object } */
export function validate(params) {
  requireParams(params, ['id', 'expectedUpdatedAt', 'fields', 'facts']);
  return {
    id: requireId(params.id, 'id'),
    expectedUpdatedAt: requireStamp(params.expectedUpdatedAt),
    fields: params.fields === undefined ? {} : validatePersonFields(params.fields),
    facts: params.facts === undefined ? undefined : validateFacts(params.facts)
  };
}

/** The facts keys whose values differ between two facts objects, in summary order. */
export function changedFactKeys(before, after) {
  return FACT_KEYS.filter((key) => canonicalJson(before?.[key]) !== canonicalJson(after[key]));
}

export async function run(tx, { id, expectedUpdatedAt, fields, facts }) {
  const row = await requireFreshPerson(tx, id, expectedUpdatedAt);
  const changed = PERSON_FIELDS.filter((name) => name in fields && fields[name] !== row[name]);
  const changedFacts = facts === undefined ? [] : changedFactKeys(row.facts, facts);
  if (changed.length === 0 && changedFacts.length === 0) throw noChange();

  const values = changed.map((name) => fields[name]);
  const sets = changed.map((name, i) => `${name} = $${i + 2}`);
  if (changedFacts.length > 0) {
    values.push(JSON.stringify(facts));
    sets.push(`facts = $${values.length + 1}::jsonb`);
  }
  // Column names come from PERSON_FIELDS only.
  const { rows: [updated] } = await tx.query(
    `update person set ${sets.join(', ')}, updated_at = now() where id = $1 returning display_name`, [id, ...values]);

  const labels = [...changed.map((name) => FIELD_LABELS[name]), ...changedFacts.map((key) => FACT_LABELS[key])];
  return { summary: `Edited ${nameOf(updated)} (${labels.join(', ')})`, personIds: [id], focusId: id };
}
