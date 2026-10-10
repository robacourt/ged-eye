/**
 * The header's sign-in button, the sign-in dialog (email code, Google, and a password form in development),
 * and the account menu (email, role, History, Editors, Sign out; for admins, "Access requests (N)"; for a
 * non-editor, Request edit access, or when they asked).
 *
 * It owns reading `/me` after every sign-in (including a restored session), and reports the result through
 * `onSignedIn(me, reason)`; every sign-out (including an expired session) is reported through `onSignedOut(reason)`.
 * User-provided strings are only ever set with `textContent`.
 */
import { showToast } from './toast.js';
import { openAccessRequestDialog, shortDate } from './accessRequestDialog.js';

export const COOKIE_BLOCKED_MESSAGE =
  'Your browser blocked the sign-in cookie. Editing needs a recent Safari/iOS, Chrome, Edge or Firefox.';

const GENERIC_ERROR = 'Something went wrong. Try again.';
const EXPIRED_TOAST_MS = 15_000;

// Better Auth's error codes, and 429 from its rate limiter.
const AUTH_MESSAGES = {
  INVALID_OTP: "That code isn't right. Check the email and try again.",
  OTP_EXPIRED: 'That code has expired. Send a new one.',
  TOO_MANY_ATTEMPTS: 'Too many wrong codes. Send a new one.',
  INVALID_EMAIL: 'Enter a full email address, like name@example.com.',
  INVALID_EMAIL_OR_PASSWORD: 'Wrong email or password.'
};

const ROLE_LABELS = { admin: 'Admin', editor: 'Editor' };

/** Words an AuthClientError (from auth.js) or ApiError (from editApi.js) for a person. */
export function friendlyError(error) {
  if (!error) return GENERIC_ERROR;
  if (typeof error.code === 'string' && Object.hasOwn(AUTH_MESSAGES, error.code)) return AUTH_MESSAGES[error.code];
  if (error.status === 429) return 'Too many attempts. Wait a minute, then try again.';
  if (error.name === 'ApiError') {
    if (error.code === 'network') return error.message;
    if (error.status === 401) return "The server didn't accept your sign-in. Sign out, then sign in again.";
    return `The server had a problem (${error.code}). Try again.`;
  }
  return error.message || GENERIC_ERROR;
}

function validateEmail(email) {
  if (!email) return 'Enter your email address.';
  if (!/^[^@]+@[^@]+$/.test(email)) return 'Enter a full email address, like name@example.com.';
  return null;
}

/** The first character (not UTF-16 unit) of `text`, upper-cased. */
const initial = (text) => ([...String(text).trim()][0] ?? '?').toUpperCase();

function callSafely(callback, ...args) {
  try {
    callback?.(...args);
  } catch (error) {
    console.error('Sign-in callback failed', error);
  }
}

const FOCUSABLE = 'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])';

let nextId = 0;

