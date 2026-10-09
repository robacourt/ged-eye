/**
 * The person editor: a dialog with the person's name and sex, the four life events (date, place and notes, and
 * the cause of death), their facts, notes, and email and phone; plus Delete. It builds `update_person` and
 * `delete_person`.
 *
 * Save sends only the core fields that changed, and the whole facts object only when it changed, with the
 * `updatedAt` the person was read with. Facts go through factsForm.js, so stored shapes survive unless edited.
 * Every data value is set with `value` or `textContent`, never as HTML.
 */
import { showToast } from './toast.js';
import { factLabel, KNOWN_FACT_TAGS } from './factLabels.js';
import { factsFromPerson, factsToForm, formToFacts, factsEqual, newRow, LIFE_EVENTS } from './factsForm.js';
import {
  DATE_HINT, DATE_PLACEHOLDER, VISUALLY_HIDDEN, el, openEditorDialog, reopenableHandle, uniqueId, callSafely, fill,
  readFilled, setBusy, commandErrorMessage
} from './editorDialog.js';

const UNNAMED = 'Unnamed person';
const STALE_MESSAGE = 'Someone else changed this person. Reload to see their changes.';
const MASKED_MESSAGE = "Couldn't load this person's full details, so they can't be edited. Sign in again, then try again.";

/** update_person's fields, each with the person record key it is shown from. */
const CORE_FIELDS = {
  given_name: 'givenName', surname: 'surname', sex: 'sex',
  birth_date: 'birthDate', birth_place: 'birthPlace', baptism_date: 'baptismDate', baptism_place: 'baptismPlace',
  death_date: 'deathDate', death_place: 'deathPlace', burial_date: 'burialDate', burial_place: 'burialPlace'
};

const EVENT_LABELS = { birth: 'Birth', baptism: 'Baptism', death: 'Death', burial: 'Burial' };
const SEX_OPTIONS = [['', 'Not recorded'], ['M', 'Male'], ['F', 'Female'], ['U', 'Unknown']];
const KIND_OPTIONS = [['occupation', 'Occupation'], ['residence', 'Residence'], ['census', 'Census'], ['other', 'Other']];
const VALUE_LABELS = { occupation: 'Occupation', residence: 'Address', census: 'Details', other: 'Details' };

const CUSTOM_TAG = '__custom';
// Event first (its Type says what happened), then the rest by label.
const TAG_CHOICES = ['EVEN', ...KNOWN_FACT_TAGS.filter(tag => tag !== 'EVEN')
  .sort((a, b) => factLabel({ tag: a }).localeCompare(factLabel({ tag: b })))];
// Earlier occurrences of a repeated birth, baptism, death or burial are kept as other facts with these tags,
// but a new fact never gets one: those belong in the life events.
const LIFE_EVENT_TAGS = new Set(['BIRT', 'BAPM', 'DEAT', 'BURI']);

// Facts are free-form: a stored value may have line breaks, which a single-line input would drop once touched.
const MULTI_LINE = /[\r\n]/;

/** Where a server error about `facts.<key>` is shown: the section that edits that key. */
export const FACT_ERROR_SLOTS = {
  notes: 'notes', birthNotes: 'birth', baptismNotes: 'baptism', deathNotes: 'death', burialNotes: 'burial',
  causeOfDeath: 'cause_of_death', email: 'email', phone: 'phone',
  occupations: 'facts', otherFacts: 'facts', censusRecords: 'facts', residences: 'facts', religion: 'facts', education: 'facts'
};

/** The name people know someone by, or "Unnamed person". */
export function displayName(person) {
  const name = String(person?.name ?? '').trim() ||
    [person?.givenName, person?.surname].filter(Boolean).join(' ').trim();
  return name || UNNAMED;
}

/** Only a view known to be unmasked may be edited: saving a masked one would write "[email hidden]" over notes. */
const isUnmasked = (view) => (view?.masked ?? view?.person?.masked) === false;

