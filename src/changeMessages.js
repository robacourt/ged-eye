/**
 * Words for a refused or failed revert, restore, undo or redo. Shared by the History panel and main.js's
 * keyboard Undo/Redo, so main.js needn't load the History panel to say what went wrong.
 */

const GENERIC_ERROR = 'Something went wrong. Try again.';

/** For a 403: the account is not (or no longer) on the editors list. Also used by editorDialog.js and uploadMessages.js. */
export const NOT_AN_EDITOR_MESSAGE = `You're not on the editors list. Use "Request edit access" in your account menu.`;

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
  if (error.status === 403) return NOT_AN_EDITOR_MESSAGE;
  if (error.code === 'conflict') return conflictMessage(error);
  if (error.code === 'wrong_state') return 'Someone else has already undone or restored that change.';
  if (error.code === 'not_found') return "Couldn't find that change.";
  if (error.name === 'ApiError' || error.status) return `The server had a problem (${error.code}). Try again.`;
  return error.message || GENERIC_ERROR;
}
