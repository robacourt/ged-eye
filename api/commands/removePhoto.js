/** remove_photo: stop showing a photo for one person. The media row stays, even with no links left. */
import { requireId, requireParams } from './validate.js';
import { nameOf } from './summary.js';
import { requirePerson, stale } from './linking.js';
import { requireMedia, requireMediaId } from './photos.js';

export const kind = 'remove_photo';

/** params: { personId, mediaId } */
export function validate(params) {
  requireParams(params, ['personId', 'mediaId']);
  return { personId: requireId(params.personId, 'personId'), mediaId: requireMediaId(params.mediaId, 'mediaId') };
}

/** A link that is already gone (another editor removed it) is stale. */
export async function run(tx, { personId, mediaId }) {
  const person = await requirePerson(tx, personId, 'personId');
  await requireMedia(tx, mediaId);
  const { rowCount } = await tx.query('delete from person_media where person_id = $1 and media_id = $2', [personId, mediaId]);
  if (rowCount === 0) throw stale(`That photo is no longer shown for ${nameOf(person)}. Reload to see the latest.`);
  return { summary: `Removed a photo from ${nameOf(person)}`, personIds: [personId], focusId: personId };
}
