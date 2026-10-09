/**
 * The + Parent / + Spouse / + Child / + Sibling dialog. "New person" creates someone (`add_relative`);
 * "Existing person" searches for someone already in the tree (`link_existing`). Both follow the spec's
 * Linking rules: a child asks which partner it is with, a parent or sibling asks which parent family when
 * there are several, and the family's id is sent as `familyId` (never for a spouse).
 *
 * Every data value is set with `value` or `textContent`, never as HTML.
 */
import {
  DATE_HINT, DATE_PLACEHOLDER, el, openEditorDialog, uniqueId, callSafely, setBusy, commandErrorMessage
} from './editorDialog.js';
import { listNames, nameById, nameOf, relativeBlocked } from './familyLinks.js';

const SEARCH_DELAY_MS = 250;
const SEARCH_MIN_CHARS = 2;
const SEARCH_LIMIT = 20;

const RELATION_WORDS = { parent: 'a parent', spouse: 'a spouse', child: 'a child', sibling: 'a sibling' };
const SEX_OPTIONS = [['', 'Not recorded'], ['M', 'Male'], ['F', 'Female'], ['U', 'Unknown']];
const NEW_FIELDS = [
  ['given_name', 'Given names'], ['surname', 'Surname'], ['sex', 'Sex'],
  ['birth_date', 'Birth date'], ['birth_place', 'Birth place'], ['death_date', 'Death date']
];
const LEGENDS = { child: 'With which partner?', parent: 'Alongside which parent?', sibling: 'Through which parents?' };

/** "1850–1910", "b. 1850", "d. 1910" or "". */
function lifeYears({ birthYear, deathYear }) {
  const born = birthYear ?? '';
  const died = deathYear ?? '';
  if (born !== '' && died !== '') return `${born}–${died}`;
  if (born !== '') return `b. ${born}`;
  if (died !== '') return `d. ${died}`;
  return '';
}

/**
 * Which family the new relative goes in.
 * @returns `{ legend, options: [{ value, label }], ask, value, blocked }`: `ask` when the person must (or may)
 *   choose among `options`; `value` the family sent when nothing else is chosen (null: none is sent);
 *   `blocked` the reason the relation can't be added at all, or null.
 */
export function familyChoice(person, relationships, relation) {
  const name = nameOf(person);
  const choice = { legend: LEGENDS[relation] ?? '', options: [], ask: false, value: null, blocked: null };
  const parentFamilies = person?.parentFamilies ?? [];
  const partnerNames = (family) => (family.partnerIds ?? []).map(id => nameById(person, relationships, id));

  if (relation === 'child') {
    for (const marriage of person?.marriages ?? []) {
      if (!marriage.spouseId) continue;
      const spouse = nameById(person, relationships, marriage.spouseId);
      choice.options.push({ value: marriage.familyId, label: marriage.marriageDate ? `${spouse} (married ${marriage.marriageDate})` : spouse });
    }
    choice.options.push({ value: 'new', label: 'Other parent unknown' });
    choice.ask = choice.options.length > 1;
    // With one spouse, the child is most likely theirs; with several, the person must say.
    choice.value = choice.options.length <= 2 ? choice.options[0].value : null;
  } else if (relation === 'parent') {
    if (relativeBlocked(person, 'parent')) {
      choice.blocked = `${name} already has two parents.`;
      return choice;
    }
    const open = parentFamilies.filter(family => (family.partnerIds ?? []).length < 2);
    choice.options = open.map(family => ({ value: family.familyId, label: listNames(partnerNames(family)) || 'No other parent' }));
    choice.ask = open.length > 1;
    choice.value = open.length === 1 ? open[0].familyId : null;
  } else if (relation === 'sibling') {
    if (relativeBlocked(person, 'sibling')) {
      choice.blocked = `Add a parent first: ${name} has no parents to share.`;
      return choice;
    }
    const shared = parentFamilies.filter(family => (family.partnerIds ?? []).length > 0);
    choice.options = shared.map(family => ({ value: family.familyId, label: listNames(partnerNames(family)) }));
    choice.ask = shared.length > 1;
    choice.value = shared.length === 1 ? shared[0].familyId : null;
  }
  return choice;
}

