// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import {
  Refusal, checkBranch, checkNpmFlags, checkSettings, describeSettings, formatPlan, parseArgs, plan, settingsFrom, watchConnection
} from '../scripts/neon/backfillMedia.js';

const SCRIPT = fileURLToPath(new URL('../scripts/neon/backfillMedia.js', import.meta.url));
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);
const ROWS = [
  { id: '7', sha256: A, object_key: `originals/${A}.jpg`, content_type: 'image/jpeg', thumb_key: `thumbs/${A}.webp` },
  { id: '9', sha256: B, object_key: `originals/${B}.tif`, content_type: 'image/tiff', thumb_key: null },
  { id: '12', sha256: C, object_key: `originals/${C}.jpg`, content_type: 'image/jpeg', thumb_key: `thumbs/${C}.webp` }
];

// Never contacted: every refusal below comes before the script connects to anything.
const DB_HOST = 'ep-quiet-lake-a1b2c3d4.example.test';
const STORAGE_HOST = 'br-quiet-lake-a1b2c3d4.storage.example.test';
const ENV = {
  NEON_BRANCH: 'photos',
  DATABASE_URL_UNPOOLED: `postgresql://user:secret@${DB_HOST}/neondb?sslmode=require`,
  AWS_ENDPOINT_URL_S3: `https://${STORAGE_HOST}`,
  AWS_ACCESS_KEY_ID: 'key id',
  AWS_SECRET_ACCESS_KEY: 'secret key'
};
const REAL_RUN = { dryRun: false, reportGps: false };

/** A refusal's message, failing the test when `fn` doesn't throw a Refusal. */
function refusal(fn) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(Refusal);
    return error.message;
  }
  throw new Error('expected a Refusal');
}

/** Runs the script with only `env` (and PATH). → { status, stdout, stderr } */
const run = (args, env) => spawnSync(process.execPath, [SCRIPT, ...args], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });

describe('backfillMedia parseArgs', () => {
  it('reads --dry-run, --report-gps and --confirm <host>', () => {
    expect(parseArgs([])).toEqual({ dryRun: false, reportGps: false });
    expect(parseArgs(['--dry-run'])).toEqual({ dryRun: true, reportGps: false });
    expect(parseArgs(['--report-gps'])).toEqual({ dryRun: false, reportGps: true });
    expect(parseArgs(['--confirm', DB_HOST])).toEqual({ dryRun: false, reportGps: false, confirm: DB_HOST });
  });

  it('refuses anything else, so a mistyped --dry-run never writes', () => {
    for (const argv of [['--dryrun'], ['--dry-run=true'], ['dry-run'], ['--dry-run', '--dry-run'], ['--report-gps', '--dry-run'],
      ['--confirm'], ['--confirm', ''], ['--confirm', '--dry-run'], ['--confirm', 'a', '--confirm', 'a'],
      ['--dry-run', '--confirm', DB_HOST], ['--report-gps', '--confirm', DB_HOST]]) {
      expect(() => parseArgs(argv), argv.join(' ')).toThrow(Refusal);
    }
  });
});

describe('backfillMedia checkNpmFlags', () => {
  it("refuses when npm took the script's options as its own (no -- before them)", () => {
    for (const name of ['npm_config_dry_run', 'npm_config_report_gps', 'npm_config_confirm']) {
      expect(refusal(() => checkNpmFlags({ [name]: 'true' }))).toMatch(/npm run backfill-media -- --dry-run/);
      expect(() => checkNpmFlags({ [name]: '' }), `${name} set but empty`).toThrow(Refusal);
    }
    expect(() => checkNpmFlags({ npm_config_cache: '/tmp' })).not.toThrow();
  });
});

