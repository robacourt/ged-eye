import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createAuth } from '../src/auth.js';
import { ApiError } from '../src/editApi.js';
import { mountSignIn, friendlyError, COOKIE_BLOCKED_MESSAGE } from '../src/signIn.js';

const XSS = '<img src=x onerror="window.__xss = 1">';
const GOOD_CODE = '123456';

const b64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt = () => `${b64url({ alg: 'EdDSA' })}.${b64url({ exp: Math.floor(Date.now() / 1000) + 900 })}.signature`;
const sessionFor = (email, name = null) => ({ session: { token: jwt() }, user: { id: 'u1', email, name, emailVerified: true } });
const ok = (data) => ({ data, error: null });
const fail = (code, message, status = 400) => ({ data: null, error: { code, message, status } });

/**
 * A stand-in for the @neondatabase/auth client, driving the real `createAuth`. A sign-in stores the session
 * "in the cookie" (`server`), unless `cookieBlocked`, when the browser drops it.
 */
function fakeClient({ session = null, cookieBlocked = false } = {}) {
  const state = { cached: session, server: session };
  const signedIn = (email) => {
    if (!cookieBlocked) state.server = sessionFor(email);
    return ok({ token: 'opaque', user: { email } });
  };
  return {
    state,
    getSession: vi.fn(async (options) => {
      if (options?.fetchOptions?.headers?.['X-Force-Fetch'] === 'true') state.cached = state.server;
      return ok(state.cached);
    }),
    emailOtp: { sendVerificationOtp: vi.fn(async () => ok({ success: true })) },
    signIn: {
      emailOtp: vi.fn(async ({ email, otp }) => (otp === GOOD_CODE ? signedIn(email) : fail('INVALID_OTP', 'Invalid OTP'))),
      email: vi.fn(async ({ email, password }) =>
        (password === 'secret' ? signedIn(email) : fail('INVALID_EMAIL_OR_PASSWORD', 'Invalid email or password', 401))),
      social: vi.fn(async () => ok({ url: 'https://accounts.google.com/o/oauth2', redirect: true }))
    },
    signOut: vi.fn(async () => {
      state.cached = state.server = null;
      return ok({ success: true });
    })
  };
}

const ACCOUNTS = {
  admin: { email: 'rob@example.com', name: 'Rob Acourt', role: 'admin' },
  editor: { email: 'rose@example.com', name: 'Rose Smith', role: 'editor' },
  viewer: { email: 'tom@example.com', name: null, role: null }
};

/** Like editApi's me(), it caches the role in auth (which tells listeners 'role'). `setup` sets `auth`. */
function fakeApi(account = ACCOUNTS.editor) {
  const api = {
    auth: null,
    me: vi.fn(async () => {
      api.auth?.setRole(account.role, account.email);
      return { ...account };
    })
  };
  return api;
}

