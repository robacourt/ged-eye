/**
 * The modal dialog and form helpers the person and family editors share.
 *
 * The dialog uses editorStyles.css's `.editor-dialog` (centred, full screen below 768px). Focus moves into it
 * and Tab keeps it there; Escape and × ask to close; closing gives focus back. Keys are handled on the
 * backdrop, so the sign-in dialog, which may open over an editor, keeps its own keys.
 */

/** Shown with every date field: dates are free text, as in GEDCOM. */
export const DATE_HINT = 'e.g. 12 MAR 1890, ABT 1850, BEF 1900';
export const DATE_PLACEHOLDER = 'e.g. 12 MAR 1890';

const FOCUSABLE = 'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])';

let nextId = 0;
const openBackdrops = new Set();

/** Whether an editor dialog is open: keyboard shortcuts such as Ctrl+Z should then be ignored. */
export function isEditorDialogOpen() {
  for (const backdrop of openBackdrops) {
    if (backdrop.isConnected) return true;
    openBackdrops.delete(backdrop); // removed from the page without being closed
  }
  return false;
}

/** A unique id prefix for labels and descriptions inside one dialog. */
export function uniqueId(prefix) {
  return `${prefix}-${++nextId}`;
}

/**
 * Makes an element. Props are attributes, except `class`, `text` (textContent) and `hidden`; a null or
 * undefined prop is left out.
 */
export function el(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') element.className = value;
    else if (key === 'text') element.textContent = value;
    else if (key === 'hidden') element.hidden = true;
    else element.setAttribute(key, value === true ? '' : value);
  }
  element.append(...children.filter(child => child !== null && child !== undefined));
  return element;
}

/** Runs a caller's callback without letting its failure break the dialog. */
export function callSafely(callback, ...args) {
  try {
    callback?.(...args);
  } catch (error) {
    console.error('Editor callback failed', error);
  }
}

/**
 * Opens a dialog.
 * @param title           plain text
 * @param className       extra class for `.editor-dialog` (a literal, never data)
 * @param onRequestClose  () when Escape or × is pressed; defaults to closing
 * @returns `{ backdrop, dialog, body, setTitle, close, isOpen }`
 */
export function openEditorDialog({ title = '', className = '', onRequestClose } = {}) {
  const id = uniqueId('editor-dialog');
  const backdrop = document.createElement('div');
  backdrop.className = 'editor-dialog-backdrop';
  backdrop.innerHTML = `
    <div class="editor-dialog" role="dialog" aria-modal="true" aria-labelledby="${id}-title">
      <div class="editor-dialog-header">
        <h2 class="editor-dialog-title" id="${id}-title"></h2>
        <button type="button" class="editor-dialog-close" aria-label="Close">×</button>
      </div>
      <div class="editor-dialog-body"></div>
    </div>`;
  const dialog = backdrop.querySelector('.editor-dialog');
  if (className) dialog.classList.add(...className.split(/\s+/).filter(Boolean));
  const titleElement = dialog.querySelector('.editor-dialog-title');
  const body = dialog.querySelector('.editor-dialog-body');
  titleElement.textContent = title;

  const active = document.activeElement;
  const returnFocus = active && active !== document.body ? active : null;
  let open = true;
  openBackdrops.add(backdrop);

  const requestClose = () => (onRequestClose ? onRequestClose() : close());

  function focusables() {
    return [...dialog.querySelectorAll(FOCUSABLE)].filter(el => !el.disabled && !el.closest('[hidden]'));
  }

  backdrop.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      requestClose();
    } else if (event.key === 'Tab') {
      const items = focusables();
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  });
  dialog.querySelector('.editor-dialog-close').addEventListener('click', requestClose);

  document.body.appendChild(backdrop);

  function close() {
    if (!open) return;
    open = false;
    openBackdrops.delete(backdrop);
    backdrop.remove();
    if (returnFocus?.isConnected && !returnFocus.closest('[hidden]')) returnFocus.focus();
  }

  return {
    backdrop,
    dialog,
    body,
    setTitle: (text) => { titleElement.textContent = text; },
    close,
    isOpen: () => open && backdrop.isConnected,
    focusables
  };
}

// --- Inputs that remember what they were filled with ----------------------------------------------------------

const filled = new WeakMap(); // input -> { shown: its value once filled, original: the stored value }

/**
 * Fills a text input or textarea with `original` (null shows as empty). Until the person changes it,
 * `readFilled` gives back `original` exactly, even where the browser can't show it as stored (line breaks
 * in a single-line input, \r\n in a textarea).
 */
export function fill(input, original) {
  input.value = original ?? '';
  filled.set(input, { shown: input.value, original });
  return input;
}

/**
 * `{ touched, value }`: `original` while untouched (or when changed back), else the current value through
 * `tidy` (by default trimmed). An input that was never filled counts as touched.
 */
export function readFilled(input, tidy = (text) => text.trim()) {
  const state = filled.get(input);
  if (state && input.value === state.shown) return { touched: false, value: state.original };
  return { touched: true, value: tidy(input.value) };
}

// --- Busy state and messages -------------------------------------------------------------------------------

/** Disables every control in `root` while busy, showing `label` on the button that started it. */
export function setBusy(root, busy, button = null, label = '') {
  root.setAttribute('aria-busy', String(busy));
  for (const control of root.querySelectorAll('button, input, select, textarea')) {
    if (busy) {
      control.dataset.wasDisabled = String(control.disabled);
      control.disabled = true;
    } else if (control.dataset.wasDisabled !== undefined) {
      control.disabled = control.dataset.wasDisabled === 'true';
      delete control.dataset.wasDisabled;
    }
  }
  if (button) {
    if (busy) {
      button.dataset.label = button.textContent;
      button.textContent = label;
    } else if (button.dataset.label !== undefined) {
      button.textContent = button.dataset.label;
      delete button.dataset.label;
    }
  }
}

/** Words for a failed command that isn't handled specially (invalid, stale, no_change). */
export function commandErrorMessage(error, { missing = 'This was deleted by someone else.' } = {}) {
  if (!error) return 'Something went wrong. Try again.';
  if (error.code === 'network') return error.message;
  if (error.status === 401) return "You're signed out. Sign in again, then try again. Your changes are still here.";
  if (error.status === 403) return "Your account can't edit the tree. Ask Rob for access.";
  if (error.code === 'not_found') return missing;
  if (error.code === 'conflict') return "This can't be done: it would conflict with other changes.";
  if (error.status === 413) return 'This is too large to save.';
  if (error.name === 'ApiError' || error.status) return `The server had a problem (${error.code}). Try again.`;
  return error.message || 'Something went wrong. Try again.';
}
