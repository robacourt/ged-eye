/**
 * The modal dialog and form helpers the person and family editors share.
 *
 * The dialog uses editorStyles.css's `.editor-dialog` (centred, full screen below 768px). Tab keeps focus inside
 * it; Escape and × ask to close; closing gives focus back. Keys are taken in the capture phase, but only by the
 * topmost dialog (dialogStack.js), so the sign-in dialog, which may open over an editor, keeps its own keys.
 */
import { isTopmostDialog } from './dialogStack.js';
import { NOT_AN_EDITOR_MESSAGE } from './changeMessages.js';

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

/** Inline style that hides text visually but leaves it to screen readers (editorStyles.css has no class for it). */
export const VISUALLY_HIDDEN = 'position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;' +
  'clip:rect(0,0,0,0);white-space:nowrap;border:0';

/** Runs a caller's callback without letting its failure break the dialog. */
export function callSafely(callback, ...args) {
  try {
    callback?.(...args);
  } catch (error) {
    console.error('Editor callback failed', error);
  }
}

/** Whether focus could go to `element`, inside `scope`. */
function isUsable(element, scope) {
  return element instanceof HTMLElement && element !== scope && element.isConnected && scope.contains(element) &&
    !element.disabled && !element.closest('[hidden]');
}

/** The enabled, visible controls in `scope`, in tab order (positive tabindex isn't used). */
export function focusablesIn(scope) {
  return [...scope.querySelectorAll(FOCUSABLE)].filter(element => isUsable(element, scope));
}

/**
 * Puts focus back inside `scope` when it has left it (a focused button disabled while busy drops focus to the
 * page): on `preferred` if it can take it, else the first control, else `scope` itself.
 */
export function keepFocusInside(scope, preferred = null) {
  if (isUsable(document.activeElement, scope)) return;
  const target = [preferred, ...focusablesIn(scope)].find(element => isUsable(element, scope)) ?? scope;
  target.focus();
}

/**
 * Opens a dialog.
 * @param title           plain text
 * @param className       extra class for `.editor-dialog` (a literal, never data)
 * @param onRequestClose  () when Escape or × is pressed; defaults to closing
 * @returns `{ backdrop, dialog, body, setTitle, close, isOpen, focusables }`
 */
export function openEditorDialog({ title = '', className = '', onRequestClose } = {}) {
  const id = uniqueId('editor-dialog');
  const backdrop = document.createElement('div');
  backdrop.className = 'editor-dialog-backdrop';
  // tabindex -1: a click on a part of the dialog that isn't a control keeps focus in the dialog.
  backdrop.innerHTML = `
    <div class="editor-dialog" role="dialog" aria-modal="true" aria-labelledby="${id}-title" tabindex="-1">
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
  const focusables = () => focusablesIn(dialog);

  function trapTab(event) {
    const items = focusables();
    if (items.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const inside = isUsable(document.activeElement, dialog);
    if (event.shiftKey && (!inside || document.activeElement === first)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (!inside || document.activeElement === last)) {
      event.preventDefault();
      first.focus();
    }
  }

  // Capture phase, so Escape and Tab are seen even when focus has fallen to the page, and an Escape that
  // closes this dialog never reaches anything below it.
  function onKeyDown(event) {
    if (!backdrop.isConnected) {
      document.removeEventListener('keydown', onKeyDown, true); // removed from the page without being closed
      return;
    }
    if (event.defaultPrevented || !isTopmostDialog(backdrop)) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      requestClose();
    } else if (event.key === 'Tab') {
      trapTab(event);
    }
  }
  document.addEventListener('keydown', onKeyDown, true);
  dialog.querySelector('.editor-dialog-close').addEventListener('click', requestClose);

  document.body.appendChild(backdrop);

  function close() {
    if (!open) return;
    open = false;
    openBackdrops.delete(backdrop);
    document.removeEventListener('keydown', onKeyDown, true);
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

/**
 * A handle that stays valid when an editor reopens itself (after Reload): `slot.editor` is the editor shown now.
 * @returns `{ handle: { close, isOpen, element }, slot }`
 */
export function reopenableHandle() {
  const slot = { editor: null };
  const handle = {
    close: () => slot.editor?.close(),
    isOpen: () => Boolean(slot.editor?.isOpen()),
    get element() {
      return slot.editor?.element ?? null;
    }
  };
  return { handle, slot };
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

const focusBeforeBusy = new WeakMap(); // root -> the element focused when it became busy

/**
 * Disables every control in `root` while busy, showing `label` on the button that started it. When it is no
 * longer busy, focus goes back into the dialog if it fell out (to the control that had it, if it still can).
 */
export function setBusy(root, busy, button = null, label = '') {
  root.setAttribute('aria-busy', String(busy));
  if (busy) focusBeforeBusy.set(root, document.activeElement);
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
  if (!busy) {
    const preferred = focusBeforeBusy.get(root);
    focusBeforeBusy.delete(root);
    if (root.isConnected) keepFocusInside(root.closest('.editor-dialog') ?? root, preferred);
  }
}

/** Words for a failed command that isn't handled specially (invalid, stale, no_change). */
export function commandErrorMessage(error, { missing = 'This was deleted by someone else.' } = {}) {
  if (!error) return 'Something went wrong. Try again.';
  if (error.code === 'network') return error.message;
  if (error.status === 401) return "You're signed out. Sign in again, then try again. Your changes are still here.";
  if (error.status === 403) return NOT_AN_EDITOR_MESSAGE;
  if (error.code === 'not_found') return missing;
  if (error.code === 'conflict') return "This can't be done: it would conflict with other changes.";
  if (error.status === 413) return 'This is too large to save.';
  if (error.name === 'ApiError' || error.status) return `The server had a problem (${error.code}). Try again.`;
  return error.message || 'Something went wrong. Try again.';
}