describe('backfillMedia settings', () => {
  it('names the branch, the database host and the storage host, even when some are unset', () => {
    expect(describeSettings(settingsFrom(ENV))).toBe(`branch photos, database ${DB_HOST}, storage ${STORAGE_HOST}`);
    expect(describeSettings(settingsFrom({ DATABASE_URL_UNPOOLED: 'not a url' })))
      .toBe('branch (unset), database (unset), storage (unset)');
  });

  it('refuses without the database URL, or any of the bucket settings (no fallback to ~/.aws)', () => {
    const without = (name) => ({ ...ENV, [name]: undefined });
    expect(refusal(() => checkSettings(settingsFrom(without('DATABASE_URL_UNPOOLED')), without('DATABASE_URL_UNPOOLED'), REAL_RUN)))
      .toMatch(/DATABASE_URL_UNPOOLED/);
    for (const name of ['AWS_ENDPOINT_URL_S3', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']) {
      const env = without(name);
      for (const args of [REAL_RUN, { dryRun: true, reportGps: false }, { dryRun: false, reportGps: true }]) {
        expect(refusal(() => checkSettings(settingsFrom(env), env, { ...args, confirm: DB_HOST }))).toContain(name);
      }
    }
    const badEndpoint = { ...ENV, AWS_ENDPOINT_URL_S3: 'storage' };
    expect(refusal(() => checkSettings(settingsFrom(badEndpoint), badEndpoint, REAL_RUN))).toMatch(/AWS_ENDPOINT_URL_S3/);
  });

  it('needs --confirm <database host> for the real run only', () => {
    const settings = settingsFrom(ENV);
    expect(refusal(() => checkSettings(settings, ENV, REAL_RUN))).toContain(`pass --confirm ${DB_HOST}`);
    expect(refusal(() => checkSettings(settings, ENV, { ...REAL_RUN, confirm: 'ep-other.example.test' }))).toContain(`pass --confirm ${DB_HOST}`);
    expect(() => checkSettings(settings, ENV, { ...REAL_RUN, confirm: DB_HOST })).not.toThrow();
    expect(() => checkSettings(settings, ENV, { dryRun: true, reportGps: false })).not.toThrow();
    expect(() => checkSettings(settings, ENV, { dryRun: false, reportGps: true })).not.toThrow();
  });
});

describe('backfillMedia checkBranch', () => {
  const MODES = { real: true, readOnly: false };

  it("passes, in every mode, when the database's own branch id is the storage endpoint's", () => {
    for (const realRun of Object.values(MODES)) {
      expect(checkBranch({ databaseBranch: 'br-quiet-lake-a1b2c3d4', storageHost: STORAGE_HOST, branchName: null, realRun }))
        .toBe('database and bucket are both on br-quiet-lake-a1b2c3d4');
    }
  });

  it('refuses, in every mode, when they differ, whatever NEON_BRANCH says', () => {
    for (const realRun of Object.values(MODES)) {
      expect(refusal(() => checkBranch({ databaseBranch: 'br-other-b9c8d7e6', storageHost: STORAGE_HOST, branchName: 'photos', realRun })))
        .toMatch(/br-other-b9c8d7e6.*br-quiet-lake-a1b2c3d4/);
    }
  });

  const unknown = [
    { databaseBranch: null, storageHost: STORAGE_HOST },
    { databaseBranch: '', storageHost: STORAGE_HOST },
    { databaseBranch: 'br-quiet-lake-a1b2c3d4', storageHost: 'storage.example.test' }
  ];

  it("refuses a real run when either branch id can't be read, even with NEON_BRANCH set", () => {
    for (const sides of unknown) {
      expect(refusal(() => checkBranch({ ...sides, branchName: 'photos', realRun: true }))).toMatch(/real run needs .*br-/);
    }
  });

  it("lets a dry run or report go on by NEON_BRANCH, with a warning, when either id can't be read; never without it", () => {
    for (const sides of unknown) {
      expect(checkBranch({ ...sides, branchName: 'photos', realRun: false })).toMatch(/^warning: .*NEON_BRANCH=photos/);
      expect(refusal(() => checkBranch({ ...sides, branchName: null, realRun: false }))).toMatch(/NEON_BRANCH/);
    }
  });
});

describe('backfillMedia watchConnection', () => {
  it("logs and keeps the client's first error instead of crashing, until stopped", () => {
    const client = new EventEmitter();
    const lines = [];
    const watch = watchConnection(client, (line) => lines.push(line));
    expect(watch.failure()).toBeNull();
    client.emit('error', new Error('Connection terminated unexpectedly'));
    client.emit('error', new Error('again'));
    expect(watch.failure().message).toBe('Connection terminated unexpectedly');
    expect(lines).toEqual(['the database connection failed: Connection terminated unexpectedly', 'the database connection failed: again']);
    watch.stop();
    expect(client.listenerCount('error')).toBe(0);
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

describe('backfillMedia command line (refusals exit 2 before connecting)', () => {
  it('npm run backfill-media --dry-run, without --, is refused rather than run for real', () => {
    for (const name of ['npm_config_dry_run', 'npm_config_report_gps']) {
      const result = run([], { ...ENV, [name]: 'true' });
      expect(result.status, result.stderr).toBe(2);
      expect(result.stderr).toContain('npm run backfill-media -- --dry-run');
    }
  });

  it('prints the branch and both hosts, then refuses a real run without --confirm', () => {
    const result = run([], ENV);
    expect(result.status, result.stderr).toBe(2);
    expect(result.stdout).toContain(`branch photos, database ${DB_HOST}, storage ${STORAGE_HOST}`);
    expect(result.stderr).toContain(`pass --confirm ${DB_HOST}`);
    expect(`${result.stdout}${result.stderr}`).not.toContain('secret');
  });

  it('refuses a dry run without the bucket credentials, and an unknown argument', () => {
    const noSecret = run(['--dry-run'], { ...ENV, AWS_SECRET_ACCESS_KEY: '' });
    expect(noSecret.status, noSecret.stderr).toBe(2);
    expect(noSecret.stderr).toContain('AWS_SECRET_ACCESS_KEY');
    const typo = run(['--dryrun'], ENV);
    expect(typo.status, typo.stderr).toBe(2);
    expect(typo.stderr).toContain('--dryrun');
  });
});
