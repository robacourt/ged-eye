/**
 * The params of the five photo commands (add_photos, update_photo, remove_photo, set_avatar, clear_avatar), as
 * the dialogs and main.js send them. Pure, with no DOM and no imports, so the contract test can run every
 * builder through the server's validators (api/commands) in the node environment.
 *
 * Captions and dates are sent trimmed, with empty as null, as the server stores them. An upload is described by
 * `{ sha256, ext, fileName }`: the client never sends object keys.
 */

/** A caption or date as sent: trimmed text, or null for empty or missing. */
const text = (value) => {
  const trimmed = String(value ?? '').trim();
  return trimmed === '' ? null : trimmed;
};

/**
 * One add_photos photo (also set_avatar's `photo`) from a processed upload's `media` (mediaApi.processUpload).
 * → `{ mediaId, caption, date, personIds }` for a file already in the tree (a dedupe hit, `media.mediaId` set),
 * else `{ upload: { sha256, ext, fileName }, caption, date, personIds }`.
 */
export function photoItem(media, { caption, date, personIds } = {}) {
  const source = media.mediaId !== null && media.mediaId !== undefined
    ? { mediaId: media.mediaId }
    : { upload: { sha256: media.sha256, ext: media.ext, fileName: media.fileName } };
  return { ...source, caption: text(caption), date: text(date), personIds: [...(personIds ?? [])] };
}

/** add_photos: `items` (photoItem's, at most 20, in the order they should appear) for the person `personId`. */
export const addPhotosParams = (personId, items) => ({ personId, photos: items });

/**
 * update_photo: the photo's new caption, date and people (the full set), with `expected` holding the values
 * `photo` (person_record's) was opened with, exactly as read, for the server's compare-and-swap. `focusId`, when
 * given, chooses whose view comes back.
 */
export function updatePhotoParams(photo, { caption, date, personIds }, focusId) {
  const params = {
    mediaId: photo.id,
    caption: text(caption),
    date: text(date),
    personIds: [...personIds],
    expected: {
      caption: photo.caption ?? null,
      date: photo.date ?? null,
      personIds: (photo.people ?? []).map((someone) => someone.id)
    }
  };
  if (focusId !== undefined && focusId !== null) params.focusId = focusId;
  return params;
}

/** remove_photo: stop showing `photo` (person_record's) for the person `personId`. */
export const removePhotoParams = (personId, photo) => ({ personId, mediaId: photo.id });

/**
 * set_avatar: `crop` (fractions of the oriented image) of a photo, rendered by the media Function as `avatarKey`.
 * `source` is `{ mediaId }` for one of the person's photos, or `{ media }` for a fresh upload, which is sent as
 * `photo` (photoItem's, shown for the person, with no caption or date): by its media id when the file was already
 * in the tree, so it is linked to the person first if it isn't yet. Throws TypeError for any other source.
 */
export function setAvatarParams(personId, source, crop, avatarKey) {
  if (source?.media) {
    const photo = photoItem(source.media, { caption: null, date: null, personIds: [personId] });
    return { personId, photo, crop, avatarKey };
  }
  if (source?.mediaId !== undefined && source?.mediaId !== null) {
    return { personId, mediaId: source.mediaId, crop, avatarKey };
  }
  throw new TypeError('An avatar needs a photo: { mediaId } or { media }.');
}

/** clear_avatar: remove the avatar of the person `personId`. */
export const clearAvatarParams = (personId) => ({ personId });
