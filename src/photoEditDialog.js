/**
 * The photo editor: one photo's caption, date and the people it is shown for, opened from the viewer's Caption
 * and People buttons. It sends `update_photo`, a compare-and-swap on the values it opened with.
 *
 * Every data value is set with `value` or `textContent`, never as HTML.
 */
import {
  DATE_HINT, DATE_PLACEHOLDER, el, openEditorDialog, uniqueId, callSafely, fill, readFilled, setBusy, commandErrorMessage
} from './editorDialog.js';
import { nameOf } from './familyLinks.js';
import { thumbUrl } from './media.js';
import { createPersonPicker } from './personPicker.js';
import { updatePhotoParams } from './photoParams.js';

const MAX_CAPTION = 500;
const MAX_DATE = 100;

const NOBODY = 'A photo must be shown for at least one person.';
const STALE_MESSAGE = 'Someone else changed this photo. Reload to see their changes.';
const MISSING_MESSAGE = 'This photo no longer exists: someone else removed it.';

/**
 * Opens the editor.
 * @param photo    the photo as person_record gives it: `{ id, caption, date, people: [{ id, name }], thumbKey,
 *                 fileName, … }`. A photo from an older view, without `people`, is taken as shown for `person`
 *                 (as every photo in their viewer is); the compare-and-swap catches it if that's wrong.
 * @param person   the person whose photo it is: their view comes back (`focusId`)
 * @param api      `{ runChange, search }` (editApi.js)
 * @param onSaved  ({ change, view }) after update_photo: the caller invalidates caches, re-renders and toasts.
 *                 (null) from Reload, after someone else changed or removed the photo: the caller reloads.
 * @returns `{ close, isOpen, element }`
 */
