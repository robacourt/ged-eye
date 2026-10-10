/**
 * Change avatar: choose one of the person's photos, or upload a new one, then crop it in a circle
 * (avatarCropper.js). Saving renders the crop with the media Function and sends `set_avatar`; "Remove avatar"
 * sends `clear_avatar`. Like every editor dialog, it is full screen below 768px, with its actions in a bar at the
 * bottom.
 *
 * Every data value is set with `textContent` or as an attribute, never as HTML.
 */
import { showToast } from './toast.js';
import {
  VISUALLY_HIDDEN, el, openEditorDialog, uniqueId, callSafely, setBusy, commandErrorMessage
} from './editorDialog.js';
import { nameOf } from './familyLinks.js';
import { displayUrl, thumbUrl } from './media.js';
import { clearAvatarParams, setAvatarParams } from './photoParams.js';
import { createUploadQueue } from './uploadQueue.js';
import { uploadErrorMessage } from './uploadMessages.js';
import { createAvatarCropper } from './avatarCropper.js';

const LOAD_FAILED = "Couldn't load the photo. Check your connection, then retry.";

/** Whether a photo can be made into an avatar: set_avatar needs an image with a display image (so no PDFs, and
 * TIFFs only once they're backfilled). */
const canBeAvatar = (photo) => Boolean(photo?.displayKey);

/** Why a processed upload (mediaApi.processUpload's `media`) can't be an avatar, or null when it can. */
function refusalOf(media) {
  if (canBeAvatar(media)) return null;
  if (media?.contentType === 'application/pdf') return "A PDF can't be an avatar: choose a photo.";
  if (media?.mediaId !== null && media?.mediaId !== undefined) {
    return "This photo is already in the tree but hasn't been prepared for viewing yet, so it can't be an avatar.";
  }
  return "This file can't be an avatar: choose a photo.";
}

function uploadStatusText(item) {
  switch (item.state) {
    case 'queued': return 'Waiting to upload…';
    case 'uploading': return `Uploading ${Math.round((item.progress ?? 0) * 100)}%`;
    case 'processing': return 'Processing…';
    case 'failed': return uploadErrorMessage(item.error);
    default: return refusalOf(item.media) ?? 'Ready';
  }
}

/**
 * Opens Change avatar.
 * @param person         the person record (person_record's: `photos`, `avatarKey`, `avatarSource`)
 * @param api            `{ runChange }` (editApi.js)
 * @param mediaApi       `{ requestUpload, uploadFile, processUpload, discardUpload, renderAvatar }` (mediaApi.js)
 * @param startWith      optional: one of the person's photos to open straight at the crop step for (the viewer's
 *                       Avatar button). One with no display image opens at the photos instead.
 * @param onSaved        ({ change, view }) after set_avatar or clear_avatar: the caller invalidates caches,
 *                       re-renders and toasts
 * @param createCropper  makes the cropper, as createAvatarCropper does (the default)
 * @param createQueue    makes the upload queue for "Upload new", as createUploadQueue does (the default)
 * @returns `{ close, isOpen, element }`; `close()` discards any upload, without asking
 */
