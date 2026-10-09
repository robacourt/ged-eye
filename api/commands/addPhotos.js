/** add_photos: add uploaded files and existing photos to a person, each shown for everyone it is tagged with. */
import { invalid } from '../http.js';
import { headUploads } from '../uploads.js';
import { requireId, requireParams } from './validate.js';
import { nameOf } from './summary.js';
import { noChange, notFound, peopleByIds, requirePerson, unique } from './linking.js';
import { MAX_PHOTOS, linkAtFront, mediaForPhoto, validatePhoto } from './photos.js';

export const kind = 'add_photos';

/**
 * params: { personId, photos: [{ upload: { sha256, ext, fileName } | mediaId, caption?, date?, personIds }] }
 * 1–20 photos; each one's personIds includes personId. The same file (sha256) or media id may not appear twice:
 * the dialog merges duplicates before saving.
 */
export function validate(params) {
  requireParams(params, ['personId', 'photos']);
  const personId = requireId(params.personId, 'personId');
  const { photos } = params;
  if (!Array.isArray(photos) || photos.length === 0 || photos.length > MAX_PHOTOS) {
    throw invalid('photos', `photos must be a list of 1 to ${MAX_PHOTOS} photos.`);
  }
  const clean = photos.map((photo, i) => validatePhoto(photo, `photos.${i}`, personId));
  const files = clean.map((photo) => (photo.upload ? `sha:${photo.upload.sha256}` : `id:${photo.mediaId}`));
  if (new Set(files).size !== files.length) throw invalid('photos', 'The same photo appears twice.');
  return { personId, photos: clean };
}

/**
 * HEADs every upload before the lock. → [{ contentType, byteSize, width, height } | null], by photo (null for a
 * media id). A missing upload is 400 missing_upload { index (the photo's), field: 'photos' }; see headUploads.
 */
export function prepare({ photos }, { headObject }) {
  return headUploads(photos.map((photo) => photo.upload ?? null), headObject, { field: 'photos' });
}

/**
 * Inserts a media row for each new upload (or reuses the row its sha gained meanwhile), fills only the null
 * caption and date of existing rows, and links each photo to everyone tagged, at the front, in batch order.
 * Existing links are left alone; when every link already exists, nothing changes (400 no_change).
 */
export async function run(tx, { personId, photos }, user, heads) {
  const person = await requirePerson(tx, personId, 'personId');
  const tagged = unique(photos.flatMap((photo) => photo.personIds));
  const known = new Set((await peopleByIds(tx, tagged)).map((row) => row.id));
  for (const [i, photo] of photos.entries()) {
    const missing = photo.personIds.find((id) => !known.has(id));
    if (missing !== undefined) throw notFound(`photos.${i}.personIds`, missing);
  }

  // Each tagged person's new photos, in batch order (a Map keeps the order people first appear in).
  const byPerson = new Map();
  for (const [i, photo] of photos.entries()) {
    const mediaId = await mediaForPhoto(tx, photo, heads?.[i], `photos.${i}`);
    for (const id of photo.personIds) byPerson.set(id, [...(byPerson.get(id) ?? []), mediaId]);
  }
  let linked = 0;
  for (const [id, mediaIds] of byPerson) linked += await linkAtFront(tx, id, mediaIds);
  if (linked === 0) throw noChange();

  const what = photos.length === 1 ? 'a photo' : `${photos.length} photos`;
  return {
    summary: `Added ${what} for ${nameOf(person)}`,
    personIds: unique([personId, ...tagged]),
    focusId: personId
  };
}