function dialogMarkup(id, dev) {
  // Static markup only: every dynamic string is set with textContent afterwards.
  const devForm = dev ? `
        <section class="signin-dev" aria-labelledby="${id}-dev-title">
          <h3 class="signin-dev-title" id="${id}-dev-title">Development sign-in</h3>
          <form class="signin-password-form" novalidate>
            <label class="editor-field">
              <span>Email</span>
              <input class="editor-input" name="email" type="email" autocomplete="username" aria-describedby="${id}-password-error">
            </label>
            <label class="editor-field">
              <span>Password</span>
              <input class="editor-input" name="password" type="password" autocomplete="current-password" aria-describedby="${id}-password-error">
            </label>
            <p class="editor-error" id="${id}-password-error" role="alert" hidden></p>
            <button type="submit" class="editor-btn" data-label="Sign in with password">Sign in with password</button>
          </form>
        </section>` : '';
  return `
    <div class="editor-dialog signin-dialog" role="dialog" aria-modal="true" aria-labelledby="${id}-title" aria-busy="false" data-step="email">
      <div class="editor-dialog-header">
        <h2 class="editor-dialog-title" id="${id}-title">Sign in to edit</h2>
        <button type="button" class="editor-dialog-close" aria-label="Close">×</button>
      </div>
      <div class="editor-dialog-body signin-body">
        <p class="signin-notice" role="alert" hidden></p>
        <section class="signin-step-email">
          <form class="signin-email-form" novalidate>
            <label class="editor-field">
              <span>Email</span>
              <input class="editor-input" name="email" type="email" autocomplete="email" aria-describedby="${id}-email-error">
            </label>
            <p class="editor-error" id="${id}-email-error" role="alert" hidden></p>
            <button type="submit" class="editor-btn editor-btn-primary" data-label="Email me a code">Email me a code</button>
          </form>
          <p class="signin-or"><span>or</span></p>
          <button type="button" class="editor-btn signin-google" data-label="Continue with Google">Continue with Google</button>
          <p class="editor-error signin-google-error" role="alert" hidden></p>${devForm}
        </section>
        <section class="signin-step-code" hidden>
          <p class="signin-sent"></p>
          <form class="signin-code-form" novalidate>
            <label class="editor-field">
              <span>6-digit code</span>
              <input class="editor-input signin-code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" aria-describedby="${id}-code-error">
            </label>
            <p class="editor-error" id="${id}-code-error" role="alert" hidden></p>
            <button type="submit" class="editor-btn editor-btn-primary" data-label="Sign in">Sign in</button>
          </form>
          <div class="signin-code-actions">
            <button type="button" class="editor-btn-link signin-resend" data-label="Send a new code">Send a new code</button>
            <button type="button" class="editor-btn-link signin-back" data-label="Use a different email">Use a different email</button>
          </div>
        </section>
      </div>
    </div>`;
}

function menuMarkup(menuId) {
  return `
    <div class="account-menu" id="${menuId}" hidden>
      <p class="account-email"></p>
      <p class="account-role"></p>
      <p class="account-note" hidden></p>
      <div class="account-actions">
        <button type="button" class="editor-btn account-retry" hidden>Try again</button>
        <button type="button" class="editor-btn editor-btn-primary account-request" hidden>Request edit access</button>
        <button type="button" class="editor-btn editor-btn-primary account-requests" hidden></button>
        <button type="button" class="editor-btn account-history" hidden>History</button>
        <button type="button" class="editor-btn account-editors" hidden>Editors</button>
        <button type="button" class="editor-btn account-signout">Sign out</button>
      </div>
    </div>`;
}

/**
 * @param container     where the header button goes (it is fixed to the top right)
 * @param auth          auth.js's module, or a `createAuth()` instance
 * @param api           has `me()` and `requestAccess(note)` (editApi.js)
 * @param onSignedIn    (me, reason) after `/me` answers for a newly signed-in or restored user;
 *                      `me` is `{ email, name, role }` (plus `pendingRequests` for an admin), role null for a
 *                      non-editor (with `accessRequest`); reason 'signed-in' | 'restored'
 * @param onSignedOut   (reason): 'signed-out' | 'expired' | 'cookie-blocked'
 * @param openHistory   () from the menu's History
 * @param openEditors   () from the menu's Editors and "Access requests (N)" (admins only)
 * @returns `{ open, close, isOpen, openMenu, closeMenu, refreshAccount, getAccount, destroy }`
 */
