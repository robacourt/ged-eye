import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openAccessRequestDialog, shortDate, NOTE_MAX_CHARS } from '../src/accessRequestDialog.js';
import { showToast } from '../src/toast.js';

vi.mock('../src/toast.js', () => ({ showToast: vi.fn() }));

const XSS = '<img src=x onerror="window.__xss = 1">';
const SENT = "Request sent. You'll get an email when an admin grants it.";
const REQUEST = { id: 7, email: 'tom@example.com', status: 'pending', createdAt: '2026-10-10T12:00:00Z' };
const apiError = (status, code, body = {}) => Object.assign(new Error(body.message ?? code), {
  name: 'ApiError', status, code, field: body.field ?? null, reason: null, blocking: [], body
});

let api;
let onSent;
let onAlreadyAnEditor;
let opener;
let dialog;

const flush = async (times = 3) => {
  for (let i = 0; i < times; i++) await new Promise(resolve => setTimeout(resolve, 0));
};

/** A promise with its resolve and reject exposed, to hold a call in flight. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function open(options = {}) {
  dialog = openAccessRequestDialog({ api, email: 'tom@example.com', onSent, onAlreadyAnEditor, ...options });
  return dialog;
}

const $ = (selector) => document.querySelector(selector);
const root = () => $('.access-request-dialog');
const note = () => $('.access-request-dialog textarea[name="note"]');
const count = () => $('.access-request-count');
const send = () => $('.access-request-send');
const error = () => {
  const element = $('.access-request-dialog .editor-error');
  return element && !element.hidden ? element.textContent : null;
};
const isOpen = () => Boolean(root()?.isConnected);

function type(value) {
  note().value = value;
  note().dispatchEvent(new Event('input', { bubbles: true }));
}

async function submit() {
  $('.access-request-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await flush();
}

function key(name, options = {}) {
  const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...options });
  (document.activeElement ?? document.body).dispatchEvent(event);
  return event;
}

beforeEach(() => {
  document.body.innerHTML = '<button type="button" id="opener">Account</button>';
  opener = document.getElementById('opener');
  opener.focus();
  api = { requestAccess: vi.fn(async () => ({ request: REQUEST, created: true })) };
  onSent = vi.fn();
  onAlreadyAnEditor = vi.fn();
  showToast.mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  dialog?.close();
  dialog = null;
  vi.restoreAllMocks();
});

describe('openAccessRequestDialog', () => {
  it('opens a modal that explains the request, with an optional note, its count, Send and Cancel', () => {
    open();
    expect(root().getAttribute('role')).toBe('dialog');
    expect(root().getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById(root().getAttribute('aria-labelledby')).textContent).toBe('Request edit access');
    expect($('.access-request-intro').textContent).toContain('tom@example.com');
    expect(root().querySelector('label').textContent).toContain('(optional)');
    expect(note().value).toBe('');
    expect(count().textContent).toBe(`0 / ${NOTE_MAX_CHARS}`);
    expect(NOTE_MAX_CHARS).toBe(500);
    expect([...root().querySelectorAll('.access-request-actions button')].map(b => b.textContent)).toEqual(['Cancel', 'Send']);
    expect(document.activeElement).toBe(note());
    expect(error()).toBeNull();
  });

  it('sends the trimmed note, toasts, closes, gives focus back, then calls onSent', async () => {
    open();
    type('  I am Tom, Rose\'s grandson.\nPlease add me.  \n');
    await submit();
    expect(api.requestAccess).toHaveBeenCalledWith('I am Tom, Rose\'s grandson.\nPlease add me.');
    expect(showToast).toHaveBeenCalledWith(SENT);
    expect(onSent).toHaveBeenCalledWith(REQUEST);
    expect(showToast.mock.invocationCallOrder[0]).toBeLessThan(onSent.mock.invocationCallOrder[0]);
    expect(isOpen()).toBe(false);
    expect(dialog.isOpen()).toBe(false);
    expect(document.activeElement).toBe(opener);
    expect(onAlreadyAnEditor).not.toHaveBeenCalled();
  });

  it('sends without a note', async () => {
    open();
    type('   \n ');
    await submit();
    expect(api.requestAccess).toHaveBeenCalledWith('');
    expect(onSent).toHaveBeenCalledOnce();
  });

  it('says so when a request was already pending (200)', async () => {
    api.requestAccess.mockResolvedValueOnce({ request: REQUEST, created: false });
    open();
    await submit();
    expect(showToast).toHaveBeenCalledWith("You've already asked. You'll get an email when an admin grants it.");
    expect(onSent).toHaveBeenCalledWith(REQUEST);
    expect(isOpen()).toBe(false);
  });

  it('counts characters as they are typed, and refuses more than 500 without asking', async () => {
    open();
    type('Hello');
    expect(count().textContent).toBe('5 / 500');
    expect(count().classList.contains('access-request-count-over')).toBe(false);
    type('😀'.repeat(500)); // characters, not UTF-16 units
    expect(count().textContent).toBe('500 / 500');
    type(`  ${'a'.repeat(500)}  `); // counted after trimming, as the server does
    expect(count().textContent).toBe('500 / 500');
    type('a'.repeat(501));
    expect(count().textContent).toBe('501 / 500');
    expect(count().classList.contains('access-request-count-over')).toBe(true);
    await submit();
    expect(api.requestAccess).not.toHaveBeenCalled();
    expect(error()).toBe('Keep the note to 500 characters or fewer.');
    expect(note().getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(note());
    expect(isOpen()).toBe(true);

    type('a'.repeat(500));
    await submit();
    expect(api.requestAccess).toHaveBeenCalledWith('a'.repeat(500));
  });

  it('is busy while sending, and ignores a second Send', async () => {
    const pending = deferred();
    api.requestAccess.mockReturnValueOnce(pending.promise);
    open();
    type('Hi');
    await submit();
    expect(send().disabled).toBe(true);
    expect(send().textContent).toBe('Sending…');
    expect(note().disabled).toBe(true);
    expect($('.access-request-cancel').disabled).toBe(true);
    expect(root().getAttribute('aria-busy')).toBe('true');
    await submit();
    expect(api.requestAccess).toHaveBeenCalledOnce();
    pending.resolve({ request: REQUEST, created: true });
    await flush();
    expect(onSent).toHaveBeenCalledOnce();
  });

  it('shows 429 inline and stays open, ready to try again', async () => {
    api.requestAccess.mockRejectedValueOnce(apiError(429, 'too_many_requests'));
    open();
    type('Hi');
    await submit();
    expect(error()).toBe('Too many requests right now — try again later.');
    expect(isOpen()).toBe(true);
    expect(send().disabled).toBe(false);
    expect(send().textContent).toBe('Send');
    expect(note().disabled).toBe(false);
    expect(note().value).toBe('Hi');
    expect(root().getAttribute('aria-busy')).toBe('false');
    expect(showToast).not.toHaveBeenCalled();
    expect(onSent).not.toHaveBeenCalled();

    await submit(); // and the next try clears the error
    expect(error()).toBeNull();
    expect(onSent).toHaveBeenCalledOnce();
  });

  it('closes and asks for a refresh when the person is already an editor (409)', async () => {
    api.requestAccess.mockRejectedValueOnce(apiError(409, 'already_an_editor'));
    open();
    await submit();
    expect(isOpen()).toBe(false);
    expect(onAlreadyAnEditor).toHaveBeenCalledOnce();
    expect(onSent).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith('You can already edit the tree.');
  });

  it.each([
    ['a network failure', apiError(0, 'network', { message: "Couldn't reach the server. Check your connection." }),
      "Couldn't reach the server. Check your connection."],
    ['an invalid note', apiError(400, 'invalid', { field: 'note', message: 'The note must be at most 500 characters.' }),
      'The note must be at most 500 characters.'],
    ['an invalid note without a message', apiError(400, 'invalid', { field: 'note' }), 'Check the note and try again.'],
    ['a sign-out', apiError(401, 'unauthenticated', { message: 'Signed out. Sign in again.' }),
      "You're signed out. Sign in again, then try again."],
    ['a server fault', apiError(500, 'internal'), 'The server had a problem (internal). Try again.']
  ])('shows %s inline', async (_, failure, message) => {
    api.requestAccess.mockRejectedValueOnce(failure);
    open();
    await submit();
    expect(error()).toBe(message);
    expect(isOpen()).toBe(true);
  });

  it('shows the email and server messages as text', async () => {
    api.requestAccess.mockRejectedValueOnce(apiError(400, 'invalid', { field: 'note', message: XSS }));
    open({ email: `${XSS}@example.com` });
    expect($('.access-request-intro').textContent).toContain(`${XSS}@example.com`);
    await submit();
    expect(error()).toBe(XSS);
    expect(document.querySelector('img')).toBeNull();
  });

  it('explains the request without an email', () => {
    open({ email: null });
    expect($('.access-request-intro').textContent).toMatch(/^The admins will get an email asking them to let you edit the tree\./);
  });

  it('closes with Cancel, ×, or Escape, sending nothing', () => {
    for (const close of [
      () => $('.access-request-cancel').click(),
      () => $('.access-request-dialog .editor-dialog-close').click(),
      () => expect(key('Escape').defaultPrevented).toBe(true)
    ]) {
      open();
      close();
      expect(isOpen()).toBe(false);
      expect(document.activeElement).toBe(opener);
    }
    expect(api.requestAccess).not.toHaveBeenCalled();
  });

  it('keeps Tab inside the dialog', () => {
    open();
    const focusable = [...root().querySelectorAll('button, textarea')].filter(el => !el.disabled);
    focusable.at(-1).focus();
    expect(key('Tab').defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(focusable[0]);
    expect(key('Tab', { shiftKey: true }).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(focusable.at(-1));
  });

  it('leaves Escape to a dialog opened above it', () => {
    open();
    const other = document.createElement('div');
    other.className = 'editor-dialog-backdrop';
    other.innerHTML = '<div class="editor-dialog" role="dialog"><button type="button">Other</button></div>';
    document.body.appendChild(other);
    other.querySelector('button').focus();
    expect(key('Escape').defaultPrevented).toBe(false);
    expect(isOpen()).toBe(true);
    other.remove();
  });

  it('still reports a request that was sent after the dialog was closed, but not a failure', async () => {
    const pending = deferred();
    api.requestAccess.mockReturnValueOnce(pending.promise);
    open();
    await submit();
    $('.access-request-dialog .editor-dialog-close').click();
    expect(isOpen()).toBe(false);
    pending.resolve({ request: REQUEST, created: true });
    await flush();
    expect(showToast).toHaveBeenCalledWith(SENT);
    expect(onSent).toHaveBeenCalledWith(REQUEST);

    const failing = deferred();
    api.requestAccess.mockReturnValueOnce(failing.promise);
    open();
    await submit();
    dialog.close();
    failing.reject(apiError(429, 'too_many_requests'));
    await flush();
    expect(onSent).toHaveBeenCalledOnce();
    expect(document.querySelector('.access-request-dialog')).toBeNull();
  });
});

describe('shortDate', () => {
  const now = Date.parse('2026-10-11T09:00:00Z');

  it('gives the day and short month in British English, with the year only when it is not this one', () => {
    expect(shortDate('2026-10-10T12:00:00Z', now)).toBe('10 Oct');
    expect(shortDate('2025-03-02T12:00:00Z', now)).toBe('2 Mar 2025');
  });

  it('gives nothing for a missing or bad date', () => {
    expect(shortDate(null, now)).toBe('');
    expect(shortDate('not a date', now)).toBe('');
  });
});
