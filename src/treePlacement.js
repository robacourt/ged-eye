/**
 * How the tree fits itself to the screen (familyTreeView.js): pure functions of positions and sizes, so they can
 * be tested without drawing. Where everyone goes, the "+" node included, is treeLayout.js.
 */

/** The smallest the button over the "+" node gets, at any zoom: a comfortable touch target. */
export const MIN_TARGET_PX = 44;
/** On a tree wider than the screen, the selected person's distance from the left (fitToHeight). */
const SELECTED_LEFT_PX = 100;
/** The least room left of a "+" button placed on the person's left, on a tree wider than the screen. */
const ADD_LEFT_MIN_PX = 16;
/**
 * The tree's zoom (fitToHeight): the zoom at which `frame` (a full, three-row tree: treeLayout.js FRAME) fits the
 * height `height` inside `margin`, at most `maxZoom`. It depends only on the screen, never on who is shown, so
 * people are always the same size and a wide tree is scrolled sideways rather than shrunk.
 */
export function chooseZoom({ frame, height, margin, maxZoom }) {
  return Math.min((height - 2 * margin) / (frame.bottom - frame.top), maxZoom);
}

/**
 * The tree's vertical pan (fitToHeight): `frame` from `margin` below the top, so the person's row is always in
 * the same place; centred instead when it is shorter than the room (a tall screen, at `maxZoom`).
 */
export function verticalPan({ frame, zoom, height, margin }) {
  const drawn = (frame.bottom - frame.top) * zoom;
  const top = Math.max(margin, (height - drawn) / 2);
  return top - frame.top * zoom;
}

/**
 * The tree's horizontal pan (fitToHeight): centred when it fits the width `width`. A wider tree has the
 * selected person SELECTED_LEFT_PX from the left, and when the "+" node (`add`: `{ x, width }` in graph units)
 * is on their left, is moved right if need be so its button (at least MIN_TARGET_PX) starts ADD_LEFT_MIN_PX in.
 * Without `add` (viewers) it is as it always was.
 */
export function horizontalPan({ bb, zoom, width, selectedX = null, add = null }) {
  const graphWidth = bb.w * zoom;
  if (graphWidth <= width || selectedX === null) return (width - graphWidth) / 2 - bb.x1 * zoom;
  const panX = SELECTED_LEFT_PX - selectedX * zoom;
  if (!add || add.x >= selectedX) return panX;
  const left = add.x * zoom + panX - Math.max(MIN_TARGET_PX, add.width * zoom) / 2;
  return left < ADD_LEFT_MIN_PX ? panX + (ADD_LEFT_MIN_PX - left) : panX;
}
