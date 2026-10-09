// SPIKE ONLY (step 0 of the photos design): proves sharp loads and measures processing. Replaced by the real Function.
import sharp from 'sharp';
import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';

const s3 = new S3Client({ forcePathStyle: true });
sharp.cache(false);
sharp.concurrency(Number(process.env.SPIKE_CONCURRENCY || 2));
const BUCKET = 'ged-eye-media';
const ALLOWED = /^originals\/[0-9a-f]{64}\.(jpg|png|tif)$/;

let peakRss = 0;
const sample = () => { peakRss = Math.max(peakRss, process.memoryUsage().rss); };

async function processKey(key, url_reencode) {
  const t0 = Date.now();
  const object = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const input = Buffer.from(await object.Body.transformToByteArray());
  const t1 = Date.now();
  const timer = setInterval(sample, 20);
  try {
    const meta = await sharp(input, { limitInputPixels: 100_000_000 }).metadata();
    const tDisplay = Date.now();
    const display = await sharp(input, { limitInputPixels: 100_000_000 }).rotate()
      .resize(2000, 2000, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
    const displayRss = Math.round(peakRss / 1048576); const displayMs = Date.now() - tDisplay;
    const thumb = await sharp(display).resize(320, 320, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 75 }).toBuffer();
    const tRe = Date.now();
    const reencoded = url_reencode ? await sharp(input, { limitInputPixels: 100_000_000 }).rotate().keepIccProfile()
      .toFormat(meta.format === 'jpeg' ? 'jpeg' : meta.format, meta.format === 'jpeg' ? { quality: 92 } : {}).toBuffer() : Buffer.alloc(0);
    const reMs = Date.now() - tRe;
    sample();
    return { key, bytes: input.length, format: meta.format, width: meta.width, height: meta.height, hasExif: !!meta.exif,
      fetchMs: t1 - t0, processMs: Date.now() - t1, displayBytes: display.length, thumbBytes: thumb.length, reencodedBytes: reencoded.length, displayRssMb: displayRss, displayMs, reMs };
  } finally { clearInterval(timer); }
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/health') {
        return Response.json({ ok: true, sharp: sharp.versions, arch: process.arch, rss: process.memoryUsage().rss });
      }
      if (url.pathname === '/spike/process') {
        const key = url.searchParams.get('key') ?? '';
        if (!ALLOWED.test(key)) return Response.json({ error: 'invalid' }, { status: 400 });
        peakRss = 0;
        const result = await processKey(key, url.searchParams.get('reencode') === '1');
        return Response.json({ ...result, peakRssMb: Math.round(peakRss / 1048576) });
      }
      if (url.pathname === '/spike/storage') {
        const key = `incoming/spike-${crypto.randomUUID()}`;
        await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: 'spike', ContentType: 'text/plain' }));
        const publicUrl = `${process.env.AWS_ENDPOINT_URL_S3}/${BUCKET}/${key}`;
        const head = await fetch(publicUrl, { method: 'HEAD' });
        await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
        const after = await fetch(publicUrl, { method: 'HEAD' });
        return Response.json({ put: true, publicHead: head.status, contentLength: head.headers.get('content-length'), deleted: true, headAfterDelete: after.status });
      }
      return Response.json({ error: 'not_found' }, { status: 404 });
    } catch (error) {
      console.error(error);
      return Response.json({ error: 'internal', message: String(error?.message ?? error) }, { status: 500 });
    }
  }
};