export function openAvatarDialog({
  person, api, mediaApi, startWith = null, onSaved, createCropper = createAvatarCropper, createQueue = createUploadQueue
}) {
  const name = nameOf(person);
  const saved = person.avatarSource ?? null; // { mediaId, crop } of the current avatar
  const photos = (person.photos ?? []).filter(canBeAvatar);
  let view = 'pick'; // or 'upload', 'crop' or 'confirm'
  let confirming = null; // what the confirm view asks: 'remove' (the avatar) or 'close' (stop uploading?)
  let busy = false;
  let closed = false;
  let warning = false; // whether the beforeunload warning is registered
  let choice = null; // the photo being cropped: { source, objectKey, imageUrl, initialCrop, returnFocus }
  let cropper = null;
  let cropReady = false;
  let retryAction = null;
  let lastUploadState = null;
  let keptCrop = null; // the crop of a new upload that has to be uploaded again, to start from once it's back

  const dialog = openEditorDialog({ title: `Change avatar for ${name}`, className: 'avatar-dialog', onRequestClose: requestClose });

  // --- Step 1: the photos ---------------------------------------------------------------------------------

  const isCurrent = (photo) => saved !== null && photo.id === saved.mediaId;
  const tiles = new Map(); // media id -> tile

  function photoTile(photo) {
    const current = isCurrent(photo);
    const label = String(photo.caption || photo.fileName || 'Photo');
    const tile = el('button', {
      type: 'button',
      class: `avatar-photo${current ? ' avatar-photo-is-current' : ''}`,
      'data-media-id': String(photo.id),
      'aria-label': current ? `${label}, the current avatar` : label,
      'aria-current': current ? 'true' : null
    }, el('img', { src: thumbUrl(photo) ?? displayUrl(photo), alt: '' }),
    current ? el('span', { class: 'avatar-photo-current', 'aria-hidden': 'true', text: 'Current' }) : null);
    tile.addEventListener('click', () => choosePhoto(photo));
    tiles.set(photo.id, tile);
    return el('li', {}, tile);
  }

  const uploadTile = el('button', { type: 'button', class: 'avatar-upload-tile' },
    el('span', { class: 'avatar-upload-plus', 'aria-hidden': 'true', text: '+' }),
    el('span', { text: 'Upload new' }));
  const grid = el('ul', { class: 'avatar-photos', 'aria-label': 'Photos' },
    ...photos.map(photoTile), el('li', {}, uploadTile));
  const pickView = el('div', { class: 'avatar-pick' },
    el('p', {
      class: 'editor-hint avatar-pick-hint',
      text: photos.length ? 'Choose a photo to crop, or upload a new one.' : `${name} has no photos to use yet. Upload one.`
    }),
    grid);

  // --- Uploading a new photo ------------------------------------------------------------------------------

  const uploadName = el('p', { class: 'avatar-upload-name' });
  const uploadStatus = el('p', { class: 'avatar-upload-status' });
  const uploadProgress = el('progress', { class: 'avatar-upload-progress', max: '1', value: '0', 'aria-label': 'Upload progress' });
  const uploadRetry = el('button', { type: 'button', class: 'editor-btn avatar-upload-retry', text: 'Retry', hidden: true });
  const uploadView = el('div', { class: 'avatar-upload', tabindex: '-1', hidden: true },
    uploadName, uploadStatus, uploadProgress, uploadRetry);

  // --- Step 2: the crop -----------------------------------------------------------------------------------

  const cropArea = el('div', { class: 'avatar-crop-area' });
  const cropView = el('div', { class: 'avatar-crop', hidden: true }, cropArea);

  // --- Confirmations --------------------------------------------------------------------------------------

  const confirmText = el('p', { class: 'avatar-confirm-text', id: uniqueId('avatar-confirm') });
  const confirmView = el('div', { class: 'avatar-confirm', hidden: true }, confirmText);

  // --- The action bar -------------------------------------------------------------------------------------

  const spacer = () => el('span', { class: 'editor-actions-spacer' });
  const messageText = el('p', { class: 'editor-error', role: 'alert' });
  const retryButton = el('button', { type: 'button', class: 'editor-btn avatar-retry', text: 'Retry' });
  const message = el('div', { class: 'editor-form-message', hidden: true }, messageText, retryButton);

  const removeButton = el('button', {
    type: 'button', class: 'editor-btn editor-btn-danger avatar-remove', text: 'Remove avatar', hidden: !person.avatarKey
  });
  const cancelButton = el('button', { type: 'button', class: 'editor-btn avatar-cancel', text: 'Cancel' });
  const uploadBack = el('button', { type: 'button', class: 'editor-btn avatar-upload-back', text: 'Back' });
  const backButton = el('button', { type: 'button', class: 'editor-btn avatar-back', text: 'Back' });
  const saveButton = el('button', { type: 'button', class: 'editor-btn editor-btn-primary avatar-save', text: 'Use as avatar', disabled: true });
  const noButton = el('button', { type: 'button', class: 'editor-btn avatar-confirm-no' });
  const yesButton = el('button', {
    type: 'button', class: 'editor-btn editor-btn-danger-solid avatar-confirm-yes', 'aria-describedby': confirmText.id
  });
  const actions = {
    pick: el('div', { class: 'editor-actions' }, removeButton, spacer(), cancelButton),
    upload: el('div', { class: 'editor-actions', hidden: true }, uploadBack, spacer()),
    crop: el('div', { class: 'editor-actions', hidden: true }, backButton, spacer(), saveButton),
    confirm: el('div', { class: 'editor-actions', hidden: true }, spacer(), noButton, yesButton)
  };
  const views = { pick: pickView, upload: uploadView, crop: cropView, confirm: confirmView };

  const announcer = el('p', { class: 'avatar-announcer', 'aria-live': 'polite', style: VISUALLY_HIDDEN });
  const root = el('div', { class: 'avatar-form' },
    pickView, uploadView, cropView, confirmView, announcer,
    el('div', { class: 'editor-dialog-footer avatar-actions' }, message, ...Object.values(actions)));
  dialog.body.append(root);

  // The picker's input lives in the sheet (a detached input is unreliable in some Safari versions), outside the
  // dialog itself so the focus trap never lands on it; the Upload new tile is its accessible control. No `capture`,
  // so a phone offers its library, camera and files.
  const input = el('input', {
    type: 'file', class: 'avatar-input', accept: 'image/*', tabindex: '-1', 'aria-hidden': 'true', style: VISUALLY_HIDDEN
  });
  dialog.backdrop.append(input);

  const queue = createQueue({ api: mediaApi, concurrency: 1, onChange: renderUpload });

  // --- Views and messages ---------------------------------------------------------------------------------

  function showView(next) {
    view = next;
    for (const [key, element] of Object.entries(views)) element.hidden = key !== next;
    for (const [key, element] of Object.entries(actions)) element.hidden = key !== next;
    if (next === 'confirm') dialog.dialog.setAttribute('aria-describedby', confirmText.id);
    else dialog.dialog.removeAttribute('aria-describedby');
  }

  /** Shows `text` in the action bar, with Retry running `retry` when given. */
  function showMessage(text, retry = null) {
    messageText.textContent = text;
    retryButton.hidden = !retry;
    retryAction = retry;
    message.hidden = false;
  }

  function clearMessage() {
    message.hidden = true;
    messageText.textContent = '';
    retryAction = null;
  }

  // --- Cropping -------------------------------------------------------------------------------------------

  function choosePhoto(photo) {
    startCrop({
      source: { mediaId: photo.id },
      objectKey: photo.key,
      imageUrl: displayUrl(photo),
      initialCrop: isCurrent(photo) ? saved.crop ?? null : null,
      returnFocus: tiles.get(photo.id) ?? uploadTile
    });
  }

  function cropUpload(media) {
    const current = saved !== null && media.mediaId !== null && media.mediaId !== undefined && media.mediaId === saved.mediaId;
    const initialCrop = keptCrop ?? (current ? saved.crop ?? null : null);
    keptCrop = null;
    startCrop({ source: { media }, objectKey: media.objectKey, imageUrl: displayUrl(media), initialCrop, returnFocus: uploadTile });
  }

  function startCrop(next) {
    clearMessage();
    choice = next;
    showView('crop');
    mountCropper();
  }

  /** (Re)makes the cropper for `choice`; Use as avatar waits until its photo has loaded. */
  function mountCropper() {
    unmountCropper();
    saveButton.disabled = true;
    const made = createCropper({
      imageUrl: choice.imageUrl,
      initialCrop: choice.initialCrop,
      onReady: () => {
        if (cropper !== made || closed) return;
        cropReady = true;
        saveButton.disabled = false;
      },
      onError: () => {
        if (cropper === made && !closed) showMessage(LOAD_FAILED, mountCropper);
      }
    });
    cropper = made;
    cropArea.replaceChildren(made.element);
    (made.element.querySelector('.avatar-cropper-area') ?? dialog.dialog).focus();
  }

  function unmountCropper() {
    if (!cropper) return;
    const old = cropper;
    cropper = null;
    cropReady = false;
    old.destroy();
    cropArea.replaceChildren();
  }

  /** Back to the photos, from cropping or uploading: an upload that wasn't saved is dropped. */
  function backToPhotos() {
    if (closed || busy) return;
    const focus = choice?.returnFocus ?? uploadTile;
    clearMessage();
    unmountCropper();
    queue.cancel();
    choice = null;
    keptCrop = null;
    showView('pick');
    focus.focus();
  }

  // --- Uploading ------------------------------------------------------------------------------------------

  function startUpload(file) {
    clearMessage();
    queue.cancel();
    lastUploadState = null;
    keptCrop = null;
    uploadName.textContent = file.name;
    showView('upload');
    uploadView.focus();
    queue.add([file]);
  }

  function renderUpload(items) {
    if (closed) return;
    syncUnloadWarning();
    const item = items[0];
    if (!item) return;
    const text = uploadStatusText(item);
    const refused = item.state === 'ready' && refusalOf(item.media) !== null;
    const failed = item.state === 'failed';
    uploadStatus.textContent = text;
    uploadStatus.classList.toggle('avatar-upload-status-error', failed || refused);
    uploadProgress.hidden = item.state !== 'uploading';
    uploadProgress.value = item.progress ?? 0;
    uploadRetry.hidden = !(failed && item.retryable);
    if (item.state !== lastUploadState && (failed || refused)) announcer.textContent = text;
    lastUploadState = item.state;
    if (item.state === 'ready' && !refused && view === 'upload') cropUpload(item.media);
  }

  function onBeforeUnload(event) {
    if (!dialog.isOpen()) { // removed from the page without closing: stop listening
      window.removeEventListener('beforeunload', onBeforeUnload);
      warning = false;
      return;
    }
    if (!queue.hasActive()) return;
    event.preventDefault();
    event.returnValue = ''; // older browsers
  }

  /** Warns before leaving the page only while uploading, so the page stays in the back/forward cache otherwise. */
  function syncUnloadWarning() {
    const active = !closed && queue.hasActive();
    if (active === warning) return;
    warning = active;
    if (active) window.addEventListener('beforeunload', onBeforeUnload);
    else window.removeEventListener('beforeunload', onBeforeUnload);
  }

  // --- Saving ---------------------------------------------------------------------------------------------

  /** The words for a failed render or set_avatar. */
  function saveErrorMessage(error) {
    if (error?.code === 'invalid') {
      return error.message && error.message !== error.code ? error.message : "This photo can't be used as an avatar.";
    }
    if (error?.code === 'busy') return 'The server is busy. Try again in a moment.';
    if (error?.code === 'missing_upload') return 'The avatar went missing while it was saved. Try again.';
    if (error?.code === 'not_found') {
      return error.field === 'personId'
        ? `${name} no longer exists: someone else deleted them.`
        : 'This photo no longer exists: someone else deleted it.';
    }
    return commandErrorMessage(error);
  }

  /**
   * The new upload has gone from storage (set_avatar's missing_upload for `photo`): it fails, back in the upload
   * view, so that Retry uploads it again, and the crop starts where it was once it's back. → whether it did.
   */
  function uploadAgain(error, crop) {
    const [item] = queue.items();
    if (item?.state !== 'ready') return false;
    unmountCropper();
    keptCrop = crop;
    showView('upload');
    queue.markFailed(item, error); // renders the failure, with Retry
    uploadView.focus();
    return true;
  }

  /** Renders the crop of the original, then makes it the avatar with set_avatar. */
  async function save() {
    if (closed || busy || view !== 'crop' || !cropReady) return;
    const crop = cropper.getCrop();
    if (!crop) return;
    const { source, objectKey } = choice;
    clearMessage();
    busy = true;
    setBusy(root, true, saveButton, 'Saving…');
    let result;
    try {
      const avatarKey = await mediaApi.renderAvatar(objectKey, crop);
      result = await api.runChange('set_avatar', setAvatarParams(person.id, source, crop, avatarKey));
    } catch (error) {
      busy = false;
      if (closed) return;
      setBusy(root, false, saveButton);
      if (error?.code === 'no_change') {
        showToast('Avatar unchanged');
        finish();
        return;
      }
      if (error?.code === 'missing_upload' && source.media && error.field !== 'avatarKey' && uploadAgain(error, crop)) return;
      showMessage(saveErrorMessage(error), save);
      return;
    }
    busy = false;
    finish();
    callSafely(onSaved, result);
  }

  // --- Removing -------------------------------------------------------------------------------------------

  function askToRemove() {
    if (closed || busy) return;
    clearMessage();
    confirming = 'remove';
    confirmText.textContent = `Remove the avatar of ${name}?${saved ? ' The photo stays in their photos.' : ''}`;
    noButton.textContent = 'Cancel';
    yesButton.textContent = 'Remove avatar';
    showView('confirm');
    noButton.focus();
  }

  async function removeAvatar() {
    if (closed || busy) return;
    clearMessage();
    busy = true;
    setBusy(root, true, yesButton, 'Removing…');
    let result;
    try {
      result = await api.runChange('clear_avatar', clearAvatarParams(person.id));
    } catch (error) {
      busy = false;
      if (closed) return;
      setBusy(root, false, yesButton);
      if (error?.code === 'no_change') {
        showToast('The avatar was already removed');
        finish();
        return;
      }
      showMessage(commandErrorMessage(error, { missing: `${name} no longer exists: someone else deleted them.` }), removeAvatar);
      return;
    }
    busy = false;
    finish();
    callSafely(onSaved, result);
  }

  // --- Closing --------------------------------------------------------------------------------------------

  /** Escape, × and Cancel: from a confirmation, go back; while uploading, ask first. */
  function requestClose() {
    if (closed || busy) return;
    if (view === 'confirm') cancelConfirm();
    else if (queue.hasActive()) askToStopUploading();
    else finish();
  }

  function askToStopUploading() {
    clearMessage();
    confirming = 'close';
    confirmText.textContent = 'Stop uploading this photo?';
    noButton.textContent = 'Keep uploading';
    yesButton.textContent = 'Discard';
    showView('confirm');
    noButton.focus();
  }

  function cancelConfirm() {
    clearMessage();
    if (confirming === 'remove') {
      showView('pick');
      removeButton.focus();
    } else {
      showView('upload');
      uploadView.focus();
      renderUpload(queue.items()); // it may have finished meanwhile: then on to the crop
    }
    confirming = null;
  }

  /** Closes the dialog, stopping and discarding any upload. */
  function finish() {
    if (closed) return;
    closed = true;
    queue.cancel();
    syncUnloadWarning();
    unmountCropper();
    dialog.close();
  }

  // --- Wiring ---------------------------------------------------------------------------------------------

  uploadTile.addEventListener('click', () => {
    if (!closed && !busy) input.click(); // synchronously, inside the tap's own handler: iOS opens a picker only then
  });
  input.addEventListener('change', () => {
    const [file] = input.files ?? [];
    input.value = ''; // so choosing the same file again is a change
    if (file && !closed && view === 'pick') startUpload(file);
  });
  uploadRetry.addEventListener('click', () => {
    const [item] = queue.items();
    if (item) queue.retry(item);
    uploadView.focus(); // Retry has gone
  });
  uploadBack.addEventListener('click', backToPhotos);
  backButton.addEventListener('click', backToPhotos);
  saveButton.addEventListener('click', save);
  removeButton.addEventListener('click', askToRemove);
  cancelButton.addEventListener('click', requestClose);
  noButton.addEventListener('click', () => !busy && cancelConfirm());
  yesButton.addEventListener('click', () => {
    if (busy) return;
    if (confirming === 'remove') removeAvatar();
    else finish();
  });
  retryButton.addEventListener('click', () => {
    const retry = retryAction;
    clearMessage();
    retry?.();
  });

  dialog.dialog.focus();
  if (startWith && canBeAvatar(startWith)) choosePhoto(startWith);

  return { close: finish, isOpen: () => !closed && dialog.isOpen(), element: dialog.dialog };
}
