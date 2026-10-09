/**
 * Transient messages at the bottom of the screen, with an optional action (such as Undo).
 * Messages and labels are set as text, never as HTML.
 */

const DEFAULT_TIMEOUT_MS = 6000;
const MAX_VISIBLE = 3;

let container = null;

function getContainer() {
  if (!container || !container.isConnected) {
    container = document.createElement('div');
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  return container;
}

/**
 * @param message  plain text
 * @param options.action   `{ label, onClick }`: a button that runs `onClick`, then dismisses the toast
 * @param options.timeout  milliseconds before it goes (paused while hovered or focused); 0 keeps it until dismissed
 * @param options.kind     'info' (a polite status) or 'error' (an alert)
 * @returns `{ dismiss, element }`
 */
export function showToast(message, { action = null, timeout = DEFAULT_TIMEOUT_MS, kind = 'info' } = {}) {
  const toast = document.createElement('div');
  toast.className = `toast toast-${kind === 'error' ? 'error' : 'info'}`;
  if (kind === 'error') {
    toast.setAttribute('role', 'alert');
  } else {
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
  }

  const text = document.createElement('span');
  text.className = 'toast-message';
  text.textContent = String(message);
  toast.appendChild(text);

  let timer = null;
  let dismissed = false;
  let hovered = false;
  let focused = false;

  function dismiss() {
    if (dismissed) return;
    dismissed = true;
    clearTimeout(timer);
    toast.remove();
  }

  function startTimer() {
    clearTimeout(timer);
    if (dismissed || hovered || focused || !(timeout > 0) || timeout === Infinity) return;
    timer = setTimeout(dismiss, timeout);
  }

  function pause() {
    clearTimeout(timer);
  }

  if (action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'toast-action';
    button.textContent = String(action.label);
    button.addEventListener('click', () => {
      try {
        action.onClick?.();
      } catch (error) {
        console.error('Toast action failed', error);
      } finally {
        dismiss();
      }
    });
    toast.appendChild(button);
  }

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'toast-close';
  close.setAttribute('aria-label', 'Dismiss');
  close.textContent = '×';
  close.addEventListener('click', dismiss);
  toast.appendChild(close);

  toast.addEventListener('mouseenter', () => { hovered = true; pause(); });
  toast.addEventListener('mouseleave', () => { hovered = false; startTimer(); });
  toast.addEventListener('focusin', () => { focused = true; pause(); });
  toast.addEventListener('focusout', (event) => {
    if (toast.contains(event.relatedTarget)) return;
    focused = false;
    startTimer();
  });

  const parent = getContainer();
  parent.appendChild(toast);
  while (parent.children.length > MAX_VISIBLE) parent.firstElementChild.remove();
  startTimer();

  return { dismiss, element: toast };
}