/**
 * Opens the editor for `person` (a person record from the person view, with `updatedAt`).
 *
 * Unless the view is known to be unmasked (`masked: false`, or `person.masked === false`), it is reloaded with
 * the editor's token first, since saving masked notes would overwrite the real ones. If the reloaded view isn't
 * `masked: false` either, the editor refuses with a toast.
 *
 * @param person      the person record
 * @param masked      whether the view it came from was masked (defaults to `person.masked`)
 * @param api         `{ runChange }` (editApi.js)
 * @param loader      `{ reload }` (dataLoader.js): for masked views and "Reload this person"
 * @param onSaved     ({ change, view }) after update_person: the caller invalidates caches, re-renders, toasts
 * @param onDeleted   ({ change, view }) after delete_person (`view` is the next person to show, or null)
 * @param onReloaded  (loadPersonWithFamily result) when the editor reloaded the person, so the panel can update
 * @returns Promise of `{ close, isOpen, element }`, or null when it refused. After "Reload this person" the
 *          editor reopens with fresh data, and the same handle then controls (and reports on) the new one.
 */
export async function openPersonEditor(options) {
  const { handle, slot } = reopenableHandle();
  return (await openInto(options, slot)) ? handle : null;
}

/** Opens the editor into `slot`, checking for a masked view first. Resolves to the editor, or null. */
async function openInto(options, slot) {
  let { person } = options;
  if (!isUnmasked({ masked: options.masked, person })) {
    let fresh = null;
    try {
      fresh = await options.loader.reload(person.id);
    } catch (error) {
      console.error('Reloading the person to edit failed', error);
    }
    if (!fresh?.person || !isUnmasked(fresh)) {
      showToast(MASKED_MESSAGE, { kind: 'error' });
      return null;
    }
    callSafely(options.onReloaded, fresh);
    person = fresh.person;
  }
  slot.editor = buildEditor(options, person, slot);
  return slot.editor;
}

