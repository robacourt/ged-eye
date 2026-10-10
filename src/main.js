import { FamilyTreeView } from './familyTreeView.js';
import { PersonDetails } from './personDetails.js';
import * as dataLoader from './dataLoader.js';
import { PersonNotFoundError } from './dataLoader.js';
import * as authModule from './auth.js';
import * as editApi from './editApi.js';
import { mountSignIn as defaultMountSignIn } from './signIn.js';
import { showToast as defaultShowToast } from './toast.js';
import { conflictMessage, toggleErrorMessage } from './changeMessages.js';
import { escapeHtml } from './html.js';
import './editorStyles.css';

export const DEFAULT_PERSON_ID = 'I122';
const SLOW_LOAD_MS = 300;
const EDITOR_ROLES = new Set(['editor', 'admin']);
const CONFLICT_TOAST_MS = 15_000;
const EDITING_UNAVAILABLE = "Couldn't load the editing tools. Check your connection, then reload the page.";

/** The editors' dialogs, History, Editors and the photo dialogs, with their stylesheet: loaded only once someone can edit. */
const defaultLoadEditing = () => import('./editing.js');

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

/** Whether the server refused a call because the signed-in account is not (or no longer) on the editors list. */
const isNotAnEditor = (error) => error?.status === 403 && error.code === 'not_an_editor';

/** The editApi.js calls whose refusals are watched: all but `me`, which reads the account itself. */
export const WATCHED_API_CALLS = ['authedFetch', 'runChange', 'revert', 'restore', 'undo', 'redo', 'listChanges',
  'search', 'listEditors', 'addEditor', 'removeEditor'];

/**
 * `api` with its calls watched: a rejection that is a 403 `not_an_editor` is reported to `onNotAnEditor`
 * (the editor was removed since /me was read), and still thrown to the caller, who words it as usual.
 */
function watchNotAnEditor(api, onNotAnEditor) {
  const watched = { ...api };
  for (const name of WATCHED_API_CALLS) {
    const call = api[name];
    if (typeof call !== 'function') continue;
    watched[name] = async (...args) => {
      try {
        return await call(...args);
      } catch (error) {
        if (isNotAnEditor(error)) onNotAnEditor();
        throw error;
      }
    };
  }
  return watched;
}

/** Logs a failure of work nobody waits for (a re-render after a change), instead of leaving it unhandled. */
const settle = (promise) => Promise.resolve(promise).catch(error => console.error('Could not show the change', error));

/**
 * The letter a key types: the layout's own letter when it is Latin (so QWERTZ's Z is Z), else, for layouts
 * such as Cyrillic or Greek, the letter at that position on a US keyboard (`event.code`).
 */
function letterOf(event) {
  const key = typeof event.key === 'string' ? event.key.toLowerCase() : '';
  if (/^[a-z]$/.test(key)) return key;
  const match = /^Key([A-Z])$/.exec(event.code ?? '');
  return match ? match[1].toLowerCase() : key;
}

/** 'undo' for Ctrl/Cmd+Z, 'redo' for Ctrl/Cmd+Shift+Z or Ctrl+Y, else null. */
export function shortcutFor(event) {
  if (event.altKey || !(event.ctrlKey || event.metaKey)) return null;
  const letter = letterOf(event);
  if (letter === 'z') return event.shiftKey ? 'redo' : 'undo';
  if (letter === 'y' && event.ctrlKey && !event.metaKey && !event.shiftKey) return 'redo';
  return null;
}

/** Whether keys pressed in `element` are typing: a form field, or editable text (where Ctrl+Z is the browser's). */
function isTyping(element) {
  if (!(element instanceof Element)) return false;
  return Boolean(element.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) ||
    element.isContentEditable === true;
}

const isPhotoViewerOpen = () => Boolean(document.querySelector('.photo-viewer.photo-viewer-open'));

