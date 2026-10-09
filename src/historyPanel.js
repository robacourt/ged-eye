/**
 * The History panel: every recorded change, newest first, in a slide-over from the right (full screen below
 * 768px). It scrolls without end (each page asks for the changes `before` the last one listed), and can be
 * limited to the changes to one person.
 *
 * Base changes (commands) get Revert while in effect and Restore once reverted, and are greyed out while
 * reverted. Undo and redo changes are plain log lines. A revert or restore that later changes block lists
 * those changes with the action that would unblock each: its link finds the change in the list (loading
 * older pages if needed) and its button does that action. Every data value is set with `textContent`.
 */
import { showToast } from './toast.js';
import { el, openEditorDialog, uniqueId, callSafely, setBusy, keepFocusInside } from './editorDialog.js';
import { nameOf } from './familyLinks.js';

/** Changes per page (the API's maximum). */
export const PAGE_SIZE = 50;
/** How many older pages looking for a blocking change may load before giving up. */
const MAX_FIND_PAGES = 20;
/** Start loading the next page this far before the end of the list scrolls into view. */
const PRELOAD_MARGIN = '300px';

const TOGGLE_KINDS = new Set(['undo', 'redo']);
const ACTIONS = {
  revert: { label: 'Revert', busy: 'Reverting…', already: 'Someone else has already reverted this change.' },
  restore: { label: 'Restore', busy: 'Restoring…', already: 'Someone else has already restored this change.' }
};
const GENERIC_ERROR = 'Something went wrong. Try again.';