/** A promise with its resolve and reject exposed, to hold a call in flight. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
async function settle() {
  for (let i = 0; i < 5; i++) await flush();
}

let controller;

function setup({ client = fakeClient(), dev = false, api = fakeApi(), auth = createAuth({ client, dev }) } = {}) {
  document.body.innerHTML = '<div id="header"></div>';
  api.auth ??= auth;
  const callbacks = {
    onSignedIn: vi.fn(),
    onSignedOut: vi.fn(),
    openHistory: vi.fn(),
    openEditors: vi.fn()
  };
  controller = mountSignIn({ container: document.getElementById('header'), auth, api, ...callbacks });
  return { client, auth, api, controller, ...callbacks };
}

const $ = (selector) => document.querySelector(selector);
const headerButton = () => $('.signin-button');
const dialog = () => $('.signin-dialog');
const dialogOpen = () => !!dialog() && !$('.signin-backdrop').hidden;
const step = () => dialog().dataset.step;
const menu = () => $('.account-menu');
const menuOpen = () => !!menu() && !menu().hidden;
const visible = (el) => !!el && !el.closest('[hidden]');
const visibleText = (selector) => [...document.querySelectorAll(selector)].filter(visible).map(el => el.textContent);
const menuButtons = () => [...menu().querySelectorAll('button')].filter(visible).map(b => b.textContent);
const errorText = (form) => {
  const error = form.querySelector('.editor-error');
  return visible(error) ? error.textContent : null;
};

function type(input, value) {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function submit(form) {
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

function key(name, options = {}) {
  const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...options });
  (document.activeElement ?? document.body).dispatchEvent(event);
  return event;
}

async function requestCode(email = 'rose@example.com') {
  headerButton().click();
  type($('.signin-email-form input[name="email"]'), email);
  submit($('.signin-email-form'));
  await settle();
}

async function signInByCode(email = 'rose@example.com', code = GOOD_CODE) {
  await requestCode(email);
  type($('.signin-code-form input[name="code"]'), code);
  submit($('.signin-code-form'));
  await settle();
}

describe('mountSignIn', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    controller?.destroy();
    controller = null;
    vi.restoreAllMocks();
    window.history.replaceState(null, '', '/');
  });

  describe('signed out', () => {
    it('shows a Sign in button in the container, and no dialog until it is clicked', () => {
      setup();
      expect(headerButton().textContent).toBe('Sign in');
      expect($('#header').contains(headerButton())).toBe(true);
      expect(headerButton().getAttribute('aria-haspopup')).toBe('dialog');
      expect(dialogOpen()).toBe(false);
      expect(menuOpen()).toBe(false);
    });

    it('opens a modal dialog on the email step, with focus in the email field', () => {
      setup();
      headerButton().click();
      expect(dialogOpen()).toBe(true);
      expect(dialog().getAttribute('role')).toBe('dialog');
      expect(dialog().getAttribute('aria-modal')).toBe('true');
      expect(document.getElementById(dialog().getAttribute('aria-labelledby')).textContent).toBe('Sign in to edit');
      expect(step()).toBe('email');
      const email = $('.signin-email-form input[name="email"]');
      expect(email.type).toBe('email');
      expect(email.getAttribute('autocomplete')).toBe('email');
      expect(document.activeElement).toBe(email);
      expect(visibleText('.signin-dialog button')).toEqual(expect.arrayContaining(['Email me a code', 'Continue with Google']));
    });
  });

  describe('email code', () => {
    it('goes from email to code to signed in, then reads /me and reports the account', async () => {
      const { client, api, onSignedIn } = setup();
      await requestCode('  rose@example.com ');
      expect(client.emailOtp.sendVerificationOtp).toHaveBeenCalledWith({ email: 'rose@example.com', type: 'sign-in' });
      expect(step()).toBe('code');
      expect($('.signin-sent').textContent).toContain('rose@example.com');
      const code = $('.signin-code-form input[name="code"]');
      expect(code.getAttribute('inputmode')).toBe('numeric');
      expect(code.getAttribute('autocomplete')).toBe('one-time-code');
      expect(code.getAttribute('maxlength')).toBeNull(); // so a pasted "123 456" fits
      expect(document.activeElement).toBe(code);
      expect(visibleText('.signin-dialog button')).toEqual(expect.arrayContaining(['Sign in', 'Use a different email']));

      type(code, ' 123 456 ');
      submit($('.signin-code-form'));
      await settle();
      expect(client.signIn.emailOtp).toHaveBeenCalledWith({ email: 'rose@example.com', otp: GOOD_CODE });
      expect(api.me).toHaveBeenCalledOnce();
      expect(onSignedIn).toHaveBeenCalledOnce();
      expect(onSignedIn).toHaveBeenCalledWith(ACCOUNTS.editor, 'signed-in');
      expect(dialogOpen()).toBe(false);
      expect(headerButton().textContent).toBe('R');
      expect(headerButton().getAttribute('aria-label')).toBe('Account: rose@example.com');
      expect(document.activeElement).toBe(headerButton());
    });

    it('disables the dialog while a request is in flight', async () => {
      const client = fakeClient();
      const pending = deferred();
      client.emailOtp.sendVerificationOtp.mockReturnValue(pending.promise);
      setup({ client });
      headerButton().click();
      type($('.signin-email-form input[name="email"]'), 'rose@example.com');
      submit($('.signin-email-form'));
      await flush();
      const submitButton = $('.signin-email-form button[type="submit"]');
      expect(submitButton.disabled).toBe(true);
      expect(submitButton.textContent).toBe('Sending…');
      expect($('.signin-google').disabled).toBe(true);
      expect($('.signin-email-form input[name="email"]').disabled).toBe(true);
      expect(dialog().getAttribute('aria-busy')).toBe('true');
      expect($('.editor-dialog-close').disabled).toBe(false);
      // A second submit while busy does nothing.
      submit($('.signin-email-form'));
      expect(client.emailOtp.sendVerificationOtp).toHaveBeenCalledOnce();

      pending.resolve(ok({ success: true }));
      await settle();
      expect(step()).toBe('code');
      expect(dialog().getAttribute('aria-busy')).toBe('false');
      expect($('.signin-code-form button[type="submit"]').disabled).toBe(false);
      expect(submitButton.textContent).toBe('Email me a code');
    });

    it('asks for an email address before sending anything', async () => {
      const { client } = setup();
      await requestCode('   ');
      expect(client.emailOtp.sendVerificationOtp).not.toHaveBeenCalled();
      expect(step()).toBe('email');
      expect(errorText($('.signin-email-form'))).toBe('Enter your email address.');
      const input = $('.signin-email-form input[name="email"]');
      expect(input.getAttribute('aria-invalid')).toBe('true');
      expect(document.activeElement).toBe(input);
      type(input, 'rose');
      submit($('.signin-email-form'));
      expect(errorText($('.signin-email-form'))).toBe('Enter a full email address, like name@example.com.');
    });

    it('asks for six digits before verifying', async () => {
      const { client } = setup();
      await requestCode();
      type($('.signin-code-form input[name="code"]'), '12345');
      submit($('.signin-code-form'));
      await settle();
      expect(client.signIn.emailOtp).not.toHaveBeenCalled();
      expect(errorText($('.signin-code-form'))).toBe('Enter the 6-digit code from the email.');
    });

    it('shows a wrong code inline and stays on the code step', async () => {
      const { api, onSignedIn } = setup();
      await signInByCode('rose@example.com', '654321');
      expect(step()).toBe('code');
      expect(dialogOpen()).toBe(true);
      expect(errorText($('.signin-code-form'))).toBe("That code isn't right. Check the email and try again.");
      expect(document.activeElement).toBe($('.signin-code-form input[name="code"]'));
      expect(api.me).not.toHaveBeenCalled();
      expect(onSignedIn).not.toHaveBeenCalled();
      expect(headerButton().textContent).toBe('Sign in');

      // A corrected code clears the error and signs in.
      type($('.signin-code-form input[name="code"]'), GOOD_CODE);
      submit($('.signin-code-form'));
      await settle();
      expect(dialogOpen()).toBe(false);
      expect(onSignedIn).toHaveBeenCalledOnce();
    });

    it('shows a network failure inline on the email step', async () => {
      const client = fakeClient();
      client.emailOtp.sendVerificationOtp.mockRejectedValue(new TypeError('Failed to fetch'));
      setup({ client });
      await requestCode();
      expect(step()).toBe('email');
      expect(errorText($('.signin-email-form'))).toBe("Couldn't reach the sign-in service. Check your connection and try again.");
    });

    it('shows a server message as text', async () => {
      const client = fakeClient();
      client.emailOtp.sendVerificationOtp.mockResolvedValue(fail('SOMETHING_ODD', XSS, 400));
      setup({ client });
      await requestCode();
      expect(errorText($('.signin-email-form'))).toBe(XSS);
      expect(document.querySelector('.signin-dialog img')).toBeNull();
    });

    it('goes back to the email step, keeping the address, with "Use a different email"', async () => {
      setup();
      await requestCode('rose@example.com');
      $('.signin-back').click();
      expect(step()).toBe('email');
      const input = $('.signin-email-form input[name="email"]');
      expect(input.value).toBe('rose@example.com');
      expect(document.activeElement).toBe(input);
    });

    it('sends a new code on request', async () => {
      const { client } = setup();
      await requestCode('rose@example.com');
      $('.signin-resend').click();
      await settle();
      expect(client.emailOtp.sendVerificationOtp).toHaveBeenCalledTimes(2);
      expect($('.signin-sent').textContent).toContain('new code');
      expect(step()).toBe('code');
    });

    it('shows the address it sent to as text', async () => {
      setup();
      const email = `${XSS}@example.com`;
      await requestCode(email);
      expect($('.signin-sent').textContent).toContain(email);
      expect(document.querySelector('.signin-dialog img')).toBeNull();
    });

    it('explains a blocked cookie and stays signed out', async () => {
      const { api, onSignedIn } = setup({ client: fakeClient({ cookieBlocked: true }) });
      await signInByCode();
      expect(dialogOpen()).toBe(true);
      expect(step()).toBe('email');
      expect(visibleText('.signin-notice')).toEqual([COOKIE_BLOCKED_MESSAGE]);
      expect(COOKIE_BLOCKED_MESSAGE).toBe('Your browser blocked the sign-in cookie. Editing needs a recent Safari/iOS, Chrome, Edge or Firefox.');
      expect(headerButton().textContent).toBe('Sign in');
      expect(api.me).not.toHaveBeenCalled();
      expect(onSignedIn).not.toHaveBeenCalled();
    });
  });

  describe('Google', () => {
    it('starts the Google sign-in', async () => {
      const { client } = setup();
      headerButton().click();
      $('.signin-google').click();
      await settle();
      expect(client.signIn.social).toHaveBeenCalledWith({
        provider: 'google', callbackURL: window.location.href, newUserCallbackURL: window.location.href
      });
      expect(errorText($('.signin-step-email'))).toBeNull();
    });

    it('comes back to the URL it was opened with, read when Google is chosen', async () => {
      const { client, controller: c } = setup();
      let back = 'http://localhost:3000/?person=I7&access-requests=';
      c.open({ googleCallbackURL: () => back });
      back = 'http://localhost:3000/?person=I8&access-requests=';
      $('.signin-google').click();
      await settle();
      expect(client.signIn.social).toHaveBeenCalledWith({ provider: 'google', callbackURL: back, newUserCallbackURL: back });
    });

    it('comes back to the current page when opened again without one', async () => {
      const { client, controller: c } = setup();
      c.open({ googleCallbackURL: () => 'http://localhost:3000/?access-requests=' });
      c.close();
      headerButton().click();
      $('.signin-google').click();
      await settle();
      expect(client.signIn.social).toHaveBeenCalledWith(expect.objectContaining({ callbackURL: window.location.href }));
    });

    it('shows a failure inline', async () => {
      const client = fakeClient();
      client.signIn.social.mockRejectedValue(new TypeError('Failed to fetch'));
      setup({ client });
      headerButton().click();
      $('.signin-google').click();
      await settle();
      expect(visibleText('.signin-step-email .editor-error')).toEqual(["Couldn't reach the sign-in service. Check your connection and try again."]);
      expect($('.signin-google').disabled).toBe(false);
    });

    it('opens the dialog to explain a blocked cookie when the redirect comes back without a session', async () => {
      window.history.replaceState(null, '', '/?neon_auth_session_verifier=v1');
      const client = fakeClient({ session: sessionFor('rose@example.com') });
      client.state.server = null; // the browser dropped the cookie
      const { auth, onSignedOut } = setup({ client });
      await auth.init();
      expect(dialogOpen()).toBe(true);
      expect(visibleText('.signin-notice')).toEqual([COOKIE_BLOCKED_MESSAGE]);
      expect(onSignedOut).toHaveBeenCalledWith('cookie-blocked');
    });
  });

  describe('dev password form', () => {
    it('is absent unless the auth client offers password sign-in', () => {
      setup({ dev: false });
      headerButton().click();
      expect($('.signin-password-form')).toBeNull();
    });

    it('signs in with a password in development', async () => {
      const { client, api, onSignedIn } = setup({ dev: true });
      headerButton().click();
      const form = $('.signin-password-form');
      expect(form).not.toBeNull();
      expect(form.querySelector('input[name="password"]').type).toBe('password');
      type(form.querySelector('input[name="email"]'), 'dev-editor@example.test');
      type(form.querySelector('input[name="password"]'), 'wrong');
      submit(form);
      await settle();
      expect(errorText(form)).toBe('Wrong email or password.');

      type(form.querySelector('input[name="password"]'), 'secret');
      submit(form);
      await settle();
      expect(client.signIn.email).toHaveBeenLastCalledWith({ email: 'dev-editor@example.test', password: 'secret' });
      expect(api.me).toHaveBeenCalledOnce();
      expect(onSignedIn).toHaveBeenCalledOnce();
      expect(dialogOpen()).toBe(false);
    });
  });

  describe('closing', () => {
    it('closes on Escape and returns focus to the header button', () => {
      setup();
      headerButton().focus();
      headerButton().click();
      expect(document.activeElement).not.toBe(headerButton());
      const event = key('Escape');
      expect(event.defaultPrevented).toBe(true);
      expect(dialogOpen()).toBe(false);
      expect(document.activeElement).toBe(headerButton());
    });

    it('closes with the close button', () => {
      setup();
      headerButton().click();
      const close = $('.editor-dialog-close');
      expect(close.getAttribute('aria-label')).toBe('Close');
      close.click();
      expect(dialogOpen()).toBe(false);
    });

    it('keeps Tab inside the dialog', () => {
      setup();
      headerButton().click();
      const focusable = [...dialog().querySelectorAll('button, input')].filter(el => visible(el) && !el.disabled);
      focusable.at(-1).focus();
      expect(key('Tab').defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(focusable[0]);
      expect(key('Tab', { shiftKey: true }).defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(focusable.at(-1));
    });

    it('starts again on the email step after closing', async () => {
      setup();
      await signInByCode('rose@example.com', '000000');
      key('Escape');
      headerButton().click();
      expect(step()).toBe('email');
      expect(errorText($('.signin-code-form'))).toBeNull();
    });

    it('ignores a reply that arrives after the dialog was closed', async () => {
      const client = fakeClient();
      const pending = deferred();
      client.emailOtp.sendVerificationOtp.mockReturnValue(pending.promise);
      setup({ client });
      await requestCode();
      key('Escape');
      pending.resolve(ok({ success: true }));
      await settle();
      expect(dialogOpen()).toBe(false);
      headerButton().click();
      expect(step()).toBe('email');
      expect($('.signin-email-form button[type="submit"]').disabled).toBe(false);
    });
  });

  describe('account menu', () => {
    async function signedInAs(account, options = {}) {
      const ctx = setup({ client: fakeClient({ session: sessionFor(account.email, account.name) }), api: fakeApi(account), ...options });
      await ctx.auth.init();
      await settle();
      return ctx;
    }

    it('reads /me for a restored session and reports it', async () => {
      const { api, onSignedIn } = await signedInAs(ACCOUNTS.editor);
      expect(api.me).toHaveBeenCalledOnce();
      expect(onSignedIn).toHaveBeenCalledWith(ACCOUNTS.editor, 'restored');
      expect(headerButton().textContent).toBe('R');
      expect(headerButton().getAttribute('aria-haspopup')).toBeNull();
      expect(headerButton().getAttribute('aria-expanded')).toBe('false');
    });

    it("reads /me once when me() caches the role, which auth reports as a 'role' change", async () => {
      const reasons = [];
      const client = fakeClient({ session: sessionFor('rob@example.com') });
      const auth = createAuth({ client });
      auth.onChange((state, reason) => reasons.push(reason));
      const { api, onSignedIn, onSignedOut } = setup({ client, auth, api: fakeApi(ACCOUNTS.admin) });
      await auth.init();
      await settle();
      expect(reasons).toEqual(['restored', 'role']);
      expect(auth.getRole()).toBe('admin');
      expect(api.me).toHaveBeenCalledOnce();
      expect(onSignedIn).toHaveBeenCalledOnce();
      expect(onSignedIn).toHaveBeenCalledWith(ACCOUNTS.admin, 'restored');
      expect(onSignedOut).not.toHaveBeenCalled();
    });

    it('reads /me when mounted after the session was restored', async () => {
      const client = fakeClient({ session: sessionFor('rose@example.com') });
      const auth = createAuth({ client });
      await auth.init();
      const { api, onSignedIn } = setup({ client, auth });
      await settle();
      expect(api.me).toHaveBeenCalledOnce();
      expect(onSignedIn).toHaveBeenCalledWith(ACCOUNTS.editor, 'restored');
    });

    it('for an admin: email, role, History, Editors and Sign out', async () => {
      const { openHistory, openEditors } = await signedInAs(ACCOUNTS.admin);
      headerButton().click();
      expect(menuOpen()).toBe(true);
      expect(headerButton().getAttribute('aria-expanded')).toBe('true');
      expect(menu().querySelector('.account-email').textContent).toBe('rob@example.com');
      expect(menu().querySelector('.account-role').textContent).toBe('Admin');
      expect(menuButtons()).toEqual(['History', 'Editors', 'Sign out']);
      expect(visibleText('.account-note')).toEqual([]);

      $('.account-history').click();
      expect(openHistory).toHaveBeenCalledOnce();
      expect(menuOpen()).toBe(false);
      headerButton().click();
      $('.account-editors').click();
      expect(openEditors).toHaveBeenCalledOnce();
      expect(menuOpen()).toBe(false);
    });

    it('for an editor: no Editors', async () => {
      await signedInAs(ACCOUNTS.editor);
      headerButton().click();
      expect(menu().querySelector('.account-role').textContent).toBe('Editor');
      expect(menuButtons()).toEqual(['History', 'Sign out']);
    });

    it('for a signed-in non-editor: a note, Request edit access and Sign out', async () => {
      await signedInAs(ACCOUNTS.viewer);
      expect(headerButton().textContent).toBe('T');
      headerButton().click();
      expect(menu().querySelector('.account-role').textContent).toBe('Not an editor');
      expect(visibleText('.account-note')).toEqual([
        "You're signed in as tom@example.com but not on the editors list."
      ]);
      expect(menuButtons()).toEqual(['Request edit access', 'Sign out']);
    });

    it('shows names and emails as text', async () => {
      const account = { email: `${XSS}@example.com`, name: XSS, role: null };
      await signedInAs(account);
      headerButton().click();
      expect(menu().querySelector('.account-email').textContent).toBe(account.email);
      expect(visibleText('.account-note')[0]).toContain(account.email);
      expect(headerButton().textContent).toBe('<');
      expect(document.querySelector('img')).toBeNull();
    });

    it('says when it is still checking access', async () => {
      const api = fakeApi();
      const pending = deferred();
      api.me.mockReturnValue(pending.promise);
      await signedInAs(ACCOUNTS.editor, { api });
      headerButton().click();
      expect(menu().querySelector('.account-role').textContent).toBe('Checking your access…');
      expect(menuButtons()).toEqual(['Sign out']);
      pending.resolve(ACCOUNTS.editor);
      await settle();
      expect(menuButtons()).toEqual(['History', 'Sign out']);
    });

    it('shows a failed /me in the menu, with Try again', async () => {
      const api = fakeApi();
      api.me.mockRejectedValueOnce(new ApiError(0, 'network', { message: "Couldn't reach the server. Check your connection." }));
      const { onSignedIn } = await signedInAs(ACCOUNTS.editor, { api });
      expect(onSignedIn).not.toHaveBeenCalled();
      headerButton().click();
      expect(visibleText('.account-note')).toEqual([
        "Couldn't check your editing access. Couldn't reach the server. Check your connection."
      ]);
      expect(menuButtons()).toEqual(['Try again', 'Sign out']);
      $('.account-retry').click();
      await settle();
      expect(api.me).toHaveBeenCalledTimes(2);
      // The retry keeps the original reason.
      expect(onSignedIn).toHaveBeenCalledWith(ACCOUNTS.editor, 'restored');
      expect(menuButtons()).toEqual(['History', 'Sign out']);
    });

    it('opens the menu to show a failed /me straight after signing in', async () => {
      const api = fakeApi();
      api.me.mockRejectedValueOnce(new ApiError(500, 'internal', {}));
      setup({ api });
      await signInByCode();
      expect(dialogOpen()).toBe(false);
      expect(menuOpen()).toBe(true);
      expect(visibleText('.account-note')[0]).toMatch(/^Couldn't check your editing access\./);
    });

    it('signs out', async () => {
      const { client, onSignedOut } = await signedInAs(ACCOUNTS.editor);
      headerButton().click();
      $('.account-signout').click();
      await settle();
      expect(client.signOut).toHaveBeenCalledOnce();
      expect(onSignedOut).toHaveBeenCalledWith('signed-out');
      expect(headerButton().textContent).toBe('Sign in');
      expect(menuOpen()).toBe(false);
      expect(headerButton().getAttribute('aria-expanded')).toBeNull();
    });

    it('says so when the sign-out call fails, though it signed out here', async () => {
      const client = fakeClient({ session: sessionFor('rose@example.com') });
      client.signOut.mockRejectedValue(new TypeError('Failed to fetch'));
      const { onSignedOut } = await signedInAs(ACCOUNTS.editor, { client });
      headerButton().click();
      $('.account-signout').click();
      await settle();
      expect(onSignedOut).toHaveBeenCalledWith('signed-out');
      expect(headerButton().textContent).toBe('Sign in');
      const toast = $('.toast-error .toast-message');
      expect(toast.textContent).toMatch(/^Couldn't reach the sign-in service/);
    });

    it('closes on Escape and on a click outside', async () => {
      await signedInAs(ACCOUNTS.editor);
      headerButton().click();
      $('.account-history').focus();
      key('Escape');
      expect(menuOpen()).toBe(false);
      expect(document.activeElement).toBe(headerButton());
      headerButton().click();
      menu().click();
      expect(menuOpen()).toBe(true);
      document.body.click();
      expect(menuOpen()).toBe(false);
    });

    it('offers to sign in again when the session expires', async () => {
      const { client, auth, onSignedOut } = await signedInAs(ACCOUNTS.editor);
      client.state.server = null; // signed out elsewhere
      expect(await auth.getToken({ force: true })).toBeNull();
      expect(onSignedOut).toHaveBeenCalledWith('expired');
      expect(headerButton().textContent).toBe('Sign in');
      await settle();
      expect($('.toast-message').textContent).toBe('Signed out — sign in again.');
      $('.toast-action').click();
      expect(dialogOpen()).toBe(true);
    });

    it('removes the "sign in again" toast when someone signs in', async () => {
      const { client, auth } = await signedInAs(ACCOUNTS.editor);
      client.state.server = null;
      await auth.getToken({ force: true });
      expect(document.querySelectorAll('.toast')).toHaveLength(1);
      await signInByCode();
      expect(headerButton().textContent).toBe('R');
      expect(document.querySelectorAll('.toast')).toHaveLength(0);
    });

    describe('edit access requests', () => {
      // This year, so the date shows without one.
      const OCT_10 = new Date(new Date().getFullYear(), 9, 10, 12).toISOString();
      const asked = (status, createdAt = OCT_10) => ({ ...ACCOUNTS.viewer, accessRequest: { status, createdAt } });

      it('offers the request button again after a dismissal, without mentioning it', async () => {
        await signedInAs(asked('dismissed'));
        headerButton().click();
        expect(visibleText('.account-note')).toEqual(["You're signed in as tom@example.com but not on the editors list."]);
        expect(menuButtons()).toEqual(['Request edit access', 'Sign out']);
      });

      it('says when a request is pending, with no button', async () => {
        await signedInAs(asked('pending'));
        headerButton().click();
        expect(menu().querySelector('.account-role').textContent).toBe('Not an editor');
        expect(visibleText('.account-note')).toEqual(['You asked for edit access on 10 Oct.']);
        expect(menuButtons()).toEqual(['Sign out']);
      });

      it('reads /me once more when a request was granted but the role is still null', async () => {
        const api = fakeApi(asked('granted'));
        api.me.mockImplementationOnce(async () => ({ ...asked('granted') }));
        api.me.mockImplementationOnce(async () => {
          api.auth.setRole('editor', 'tom@example.com');
          return { ...ACCOUNTS.viewer, role: 'editor' };
        });
        const { onSignedIn } = await signedInAs(ACCOUNTS.viewer, { api });
        expect(api.me).toHaveBeenCalledTimes(2);
        expect(onSignedIn).toHaveBeenCalledOnce();
        expect(onSignedIn).toHaveBeenCalledWith({ ...ACCOUNTS.viewer, role: 'editor' }, 'restored');
        headerButton().click();
        expect(menuButtons()).toEqual(['History', 'Sign out']);
      });

      it('reads /me only once more, then offers the button', async () => {
        const api = fakeApi(asked('granted'));
        const { onSignedIn } = await signedInAs(ACCOUNTS.viewer, { api });
        expect(api.me).toHaveBeenCalledTimes(2);
        expect(onSignedIn).toHaveBeenCalledOnce();
        headerButton().click();
        expect(menuButtons()).toEqual(['Request edit access', 'Sign out']);
      });

      it('opens the request dialog from the menu, and shows the request once sent', async () => {
        const api = fakeApi(ACCOUNTS.viewer);
        api.requestAccess = vi.fn(async () => ({ request: { id: 7, status: 'pending', createdAt: OCT_10 }, created: true }));
        const { onSignedIn } = await signedInAs(ACCOUNTS.viewer, { api });
        headerButton().click();
        $('.account-request').click();
        expect(menuOpen()).toBe(false);
        const requestDialog = $('.access-request-dialog');
        expect(requestDialog).not.toBeNull();
        expect(requestDialog.querySelector('.access-request-intro').textContent).toContain('tom@example.com');
        type(requestDialog.querySelector('textarea'), 'Hello');
        submit(requestDialog.querySelector('form'));
        await settle();
        expect(api.requestAccess).toHaveBeenCalledWith('Hello');
        expect($('.access-request-dialog')).toBeNull();
        expect($('.toast-message').textContent).toBe("Request sent. You'll get an email when an admin grants it.");
        expect(document.activeElement).toBe(headerButton());
        headerButton().click();
        expect(visibleText('.account-note')).toEqual(['You asked for edit access on 10 Oct.']);
        expect(menuButtons()).toEqual(['Sign out']);
        expect(api.me).toHaveBeenCalledOnce(); // the menu used the request it got back
        expect(onSignedIn).toHaveBeenCalledOnce();
      });

      it('refreshes the account when the request finds them already an editor', async () => {
        const api = fakeApi(ACCOUNTS.viewer);
        api.requestAccess = vi.fn(async () => {
          throw new ApiError(409, 'already_an_editor', {});
        });
        const { onSignedIn } = await signedInAs(ACCOUNTS.viewer, { api });
        api.me.mockImplementation(async () => ({ ...ACCOUNTS.viewer, role: 'editor' }));
        headerButton().click();
        $('.account-request').click();
        submit($('.access-request-dialog form'));
        await settle();
        expect($('.access-request-dialog')).toBeNull();
        expect(api.me).toHaveBeenCalledTimes(2);
        expect(onSignedIn).toHaveBeenLastCalledWith({ ...ACCOUNTS.viewer, role: 'editor' }, 'restored');
        headerButton().click();
        expect(menuButtons()).toEqual(['History', 'Sign out']);
      });

      it('for an admin with pending requests: "Access requests (N)", which opens the Editors dialog', async () => {
        const { openEditors } = await signedInAs({ ...ACCOUNTS.admin, pendingRequests: 2 });
        headerButton().click();
        expect(menuButtons()).toEqual(['Access requests (2)', 'History', 'Editors', 'Sign out']);
        $('.account-requests').click();
        expect(openEditors).toHaveBeenCalledOnce();
        expect(menuOpen()).toBe(false);
      });

      it('for an admin with none pending: no "Access requests"', async () => {
        await signedInAs({ ...ACCOUNTS.admin, pendingRequests: 0 });
        headerButton().click();
        expect(menuButtons()).toEqual(['History', 'Editors', 'Sign out']);
      });

      it('shows the new count after refreshAccount', async () => {
        const api = fakeApi({ ...ACCOUNTS.admin, pendingRequests: 1 });
        const { controller: c } = await signedInAs(ACCOUNTS.admin, { api });
        api.me.mockImplementation(async () => ({ ...ACCOUNTS.admin, pendingRequests: 0 }));
        await c.refreshAccount();
        headerButton().click();
        expect(menuButtons()).toEqual(['History', 'Editors', 'Sign out']);
      });
    });

    it('ignores a /me reply for someone who has since signed out', async () => {
      const api = fakeApi();
      const pending = deferred();
      api.me.mockReturnValue(pending.promise);
      const { auth, onSignedIn } = await signedInAs(ACCOUNTS.editor, { api });
      await auth.signOut();
      pending.resolve(ACCOUNTS.editor);
      await settle();
      expect(onSignedIn).not.toHaveBeenCalled();
      expect(headerButton().textContent).toBe('Sign in');
    });
  });

  describe('sign-in from elsewhere', () => {
    it('closes an idle dialog when a session is restored', async () => {
      const client = fakeClient({ session: sessionFor('rose@example.com') });
      const { auth, api, onSignedIn } = setup({ client });
      headerButton().click();
      expect(dialogOpen()).toBe(true);
      await auth.init();
      await settle();
      expect(dialogOpen()).toBe(false);
      expect(api.me).toHaveBeenCalledOnce();
      expect(onSignedIn).toHaveBeenCalledWith(ACCOUNTS.editor, 'restored');
    });

    it("keeps its own sign-in open and busy until /me answers, then closes", async () => {
      const api = fakeApi();
      const pending = deferred();
      api.me.mockReturnValue(pending.promise);
      const { onSignedIn } = setup({ api });
      await signInByCode();
      expect(headerButton().textContent).toBe('R'); // auth already signed in
      expect(dialogOpen()).toBe(true);
      expect(dialog().getAttribute('aria-busy')).toBe('true');
      expect($('.signin-code-form button[type="submit"]').textContent).toBe('Signing in…');
      pending.resolve(ACCOUNTS.editor);
      await settle();
      expect(dialogOpen()).toBe(false);
      expect(api.me).toHaveBeenCalledOnce();
      expect(onSignedIn).toHaveBeenCalledOnce();
    });
  });

  describe('stacking', () => {
    function otherDialog() {
      const other = document.createElement('div');
      other.className = 'editor-dialog-backdrop';
      other.innerHTML = '<div class="editor-dialog" role="dialog"><button type="button">Other</button></div>';
      document.body.appendChild(other);
      return other;
    }

    it('goes on top of a dialog that is already open, and Escape closes only the sign-in dialog', () => {
      setup();
      const other = otherDialog();
      const below = vi.fn();
      document.addEventListener('keydown', below);
      try {
        headerButton().click();
        expect(document.body.lastElementChild).toBe($('.signin-backdrop'));
        key('Escape');
        expect(dialogOpen()).toBe(false);
        expect(other.isConnected).toBe(true);
        expect(below).not.toHaveBeenCalled(); // the dialog below never hears it
      } finally {
        document.removeEventListener('keydown', below);
      }
    });

    it('leaves Escape and Tab to a dialog above it', () => {
      setup();
      headerButton().click();
      const other = otherDialog();
      other.querySelector('button').focus();
      const escape = key('Escape');
      expect(escape.defaultPrevented).toBe(false);
      expect(dialogOpen()).toBe(true);
      expect(key('Tab').defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(other.querySelector('button'));
    });

    it('leaves Escape alone while the menu is closed and no dialog is open', async () => {
      setup();
      const below = vi.fn();
      document.addEventListener('keydown', below);
      try {
        key('Escape');
        expect(below).toHaveBeenCalledOnce();
      } finally {
        document.removeEventListener('keydown', below);
      }
    });
  });

  describe('controller', () => {
    it('opens the dialog on request and reports the account', async () => {
      const { controller: c } = setup();
      expect(c.getAccount()).toBeNull();
      c.open();
      expect(dialogOpen()).toBe(true);
      c.close();
      expect(dialogOpen()).toBe(false);
      await signInByCode();
      expect(c.getAccount()).toEqual(ACCOUNTS.editor);
    });

    it("calls open's onCancel when the dialog closes without a sign-in, and not after one", async () => {
      const { controller: c } = setup();
      const onCancel = vi.fn();
      c.open({ onCancel });
      key('Escape');
      expect(onCancel).toHaveBeenCalledOnce();
      c.open({ onCancel });
      await signInByCode(); // the header button finds the dialog open already
      expect(dialogOpen()).toBe(false);
      expect(onCancel).toHaveBeenCalledOnce();
    });

    it('keeps the options of a dialog that was already open, unless new ones are given', () => {
      const { controller: c } = setup();
      const first = vi.fn();
      const second = vi.fn();
      c.open({ onCancel: first });
      c.open();
      c.close();
      expect(first).toHaveBeenCalledOnce();
      c.open();
      c.open({ onCancel: second });
      c.close();
      expect(second).toHaveBeenCalledOnce();
      expect(first).toHaveBeenCalledOnce();
    });

    it('removes everything and stops listening on destroy', async () => {
      const { auth, controller: c, onSignedOut } = setup();
      await signInByCode();
      c.destroy();
      controller = null;
      expect(headerButton()).toBeNull();
      expect(dialog()).toBeNull();
      await auth.signOut();
      expect(onSignedOut).not.toHaveBeenCalled();
    });
  });
});

describe('friendlyError', () => {
  const authError = (code, status = 400) => ({ name: 'AuthClientError', code, status, message: 'raw' });

  it('words the sign-in service errors', () => {
    expect(friendlyError(authError('OTP_EXPIRED'))).toBe('That code has expired. Send a new one.');
    expect(friendlyError(authError('TOO_MANY_ATTEMPTS'))).toBe('Too many wrong codes. Send a new one.');
    expect(friendlyError(authError('INVALID_EMAIL'))).toBe('Enter a full email address, like name@example.com.');
    expect(friendlyError(authError(null, 429))).toBe('Too many attempts. Wait a minute, then try again.');
    expect(friendlyError(authError('WHATEVER'))).toBe('raw');
    expect(friendlyError(null)).toBe('Something went wrong. Try again.');
  });

  it('words API errors', () => {
    expect(friendlyError(new ApiError(401, 'unauthenticated', { message: 'Signed out. Sign in again.' })))
      .toBe('The server didn\'t accept your sign-in. Sign out, then sign in again.');
    expect(friendlyError(new ApiError(500, 'internal', {}))).toBe('The server had a problem (internal). Try again.');
  });
});
