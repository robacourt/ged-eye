// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { formatPlan, parseArgs, plan } from '../scripts/neon/backfillMedia.js';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);
const ROWS = [
  { id: '7', sha256: A, object_key: `originals/${A}.jpg`, content_type: 'image/jpeg', thumb_key: `thumbs/${A}.webp` },
  { id: '9', sha256: B, object_key: `originals/${B}.tif`, content_type: 'image/tiff', thumb_key: null },
  { id: '12', sha256: C, object_key: `originals/${C}.jpg`, content_type: 'image/jpeg', thumb_key: `thumbs/${C}.webp` }
];

describe('backfillMedia parseArgs', () => {
  it('reads --dry-run and --report-gps, defaulting to a real run', () => {
    expect(parseArgs([])).toEqual({ dryRun: false, reportGps: false });
    expect(parseArgs(['--dry-run'])).toEqual({ dryRun: true, reportGps: false });
    expect(parseArgs(['--report-gps'])).toEqual({ dryRun: false, reportGps: true });
  });

  it('refuses anything else, so a mistyped --dry-run never writes', () => {
    for (const argv of [['--dryrun'], ['--dry-run=true'], ['dry-run'], ['--dry-run', '--dry-run'], ['--report-gps', '--dry-run']]) {
      expect(() => parseArgs(argv), argv.join(' ')).toThrow();
    }
  });
});

describe('backfillMedia plan', () => {
  it('derives the display key from the sha, and a thumbnail key only where there is none', () => {
    expect(plan(ROWS)).toEqual([
      { id: '7', objectKey: `originals/${A}.jpg`, contentType: 'image/jpeg', displayKey: `display/${A}.webp`, thumbKey: null },
      { id: '9', objectKey: `originals/${B}.tif`, contentType: 'image/tiff', displayKey: `display/${B}.webp`, thumbKey: `thumbs/${B}.webp` },
      { id: '12', objectKey: `originals/${C}.jpg`, contentType: 'image/jpeg', displayKey: `display/${C}.webp`, thumbKey: null }
    ]);
  });

  it('summarises the plan by type, listing the rows that also need a thumbnail', () => {
    expect(formatPlan(plan(ROWS))).toEqual([
      '3 images without a display image (image/jpeg 2, image/tiff 1)',
      '1 of them also needs a thumbnail: 9'
    ]);
    expect(formatPlan([])).toEqual(['0 images without a display image']);
  });
});
