import { FamilyTreeView } from './familyTreeView.js';
import { PersonDetails } from './personDetails.js';
import * as dataLoader from './dataLoader.js';
import { PersonNotFoundError } from './dataLoader.js';
import * as authModule from './auth.js';
import * as editApi from './editApi.js';
import { mountSignIn as defaultMountSignIn } from './signIn.js';
import { showToast as defaultShowToast } from './toast.js';
import { openHistoryPanel, conflictMessage, toggleErrorMessage } from './historyPanel.js';
import { openEditorsDialog } from './editorsDialog.js';
import { openPersonEditor } from './personEditor.js';
import { openFamilyEditor } from './familyEditor.js';
import { openRelativeDialog } from './relativeDialog.js';
import { openUnlinkConfirm } from './unlinkConfirm.js';
import { isEditorDialogOpen } from './editorDialog.js';
import { escapeHtml } from './html.js';
import './editorStyles.css';

export const DEFAULT_PERSON_ID = 'I122';
const SLOW_LOAD_MS = 300;
const EDITOR_ROLES = new Set(['editor', 'admin']);
const CONFLICT_TOAST_MS = 15_000;

const DEFAULT_DIALOGS = {
  openHistoryPanel, openEditorsDialog, openPersonEditor, openFamilyEditor, openRelativeDialog, openUnlinkConfirm,
  isEditorDialogOpen
};

function personIdFromUrl() {
  return new URLSearchParams(window.location.search).get('person') || DEFAULT_PERSON_ID;
}

/** Puts `personId` in the URL: a new history entry, or in place of the current one (`replace`). */
function setUrlPerson(personId, { replace = false } = {}) {
  const url = new URL(window.location);
  url.searchParams.set('person', personId);
  if (replace) window.history.replaceState({}, '', url);
  else window.history.pushState({}, '', url);
}

const isNotFound = (error) => error instanceof PersonNotFoundError || error?.name === 'PersonNotFoundError';

/** 'undo' for Ctrl/Cmd+Z, 'redo' for Ctrl/Cmd+Shift+Z or Ctrl+Y, else null. */
export function shortcutFor(event) {
  if (event.altKey || !(event.ctrlKey || event.metaKey)) return null;
  const key = event.key?.toLowerCase();
  if (key === 'z') return event.shiftKey ? 'redo' : 'undo';
  if (key === 'y' && event.ctrlKey && !event.metaKey && !event.shiftKey) return 'redo';
  return null;
}

/** Whether keys pressed in `element` are typing: a form field, or editable text (where Ctrl+Z is the browser's). */
function isTyping(element) {
  if (!(element instanceof Element)) return false;
  return Boolean(element.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) ||
    element.isContentEditable === true;
}

/**
 * Starts the app: the tree, the details panel, sign-in, and for editors the editing dialogs and Undo/Redo.
 * Everything it uses can be passed in (the tests do); by default the real modules are used.
 * @returns `{ showPerson, destroy }`
 */