function buildEditor(options, person, slot) {
  const { api, loader, onSaved, onDeleted, onReloaded } = options;
  const name = displayName(person);
  const storedFacts = factsFromPerson(person);
  const form = factsToForm(storedFacts);
  const errorSlots = new Map(); // key -> { element, input }
  let busy = false;
  let view = 'form';

  const dialog = openEditorDialog({
    title: `Edit ${name}`,
    className: 'editor-dialog-wide person-editor',
    onRequestClose: () => {
      if (busy) return;
      if (view === 'confirm') showForm();
      else dialog.close();
    }
  });

  // --- Building blocks -----------------------------------------------------------------------------------

  function errorLine(key, input = null) {
    const element = el('p', { class: 'editor-error', id: uniqueId('editor-error'), role: 'alert', 'data-error-for': key, hidden: true });
    if (input) input.setAttribute('aria-describedby', element.id);
    errorSlots.set(key, { element, input });
    return element;
  }

  /** A labelled control and its error line. */
  function labelled(label, control, errorKey, className = '') {
    const labelText = el('span', { text: label });
    const wrap = el('div', { class: `editor-field-wrap ${className}`.trim() },
      el('label', { class: 'editor-field' }, labelText, control),
      errorKey ? errorLine(errorKey, control) : null);
    return { wrap, labelText };
  }

  const textInput = (name, { type = 'text', placeholder } = {}) =>
    el('input', { class: 'editor-input', type, name, autocomplete: 'off', placeholder });

  /** A text input filled with a facts value, or a textarea when the value has line breaks. */
  function factText(name, value, options = {}) {
    const control = typeof value === 'string' && MULTI_LINE.test(value)
      ? el('textarea', { class: 'editor-input editor-textarea', name, rows: String(Math.min(8, value.split('\n').length + 1)) })
      : textInput(name, options);
    return fill(control, value);
  }

  const inputs = {};
  function coreField(label, field, { placeholder } = {}) {
    const input = fill(textInput(field, { placeholder }), person[CORE_FIELDS[field]] ?? null);
    inputs[field] = input;
    return labelled(label, input, field).wrap;
  }

  /** An editable list of notes. Notes left blank (or emptied) are dropped; untouched ones kept verbatim. */
  function notesEditor(notes, { itemLabel = 'Note', addLabel = 'Add a note', errorKey = null, className = '' } = {}) {
    const list = el('div', { class: 'editor-notes-list' });
    const add = el('button', { type: 'button', class: 'editor-btn-link editor-notes-add', text: addLabel });
    const root = el('div', { class: `editor-notes ${className}`.trim() }, list, add, errorKey ? errorLine(errorKey) : null);
    const items = [];

    const relabel = () => items.forEach(({ textarea, remove }, i) => {
      textarea.setAttribute('aria-label', `${itemLabel} ${i + 1}`);
      remove.setAttribute('aria-label', `Remove ${itemLabel.toLowerCase()} ${i + 1}`);
    });

    function addNote(text, isNew) {
      const lines = isNew ? 1 : text.split('\n').length;
      const textarea = el('textarea', { class: 'editor-input editor-textarea', rows: String(Math.min(12, Math.max(2, lines))) });
      if (!isNew) fill(textarea, text);
      const remove = el('button', { type: 'button', class: 'editor-btn-link editor-note-remove', text: 'Remove' });
      const entry = { item: el('div', { class: 'editor-note' }, textarea, remove), textarea, remove };
      remove.addEventListener('click', () => {
        items.splice(items.indexOf(entry), 1);
        entry.item.remove();
        relabel();
        add.focus();
      });
      items.push(entry);
      list.append(entry.item);
      relabel();
      return textarea;
    }

    notes.forEach(note => addNote(note, false));
    add.addEventListener('click', () => addNote('', true).focus());

    return {
      element: root,
      read() {
        const result = [];
        for (const { textarea } of items) {
          const { touched, value } = readFilled(textarea, text => text.trimEnd());
          if (touched && value.trim() === '') continue;
          result.push(value);
        }
        return result;
      }
    };
  }

  /** One row of the facts list. */
  function factRowEditor(row, onRemove) {
    const kind = el('select', { class: 'editor-input', name: 'kind' });
    for (const [value, label] of KIND_OPTIONS) kind.append(el('option', { value, text: label }));
    kind.value = row.kind;

    // A stored fact keeps its life event tag; it just isn't offered for anything else.
    const choices = TAG_CHOICES.filter(choice => !LIFE_EVENT_TAGS.has(choice) || choice === row.tag);
    const tag = el('select', { class: 'editor-input', name: 'tag' });
    tag.append(el('option', { value: '', text: 'Choose…' }));
    for (const choice of choices) tag.append(el('option', { value: choice, text: factLabel({ tag: choice }) }));
    tag.append(el('option', { value: CUSTOM_TAG, text: 'Another tag…' }));
    const knownTag = row.tag === '' || choices.includes(row.tag);
    tag.value = knownTag ? row.tag : CUSTOM_TAG;
    const customTag = factText('custom_tag', knownTag ? '' : row.tag);

    const inputsOf = {};
    for (const name of ['type', 'value', 'date', 'place', 'cause']) {
      inputsOf[name] = factText(name, row[name], { placeholder: name === 'date' ? DATE_PLACEHOLDER : undefined });
    }
    const notes = notesEditor(row.notes);
    const legend = el('legend', { class: 'fact-row-legend', style: VISUALLY_HIDDEN });
    let number = 0;

    const kindField = labelled('Kind', kind);
    const tagField = labelled('Fact', tag);
    const customField = labelled('GEDCOM tag', customTag);
    const typeField = labelled('Type', inputsOf.type);
    const valueField = labelled(VALUE_LABELS[row.kind], inputsOf.value);
    const causeField = labelled('Cause', inputsOf.cause);
    const remove = el('button', { type: 'button', class: 'editor-btn-link fact-row-remove', text: 'Remove this fact' });

    const element = el('fieldset', { class: 'editor-fieldset fact-row' },
      legend,
      el('div', { class: 'editor-grid' }, kindField.wrap, tagField.wrap, customField.wrap),
      el('div', { class: 'editor-grid' }, typeField.wrap, valueField.wrap),
      el('div', { class: 'editor-grid' }, labelled('Date', inputsOf.date).wrap, labelled('Place', inputsOf.place).wrap, causeField.wrap),
      notes.element,
      el('div', { class: 'editor-row-actions' }, remove));

    function applyKind() {
      const other = kind.value === 'other';
      tagField.wrap.hidden = !other;
      customField.wrap.hidden = !(other && tag.value === CUSTOM_TAG);
      typeField.wrap.hidden = !other;
      causeField.wrap.hidden = !other;
      valueField.labelText.textContent = VALUE_LABELS[kind.value];
      const what = other && tag.value && tag.value !== CUSTOM_TAG
        ? factLabel({ tag: tag.value })
        : kind.selectedOptions[0]?.textContent ?? '';
      legend.textContent = `Fact ${number}: ${what}`;
    }
    kind.addEventListener('change', applyKind);
    tag.addEventListener('change', () => {
      applyKind();
      if (tag.value === CUSTOM_TAG) customTag.focus();
    });
    remove.addEventListener('click', () => onRemove(editor));
    applyKind();

    const editor = {
      element,
      focus: () => kind.focus(),
      setNumber(value) {
        number = value;
        applyKind();
      },
      read: () => ({
        kind: kind.value,
        tag: tag.value === CUSTOM_TAG ? readFilled(customTag).value : tag.value,
        type: readFilled(inputsOf.type).value,
        value: readFilled(inputsOf.value).value,
        date: readFilled(inputsOf.date).value,
        place: readFilled(inputsOf.place).value,
        cause: readFilled(inputsOf.cause).value,
        notes: notes.read(),
        original: row.original
      })
    };
    return editor;
  }

  // --- The form ------------------------------------------------------------------------------------------

  const section = (title, className, ...children) =>
    el('section', { class: `editor-section ${className}`.trim() }, el('h3', { class: 'editor-section-title', text: title }), ...children);

  const sex = el('select', { class: 'editor-input', name: 'sex' });
  const sexOptions = [...SEX_OPTIONS];
  if (person.sex && !sexOptions.some(([value]) => value === person.sex)) sexOptions.push([person.sex, person.sex]);
  for (const [value, label] of sexOptions) sex.append(el('option', { value, text: label }));
  sex.value = person.sex ?? '';

  const nameSection = section('Name', 'person-editor-name',
    el('div', { class: 'editor-grid' },
      coreField('Given names', 'given_name'),
      coreField('Surname', 'surname'),
      labelled('Sex', sex, 'sex').wrap));

  const cause = factText('cause_of_death', form.causeOfDeath);
  const eventNotes = {};
  const events = LIFE_EVENTS.map((event) => {
    eventNotes[event] = notesEditor(form.lifeEvents[event].notes, {
      addLabel: `Add a ${event} note`, errorKey: event, className: 'editor-event-notes'
    });
    return el('fieldset', { class: 'editor-fieldset editor-event', 'data-event': event },
      el('legend', { text: EVENT_LABELS[event] }),
      el('div', { class: 'editor-grid' },
        coreField('Date', `${event}_date`, { placeholder: DATE_PLACEHOLDER }),
        coreField('Place', `${event}_place`),
        event === 'death' ? labelled('Cause of death', cause, 'cause_of_death').wrap : null),
      eventNotes[event].element);
  });
  const eventsSection = section('Life events', 'person-editor-events',
    el('p', { class: 'editor-hint', text: `Dates are free text, ${DATE_HINT}.` }), ...events);

  const factRows = el('div', { class: 'fact-rows' });
  const rowEditors = [];
  const renumber = () => rowEditors.forEach((editor, i) => editor.setNumber(i + 1));
  function addRow(row) {
    const editor = factRowEditor(row, (removed) => {
      rowEditors.splice(rowEditors.indexOf(removed), 1);
      removed.element.remove();
      renumber();
      addFact.focus();
    });
    rowEditors.push(editor);
    factRows.append(editor.element);
    editor.setNumber(rowEditors.length);
    return editor;
  }
  form.rows.forEach(addRow);
  const addFact = el('button', { type: 'button', class: 'editor-btn-link fact-add', text: 'Add a fact' });
  addFact.addEventListener('click', () => addRow(newRow('occupation')).focus());
  const factsSection = section('Facts', 'person-editor-facts', factRows, addFact, errorLine('facts'));

  const personNotes = notesEditor(form.notes, { errorKey: 'notes', className: 'person-editor-notes' });
  const notesSection = section('Notes', 'person-editor-notes-section', personNotes.element);

  const email = factText('email', form.email, { type: 'email' });
  const phone = factText('phone', form.phone, { type: 'tel' });
  const contactSection = section('Contact', 'person-editor-contact',
    el('div', { class: 'editor-grid' }, labelled('Email', email, 'email').wrap, labelled('Phone', phone, 'phone').wrap));

  const legacyNote = Object.keys(form.legacy).length
    ? el('p', { class: 'editor-hint', text: "Some stored details can't be edited here. They'll be kept as they are." })
    : null;

  const fields = el('div', { class: 'person-editor-fields' },
    nameSection, eventsSection, factsSection, notesSection, contactSection, legacyNote);

  // --- Delete confirmation, messages and buttons ---------------------------------------------------------

  const confirmText = el('p', { class: 'person-editor-confirm-text', id: uniqueId('editor-confirm'), text: `Delete ${name}? You can undo this from History.` });
  const confirm = el('div', { class: 'person-editor-confirm', hidden: true }, confirmText);

  const messageText = el('p', { class: 'editor-error', role: 'alert' });
  const reloadButton = el('button', { type: 'button', class: 'editor-btn editor-reload', text: 'Reload this person', hidden: true });
  const message = el('div', { class: 'editor-form-message', hidden: true }, messageText, reloadButton);

  const deleteButton = el('button', { type: 'button', class: 'editor-btn editor-btn-danger person-editor-delete', text: 'Delete' });
  const cancelButton = el('button', { type: 'button', class: 'editor-btn person-editor-cancel', text: 'Cancel' });
  const saveButton = el('button', { type: 'submit', class: 'editor-btn editor-btn-primary person-editor-save', text: 'Save' });
  const formActions = el('div', { class: 'editor-actions' },
    deleteButton, el('span', { class: 'editor-actions-spacer' }), cancelButton, saveButton);

  const keepButton = el('button', { type: 'button', class: 'editor-btn person-editor-confirm-cancel', text: 'Cancel' });
  const confirmDeleteButton = el('button', {
    type: 'button', class: 'editor-btn editor-btn-danger-solid person-editor-confirm-delete', text: 'Delete', 'aria-describedby': confirmText.id
  });
  const confirmActions = el('div', { class: 'editor-actions', hidden: true },
    el('span', { class: 'editor-actions-spacer' }), keepButton, confirmDeleteButton);

  const formElement = el('form', { class: 'editor-form person-editor-form', novalidate: true },
    fields, confirm, el('div', { class: 'editor-dialog-footer' }, message, formActions, confirmActions));
  dialog.body.append(formElement);

  // --- Behaviour -----------------------------------------------------------------------------------------

  function clearMessages() {
    message.hidden = true;
    messageText.textContent = '';
    reloadButton.hidden = true;
    for (const { element, input } of errorSlots.values()) {
      element.hidden = true;
      element.textContent = '';
      input?.removeAttribute('aria-invalid');
    }
  }

  function showMessage(text, { reload = false } = {}) {
    messageText.textContent = text;
    reloadButton.hidden = !reload;
    message.hidden = false;
    message.scrollIntoView?.({ block: 'nearest' });
  }

  /** Shows a 400 `invalid` next to its field; false when the form has no place for that field. */
  function showFieldError(field, text) {
    const key = typeof field === 'string' && field.startsWith('facts.') ? FACT_ERROR_SLOTS[field.slice(6)] : field;
    const slot = key ? errorSlots.get(key) : null;
    if (!slot) return false;
    slot.element.textContent = text;
    slot.element.hidden = false;
    if (slot.input) {
      slot.input.setAttribute('aria-invalid', 'true');
      slot.input.focus();
    } else {
      slot.element.scrollIntoView?.({ block: 'nearest' });
    }
    return true;
  }

  function showFailure(error) {
    if (error?.code === 'no_change') return finishUnchanged();
    if (error?.code === 'stale') return showMessage(STALE_MESSAGE, { reload: true });
    if (error?.code === 'invalid') {
      const text = error.message && error.message !== 'invalid' ? error.message : 'Check this and try again.';
      if (view === 'form' && showFieldError(error.field, text)) return;
      return showMessage(text);
    }
    showMessage(commandErrorMessage(error, { missing: `${name} no longer exists: someone else deleted them.` }));
  }

  function finishUnchanged() {
    showToast('Nothing changed');
    dialog.close();
  }

  /** Runs a command with the form busy; closes and reports on success, shows the failure otherwise. */
  async function runCommand(kind, params, button, busyLabel, onDone) {
    busy = true;
    setBusy(formElement, true, button, busyLabel);
    let result;
    try {
      result = await api.runChange(kind, params);
    } catch (error) {
      busy = false;
      setBusy(formElement, false, button);
      showFailure(error);
      return;
    }
    busy = false;
    dialog.close();
    callSafely(onDone, result);
  }

  function changedFields() {
    const changed = {};
    for (const [field, key] of Object.entries(CORE_FIELDS)) {
      const before = person[key] ?? null;
      if (field === 'sex') {
        if ((sex.value || null) !== (before || null)) changed.sex = sex.value || null;
        continue;
      }
      const { touched, value } = readFilled(inputs[field]);
      if (touched && value !== (before ?? '')) changed[field] = value;
    }
    return changed;
  }

  function readForm() {
    return {
      notes: personNotes.read(),
      lifeEvents: Object.fromEntries(LIFE_EVENTS.map(event => [event, { notes: eventNotes[event].read() }])),
      causeOfDeath: readFilled(cause).value,
      rows: rowEditors.map(editor => editor.read()),
      email: readFilled(email).value,
      phone: readFilled(phone).value,
      legacy: form.legacy
    };
  }

  async function save() {
    if (busy || view !== 'form') return;
    clearMessages();
    const changed = changedFields();
    const facts = formToFacts(readForm());
    const factsChanged = !factsEqual(facts, storedFacts);
    if (Object.keys(changed).length === 0 && !factsChanged) {
      finishUnchanged();
      return;
    }
    const params = { id: person.id, expectedUpdatedAt: person.updatedAt, fields: changed };
    if (factsChanged) params.facts = facts;
    await runCommand('update_person', params, saveButton, 'Saving…', onSaved);
  }

  function showConfirm() {
    if (busy) return;
    clearMessages();
    view = 'confirm';
    fields.hidden = true;
    formActions.hidden = true;
    confirm.hidden = false;
    confirmActions.hidden = false;
    dialog.dialog.setAttribute('aria-describedby', confirmText.id);
    dialog.dialog.scrollTop = 0;
    keepButton.focus();
  }

  function showForm() {
    clearMessages();
    view = 'form';
    dialog.dialog.removeAttribute('aria-describedby');
    confirm.hidden = true;
    confirmActions.hidden = true;
    fields.hidden = false;
    formActions.hidden = false;
    deleteButton.focus();
  }

  async function reloadPerson() {
    if (busy) return;
    busy = true;
    setBusy(formElement, true, reloadButton, 'Reloading…');
    let fresh;
    try {
      fresh = await loader.reload(person.id);
    } catch (error) {
      // The message first: it may hide Reload, and focus then goes to the next control rather than a hidden one.
      if (error?.name === 'PersonNotFoundError') showMessage(`${name} no longer exists: someone else deleted them.`);
      else showMessage("Couldn't reload this person. Check your connection and try again.", { reload: true });
      busy = false;
      setBusy(formElement, false, reloadButton);
      return;
    }
    busy = false;
    dialog.close();
    callSafely(onReloaded, fresh);
    await openInto({ ...options, person: fresh.person, masked: fresh.masked }, slot);
  }

  formElement.addEventListener('submit', (event) => {
    event.preventDefault();
    save();
  });
  cancelButton.addEventListener('click', () => {
    if (!busy) dialog.close();
  });
  deleteButton.addEventListener('click', showConfirm);
  keepButton.addEventListener('click', () => {
    if (!busy) showForm();
  });
  confirmDeleteButton.addEventListener('click', () => {
    if (busy) return;
    clearMessages();
    runCommand('delete_person', { id: person.id, expectedUpdatedAt: person.updatedAt }, confirmDeleteButton, 'Deleting…', onDeleted);
  });
  reloadButton.addEventListener('click', reloadPerson);

  inputs.given_name.focus();

  return { close: () => dialog.close(), isOpen: dialog.isOpen, element: dialog.dialog };
}
