import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openEditorsDialog, editorsErrorMessage } from '../src/editorsDialog.js';
import { isEditorDialogOpen } from '../src/editorDialog.js';
import { showToast } from '../src/toast.js';

vi.mock('../src/toast.js', () => ({ showToast: vi.fn() }));

const XSS = '<img src=x onerror="window.__xss = 1">';
const apiError = (status, code, body = {}) => Object.assign(new Error(body.message ?? code), {
  name: 'ApiError', status, code, reason: null, blocking: [], field: body.field ?? null, body
});

const ROB = { email: 'rob@example.com', name: 'Rob', role: 'admin', addedBy: 'migration', addedAt: '2026-10-09T10:00:00Z' };
const ANN = { email: 'ann@example.com', name: 'Ann Jones', role: 'editor', addedBy: 'rob@example.com', addedAt: '2026-10-09T11:00:00Z' };
const TOM = { email: 'tom@example.com', name: null, role: 'editor', addedBy: 'rob@example.com', addedAt: '2026-10-09T11:30:00Z' };

// This year, so the date shows without one.
const OCT_10 = new Date(new Date().getFullYear(), 9, 10, 12).toISOString();
const TOM_ASKS = { id: 7, email: 'tom@example.com', name: 'Tom Acourt', note: "I'm Rose's grandson.\nPlease add me.", createdAt: OCT_10 };
const SUE_ASKS = { id: 9, email: 'sue@example.com', name: null, note: null, createdAt: OCT_10 };

let api;
let dialog;
let onChanged;

const flush = async (times = 3) => {
  for (let i = 0; i < times; i++) await new Promise(resolve => setTimeout(resolve, 0));
};

async function open(options = {}) {
  dialog = openEditorsDialog({ api, currentEmail: 'rob@example.com', onChanged, ...options });
  await flush();
  return dialog;
}

