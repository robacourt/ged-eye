/**
 * Shared by the photo commands (add_photos, update_photo, remove_photo, set_avatar, clear_avatar): parameter
 * validation for media ids, people and photos, and the media and person_media reads and writes. The database
 * functions take the command's transaction client, which already holds the global write lock (begin_change).
 */
import { invalid } from '../http.js';
import { keysFor, validateUpload } from '../uploads.js';
import { optionalLine, requireId, requireKeys } from './validate.js';
import { notFound, peopleByIds, unique } from './linking.js';

export const MAX_CAPTION = 500;
export const MAX_DATE = 100;
export const MAX_PHOTOS = 20;

/** An avatar rendered by the media Function: avatars/<sha of the photo>-<first 12 hex of the crop's hash>.webp. */
export const AVATAR_KEY = /^avatars\/[0-9a-f]{64}-[0-9a-f]{12}\.webp$/;

const MEDIA_ID = /^[1-9][0-9]{0,15}$/;
const PHOTO_KEYS = ['upload', 'mediaId', 'caption', 'date', 'personIds'];

const isGiven = (value) => value !== undefined && value !== null;

/**
 * A media id: a positive whole number, sent as a number (as person_record gives it) or a numeric string.
 * → the number. Throws ApiError 400 invalid naming `field`.
 */
export function requireMediaId(value, field) {
  const id = typeof value === 'string' && MEDIA_ID.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(id) || id <= 0) throw invalid(field, `${field} must be a media id.`);
  return id;
}

/**
 * A list of distinct person ids, non-empty unless `allowEmpty`. → the list. Throws ApiError 400 invalid naming
 * `field`.
 */
export function requirePersonIds(value, field, { allowEmpty = false } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw invalid(field, `${field} must be a list of${allowEmpty ? '' : ' one or more'} person ids.`);
  }
  for (const id of value) requireId(id, field);
  if (new Set(value).size !== value.length) throw invalid(field, `${field} lists someone twice.`);
  return value;
}

/** A photo's caption (at most 500 characters) and date (at most 100), each trimmed; empty is null. */
export function validateCaption({ caption, date }, prefix = '') {
  return {
    caption: optionalLine(caption, `${prefix}caption`, { max: MAX_CAPTION, label: 'caption' }),
    date: optionalLine(date, `${prefix}date`, { max: MAX_DATE, label: 'date' })
  };
}

/**
 * One photo for add_photos, or set_avatar's `photo`, named `field` ('photos.0', 'photo'):
 * { upload: { sha256, ext, fileName } | mediaId, caption?, date?, personIds }, with exactly one of upload and
 * mediaId, and personIds (who it is shown for) including `personId`.
 * → { upload | null, mediaId | null, caption, date, personIds }. Throws ApiError 400 invalid.
 */
export function validatePhoto(photo, field, personId) {
  requireKeys(photo, PHOTO_KEYS, field, `${field}.`);
  if (isGiven(photo.upload) === isGiven(photo.mediaId)) {
    throw invalid(field, 'Each photo needs exactly one of upload and mediaId.');
  }
  const upload = isGiven(photo.upload) ? validateUpload(photo.upload, `${field}.upload`) : null;
  const mediaId = isGiven(photo.mediaId) ? requireMediaId(photo.mediaId, `${field}.mediaId`) : null;
  const personIds = requirePersonIds(photo.personIds, `${field}.personIds`);
  if (!personIds.includes(personId)) throw invalid(`${field}.personIds`, `${field}.personIds must include personId.`);
  return { upload, mediaId, ...validateCaption(photo, `${field}.`), personIds };
}

/** The media row (id as a number), or 404 not_found naming `field`. */
export async function requireMedia(tx, id, field = 'mediaId') {
  const { rows: [row] } = await tx.query(
    `select id, sha256, object_key, display_key, thumb_key, content_type, width, height, caption, date
     from media where id = $1`, [id]);
  if (!row) throw notFound(field, id);
  return { ...row, id: Number(row.id) };
}

/** The ids of the people a media row is linked to, sorted. */
export async function linkedPeople(tx, mediaId) {
  const { rows } = await tx.query('select person_id from person_media where media_id = $1', [mediaId]);
  return rows.map((row) => row.person_id).sort();
}

/** Person rows (id, display_name, sex) for `ids`, in order; 404 not_found naming `field` for the first missing. */
export async function requirePeople(tx, ids, field) {
  const people = await peopleByIds(tx, ids);
  const missing = ids.find((id) => !people.some((row) => row.id === id));
  if (missing !== undefined) throw notFound(field, missing);
  return people;
}

/**
 * Links `mediaIds` (in order) to `personId` at the front: positions min(position) - n … min(position) - 1, so
 * the first comes first and existing photos keep their order. Existing links are left alone (on conflict do
 * nothing). → the number of links made.
 */
export async function linkAtFront(tx, personId, mediaIds) {
  const ids = unique(mediaIds);
  if (ids.length === 0) return 0;
  const { rowCount } = await tx.query(
    `insert into person_media (person_id, media_id, position)
     select $1::text, m.id, low.position - $3::int + m.ord::int - 1
     from unnest($2::bigint[]) with ordinality as m (id, ord)
     cross join (select coalesce(min(position), 0) as position from person_media where person_id = $1::text) low
     order by m.ord
     on conflict (person_id, media_id) do nothing`, [personId, ids, ids.length]);
  return rowCount;
}

/** Sets caption and/or date only where the row's are null. */
export async function fillCaption(tx, mediaId, { caption, date }) {
  if (caption === null && date === null) return;
  await tx.query('update media set caption = coalesce(caption, $2), date = coalesce(date, $3) where id = $1',
    [mediaId, caption, date]);
}

/**
 * The media id for an uploaded file: a new row from the upload and its HEAD results (`head`, from
 * headUploads), or the existing row with this sha (another editor's upload since /process), whose null
 * caption/date are filled in. Throws TypeError without `head`, which prepare always provides for an upload.
 */
export async function mediaForUpload(tx, upload, head, { caption, date }) {
  if (!head) throw new TypeError(`No upload check for ${upload.sha256}.`);
  const { objectKey, displayKey, thumbKey } = keysFor(upload);
  const { rows: [inserted] } = await tx.query(
    `insert into media (sha256, original_path, file_name, content_type, byte_size, object_key, thumb_key, display_key,
                        width, height, caption, date)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     on conflict (sha256) do nothing
     returning id`,
    [upload.sha256, `upload/${upload.fileName}`, upload.fileName, head.contentType, head.byteSize, objectKey, thumbKey,
      displayKey, head.width, head.height, caption, date]);
  if (inserted) return Number(inserted.id);
  const { rows: [existing] } = await tx.query('select id from media where sha256 = $1', [upload.sha256]);
  await fillCaption(tx, existing.id, { caption, date });
  return Number(existing.id);
}

/**
 * The media id for a validated photo (see validatePhoto): its upload's row (mediaForUpload, given its HEAD
 * results), or its existing media, whose null caption/date are filled in (404 not_found, `<field>.mediaId`).
 */
export async function mediaForPhoto(tx, photo, head, field) {
  if (photo.upload) return mediaForUpload(tx, photo.upload, head, photo);
  const media = await requireMedia(tx, photo.mediaId, `${field}.mediaId`);
  await fillCaption(tx, media.id, photo);
  return media.id;
}
