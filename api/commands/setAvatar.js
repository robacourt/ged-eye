/**
 * set_avatar: make a square crop of one of a person's photos their avatar, or of a new upload, which is added to
 * their photos first. It leaves person.updated_at alone, so an open person editor isn't made stale.
 */
import { invalid } from '../http.js';
import { headKey, headUploads } from '../uploads.js';
import { CropError, avatarKeyFor, cropPixels, validateCrop } from '../../media/crop.js';
import { SHA256 } from '../../media/types.js';
import { requireId, requireParams } from './validate.js';
import { nameOf } from './summary.js';
import { requirePerson, unique } from './linking.js';
import { AVATAR_KEY, linkAtFront, mediaForPhoto, requireMedia, requireMediaId, requirePeople, validatePhoto } from './photos.js';

export const kind = 'set_avatar';

const isGiven = (value) => value !== undefined && value !== null;
const isSize = (value) => Number.isInteger(value) && value > 0;
const mismatch = () => invalid('avatarKey', "The avatar wasn't made from this photo and crop. Make it again.");

/** `check()`'s result; a CropError becomes 400 invalid naming its field. */
function cropCheck(check) {
  try {
    return check();
  } catch (error) {
    if (error instanceof CropError) throw invalid(error.field, error.message);
    throw error;
  }
}

/**
 * params: { personId, mediaId | photo, crop: { x, y, w, h }, avatarKey }
 * `photo` is one add_photos photo, for an upload made in the avatar flow. `crop` is in fractions of the oriented
 * image, as media/crop.js validates it (and is stored rounded, as it does). `avatarKey` is the avatar the media
 * Function rendered: avatars/<sha>-<crop12>.webp. With an upload it must be the key of that upload and crop
 * (checked here); with a media id it is checked against the media row in run.
 */
export function validate(params) {
  requireParams(params, ['personId', 'mediaId', 'photo', 'crop', 'avatarKey']);
  const personId = requireId(params.personId, 'personId');
  if (isGiven(params.mediaId) === isGiven(params.photo)) throw invalid('mediaId', 'Choose exactly one of mediaId and photo.');
  const mediaId = isGiven(params.mediaId) ? requireMediaId(params.mediaId, 'mediaId') : null;
  const photo = isGiven(params.photo) ? validatePhoto(params.photo, 'photo', personId) : null;
  const crop = cropCheck(() => validateCrop(params.crop));
  const { avatarKey } = params;
  if (typeof avatarKey !== 'string' || !AVATAR_KEY.test(avatarKey)) {
    throw invalid('avatarKey', 'avatarKey must be the key of an avatar made by the media service.');
  }
  if (photo?.upload && avatarKey !== avatarKeyFor(photo.upload.sha256, crop)) throw mismatch();
  return { personId, mediaId, photo, crop, avatarKey };
}

/**
 * HEADs the avatar, and the photo's upload when there is one, together, before the lock. → { head: the upload's
 * { contentType, byteSize, width, height }, or null }. A missing avatar is 400 missing_upload { field:
 * 'avatarKey' }, and a missing upload 400 missing_upload { index: 0, field: 'photo' }.
 */
export async function prepare({ photo, avatarKey }, { headObject }) {
  const [heads] = await Promise.all([
    photo?.upload ? headUploads([photo.upload], headObject, { field: 'photo' }) : [null],
    headKey(avatarKey, headObject, { field: 'avatarKey', pattern: AVATAR_KEY })
  ]);
  return { head: heads[0] };
}

/**
 * Adds `photo` first (as add_photos does, for everyone tagged), then requires the photo to be an image with a
 * display image, linked to the person, whose sha and crop give avatarKey, and whose crop is square in pixels
 * (when its size is known). Then sets avatar_key and avatar_source ({ mediaId, crop }).
 */
export async function run(tx, { personId, mediaId, photo, crop, avatarKey }, user, prepared) {
  const person = await requirePerson(tx, personId, 'personId');
  let chosenId = mediaId;
  if (photo) {
    await requirePeople(tx, photo.personIds, 'photo.personIds');
    chosenId = await mediaForPhoto(tx, photo, prepared?.head, 'photo');
    for (const id of photo.personIds) await linkAtFront(tx, id, [chosenId]);
  }

  const field = photo ? 'photo' : 'mediaId';
  const media = await requireMedia(tx, chosenId, field);
  if (!media.content_type.startsWith('image/')) {
    throw invalid(field, `${media.content_type === 'application/pdf' ? 'A PDF' : 'That file'} can't be an avatar: choose a photo.`);
  }
  if (media.display_key === null) throw invalid(field, "That photo hasn't been prepared for viewing yet, so it can't be an avatar.");
  const { rows } = await tx.query('select 1 from person_media where person_id = $1 and media_id = $2', [personId, media.id]);
  if (rows.length === 0) throw invalid(field, `That photo isn't one of ${nameOf(person)}'s photos.`);
  if (!SHA256.test(media.sha256) || avatarKey !== avatarKeyFor(media.sha256, crop)) throw mismatch();
  if (isSize(media.width) && isSize(media.height)) cropCheck(() => cropPixels(crop, media.width, media.height));

  // No updated_at: an open person editor mustn't go stale because the avatar changed.
  await tx.query('update person set avatar_key = $2, avatar_source = $3::jsonb where id = $1',
    [personId, avatarKey, JSON.stringify({ mediaId: media.id, crop })]);
  return {
    summary: `Changed the avatar of ${nameOf(person)}`,
    // A new photo is also added for everyone tagged in it.
    personIds: unique([personId, ...(photo?.personIds ?? [])]),
    focusId: personId
  };
}
