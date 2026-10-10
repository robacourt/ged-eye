/**
 * The Editors dialog, for admins: pending requests for edit access (Grant or Dismiss), who may edit the tree
 * (email, name, role), adding someone, and removing someone after a confirmation. The server's refusals (already
 * an editor, removing yourself, the last admin, not an admin, a request another admin already dealt with) are
 * shown where they happened. Every data value is set with `value` or `textContent`.
 */
import { showToast } from './toast.js';
import { el, openEditorDialog, uniqueId, setBusy, keepFocusInside, callSafely } from './editorDialog.js';
import { shortDate } from './accessRequestDialog.js';

const ROLE_LABELS = { admin: 'Admin', editor: 'Editor' };
const ROLE_OPTIONS = [['editor', 'Editor: can edit the tree'], ['admin', 'Admin: can also manage editors']];
const NOT_AN_ADMIN = 'Only admins can change the editors list.';
const GENERIC_ERROR = 'Something went wrong. Try again.';

/** Words for a failed editors call (the server's own message where it has one). */
export function editorsErrorMessage(error) {
  if (!error) return GENERIC_ERROR;
  switch (error.code) {
    case 'network':
      return error.message || GENERIC_ERROR;
    case 'already_an_editor':
      return `${error.body?.email ?? 'That address'} is already an editor.`;
    case 'cannot_remove_self':
      return "You can't remove yourself.";
    case 'last_admin':
      return "The last admin can't be removed.";
    case 'not_an_admin':
    case 'not_an_editor':
      return NOT_AN_ADMIN;
    case 'invalid':
      return error.message && error.message !== error.code ? error.message : 'Check this and try again.';
    default:
  }
  if (error.status === 401) return "You're signed out. Sign in again, then try again.";
  if (error.name === 'ApiError' || error.status) return `The server had a problem (${error.code}). Try again.`;
  return error.message || GENERIC_ERROR;
}

function validateEmail(email) {
  if (!email) return 'Enter an email address.';
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) return 'Enter a full email address, like name@example.com.';
  return null;
}

const sameEmail = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

/**
 * "Granted by Ann Jones", from a 409 already_resolved's `{ status, resolvedByName, resolvedBy }`: the admin's
 * name, else their email.
 */
function resolvedText({ status, resolvedBy, resolvedByName } = {}) {
  const by = [resolvedByName, resolvedBy].find(value => typeof value === 'string' && value.trim() !== '') ?? null;
  if (status === 'granted') return by ? `Granted by ${by}` : 'Already granted';
  if (status === 'dismissed') return by ? `Dismissed by ${by}` : 'Already dismissed';
  return 'Another admin has already dealt with this request.';
}

/**
 * Opens the dialog and loads both lists.
 * @param api           `{ listEditors, addEditor, removeEditor, listAccessRequests, grantAccessRequest,
 *                      dismissAccessRequest }` (editApi.js)
 * @param currentEmail  the signed-in admin's email, marked "(you)"
 * @param onChanged     () after the pending requests changed here (granted, dismissed, already resolved, or the
 *                      person added directly), so the account menu's count can be read again
 * @returns `{ close, isOpen, element }`
 */