export function openPhotoEditDialog({ photo, person, api, onSaved }) {
  const people = Array.isArray(photo.people) ? photo.people : [{ id: person.id, name: person.name ?? '' }];
  const opened = { ...photo, people }; // the values the compare-and-swap expects
  const errorSlots = new Map(); // field -> { element, input }
  let busy = false;

  const dialog = openEditorDialog({
    title: 'Edit photo',
    className: 'photo-edit-dialog',
    onRequestClose: () => {
      if (!busy) close();
    }
  });

  function textField(label, name, { maxlength, placeholder = null }) {
    const input = el('input', { class: 'editor-input', type: 'text', name, autocomplete: 'off', maxlength, placeholder });
    fill(input, photo[name] ?? null);
    const error = el('p', { class: 'editor-error', id: uniqueId('editor-error'), role: 'alert', 'data-error-for': name, hidden: true });
    input.setAttribute('aria-describedby', error.id);
    errorSlots.set(name, { element: error, input });
    const wrap = el('div', { class: 'editor-field-wrap' }, el('label', { class: 'editor-field' }, el('span', { text: label }), input), error);
    return { wrap, input };
  }

  function preview() {
    let url = null;
    try {
      url = thumbUrl(photo);
    } catch (error) {
      console.warn('No thumbnail URL', error?.message);
    }
    const image = url ? el('img', { src: url, alt: '' }) : el('span', { class: 'photo-edit-doc', 'aria-hidden': 'true', text: '📄' });
    return el('div', { class: 'photo-edit-head' },
      el('div', { class: 'photo-edit-preview' }, image),
      el('p', { class: 'photo-edit-file-name', text: photo.fileName ?? '' }));
  }

  const captionField = textField('Caption', 'caption', { maxlength: String(MAX_CAPTION) });
  const dateField = textField('Date', 'date', { maxlength: String(MAX_DATE), placeholder: DATE_PLACEHOLDER });
  const picker = createPersonPicker({ api, chosen: people, fixedIds: [], label: 'Add someone', onChange: clearPeopleError });
  const peopleError = el('p', { class: 'editor-error', id: uniqueId('editor-error'), role: 'alert', 'data-error-for': 'personIds', hidden: true });
  const searchInput = picker.element.querySelector('input');
  searchInput?.setAttribute('aria-describedby', peopleError.id);

  const messageText = el('p', { class: 'editor-error', role: 'alert' });
  const reloadButton = el('button', { type: 'button', class: 'editor-btn editor-reload', text: 'Reload', hidden: true });
  const message = el('div', { class: 'editor-form-message', hidden: true }, messageText, reloadButton);
  const cancelButton = el('button', { type: 'button', class: 'editor-btn photo-edit-cancel', text: 'Cancel' });
  const saveButton = el('button', { type: 'submit', class: 'editor-btn editor-btn-primary photo-edit-save', text: 'Save' });

  const formElement = el('form', { class: 'editor-form photo-edit-form', novalidate: true },
    preview(),
    el('p', { class: 'editor-hint', text: `The caption and date are shared by everyone the photo is shown for. Dates are free text, ${DATE_HINT}.` }),
    el('div', { class: 'editor-grid' }, captionField.wrap, dateField.wrap),
    el('fieldset', { class: 'editor-fieldset photo-edit-people' }, el('legend', { text: 'Shown for' }), picker.element, peopleError),
    el('div', { class: 'editor-dialog-footer' }, message,
      el('div', { class: 'editor-actions' }, el('span', { class: 'editor-actions-spacer' }), cancelButton, saveButton)));
  dialog.body.append(formElement);

  // --- Messages -------------------------------------------------------------------------------------------

  function clearPeopleError() {
    peopleError.hidden = true;
    peopleError.textContent = '';
  }

  function clearMessages() {
    message.hidden = true;
    messageText.textContent = '';
    reloadButton.hidden = true;
    clearPeopleError();
    for (const { element, input } of errorSlots.values()) {
      element.hidden = true;
      element.textContent = '';
      input.removeAttribute('aria-invalid');
    }
  }

  function showMessage(text, { reload = false } = {}) {
    messageText.textContent = text;
    reloadButton.hidden = !reload;
    message.hidden = false;
  }

  function showPeopleError(text) {
    peopleError.textContent = text;
    peopleError.hidden = false;
    searchInput?.focus();
  }

  function showFailure(error, chosen) {
    if (error?.code === 'no_change') {
      close();
      return;
    }
    if (error?.code === 'stale') {
      showMessage(STALE_MESSAGE, { reload: true });
      return;
    }
    const field = String(error?.field ?? '').split('.')[0];
    if (error?.code === 'invalid') {
      const text = error.message && error.message !== 'invalid' ? error.message : 'Check this and try again.';
      if (field === 'personIds') return showPeopleError(text);
      const slot = errorSlots.get(field);
      if (!slot) return showMessage(text);
      slot.element.textContent = text;
      slot.element.hidden = false;
      slot.input.setAttribute('aria-invalid', 'true');
      slot.input.focus();
      return;
    }
    if (error?.code === 'not_found' && field === 'personIds') {
      const gone = chosen.find(someone => someone.id === error.body?.id);
      const who = gone ? nameOf(gone) : 'Someone chosen';
      showPeopleError(`${who} no longer exists: someone else deleted them. Remove them, then save.`);
      return;
    }
    if (error?.code === 'not_found') {
      showMessage(MISSING_MESSAGE, { reload: true });
      return;
    }
    showMessage(commandErrorMessage(error, { missing: MISSING_MESSAGE }));
  }

  // --- Saving ---------------------------------------------------------------------------------------------

  async function save() {
    if (busy) return;
    clearMessages();
    const chosen = picker.chosen();
    if (chosen.length === 0) {
      showPeopleError(NOBODY);
      return;
    }
    const params = updatePhotoParams(opened, {
      caption: readFilled(captionField.input).value,
      date: readFilled(dateField.input).value,
      personIds: chosen.map(someone => someone.id)
    }, person.id);

    busy = true;
    setBusy(formElement, true, saveButton, 'Saving…');
    let result;
    try {
      result = await api.runChange('update_photo', params);
    } catch (error) {
      busy = false;
      setBusy(formElement, false, saveButton);
      showFailure(error, chosen);
      return;
    }
    busy = false;
    close();
    callSafely(onSaved, result);
  }

  function close() {
    picker.destroy();
    dialog.close();
  }

  formElement.addEventListener('submit', (event) => {
    event.preventDefault();
    save();
  });
  cancelButton.addEventListener('click', () => {
    if (!busy) close();
  });
  reloadButton.addEventListener('click', () => {
    if (busy) return;
    close();
    callSafely(onSaved, null);
  });

  captionField.input.focus();

  return { close, isOpen: dialog.isOpen, element: dialog.dialog };
}
