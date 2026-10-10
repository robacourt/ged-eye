/**
 * The media Function's database reads. `media` only reads: only `api` writes the tree, through recorded changes.
 * Importing this module has no side effects: index.js creates the pool and passes it in.
 */
import { createDb } from '../api/db.js';

const MEDIA_BY_SHA_SQL = `
  select id, sha256, object_key, display_key, thumb_key, content_type, byte_size, width, height, file_name, caption, date
  from media
  where sha256 = $1`;

/**
 * → {
 *   lookupEditor(email) → { email, name, role } | null  (api/db.js's own query)
 *   mediaBySha(sha256) → the media row (snake_case, as pg returns it: id and byte_size are bigint strings) | null
 * }
 */
export function createMediaDb(pool) {
  const { lookupEditor } = createDb(pool);
  return {
    lookupEditor,
    async mediaBySha(sha256) {
      const { rows: [row] } = await pool.query(MEDIA_BY_SHA_SQL, [sha256]);
      return row ?? null;
    }
  };
}