/**
 * Starts the app: the tree, the details panel, sign-in, and for editors the editing dialogs and Undo/Redo.
 * Everything it uses can be passed in (the tests do); by default the real modules are used.
 * `loadEditing` resolves to the editing UI (editing.js): `{ openPersonEditor, openFamilyEditor,
 * openRelativeDialog, openUnlinkConfirm, openHistoryPanel, openEditorsDialog, isEditorDialogOpen,
 * openAddPhotosDialog, openAvatarDialog, openPhotoEditDialog, mediaApi, commandErrorMessage, removePhotoParams }`.
 * @returns `{ showPerson, destroy }`
 */
export function initApp({
  treeView = new FamilyTreeView(document.getElementById('cy')),
  personDetails = new PersonDetails(document.getElementById('details')),
  auth = authModule,
  api: apiModule = editApi,
  loader = dataLoader,
  showToast = defaultShowToast,
  mountSignIn = defaultMountSignIn,
  loadEditing = defaultLoadEditing
} = {}) {
  const loadingEl = document.getElementById('loading');

  // Calls to the API from here and from the editing dialogs. An editor who has been removed since signing in
  // learns it from the first refusal: the account is read again, which takes the edit controls away.
  const api = watchNotAnEditor(apiModule, () => {
    if (canEdit()) signIn.refreshAccount(); // never rejects: a failure shows in the account menu
  });

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
  let settledRequest = 0; // the last showPerson request that finished
  let requestedPersonId = null;
  let shown = null;       // { person, relationships } in the details panel
  let account = null;     // /me: { email, name, role }, while signed in
  let editing = null;     // the editing UI, once loaded
  let editingLoad = null; // Promise of it, while loading (or loaded)
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
      if (isCurrent()) settledRequest = request;
    }
  }

  /** Shows the person in the URL again, with fresh data (after a change, a sign-in or a sign-out). */
  const showCurrentPerson = () => settle(showPerson(personIdFromUrl()));

  function navigateTo(personId) {
    if (personId === personIdFromUrl()) return showCurrentPerson();
    setUrlPerson(personId);
    return settle(showPerson(personId));
  }

  // --- The editing UI, loaded on demand ----------------------------------------------------------------------

  /** Loads the editing UI (once), then shows the edit controls on the person already on screen. */
  function ensureEditing() {
    editingLoad ??= Promise.resolve()
      .then(() => loadEditing())
      .then(
        (module) => {
          editing = module;
          // A person load still running renders with the controls when it finishes.
          if (canEdit() && shown && settledRequest === currentRequest) {
            personDetails.showPerson(shown.person, shown.relationships, detailsOptions());
          }
          return module;
        },
        (error) => {
          editingLoad = null; // a failed chunk load can be tried again
          throw error;
        });
    return editingLoad;
  }

  /** For someone who can now edit: loads the editing UI, which then shows the edit controls. */
  function prepareEditing() {
    if (editing) return;
    ensureEditing().catch((error) => {
      console.error('Could not load the editing UI', error);
      showToast(EDITING_UNAVAILABLE, { kind: 'error' });
    });
  }

  /** The editing UI for a dialog someone asked for, or null (and a toast) when it can't be loaded. */
  async function editingFor() {
    try {
      return await ensureEditing();
    } catch (error) {
      console.error('Could not load the editing UI', error);
      showToast(EDITING_UNAVAILABLE, { kind: 'error' });
      return null;
    }
  }

  // --- The details panel's edit controls (only once the editing UI is loaded) --------------------------------

  /**
   * The details panel's options: for everyone, onOpenPerson (the photo viewer's "Shown for" links); for editors,
   * once the editing UI is here, the edit controls. The photo hooks open their dialogs synchronously: Add photos
   * opens the file picker from inside the tap, which iOS requires. The viewer has closed itself before calling
   * onEditPhoto, onUseAsAvatar or onRemovePhoto.
   */
  function detailsOptions() {
    if (!canEdit() || !editing) return { canEdit: false, onOpenPerson: navigateTo };
    return {
      canEdit: true,
      onOpenPerson: navigateTo,
      onEdit: editPerson,
      onAddRelative: (relation, person) => editing.openRelativeDialog({
        person, relationships: shown?.relationships ?? null, relation, api, loader,
        onAdded: (result) => afterCommand(result, person.id), onReloaded
      }),
      onUnlink: ({ relation, personId, familyId }, person) => editing.openUnlinkConfirm({
        person, relationships: shown?.relationships ?? null, relation, personId, familyId, api, loader,
        onUnlinked: (result) => afterCommand(result, person.id), onReloaded
      }),
      onEditFamily: (family, person) => editing.openFamilyEditor({
        family, api, focusId: person.id, loader, onSaved: (result) => afterCommand(result, person.id), onReloaded
      }),
      onShowHistory: (person) => openHistory({ id: person.id, name: person.name }),
      onAddPhotos: (person, files) => editing.openAddPhotosDialog({
        person, files, api, mediaApi: editing.mediaApi, onSaved: (result) => afterCommand(result, person.id)
      }),
      onChangeAvatar: (person) => editing.openAvatarDialog({
        person, api, mediaApi: editing.mediaApi, onSaved: (result) => afterCommand(result, person.id)
      }),
      // onSaved(null) is the photo editor's Reload, after someone else changed or removed the photo.
      onEditPhoto: (photo, person) => editing.openPhotoEditDialog({
        photo, person, api,
        onSaved: (result) => (result ? afterCommand(result, person.id) : settle(afterChange({}, { from: person.id })))
      }),
      onUseAsAvatar: (photo, person) => editing.openAvatarDialog({
        person, api, mediaApi: editing.mediaApi, startWith: photo, onSaved: (result) => afterCommand(result, person.id)
      }),
      onRemovePhoto: (photo, person) => settle(removePhoto(photo, person))
    };
  }

  /**
   * The viewer's Remove, already confirmed: sends remove_photo, then shows the result with Undo. There is no
   * dialog to show a failure in, so failures are toasts; a photo someone else already removed reloads the person.
   */
  async function removePhoto(photo, person) {
    let result;
    try {
      result = await api.runChange('remove_photo', editing.removePhotoParams(person.id, photo));
    } catch (error) {
      const stale = error?.code === 'stale';
      if (!stale && (error?.name !== 'ApiError' || error.status >= 500)) console.error('Could not remove the photo', error);
      showToast(stale ? 'That photo was already removed. Reloading.' : editing.commandErrorMessage(error), { kind: 'error' });
      if (stale) await afterChange({}, { from: person.id });
      return;
    }
    afterCommand(result, person.id);
  }

  async function editPerson(person) {
    // The cached view says whether its notes were masked; the editor reloads the person when it can't tell.
    let view = null;
    try {
      view = await loader.loadPersonWithFamily(person.id);
    } catch (error) {
      console.warn('Could not read the person to edit from the cache', error);
    }
    const done = (result) => afterCommand(result, person.id);
    editing.openPersonEditor({
      person: view?.person ?? person, masked: view?.masked, api, loader, onSaved: done, onDeleted: done, onReloaded
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
   * After any change: forget every cached view, and bring an open History up to date. Then, if the person
   * `from` (on screen when the change was asked for) is still in the URL, show the command's `view`, or that
   * person again; if they no longer exist (deleted, or an undone add), the change's first person who still
   * does, else the default person, in place of the current URL entry. Someone who went elsewhere meanwhile
   * (Back during a save) is left where they are.
   */
  async function afterChange({ change = null, view = null } = {}, { from = personIdFromUrl(), refreshHistory = true } = {}) {
    loader.invalidateAll();
    if (view) loader.cacheView(view);
    if (refreshHistory && historyPanel?.isOpen()) settle(historyPanel.refresh?.({ change }));
    const current = personIdFromUrl();
    if (current !== from) return;
    const candidates = view?.person?.id ? [view.person.id] : [current, ...(change?.personIds ?? [])];
    const target = await firstLoadable([...new Set(candidates)]);
    if (personIdFromUrl() !== current) return; // they went elsewhere meanwhile, which loads afresh anyway
    if (target !== current) setUrlPerson(target, { replace: true });
    await showPerson(target);
  }

  /** After an editor's command (`{ change, view }`) on person `from`: show the result and offer Undo. */
  function afterCommand(result, from) {
    if (!result?.change) return;
    settle(afterChange(result, { from }));
    showToast(result.change.summary, { action: { label: 'Undo', onClick: () => undoChange(result.change) } });
  }

  /**
   * Runs an undo, redo or revert, then shows its result; `nothing` is said when there was nothing to do.
   * `action` is 'revert' (an undo) or 'restore' (a redo), for the words of a refusal.
   */
  async function runToggle(call, { action = 'revert', nothing = null } = {}) {
    const from = personIdFromUrl();
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
    await afterChange({ change }, { from });
  }

  /** The toast's Undo: reverts that very change, as a keyboard undo (so Redo can bring it back). */
  const undoChange = (change) => settle(runToggle(() => api.revert(change.id, 'keyboard')));

  function reportToggleError(error, action) {
    dropQueuedKeys(); // presses queued behind this one would only fail the same way
    if (error?.code === 'conflict') {
      showToast(conflictMessage(error, action), {
        kind: 'error',
        timeout: CONFLICT_TOAST_MS,
        action: { label: 'Open History', onClick: () => openHistory(null, { conflict: error, conflictAction: action }) }
      });
      return;
    }
    if (error?.name !== 'ApiError' || error.status >= 500) console.error('Undo or redo failed', error);
    showToast(toggleErrorMessage(error), { kind: 'error' });
    if (error?.code === 'wrong_state') settle(afterChange());
  }

  // --- History and Editors -----------------------------------------------------------------------------------

  async function openHistory(personFilter = null, { conflict = null, conflictAction = 'revert' } = {}) {
    if (!canEdit()) return;
    const module = await editingFor();
    if (!module || !canEdit()) return;
    historyPanel?.close();
    historyPanel = module.openHistoryPanel({
      api, personFilter, conflict, conflictAction,
      onOpenPerson: navigateTo,
      // The panel has refreshed itself and toasted the summary.
      onChanged: ({ change }) => settle(afterChange({ change }, { refreshHistory: false }))
    });
  }

  async function openEditors() {
    if (account?.role !== 'admin') return;
    const module = await editingFor();
    if (!module || account?.role !== 'admin') return;
    editorsDialog?.close();
    editorsDialog = module.openEditorsDialog({ api, currentEmail: account.email ?? null });
  }

  // --- Keyboard Undo and Redo ----------------------------------------------------------------------------------

  let keyQueue = Promise.resolve();
  let keyEpoch = 0; // bumped to drop the presses still queued

  function dropQueuedKeys() {
    keyEpoch++;
  }

  function onKeyDown(event) {
    const action = shortcutFor(event);
    if (!action || event.defaultPrevented || event.repeat || !canEdit() || !editing) return;
    if (isTyping(event.target) || isTyping(document.activeElement)) return;
    if (editing.isEditorDialogOpen() || signIn.isOpen() || isPhotoViewerOpen()) return;
    event.preventDefault();
    const epoch = keyEpoch;
    // One at a time, so each toast and re-render follows its own press.
    keyQueue = keyQueue
      .then(() => {
        if (epoch !== keyEpoch || !canEdit()) return undefined;
        return action === 'undo'
          ? runToggle(() => api.undo(), { nothing: 'Nothing to undo' })
          : runToggle(() => api.redo(), { action: 'restore', nothing: 'Nothing to redo' });
      })
      .catch(error => console.error('Undo or redo failed', error));
  }

  // --- Sign-in -------------------------------------------------------------------------------------------------

  const signIn = mountSignIn({
    container: document.getElementById('app') ?? document.body,
    auth,
    api: apiModule,
    onSignedIn(me) {
      account = me;
      if (!canEdit()) {
        // Signed in without editing access, or an editor who has been removed since (see watchNotAnEditor).
        dropQueuedKeys();
        historyPanel?.close();
        editorsDialog?.close();
      }
      loader.invalidateAll();
      showCurrentPerson();
      if (canEdit()) prepareEditing();
    },
    onSignedOut() {
      account = null;
      dropQueuedKeys();
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
      dropQueuedKeys();
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