/**
 * Opens the dialog.
 * @param person         the person record the relative is added to (the anchor)
 * @param relationships  the loader's `{ parents, spouses, children, siblings }`, for names
 * @param relation       'parent' | 'spouse' | 'child' | 'sibling'
 * @param api            `{ runChange, search }` (editApi.js)
 * @param onAdded        ({ change, view }) after the command: the caller invalidates caches, re-renders and
 *                       shows `change.summary` in a toast with Undo
 * @param loader         optional `{ reload }` (dataLoader.js): a stale error then offers "Reload this person"
 * @param onReloaded     (loadPersonWithFamily result) after that reload; the dialog has closed by then
 * @returns `{ close, isOpen, element }`
 */
export function openRelativeDialog({ person, relationships, relation, api, onAdded, loader, onReloaded }) {
  const name = nameOf(person);
  const choice = familyChoice(person, relationships, relation);
  const warnsOfParents = relation === 'child' || relation === 'sibling';
  const errorSlots = new Map(); // key -> { element, input }
  let busy = false;
  let activeTab = 'new';

  const dialog = openEditorDialog({
    title: `Add ${RELATION_WORDS[relation] ?? 'a relative'} of ${name}`,
    className: 'relative-dialog',
    onRequestClose: () => {
      if (!busy) dialog.close();
    }
  });

  function errorLine(key, input = null) {
    const element = el('p', { class: 'editor-error', id: uniqueId('editor-error'), role: 'alert', 'data-error-for': key, hidden: true });
    if (input) input.setAttribute('aria-describedby', element.id);
    errorSlots.set(key, { element, input });
    return element;
  }

  // --- Family choice -------------------------------------------------------------------------------------

  const choiceName = uniqueId('relative-family');
  const choiceRadios = choice.options.map(option => {
    const radio = el('input', { type: 'radio', name: choiceName, value: option.value });
    radio.checked = option.value === choice.value;
    return { radio, label: el('label', { class: 'relative-choice' }, radio, el('span', { text: option.label })) };
  });
  const choiceFieldset = el('fieldset', { class: 'editor-fieldset relative-family-choice', hidden: !choice.ask },
    el('legend', { text: choice.legend }), ...choiceRadios.map(({ label }) => label));
  choiceFieldset.append(errorLine('familyId'));
  errorSlots.get('familyId').input = choiceRadios[0]?.radio ?? null;
  const blocked = choice.blocked ? el('p', { class: 'editor-error relative-blocked', text: choice.blocked }) : null;

  // --- New person ----------------------------------------------------------------------------------------

  const inputs = {};
  const newFields = NEW_FIELDS.map(([field, label]) => {
    let input;
    if (field === 'sex') {
      input = el('select', { class: 'editor-input', name: field });
      for (const [value, text] of SEX_OPTIONS) input.append(el('option', { value, text }));
    } else {
      input = el('input', {
        class: 'editor-input', type: 'text', name: field, autocomplete: 'off',
        placeholder: field.endsWith('_date') ? DATE_PLACEHOLDER : null
      });
    }
    inputs[field] = input;
    return el('div', { class: 'editor-field-wrap' },
      el('label', { class: 'editor-field' }, el('span', { text: label }), input), errorLine(field, input));
  });

  // --- Existing person -----------------------------------------------------------------------------------

  const searchInput = el('input', {
    class: 'editor-input', type: 'search', name: 'search', autocomplete: 'off', placeholder: 'Type a name'
  });
  const resultsName = uniqueId('relative-result');
  const status = el('p', { class: 'editor-hint relative-status', 'aria-live': 'polite', text: 'Type at least 2 letters of their name.' });
  const results = el('div', { class: 'relative-results', role: 'radiogroup', 'aria-label': 'People found' });
  const warning = el('p', { class: 'relative-warning', hidden: true });
  let found = []; // the results shown
  let searchTimer = null;
  let searchNumber = 0;

  const tabIds = { new: uniqueId('relative-tab'), existing: uniqueId('relative-tab') };
  const panelIds = { new: uniqueId('relative-panel'), existing: uniqueId('relative-panel') };
  const tabButton = (key, text) => el('button', {
    type: 'button', class: 'relative-tab', role: 'tab', id: tabIds[key], 'data-tab': key,
    'aria-controls': panelIds[key], text
  });
  const tabs = { new: tabButton('new', 'New person'), existing: tabButton('existing', 'Existing person') };
  const panels = {
    new: el('div', { class: 'relative-panel', role: 'tabpanel', id: panelIds.new, 'data-panel': 'new', 'aria-labelledby': tabIds.new },
      el('div', { class: 'editor-grid' }, ...newFields),
      el('p', { class: 'editor-hint', text: `Dates are free text, ${DATE_HINT}.` })),
    existing: el('div', { class: 'relative-panel', role: 'tabpanel', id: panelIds.existing, 'data-panel': 'existing', 'aria-labelledby': tabIds.existing },
      el('div', { class: 'editor-field-wrap' },
        el('label', { class: 'editor-field' }, el('span', { text: 'Search the tree' }), searchInput), errorLine('otherId', searchInput)),
      status, results, warning)
  };

  // --- Messages and buttons ------------------------------------------------------------------------------

  const messageText = el('p', { class: 'editor-error', role: 'alert' });
  const reloadButton = el('button', { type: 'button', class: 'editor-btn editor-reload', text: 'Reload this person', hidden: true });
  const message = el('div', { class: 'editor-form-message', hidden: true }, messageText, reloadButton);
  const cancelButton = el('button', { type: 'button', class: 'editor-btn relative-cancel', text: 'Cancel' });
  const submitButton = el('button', { type: 'submit', class: 'editor-btn editor-btn-primary relative-submit', text: 'Add' });
  submitButton.disabled = Boolean(choice.blocked);

  // When the relation can't be added, only the reason and Cancel are shown.
  const choosers = el('div', { class: 'relative-choosers', hidden: Boolean(choice.blocked) },
    choiceFieldset,
    el('div', { class: 'relative-tabs', role: 'tablist', 'aria-label': 'Who to add' }, tabs.new, tabs.existing),
    panels.new, panels.existing);
  const formElement = el('form', { class: 'editor-form relative-form', novalidate: true },
    blocked, choosers,
    el('div', { class: 'editor-dialog-footer' }, message,
      el('div', { class: 'editor-actions' }, el('span', { class: 'editor-actions-spacer' }), cancelButton, submitButton)));
  dialog.body.append(formElement);

  // --- Behaviour -----------------------------------------------------------------------------------------

  function showTab(key, { focus = true } = {}) {
    activeTab = key;
    for (const [tabKey, button] of Object.entries(tabs)) {
      const selected = tabKey === key;
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
      panels[tabKey].hidden = !selected;
    }
    submitButton.textContent = key === 'new' ? 'Add' : 'Link';
    clearMessages();
    if (focus) (key === 'new' ? inputs.given_name : searchInput).focus();
  }

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
    reloadButton.hidden = !(reload && loader);
    message.hidden = false;
    message.scrollIntoView?.({ block: 'nearest' });
  }

  /** Shows an error next to `key`'s control; false when it has no visible place for it. */
  function showFieldError(key, text) {
    const slot = errorSlots.get(key);
    if (!slot || slot.element.parentElement?.closest('[hidden]')) return false;
    slot.element.textContent = text;
    slot.element.hidden = false;
    if (slot.input) {
      slot.input.setAttribute('aria-invalid', 'true');
      slot.input.focus();
    }
    return true;
  }

  function showFailure(error) {
    const text = error?.message && error.message !== error.code ? error.message : 'Check this and try again.';
    if (error?.code === 'invalid') {
      const key = String(error.field ?? '').replace(/^person\.fields\./, '');
      const placed = (key === 'familyId' && choice.ask) ||
        (activeTab === 'new' && key in inputs) ||
        (activeTab === 'existing' && key === 'otherId');
      if (placed && showFieldError(key, text)) return;
      return showMessage(text);
    }
    if (error?.code === 'not_found' && error.field === 'otherId' && activeTab === 'existing') {
      showFieldError('otherId', 'That person no longer exists: someone else deleted them.');
      return;
    }
    if (error?.code === 'stale') return showMessage(text, { reload: true });
    showMessage(commandErrorMessage(error, { missing: `${name} no longer exists: someone else deleted them.` }));
  }

  function chosenFamily() {
    if (!choice.ask) return choice.value;
    return choiceRadios.find(({ radio }) => radio.checked)?.radio.value ?? null;
  }

  function newPersonFields() {
    const fields = {};
    for (const [field] of NEW_FIELDS) {
      const value = inputs[field].value.trim();
      if (value !== '') fields[field] = value;
    }
    return fields;
  }

  async function submit() {
    if (busy || choice.blocked) return;
    clearMessages();
    const familyId = chosenFamily();
    if (relation !== 'spouse' && choice.ask && !familyId) {
      showFieldError('familyId', 'Choose one.');
      return;
    }
    const withFamily = relation !== 'spouse' && familyId ? { familyId } : {};
    let kind;
    let params;
    if (activeTab === 'new') {
      kind = 'add_relative';
      params = { anchorId: person.id, relation, person: { fields: newPersonFields() }, ...withFamily };
    } else {
      const otherId = results.querySelector('input:checked')?.value;
      if (!otherId) {
        showFieldError('otherId', 'Search for someone, then choose them.');
        return;
      }
      kind = 'link_existing';
      params = { anchorId: person.id, relation, otherId, ...withFamily };
    }

    busy = true;
    setBusy(formElement, true, submitButton, activeTab === 'new' ? 'Adding…' : 'Linking…');
    let result;
    try {
      result = await api.runChange(kind, params);
    } catch (error) {
      busy = false;
      setBusy(formElement, false, submitButton);
      showFailure(error);
      return;
    }
    busy = false;
    clearTimeout(searchTimer);
    dialog.close();
    callSafely(onAdded, result);
  }

  function showResults(people) {
    found = people.filter(someone => someone.id !== person.id);
    const chosen = results.querySelector('input:checked')?.value;
    results.replaceChildren(...found.map(someone => {
      const radio = el('input', { type: 'radio', name: resultsName, value: someone.id });
      radio.checked = someone.id === chosen;
      const years = lifeYears(someone);
      return el('label', { class: 'relative-result' }, radio,
        el('span', { class: 'relative-result-name', text: nameOf(someone) }),
        years ? el('span', { class: 'relative-result-years', text: years }) : null);
    }));
    status.textContent = found.length ? '' : 'No one matches.';
    updateWarning();
  }

  function updateWarning() {
    const chosenId = results.querySelector('input:checked')?.value;
    const chosen = found.find(someone => someone.id === chosenId);
    warning.hidden = !(warnsOfParents && chosen);
    warning.textContent = warning.hidden ? '' : `If ${nameOf(chosen)} already has parents, they will have two sets of parents.`;
  }

  async function runSearch() {
    clearTimeout(searchTimer);
    if (!dialog.isOpen()) return; // closed with Escape or × while the search was waiting
    const text = searchInput.value.trim();
    const number = ++searchNumber;
    if ([...text].length < SEARCH_MIN_CHARS) {
      showResults([]);
      status.textContent = 'Type at least 2 letters of their name.';
      return;
    }
    status.textContent = 'Searching…';
    let people;
    try {
      people = await api.search(text, { limit: SEARCH_LIMIT });
    } catch (error) {
      if (number !== searchNumber) return;
      console.error('Search failed', error);
      showResults([]);
      status.textContent = "Couldn't search. Check your connection and try again.";
      return;
    }
    if (number !== searchNumber || !dialog.isOpen()) return; // a newer search has started, or the dialog closed
    showResults(Array.isArray(people) ? people : []);
  }

  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, SEARCH_DELAY_MS);
  });
  searchInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault(); // search now rather than submit
    runSearch();
  });
  results.addEventListener('change', () => {
    errorSlots.get('otherId').element.hidden = true;
    searchInput.removeAttribute('aria-invalid');
    updateWarning();
  });
  choiceFieldset.addEventListener('change', () => {
    errorSlots.get('familyId').element.hidden = true;
    choiceRadios[0]?.radio.removeAttribute('aria-invalid');
  });

  for (const [key, button] of Object.entries(tabs)) {
    button.addEventListener('click', () => {
      if (!busy && activeTab !== key) showTab(key);
    });
    button.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      const other = key === 'new' ? 'existing' : 'new';
      showTab(other, { focus: false });
      tabs[other].focus();
    });
  }

  formElement.addEventListener('submit', (event) => {
    event.preventDefault();
    submit();
  });
  cancelButton.addEventListener('click', () => {
    if (busy) return;
    clearTimeout(searchTimer);
    dialog.close();
  });
  reloadButton.addEventListener('click', async () => {
    if (busy || !loader) return;
    busy = true;
    setBusy(formElement, true, reloadButton, 'Reloading…');
    let fresh;
    try {
      fresh = await loader.reload(person.id);
    } catch (error) {
      showMessage(error?.name === 'PersonNotFoundError'
        ? `${name} no longer exists: someone else deleted them.`
        : "Couldn't reload this person. Check your connection and try again.", { reload: error?.name !== 'PersonNotFoundError' });
      busy = false;
      setBusy(formElement, false, reloadButton);
      return;
    }
    busy = false;
    dialog.close();
    callSafely(onReloaded, fresh);
  });

  showTab('new', { focus: false });
  if (choice.blocked) cancelButton.focus();
  else if (choice.ask && !choice.value) choiceRadios[0].radio.focus();
  else inputs.given_name.focus();

  return { close: () => dialog.close(), isOpen: dialog.isOpen, element: dialog.dialog };
}
