import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openHistoryPanel, relativeTime, conflictMessage, toggleErrorMessage, PAGE_SIZE } from '../src/historyPanel.js';
import { isEditorDialogOpen } from '../src/editorDialog.js';
import { showToast } from '../src/toast.js';

vi.mock('../src/toast.js', () => ({ showToast: vi.fn() }));

const XSS = '<img src=x onerror="window.__xss = 1">';
const NOW = Date.parse('2026-10-09T12:00:00Z');
const ago = (ms) => new Date(NOW - ms).toISOString();
const MINUTE = 60_000;

const apiError = (status, code, body = {}) => Object.assign(new Error(body.message ?? code), {
  name: 'ApiError', status, code, reason: body.reason ?? null, blocking: body.blocking ?? [], field: body.field ?? null, body
});

/** A recorded change, as GET /changes lists it. */
const change = (id, extra = {}) => ({
  id, createdAt: ago(3 * MINUTE), authorName: 'Ann', authorEmail: 'ann@example.com', kind: 'update_person', via: 'edit',
  summary: `Change ${id}`, personIds: ['I7'], baseChangeId: null, undone: false, ...extra
});

/** Changes `from` down to `to` (newest first), as base changes. */
const range = (from, to, extra = {}) => Array.from({ length: from - to + 1 }, (_, i) => change(from - i, extra));

let log; // every change on the "server", newest first
let api;
let onOpenPerson;
let onChanged;
let panel;

/** listChanges over `log`, like the API: newest first, `before` exclusive, at most `limit`, filtered by person. */
function listChanges({ before, limit = PAGE_SIZE, person } = {}) {
  return Promise.resolve(log
    .filter(entry => before === undefined || entry.id < before)
    .filter(entry => !person || entry.personIds.includes(person))
    .slice(0, limit));
}

/** revert or restore on the "server": flips the base change and logs the undo or redo line. */
const toggle = (kind) => vi.fn(async (id) => {
  const base = log.find(entry => entry.id === id);
  const next = Math.max(0, ...log.map(entry => entry.id)) + 1;
  const summary = `${kind === 'undo' ? 'Undid' : 'Redid'}: Change ${id}`;
  const personIds = base?.personIds ?? [];
  log = [change(next, { kind, summary, baseChangeId: id, personIds }),
    ...log.map(entry => (entry.id === id ? { ...entry, undone: kind === 'undo' } : entry))];
  return { id: next, summary, personIds };
});

const flush = async (times = 5) => {
  for (let i = 0; i < times; i++) await new Promise(resolve => setTimeout(resolve, 0));
};

async function open(options = {}) {
  panel = openHistoryPanel({ api, onOpenPerson, onChanged, now: () => NOW, ...options });
  await flush();
  return panel;
}

const root = () => document.querySelector('.history-panel');
const $ = (selector) => root().querySelector(selector);
const $$ = (selector) => [...root().querySelectorAll(selector)];
const entry = (id) => $(`.history-entry[data-change-id="${id}"]`);
const entryIds = () => $$('.history-entry').map(element => Number(element.dataset.changeId));
const actionOf = (id) => entry(id).querySelector('.history-action');
const statusText = () => $('.history-status').textContent;

beforeEach(() => {
  document.body.innerHTML = '';
  log = range(3, 1);
  api = {
    listChanges: vi.fn(listChanges),
    revert: toggle('undo'),
    restore: toggle('redo')
  };
  onOpenPerson = vi.fn();
  onChanged = vi.fn();
  showToast.mockClear();
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  panel?.close();
  panel = null;
  delete Element.prototype.scrollIntoView;
  delete globalThis.IntersectionObserver;
});

describe('relativeTime', () => {
  it('says how long ago, then gives the date', () => {
    expect(relativeTime(ago(20_000), NOW)).toBe('just now');
    expect(relativeTime(ago(-60_000), NOW)).toBe('just now'); // a clock a little ahead
    expect(relativeTime(ago(MINUTE), NOW)).toBe('1 min ago');
    expect(relativeTime(ago(3 * MINUTE), NOW)).toBe('3 min ago');
    expect(relativeTime(ago(60 * MINUTE), NOW)).toBe('1 hour ago');
    expect(relativeTime(ago(5 * 60 * MINUTE), NOW)).toBe('5 hours ago');
    expect(relativeTime(ago(26 * 60 * MINUTE), NOW)).toBe('1 day ago');
    expect(relativeTime(ago(3 * 24 * 60 * MINUTE), NOW)).toBe('3 days ago');
    const old = relativeTime(ago(30 * 24 * 60 * MINUTE), NOW);
    expect(old).not.toMatch(/ago/);
    expect(old).toMatch(/2026/);
    expect(relativeTime('not a date', NOW)).toBe('');
  });
});

