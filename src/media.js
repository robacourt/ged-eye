/**
 * URLs for objects in the public media bucket.
 */

/**
 * The public URL of a bucket object, or null for no key.
 * Throws when VITE_MEDIA_BASE_URL isn't configured.
 */
export function mediaUrl(key) {
  if (!key) return null;
  const base = import.meta.env.VITE_MEDIA_BASE_URL;
  if (!base) throw new Error('VITE_MEDIA_BASE_URL is not configured');
  return `${base}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

/** The thumbnail URL of a photo, or null when it has none (a document). */
export function thumbUrl(photo) {
  return photo?.thumbKey ? mediaUrl(photo.thumbKey) : null;
}

/**
 * The URL to show a photo at full size: its display image, else (an image not yet backfilled) the original,
 * else null for a document.
 */
export function displayUrl(photo) {
  if (photo?.displayKey) return mediaUrl(photo.displayKey);
  if (photo?.thumbKey) return mediaUrl(photo.key);
  return null;
}

/** Whether a photo is an image, rather than a document: it has a thumbnail or a display image. */
export function isImage(photo) {
  return Boolean(photo?.thumbKey || photo?.displayKey);
}

/** A person's avatar URL, or the man or woman placeholder when they have none. */
export function avatarUrl(person) {
  if (person.avatarKey) return mediaUrl(person.avatarKey);
  const placeholder = person.sex === 'F' ? 'woman.png' : 'man.png';
  return `${import.meta.env.BASE_URL}placeholders/${placeholder}`;
}