export function mountSignIn({ container, auth, api, onSignedIn, onSignedOut, openHistory, openEditors }) {
  const id = `signin-${++nextId}`;
  const dev = typeof auth.signInWithPassword === 'function';

  // Header button and account menu.
  const wrapper = document.createElement('div');
  wrapper.className = 'signin';
  wrapper.innerHTML = `<button type="button" class="signin-button"></button>${menuMarkup(`${id}-menu`)}`;
  container.appendChild(wrapper);
  const button = wrapper.querySelector('.signin-button');
  const menu = wrapper.querySelector('.account-menu');
  const menuEmail = menu.querySelector('.account-email');
  const menuRole = menu.querySelector('.account-role');
  const menuNote = menu.querySelector('.account-note');
  const retryButton = menu.querySelector('.account-retry');
  const requestButton = menu.querySelector('.account-request');
  const requestsButton = menu.querySelector('.account-requests');
  const historyButton = menu.querySelector('.account-history');
  const editorsButton = menu.querySelector('.account-editors');
  const signOutButton = menu.querySelector('.account-signout');

  // Dialog.
  const backdrop = document.createElement('div');
  backdrop.className = 'editor-dialog-backdrop signin-backdrop';
  backdrop.hidden = true;
  backdrop.innerHTML = dialogMarkup(id, dev);
  document.body.appendChild(backdrop);
  const dialog = backdrop.querySelector('.signin-dialog');
  const body = dialog.querySelector('.signin-body');
  const closeButton = dialog.querySelector('.editor-dialog-close');
  const notice = dialog.querySelector('.signin-notice');
  const emailStep = dialog.querySelector('.signin-step-email');
  const codeStep = dialog.querySelector('.signin-step-code');
  const emailForm = dialog.querySelector('.signin-email-form');
  const emailInput = emailForm.querySelector('input[name="email"]');
  const emailSubmit = emailForm.querySelector('button[type="submit"]');
  const emailError = emailForm.querySelector('.editor-error');
  const googleButton = dialog.querySelector('.signin-google');
  const googleError = dialog.querySelector('.signin-google-error');
  const sent = dialog.querySelector('.signin-sent');
  const codeForm = dialog.querySelector('.signin-code-form');
  const codeInput = codeForm.querySelector('input[name="code"]');
  const codeSubmit = codeForm.querySelector('button[type="submit"]');
  const codeError = codeForm.querySelector('.editor-error');
  const resendButton = dialog.querySelector('.signin-resend');
  const backButton = dialog.querySelector('.signin-back');
  const passwordForm = dialog.querySelector('.signin-password-form');

  let account = { status: 'none' }; // 'loading' | 'ready' (with me) | 'error' (with error)
  let accountRequest = null;        // { email, reason, promise }: the latest /me for the signed-in user
  let menuIsOpen = false;
  let isOpen = false;
  let session = 0;                  // bumped on open and close, so late replies are ignored
  let busy = false;
  let pendingEmail = '';
  let returnFocus = null;
  let openOptions = {};             // the current open()'s { googleCallbackURL, onCancel }
  let requestDialog = null;         // the Request edit access dialog, once opened

  // --- Account ---------------------------------------------------------------------------------------------

  /**
   * Reads `/me`. A request granted while it was being read can come back as granted with the role still null:
   * then `/me` is read once more (`recheckGranted`), and only that answer is reported.
   */
  function loadAccount(reason, { recheckGranted = true } = {}) {
    const email = auth.getState().user?.email;
    if (!email) return Promise.resolve(null);
    const request = { email, reason };
    accountRequest = request;
    account = { status: 'loading' };
    render();
    request.promise = (async () => {
      let me;
      try {
        me = await api.me();
      } catch (error) {
        if (accountRequest !== request) return null;
        account = { status: 'error', error };
        render();
        return null;
      }
      if (accountRequest !== request) return null;
      if (recheckGranted && !me?.role && me?.accessRequest?.status === 'granted') {
        return loadAccount(reason, { recheckGranted: false });
      }
      account = { status: 'ready', me };
      render();
      callSafely(onSignedIn, me, reason);
      return me;
    })();
    return request.promise;
  }

  const refreshAccount = () => loadAccount(accountRequest?.reason ?? 'signed-in');

  /** A request just sent (or already pending) for `email`: the menu says so, without reading `/me` again. */
  function showRequested(email, request) {
    if (account.status !== 'ready' || account.me.role || account.me.email !== email) return;
    const accessRequest = { status: request?.status ?? 'pending', createdAt: request?.createdAt ?? new Date().toISOString() };
    account = { status: 'ready', me: { ...account.me, accessRequest } };
    render();
  }

  /** An admin's count of pending requests, from `/me`; 0 when missing. */
  const pendingRequests = (me) => (Number.isInteger(me?.pendingRequests) && me.pendingRequests > 0 ? me.pendingRequests : 0);

  /** The /me already started for `email` by the sign-in event, or a new one. */
  function accountFor(email) {
    return accountRequest?.email === email ? accountRequest.promise : loadAccount('signed-in');
  }

  // --- Rendering -------------------------------------------------------------------------------------------

  function render() {
    const { user, cookieBlocked } = auth.getState();
    notice.textContent = COOKIE_BLOCKED_MESSAGE;
    notice.hidden = !(cookieBlocked && !user);

    if (!user) {
      menuIsOpen = false;
      menu.hidden = true;
      button.textContent = 'Sign in';
      button.classList.remove('signin-button-account');
      button.setAttribute('aria-haspopup', 'dialog');
      for (const name of ['aria-label', 'aria-expanded', 'aria-controls', 'title']) button.removeAttribute(name);
      return;
    }

    const me = account.status === 'ready' ? account.me : null;
    const email = me?.email || user.email;
    button.textContent = initial(me?.name || user.name || email);
    button.classList.add('signin-button-account');
    button.removeAttribute('aria-haspopup');
    button.setAttribute('aria-label', `Account: ${email}`);
    button.title = email;
    button.setAttribute('aria-controls', menu.id);
    button.setAttribute('aria-expanded', String(menuIsOpen));
    menu.hidden = !menuIsOpen;

    menuEmail.textContent = email;
    menuNote.hidden = true;
    retryButton.hidden = true;
    requestButton.hidden = true;
    requestsButton.hidden = true;
    historyButton.hidden = true;
    editorsButton.hidden = true;
    if (account.status === 'ready') {
      menuRole.textContent = ROLE_LABELS[me.role] ?? 'Not an editor';
      if (me.role) {
        historyButton.hidden = false;
        editorsButton.hidden = me.role !== 'admin';
        const pending = me.role === 'admin' ? pendingRequests(me) : 0;
        requestsButton.textContent = `Access requests (${pending})`;
        requestsButton.hidden = pending === 0;
      } else if (me.accessRequest?.status === 'pending') {
        // A dismissed request is never mentioned; a granted one with no role was read again (loadAccount).
        const date = shortDate(me.accessRequest.createdAt);
        menuNote.textContent = date ? `You asked for edit access on ${date}.` : 'You asked for edit access.';
        menuNote.hidden = false;
      } else {
        menuNote.textContent = `You're signed in as ${email} but not on the editors list.`;
        menuNote.hidden = false;
        requestButton.hidden = false;
      }
    } else if (account.status === 'error') {
      menuRole.textContent = '';
      menuNote.textContent = `Couldn't check your editing access. ${friendlyError(account.error)}`;
      menuNote.hidden = false;
      retryButton.hidden = false;
    } else {
      menuRole.textContent = 'Checking your access…';
    }
    menuRole.hidden = !menuRole.textContent;
  }

  // --- Account menu ----------------------------------------------------------------------------------------

  function openMenu() {
    if (!auth.getState().user) return;
    menuIsOpen = true;
    render();
  }

  function closeMenu() {
    if (!menuIsOpen) return;
    const hadFocus = menu.contains(document.activeElement);
    menuIsOpen = false;
    render();
    if (hadFocus) button.focus();
  }

  button.addEventListener('click', () => {
    if (!auth.getState().user) open();
    else if (menuIsOpen) closeMenu();
    else openMenu();
  });

  retryButton.addEventListener('click', refreshAccount);

  requestButton.addEventListener('click', () => {
    const me = account.status === 'ready' ? account.me : null;
    if (!me || me.role) return;
    closeMenu();
    button.focus(); // where focus goes back when the dialog closes
    requestDialog?.close();
    const email = me.email;
    requestDialog = openAccessRequestDialog({
      api,
      email,
      onSent: (request) => showRequested(email, request),
      onAlreadyAnEditor: () => {
        if (auth.getState().user?.email === email) refreshAccount();
      }
    });
  });

  requestsButton.addEventListener('click', () => {
    closeMenu();
    callSafely(openEditors);
  });

  historyButton.addEventListener('click', () => {
    closeMenu();
    callSafely(openHistory);
  });

  editorsButton.addEventListener('click', () => {
    closeMenu();
    callSafely(openEditors);
  });

  signOutButton.addEventListener('click', async () => {
    signOutButton.disabled = true;
    try {
      await auth.signOut();
    } catch (error) {
      console.error('Sign-out failed', error);
      showToast("Couldn't reach the sign-in service. You're signed out on this page, but may be signed in again after a reload.",
        { kind: 'error' });
    } finally {
      signOutButton.disabled = false;
      closeMenu();
      // Disabling the focused button may have dropped focus to the page.
      if (document.activeElement === document.body) button.focus();
    }
  });

  // --- Dialog ----------------------------------------------------------------------------------------------

  function showStep(step) {
    dialog.dataset.step = step;
    emailStep.hidden = step !== 'email';
    codeStep.hidden = step !== 'code';
  }

  function clearErrors() {
    for (const error of dialog.querySelectorAll('.editor-error')) {
      error.hidden = true;
      error.textContent = '';
    }
    for (const input of dialog.querySelectorAll('[aria-invalid]')) input.removeAttribute('aria-invalid');
  }

  function showError(errorElement, message, focusTarget) {
    errorElement.textContent = message;
    errorElement.hidden = false;
    if (focusTarget?.tagName === 'INPUT') focusTarget.setAttribute('aria-invalid', 'true');
    focusTarget?.focus();
  }

  function setBusy(activeButton, label) {
    busy = true;
    dialog.setAttribute('aria-busy', 'true');
    for (const control of body.querySelectorAll('button, input')) control.disabled = true;
    if (activeButton) activeButton.textContent = label;
  }

  function clearBusy() {
    busy = false;
    dialog.setAttribute('aria-busy', 'false');
    for (const control of body.querySelectorAll('button, input')) control.disabled = false;
    for (const control of body.querySelectorAll('button[data-label]')) control.textContent = control.dataset.label;
  }

  /** Runs `task` with the dialog busy. `stale` when the dialog was closed (or reopened) meanwhile. */
  async function attempt(activeButton, busyLabel, task) {
    clearErrors();
    const current = session;
    setBusy(activeButton, busyLabel);
    let result;
    let error = null;
    try {
      result = await task();
    } catch (caught) {
      error = caught;
    }
    const stale = current !== session;
    if (!stale) clearBusy();
    return { stale, result, error };
  }

  function showSent(prefix) {
    const strong = document.createElement('strong');
    strong.textContent = pendingEmail;
    sent.replaceChildren(prefix, strong, '.');
  }

  /** After a sign-in call: signed in (close, or show a failed /me in the menu), or the cookie was blocked. */
  function finishSignIn(state) {
    if (!state?.user) {
      showStep('email');
      render();
      emailInput.focus();
      return;
    }
    close();
    if (account.status === 'error') openMenu();
  }

  /** Signs in with `signIn()`, keeping the dialog busy until `/me` has answered too. */
  function signInTask(signIn) {
    return async () => {
      const state = await signIn();
      if (state?.user) await accountFor(state.user.email);
      return state;
    };
  }

  emailForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy) return;
    clearErrors();
    const email = emailInput.value.trim();
    const invalid = validateEmail(email);
    if (invalid) return showError(emailError, invalid, emailInput);
    const { stale, error } = await attempt(emailSubmit, 'Sending…', () => auth.sendEmailCode(email));
    if (stale) return;
    if (error) return showError(emailError, friendlyError(error), emailInput);
    pendingEmail = email;
    showSent('We sent a 6-digit code to ');
    codeInput.value = '';
    showStep('code');
    codeInput.focus();
  });

  codeForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy) return;
    clearErrors();
    const code = codeInput.value.replace(/[\s-]+/g, ''); // pasted codes may be spaced, like "123 456"
    if (!/^\d{6}$/.test(code)) return showError(codeError, 'Enter the 6-digit code from the email.', codeInput);
    const { stale, result, error } = await attempt(codeSubmit, 'Signing in…',
      signInTask(() => auth.verifyEmailCode(pendingEmail, code)));
    if (stale) return;
    if (error) return showError(codeError, friendlyError(error), codeInput);
    finishSignIn(result);
  });

  resendButton.addEventListener('click', async () => {
    if (busy) return;
    const { stale, error } = await attempt(resendButton, 'Sending…', () => auth.sendEmailCode(pendingEmail));
    if (stale) return;
    if (error) return showError(codeError, friendlyError(error), codeInput);
    showSent('We sent a new code to ');
    codeInput.value = '';
    codeInput.focus();
  });

  backButton.addEventListener('click', () => {
    if (busy) return;
    clearErrors();
    showStep('email');
    emailInput.value = pendingEmail;
    emailInput.focus();
  });

  /** Where Google should send the browser back to: the URL open() was given, else (undefined) this page. */
  function googleOptions() {
    const { googleCallbackURL } = openOptions;
    const callbackURL = typeof googleCallbackURL === 'function' ? googleCallbackURL() : googleCallbackURL;
    return callbackURL ? { callbackURL } : undefined;
  }

  googleButton.addEventListener('click', async () => {
    if (busy) return;
    const options = googleOptions();
    const { stale, error } = await attempt(googleButton, 'Opening Google…', () => auth.signInWithGoogle(options));
    if (stale) return;
    if (error) return showError(googleError, friendlyError(error), googleButton);
    setBusy(googleButton, 'Opening Google…'); // the browser is on its way to Google
  });

  if (passwordForm) {
    const passwordEmail = passwordForm.querySelector('input[name="email"]');
    const password = passwordForm.querySelector('input[name="password"]');
    const passwordSubmit = passwordForm.querySelector('button[type="submit"]');
    const passwordError = passwordForm.querySelector('.editor-error');
    passwordForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (busy) return;
      clearErrors();
      const email = passwordEmail.value.trim();
      const invalid = validateEmail(email);
      if (invalid) return showError(passwordError, invalid, passwordEmail);
      if (!password.value) return showError(passwordError, 'Enter the password.', password);
      const { stale, result, error } = await attempt(passwordSubmit, 'Signing in…',
        signInTask(() => auth.signInWithPassword(email, password.value)));
      if (stale) return;
      if (error) return showError(passwordError, friendlyError(error), password);
      password.value = '';
      finishSignIn(result);
    });
  }

  closeButton.addEventListener('click', () => close());

  /**
   * Opens the sign-in dialog. Options, for this opening only (a call while it is open replaces them, if given):
   * `googleCallbackURL` (a URL, or a function giving one when Google is chosen) is where Google sends the browser
   * back to, instead of this page; `onCancel` () runs if the dialog closes without anyone signed in.
   */
  function open(options = {}) {
    if (isOpen) {
      if (Object.keys(options).length > 0) openOptions = options;
      return;
    }
    openOptions = options;
    closeMenu();
    session++;
    isOpen = true;
    const active = document.activeElement;
    returnFocus = active && active !== document.body && !backdrop.contains(active) ? active : null;
    clearBusy();
    clearErrors();
    showStep('email');
    if (pendingEmail && !emailInput.value) emailInput.value = pendingEmail;
    document.body.appendChild(backdrop); // last, so it's above any dialog already open
    backdrop.hidden = false;
    render();
    emailInput.focus();
  }

  function close({ restoreFocus = true } = {}) {
    if (!isOpen) return;
    session++;
    isOpen = false;
    busy = false;
    backdrop.hidden = true;
    const { onCancel } = openOptions;
    openOptions = {};
    if (!auth.getState().user) callSafely(onCancel);
    if (!restoreFocus) return;
    const target = returnFocus?.isConnected && !returnFocus.closest('[hidden]') ? returnFocus : button;
    returnFocus = null;
    target.focus();
  }

  function focusables() {
    return [...dialog.querySelectorAll(FOCUSABLE)].filter(el => !el.disabled && !el.closest('[hidden]'));
  }

  function trapTab(event) {
    const items = focusables();
    if (items.length === 0) {
      event.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !dialog.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  }

  /** Open dialogs, bottom to top: by z-index (the sign-in dialog's is highest), then document order. */
  function openDialogs() {
    const zIndex = (el) => Number.parseInt(getComputedStyle(el).zIndex, 10) || 0;
    return [...document.querySelectorAll('.editor-dialog-backdrop')]
      .filter(el => !el.hidden)
      .map((el, order) => ({ el, order, z: zIndex(el) }))
      .sort((a, b) => a.z - b.z || a.order - b.order)
      .map(({ el }) => el);
  }

  const isTopmost = () => isOpen && openDialogs().at(-1) === backdrop;

  // Registered in the capture phase, so an Escape that closes this dialog never reaches a dialog below it.
  function onKeyDown(event) {
    if (isOpen) {
      if (!isTopmost()) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close();
      } else if (event.key === 'Tab') {
        trapTab(event);
      }
      return;
    }
    if (menuIsOpen && event.key === 'Escape' && openDialogs().length === 0) {
      event.preventDefault();
      event.stopPropagation();
      closeMenu();
      button.focus();
    }
  }

  function onDocumentClick(event) {
    if (menuIsOpen && !wrapper.contains(event.target)) closeMenu();
  }

  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('click', onDocumentClick);

  // --- Auth events -----------------------------------------------------------------------------------------

  let expiredToast = null;

  function showExpiredToast() {
    if (expiredToast?.element.isConnected) return;
    expiredToast = showToast('Signed out — sign in again.', {
      timeout: EXPIRED_TOAST_MS,
      action: { label: 'Sign in', onClick: () => open() }
    });
  }

  function dismissExpiredToast() {
    expiredToast?.dismiss();
    expiredToast = null;
  }

  const unsubscribe = auth.onChange((state, reason) => {
    switch (reason) {
      case 'restored':
      case 'signed-in':
        if (!state.user) return;
        dismissExpiredToast();
        // Signed in by a restore or in another tab while the dialog sat idle. (A sign-in from the dialog
        // keeps it busy until /me has answered, then closes it itself.)
        if (isOpen && !busy) close();
        loadAccount(reason);
        return;
      case 'signed-out':
      case 'expired':
      case 'cookie-blocked':
        accountRequest = null;
        account = { status: 'none' };
        requestDialog?.close();
        closeMenu();
        render();
        callSafely(onSignedOut, reason);
        if (reason === 'expired') showExpiredToast();
        else if (reason === 'cookie-blocked' && !isOpen) open();
        return;
      default:
        // 'role': me() caching the role it just returned. The menu already shows /me's answer.
    }
  });

  render();
  if (auth.getState().user) loadAccount('restored');

  return {
    open,
    close,
    /** Whether the sign-in dialog is open (keyboard shortcuts should then be ignored). */
    isOpen: () => isOpen,
    openMenu,
    closeMenu,
    /**
     * Reads `/me` again (for example after an admin changed roles, or acted on access requests).
     * Resolves to `me`, or null on failure.
     */
    refreshAccount,
    /** `{ email, name, role, ... }` once `/me` has answered for the signed-in user, else null. */
    getAccount: () => (account.status === 'ready' ? account.me : null),
    destroy() {
      unsubscribe();
      dismissExpiredToast();
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('click', onDocumentClick);
      requestDialog?.close();
      close({ restoreFocus: false });
      accountRequest = null;
      wrapper.remove();
      backdrop.remove();
    }
  };
}