describe('conflictMessage and toggleErrorMessage', () => {
  it('words each conflict reason', () => {
    expect(conflictMessage(apiError(409, 'conflict', { reason: 'precondition' })))
      .toBe("This can't be done yet: later changes depend on it.");
    expect(conflictMessage(apiError(409, 'conflict', { reason: 'cascade' })))
      .toBe("This can't be done yet: later changes depend on it.");
    expect(conflictMessage(apiError(409, 'conflict', { reason: 'untracked' })))
      .toBe("This change can't be undone automatically: the data has changed in a way the history doesn't explain.");
    expect(conflictMessage(apiError(409, 'conflict', { reason: 'untracked' }), 'restore'))
      .toBe("This change can't be restored automatically: the data has changed in a way the history doesn't explain.");
    expect(conflictMessage(apiError(409, 'conflict', { reason: 'structure' }))).toMatch(/family without (any )?parents/);
    expect(conflictMessage(apiError(409, 'conflict', { reason: 'cycle' }))).toMatch(/their own ancestor/);
  });

  it('words other failures', () => {
    expect(toggleErrorMessage(apiError(0, 'network', { message: "Couldn't reach the server." }))).toBe("Couldn't reach the server.");
    expect(toggleErrorMessage(apiError(503, 'busy', { message: 'The family tree is busy — please try again.' })))
      .toBe('The family tree is busy — please try again.');
    expect(toggleErrorMessage(apiError(401, 'unauthenticated'))).toMatch(/signed out/i);
    expect(toggleErrorMessage(apiError(409, 'wrong_state'))).toMatch(/already/);
    expect(toggleErrorMessage(apiError(500, 'internal'))).toBe('The server had a problem (internal). Try again.');
  });
});

describe('openHistoryPanel: the list', () => {
  it('opens a slide-over dialog with the newest changes first', async () => {
    await open();
    expect(document.querySelector('.editor-dialog-backdrop.history-backdrop')).not.toBeNull();
    expect(root().getAttribute('role')).toBe('dialog');
    expect(root().querySelector('.editor-dialog-title').textContent).toBe('History');
    expect(isEditorDialogOpen()).toBe(true);
    expect(api.listChanges).toHaveBeenCalledWith({ before: undefined, limit: PAGE_SIZE, person: undefined });
    expect(entryIds()).toEqual([3, 2, 1]);
  });

  it('shows each summary, author and relative time as text', async () => {
    log = [change(1, { summary: XSS, authorName: XSS })];
    await open();
    expect(entry(1).querySelector('.history-summary').textContent).toBe(XSS);
    expect(entry(1).querySelector('.history-author').textContent).toBe(XSS);
    const time = entry(1).querySelector('time.history-time');
    expect(time.textContent).toBe('3 min ago');
    expect(time.getAttribute('datetime')).toBe(ago(3 * MINUTE));
    expect(time.title).toMatch(/2026/);
    expect(document.querySelector('img')).toBeNull();
  });

  it('falls back to the email when there is no author name', async () => {
    log = [change(1, { authorName: null })];
    await open();
    expect(entry(1).querySelector('.history-author').textContent).toBe('ann@example.com');
  });

  it('offers Revert on changes in effect, Restore (greyed) on reverted ones, and nothing on undo and redo lines', async () => {
    log = [
      change(4, { kind: 'redo', summary: 'Redid: Change 1', baseChangeId: 1 }),
      change(3, { kind: 'undo', summary: 'Undid: Change 1', baseChangeId: 1 }),
      change(2, { undone: true }),
      change(1)
    ];
    await open();
    expect(actionOf(1).textContent).toBe('Revert');
    expect(entry(1).classList.contains('history-entry-undone')).toBe(false);
    expect(actionOf(2).textContent).toBe('Restore');
    expect(entry(2).classList.contains('history-entry-undone')).toBe(true);
    expect(entry(2).querySelector('.history-state').hidden).toBe(false);
    expect(entry(2).querySelector('.history-state').textContent).toBe('Reverted');
    expect(actionOf(3)).toBeNull();
    expect(actionOf(4)).toBeNull();
    expect(entry(3).classList.contains('history-entry-toggle')).toBe(true);
    expect(entry(3).classList.contains('history-entry-undone')).toBe(false);
  });

  it('links an entry to its first person, closing the panel', async () => {
    log = [change(2, { personIds: ['I9', 'I7'] }), change(1, { personIds: [] })];
    await open();
    expect(entry(1).querySelector('.history-open')).toBeNull();
    entry(2).querySelector('.history-open').click();
    expect(onOpenPerson).toHaveBeenCalledWith('I9');
    expect(panel.isOpen()).toBe(false);
    expect(document.querySelector('.history-panel')).toBeNull();
  });

  it('says when there are no changes', async () => {
    log = [];
    await open();
    expect(statusText()).toBe('No changes yet.');
  });

  it('shows a load failure with Try again', async () => {
    api.listChanges.mockRejectedValueOnce(apiError(0, 'network', { message: "Couldn't reach the server." }));
    await open();
    expect(statusText()).toMatch(/Couldn't load the history\. Couldn't reach the server\./);
    const retry = $('.history-retry-load');
    expect(retry.hidden).toBe(false);
    retry.click();
    await flush();
    expect(entryIds()).toEqual([3, 2, 1]);
    expect(retry.hidden).toBe(true);
  });

  it('closes on Escape', async () => {
    await open();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(panel.isOpen()).toBe(false);
  });
});

