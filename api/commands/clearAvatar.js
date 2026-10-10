/** clear_avatar: remove a person's avatar. Like set_avatar, it leaves person.updated_at alone. */
import { requireId, requireParams } from './validate.js';
import { nameOf } from './summary.js';
import { noChange, requirePerson } from './linking.js';

export const kind = 'clear_avatar';

/** params: { personId } */
export function validate(params) {
  requireParams(params, ['personId']);
  return { personId: requireId(params.personId, 'personId') };
}

export async function run(tx, { personId }) {
  const person = await requirePerson(tx, personId, 'personId');
  if (person.avatar_key === null && person.avatar_source === null) throw noChange();
  // No updated_at: an open person editor mustn't go stale because the avatar changed.
  await tx.query('update person set avatar_key = null, avatar_source = null where id = $1', [personId]);
  return { summary: `Removed the avatar of ${nameOf(person)}`, personIds: [personId], focusId: personId };
}
