/**
 * Smoke test of the photo commands on a development branch (photos plan, Task 8), against the deployed api and
 * media Functions. Signs in as the dev editor, then: uploads and processes a JPEG with GPS; add_photos for I1,
 * tagged with a relative and captioned with an email address; checks the editor's view and the anonymous one (the
 * address masked); update_photo, then the same call again (409 stale); /avatars and set_avatar; /undo twice and
 * /redo twice; remove_photo; clear_avatar.
 *
 *   node --env-file=.env.local --env-file=.env.dev-accounts.local scripts/neon/smokePhotos.js [--media-url <url>]
 *
 * Env: as smokeMedia.js, whose sign-in, upload and checks it reuses. Refuses production and main.
 *
 * Then it leaves the branch tidy: /undo until its first change is undone, checking before each one that the edit
 * /undo would pick is one this run made (it never undoes another), and that I1's photos and avatar are as before.
 * The changes stay in History, and the uploaded objects in the branch's bucket.
 *
 * Prints a PASS or FAIL line per check, with statuses, ids and shapes only: never a presigned URL, token or password.
 * Exits 1 on any failure, or 2 when it can't start.
 */
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { EMAIL_MASK } from '../../api/privacy.js';
import { AVATAR_KEY } from '../../api/commands/photos.js';
import { hasLocation } from '../../media/imaging.js';
import { isMain } from './cli.js';
import {
  CROP, EDITOR_EMAIL, branchFunctions, call, check, checkMedia, codeOf, describe, gpsJpeg, runSmoke, safeMessage, signIn, trimSlash,
  upload
} from './smokeMedia.js';

const PERSON = 'I1';
const FILE_NAME = 'smoke-photos.jpg';
const CAPTION = 'Smoke test photo: ask a@b.com';
const EDITED = 'Smoke test photo, edited: ask a@b.com';
const CHANGES_PAGE = 50;
const TOGGLE_KINDS = ['undo', 'redo'];

/** The ids of the edits (via 'edit') this run recorded, oldest first: only these may be undone. */
const made = [];

const sameIds = (a, b) => Array.isArray(a) && a.length === b.length && [...a].sort().join() === [...b].sort().join();
const photoIn = (person, mediaId) => person?.photos?.find((photo) => photo.id === mediaId) ?? null;
const photoIds = (person) => (person?.photos ?? []).map((photo) => photo.id);
const label = (value) => (value === null || value === undefined ? 'none' : String(value));

/** POSTs one command to /changes, remembering the change it records. → the response, as call() */
async function runCommand(api, token, kind, params) {
  const result = await call('POST', `${api}/changes`, { token, body: { kind, params } });
  const id = result.body?.change?.id;
  if (result.status === 200 && Number.isSafeInteger(id)) made.push(id);
  return result;
}

/** A command's response, briefly: its status and the change it recorded, or its error code. */
const commandDetail = (result) => (result.status === 200
  ? `200, change ${result.body?.change?.id}`
  : `${result.status} ${codeOf(result)}`);

/** GET /person/<id>, as the editor with `token`, or anonymously. → { status, masked, person (or null) } */
async function viewOf(api, id, token) {
  const result = await call('GET', `${api}/person/${id}`, { token });
  return { status: result.status, masked: result.body?.masked, person: result.status === 200 ? result.body?.person ?? null : null };
}

/** A toggle's response, briefly: the toggle's change and its base, or the error code (with blocking ids, for 409). */
function toggleDetail(result) {
  if (result.status !== 200) {
    const blocking = (result.body?.blocking ?? []).map((entry) => `${entry.action} ${entry.id}`).join(', ');
    return `${result.status} ${codeOf(result)}${blocking ? ` (blocking: ${blocking})` : ''}`;
  }
  const change = result.body?.change;
  return change ? `200, ${change.kind} ${change.id} of change ${change.baseChangeId}` : '200, nothing to do';
}

/**
 * POSTs /undo or /redo and checks it toggled change `base`, then checks the editor's view with
 * `expect(person)` (→ a detail string, or null when the view is as expected).
 */
async function toggleAndCheck(api, token, action, base, what, expect) {
  const result = await call('POST', `${api}/${action}`, { token });
  const change = result.body?.change;
  const toggled = result.status === 200 && change?.kind === action && change?.baseChangeId === base;
  const view = toggled ? await viewOf(api, PERSON, token) : null;
  const problem = view ? expect(view.person) : null;
  return check(`/${action} ${what}`, toggled && view.status === 200 && problem === null,
    `${toggleDetail(result)}${toggled ? '' : `, wanted ${action} of ${base}`}${problem ? `; ${problem}` : ''}`);
}