/** "just now", "3 min ago", "5 hours ago", "1 day ago", "3 days ago", then the date. */
export function relativeTime(iso, now = Date.now()) {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return '';
  const seconds = Math.max(0, (now - time) / 1000);
  if (seconds < 45) return 'just now';
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return days === 1 ? '1 day ago' : `${days} days ago`;
  return new Date(time).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** The full date and time, for a tooltip. */
function absoluteTime(iso) {
  const time = Date.parse(iso);
  return Number.isNaN(time) ? '' : new Date(time).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * Why a revert, restore, undo or redo was refused (a 409 `conflict`), by its `reason`.
 * @param action  'revert' (also undo) or 'restore' (also redo), for the untracked wording
 */
export function conflictMessage(error, action = 'revert') {
  switch (error?.reason) {
    case 'untracked':
      return `This change can't be ${action === 'restore' ? 'restored' : 'undone'} automatically: ` +
        "the data has changed in a way the history doesn't explain.";
    case 'structure':
      return "This can't be done: it would leave a family without any parents.";
    case 'cycle':
      return "This can't be done: it would make someone their own ancestor.";
    case 'constraint':
      return "This can't be done: it would clash with the rest of the tree.";
    default: // precondition, cascade
      return "This can't be done yet: later changes depend on it.";
  }
}

/** Words for a failed revert, restore, undo or redo. */
export function toggleErrorMessage(error) {
  if (!error) return GENERIC_ERROR;
  if (error.code === 'network' || error.code === 'busy') return error.message || GENERIC_ERROR;
  if (error.status === 401) return "You're signed out. Sign in again, then try again.";
  if (error.status === 403) return "Your account can't edit the tree. Ask Rob for access.";
  if (error.code === 'conflict') return conflictMessage(error);
  if (error.code === 'wrong_state') return 'Someone else has already undone or restored that change.';
  if (error.code === 'not_found') return "Couldn't find that change.";
  if (error.name === 'ApiError' || error.status) return `The server had a problem (${error.code}). Try again.`;
  return error.message || GENERIC_ERROR;
}

const key = (id) => String(id);

/**
 * Opens the panel.
 * @param api           `{ listChanges, revert, restore }` (editApi.js)
 * @param personFilter  optional `{ id, name }`: list only the changes to this person (the chip clears it)
 * @param conflict      optional: a conflict ApiError (from a keyboard undo or redo) to show above the list
 * @param onOpenPerson  (personId) from an entry's Open: the panel closes first
 * @param onChanged     ({ change }) after a revert or restore succeeded (the panel has toasted its summary)
 * @param now           () → the time now, for tests
 * @returns `{ close, isOpen, element }`
 */
export function openHistoryPanel({ api, personFilter = null, conflict = null, onOpenPerson, onChanged, now = Date.now }) {
  const dialog = openEditorDialog({ title: 'History', className: 'history-panel', onRequestClose: () => close() });
  dialog.backdrop.classList.add('history-backdrop');
  const { body } = dialog;

  let filter = personFilter?.id ? { id: personFilter.id, name: nameOf(personFilter) } : null;
  let entries = new Map(); // key(id) -> entry, see buildEntry
  let lastId = null;       // the oldest change listed: the next page is `before` it
  let done = false;        // the oldest change has been listed
  let loading = null;      // the page being loaded (a promise)
  let loadError = null;
  let generation = 0;      // bumped when the list starts again (filter cleared), so late pages are dropped

  // --- Layout ----------------------------------------------------------------------------------------------

  const filterText = el('span', { class: 'history-filter-text' });
  const clearFilter = el('button', { type: 'button', class: 'history-filter-clear', 'aria-label': 'Show all changes', text: '×' });
  const filterBar = el('div', { class: 'history-filter' }, filterText, clearFilter);
  const notice = el('div', { class: 'history-notice', hidden: true });
  const list = el('ol', { class: 'history-list', 'aria-label': 'Changes, newest first' });
  const sentinel = el('div', { class: 'history-sentinel', 'aria-hidden': 'true' });
  const status = el('p', { class: 'history-status', role: 'status' });
  const retryLoad = el('button', { type: 'button', class: 'editor-btn history-retry-load', text: 'Try again', hidden: true });
  const more = el('button', { type: 'button', class: 'editor-btn history-more', text: 'Load older changes', hidden: true });
  body.append(filterBar, notice, list, sentinel, el('div', { class: 'history-footer' }, status, retryLoad, more));

  clearFilter.addEventListener('click', () => {
    filter = null;
    restart();
    keepFocusInside(dialog.dialog, more);
  });
  retryLoad.addEventListener('click', () => loadMore());
  more.addEventListener('click', () => loadMore());

  // Infinite scroll: load the next page when the end of the list comes near. The button is the fallback.
  let observer = null;
  if (typeof IntersectionObserver === 'function') {
    observer = new IntersectionObserver((records) => {
      // After a failure only Try again loads, so a list end left in view doesn't retry without end.
      if (!loadError && records.some(record => record.isIntersecting)) loadMore();
    }, { root: body, rootMargin: `0px 0px ${PRELOAD_MARGIN} 0px` });
    observer.observe(sentinel);
  }

  /** Observing again reports whether the end is still in view, so a page that didn't fill the panel loads more. */
  function reobserve() {
    if (!observer || !dialog.isOpen()) return;
    observer.unobserve(sentinel);
    observer.observe(sentinel);
  }

  function renderFilter() {
    filterBar.hidden = !filter;
    filterText.textContent = filter ? `Changes to ${filter.name}` : '';
  }

  function renderFooter() {
    list.setAttribute('aria-busy', String(Boolean(loading)));
    retryLoad.hidden = !loadError || Boolean(loading);
    more.hidden = Boolean(loading || loadError) || done;
    if (loading) status.textContent = 'Loading…';
    else if (loadError) status.textContent = `Couldn't load the history. ${toggleErrorMessage(loadError)}`;
    else if (done && entries.size === 0) status.textContent = filter ? `No changes to ${filter.name} yet.` : 'No changes yet.';
    else if (done) status.textContent = 'No older changes.';
    else status.textContent = '';
  }

  // --- Entries ---------------------------------------------------------------------------------------------

  function buildEntry(change) {
    const isToggle = TOGGLE_KINDS.has(change.kind);
    const summaryId = uniqueId('history-summary');
    const element = el('li', { class: 'history-entry', 'data-change-id': key(change.id), tabindex: '-1' });
    const summary = el('p', { class: 'history-summary', id: summaryId, text: change.summary || `Change ${change.id}` });
    const time = el('time', {
      class: 'history-time', datetime: change.createdAt, title: absoluteTime(change.createdAt),
      text: relativeTime(change.createdAt, now())
    });
    const state = el('span', { class: 'history-state', text: 'Reverted', hidden: true });
    const meta = el('p', { class: 'history-meta' },
      el('span', { class: 'history-author', text: change.authorName || change.authorEmail || 'Someone' }), ' · ', time, state);
    const actions = el('div', { class: 'history-actions' });
    const message = el('div', { class: 'history-entry-message', hidden: true });
    const entry = { change, element, state, message, actionButton: null };

    if (!isToggle) {
      entry.actionButton = el('button', { type: 'button', class: 'editor-btn history-action', 'aria-describedby': summaryId });
      entry.actionButton.addEventListener('click', () => {
        perform(entry.change.id, entry.change.undone ? 'restore' : 'revert', { button: entry.actionButton, area: message });
      });
      actions.append(entry.actionButton);
    }
    const personId = change.personIds?.[0];
    if (personId) {
      const open = el('button', { type: 'button', class: 'editor-btn-link history-open', text: 'Open', 'aria-describedby': summaryId });
      open.addEventListener('click', () => {
        close();
        callSafely(onOpenPerson, personId);
      });
      actions.append(open);
    }
    element.append(summary, meta, actions, message);
    applyState(entry);
    return entry;
  }

  /** Shows whether the entry's change is in effect: Revert, or greyed with Restore. */
  function applyState(entry) {
    const isToggle = TOGGLE_KINDS.has(entry.change.kind);
    const undone = !isToggle && Boolean(entry.change.undone);
    entry.element.classList.toggle('history-entry-toggle', isToggle);
    entry.element.classList.toggle('history-entry-undone', undone);
    entry.state.hidden = !undone;
    const button = entry.actionButton;
    if (button && button.dataset.label === undefined) button.textContent = ACTIONS[undone ? 'restore' : 'revert'].label;
  }

  function addEntries(changes, { atTop = false } = {}) {
    const fresh = changes.filter(change => change && !entries.has(key(change.id)));
    const built = fresh.map(change => {
      const entry = buildEntry(change);
      entries.set(key(change.id), entry);
      return entry.element;
    });
    if (atTop) list.prepend(...built);
    else list.append(...built);
  }

  /** After a revert or restore: the change's new state, before the server's list says so. */
  function setUndone(id, undone) {
    const entry = entries.get(key(id));
    if (!entry) return;
    entry.change = { ...entry.change, undone };
    applyState(entry);
  }

  // --- Loading ---------------------------------------------------------------------------------------------

  /** Loads the next (older) page; while one is loading, resolves with it. */
  function loadMore() {
    if (loading) return loading;
    if (done || !dialog.isOpen()) return Promise.resolve();
    const startedIn = generation;
    const current = () => startedIn === generation && dialog.isOpen();
    loadError = null;
    const promise = Promise.resolve()
      .then(() => api.listChanges({ before: lastId ?? undefined, limit: PAGE_SIZE, person: filter?.id ?? undefined }))
      .then(
        (page) => {
          if (!current()) return;
          const changes = Array.isArray(page) ? page : [];
          addEntries(changes);
          if (changes.length) lastId = changes[changes.length - 1].id;
          done = changes.length < PAGE_SIZE;
        },
        (error) => {
          if (current()) loadError = error;
        })
      .finally(() => {
        if (loading !== promise) return; // the list started again meanwhile
        loading = null;
        renderFooter();
        if (!loadError) reobserve();
      });
    loading = promise;
    renderFooter();
    return promise;
  }

  /** Lists the changes made since the newest one listed (after a revert or restore), and refreshes states. */
  async function refreshNewest() {
    if (!dialog.isOpen()) return;
    const startedIn = generation;
    let page;
    try {
      page = await api.listChanges({ limit: PAGE_SIZE, person: filter?.id ?? undefined });
    } catch (error) {
      console.warn('Could not refresh the history', error);
      return;
    }
    if (startedIn !== generation || !dialog.isOpen() || !Array.isArray(page)) return;
    const newest = Math.max(-Infinity, ...[...entries.values()].map(entry => Number(entry.change.id)));
    const added = [];
    for (const change of page) {
      const entry = entries.get(key(change.id));
      if (entry) {
        entry.change = change;
        applyState(entry);
      } else if (Number(change.id) > newest) {
        added.push(change);
      }
    }
    addEntries(added, { atTop: true });
    if (lastId === null && page.length) {
      lastId = page[page.length - 1].id;
      done = page.length < PAGE_SIZE;
    }
    renderFooter();
  }

  /** Empties the list and loads it again from the newest change (with the current filter). */
  function restart() {
    generation++;
    entries = new Map();
    list.replaceChildren();
    lastId = null;
    done = false;
    loading = null;
    loadError = null;
    renderFilter();
    loadMore();
  }

  // --- Revert and Restore ----------------------------------------------------------------------------------

  function showText(area, text) {
    area.replaceChildren(el('p', { class: 'editor-error', role: 'alert', text }));
    area.hidden = false;
  }

  function clearArea(area) {
    area.replaceChildren();
    area.hidden = true;
  }

  /**
   * Reverts or restores change `id`, showing a failure in `area`. The panel is busy meanwhile.
   * Resolves to the new change, or null when it failed.
   */
  async function perform(id, action, { button, area }) {
    if (body.getAttribute('aria-busy') === 'true') return null;
    clearArea(area);
    setBusy(body, true, button, ACTIONS[action].busy);
    let change = null;
    let error = null;
    try {
      change = action === 'revert' ? await api.revert(id, 'history') : await api.restore(id);
    } catch (caught) {
      error = caught;
    }
    setBusy(body, false, button);
    if (error) {
      if (error.code === 'wrong_state') {
        setUndone(id, action === 'revert');
        showText(area, ACTIONS[action].already);
        refreshNewest();
      } else if (error.code === 'conflict') {
        showConflict(area, error, { action, retry: () => perform(id, action, { button, area }) });
      } else {
        showText(area, toggleErrorMessage(error));
      }
      const entry = entries.get(key(id));
      if (entry) applyState(entry);
      return null;
    }
    setUndone(id, action === 'revert');
    if (change?.summary) showToast(change.summary);
    callSafely(onChanged, { change });
    refreshNewest();
    return change;
  }

  /** A conflict: why, each blocking change with its action, and (for a change in the list) Try again. */
  function showConflict(area, error, { action = 'revert', retry = null } = {}) {
    const box = el('div', { class: 'history-conflict', role: 'alert' },
      el('p', { class: 'history-conflict-message', text: conflictMessage(error, action) }));
    const blocking = Array.isArray(error.blocking) ? error.blocking : [];
    if (blocking.length) box.append(el('ul', { class: 'history-blockers' }, ...blocking.map(blockerItem)));
    if (retry) {
      const again = el('button', { type: 'button', class: 'editor-btn history-conflict-retry', text: 'Try again' });
      again.addEventListener('click', retry);
      box.append(again);
    }
    area.replaceChildren(box);
    area.hidden = false;
  }

  function blockerItem(blocker) {
    const action = blocker.action === 'restore' ? 'restore' : 'revert';
    const { label } = ACTIONS[action];
    const linkId = uniqueId('history-blocker');
    const link = el('button', {
      type: 'button', class: 'editor-btn-link history-blocker-link', id: linkId,
      text: `${label}: ${blocker.summary || `change ${blocker.id}`}`
    });
    const when = blocker.createdAt ? relativeTime(blocker.createdAt, now()) : '';
    const meta = el('span', { class: 'history-blocker-meta', text: [blocker.authorName, when].filter(Boolean).join(' · ') });
    const button = el('button', { type: 'button', class: 'editor-btn history-blocker-action', text: label, 'aria-describedby': linkId });
    const note = el('div', { class: 'history-blocker-message', hidden: true });
    const item = el('li', { class: 'history-blocker' }, link, meta, button, note);

    link.addEventListener('click', () => findChange(blocker.id, note));
    button.addEventListener('click', async () => {
      const change = await perform(blocker.id, action, { button, area: note });
      if (!change) return;
      item.classList.add('history-blocker-done');
      button.hidden = true;
      note.replaceChildren(el('p', { class: 'history-blocker-done-text', text: 'Done.' }));
      note.hidden = false;
      keepFocusInside(dialog.dialog, item.closest('.history-conflict')?.querySelector('.history-conflict-retry'));
    });
    return item;
  }

  /** Scrolls to change `id` and highlights it, loading older pages to find it; says so in `note` if it can't. */
  async function findChange(id, note) {
    clearArea(note);
    for (let pages = 0; !entries.has(key(id)) && !done && pages < MAX_FIND_PAGES && dialog.isOpen(); pages++) {
      await loadMore();
      if (loadError) break;
    }
    if (!dialog.isOpen()) return;
    const entry = entries.get(key(id));
    if (!entry) {
      let text = "That change isn't in this list.";
      if (loadError) text = "Couldn't load enough of the history to find that change.";
      else if (filter) text = "That change isn't in this list. Show all changes to look for it.";
      else if (!done) text = "That change isn't in this list: it's too far back.";
      note.replaceChildren(el('p', { class: 'history-blocker-note', text }));
      note.hidden = false;
      return;
    }
    for (const other of list.querySelectorAll('.history-entry-highlight')) other.classList.remove('history-entry-highlight');
    entry.element.classList.add('history-entry-highlight');
    entry.element.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    const target = entry.actionButton && !entry.actionButton.disabled ? entry.actionButton : entry.element;
    target.focus({ preventScroll: true });
  }

  // --- Open and close --------------------------------------------------------------------------------------

  function close() {
    if (!dialog.isOpen()) return;
    observer?.disconnect();
    dialog.close();
  }

  if (conflict) {
    showConflict(notice, conflict);
    notice.hidden = false;
  }
  renderFilter();
  loadMore();
  dialog.dialog.focus();

  return { close, isOpen: dialog.isOpen, element: dialog.dialog };
}
