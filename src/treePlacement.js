/**
 * Where the tree puts an editor's "+" node, and how it fits the tree to the screen (familyTreeView.js): pure
 * functions of positions and sizes, so they can be tested without drawing.
 */

/** The smallest the button over the "+" node gets, at any zoom: a comfortable touch target. */
export const MIN_TARGET_PX = 44;
/** The space between the "+" node and the person beside it, and between it and the next node in their row. */
const ADD_GAP = 40;
/** On a tree wider than the screen, the selected person's distance from the left (fitToHeight). */
const SELECTED_LEFT_PX = 100;
/** The least room left of a "+" button placed on the person's left, on a tree wider than the screen. */
const ADD_LEFT_MIN_PX = 16;
/** How far an editor's tree may zoom out to fit the width, as a share of the zoom that fits the height. */
const ADD_MIN_ZOOM_SHARE = 0.75;

/**
 * Where the "+" node goes, beside the selected person in their row (graph units): on their left when they have
 * spouses and none is on their left, so it never sits between a couple; else on their right. The nodes of the
 * row on that side move outward to make room.
 * @param selected  `{ x, y, width }`: the selected person's centre and outer width
 * @param addWidth  the "+" node's outer width
 * @param spouseXs  the x of each spouse (the nodes sharing a partnership node with them)
 * @param row       `[{ id, x }]`: the other nodes in their row
 * @returns `{ add: { x, y }, moves: [{ id, x }] }`
 */
export function placeBeside({ selected, addWidth, spouseXs = [], row = [] }) {
  const side = spouseXs.length > 0 && !spouseXs.some(x => x < selected.x) ? -1 : 1;
  const add = { x: selected.x + side * (selected.width / 2 + ADD_GAP + addWidth / 2), y: selected.y };
  const shift = side * (addWidth + ADD_GAP);
  const moves = row.filter(node => (node.x - selected.x) * side > 0).map(node => ({ id: node.id, x: node.x + shift }));
  return { add, moves };
}

/**
 * The tree's zoom (fitToHeight): the zoom that fits the height `height` inside `margin`, at most `maxZoom`.
 * An editor's tree (`hasAdd`: with the "+" node, which widens the person's row) wider than `width` inside the
 * same margin at that zoom zooms out just enough to fit, but never below ADD_MIN_ZOOM_SHARE of it.
 * Viewers' trees are as they always were.
 */
export function chooseZoom({ bb, width, height, margin, maxZoom, hasAdd = false }) {
  const heightZoom = Math.min((height - 2 * margin) / bb.h, maxZoom);
  const fitWidth = width - 2 * margin; // the same room for "fits" as for the zoom, so the result changes smoothly
  if (!hasAdd || bb.w * heightZoom <= fitWidth) return heightZoom;
  return Math.min(heightZoom, Math.max(fitWidth / bb.w, ADD_MIN_ZOOM_SHARE * heightZoom));
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