/**
 * The id of the edit POST /undo would pick now (undo_last: the dev editor's latest change via 'edit', not a toggle,
 * not undone), from GET /changes, newest first. → the id, or null when there is none this run could have made (none
 * at or after `floor`, its first change). Throws when /changes fails.
 */
async function nextUndo(api, token, floor) {
  let before = null;
  for (;;) {
    const query = `limit=${CHANGES_PAGE}${before === null ? '' : `&before=${before}`}`;
    const page = await call('GET', `${api}/changes?${query}`, { token });
    if (page.status !== 200 || !Array.isArray(page.body?.changes)) throw new Error(`GET /changes: ${describe(page)}`);
    const { changes } = page.body;
    const target = changes.find((change) => change.authorEmail === EDITOR_EMAIL && change.via === 'edit'
      && !TOGGLE_KINDS.includes(change.kind) && !change.undone);
    if (target) return target.id;
    if (changes.length < CHANGES_PAGE || changes.at(-1).id < floor) return null;
    before = changes.at(-1).id;
  }
}

/**
 * Undoes this run's edits with POST /undo, newest first, until its first change is undone. Before each, it checks
 * that /undo would pick one of this run's edits; otherwise it stops and says which are still in effect.
 */
async function cleanUp(api, token) {
  if (made.length === 0) {
    console.log('clean-up: this run recorded no changes');
    return true;
  }
  const first = made[0];
  const name = `clean-up: /undo until change ${first} (the first of ${made.join(', ')}) is undone`;
  const undid = [];
  for (let attempt = 0; attempt <= made.length; attempt++) {
    const next = await nextUndo(api, token, first);
    if (!made.includes(next)) {
      const why = next === null ? 'no edit of this run is left to undo' : `the next /undo would undo change ${next}, which this run didn't make`;
      return check(name, false, `${why}; stopped after undoing ${undid.join(', ') || 'none'}`);
    }
    const result = await call('POST', `${api}/undo`, { token });
    const change = result.body?.change;
    if (result.status !== 200 || !change || change.baseChangeId !== next) {
      return check(name, false, `/undo for change ${next}: ${toggleDetail(result)}; stopped after undoing ${undid.join(', ') || 'none'}`);
    }
    undid.push(next);
    console.log(`clean-up: undo ${change.id} of change ${next}`);
    if (next === first) return check(name, true, `undid ${undid.join(', ')}`);
  }
  return check(name, false, `still not undone after ${made.length + 1} undos (undid ${undid.join(', ')})`);
}

