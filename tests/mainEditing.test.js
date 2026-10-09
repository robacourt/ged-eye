import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PersonNotFoundError } from '../src/dataLoader.js';

// The tree view draws with Cytoscape; the tests give initApp a fake one instead.
vi.mock('../src/familyTreeView.js', () => ({ FamilyTreeView: class {} }));

const { initApp, DEFAULT_PERSON_ID, shortcutFor, WATCHED_API_CALLS } = await import('../src/main.js');
const { createEditApi } = await import('../src/editApi.js');

const apiError = (status, code, body = {}) => Object.assign(new Error(body.message ?? code), {
  name: 'ApiError', status, code, reason: body.reason ?? null, blocking: body.blocking ?? [], field: body.field ?? null, body
});

// What the dialogs get as `api`: the injected one with its calls watched (see "a removed editor" below).
const anApi = expect.objectContaining({ runChange: expect.any(Function), undo: expect.any(Function), revert: expect.any(Function) });

const RELS = { parents: [], spouses: [], children: [], siblings: [] };
const EDITOR = { email: 'ann@example.com', name: 'Ann', role: 'editor' };
const ADMIN = { email: 'rob@example.com', name: 'Rob', role: 'admin' };

let people;      // id -> person record, on the "server"
let loader;
let treeView;
let personDetails;
let auth;
let api;
let showToast;
let signIn;
let signInOptions;
let mountSignIn;
let dialogs;     // the editing UI (editing.js) that loadEditing resolves to
let loadEditing;
let app;

const flush = async (times = 5) => {
  for (let i = 0; i < times; i++) await new Promise(resolve => setTimeout(resolve, 0));
};

const person = (id, name) => ({ id, name, sex: 'F', parentFamilies: [], marriages: [], updatedAt: '2026-10-09T10:00:00Z' });
const handle = () => ({ close: vi.fn(), isOpen: vi.fn(() => true), refresh: vi.fn(async () => {}) });

function start(url = '/?person=I7') {
  window.history.replaceState({}, '', url);
  app = initApp({ treeView, personDetails, auth, api, loader, showToast, mountSignIn, loadEditing });
  return flush();
}

const lastShown = () => personDetails.showPerson.mock.calls.at(-1);
const shownId = () => lastShown()?.[0]?.id;
const shownOptions = () => lastShown()?.[2];
const urlPerson = () => new URLSearchParams(window.location.search).get('person');
const lastToast = () => showToast.mock.calls.at(-1);

async function signInAs(account = EDITOR) {
  signInOptions.onSignedIn(account, 'signed-in');
  await flush();
}

/** Presses a key on `target` (default: the page), and resolves to the event. */
async function press(key, modifiers = {}, target = document.body) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...modifiers });
  target.dispatchEvent(event);
  await flush();
  return event;
}

beforeEach(() => {
  document.body.innerHTML =
    '<div id="app"><div id="cy"></div><div id="details"></div><div id="loading" class="loading">Loading...</div></div>';
  people = new Map([
    ['I7', person('I7', 'Rose Smith')],
    ['I8', person('I8', 'Jack Smith')],
    [DEFAULT_PERSON_ID, person(DEFAULT_PERSON_ID, 'Felix')]
  ]);
  loader = {
    loadPersonWithFamily: vi.fn(async (id) => {
      if (!people.has(id)) throw new PersonNotFoundError(id);
      return { person: people.get(id), family: [], relationships: RELS, masked: false };
    }),
    reload: vi.fn(),
    invalidateAll: vi.fn(),
    cacheView: vi.fn()
  };
  treeView = {
    loadPerson: vi.fn(async (id) => {
      const result = await loader.loadPersonWithFamily(id);
      return { person: result.person, relationships: result.relationships };
    }),
    onPersonSelect: vi.fn()
  };
  personDetails = { showPerson: vi.fn() };
  auth = { init: vi.fn(async () => ({ user: null })), getState: vi.fn(() => ({ user: null })), onChange: vi.fn() };
  api = {
    undo: vi.fn(async () => ({ id: 21, summary: 'Undid: Edited Rose Smith (birth date)', personIds: ['I7'] })),
    redo: vi.fn(async () => ({ id: 22, summary: 'Redid: Edited Rose Smith (birth date)', personIds: ['I7'] })),
    revert: vi.fn(async (id) => ({ id: 23, summary: `Undid: change ${id}`, personIds: ['I7'] })),
    restore: vi.fn(),
    runChange: vi.fn(),
    listChanges: vi.fn(async () => [])
  };
  showToast = vi.fn(() => ({ dismiss: vi.fn() }));
  signIn = { isOpen: vi.fn(() => false), destroy: vi.fn(), open: vi.fn(), refreshAccount: vi.fn(async () => null) };
  mountSignIn = vi.fn((options) => {
    signInOptions = options;
    return signIn;
  });
  dialogs = {
    openHistoryPanel: vi.fn(handle),
    openEditorsDialog: vi.fn(handle),
    openPersonEditor: vi.fn(async () => handle()),
    openFamilyEditor: vi.fn(handle),
    openRelativeDialog: vi.fn(handle),
    openUnlinkConfirm: vi.fn(handle),
    isEditorDialogOpen: vi.fn(() => false)
  };
  loadEditing = vi.fn(async () => dialogs);
});