export function initApp({
  treeView = new FamilyTreeView(document.getElementById('cy')),
  personDetails = new PersonDetails(document.getElementById('details')),
  auth = authModule,
  api = editApi,
  loader = dataLoader,
  showToast = defaultShowToast,
  mountSignIn = defaultMountSignIn,
  dialogs: dialogOverrides = {}
} = {}) {
  const dialogs = { ...DEFAULT_DIALOGS, ...dialogOverrides };
  const loadingEl = document.getElementById('loading');

  const overlay = {
    hide() {
      loadingEl.classList.add('hidden');
      loadingEl.classList.remove('interactive');
    },
    loading(text = 'Loading...') {
      loadingEl.textContent = text;
      loadingEl.classList.remove('hidden', 'interactive');
    },
    message(html) {
      loadingEl.innerHTML = html;
      loadingEl.classList.remove('hidden');
      loadingEl.classList.add('interactive');
    }
  };

  let currentRequest = 0;
  let requestedPersonId = null;
  let shown = null;    // { person, relationships } in the details panel
  let account = null;  // /me: { email, name, role }, while signed in
  let historyPanel = null;
  let editorsDialog = null;

  const canEdit = () => EDITOR_ROLES.has(account?.role);

  async function showPerson(personId) {
    const request = ++currentRequest;
    const isCurrent = () => request === currentRequest;
    requestedPersonId = personId;
    // Don't leave a stale error/message panel on top of the new load.
    if (loadingEl.classList.contains('interactive')) overlay.loading();
    const slowTimer = setTimeout(() => {
      if (isCurrent() && loadingEl.classList.contains('hidden')) overlay.loading();
    }, SLOW_LOAD_MS);
    try {
      const result = await treeView.loadPerson(personId);
      if (!result || !isCurrent()) return; // superseded by a newer selection
      shown = result;
      personDetails.showPerson(result.person, result.relationships, detailsOptions());
      overlay.hide();
    } catch (error) {
      if (!isCurrent()) return;
      requestedPersonId = null; // allow tapping the same person again to retry
      console.error('Failed to load person', personId, error);
      if (isNotFound(error)) {
        overlay.message(`<p>Person not found.</p><p><a href="?person=${DEFAULT_PERSON_ID}">Go to the start of the tree</a></p>`);
      } else {
        overlay.message(`<p>Couldn't load this person.</p><p class="loading-error-detail">${escapeHtml(error.message)}</p><button type="button" class="loading-retry">Retry</button>`);
        loadingEl.querySelector('.loading-retry').addEventListener('click', () => {
          overlay.loading();
          showPerson(personId);
        });
      }
    } finally {
      clearTimeout(slowTimer);
    }
  }

  /** Shows the person in the URL again, with fresh data (after a change, a sign-in or a sign-out). */
  const showCurrentPerson = () => showPerson(personIdFromUrl());

  function navigateTo(personId) {
    if (personId === personIdFromUrl()) return showCurrentPerson();
    setUrlPerson(personId);
    return showPerson(personId);
  }

  // --- The details panel's edit controls ---------------------------------------------------------------------

  function detailsOptions() {
    if (!canEdit()) return { canEdit: false };
    return {
      canEdit: true,
      onEdit: editPerson,
      onAddRelative: (relation, person) => dialogs.openRelativeDialog({
        person, relationships: shown?.relationships ?? null, relation, api, loader, onAdded: afterCommand, onReloaded
      }),
      onUnlink: ({ relation, personId, familyId }, person) => dialogs.openUnlinkConfirm({
        person, relationships: shown?.relationships ?? null, relation, personId, familyId, api, loader,
        onUnlinked: afterCommand, onReloaded
      }),
      onEditFamily: (family, person) => dialogs.openFamilyEditor({
        family, api, focusId: person.id, loader, onSaved: afterCommand, onReloaded
      }),
      onShowHistory: (person) => openHistory({ id: person.id, name: person.name })
    };
  }

  async function editPerson(person) {
    // The cached view says whether its notes were masked; the editor reloads the person when it can't tell.
    let view = null;
    try {
      view = await loader.loadPersonWithFamily(person.id);
    } catch (error) {
      console.warn('Could not read the person to edit from the cache', error);
    }
    dialogs.openPersonEditor({
      person: view?.person ?? person, masked: view?.masked, api, loader,
      onSaved: afterCommand, onDeleted: afterCommand, onReloaded
    });
  }

  /** An editor reloaded a person (from "Reload this person"): show the fresh data if they're on screen. */
  function onReloaded(fresh) {
    if (fresh?.person?.id === personIdFromUrl()) showCurrentPerson();
  }

  // --- After a change ----------------------------------------------------------------------------------------

  /** The first of `ids` who can be loaded (a load failing for another reason counts), else the default person. */
  async function firstLoadable(ids) {
    for (const id of ids) {
      try {
        await loader.loadPersonWithFamily(id);
        return id;
      } catch (error) {
        if (!isNotFound(error)) return id; // showPerson reports it, with Retry
      }
    }
    return DEFAULT_PERSON_ID;
  }

  /**
   * After any change: forget every cached view, then show the command's `view`, or the current person again.
   * If they no longer exist (deleted, or an undone add), show the change's first person who still does, else
   * the default person, in place of the current URL.
   */
  async function afterChange({ change = null, view = null } = {}) {
    loader.invalidateAll();
    if (view) loader.cacheView(view);
    const current = personIdFromUrl();
    const candidates = view?.person?.id ? [view.person.id] : [current, ...(change?.personIds ?? [])];
    const target = await firstLoadable([...new Set(candidates)]);
    if (personIdFromUrl() !== current) return; // they went elsewhere meanwhile, which loads afresh anyway
    if (target !== current) setUrlPerson(target, { replace: true });
    await showPerson(target);
  }

  /** After an editor's command (`{ change, view }`): show the result and offer Undo. */
  function afterCommand(result) {
    if (!result?.change) return;
    afterChange(result);
    showToast(result.change.summary, { action: { label: 'Undo', onClick: () => undoChange(result.change) } });
  }

  /**
   * Runs an undo, redo or revert, then shows its result; `nothing` is said when there was nothing to do.
   * `action` is 'revert' (an undo) or 'restore' (a redo), for the words of a refusal.
   */
  async function runToggle(call, { action = 'revert', nothing = null } = {}) {
    let change;
    try {
      change = await call();
    } catch (error) {
      reportToggleError(error, action);
      return;
    }
    if (!change) {
      if (nothing) showToast(nothing);
      return;
    }
    showToast(change.summary);
    await afterChange({ change });
  }

  /** The toast's Undo: reverts that very change, as a keyboard undo (so Redo can bring it back). */
  const undoChange = (change) => runToggle(() => api.revert(change.id, 'keyboard'));

  function reportToggleError(error, action) {
    if (error?.code === 'conflict') {
      showToast(conflictMessage(error, action), {
        kind: 'error',
        timeout: CONFLICT_TOAST_MS,
        action: { label: 'Open History', onClick: () => openHistory(null, { conflict: error }) }
      });
      return;
    }
    if (error?.name !== 'ApiError' || error.status >= 500) console.error('Undo or redo failed', error);
    showToast(toggleErrorMessage(error), { kind: 'error' });
    if (error?.code === 'wrong_state') afterChange();
  }

  // --- History and Editors -----------------------------------------------------------------------------------

  function openHistory(personFilter = null, { conflict = null } = {}) {
    if (!canEdit()) return;
    historyPanel?.close();
    historyPanel = dialogs.openHistoryPanel({
      api, personFilter, conflict,
      onOpenPerson: navigateTo,
      onChanged: ({ change }) => afterChange({ change })
    });
  }

  function openEditors() {
    editorsDialog?.close();
    editorsDialog = dialogs.openEditorsDialog({ api, currentEmail: account?.email ?? null });
  }

  // --- Keyboard Undo and Redo ----------------------------------------------------------------------------------

  let keyQueue = Promise.resolve();

  function onKeyDown(event) {
    const action = shortcutFor(event);
    if (!action || event.defaultPrevented || event.repeat || !canEdit()) return;
    if (isTyping(event.target) || isTyping(document.activeElement)) return;
    if (dialogs.isEditorDialogOpen() || signIn.isOpen()) return;
    event.preventDefault();
    // One at a time, so each toast and re-render follows its own press.
    keyQueue = keyQueue.then(() => (action === 'undo'
      ? runToggle(() => api.undo(), { nothing: 'Nothing to undo' })
      : runToggle(() => api.redo(), { action: 'restore', nothing: 'Nothing to redo' })));
  }

  // --- Sign-in -------------------------------------------------------------------------------------------------

  const signIn = mountSignIn({
    container: document.getElementById('app') ?? document.body,
    auth,
    api,
    onSignedIn(me) {
      account = me;
      loader.invalidateAll();
      showCurrentPerson();
    },
    onSignedOut() {
      account = null;
      historyPanel?.close();
      editorsDialog?.close();
      loader.invalidateAll();
      showCurrentPerson();
    },
    openHistory: () => openHistory(),
    openEditors
  });

  // --- Start ---------------------------------------------------------------------------------------------------

  treeView.onPersonSelect(personId => {
    if (personId === requestedPersonId) return; // double tap on the person already being shown
    setUrlPerson(personId);
    showPerson(personId);
  });

  const onPopState = () => showPerson(personIdFromUrl());
  window.addEventListener('popstate', onPopState);
  document.addEventListener('keydown', onKeyDown);

  overlay.loading('Loading family tree...');
  showPerson(personIdFromUrl());

  // Viewing doesn't wait for this: signed-in editors get their controls when /me answers (onSignedIn).
  Promise.resolve()
    .then(() => auth.init())
    .catch(error => console.warn('Sign-in is unavailable', error));

  return {
    showPerson,
    destroy() {
      window.removeEventListener('popstate', onPopState);
      document.removeEventListener('keydown', onKeyDown);
      historyPanel?.close();
      editorsDialog?.close();
      signIn.destroy();
    }
  };
}

// index.html loads this module to start the app. Under Vitest (mode 'test') the tests call initApp themselves.
if (import.meta.env.MODE !== 'test') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => initApp());
  } else {
    initApp();
  }
}