/** The flow of the plan's Step 2, items 1–10. `before` is I1's view (as the editor) before any change. */
async function photoFlow({ api, media, token, before, relative }) {
  // 1. A JPEG with GPS, uploaded and processed.
  const jpeg = await gpsJpeg();
  const sha256 = createHash('sha256').update(jpeg).digest('hex');
  check('the test JPEG carries location', hasLocation(await sharp(jpeg).metadata()), `${jpeg.length} bytes`);
  const uploadId = await upload(media, token, jpeg, FILE_NAME, 'upload');
  if (!uploadId) return;
  const processed = await call('POST', `${media}/uploads/${uploadId}/process`, { token, body: { fileName: FILE_NAME } });
  if (!check('POST /uploads/<id>/process', processed.status === 200, describe(processed))) return;
  const stored = processed.body?.media ?? null;
  if (!checkMedia('process: the media shape', stored, { sha256, fileName: FILE_NAME })) return;

  // 2. add_photos for I1, tagged with the relative, captioned with an address.
  const people = [PERSON, relative];
  const added = await runCommand(api, token, 'add_photos', {
    personId: PERSON,
    photos: [{ upload: { sha256, ext: 'jpg', fileName: FILE_NAME }, caption: CAPTION, personIds: people }]
  });
  if (!check(`add_photos for ${PERSON}, tagged with ${relative}`, added.status === 200, commandDetail(added))) return;

  // 3. The editor's view: the photo first, with its display image, both people, and the caption as written.
  const editorView = await viewOf(api, PERSON, token);
  const first = editorView.person?.photos?.[0] ?? null;
  const mediaId = first?.key === stored.objectKey && Number.isSafeInteger(first?.id) ? first.id : null;
  check('editor GET /person/I1: the new photo is first', editorView.status === 200 && editorView.masked === false && mediaId !== null,
    `${editorView.status}, masked ${editorView.masked}, ${editorView.person?.photos?.length ?? 0} photos, first ${first?.key === stored.objectKey ? `media ${mediaId}` : 'another photo'}`);
  if (mediaId === null) return;
  check('editor view: the photo has displayKey', first.displayKey === stored.displayKey, `displayKey ${first.displayKey === stored.displayKey ? 'display/<sha>.webp' : label(first.displayKey)}`);
  const tagged = (first.people ?? []).map((person) => person.id);
  check(`editor view: people is ${PERSON} and ${relative}`, sameIds(tagged, people), `people ${tagged.join(', ') || 'none'}`);
  check('editor view: the caption is set, unmasked', first.caption === CAPTION, first.caption === CAPTION ? 'as written' : `caption ${JSON.stringify(first.caption)}`);

  // 4. The anonymous view masks the address in the caption.
  const anonymous = await viewOf(api, PERSON);
  const anonymousCaption = photoIn(anonymous.person, mediaId)?.caption;
  const maskedCaption = CAPTION.replace('a@b.com', EMAIL_MASK);
  check('anonymous GET /person/I1: the caption\'s address is masked', anonymous.status === 200 && anonymous.masked === true
    && anonymousCaption === maskedCaption, `${anonymous.status}, masked ${anonymous.masked}, caption ${JSON.stringify(anonymousCaption ?? null)}`);

  // 5. update_photo changes the caption; the same call again, with the old `expected`, is stale.
  const edit = {
    mediaId, caption: EDITED, date: null, personIds: people,
    expected: { caption: CAPTION, date: null, personIds: people }, focusId: PERSON
  };
  const updated = await runCommand(api, token, 'update_photo', edit);
  const updatedCaption = photoIn(updated.body?.view?.person, mediaId)?.caption;
  const updateOk = check('update_photo: the caption is changed', updated.status === 200 && updatedCaption === EDITED,
    `${commandDetail(updated)}, caption ${updatedCaption === EDITED ? 'edited' : JSON.stringify(updatedCaption ?? null)}`);
  const updateId = updateOk ? updated.body.change.id : null;
  const again = await runCommand(api, token, 'update_photo', edit);
  check('update_photo again with the old expected: 409 stale', again.status === 409 && again.body?.error === 'stale', commandDetail(again));

  // 6. An avatar from the photo: the view's avatarKey is the key /avatars returned.
  const avatar = await call('POST', `${media}/avatars`, { token, body: { objectKey: stored.objectKey, crop: CROP } });
  const avatarKey = avatar.body?.avatarKey;
  if (!check('POST /avatars', avatar.status === 200 && AVATAR_KEY.test(avatarKey ?? ''), describe(avatar))) return;
  const setAvatar = await runCommand(api, token, 'set_avatar', { personId: PERSON, mediaId, crop: CROP, avatarKey });
  const afterSet = setAvatar.status === 200 ? await viewOf(api, PERSON, token) : null;
  const setOk = check('set_avatar: the view\'s avatarKey is the returned key', setAvatar.status === 200
    && setAvatar.body?.view?.person?.avatarKey === avatarKey && afterSet?.person?.avatarKey === avatarKey
    && afterSet?.person?.avatarSource?.mediaId === mediaId,
  `${commandDetail(setAvatar)}, avatarKey ${afterSet?.person?.avatarKey === avatarKey ? 'the returned key' : label(afterSet?.person?.avatarKey)}, avatarSource.mediaId ${label(afterSet?.person?.avatarSource?.mediaId)}`);
  if (!setOk || updateId === null) return;
  const setId = setAvatar.body.change.id;

  // 7. Two undos: the avatar edit, then the caption edit.
  const avatarIs = (key) => (person) => (person?.avatarKey === key ? null : `avatarKey ${person?.avatarKey === avatarKey ? 'the new avatar' : label(person?.avatarKey)}`);
  const captionIs = (caption) => (person) => {
    const now = photoIn(person, mediaId)?.caption;
    return now === caption ? null : `caption ${JSON.stringify(now ?? null)}`;
  };
  const both = (...checks) => (person) => checks.map((one) => one(person)).filter(Boolean).join(', ') || null;
  if (!await toggleAndCheck(api, token, 'undo', setId, 'reverts the avatar', both(avatarIs(before.avatarKey), captionIs(EDITED)))) return;
  if (!await toggleAndCheck(api, token, 'undo', updateId, 'reverts the caption', both(captionIs(CAPTION), avatarIs(before.avatarKey)))) return;

  // 8. Redo, latest undo first: the caption, then the avatar (so 10 has an avatar to clear).
  if (!await toggleAndCheck(api, token, 'redo', updateId, 'restores the caption', both(captionIs(EDITED), avatarIs(before.avatarKey)))) return;
  if (!await toggleAndCheck(api, token, 'redo', setId, 'restores the avatar', both(avatarIs(avatarKey), captionIs(EDITED)))) return;

  // 9. remove_photo: the photo is no longer shown for I1.
  const removed = await runCommand(api, token, 'remove_photo', { personId: PERSON, mediaId });
  const removedView = removed.body?.view?.person;
  check('remove_photo: the photo is gone from I1\'s view', removed.status === 200 && removedView && photoIn(removedView, mediaId) === null,
    `${commandDetail(removed)}, ${removedView ? `${removedView.photos.length} photos` : 'no view'}`);

  // 10. clear_avatar: no avatar.
  const cleared = await runCommand(api, token, 'clear_avatar', { personId: PERSON });
  const clearedView = cleared.body?.view?.person;
  check('clear_avatar: the view has no avatar', cleared.status === 200 && clearedView?.avatarKey === null && !('avatarSource' in clearedView),
    `${commandDetail(cleared)}, avatarKey ${label(clearedView?.avatarKey)}, avatarSource ${clearedView && 'avatarSource' in clearedView ? 'present' : 'absent'}`);
}

