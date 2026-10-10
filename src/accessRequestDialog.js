/**
 * The "Request edit access" dialog, for someone signed in who isn't on the editors list: a short explanation, an
 * optional note to the admins (at most 500 characters, with a live count), Send and Cancel.
 *
 * Non-editors never load the editing chunk, so this lives in the main bundle and builds its own small modal, as
 * signIn.js does, instead of using editorDialog.js. It looks like the other dialogs (editorStyles.css) and keeps
 * their keyboard rules: Escape and Tab belong to the topmost dialog only (dialogStack.js), and closing gives focus
 * back. Every dynamic string is set with textContent.
 */
import { showToast } from './toast.js';
import { isTopmostDialog } from './dialogStack.js';

/** The longest note the server takes, in characters (code points) after trimming. */
export const NOTE_MAX_CHARS = 500;

const SENT = "Request sent. You'll get an email when an admin grants it.";
const ALREADY_ASKED = "You've already asked. You'll get an email when an admin grants it.";
const ALREADY_AN_EDITOR = 'You can already edit the tree.';
const TOO_LONG = `Keep the note to ${NOTE_MAX_CHARS} characters or fewer.`;
const GENERIC_ERROR = 'Something went wrong. Try again.';
const FOCUSABLE = 'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])';

/** "10 Oct" in British English, with the year ("2 Mar 2025") when it isn't this year; '' for a missing or bad date. */
export function shortDate(iso, now = Date.now()) {
  const time = Date.parse(iso ?? '');
  if (Number.isNaN(time)) return '';
  const date = new Date(time);
  const options = { day: 'numeric', month: 'short' };
  if (date.getFullYear() !== new Date(now).getFullYear()) options.year = 'numeric';
  return date.toLocaleDateString('en-GB', options);
}

/** Words for a failed request (ApiError from editApi.js). */
export function accessRequestErrorMessage(error) {
  if (!error) return GENERIC_ERROR;
  if (error.status === 429) return 'Too many requests right now — try again later.';
  if (error.code === 'network') return error.message || GENERIC_ERROR;
  if (error.code === 'invalid') {
    return error.message && error.message !== error.code ? error.message : 'Check the note and try again.';
  }
  if (error.status === 401) return "You're signed out. Sign in again, then try again.";
  if (error.name === 'ApiError' || error.status) return `The server had a problem (${error.code}). Try again.`;
  return error.message || GENERIC_ERROR;
}

const charCount = (text) => [...text].length;

function callSafely(callback, ...args) {
  try {
    callback?.(...args);
  } catch (error) {
    console.error('Access request callback failed', error);
  }
}

let nextId = 0;

function markup(id) {
  // Static markup only: every dynamic string is set with textContent afterwards.
  return `
    <div class="editor-dialog access-request-dialog" role="dialog" aria-modal="true" aria-labelledby="${id}-title" aria-busy="false" tabindex="-1">
      <div class="editor-dialog-header">
        <h2 class="editor-dialog-title" id="${id}-title">Request edit access</h2>
        <button type="button" class="editor-dialog-close" aria-label="Close">×</button>
      </div>
      <div class="editor-dialog-body">
        <form class="access-request-form" novalidate>
          <p class="access-request-intro"></p>
          <label class="editor-field">
            <span>Note to the admins (optional)</span>
            <textarea class="editor-input access-request-note" name="note" rows="4"
              placeholder="For example, who you are or how you're related"
              aria-describedby="${id}-count ${id}-error"></textarea>
          </label>
          <p class="access-request-count" id="${id}-count"></p>
          <p class="editor-error" id="${id}-error" role="alert" hidden></p>
          <div class="access-request-actions">
            <button type="button" class="editor-btn access-request-cancel">Cancel</button>
            <button type="submit" class="editor-btn editor-btn-primary access-request-send">Send</button>
          </div>
        </form>
      </div>
    </div>`;
}

/**
 * Opens the dialog.
 * @param api                has `requestAccess(note)` → `{ request, created }` (editApi.js)
 * @param email              the signed-in address, named in the explanation (or null)
 * @param onSent             (request) once the request is sent, or was already pending; after the toast. Called even
 *                           when the dialog was closed while sending.
 * @param onAlreadyAnEditor  () when the server says they can already edit (409): the account should be read again
 * @returns `{ close, isOpen, element }`
 */