afterEach(() => {
  app?.destroy();
  app = null;
  vi.restoreAllMocks();
});

describe('shortcutFor', () => {
  const key = (k, modifiers = {}) => shortcutFor(new KeyboardEvent('keydown', { key: k, ...modifiers }));

  it('maps Ctrl/Cmd+Z to undo and Ctrl/Cmd+Shift+Z or Ctrl+Y to redo', () => {
    expect(key('z', { ctrlKey: true })).toBe('undo');
    expect(key('z', { metaKey: true })).toBe('undo');
    expect(key('Z', { ctrlKey: true, shiftKey: true })).toBe('redo');
    expect(key('Z', { metaKey: true, shiftKey: true })).toBe('redo');
    expect(key('y', { ctrlKey: true })).toBe('redo');
  });

  it('reads the key\'s position on layouts without Latin letters, and the letter on Latin ones', () => {
    expect(key('я', { ctrlKey: true, code: 'KeyZ' })).toBe('undo');
    expect(key('Я', { ctrlKey: true, shiftKey: true, code: 'KeyZ' })).toBe('redo');
    expect(key('н', { ctrlKey: true, code: 'KeyY' })).toBe('redo');
    expect(key('z', { ctrlKey: true, code: 'KeyY' })).toBe('undo'); // QWERTZ: its Z is where QWERTY's Y is
    expect(key('y', { ctrlKey: true, code: 'KeyZ' })).toBe('redo');
    expect(key('ч', { ctrlKey: true, code: 'KeyX' })).toBeNull();
  });

  it('ignores everything else', () => {
    expect(key('z')).toBeNull();
    expect(key('z', { shiftKey: true })).toBeNull();
    expect(key('z', { ctrlKey: true, altKey: true })).toBeNull();
    expect(key('y', { metaKey: true })).toBeNull();
    expect(key('Y', { ctrlKey: true, shiftKey: true })).toBeNull();
    expect(key('x', { ctrlKey: true })).toBeNull();
  });
});

describe('initApp: start-up', () => {
  it('mounts sign-in, restores the session and shows the URL\'s person without edit controls', async () => {
    await start();
    expect(mountSignIn).toHaveBeenCalledWith(expect.objectContaining({
      container: document.getElementById('app'), auth, api
    }));
    expect(auth.init).toHaveBeenCalledTimes(1);
    expect(mountSignIn.mock.invocationCallOrder[0]).toBeLessThan(auth.init.mock.invocationCallOrder[0]);
    expect(lastShown()).toEqual([people.get('I7'), RELS, { canEdit: false }]);
  });

  it('shows the person without waiting for the session', async () => {
    auth.init.mockImplementation(() => new Promise(() => {}));
    await start();
    expect(shownId()).toBe('I7');
  });

  it('keeps viewing when sign-in is unavailable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    auth.init.mockRejectedValue(new Error('VITE_NEON_AUTH_URL is not configured'));
    await start();
    expect(shownId()).toBe('I7');
    expect(warn).toHaveBeenCalled();
  });
});

