import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import sharp from 'sharp';
import { S3Client, PutObjectCommand, HeadObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { parseGedcom, extractPersonData } from '../gedParser.js';
import { ROOT, argValue, isMain, readJson, writeJson } from './cli.js';
import { readLegacyAvatars } from './legacyData.js';
import { contentTypeFor, contentDisposition, isDisplayable, objectKeyFor } from './mediaTypes.js';

export const BUCKET = process.env.MEDIA_BUCKET || 'ged-eye-media';
export const MANIFEST_PATH = path.join(ROOT, '.neon-import', 'media-manifest.json');
const IMMUTABLE = 'public, max-age=31536000, immutable';
const CONCURRENCY = 6;

const s3 = new S3Client({ forcePathStyle: true });

async function withRetry(label, fn) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= 3) throw new Error(`${label}: ${error.message}`);
      await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt));
    }
  }
}

async function exists(key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return true;
  } catch (error) {
    if (error.$metadata?.httpStatusCode === 404 || error.name === 'NotFound') return false;
    throw error;
  }
}

async function putOnce(key, body, headers) {
  if (await withRetry(`head ${key}`, () => exists(key))) return 'skipped';
  await withRetry(`put ${key}`, () => s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ...headers })));
  return 'uploaded';
}

async function runPool(items, worker) {
  let next = 0;
  const runners = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await worker(item);
    }
  });
  await Promise.all(runners);
}

export function referencedMediaPaths(parsedGed) {
  const paths = new Set();
  for (const [id] of parsedGed.individuals) {
    for (const photoPath of extractPersonData(parsedGed, id).photos) paths.add(photoPath);
  }
  return [...paths];
}

async function main() {
  const legacyRoot = path.resolve(ROOT, argValue('--legacy-root', 'public'));
  const parsed = parseGedcom(fs.readFileSync(path.join(ROOT, 'acourt.ged'), 'utf-8'));
  const manifest = readJson(MANIFEST_PATH, { files: {}, avatars: {} });
  const stats = { uploaded: 0, skipped: 0, missing: 0, failed: 0, thumbFailed: 0 };
  const failures = [];
  let sinceSave = 0;
  const save = (force = false) => {
    if (force || ++sinceSave >= 25) {
      writeJson(MANIFEST_PATH, manifest);
      sinceSave = 0;
    }
  };

  const mediaPaths = referencedMediaPaths(parsed);
  console.log(`Media: ${mediaPaths.length} referenced paths`);

  await runPool(mediaPaths, async (mediaPath) => {
    const fullPath = path.join(ROOT, mediaPath);
    if (!fs.existsSync(fullPath)) {
      stats.missing++;
      return;
    }
    try {
      const body = fs.readFileSync(fullPath);
      const sha256 = crypto.createHash('sha256').update(body).digest('hex');
      const fileName = path.basename(mediaPath);
      const objectKey = objectKeyFor(sha256, fileName);
      const result = await putOnce(objectKey, body, {
        ContentType: contentTypeFor(fileName),
        CacheControl: IMMUTABLE,
        ContentDisposition: contentDisposition(fileName)
      });
      stats[result]++;

      let thumbKey = null;
      if (isDisplayable(fileName)) {
        try {
          const key = `thumbs/${sha256}.webp`;
          if (!(await withRetry(`head ${key}`, () => exists(key)))) {
            const thumb = await sharp(body).rotate().resize(320, 320, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 75 }).toBuffer();
            await withRetry(`put ${key}`, () => s3.send(new PutObjectCommand({
              Bucket: BUCKET, Key: key, Body: thumb, ContentType: 'image/webp', CacheControl: IMMUTABLE
            })));
          }
          thumbKey = key;
        } catch (error) {
          stats.thumbFailed++;
          console.warn(`Thumbnail failed for ${mediaPath}: ${error.message}`);
        }
      }

      manifest.files[mediaPath] = {
        sha256, objectKey, thumbKey, contentType: contentTypeFor(fileName), byteSize: body.length, fileName
      };
      save();
    } catch (error) {
      stats.failed++;
      failures.push(`${mediaPath}: ${error.message}`);
    }
  });

  const avatarPaths = [...new Set(readLegacyAvatars(legacyRoot).values())];
  console.log(`Avatars: ${avatarPaths.length} in use`);
  await runPool(avatarPaths, async (avatarPath) => {
    const fullPath = path.join(legacyRoot, avatarPath);
    if (!fs.existsSync(fullPath)) {
      stats.missing++;
      return;
    }
    try {
      const body = fs.readFileSync(fullPath);
      const sha256 = crypto.createHash('sha256').update(body).digest('hex');
      const key = `avatars/${sha256}.jpg`;
      stats[await putOnce(key, body, { ContentType: 'image/jpeg', CacheControl: IMMUTABLE })]++;
      manifest.avatars[avatarPath] = key;
      save();
    } catch (error) {
      stats.failed++;
      failures.push(`${avatarPath}: ${error.message}`);
    }
  });

  save(true);
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: 'spike/test.jpg' })).catch(() => {});

  console.log(JSON.stringify(stats));
  if (failures.length) {
    console.error(failures.join('\n'));
    process.exitCode = 1;
  }
}

if (isMain(import.meta.url)) {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
