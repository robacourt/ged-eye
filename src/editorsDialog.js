/**
 * The Editors dialog, for admins: who may edit the tree (email, name, role), adding someone, and removing
 * someone after a confirmation. The server's refusals (already an editor, removing yourself, the last admin,
 * not an admin) are shown where they happened. Every data value is set with `value` or `textContent`.
 */
import { showToast } from './toast.js';
import { el, openEditorDialog, uniqueId, setBusy, keepFocusInside } from './editorDialog.js';

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
 * Opens the dialog and loads the list.
 * @param api           `{ listEditors, addEditor, removeEditor }` (editApi.js)
 * @param currentEmail  the signed-in admin's email, marked "(you)"
 * @returns `{ close, isOpen, element }`
 */
export function openEditorsDialog({ api, currentEmail = null }) {
  let busy = false;
  const dialog = openEditorDialog({
    title: 'Editors',
    className: 'editors-dialog',
    onRequestClose: () => {
      if (!busy) dialog.close();
    }
  });

  // --- Layout ----------------------------------------------------------------------------------------------

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

  dialog.body.append(intro, status, retry, list, form);

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
  });

  load();
  emailInput.focus();

  return { close: () => dialog.close(), isOpen: dialog.isOpen, element: dialog.dialog };
}
