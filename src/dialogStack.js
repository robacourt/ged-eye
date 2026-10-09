/**
 * Which open modal is on top. Every modal sits in an `.editor-dialog-backdrop`; the topmost visible one, by
 * z-index and then document order (later is higher), is the one that handles Escape and Tab. signIn.js
 * applies the same rule to its own dialog, so the two never both act on one key.
 */

/** The visible dialog backdrops, bottom to top. */
export function openDialogBackdrops() {
  const zIndex = (element) => Number.parseInt(getComputedStyle(element).zIndex, 10) || 0;
  return [...document.querySelectorAll('.editor-dialog-backdrop')]
    .filter(element => !element.closest('[hidden]'))
    .map((element, order) => ({ element, order, z: zIndex(element) }))
    .sort((a, b) => a.z - b.z || a.order - b.order)
    .map(({ element }) => element);
}

/** Whether `backdrop` is the topmost visible dialog backdrop. */
export function isTopmostDialog(backdrop) {
  const open = openDialogBackdrops();
  return open.length > 0 && open[open.length - 1] === backdrop;
}