const root = () => document.querySelector('.editors-dialog');
const $ = (selector) => root().querySelector(selector);
const $$ = (selector) => [...root().querySelectorAll(selector)];
const row = (email) => $$('.editors-row').find(element => element.dataset.email === email);
const rows = () => $$('.editors-row').map(element => ({
  email: element.querySelector('.editors-email').textContent,
  name: element.querySelector('.editors-name')?.textContent ?? null,
  role: element.querySelector('.editors-role').textContent
}));
const field = (name) => $(`.editors-add [name="${name}"]`);
const type = (input, value) => {
  input.value = value;
  input.dispatchEvent(new Event(input.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
};
const errorFor = (name) => {
  const element = $(`.editors-add [data-error-for="${name}"]`);
  return element && !element.hidden ? element.textContent : null;
};
const submitAdd = async () => {
  $('.editors-add').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await flush();
};

beforeEach(() => {
  document.body.innerHTML = '';
  api = {
    listEditors: vi.fn(async () => [ROB, ANN, TOM]),
    addEditor: vi.fn(async ({ email, name, role }) => ({
      email: email.trim().toLowerCase(), name: name || null, role, addedBy: 'rob@example.com', addedAt: '2026-10-09T12:00:00Z'
    })),
    removeEditor: vi.fn(async () => {}),
    listAccessRequests: vi.fn(async () => []),
    grantAccessRequest: vi.fn(async (id) => ({
      request: { id, status: 'granted' },
      editor: { email: 'tom@example.com', name: 'Tom Acourt', role: 'editor', addedBy: 'rob@example.com', addedAt: OCT_10 }
    })),
    dismissAccessRequest: vi.fn(async (id) => ({ request: { id, status: 'dismissed' } }))
  };
  onChanged = vi.fn();
  showToast.mockClear();
});

afterEach(() => {
  dialog?.close();
  dialog = null;
});

describe('editorsErrorMessage', () => {
  it('words the server\'s errors', () => {
    expect(editorsErrorMessage(apiError(409, 'already_an_editor', { email: 'ann@example.com' }))).toBe('ann@example.com is already an editor.');
    expect(editorsErrorMessage(apiError(409, 'cannot_remove_self', { message: "You can't remove yourself." }))).toBe("You can't remove yourself.");
    expect(editorsErrorMessage(apiError(409, 'last_admin', { message: "The last admin can't be removed." }))).toBe("The last admin can't be removed.");
    expect(editorsErrorMessage(apiError(403, 'not_an_admin'))).toBe('Only admins can change the editors list.');
    expect(editorsErrorMessage(apiError(403, 'not_an_editor'))).toBe('Only admins can change the editors list.');
    expect(editorsErrorMessage(apiError(401, 'unauthenticated'))).toMatch(/signed out/i);
    expect(editorsErrorMessage(apiError(0, 'network', { message: "Couldn't reach the server." }))).toBe("Couldn't reach the server.");
    expect(editorsErrorMessage(apiError(500, 'internal'))).toBe('The server had a problem (internal). Try again.');
  });
});

describe('openEditorsDialog: the list', () => {
  it('opens a dialog listing every editor with name and role, as text', async () => {
    api.listEditors.mockResolvedValueOnce([ROB, { ...ANN, name: XSS }]);
    await open();
    expect(isEditorDialogOpen()).toBe(true);
    expect(root().querySelector('.editor-dialog-title').textContent).toBe('Editors');
    expect(rows()).toEqual([
      { email: 'rob@example.com', name: 'Rob', role: 'Admin' },
      { email: 'ann@example.com', name: XSS, role: 'Editor' }
    ]);
    expect(document.querySelector('img')).toBeNull();
  });

  it('marks the signed-in admin as you, and leaves out a missing name', async () => {
    await open();
    expect(row('rob@example.com').querySelector('.editors-you').textContent).toBe('(you)');
    expect(row('tom@example.com').querySelector('.editors-name')).toBeNull();
  });

  it('shows a load failure with Try again', async () => {
    api.listEditors.mockRejectedValueOnce(apiError(403, 'not_an_admin'));
    await open();
    expect($('.editors-status').textContent).toBe("Couldn't load the editors. Only admins can change the editors list.");
    $('.editors-retry').click();
    await flush();
    expect(rows()).toHaveLength(3);
    expect($('.editors-retry').hidden).toBe(true);
  });

  it('closes on Escape', async () => {
    await open();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(dialog.isOpen()).toBe(false);
  });
});

describe('openEditorsDialog: adding', () => {
  it('adds an editor and lists them', async () => {
    await open();
    type(field('email'), '  Jill@Example.com ');
    type(field('name'), ' Jill Smith ');
    type(field('role'), 'admin');
    await submitAdd();
    expect(api.addEditor).toHaveBeenCalledWith({ email: 'Jill@Example.com', name: 'Jill Smith', role: 'admin' });
    expect(rows().at(-1)).toEqual({ email: 'jill@example.com', name: 'Jill Smith', role: 'Admin' });
    expect(showToast).toHaveBeenCalledWith('Added jill@example.com as an admin.');
    expect(field('email').value).toBe('');
    expect(field('name').value).toBe('');
    expect(field('role').value).toBe('editor');
  });

  it('defaults to the editor role and sends no empty name', async () => {
    await open();
    type(field('email'), 'jill@example.com');
    await submitAdd();
    expect(api.addEditor).toHaveBeenCalledWith({ email: 'jill@example.com', name: null, role: 'editor' });
  });

  it('checks the email before asking', async () => {
    await open();
    await submitAdd();
    expect(errorFor('email')).toBe('Enter an email address.');
    expect(field('email').getAttribute('aria-invalid')).toBe('true');
    type(field('email'), 'jill');
    await submitAdd();
    expect(errorFor('email')).toBe('Enter a full email address, like name@example.com.');
    expect(api.addEditor).not.toHaveBeenCalled();
  });

  it('shows already_an_editor at the email', async () => {
    await open();
    api.addEditor.mockRejectedValueOnce(apiError(409, 'already_an_editor', { email: 'ann@example.com' }));
    type(field('email'), 'ANN@example.com');
    await submitAdd();
    expect(errorFor('email')).toBe('ann@example.com is already an editor.');
    expect(rows()).toHaveLength(3);
  });

  it('shows a validation error at its field', async () => {
    await open();
    api.addEditor.mockRejectedValueOnce(apiError(400, 'invalid', { field: 'name', message: 'name must be at most 500 characters.' }));
    type(field('email'), 'jill@example.com');
    await submitAdd();
    expect(errorFor('name')).toBe('name must be at most 500 characters.');
  });

  it('shows other failures in the form', async () => {
    await open();
    api.addEditor.mockRejectedValueOnce(apiError(403, 'not_an_admin'));
    type(field('email'), 'jill@example.com');
    await submitAdd();
    expect($('.editors-add .editors-add-error').textContent).toBe('Only admins can change the editors list.');
    expect(field('email').value).toBe('jill@example.com');
  });

  it('is busy while adding', async () => {
    await open();
    let resolve;
    api.addEditor.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    type(field('email'), 'jill@example.com');
    await submitAdd();
    const button = $('.editors-add button[type="submit"]');
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe('Adding…');
    await submitAdd();
    expect(api.addEditor).toHaveBeenCalledTimes(1);
    resolve({ email: 'jill@example.com', name: null, role: 'editor' });
    await flush();
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe('Add editor');
  });
});

describe('openEditorsDialog: removing', () => {
  it('asks first, then removes', async () => {
    await open();
    row('ann@example.com').querySelector('.editors-remove').click();
    const confirm = row('ann@example.com').querySelector('.editors-confirm');
    expect(confirm.hidden).toBe(false);
    expect(confirm.querySelector('.editors-confirm-text').textContent).toBe('Remove ann@example.com from the editors?');
    expect(api.removeEditor).not.toHaveBeenCalled();
    confirm.querySelector('.editors-confirm-remove').click();
    await flush();
    expect(api.removeEditor).toHaveBeenCalledWith('ann@example.com');
    expect(row('ann@example.com')).toBeUndefined();
    expect(showToast).toHaveBeenCalledWith('Removed ann@example.com.');
    expect(root().contains(document.activeElement)).toBe(true);
  });

  it('keeps them on Cancel', async () => {
    await open();
    row('ann@example.com').querySelector('.editors-remove').click();
    row('ann@example.com').querySelector('.editors-confirm-cancel').click();
    expect(row('ann@example.com').querySelector('.editors-confirm').hidden).toBe(true);
    expect(document.activeElement).toBe(row('ann@example.com').querySelector('.editors-remove'));
    expect(api.removeEditor).not.toHaveBeenCalled();
  });

  it.each([
    ['cannot_remove_self', 409, "You can't remove yourself.", 'rob@example.com'],
    ['last_admin', 409, "The last admin can't be removed.", 'rob@example.com'],
    ['not_an_admin', 403, undefined, 'ann@example.com']
  ])('shows %s in the row', async (code, status, message, email) => {
    await open();
    api.removeEditor.mockRejectedValueOnce(apiError(status, code, message ? { message } : {}));
    row(email).querySelector('.editors-remove').click();
    row(email).querySelector('.editors-confirm-remove').click();
    await flush();
    const error = row(email).querySelector('.editors-row-error');
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe(message ?? 'Only admins can change the editors list.');
    expect(row(email).querySelector('.editors-confirm').hidden).toBe(true);
  });

  it('drops a row someone else already removed', async () => {
    await open();
    api.removeEditor.mockRejectedValueOnce(apiError(404, 'not_found'));
    row('ann@example.com').querySelector('.editors-remove').click();
    row('ann@example.com').querySelector('.editors-confirm-remove').click();
    await flush();
    expect(row('ann@example.com')).toBeUndefined();
  });
});

describe('openEditorsDialog: access requests', () => {
  const section = () => $('.editors-requests');
  const request = (id) => $$('.editors-request').find(element => element.dataset.id === String(id));
  const requests = () => $$('.editors-request').map(element => ({
    name: element.querySelector('.editors-request-name')?.textContent ?? null,
    email: element.querySelector('.editors-request-email').textContent,
    note: element.querySelector('.editors-request-note')?.textContent ?? null,
    date: element.querySelector('.editors-request-date').textContent
  }));
  const buttons = (id) => [...request(id).querySelectorAll('button')].filter(b => !b.hidden).map(b => b.textContent);
  const visible = (element) => Boolean(element) && !element.closest('[hidden]');

  beforeEach(() => {
    api.listAccessRequests.mockResolvedValue([TOM_ASKS, SUE_ASKS]);
  });

  it('lists pending requests above the editors: name, email, note, date, Grant and Dismiss', async () => {
    await open();
    expect(api.listAccessRequests).toHaveBeenCalledOnce();
    expect(visible(section())).toBe(true);
    expect(section().querySelector('h3').textContent).toBe('Requests');
    expect(section().compareDocumentPosition($('.editors-list')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(requests()).toEqual([
      { name: 'Tom Acourt', email: 'tom@example.com', note: "I'm Rose's grandson.\nPlease add me.", date: 'Asked 10 Oct' },
      { name: null, email: 'sue@example.com', note: null, date: 'Asked 10 Oct' }
    ]);
    expect(request(7).querySelector('.editors-request-date').getAttribute('datetime')).toBe(OCT_10);
    expect(buttons(7)).toEqual(['Grant', 'Dismiss']);
    expect(request(7).querySelector('.editors-request-grant').getAttribute('aria-label')).toBe('Grant tom@example.com edit access');
    expect(request(7).querySelector('.editors-request-dismiss').getAttribute('aria-label')).toBe('Dismiss the request from tom@example.com');
    expect(rows()).toHaveLength(3);
  });

  it('shows nothing at all when there are no requests', async () => {
    api.listAccessRequests.mockResolvedValue([]);
    await open();
    expect(visible(section())).toBe(false);
    expect([...root().querySelectorAll('h3')].filter(visible).map(h => h.textContent)).toEqual(['Add an editor']);
    expect(rows()).toHaveLength(3);
  });

  it('shows names, emails and notes as text, keeping line breaks', async () => {
    api.listAccessRequests.mockResolvedValue([{ ...TOM_ASKS, name: XSS, email: `${XSS}@example.com`, note: `${XSS}\n\nline 3` }]);
    await open();
    expect(requests()[0]).toMatchObject({ name: XSS, email: `${XSS}@example.com`, note: `${XSS}\n\nline 3` });
    expect(document.querySelector('img')).toBeNull();
  });

  it('grants: busy while it runs, then both lists and the account menu are refreshed', async () => {
    await open();
    let resolve;
    api.grantAccessRequest.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const grant = request(7).querySelector('.editors-request-grant');
    grant.click();
    await flush();
    expect(api.grantAccessRequest).toHaveBeenCalledWith(7);
    expect(grant.disabled).toBe(true);
    expect(grant.textContent).toBe('Granting…');
    expect(request(9).querySelector('.editors-request-dismiss').disabled).toBe(true);
    request(9).querySelector('.editors-request-grant').click(); // ignored while busy
    expect(api.grantAccessRequest).toHaveBeenCalledOnce();

    api.listAccessRequests.mockResolvedValue([SUE_ASKS]);
    api.listEditors.mockResolvedValue([ROB, ANN, TOM, { email: 'tom@example.com', name: 'Tom Acourt', role: 'editor' }]);
    resolve({ request: { id: 7, status: 'granted' }, editor: { email: 'tom@example.com', name: 'Tom Acourt', role: 'editor' } });
    await flush();
    expect(showToast).toHaveBeenCalledWith('Granted tom@example.com edit access.');
    expect(api.listAccessRequests).toHaveBeenCalledTimes(2);
    expect(api.listEditors).toHaveBeenCalledTimes(2);
    expect(request(7)).toBeUndefined();
    expect(requests().map(r => r.email)).toEqual(['sue@example.com']);
    expect(rows()).toHaveLength(4);
    expect(onChanged).toHaveBeenCalledOnce();
    expect(request(9).querySelector('.editors-request-dismiss').disabled).toBe(false);
    expect(root().contains(document.activeElement)).toBe(true);
  });

  it('dismisses: busy while it runs, then the row goes, and the section with the last one', async () => {
    await open();
    let resolve;
    api.dismissAccessRequest.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const dismiss = request(9).querySelector('.editors-request-dismiss');
    dismiss.click();
    await flush();
    expect(api.dismissAccessRequest).toHaveBeenCalledWith(9);
    expect(dismiss.disabled).toBe(true);
    expect(dismiss.textContent).toBe('Dismissing…');
    resolve({ request: { id: 9, status: 'dismissed' } });
    await flush();
    expect(showToast).toHaveBeenCalledWith('Dismissed the request from sue@example.com.');
    expect(request(9)).toBeUndefined();
    expect(api.grantAccessRequest).not.toHaveBeenCalled();
    expect(onChanged).toHaveBeenCalledOnce();
    expect(root().contains(document.activeElement)).toBe(true);

    request(7).querySelector('.editors-request-dismiss').click();
    await flush();
    expect(requests()).toEqual([]);
    expect(visible(section())).toBe(false);
    expect(onChanged).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['granted', 'Granted by Ann Jones'],
    ['dismissed', 'Dismissed by Ann Jones']
  ])('says who got there first, by name, when the request was already %s', async (status, text) => {
    await open();
    api.grantAccessRequest.mockRejectedValueOnce(apiError(409, 'already_resolved', {
      status, resolvedBy: 'ann@example.com', resolvedByName: 'Ann Jones'
    }));
    request(7).querySelector('.editors-request-grant').click();
    await flush();
    expect(request(7).querySelector('.editors-request-resolved').textContent).toBe(text);
    expect(buttons(7)).toEqual([]);
    expect(request(7).querySelector('.editors-request-error').hidden).toBe(true);
    expect(onChanged).toHaveBeenCalledOnce();
    expect(api.listEditors).toHaveBeenCalledTimes(status === 'granted' ? 2 : 1); // a new editor to show
    expect(root().contains(document.activeElement)).toBe(true);
  });

  it('says who got there first on a Dismiss too, as text', async () => {
    await open();
    api.dismissAccessRequest.mockRejectedValueOnce(apiError(409, 'already_resolved', {
      status: 'granted', resolvedBy: 'ann@example.com', resolvedByName: XSS
    }));
    request(9).querySelector('.editors-request-dismiss').click();
    await flush();
    expect(request(9).querySelector('.editors-request-resolved').textContent).toBe(`Granted by ${XSS}`);
    expect(document.querySelector('img')).toBeNull();
  });

  it('falls back to the email without a name, and to "Already …" without either', async () => {
    await open();
    api.dismissAccessRequest.mockRejectedValueOnce(apiError(409, 'already_resolved', {
      status: 'dismissed', resolvedBy: 'ann@example.com', resolvedByName: null
    }));
    request(9).querySelector('.editors-request-dismiss').click();
    await flush();
    expect(request(9).querySelector('.editors-request-resolved').textContent).toBe('Dismissed by ann@example.com');

    api.grantAccessRequest.mockRejectedValueOnce(apiError(409, 'already_resolved', { status: 'dismissed' }));
    request(7).querySelector('.editors-request-grant').click();
    await flush();
    expect(request(7).querySelector('.editors-request-resolved').textContent).toBe('Already dismissed');
  });

  it('drops a request that no longer exists', async () => {
    await open();
    api.grantAccessRequest.mockRejectedValueOnce(apiError(404, 'not_found'));
    request(7).querySelector('.editors-request-grant').click();
    await flush();
    expect(request(7)).toBeUndefined();
    expect(onChanged).toHaveBeenCalledOnce();
  });

  it('shows other failures in the row, and keeps the buttons', async () => {
    await open();
    api.grantAccessRequest.mockRejectedValueOnce(apiError(403, 'not_an_admin'));
    request(7).querySelector('.editors-request-grant').click();
    await flush();
    const error = request(7).querySelector('.editors-request-error');
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe('Only admins can change the editors list.');
    expect(buttons(7)).toEqual(['Grant', 'Dismiss']);
    expect(request(7).querySelector('.editors-request-grant').disabled).toBe(false);
    expect(onChanged).not.toHaveBeenCalled();

    api.dismissAccessRequest.mockRejectedValueOnce(apiError(0, 'network', { message: "Couldn't reach the server." }));
    request(7).querySelector('.editors-request-dismiss').click();
    await flush();
    expect(error.textContent).toBe("Couldn't reach the server.");
  });

  it('shows a failure to load the requests, with Try again, and still lists the editors', async () => {
    api.listAccessRequests.mockRejectedValueOnce(apiError(500, 'internal'));
    await open();
    expect(visible(section())).toBe(true);
    expect(section().querySelector('.editors-requests-status').textContent)
      .toBe("Couldn't load the access requests. The server had a problem (internal). Try again.");
    expect(rows()).toHaveLength(3);
    section().querySelector('.editors-requests-retry').click();
    await flush();
    expect(requests()).toHaveLength(2);
    expect(section().querySelector('.editors-requests-retry').hidden).toBe(true);
    expect(section().querySelector('.editors-requests-status').textContent).toBe('');
  });

  it('refreshes the requests and the menu after adding someone who had asked', async () => {
    await open();
    api.listAccessRequests.mockResolvedValue([SUE_ASKS]);
    type(field('email'), 'Tom@Example.com');
    await submitAdd();
    expect(api.listAccessRequests).toHaveBeenCalledTimes(2);
    expect(requests().map(r => r.email)).toEqual(['sue@example.com']);
    expect(onChanged).toHaveBeenCalledOnce();

    type(field('email'), 'jill@example.com'); // who hadn't asked
    await submitAdd();
    expect(api.listAccessRequests).toHaveBeenCalledTimes(2);
    expect(onChanged).toHaveBeenCalledOnce();
  });
});
