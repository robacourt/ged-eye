/**
 * The family editor: a couple's marriage and divorce date and place, opened from a marriage row. It builds
 * `update_family`, a compare-and-swap on the four fields as they were seen.
 * Every data value is set with `value` or `textContent`, never as HTML.
 */
import { showToast } from './toast.js';
import {
  DATE_HINT, DATE_PLACEHOLDER, el, openEditorDialog, uniqueId, callSafely, fill, readFilled, setBusy, commandErrorMessage
} from './editorDialog.js';

/** update_family's fields, each with the marriage row key it is shown from (person view `marriages[]`). */
const FIELDS = {
  marriage_date: 'marriageDate', marriage_place: 'marriagePlace', divorce_date: 'divorceDate', divorce_place: 'divorcePlace'
};
const LABELS = {
  marriage_date: 'Marriage date', marriage_place: 'Marriage place', divorce_date: 'Divorce date', divorce_place: 'Divorce place'
};

const STALE_MESSAGE = 'Someone else changed this marriage.';
const MISSING_MESSAGE = 'This marriage no longer exists: someone else removed it.';

const partnerName = (partner) =>
  String((typeof partner === 'string' ? partner : partner?.name) ?? '').trim() || 'Unnamed person';

/**
 * Opens the editor.
 * @param family      `{ familyId, partners: [{ id, name }] (or names), marriageDate, marriagePlace, divorceDate, divorcePlace }`
 * @param api         `{ runChange }` (editApi.js)
 * @param onSaved     ({ change, view }) after update_family: the caller invalidates caches, re-renders, toasts
 * @param focusId     optional: the person whose view the command returns (by default the first partner)
 * @param loader      optional `{ reload }` (dataLoader.js): with `focusId`, a stale save offers Reload, which
 *                    reloads that person and reopens with their fresh marriage row
 * @param onReloaded  (loadPersonWithFamily result) after such a reload, so the panel can update
 * @returns `{ close, isOpen, element }`
 */
export function openFamilyEditor(options) {
  const { family, api, onSaved, focusId, loader, onReloaded } = options;
  const names = (family.partners ?? []).map(partnerName);
  const errorSlots = new Map(); // field -> { element, input }
  const inputs = {};
  let busy = false;

  const dialog = openEditorDialog({
    title: names.length ? `Edit the marriage of ${names.join(' and ')}` : 'Edit the marriage',
    className: 'family-editor',
    onRequestClose: () => {
      if (!busy) dialog.close();
    }
  });

  function field(name) {
    const isDate = name.endsWith('_date');
    const input = el('input', { class: 'editor-input', type: 'text', name, autocomplete: 'off', placeholder: isDate ? DATE_PLACEHOLDER : null });
    fill(input, family[FIELDS[name]] ?? null);
    inputs[name] = input;
    const error = el('p', { class: 'editor-error', id: uniqueId('editor-error'), role: 'alert', 'data-error-for': name, hidden: true });
    input.setAttribute('aria-describedby', error.id);
    errorSlots.set(name, { element: error, input });
    return el('div', { class: 'editor-field-wrap' },
      el('label', { class: 'editor-field' }, el('span', { text: LABELS[name] }), input), error);
  }

  const messageText = el('p', { class: 'editor-error', role: 'alert' });
  const reloadButton = el('button', { type: 'button', class: 'editor-btn editor-reload', text: 'Reload', hidden: true });
  const message = el('div', { class: 'editor-form-message', hidden: true }, messageText, reloadButton);
  const cancelButton = el('button', { type: 'button', class: 'editor-btn family-editor-cancel', text: 'Cancel' });
  const saveButton = el('button', { type: 'submit', class: 'editor-btn editor-btn-primary family-editor-save', text: 'Save' });

  const formElement = el('form', { class: 'editor-form family-editor-form', novalidate: true },
    el('p', { class: 'editor-hint', text: `Dates are free text, ${DATE_HINT}.` }),
    el('div', { class: 'editor-grid' }, field('marriage_date'), field('marriage_place')),
    el('div', { class: 'editor-grid' }, field('divorce_date'), field('divorce_place')),
    el('div', { class: 'editor-dialog-footer' }, message,
      el('div', { class: 'editor-actions' }, el('span', { class: 'editor-actions-spacer' }), cancelButton, saveButton)));
  dialog.body.append(formElement);

  function clearMessages() {
    message.hidden = true;
    messageText.textContent = '';
    reloadButton.hidden = true;
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

  function showFailure(error) {
    if (error?.code === 'no_change') {
      showToast('Nothing changed');
      dialog.close();
      return;
    }
    if (error?.code === 'stale') {
      if (loader && focusId) showMessage(`${STALE_MESSAGE} Reload to see their changes.`, { reload: true });
      else showMessage(`${STALE_MESSAGE} Close this and open it again to see their changes.`);
      return;
    }
    if (error?.code === 'invalid') {
      const text = error.message && error.message !== 'invalid' ? error.message : 'Check this and try again.';
      const slot = errorSlots.get(error.field);
      if (!slot) return showMessage(text);
      slot.element.textContent = text;
      slot.element.hidden = false;
      slot.input.setAttribute('aria-invalid', 'true');
      slot.input.focus();
      return;
    }
    showMessage(commandErrorMessage(error, { missing: MISSING_MESSAGE }));
  }

  async function save() {
    if (busy) return;
    clearMessages();
    const expected = {};
    const fields = {};
    for (const [name, key] of Object.entries(FIELDS)) {
      const before = family[key] ?? null;
      expected[name] = before;
      const { touched, value } = readFilled(inputs[name]);
      if (touched && value !== (before ?? '')) fields[name] = value;
    }
    if (Object.keys(fields).length === 0) {
      showToast('Nothing changed');
      dialog.close();
      return;
    }
    const params = { id: family.familyId, expected, fields };
    if (focusId) params.focusId = focusId;

    busy = true;
    setBusy(formElement, true, saveButton, 'Saving…');
    let result;
    try {
      result = await api.runChange('update_family', params);
    } catch (error) {
      busy = false;
      setBusy(formElement, false, saveButton);
      showFailure(error);
      return;
    }
    busy = false;
    dialog.close();
    callSafely(onSaved, result);
  }

  async function reload() {
    if (busy) return;
    busy = true;
    setBusy(formElement, true, reloadButton, 'Reloading…');
    let fresh;
    try {
      fresh = await loader.reload(focusId);
    } catch (error) {
      busy = false;
      setBusy(formElement, false, reloadButton);
      if (error?.name === 'PersonNotFoundError') showMessage(MISSING_MESSAGE);
      else showMessage("Couldn't reload. Check your connection and try again.", { reload: true });
      return;
    }
    busy = false;
    const marriage = (fresh?.person?.marriages ?? []).find(row => row.familyId === family.familyId);
    if (!marriage) {
      showMessage(MISSING_MESSAGE);
      return;
    }
    dialog.close();
    callSafely(onReloaded, fresh);
    const freshFields = Object.fromEntries(Object.values(FIELDS).map(key => [key, marriage[key] ?? null]));
    openFamilyEditor({ ...options, family: { ...family, ...freshFields } });
  }

  formElement.addEventListener('submit', (event) => {
    event.preventDefault();
    save();
  });
  cancelButton.addEventListener('click', () => {
    if (!busy) dialog.close();
  });
  reloadButton.addEventListener('click', reload);

  inputs.marriage_date.focus();

  return { close: () => dialog.close(), isOpen: dialog.isOpen, element: dialog.dialog };
}