async function main() {
  const { env, api, media } = branchFunctions();
  console.log(`branch ${env.NEON_BRANCH}, api Function ${new URL(api).host}, media Function ${new URL(media).host}`);

  const token = await signIn(trimSlash(env.NEON_AUTH_BASE_URL), env.DEV_EDITOR_PASSWORD);
  if (!token) return;
  const me = await call('GET', `${api}/me`, { token });
  if (!check('api GET /me: an editor', me.status === 200 && ['editor', 'admin'].includes(me.body?.role) && me.body?.email === EDITOR_EMAIL,
    `${me.status} ${me.status === 200 ? `role ${me.body?.role}` : codeOf(me)}`)) return;

  // I1 before any change, and a relative from their view to tag.
  const before = await viewOf(api, PERSON, token);
  const relative = before.person?.parentIds?.[0] ?? before.person?.spouseIds?.[0] ?? null;
  if (!check(`editor GET /person/${PERSON} before: a parent or spouse to tag`, before.status === 200 && relative !== null,
    `${before.status}, ${photoIds(before.person).length} photos, avatar ${before.person?.avatarKey ? 'set' : 'none'}, tagging ${label(relative)}`)) return;
  const relativeBefore = await viewOf(api, relative, token);

  try {
    await photoFlow({ api, media, token, before: before.person, relative });
  } catch (error) {
    check('photo flow: no unexpected error', false, `${error?.name ?? 'Error'}: ${safeMessage(error)}`);
  }

  // 11. Tidy: every change this run made undone, and I1 and the relative as before.
  if (await cleanUp(api, token) && made.length > 0) {
    const [after, relativeAfter] = await Promise.all([viewOf(api, PERSON, token), viewOf(api, relative, token)]);
    check(`after clean-up: ${PERSON}'s and ${relative}'s photos and avatars are as before`,
      after.status === 200 && relativeAfter.status === 200
      && photoIds(after.person).join() === photoIds(before.person).join()
      && photoIds(relativeAfter.person).join() === photoIds(relativeBefore.person).join()
      && after.person.avatarKey === before.person.avatarKey && relativeAfter.person.avatarKey === relativeBefore.person?.avatarKey,
    `${PERSON}: ${photoIds(after.person).length} photos (was ${photoIds(before.person).length}), avatar ${after.person?.avatarKey === before.person.avatarKey ? 'as before' : 'changed'}; `
      + `${relative}: ${photoIds(relativeAfter.person).length} photos (was ${photoIds(relativeBefore.person).length})`);
  }
}

if (isMain(import.meta.url)) await runSmoke(main);
