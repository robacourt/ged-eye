/**
 * URLs for objects in the public media bucket.
 */
export function mediaUrl(key) {
  if (!key) return null;
  const base = import.meta.env.VITE_MEDIA_BASE_URL;
  if (!base) throw new Error('VITE_MEDIA_BASE_URL is not configured');
  return `${base}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

export function thumbUrl(photo) {
  return photo?.thumbKey ? mediaUrl(photo.thumbKey) : null;
}
