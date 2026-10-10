/**
 * The Add photos sheet: one card per file, each uploading through the upload queue (uploadQueue.js) while the
 * editor fills in its Caption, Date and "Shown for", then one `add_photos` for them all. It is full screen below
 * 768px, with the actions in a bar stuck to the bottom.
 *
 * Every data value is set with `value` or `textContent`, never as HTML.
 */
import { showToast } from './toast.js';
import {
  DATE_HINT, DATE_PLACEHOLDER, VISUALLY_HIDDEN, el, openEditorDialog, uniqueId, callSafely, setBusy, commandErrorMessage
} from './editorDialog.js';
import { nameOf } from './familyLinks.js';
import { thumbUrl } from './media.js';
import { createPersonPicker } from './personPicker.js';
import { MAX_CAPTION, MAX_DATE, MAX_PHOTOS, addPhotosParams, photoItem } from './photoParams.js';
import { createUploadQueue } from './uploadQueue.js';
import { uploadErrorMessage } from './uploadMessages.js';

/** Types every supported browser can show from an object URL; anything else previews as a document. */
const PREVIEWABLE = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif']);

const FAILED_FIRST = 'Retry or remove the photos that failed, then save.';
const NO_PHOTOS = 'Choose some photos first.';

const photosWord = (n) => (n === 1 ? '1 photo' : `${n} photos`);
/** `text` ending in a full stop, so announcements read out together stay apart. */
const sentence = (text) => (/[.?!…]$/.test(text) ? text : `${text}.`);

/**
 * Opens the sheet.
 * @param person       the person record the photos are added for (shown for them, and anyone else chosen)
 * @param files        optional Files (a FileList or array), e.g. from a drop: they start uploading at once.
 *                     Without them the file picker opens straight away, so call this from inside the tap's own
 *                     event handler, with no `await` before it: iOS only opens a picker from there.
 * @param api          `{ runChange, search }` (editApi.js)
 * @param mediaApi     `{ requestUpload, uploadFile, processUpload, discardUpload }` (mediaApi.js), for the queue
 * @param createQueue  makes the upload queue, as createUploadQueue({ api, onChange }) does (the default)
 * @param onSaved      ({ change, view }) after add_photos: the caller invalidates caches, re-renders and toasts
 * @returns `{ close, isOpen, element }`; `close()` discards any uploads, without asking
 */