export function openAccessRequestDialog({ api, email = null, onSent, onAlreadyAnEditor } = {}) {
  const id = `access-request-${++nextId}`;
  const backdrop = document.createElement('div');
  backdrop.className = 'editor-dialog-backdrop';
  backdrop.innerHTML = markup(id);
  const dialog = backdrop.querySelector('.access-request-dialog');
  const body = dialog.querySelector('.editor-dialog-body');
  const form = dialog.querySelector('.access-request-form');
  const intro = dialog.querySelector('.access-request-intro');
  const noteInput = dialog.querySelector('.access-request-note');
  const count = dialog.querySelector('.access-request-count');
  const error = dialog.querySelector('.editor-error');
  const cancelButton = dialog.querySelector('.access-request-cancel');
  const sendButton = dialog.querySelector('.access-request-send');

  const who = email ? [document.createElement('strong')] : ['you'];
  if (email) who[0].textContent = email;
  intro.replaceChildren('The admins will get an email asking them to let ', ...who,
    ' edit the tree. Add a note if they might not know who you are.');

  const active = document.activeElement;
  const returnFocus = active && active !== document.body ? active : null;
  let open = true;
  let busy = false;

  function updateCount() {
    const length = charCount(noteInput.value.trim());
    count.textContent = `${length} / ${NOTE_MAX_CHARS}`;
    count.classList.toggle('access-request-count-over', length > NOTE_MAX_CHARS);
  }

  function clearError() {
    error.hidden = true;
    error.textContent = '';
    noteInput.removeAttribute('aria-invalid');
  }

  function showError(message, { noteIsInvalid = false } = {}) {
    error.textContent = message;
    error.hidden = false;
    if (noteIsInvalid) noteInput.setAttribute('aria-invalid', 'true');
    noteInput.focus();
  }

  function setBusy(on) {
    busy = on;
    dialog.setAttribute('aria-busy', String(on));
    for (const control of body.querySelectorAll('button, textarea')) control.disabled = on;
    sendButton.textContent = on ? 'Sending…' : 'Send';
  }

  function close() {
    if (!open) return;
    open = false;
    document.removeEventListener('keydown', onKeyDown, true);
    backdrop.remove();
    if (returnFocus?.isConnected && !returnFocus.closest('[hidden]')) returnFocus.focus();
  }

  noteInput.addEventListener('input', () => {
    updateCount();
    if (!error.hidden && charCount(noteInput.value.trim()) <= NOTE_MAX_CHARS) clearError();
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy) return;
    clearError();
    const note = noteInput.value.trim();
    if (charCount(note) > NOTE_MAX_CHARS) {
      showError(TOO_LONG, { noteIsInvalid: true });
      return;
    }
    setBusy(true);
    let result = null;
    let failure = null;
    try {
      result = await api.requestAccess(note);
    } catch (caught) {
      failure = caught;
    }
    if (open) setBusy(false);
    if (!failure) {
      close();
      showToast(result?.created === false ? ALREADY_ASKED : SENT);
      callSafely(onSent, result?.request ?? null);
      return;
    }
    if (failure.status === 409 && failure.code === 'already_an_editor') {
      close();
      showToast(ALREADY_AN_EDITOR);
      callSafely(onAlreadyAnEditor);
      return;
    }
    if (!open) return; // closed while sending: nothing to show the failure in
    if (failure.name !== 'ApiError' || failure.status >= 500) console.error('Could not request edit access', failure);
    showError(accessRequestErrorMessage(failure), { noteIsInvalid: failure.code === 'invalid' });
  });

  cancelButton.addEventListener('click', close);
  dialog.querySelector('.editor-dialog-close').addEventListener('click', close);

  function focusables() {
    return [...dialog.querySelectorAll(FOCUSABLE)].filter(element => !element.disabled && !element.closest('[hidden]'));
  }

  function trapTab(event) {
    const items = focusables();
    if (items.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const current = document.activeElement;
    const inside = items.includes(current);
    if (event.shiftKey && (!inside || current === first)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (!inside || current === last)) {
      event.preventDefault();
      first.focus();
    }
  }

  // Capture phase, so an Escape that closes this dialog never reaches anything below it.
  function onKeyDown(event) {
    if (!backdrop.isConnected) {
      document.removeEventListener('keydown', onKeyDown, true); // removed from the page without being closed
      return;
    }
    if (event.defaultPrevented || !isTopmostDialog(backdrop)) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === 'Tab') {
      trapTab(event);
    }
  }

  updateCount();
  document.addEventListener('keydown', onKeyDown, true);
  document.body.appendChild(backdrop);
  noteInput.focus();

  return { close, isOpen: () => open && backdrop.isConnected, element: dialog };
}
