/**
 * Transient messages at the bottom of the screen, with an optional action (such as Undo).
 * Messages and labels are set as text, never as HTML.
 *
 * Screen readers hear toasts through two live regions that are created once and then kept: a polite one
 * (`.toast-container`) and an assertive one for errors (`.toast-alerts`). A toast's text is filled in just
 * after the toast is added, so it reads as a change to a region the screen reader already knows.
 */

const DEFAULT_TIMEOUT_MS = 6000;
const MAX_VISIBLE = 3;

let regions = null; // { stack, polite, alerts }
const visible = []; // dismiss functions, oldest first

function getRegions() {
  if (regions?.stack.isConnected) return regions;
  const stack = document.createElement('div');
  stack.className = 'toast-stack';
  const polite = document.createElement('div');
  polite.className = 'toast-container';
  polite.setAttribute('aria-live', 'polite');
  polite.setAttribute('aria-relevant', 'additions text');
  const alerts = document.createElement('div');
  alerts.className = 'toast-alerts';
  alerts.setAttribute('role', 'alert');
  alerts.setAttribute('aria-live', 'assertive');
  alerts.setAttribute('aria-relevant', 'additions text');
  stack.append(polite, alerts);
  document.body.appendChild(stack);
  visible.length = 0; // toasts in a removed stack are gone
  regions = { stack, polite, alerts };
  return regions;
}

/**
 * @param message  plain text
 * @param options.action   `{ label, onClick }`: a button that runs `onClick`, then dismisses the toast
 * @param options.timeout  milliseconds before it goes (paused while hovered or focused); 0 keeps it until dismissed
 * @param options.kind     'info' (announced politely) or 'error' (announced at once)
 * @returns `{ dismiss, element }`
 */
export function showToast(message, { action = null, timeout = DEFAULT_TIMEOUT_MS, kind = 'info' } = {}) {
  const isError = kind === 'error';
  const toast = document.createElement('div');
  toast.className = `toast toast-${isError ? 'error' : 'info'}`;

  const text = document.createElement('span');
  text.className = 'toast-message';
  toast.appendChild(text);

  let timer = null;
  let fill = null;
  let dismissed = false;
  let hovered = false;
  let focused = false;

  function dismiss() {
    if (dismissed) return;
    dismissed = true;
    clearTimeout(timer);
    clearTimeout(fill);
    toast.remove();
    const index = visible.indexOf(dismiss);
    if (index !== -1) visible.splice(index, 1);
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

  const { polite, alerts } = getRegions();
  (isError ? alerts : polite).appendChild(toast);
  visible.push(dismiss);
  while (visible.length > MAX_VISIBLE) visible[0]();
  fill = setTimeout(() => { text.textContent = String(message); }, 0);
  startTimer();

  return { dismiss, element: toast };
}
