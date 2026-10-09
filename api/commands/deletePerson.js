/** delete_person: delete a person; the foreign keys cascade their links away, then their families are cleaned up. */
import { requireId, requireParams, requireStamp } from './validate.js';
import { nameOf } from './summary.js';
import { cleanupFamilies, familyMembers, requireFreshPerson, unique } from './linking.js';

export const kind = 'delete_person';

/** params: { id, expectedUpdatedAt } */
export function validate(params) {
  requireParams(params, ['id', 'expectedUpdatedAt']);
  return { id: requireId(params.id, 'id'), expectedUpdatedAt: requireStamp(params.expectedUpdatedAt) };
}

export async function run(tx, { id, expectedUpdatedAt }) {
  const person = await requireFreshPerson(tx, id, expectedUpdatedAt);
  // Their families (as a partner, then as a child), and the focus afterwards: their first parent,
  // else their first spouse, else nobody. All read before the delete.
  const { rows: [{ family_ids: familyIds, focus_id: focusId }] } = await tx.query(
    `select coalesce((parent_ids($1))[1], (spouse_ids($1))[1]) as focus_id,
            array(select id from (
                    select f.id, 0 as grp, f.sort_key from family f where $1 in (f.partner1_id, f.partner2_id)
                    union all
                    select f.id, 1, f.sort_key from family_child fc join family f on f.id = fc.family_id where fc.child_id = $1
                  ) s order by grp, sort_key, id) as family_ids`, [id]);
  const members = await familyMembers(tx, familyIds);

  // ON DELETE: family partner slots are set null; family_child and person_media rows cascade.
  await tx.query('delete from person where id = $1', [id]);
  await cleanupFamilies(tx, familyIds);

  return { summary: `Deleted ${nameOf(person)}`, personIds: unique([id, ...members]), focusId: focusId ?? null };
}