describe('openHistoryPanel: infinite scroll', () => {
  it('loads older pages with `before` = the last id, until a short page', async () => {
    log = range(120, 1);
    await open();
    expect(entryIds()).toHaveLength(50);
    const more = $('.history-more');
    expect(more.hidden).toBe(false);
    more.click();
    await flush();
    expect(api.listChanges).toHaveBeenLastCalledWith({ before: 71, limit: PAGE_SIZE, person: undefined });
    expect(entryIds()).toHaveLength(100);
    more.click();
    await flush();
    expect(api.listChanges).toHaveBeenLastCalledWith({ before: 21, limit: PAGE_SIZE, person: undefined });
    expect(entryIds()).toHaveLength(120);
    expect(entryIds().at(-1)).toBe(1);
    expect(more.hidden).toBe(true);
    expect(statusText()).toBe('No older changes.');
  });

  it('loads the next page when the end of the list scrolls into view', async () => {
    const observers = [];
    globalThis.IntersectionObserver = class {
      constructor(callback, options) {
        this.callback = callback;
        this.options = options;
        this.targets = new Set();
        observers.push(this);
      }
      observe(target) { this.targets.add(target); }
      unobserve(target) { this.targets.delete(target); }
      disconnect() { this.targets.clear(); }
    };
    log = range(120, 1);
    await open();
    const [observer] = observers;
    expect(observer.options.root).toBe(root().querySelector('.editor-dialog-body'));
    const [sentinel] = observer.targets;
    expect(sentinel.isConnected).toBe(true);
    observer.callback([{ isIntersecting: false, target: sentinel }]);
    await flush();
    expect(entryIds()).toHaveLength(50);
    observer.callback([{ isIntersecting: true, target: sentinel }]);
    observer.callback([{ isIntersecting: true, target: sentinel }]); // a second report while loading
    await flush();
    expect(api.listChanges).toHaveBeenCalledTimes(2);
    expect(entryIds()).toHaveLength(100);
    panel.close();
    expect(observer.targets.size).toBe(0);
  });

  it('after a failed page, waits for Try again rather than retrying while the end is in view', async () => {
    const observers = [];
    globalThis.IntersectionObserver = class {
      constructor(callback) {
        this.callback = callback;
        observers.push(this);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    log = range(120, 1);
    await open();
    api.listChanges.mockRejectedValueOnce(apiError(0, 'network', { message: "Couldn't reach the server." }));
    observers[0].callback([{ isIntersecting: true }]);
    await flush();
    expect(api.listChanges).toHaveBeenCalledTimes(2);
    observers[0].callback([{ isIntersecting: true }]);
    await flush();
    expect(api.listChanges).toHaveBeenCalledTimes(2);
    $('.history-retry-load').click();
    await flush();
    expect(entryIds()).toHaveLength(100);
  });

  it('ignores ids it already has', async () => {
    log = range(60, 1);
    api.listChanges.mockImplementationOnce(listChanges).mockImplementationOnce(async () => range(11, 1).concat([change(12)]));
    await open();
    $('.history-more').click();
    await flush();
    expect(entryIds().filter(id => id === 11)).toHaveLength(1);
    expect(new Set(entryIds()).size).toBe(entryIds().length);
  });
});

describe('openHistoryPanel: person filter', () => {
  beforeEach(() => {
    log = [change(3, { personIds: ['I8'] }), change(2, { personIds: ['I7', 'I8'] }), change(1, { personIds: ['I7'] })];
  });

  it('shows only changes to the person, with a chip that clears the filter', async () => {
    await open({ personFilter: { id: 'I7', name: 'Rose Smith' } });
    expect(api.listChanges).toHaveBeenCalledWith({ before: undefined, limit: PAGE_SIZE, person: 'I7' });
    expect($('.history-filter').hidden).toBe(false);
    expect($('.history-filter-text').textContent).toBe('Changes to Rose Smith');
    expect(entryIds()).toEqual([2, 1]);
    const clear = $('.history-filter-clear');
    expect(clear.getAttribute('aria-label')).toBe('Show all changes');
    clear.click();
    await flush();
    expect(api.listChanges).toHaveBeenLastCalledWith({ before: undefined, limit: PAGE_SIZE, person: undefined });
    expect($('.history-filter').hidden).toBe(true);
    expect(entryIds()).toEqual([3, 2, 1]);
    expect(root().contains(document.activeElement)).toBe(true);
  });

  it('says when the person has no changes, and names unnamed people', async () => {
    log = [];
    await open({ personFilter: { id: 'I7', name: '  ' } });
    expect($('.history-filter-text').textContent).toBe('Changes to Unnamed person');
    expect(statusText()).toBe('No changes to Unnamed person yet.');
  });

  it('drops a filtered page that arrives after the filter was cleared', async () => {
    let answer;
    api.listChanges.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
    panel = openHistoryPanel({ api, onOpenPerson, onChanged, now: () => NOW, personFilter: { id: 'I7', name: 'Rose' } });
    await flush();
    $('.history-filter-clear').click();
    await flush();
    answer([change(99)]);
    await flush();
    expect(entryIds()).toEqual([3, 2, 1]);
  });
});

describe('openHistoryPanel: Revert and Restore', () => {
  it('reverts a change from History, toasts, reports it, and shows the new state and the undo line', async () => {
    await open();
    let resolve;
    api.revert.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    actionOf(2).click();
    expect(api.revert).toHaveBeenCalledWith(2, 'history');
    expect(actionOf(2).disabled).toBe(true);
    expect(actionOf(2).textContent).toBe('Reverting…');
    log = [change(4, { kind: 'undo', summary: 'Undid: Change 2', baseChangeId: 2 }), change(3), change(2, { undone: true }), change(1)];
    resolve({ id: 4, summary: 'Undid: Change 2', personIds: ['I7'] });
    await flush();
    expect(showToast).toHaveBeenCalledWith('Undid: Change 2');
    expect(onChanged).toHaveBeenCalledWith({ change: { id: 4, summary: 'Undid: Change 2', personIds: ['I7'] } });
    expect(actionOf(2).disabled).toBe(false);
    expect(actionOf(2).textContent).toBe('Restore');
    expect(entry(2).classList.contains('history-entry-undone')).toBe(true);
    expect(entryIds()).toEqual([4, 3, 2, 1]);
    expect(actionOf(4)).toBeNull();
  });

  it('restores a reverted change', async () => {
    log = [change(2, { undone: true }), change(1)];
    await open();
    actionOf(2).click();
    expect(api.restore).toHaveBeenCalledWith(2);
    await flush();
    expect(showToast).toHaveBeenCalledWith('Redid: Change 2');
    expect(onChanged).toHaveBeenCalledWith({ change: { id: 3, summary: 'Redid: Change 2', personIds: ['I7'] } });
    expect(actionOf(2).textContent).toBe('Revert');
    expect(entry(2).classList.contains('history-entry-undone')).toBe(false);
  });

  it('shows other failures in the entry', async () => {
    await open();
    api.revert.mockRejectedValueOnce(apiError(0, 'network', { message: "Couldn't reach the server." }));
    actionOf(2).click();
    await flush();
    const message = entry(2).querySelector('.history-entry-message');
    expect(message.hidden).toBe(false);
    expect(message.textContent).toBe("Couldn't reach the server.");
    expect(onChanged).not.toHaveBeenCalled();
    expect(actionOf(2).textContent).toBe('Revert');
  });

  it('shows the new state when someone else got there first', async () => {
    await open();
    log = log.map(entry => (entry.id === 2 ? { ...entry, undone: true } : entry)); // reverted by someone else
    api.revert.mockRejectedValueOnce(apiError(409, 'wrong_state'));
    actionOf(2).click();
    await flush();
    expect(entry(2).querySelector('.history-entry-message').textContent).toBe('Someone else has already reverted this change.');
    expect(actionOf(2).textContent).toBe('Restore');
  });
});

describe('openHistoryPanel: conflicts', () => {
  const blocked = (blocking, reason = 'precondition') => apiError(409, 'conflict', { reason, blocking });
  const BLOCKERS = [
    { id: 5, action: 'revert', summary: "Edited Rose Smith (birth date)", authorName: 'Ann', createdAt: ago(2 * MINUTE) },
    { id: 4, action: 'restore', summary: 'Added Jack Smith as a son of Tom Smith', authorName: 'Tom', createdAt: ago(60 * MINUTE) }
  ];

  beforeEach(() => {
    log = [change(5), change(4, { undone: true }), ...range(3, 1)];
  });

  it('lists the blockers with their actions', async () => {
    await open();
    api.revert.mockRejectedValueOnce(blocked(BLOCKERS));
    actionOf(2).click();
    await flush();
    const conflict = entry(2).querySelector('.history-conflict');
    expect(conflict.getAttribute('role')).toBe('alert');
    expect(conflict.querySelector('.history-conflict-message').textContent).toBe("This can't be done yet: later changes depend on it.");
    const links = [...conflict.querySelectorAll('.history-blocker-link')].map(link => link.textContent);
    expect(links).toEqual(['Revert: Edited Rose Smith (birth date)', 'Restore: Added Jack Smith as a son of Tom Smith']);
    const metas = [...conflict.querySelectorAll('.history-blocker-meta')].map(meta => meta.textContent);
    expect(metas).toEqual(['Ann · 2 min ago', 'Tom · 1 hour ago']);
    const actions = [...conflict.querySelectorAll('.history-blocker-action')].map(button => button.textContent);
    expect(actions).toEqual(['Revert', 'Restore']);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('sets blocker text as text', async () => {
    await open();
    api.revert.mockRejectedValueOnce(blocked([{ id: 5, action: 'revert', summary: XSS, authorName: XSS, createdAt: null }]));
    actionOf(2).click();
    await flush();
    expect(entry(2).querySelector('.history-blocker-link').textContent).toBe(`Revert: ${XSS}`);
    expect(entry(2).querySelector('.history-blocker-meta').textContent).toBe(XSS);
    expect(document.querySelector('img')).toBeNull();
  });

  it('names a blocker by id when its summary could not be read', async () => {
    await open();
    api.revert.mockRejectedValueOnce(blocked([{ id: 5, action: 'revert', summary: null, authorName: null, createdAt: null }]));
    actionOf(2).click();
    await flush();
    expect(entry(2).querySelector('.history-blocker-link').textContent).toBe('Revert: change 5');
  });

  it('uses the untracked, structure and cycle wordings', async () => {
    await open();
    api.revert.mockRejectedValueOnce(blocked([], 'untracked'));
    actionOf(2).click();
    await flush();
    expect(entry(2).querySelector('.history-conflict-message').textContent)
      .toBe("This change can't be undone automatically: the data has changed in a way the history doesn't explain.");
    expect(entry(2).querySelector('.history-blockers')).toBeNull();

    api.revert.mockRejectedValueOnce(blocked(BLOCKERS.slice(0, 1), 'structure'));
    actionOf(2).click();
    await flush();
    expect(entry(2).querySelector('.history-conflict-message').textContent).toMatch(/family without (any )?parents/);
    expect(entry(2).querySelectorAll('.history-blocker')).toHaveLength(1);

    api.revert.mockRejectedValueOnce(blocked([], 'cycle'));
    actionOf(2).click();
    await flush();
    expect(entry(2).querySelector('.history-conflict-message').textContent).toMatch(/their own ancestor/);
  });

  it('scrolls to and highlights a blocking change that is already listed', async () => {
    await open();
    api.revert.mockRejectedValueOnce(blocked(BLOCKERS));
    actionOf(2).click();
    await flush();
    entry(2).querySelector('.history-blocker-link').click();
    await flush();
    expect(entry(5).classList.contains('history-entry-highlight')).toBe(true);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    expect(Element.prototype.scrollIntoView.mock.contexts.at(-1)).toBe(entry(5));
    expect(document.activeElement).toBe(actionOf(5));
    entry(2).querySelectorAll('.history-blocker-link')[1].click();
    await flush();
    expect(entry(5).classList.contains('history-entry-highlight')).toBe(false);
    expect(entry(4).classList.contains('history-entry-highlight')).toBe(true);
  });

  it('loads older pages to find a blocking change', async () => {
    log = range(160, 1);
    await open();
    $('.history-more').click();
    await flush();
    $('.history-more').click();
    await flush();
    expect(entryIds().at(-1)).toBe(11);
    // A revert of 150 blocked by... 150 is listed; pretend the blocker is older than what's loaded (odd, but
    // the panel must still find it).
    api.revert.mockRejectedValueOnce(blocked([{ id: 3, action: 'revert', summary: 'Change 3', authorName: 'Ann', createdAt: ago(MINUTE) }]));
    actionOf(150).click();
    await flush();
    entry(150).querySelector('.history-blocker-link').click();
    await flush(10);
    expect(entry(3)).not.toBeNull();
    expect(entry(3).classList.contains('history-entry-highlight')).toBe(true);
  });

  it('says so when a blocking change is not in the list', async () => {
    log = [change(3, { personIds: ['I8'] }), change(2), change(1)];
    await open({ personFilter: { id: 'I7', name: 'Rose Smith' } });
    api.revert.mockRejectedValueOnce(blocked([{ id: 3, action: 'revert', summary: 'Change 3', authorName: 'Ann', createdAt: ago(MINUTE) }]));
    actionOf(2).click();
    await flush();
    entry(2).querySelector('.history-blocker-link').click();
    await flush();
    const note = entry(2).querySelector('.history-blocker-message');
    expect(note.hidden).toBe(false);
    expect(note.textContent).toMatch(/isn't in this list/);
    expect(note.textContent).toMatch(/Show all changes/);
  });

  it('gives up looking after a sane number of pages', async () => {
    log = range(5000, 1);
    await open();
    api.revert.mockRejectedValueOnce(blocked([{ id: 1, action: 'revert', summary: 'Change 1', authorName: 'Ann', createdAt: ago(MINUTE) }]));
    actionOf(5000).click();
    await flush();
    const calls = api.listChanges.mock.calls.length;
    entry(5000).querySelector('.history-blocker-link').click();
    await flush(60);
    expect(api.listChanges.mock.calls.length - calls).toBeLessThanOrEqual(20);
    expect(entry(5000).querySelector('.history-blocker-message').textContent).toMatch(/isn't in this list/);
  });

  it('performs a blocker\'s action, then the original can be tried again', async () => {
    await open();
    api.revert.mockRejectedValueOnce(blocked(BLOCKERS));
    actionOf(2).click();
    await flush();
    const [revertFive, restoreFour] = entry(2).querySelectorAll('.history-blocker-action');
    revertFive.click();
    await flush();
    expect(api.revert).toHaveBeenLastCalledWith(5, 'history');
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith('Undid: Change 5');
    expect(revertFive.hidden).toBe(true);
    expect(revertFive.closest('.history-blocker').classList.contains('history-blocker-done')).toBe(true);
    expect(actionOf(5).textContent).toBe('Restore');
    restoreFour.click();
    await flush();
    expect(api.restore).toHaveBeenLastCalledWith(4);
    expect(onChanged).toHaveBeenCalledTimes(2);
    entry(2).querySelector('.history-conflict-retry').click();
    await flush();
    expect(api.revert).toHaveBeenLastCalledWith(2, 'history');
    expect(onChanged).toHaveBeenCalledTimes(3);
    expect(entry(2).querySelector('.history-conflict')).toBeNull();
    expect(actionOf(2).textContent).toBe('Restore');
  });

  it('shows a conflict it was opened with (from a keyboard undo)', async () => {
    await open({ conflict: blocked(BLOCKERS) });
    const notice = $('.history-notice');
    expect(notice.hidden).toBe(false);
    expect(notice.querySelector('.history-conflict-message').textContent).toBe("This can't be done yet: later changes depend on it.");
    expect(notice.querySelectorAll('.history-blocker')).toHaveLength(2);
    expect(notice.querySelector('.history-conflict-retry')).toBeNull();
    notice.querySelector('.history-blocker-link').click();
    await flush();
    expect(entry(5).classList.contains('history-entry-highlight')).toBe(true);
  });
});