export function openAddPhotosDialog({ person, files, api, mediaApi, createQueue = createUploadQueue, onSaved }) {
  const name = nameOf(person);
  const cards = new Map(); // item id -> card
  let phase = 'idle'; // or 'waiting' (for uploads to finish, then saving) or 'sending'
  let view = 'form'; // or 'confirm' (stop uploading?)
  let closed = false;
  let warning = false; // whether the beforeunload warning is registered
  let saveToken = 0; // a save waiting for uploads goes ahead only if this hasn't changed meanwhile
  let announcements = []; // waiting to be read out together
  let announceTimer = null;

  const dialog = openEditorDialog({ title: `Add photos for ${name}`, className: 'add-photos-dialog', onRequestClose: requestClose });

  // --- The sheet ------------------------------------------------------------------------------------------

  const list = el('ol', { class: 'add-photos-cards', 'aria-label': 'Photos' });
  const empty = el('p', { class: 'editor-hint add-photos-empty', text: 'No photos chosen yet.' });
  const main = el('div', { class: 'add-photos-main' },
    el('p', { class: 'editor-hint', text: `Captions and dates are shared by everyone a photo is shown for. Dates are free text, ${DATE_HINT}.` }),
    empty, list);
  const announcer = el('p', { class: 'add-photos-announcer', 'aria-live': 'polite', style: VISUALLY_HIDDEN });

  const confirmText = el('p', { class: 'add-photos-confirm-text', id: uniqueId('add-photos-confirm') });
  const confirm = el('div', { class: 'add-photos-confirm', hidden: true }, confirmText);

  const messageText = el('p', { class: 'editor-error', role: 'alert' });
  const message = el('div', { class: 'editor-form-message', hidden: true }, messageText);
  const moreButton = el('button', { type: 'button', class: 'editor-btn add-photos-more' });
  const cancelButton = el('button', { type: 'button', class: 'editor-btn add-photos-cancel', text: 'Cancel' });
  const saveButton = el('button', { type: 'submit', class: 'editor-btn editor-btn-primary add-photos-save' });
  const formActions = el('div', { class: 'editor-actions' },
    moreButton, el('span', { class: 'editor-actions-spacer' }), cancelButton, saveButton);
  const keepButton = el('button', { type: 'button', class: 'editor-btn add-photos-keep', text: 'Keep uploading' });
  const discardButton = el('button', {
    type: 'button', class: 'editor-btn editor-btn-danger-solid add-photos-discard', text: 'Discard', 'aria-describedby': confirmText.id
  });
  const confirmActions = el('div', { class: 'editor-actions', hidden: true },
    el('span', { class: 'editor-actions-spacer' }), keepButton, discardButton);

  const formElement = el('form', { class: 'editor-form add-photos-form', novalidate: true },
    main, confirm, announcer,
    el('div', { class: 'editor-dialog-footer add-photos-actions' }, message, formActions, confirmActions));
  dialog.body.append(formElement);

  // The picker's input lives in the sheet (a detached input is unreliable in some Safari versions), outside the
  // dialog itself so the focus trap never lands on it; "Add more" is its accessible control.
  const input = el('input', {
    type: 'file', class: 'add-photos-input', accept: 'image/*,application/pdf', multiple: true,
    tabindex: '-1', 'aria-hidden': 'true', style: VISUALLY_HIDDEN
  });
  dialog.backdrop.append(input);

  const queue = createQueue({ api: mediaApi, onChange: render });

  // --- Messages -------------------------------------------------------------------------------------------

  function showMessage(text) {
    messageText.textContent = text;
    message.hidden = false;
  }

  function clearMessages() {
    message.hidden = true;
    messageText.textContent = '';
    for (const card of cards.values()) {
      for (const { error, input: field } of Object.values(card.errors)) {
        error.hidden = true;
        error.textContent = '';
        field.removeAttribute('aria-invalid');
      }
    }
  }

  /** Reads out `text` politely, together with anything else announced in the same tick (cards settling at once). */
  function announce(text) {
    announcements.push(text);
    if (announceTimer !== null) return;
    announceTimer = setTimeout(() => {
      announceTimer = null;
      announcer.textContent = announcements.join(' ');
      announcements = [];
    }, 0);
  }

  // --- Cards ----------------------------------------------------------------------------------------------

  function textField(label, fieldName, { maxlength, placeholder = null }) {
    const field = el('input', { class: 'editor-input', type: 'text', name: fieldName, autocomplete: 'off', maxlength, placeholder });
    const error = el('p', { class: 'editor-error', id: uniqueId('editor-error'), role: 'alert', 'data-error-for': fieldName, hidden: true });
    // Filled in when the photo is already in the tree with a value here, which is shared and so read-only. Empty
    // until then, because a description is read out even while hidden.
    const shared = el('p', { class: 'editor-hint', id: uniqueId('add-photos-shared'), 'data-hint-for': fieldName, hidden: true });
    field.setAttribute('aria-describedby', `${error.id} ${shared.id}`);
    const wrap = el('div', { class: 'editor-field-wrap' },
      el('label', { class: 'editor-field' }, el('span', { text: label }), field), error, shared);
    return { input: field, error, shared, wrap };
  }

  function createCard(item) {
    const titleId = uniqueId('add-photos-card');
    const preview = el('div', { class: 'add-photos-preview' });
    const title = el('h3', { class: 'add-photos-card-title', id: titleId });
    const status = el('p', { class: 'add-photos-status' });
    const progress = el('progress', { class: 'add-photos-progress', max: '1', value: '0', 'aria-labelledby': titleId });
    const retryButton = el('button', { type: 'button', class: 'editor-btn add-photos-retry', text: 'Retry' });
    const removeButton = el('button', { type: 'button', class: 'editor-btn editor-btn-danger add-photos-remove', text: 'Remove' });
    const captionField = textField('Caption', 'caption', { maxlength: String(MAX_CAPTION) });
    const dateField = textField('Date', 'date', { maxlength: String(MAX_DATE), placeholder: DATE_PLACEHOLDER });
    const picker = createPersonPicker({
      api, chosen: [{ id: person.id, name: person.name ?? '' }], fixedIds: [person.id], label: 'Add someone'
    });
    const fields = el('div', { class: 'add-photos-fields' },
      el('div', { class: 'editor-grid' }, captionField.wrap, dateField.wrap),
      el('fieldset', { class: 'editor-fieldset add-photos-people' }, el('legend', { text: 'Shown for' }), picker.element));
    const element = el('li', { class: 'add-photos-card', tabindex: '-1', 'aria-labelledby': titleId },
      el('div', { class: 'add-photos-card-head' },
        preview,
        el('div', { class: 'add-photos-card-info' },
          title,
          el('p', { class: 'add-photos-file-name', text: item.file.name }),
          status, progress,
          el('div', { class: 'add-photos-card-actions' }, retryButton, removeButton))),
      fields);

    const card = {
      item, element, preview, title, status, progress, retryButton, removeButton, fields, picker,
      caption: captionField.input,
      date: dateField.input,
      errors: { caption: captionField, date: dateField },
      objectUrl: null,
      localFailed: false, // the browser couldn't show the file itself
      thumbShown: false,
      filledFor: null, // the media id whose shared caption and date are shown
      lastState: null,
      /** This card's add_photos photo; a read-only (shared) caption or date is left alone. */
      photo: () => photoItem(item.media, {
        caption: captionField.input.readOnly ? null : captionField.input.value,
        date: dateField.input.readOnly ? null : dateField.input.value,
        personIds: picker.chosen().map((someone) => someone.id)
      })
    };

    if (PREVIEWABLE.has(item.file.type) && typeof URL.createObjectURL === 'function') {
      card.objectUrl = URL.createObjectURL(item.file);
      showLocalPreview(card);
    } else {
      showDocument(card);
    }

    retryButton.addEventListener('click', () => {
      if (phase === 'sending') return;
      clearMessages();
      queue.retry(item);
      element.focus(); // Retry has gone
    });
    removeButton.addEventListener('click', () => {
      if (phase === 'sending') return;
      clearMessages();
      const index = queue.items().indexOf(item);
      queue.remove(item);
      const next = queue.items()[index] ?? queue.items()[index - 1];
      (next ? cards.get(next.id)?.element : moreButton)?.focus();
    });
    return card;
  }

  /** Shows `src` as the preview; `onError` runs if it won't load while it is still shown. → the image. */
  function showImage(card, src, onError) {
    const image = el('img', { src, alt: '' });
    image.addEventListener('error', () => {
      if (card.preview.contains(image)) onError();
    });
    card.preview.replaceChildren(image);
    return image;
  }

  /** The file itself, or a document icon if the browser can't show it after all. */
  function showLocalPreview(card) {
    if (!card.objectUrl || card.localFailed) {
      showDocument(card);
      return;
    }
    showImage(card, card.objectUrl, () => {
      card.localFailed = true;
      showDocument(card);
    });
  }

  function showDocument(card) {
    card.preview.replaceChildren(el('span', { class: 'add-photos-doc', 'aria-hidden': 'true', text: '📄' }));
  }

  function revokePreview(card) {
    if (!card.objectUrl) return;
    URL.revokeObjectURL?.(card.objectUrl);
    card.objectUrl = null;
  }

  /**
   * Swaps the preview for the server's thumbnail once there is one (a PDF has none). The file's own preview is let
   * go only once the thumbnail has loaded, and comes back if it won't.
   */
  function showThumbnail(card, media) {
    if (card.thumbShown || !media?.thumbKey) return;
    let url = null;
    try {
      url = thumbUrl(media);
    } catch (error) {
      console.warn('No thumbnail URL', error?.message);
    }
    if (!url) return;
    card.thumbShown = true;
    const image = showImage(card, url, () => showLocalPreview(card));
    image.addEventListener('load', () => revokePreview(card));
  }

  function disposeCard(card) {
    revokePreview(card);
    card.picker.destroy();
  }

  function statusText(item, items) {
    switch (item.state) {
      case 'queued': return 'Waiting to upload…';
      case 'uploading': return `Uploading ${Math.round((item.progress ?? 0) * 100)}%`;
      case 'processing': return 'Processing…';
      case 'failed': return uploadErrorMessage(item.error);
      default:
        if (item.duplicateOf) return `Same as photo ${items.indexOf(item.duplicateOf) + 1}`;
        return item.media?.mediaId ? 'Already in the tree' : 'Ready';
    }
  }

  function updateCard(card, item, index, items) {
    const number = index + 1;
    const text = statusText(item, items);
    const failed = item.state === 'failed';
    card.title.textContent = `Photo ${number}`;
    card.status.textContent = text;
    card.status.classList.toggle('add-photos-status-error', failed);
    card.element.dataset.state = item.state;
    card.progress.hidden = item.state !== 'uploading';
    card.progress.value = item.progress ?? 0;
    card.retryButton.hidden = !(failed && item.retryable);
    card.retryButton.setAttribute('aria-label', `Retry photo ${number}`);
    card.removeButton.setAttribute('aria-label', `Remove photo ${number}`);
    // A copy of an earlier photo isn't saved, and a refused file can't be: neither needs fields.
    const hideFields = Boolean(item.duplicateOf) || (failed && !item.retryable);
    if (hideFields && card.fields.contains(document.activeElement)) card.element.focus();
    card.fields.hidden = hideFields;

    if (item.state === 'ready') {
      const media = item.media ?? item.duplicateOf?.media;
      showThumbnail(card, media);
      // Already in the tree: its caption and date are shared, so they are shown, and only an empty one is filled.
      // Keyed by the media, not the state, so a copy that takes over from a removed photo shows them too.
      const mediaId = item.media?.mediaId ?? null;
      if (mediaId !== null && card.filledFor !== mediaId) {
        card.filledFor = mediaId;
        for (const key of ['caption', 'date']) {
          if (item.media[key] === null || item.media[key] === undefined) continue;
          card[key].value = item.media[key];
          card[key].readOnly = true;
          const { shared } = card.errors[key];
          shared.textContent = `This photo is already in the tree; edit its ${key} from the photo.`;
          shared.hidden = false;
        }
      }
    }
    if (card.lastState !== item.state && (item.state === 'ready' || failed)) announce(sentence(`Photo ${number}: ${text}`));
    card.lastState = item.state;
  }

  // --- Rendering --------------------------------------------------------------------------------------------

  function render(items) {
    if (closed) return;
    const ids = new Set(items.map((item) => item.id));
    for (const [id, card] of cards) {
      if (ids.has(id)) continue;
      disposeCard(card);
      card.element.remove();
      cards.delete(id);
    }
    items.forEach((item, index) => {
      let card = cards.get(item.id);
      if (!card) {
        card = createCard(item);
        cards.set(item.id, card);
        list.append(card.element);
      }
      updateCard(card, item, index, items);
    });
    updateFooter(items);
    syncUnloadWarning();
    if (view === 'confirm') updateConfirm(items);
  }

  /**
   * Keeps "Stop uploading?" true: once nothing is uploading there's nothing to stop, so the sheet goes back to the
   * photos rather than let Discard throw away ones that have just become ready.
   */
  function updateConfirm(items) {
    if (queue.hasActive()) {
      confirmText.textContent = `Stop uploading and discard ${photosWord(items.length)}?`;
      return;
    }
    showForm();
    announce('The uploads have finished.');
  }

  function updateFooter(items = queue.items()) {
    empty.hidden = items.length > 0;
    moreButton.textContent = items.length > 0 ? 'Add more' : 'Choose photos';
    if (phase === 'sending') return; // setBusy shows "Saving…" and puts the label back
    // A copy of an earlier photo isn't saved, and nor can a refused file be.
    const count = items.filter((item) => !item.duplicateOf && !(item.state === 'failed' && !item.retryable)).length;
    saveButton.textContent = phase === 'waiting' ? 'Waiting for uploads…'
      : count === 0 ? 'Save photos' : `Save ${photosWord(count)}`;
  }

  // --- Leaving the page ---------------------------------------------------------------------------------------

  function onBeforeUnload(event) {
    if (!dialog.isOpen() || !queue.hasActive()) return; // closed, or removed from the page without closing
    event.preventDefault();
    event.returnValue = ''; // older browsers
  }

  /** Warns before leaving the page only while something is uploading, so the page stays in the back/forward cache otherwise. */
  function syncUnloadWarning() {
    const active = !closed && queue.hasActive();
    if (active === warning) return;
    warning = active;
    if (active) window.addEventListener('beforeunload', onBeforeUnload);
    else window.removeEventListener('beforeunload', onBeforeUnload);
  }

  // --- Adding files ---------------------------------------------------------------------------------------------

  function addFiles(chosen) {
    const added = Array.from(chosen ?? []);
    if (added.length === 0) return;
    clearMessages();
    const room = Math.max(0, MAX_PHOTOS - queue.items().length);
    const kept = added.slice(0, room);
    if (kept.length < added.length) {
      showMessage(room === 0
        ? `Up to ${MAX_PHOTOS} photos can be added at once. Save these first, or remove failed or duplicate photos to make room.`
        : `Up to ${MAX_PHOTOS} photos can be added at once, so only the first ${kept.length} ${kept.length === 1 ? 'was' : 'were'} kept. ` +
          'Remove failed or duplicate photos to make room.');
    }
    queue.add(kept);
  }

  // --- Saving ---------------------------------------------------------------------------------------------------

  const failedItems = () => queue.items().filter((item) => item.state === 'failed');

  /** Saves once nothing is uploading; failed photos must be retried or removed first. */
  async function save() {
    if (closed || phase !== 'idle' || view !== 'form') return;
    clearMessages();
    if (queue.items().length === 0) return showMessage(NO_PHOTOS);
    if (failedItems().length > 0) return showMessage(FAILED_FIRST);
    if (queue.hasActive()) {
      const token = ++saveToken;
      phase = 'waiting';
      updateFooter();
      announce('Saving once the uploads have finished.');
      while (!closed && token === saveToken && queue.hasActive()) await queue.allSettled();
      // Closed, or "Stop uploading?" was asked meanwhile: that called the save off, so Save must be pressed again.
      if (closed || token !== saveToken) return;
      phase = 'idle';
      updateFooter();
      if (queue.items().length === 0) return showMessage(NO_PHOTOS);
      if (failedItems().length > 0) return showMessage(FAILED_FIRST);
    }
    await send();
  }

  async function send() {
    // A later copy of an earlier photo is left out: the server refuses the same file twice.
    const sent = queue.items().filter((item) => item.state === 'ready' && !item.duplicateOf);
    const params = addPhotosParams(person.id, sent.map((item) => cards.get(item.id).photo()));
    phase = 'sending';
    setBusy(formElement, true, saveButton, 'Saving…');
    let result;
    try {
      result = await api.runChange('add_photos', params);
    } catch (error) {
      phase = 'idle';
      setBusy(formElement, false, saveButton);
      showFailure(error, sent);
      return;
    }
    phase = 'idle';
    finish();
    callSafely(onSaved, result);
  }

  const numberOf = (item) => queue.items().indexOf(item) + 1;

  function showFailure(error, sent) {
    if (error?.code === 'no_change') {
      showToast('Already shown for everyone selected');
      finish();
      return;
    }
    const photoField = /^photos\.(\d+)(?:\.(.+))?$/.exec(error?.field ?? '');
    const index = Number(error?.body?.index ?? photoField?.[1]);
    const item = Number.isInteger(index) ? sent[index] : undefined;
    if (error?.code === 'missing_upload' && item) {
      queue.markFailed(item, error);
      showMessage(`Photo ${numberOf(item)} has to be uploaded again. Retry it, then save.`);
      return;
    }
    if (error?.code === 'invalid') {
      const key = photoField?.[2];
      const slot = item && (key === 'caption' || key === 'date') ? cards.get(item.id)?.errors[key] : null;
      const text = error.message && error.message !== error.code ? error.message : 'Check the photos and try again.';
      if (slot && !slot.wrap.closest('[hidden]')) {
        slot.error.textContent = text;
        slot.error.hidden = false;
        slot.input.setAttribute('aria-invalid', 'true');
        slot.input.focus();
        return;
      }
      showMessage(item ? `Photo ${numberOf(item)}: ${text}` : text);
      return;
    }
    if (error?.code === 'not_found' && item && photoField?.[2] === 'personIds') {
      showMessage(`Someone chosen for photo ${numberOf(item)} no longer exists: someone else deleted them. Remove them, then save.`);
      return;
    }
    if (error?.code === 'busy') {
      showMessage('The server is busy. Try again in a moment.');
      return;
    }
    showMessage(commandErrorMessage(error, { missing: `${name} no longer exists: someone else deleted them.` }));
  }

  // --- Closing --------------------------------------------------------------------------------------------------

  /** Escape, × and Cancel: ask first while anything is uploading. */
  function requestClose() {
    if (closed || phase === 'sending') return;
    if (view === 'confirm') showForm();
    else if (queue.hasActive()) showConfirm();
    else finish();
  }

  function showConfirm() {
    clearMessages();
    if (phase === 'waiting') {
      saveToken++; // calls off the save waiting for uploads
      phase = 'idle';
      updateFooter();
    }
    view = 'confirm';
    confirmText.textContent = `Stop uploading and discard ${photosWord(queue.items().length)}?`;
    main.hidden = true;
    formActions.hidden = true;
    confirm.hidden = false;
    confirmActions.hidden = false;
    dialog.dialog.setAttribute('aria-describedby', confirmText.id);
    dialog.dialog.scrollTop = 0;
    keepButton.focus();
  }

  function showForm() {
    view = 'form';
    dialog.dialog.removeAttribute('aria-describedby');
    confirm.hidden = true;
    confirmActions.hidden = true;
    main.hidden = false;
    formActions.hidden = false;
    cancelButton.focus();
  }

  /** Closes the sheet, stopping and discarding any uploads. */
  function finish() {
    if (closed) return;
    closed = true;
    clearTimeout(announceTimer);
    queue.cancel();
    syncUnloadWarning();
    for (const card of cards.values()) disposeCard(card);
    cards.clear();
    dialog.close();
  }

  // --- Wiring ---------------------------------------------------------------------------------------------------

  input.addEventListener('change', () => {
    addFiles(input.files);
    input.value = ''; // so choosing the same file again is a change
  });
  // The picker was dismissed: with nothing chosen yet, there's nothing to do here.
  input.addEventListener('cancel', () => {
    if (!closed && phase === 'idle' && queue.items().length === 0) finish();
  });
  moreButton.addEventListener('click', () => {
    if (!closed && phase !== 'sending') input.click();
  });
  formElement.addEventListener('submit', (event) => {
    event.preventDefault();
    save();
  });
  cancelButton.addEventListener('click', requestClose);
  keepButton.addEventListener('click', showForm);
  discardButton.addEventListener('click', finish);

  updateFooter([]);
  dialog.dialog.focus();
  if (files && files.length > 0) addFiles(files);
  else input.click(); // synchronously, still inside the tap's event handler (see above)

  return { close: finish, isOpen: () => !closed && dialog.isOpen(), element: dialog.dialog };
}