export function openEditorsDialog({ api, currentEmail = null, onChanged }) {
  let busy = false;
  const dialog = openEditorDialog({
    title: 'Editors',
    className: 'editors-dialog',
    onRequestClose: () => {
      if (!busy) dialog.close();
    }
  });

  // --- Layout ----------------------------------------------------------------------------------------------

  // Requests: shown only once there are some (or they couldn't be loaded).
  const requestsTitle = el('h3', { class: 'editor-section-title', id: uniqueId('editors-requests'), text: 'Requests' });
  const requestsStatus = el('p', { class: 'editors-requests-status', role: 'status' });
  const requestsRetry = el('button', { type: 'button', class: 'editor-btn editors-requests-retry', text: 'Try again', hidden: true });
  const requestsList = el('ul', { class: 'editors-requests-list', 'aria-label': 'Access requests' });
  const requestsSection = el('section', { class: 'editors-requests', 'aria-labelledby': requestsTitle.id, hidden: true },
    requestsTitle, requestsStatus, requestsRetry, requestsList);

  const intro = el('p', { class: 'editors-intro', text: 'People on this list can sign in and edit the tree.' });
  const status = el('p', { class: 'editors-status', role: 'status' });
  const retry = el('button', { type: 'button', class: 'editor-btn editors-retry', text: 'Try again', hidden: true });
  const list = el('ul', { class: 'editors-list', 'aria-label': 'Editors' });

  const errorLines = new Map(); // field -> { element, input }
  function fieldWithError(name, label, input, hint = null) {
    const error = el('p', { class: 'editor-error', id: uniqueId('editors-error'), role: 'alert', 'data-error-for': name, hidden: true });
    input.setAttribute('aria-describedby', error.id);
    errorLines.set(name, { element: error, input });
    return el('label', { class: 'editor-field' }, el('span', { text: label }), input, hint, error);
  }
  const emailInput = el('input', { class: 'editor-input', name: 'email', type: 'email', autocomplete: 'off', required: true });
  const nameInput = el('input', { class: 'editor-input', name: 'name', type: 'text', autocomplete: 'off', maxlength: '500' });
  const roleSelect = el('select', { class: 'editor-input', name: 'role' },
    ...ROLE_OPTIONS.map(([value, label]) => el('option', { value, text: label })));
  const addError = el('p', { class: 'editor-error editors-add-error', role: 'alert', hidden: true });
  const addButton = el('button', { type: 'submit', class: 'editor-btn editor-btn-primary', text: 'Add editor' });
  const form = el('form', { class: 'editor-form editors-add', novalidate: true },
    el('h3', { class: 'editor-section-title', text: 'Add an editor' }),
    fieldWithError('email', 'Email', emailInput),
    fieldWithError('name', 'Name (optional)', nameInput,
      el('span', { class: 'editor-hint', text: 'Shown in the history as who made each change.' })),
    fieldWithError('role', 'Role', roleSelect),
    addError,
    el('div', { class: 'editor-actions' }, el('span', { class: 'editor-actions-spacer' }), addButton));

  dialog.body.append(requestsSection, intro, status, retry, list, form);

  // --- Requests --------------------------------------------------------------------------------------------

  const requestRows = () => [...requestsList.children];

  function updateRequestsSection() {
    requestsSection.hidden = requestsList.children.length === 0 && !requestsStatus.textContent;
  }

  /** Takes `item` out of the list, keeping focus in the dialog (on the next request's Grant, if any). */
  function dropRequestRow(item) {
    const next = item.nextElementSibling ?? item.previousElementSibling;
    item.remove();
    updateRequestsSection();
    keepFocusInside(dialog.dialog, next?.querySelector('.editors-request-grant') ?? emailInput);
  }

  function requestRow(request) {
    const who = el('div', { class: 'editors-request-who' },
      request.name ? el('span', { class: 'editors-request-name', text: request.name }) : null,
      el('span', { class: 'editors-request-email', text: request.email }));
    const date = shortDate(request.createdAt);
    const when = el('time', { class: 'editors-request-date', datetime: request.createdAt, text: date ? `Asked ${date}` : '' });
    // textContent, and `white-space: pre-wrap` in the stylesheet, keep the note's line breaks.
    const note = request.note ? el('p', { class: 'editors-request-note', text: request.note }) : null;
    const grant = el('button', {
      type: 'button', class: 'editor-btn editor-btn-primary editors-request-grant', text: 'Grant',
      'aria-label': `Grant ${request.email} edit access`
    });
    const dismiss = el('button', {
      type: 'button', class: 'editor-btn editors-request-dismiss', text: 'Dismiss',
      'aria-label': `Dismiss the request from ${request.email}`
    });
    const actions = el('div', { class: 'editors-request-actions' }, grant, dismiss);
    const resolved = el('p', { class: 'editors-request-resolved', role: 'status', hidden: true });
    const error = el('p', { class: 'editor-error editors-request-error', role: 'alert', hidden: true });
    const item = el('li', { class: 'editors-request', 'data-id': String(request.id), 'data-email': request.email },
      who, when, note, actions, resolved, error);

    /** Runs Grant or Dismiss with the dialog busy. → `{ result }` or `{ failure }`; null if the dialog closed. */
    async function run(button, busyLabel, call) {
      busy = true;
      error.hidden = true;
      setBusy(dialog.body, true, button, busyLabel);
      let outcome;
      try {
        outcome = { result: await call(request.id) };
      } catch (failure) {
        outcome = { failure };
      }
      busy = false;
      setBusy(dialog.body, false, button);
      return dialog.isOpen() ? outcome : null;
    }

    /** Shows a failure in the row, or what became of a request someone else dealt with (or that no longer exists). */
    function showFailure(failure, button) {
      if (failure.code === 'not_found') {
        dropRequestRow(item);
        callSafely(onChanged);
        return;
      }
      if (failure.code === 'already_resolved') {
        resolved.textContent = resolvedText(failure.body);
        resolved.hidden = false;
        actions.remove();
        if (failure.body?.status === 'granted') load(); // someone new to list
        keepFocusInside(dialog.dialog, item.nextElementSibling?.querySelector('.editors-request-grant') ?? emailInput);
        callSafely(onChanged);
        return;
      }
      error.textContent = editorsErrorMessage(failure);
      error.hidden = false;
      keepFocusInside(dialog.dialog, button);
    }

    grant.addEventListener('click', async () => {
      if (busy) return;
      const outcome = await run(grant, 'Granting…', api.grantAccessRequest);
      if (!outcome) return;
      if (outcome.failure) {
        showFailure(outcome.failure, grant);
        return;
      }
      showToast(`Granted ${request.email} edit access.`);
      dropRequestRow(item);
      loadRequests();
      load();
      callSafely(onChanged);
    });

    dismiss.addEventListener('click', async () => {
      if (busy) return;
      const outcome = await run(dismiss, 'Dismissing…', api.dismissAccessRequest);
      if (!outcome) return;
      if (outcome.failure) {
        showFailure(outcome.failure, dismiss);
        return;
      }
      showToast(`Dismissed the request from ${request.email}.`);
      dropRequestRow(item);
      loadRequests();
      callSafely(onChanged);
    });

    return item;
  }

  /**
   * Shows `requests`: rows already shown for them are kept as they are (so focus stays put), rows for requests
   * no longer pending go, and new ones are added at the end (the list is oldest first).
   */
  function showRequests(requests) {
    const ids = new Set(requests.map(request => String(request.id)));
    for (const item of requestRows()) {
      if (!ids.has(item.dataset.id)) item.remove();
    }
    const shown = new Set(requestRows().map(item => item.dataset.id));
    requestsList.append(...requests.filter(request => !shown.has(String(request.id))).map(requestRow));
    updateRequestsSection();
  }

  let requestsLoad = 0; // bumped per load, so only the latest answer is shown

  async function loadRequests() {
    if (typeof api.listAccessRequests !== 'function') return;
    const current = ++requestsLoad;
    requestsRetry.hidden = true;
    let requests;
    try {
      requests = await api.listAccessRequests();
    } catch (error) {
      if (!dialog.isOpen() || current !== requestsLoad) return;
      requestsStatus.textContent = `Couldn't load the access requests. ${editorsErrorMessage(error)}`;
      requestsRetry.hidden = false;
      updateRequestsSection();
      return;
    }
    if (!dialog.isOpen() || current !== requestsLoad) return;
    requestsStatus.textContent = '';
    showRequests(Array.isArray(requests) ? requests : []);
  }

  requestsRetry.addEventListener('click', loadRequests);

  // --- List ------------------------------------------------------------------------------------------------

  function editorRow(editor) {
    const isYou = sameEmail(editor.email, currentEmail);
    const who = el('div', { class: 'editors-who' },
      el('span', { class: 'editors-email', text: editor.email }),
      isYou ? el('span', { class: 'editors-you', text: '(you)' }) : null,
      editor.name ? el('span', { class: 'editors-name', text: editor.name }) : null);
    const role = el('span', { class: 'editors-role', text: ROLE_LABELS[editor.role] ?? String(editor.role ?? '') });
    const remove = el('button', {
      type: 'button', class: 'editor-btn editor-btn-danger editors-remove', text: 'Remove', 'aria-label': `Remove ${editor.email}`
    });
    const confirmRemove = el('button', { type: 'button', class: 'editor-btn editor-btn-danger-solid editors-confirm-remove', text: 'Remove' });
    const cancel = el('button', { type: 'button', class: 'editor-btn editors-confirm-cancel', text: 'Cancel' });
    const confirmText = el('p', { class: 'editors-confirm-text', id: uniqueId('editors-confirm'), text: `Remove ${editor.email} from the editors?` });
    confirmRemove.setAttribute('aria-describedby', confirmText.id);
    const confirm = el('div', { class: 'editors-confirm', hidden: true }, confirmText,
      el('div', { class: 'editor-actions' }, cancel, confirmRemove));
    const error = el('p', { class: 'editor-error editors-row-error', role: 'alert', hidden: true });
    const item = el('li', { class: 'editors-row', 'data-email': editor.email }, who, role, remove, confirm, error);

    function showConfirm(show) {
      confirm.hidden = !show;
      remove.hidden = show;
      (show ? cancel : remove).focus();
    }

    remove.addEventListener('click', () => {
      if (busy) return;
      error.hidden = true;
      showConfirm(true);
    });
    cancel.addEventListener('click', () => {
      if (!busy) showConfirm(false);
    });
    confirmRemove.addEventListener('click', async () => {
      if (busy) return;
      busy = true;
      setBusy(dialog.body, true, confirmRemove, 'Removing…');
      let failure = null;
      try {
        await api.removeEditor(editor.email);
      } catch (caught) {
        failure = caught;
      }
      busy = false;
      setBusy(dialog.body, false, confirmRemove);
      if (!failure || failure.code === 'not_found') {
        const next = item.nextElementSibling ?? item.previousElementSibling;
        item.remove();
        if (!failure) showToast(`Removed ${editor.email}.`);
        keepFocusInside(dialog.dialog, next?.querySelector('.editors-remove') ?? emailInput);
        return;
      }
      confirm.hidden = true;
      remove.hidden = false;
      error.textContent = editorsErrorMessage(failure);
      error.hidden = false;
      remove.focus();
    });
    return item;
  }

  async function load() {
    retry.hidden = true;
    status.textContent = 'Loading editors…';
    list.setAttribute('aria-busy', 'true');
    let editors;
    try {
      editors = await api.listEditors();
    } catch (error) {
      if (!dialog.isOpen()) return;
      list.setAttribute('aria-busy', 'false');
      status.textContent = `Couldn't load the editors. ${editorsErrorMessage(error)}`;
      retry.hidden = false;
      return;
    }
    if (!dialog.isOpen()) return;
    list.setAttribute('aria-busy', 'false');
    list.replaceChildren(...(Array.isArray(editors) ? editors : []).map(editorRow));
    status.textContent = list.children.length ? '' : 'No editors yet.';
  }

  retry.addEventListener('click', load);

  // --- Adding ----------------------------------------------------------------------------------------------

  function clearErrors() {
    addError.hidden = true;
    addError.textContent = '';
    for (const { element, input } of errorLines.values()) {
      element.hidden = true;
      element.textContent = '';
      input.removeAttribute('aria-invalid');
    }
  }

  function showFieldError(name, text) {
    const line = errorLines.get(name);
    if (!line) return false;
    line.element.textContent = text;
    line.element.hidden = false;
    line.input.setAttribute('aria-invalid', 'true');
    line.input.focus();
    return true;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy) return;
    clearErrors();
    const email = emailInput.value.trim();
    const invalid = validateEmail(email);
    if (invalid) {
      showFieldError('email', invalid);
      return;
    }
    const role = roleSelect.value;
    busy = true;
    setBusy(dialog.body, true, addButton, 'Adding…');
    let added = null;
    let failure = null;
    try {
      added = await api.addEditor({ email, name: nameInput.value.trim() || null, role });
    } catch (caught) {
      failure = caught;
    }
    busy = false;
    setBusy(dialog.body, false, addButton);
    if (failure) {
      const field = failure.code === 'already_an_editor' ? 'email' : failure.code === 'invalid' ? failure.field : null;
      if (!(field && showFieldError(field, editorsErrorMessage(failure)))) {
        addError.textContent = editorsErrorMessage(failure);
        addError.hidden = false;
      }
      return;
    }
    const editor = added ?? { email, name: nameInput.value.trim() || null, role };
    [...list.children].find(item => sameEmail(item.dataset.email, editor.email))?.remove();
    list.append(editorRow(editor));
    status.textContent = '';
    showToast(`Added ${editor.email} as ${editor.role === 'admin' ? 'an admin' : 'an editor'}.`);
    form.reset();
    emailInput.focus();
    // Adding someone grants their pending request too (on the server), so it leaves the list.
    if (requestRows().some(item => sameEmail(item.dataset.email, editor.email))) {
      loadRequests();
      callSafely(onChanged);
    }
  });

  load();
  loadRequests();
  emailInput.focus();

  return { close: () => dialog.close(), isOpen: dialog.isOpen, element: dialog.dialog };
}