describe('initApp: loading the editing UI', () => {
  it('never loads it for viewers or signed-in non-editors', async () => {
    await start();
    await signInAs({ email: 'tom@example.com', name: null, role: null });
    signInOptions.openHistory();
    await flush();
    expect(loadEditing).not.toHaveBeenCalled();
    expect(shownOptions()).toEqual({ canEdit: false });
  });

  it('loads it once someone can edit, and only then shows the edit controls', async () => {
    let resolve;
    loadEditing.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    await start();
    await signInAs(EDITOR);
    expect(loadEditing).toHaveBeenCalledTimes(1);
    expect(shownOptions()).toEqual({ canEdit: false }); // not before the dialogs (and their styles) are here
    resolve(dialogs);
    await flush();
    expect(shownId()).toBe('I7');
    expect(shownOptions().canEdit).toBe(true);
    await signInAs(EDITOR);
    expect(loadEditing).toHaveBeenCalledTimes(1);
  });

  it('says so when it can\'t be loaded, and tries again when History is asked for', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    loadEditing.mockRejectedValueOnce(new Error('Failed to fetch dynamically imported module'));
    await start();
    await signInAs(EDITOR);
    expect(lastToast()).toEqual([expect.stringMatching(/^Couldn't load the editing tools/), { kind: 'error' }]);
    expect(shownOptions()).toEqual({ canEdit: false });
    signInOptions.openHistory();
    await flush();
    expect(loadEditing).toHaveBeenCalledTimes(2);
    expect(dialogs.openHistoryPanel).toHaveBeenCalled();
    expect(shownOptions().canEdit).toBe(true);
  });
});

describe('initApp: sign-in state', () => {
  it('on sign-in as an editor, forgets cached views and re-renders with the edit controls', async () => {
    await start();
    loader.invalidateAll.mockClear();
    personDetails.showPerson.mockClear();
    await signInAs(EDITOR);
    expect(loader.invalidateAll).toHaveBeenCalledTimes(1);
    expect(loader.invalidateAll.mock.invocationCallOrder[0]).toBeLessThan(treeView.loadPerson.mock.invocationCallOrder.at(-1));
    expect(shownId()).toBe('I7');
    expect(shownOptions()).toEqual(expect.objectContaining({
      canEdit: true, onEdit: expect.any(Function), onAddRelative: expect.any(Function), onUnlink: expect.any(Function),
      onEditFamily: expect.any(Function), onShowHistory: expect.any(Function)
    }));
  });

  it('gives no edit controls to a signed-in non-editor', async () => {
    await start();
    await signInAs({ email: 'tom@example.com', name: null, role: null });
    expect(loader.invalidateAll).toHaveBeenCalled();
    expect(shownOptions()).toEqual({ canEdit: false });
  });

  it('on sign-out, forgets cached views, re-renders without edit controls and closes History and Editors', async () => {
    await start();
    await signInAs(ADMIN);
    signInOptions.openHistory();
    signInOptions.openEditors();
    await flush();
    const history = dialogs.openHistoryPanel.mock.results[0].value;
    const editors = dialogs.openEditorsDialog.mock.results[0].value;
    loader.invalidateAll.mockClear();
    signInOptions.onSignedOut('signed-out');
    await flush();
    expect(loader.invalidateAll).toHaveBeenCalledTimes(1);
    expect(shownOptions()).toEqual({ canEdit: false });
    expect(history.close).toHaveBeenCalled();
    expect(editors.close).toHaveBeenCalled();
  });
});

describe('initApp: a removed editor', () => {
  const NOT_AN_EDITOR = () => apiError(403, 'not_an_editor', { email: 'ann@example.com' });
  /** The api the person editor was opened with. */
  let dialogApi;

  beforeEach(async () => {
    await start();
    await signInAs(EDITOR);
    shownOptions().onEdit(people.get('I7'));
    await flush();
    dialogApi = dialogs.openPersonEditor.mock.calls[0][0].api;
    // /me now says she is not an editor.
    signIn.refreshAccount.mockImplementation(async () => {
      signInOptions.onSignedIn({ email: 'ann@example.com', name: null, role: null }, 'signed-in');
      return null;
    });
    personDetails.showPerson.mockClear();
  });

  it('reads the account again when a save is refused, which takes the edit controls away', async () => {
    api.runChange.mockRejectedValueOnce(NOT_AN_EDITOR());
    await expect(dialogApi.runChange({ kind: 'update_person' })).rejects.toMatchObject({ code: 'not_an_editor', status: 403 });
    await flush();
    expect(signIn.refreshAccount).toHaveBeenCalledTimes(1);
    expect(shownId()).toBe('I7');
    expect(shownOptions()).toEqual({ canEdit: false });
  });

  it('passes calls through unchanged: arguments, results and other failures', async () => {
    api.runChange.mockResolvedValueOnce({ change: { id: 5 } });
    await expect(dialogApi.runChange({ kind: 'update_person' }, 'x')).resolves.toEqual({ change: { id: 5 } });
    expect(api.runChange).toHaveBeenCalledWith({ kind: 'update_person' }, 'x');

    for (const error of [apiError(403, 'not_an_admin'), apiError(409, 'conflict'), apiError(500, 'server_error'),
      apiError(401, 'unauthenticated'), apiError(0, 'network')]) {
      api.runChange.mockRejectedValueOnce(error);
      await expect(dialogApi.runChange({})).rejects.toBe(error);
    }
    await flush();
    expect(signIn.refreshAccount).not.toHaveBeenCalled();
    expect(personDetails.showPerson).not.toHaveBeenCalled(); // nothing was re-rendered
  });

  it('also does so for a refused keyboard undo, and closes History and Editors', async () => {
    await signInAs(ADMIN);
    signInOptions.openHistory();
    signInOptions.openEditors();
    await flush();
    const history = dialogs.openHistoryPanel.mock.results[0].value;
    const editors = dialogs.openEditorsDialog.mock.results[0].value;
    api.undo.mockRejectedValueOnce(NOT_AN_EDITOR());
    showToast.mockClear();
    await press('z', { ctrlKey: true });
    expect(signIn.refreshAccount).toHaveBeenCalledTimes(1);
    expect(lastToast()).toEqual(["Your account can't edit the tree. Ask Rob for access.", { kind: 'error' }]);
    expect(shownOptions()).toEqual({ canEdit: false });
    expect(history.close).toHaveBeenCalled();
    expect(editors.close).toHaveBeenCalled();
    // and Ctrl+Z no longer does anything
    api.undo.mockClear();
    await press('z', { ctrlKey: true });
    expect(api.undo).not.toHaveBeenCalled();
  });

  it('also does so for a refused revert from History', async () => {
    signInOptions.openHistory();
    await flush();
    const historyApi = dialogs.openHistoryPanel.mock.calls[0][0].api;
    api.revert.mockRejectedValueOnce(NOT_AN_EDITOR());
    await expect(historyApi.revert(12, 'history')).rejects.toMatchObject({ code: 'not_an_editor' });
    await flush();
    expect(signIn.refreshAccount).toHaveBeenCalledTimes(1);
    expect(shownOptions()).toEqual({ canEdit: false });
  });

  it('does not read the account again for someone who already cannot edit', async () => {
    signInOptions.onSignedIn({ email: 'ann@example.com', name: null, role: null }, 'signed-in');
    await flush();
    api.runChange.mockRejectedValueOnce(NOT_AN_EDITOR());
    await expect(dialogApi.runChange({})).rejects.toMatchObject({ code: 'not_an_editor' });
    await flush();
    expect(signIn.refreshAccount).not.toHaveBeenCalled();
  });

  it('keeps the edit controls when the account read fails', async () => {
    signIn.refreshAccount.mockImplementation(async () => null); // /me unreachable: the menu shows the error
    api.runChange.mockRejectedValueOnce(NOT_AN_EDITOR());
    await expect(dialogApi.runChange({})).rejects.toBeTruthy();
    await flush();
    expect(signIn.refreshAccount).toHaveBeenCalledTimes(1);
    expect(personDetails.showPerson).not.toHaveBeenCalled();
  });

  it('watches every call the real API offers except me', () => {
    const real = createEditApi({ getToken: async () => null });
    expect(Object.keys(real).filter(name => name !== 'me').sort()).toEqual([...WATCHED_API_CALLS].sort());
  });
});

describe('initApp: opening the editors', () => {
  beforeEach(async () => {
    await start();
    await signInAs(ADMIN);
  });

  it('Edit opens the person editor with the view\'s masked flag', async () => {
    shownOptions().onEdit(people.get('I7'));
    await flush();
    expect(dialogs.openPersonEditor).toHaveBeenCalledWith(expect.objectContaining({
      person: people.get('I7'), masked: false, api: anApi, loader,
      onSaved: expect.any(Function), onDeleted: expect.any(Function), onReloaded: expect.any(Function)
    }));
  });

  it('+ relative, × and a marriage\'s Edit open their dialogs', () => {
    const rose = people.get('I7');
    shownOptions().onAddRelative('child', rose);
    expect(dialogs.openRelativeDialog).toHaveBeenCalledWith(expect.objectContaining({
      person: rose, relationships: RELS, relation: 'child', api: anApi, loader, onAdded: expect.any(Function), onReloaded: expect.any(Function)
    }));
    shownOptions().onUnlink({ relation: 'parent', role: 'partner', personId: 'I1', familyId: 'F1' }, rose);
    expect(dialogs.openUnlinkConfirm).toHaveBeenCalledWith(expect.objectContaining({
      person: rose, relationships: RELS, relation: 'parent', personId: 'I1', familyId: 'F1', api: anApi, loader,
      onUnlinked: expect.any(Function), onReloaded: expect.any(Function)
    }));
    const family = { familyId: 'F5', partners: [{ id: 'I7', name: 'Rose Smith' }] };
    shownOptions().onEditFamily(family, rose);
    expect(dialogs.openFamilyEditor).toHaveBeenCalledWith(expect.objectContaining({
      family, api: anApi, focusId: 'I7', loader, onSaved: expect.any(Function), onReloaded: expect.any(Function)
    }));
  });

  it('"History of this person" opens History filtered to them', async () => {
    shownOptions().onShowHistory(people.get('I7'));
    await flush();
    expect(dialogs.openHistoryPanel).toHaveBeenCalledWith(expect.objectContaining({
      api: anApi, personFilter: { id: 'I7', name: 'Rose Smith' }, onOpenPerson: expect.any(Function), onChanged: expect.any(Function)
    }));
  });

  it('the account menu opens History and Editors, replacing one already open', async () => {
    signInOptions.openHistory();
    await flush();
    expect(dialogs.openHistoryPanel).toHaveBeenLastCalledWith(expect.objectContaining({ personFilter: null }));
    const first = dialogs.openHistoryPanel.mock.results[0].value;
    signInOptions.openHistory();
    await flush();
    expect(first.close).toHaveBeenCalled();
    signInOptions.openEditors();
    await flush();
    expect(dialogs.openEditorsDialog).toHaveBeenCalledWith(expect.objectContaining({ api: anApi, currentEmail: 'rob@example.com' }));
  });

  it('opens Editors only for admins', async () => {
    await signInAs(EDITOR);
    signInOptions.openEditors();
    await flush();
    expect(dialogs.openEditorsDialog).not.toHaveBeenCalled();
  });

  it('History\'s person links navigate, and its changes re-render without another toast or refresh', async () => {
    signInOptions.openHistory();
    await flush();
    const options = dialogs.openHistoryPanel.mock.calls[0][0];
    const history = dialogs.openHistoryPanel.mock.results[0].value;
    options.onOpenPerson('I8');
    await flush();
    expect(urlPerson()).toBe('I8');
    expect(shownId()).toBe('I8');
    loader.invalidateAll.mockClear();
    showToast.mockClear();
    options.onChanged({ change: { id: 30, summary: 'Undid: Added Jack', personIds: ['I8'] } });
    await flush();
    expect(loader.invalidateAll).toHaveBeenCalledTimes(1);
    expect(shownId()).toBe('I8');
    expect(showToast).not.toHaveBeenCalled();
    expect(history.refresh).not.toHaveBeenCalled();
  });

  it('re-renders when an editor reloaded the person', async () => {
    shownOptions().onEdit(people.get('I7'));
    await flush();
    const { onReloaded } = dialogs.openPersonEditor.mock.calls[0][0];
    people.set('I7', person('I7', 'Rose Brown'));
    personDetails.showPerson.mockClear();
    onReloaded({ person: people.get('I7'), relationships: RELS });
    await flush();
    expect(lastShown()[0].name).toBe('Rose Brown');
  });
});

describe('initApp: after a command', () => {
  let saved;

  beforeEach(async () => {
    await start();
    await signInAs(EDITOR);
    shownOptions().onEdit(people.get('I7'));
    await flush();
    saved = dialogs.openPersonEditor.mock.calls[0][0];
    loader.invalidateAll.mockClear();
    personDetails.showPerson.mockClear();
    showToast.mockClear();
  });

  it('forgets cached views, caches the returned view, re-renders and toasts the summary with Undo', async () => {
    const view = { person: { id: 'I7' }, family: [], relationships: {} };
    saved.onSaved({ change: { id: 12, summary: 'Edited Rose Smith (birth date)', personIds: ['I7'] }, view });
    await flush();
    expect(loader.invalidateAll).toHaveBeenCalledTimes(1);
    expect(loader.cacheView).toHaveBeenCalledWith(view);
    expect(loader.invalidateAll.mock.invocationCallOrder[0]).toBeLessThan(loader.cacheView.mock.invocationCallOrder[0]);
    expect(shownId()).toBe('I7');
    expect(shownOptions().canEdit).toBe(true);
    const [message, options] = lastToast();
    expect(message).toBe('Edited Rose Smith (birth date)');
    expect(options.action.label).toBe('Undo');
  });

  it('keeps an open History current after a command and its toast\'s Undo', async () => {
    signInOptions.openHistory();
    await flush();
    const history = dialogs.openHistoryPanel.mock.results[0].value;
    const change = { id: 12, summary: 'Edited Rose Smith (birth date)', personIds: ['I7'] };
    saved.onSaved({ change, view: null });
    await flush();
    expect(history.refresh).toHaveBeenLastCalledWith({ change });
    lastToast()[1].action.onClick();
    await flush();
    expect(history.refresh).toHaveBeenLastCalledWith({ change: { id: 23, summary: 'Undid: change 12', personIds: ['I7'] } });
  });

  it('the toast\'s Undo reverts that change by keyboard, re-renders and toasts', async () => {
    saved.onSaved({ change: { id: 12, summary: 'Edited Rose Smith (birth date)', personIds: ['I7'] }, view: null });
    await flush();
    const [, { action }] = lastToast();
    loader.invalidateAll.mockClear();
    personDetails.showPerson.mockClear();
    action.onClick();
    await flush();
    expect(api.revert).toHaveBeenCalledWith(12, 'keyboard');
    expect(loader.invalidateAll).toHaveBeenCalledTimes(1);
    expect(shownId()).toBe('I7');
    expect(lastToast()[0]).toBe('Undid: change 12');
  });

  it('a blocked Undo offers History', async () => {
    saved.onSaved({ change: { id: 12, summary: 'Edited Rose Smith (birth date)', personIds: ['I7'] }, view: null });
    await flush();
    const conflict = apiError(409, 'conflict', { reason: 'precondition', blocking: [{ id: 13, action: 'revert', summary: 'Edited Rose Smith (notes)' }] });
    api.revert.mockRejectedValueOnce(conflict);
    lastToast()[1].action.onClick();
    await flush();
    const [message, options] = lastToast();
    expect(message).toBe("This can't be done yet: later changes depend on it.");
    expect(options.kind).toBe('error');
    expect(options.action.label).toBe('Open History');
    options.action.onClick();
    await flush();
    expect(dialogs.openHistoryPanel).toHaveBeenCalledWith(expect.objectContaining({ personFilter: null, conflict, conflictAction: 'revert' }));
  });

  it('after a delete, shows the person the command returned, in place of the deleted one', async () => {
    const length = window.history.length;
    people.delete('I7');
    saved.onDeleted({ change: { id: 14, summary: 'Deleted Rose Smith', personIds: ['I7', 'I8'] }, view: { person: { id: 'I8' } } });
    await flush();
    expect(loader.cacheView).toHaveBeenCalledWith({ person: { id: 'I8' } });
    expect(urlPerson()).toBe('I8');
    expect(window.history.length).toBe(length);
    expect(shownId()).toBe('I8');
  });

  it('after a delete with no view, falls back to the first of the change\'s people who still exists', async () => {
    people.delete('I7');
    saved.onDeleted({ change: { id: 14, summary: 'Deleted Rose Smith', personIds: ['I7', 'I9', 'I8'] }, view: null });
    await flush();
    expect(urlPerson()).toBe('I8');
    expect(shownId()).toBe('I8');
  });

  it('falls back to the default person when nobody in the change exists', async () => {
    people.delete('I7');
    saved.onDeleted({ change: { id: 14, summary: 'Deleted Rose Smith', personIds: ['I7'] }, view: null });
    await flush();
    expect(urlPerson()).toBe(DEFAULT_PERSON_ID);
    expect(shownId()).toBe(DEFAULT_PERSON_ID);
  });

  it('after a save, leaves someone who went Back meanwhile where they are', async () => {
    window.history.pushState({}, '', '/?person=I8');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await flush();
    expect(shownId()).toBe('I8');
    const length = window.history.length;
    personDetails.showPerson.mockClear();
    loader.invalidateAll.mockClear();
    const view = { person: { id: 'I7' } };
    saved.onSaved({ change: { id: 12, summary: 'Edited Rose Smith (birth date)', personIds: ['I7'] }, view });
    await flush();
    expect(loader.invalidateAll).toHaveBeenCalledTimes(1);
    expect(loader.cacheView).toHaveBeenCalledWith(view);
    expect(urlPerson()).toBe('I8');
    expect(window.history.length).toBe(length);
    expect(personDetails.showPerson).not.toHaveBeenCalled();
    expect(lastToast()[1].action.label).toBe('Undo');
  });

  it('after a delete, leaves someone who went Back meanwhile where they are', async () => {
    window.history.pushState({}, '', '/?person=I8');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await flush();
    people.delete('I7');
    personDetails.showPerson.mockClear();
    saved.onDeleted({ change: { id: 14, summary: 'Deleted Rose Smith', personIds: ['I7'] }, view: { person: { id: DEFAULT_PERSON_ID } } });
    await flush();
    expect(urlPerson()).toBe('I8');
    expect(personDetails.showPerson).not.toHaveBeenCalled();
  });

  it('every editor\'s callback runs the same flow', async () => {
    const result = { change: { id: 15, summary: 'Added Jack Smith as a son of Rose Smith', personIds: ['I8', 'I7'] }, view: null };
    await signInAs(EDITOR); // renders the panel again (beforeEach cleared its calls)
    const rose = people.get('I7');
    shownOptions().onAddRelative('child', rose);
    shownOptions().onUnlink({ relation: 'child', role: 'child', personId: 'I8', familyId: 'F5' }, rose);
    shownOptions().onEditFamily({ familyId: 'F5', partners: [] }, rose);
    const callbacks = [
      dialogs.openRelativeDialog.mock.calls[0][0].onAdded,
      dialogs.openUnlinkConfirm.mock.calls[0][0].onUnlinked,
      dialogs.openFamilyEditor.mock.calls[0][0].onSaved
    ];
    for (const callback of callbacks) {
      showToast.mockClear();
      loader.invalidateAll.mockClear();
      callback(result);
      await flush();
      expect(loader.invalidateAll).toHaveBeenCalledTimes(1);
      expect(lastToast()[0]).toBe('Added Jack Smith as a son of Rose Smith');
      expect(lastToast()[1].action.label).toBe('Undo');
    }
  });
});

describe('initApp: keyboard undo and redo', () => {
  beforeEach(async () => {
    await start();
    await signInAs(EDITOR);
    loader.invalidateAll.mockClear();
    personDetails.showPerson.mockClear();
    showToast.mockClear();
  });

  it('Ctrl+Z undoes, re-renders and toasts the summary', async () => {
    const event = await press('z', { ctrlKey: true });
    expect(event.defaultPrevented).toBe(true);
    expect(api.undo).toHaveBeenCalledTimes(1);
    expect(loader.invalidateAll).toHaveBeenCalledTimes(1);
    expect(shownId()).toBe('I7');
    expect(lastToast()[0]).toBe('Undid: Edited Rose Smith (birth date)');
  });

  it('Cmd+Z undoes; Ctrl+Shift+Z, Cmd+Shift+Z and Ctrl+Y redo', async () => {
    await press('z', { metaKey: true });
    expect(api.undo).toHaveBeenCalledTimes(1);
    await press('Z', { ctrlKey: true, shiftKey: true });
    await press('Z', { metaKey: true, shiftKey: true });
    await press('y', { ctrlKey: true });
    expect(api.redo).toHaveBeenCalledTimes(3);
    expect(lastToast()[0]).toBe('Redid: Edited Rose Smith (birth date)');
  });

  it('says when there is nothing to undo or redo', async () => {
    api.undo.mockResolvedValueOnce(null);
    api.redo.mockResolvedValueOnce(null);
    await press('z', { ctrlKey: true });
    expect(lastToast()[0]).toBe('Nothing to undo');
    await press('y', { ctrlKey: true });
    expect(lastToast()[0]).toBe('Nothing to redo');
    expect(loader.invalidateAll).not.toHaveBeenCalled();
  });

  it('runs presses one after another', async () => {
    const answers = [];
    api.undo.mockImplementation(() => new Promise(resolve => answers.push(resolve)));
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
    await flush();
    expect(api.undo).toHaveBeenCalledTimes(1);
    answers[0]({ id: 31, summary: 'Undid: one', personIds: ['I7'] });
    await flush();
    expect(api.undo).toHaveBeenCalledTimes(2);
    answers[1]({ id: 32, summary: 'Undid: two', personIds: ['I7'] });
    await flush();
    expect(showToast.mock.calls.map(([message]) => message)).toEqual(['Undid: one', 'Undid: two']);
  });

  it('opens the change\'s first person who still exists when the current one is gone', async () => {
    api.undo.mockResolvedValueOnce({ id: 33, summary: 'Undid: Added Rose Smith as a daughter of Jack Smith', personIds: ['I7', 'I8'] });
    people.delete('I7');
    await press('z', { ctrlKey: true });
    expect(urlPerson()).toBe('I8');
    expect(shownId()).toBe('I8');
  });

  it('offers History when the undo is blocked', async () => {
    const conflict = apiError(409, 'conflict', { reason: 'untracked' });
    api.undo.mockRejectedValueOnce(conflict);
    await press('z', { ctrlKey: true });
    const [message, options] = lastToast();
    expect(message).toBe("This change can't be undone automatically: the data has changed in a way the history doesn't explain.");
    expect(options.kind).toBe('error');
    options.action.onClick();
    await flush();
    expect(dialogs.openHistoryPanel).toHaveBeenCalledWith(expect.objectContaining({ conflict, conflictAction: 'revert' }));
  });

  it('words a blocked redo as a restore, here and in History', async () => {
    const conflict = apiError(409, 'conflict', { reason: 'untracked' });
    api.redo.mockRejectedValueOnce(conflict);
    await press('y', { ctrlKey: true });
    expect(lastToast()[0]).toBe("This change can't be restored automatically: the data has changed in a way the history doesn't explain.");
    lastToast()[1].action.onClick();
    await flush();
    expect(dialogs.openHistoryPanel).toHaveBeenCalledWith(expect.objectContaining({ conflict, conflictAction: 'restore' }));
  });

  it('drops presses queued behind a failure, so it is reported once', async () => {
    const answers = [];
    api.undo.mockImplementation(() => new Promise((resolve, reject) => answers.push({ resolve, reject })));
    for (let i = 0; i < 3; i++) {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
    }
    await flush();
    expect(api.undo).toHaveBeenCalledTimes(1);
    answers[0].reject(apiError(409, 'conflict', { reason: 'precondition' }));
    await flush();
    expect(api.undo).toHaveBeenCalledTimes(1);
    expect(showToast.mock.calls.filter(([message]) => /can't be done/.test(message))).toHaveLength(1);
    await press('z', { ctrlKey: true }); // a new press is heard again
    expect(api.undo).toHaveBeenCalledTimes(2);
  });

  it('drops presses queued at sign-out, even after signing in again', async () => {
    const answers = [];
    api.undo.mockImplementation(() => new Promise(resolve => answers.push(resolve)));
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
    await flush();
    signInOptions.onSignedOut('expired');
    await signInAs(EDITOR);
    answers[0](null);
    await flush();
    expect(api.undo).toHaveBeenCalledTimes(1);
  });

  it('keeps going after a press whose re-render failed', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    loader.invalidateAll.mockImplementationOnce(() => { throw new Error('boom'); });
    await press('z', { ctrlKey: true });
    await press('z', { ctrlKey: true });
    expect(api.undo).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalled();
    expect(shownId()).toBe('I7');
  });

  it('leaves a page someone went to while the undo ran alone', async () => {
    let answer;
    api.undo.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
    await flush();
    window.history.pushState({}, '', '/?person=I8');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await flush();
    personDetails.showPerson.mockClear();
    loader.invalidateAll.mockClear();
    answer({ id: 50, summary: 'Undid: Added Rose Smith', personIds: ['I7'] });
    await flush();
    expect(loader.invalidateAll).toHaveBeenCalledTimes(1);
    expect(urlPerson()).toBe('I8');
    expect(personDetails.showPerson).not.toHaveBeenCalled();
  });

  it('keeps an open History current after a keyboard undo and a toast\'s Undo', async () => {
    signInOptions.openHistory();
    await flush();
    const history = dialogs.openHistoryPanel.mock.results[0].value;
    await press('z', { ctrlKey: true });
    expect(history.refresh).toHaveBeenLastCalledWith({ change: { id: 21, summary: 'Undid: Edited Rose Smith (birth date)', personIds: ['I7'] } });
    history.isOpen.mockReturnValue(false);
    await press('z', { ctrlKey: true });
    expect(history.refresh).toHaveBeenCalledTimes(1);
  });

  it('re-renders and says so when someone else already undid the change', async () => {
    api.undo.mockRejectedValueOnce(apiError(409, 'wrong_state'));
    await press('z', { ctrlKey: true });
    expect(lastToast()).toEqual(['Someone else has already undone or restored that change.', { kind: 'error' }]);
    expect(loader.invalidateAll).toHaveBeenCalledTimes(1);
    expect(shownId()).toBe('I7');
  });

  it('shows other failures as an error toast', async () => {
    api.redo.mockRejectedValueOnce(apiError(0, 'network', { message: "Couldn't reach the server." }));
    await press('y', { ctrlKey: true });
    expect(lastToast()).toEqual(["Couldn't reach the server.", { kind: 'error' }]);
  });

  it.each([
    ['an input', () => document.createElement('input')],
    ['a textarea', () => document.createElement('textarea')],
    ['a select', () => document.createElement('select')],
    ['editable text', () => {
      const editable = document.createElement('div');
      editable.setAttribute('contenteditable', 'true');
      editable.tabIndex = 0;
      return editable;
    }]
  ])('leaves the keys alone while typing in %s', async (_, make) => {
    const field = make();
    document.body.appendChild(field);
    field.focus();
    const undoEvent = await press('z', { ctrlKey: true }, field);
    const redoEvent = await press('y', { ctrlKey: true }, field);
    expect(undoEvent.defaultPrevented).toBe(false);
    expect(redoEvent.defaultPrevented).toBe(false);
    expect(api.undo).not.toHaveBeenCalled();
    expect(api.redo).not.toHaveBeenCalled();
  });

  it('leaves the keys alone inside editable text\'s children', async () => {
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', '');
    editable.innerHTML = '<p><b>bold</b></p>';
    document.body.appendChild(editable);
    await press('z', { ctrlKey: true }, editable.querySelector('b'));
    expect(api.undo).not.toHaveBeenCalled();
  });

  it('leaves the keys alone while an editor dialog or the sign-in dialog is open', async () => {
    dialogs.isEditorDialogOpen.mockReturnValue(true);
    expect((await press('z', { ctrlKey: true })).defaultPrevented).toBe(false);
    dialogs.isEditorDialogOpen.mockReturnValue(false);
    signIn.isOpen.mockReturnValue(true);
    expect((await press('z', { ctrlKey: true })).defaultPrevented).toBe(false);
    expect(api.undo).not.toHaveBeenCalled();
  });

  it('leaves the keys alone while the photo viewer is open', async () => {
    const viewer = document.createElement('div');
    viewer.className = 'photo-viewer photo-viewer-open';
    document.body.appendChild(viewer);
    expect((await press('z', { ctrlKey: true })).defaultPrevented).toBe(false);
    viewer.classList.remove('photo-viewer-open');
    expect((await press('z', { ctrlKey: true })).defaultPrevented).toBe(true);
    expect(api.undo).toHaveBeenCalledTimes(1);
  });

  it('leaves the keys alone when held down, or already handled', async () => {
    await press('z', { ctrlKey: true, repeat: true });
    const handled = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true });
    handled.preventDefault();
    document.body.dispatchEvent(handled);
    await flush();
    expect(api.undo).not.toHaveBeenCalled();
  });

  it('leaves the keys alone for someone who can\'t edit', async () => {
    signInOptions.onSignedOut('signed-out');
    await flush();
    expect((await press('z', { ctrlKey: true })).defaultPrevented).toBe(false);
    await signInAs({ email: 'tom@example.com', name: null, role: null });
    expect((await press('z', { ctrlKey: true })).defaultPrevented).toBe(false);
    expect(api.undo).not.toHaveBeenCalled();
  });

  it('stops listening when destroyed', async () => {
    app.destroy();
    expect(signIn.destroy).toHaveBeenCalled();
    await press('z', { ctrlKey: true });
    expect(api.undo).not.toHaveBeenCalled();
    app = null;
  });
});
