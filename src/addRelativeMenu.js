/**
 * The add-relative menu the tree's "+" button opens (familyTreeView.js): Parent, Spouse, Child and Sibling for
 * one person. A lightweight popover rather than a dialog: it sits by its anchor, outside the dialog stack, and
 * closes on Escape, Tab, a choice or a tap outside, giving focus back to the anchor. It knows nothing of the tree.
 * Styles: editingStyles.css (.add-relative-menu).
 */
import { callSafely, el, uniqueId } from './editorDialog.js';
import { nameOf, relativeBlocked } from './familyLinks.js';

const RELATIONS = [['parent', 'Parent'], ['spouse', 'Spouse'], ['child', 'Child'], ['sibling', 'Sibling']];

/** Space kept between the menu and the viewport's edges, and between the menu and its anchor. */
const MARGIN = 12;
const GAP = 8;

let current = null; // the menu open now, if any: only one at a time

const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));

/**
 * Where the menu goes, in viewport pixels: below the anchor, or above it when there isn't room below but there
 * is above (with neither, as low as fits); centred on the anchor and clamped inside the viewport, MARGIN from
 * each edge (a menu wider than the viewport keeps to the left margin).
 * @param anchor    the anchor's rectangle `{ left, top, right, bottom }`
 * @param menu      the menu's size `{ width, height }`
 * @param viewport  `{ width, height }`
 * @returns `{ left, top, placement: 'below' | 'above' }`
 */
export function placeMenu(anchor, menu, viewport) {
  const below = anchor.bottom + GAP;
  const above = anchor.top - GAP - menu.height;
  const fitsBelow = below + menu.height <= viewport.height - MARGIN;
  const fitsAbove = above >= MARGIN;
  const placement = !fitsBelow && fitsAbove ? 'above' : 'below';
  let top = placement === 'above' ? above : below;
  if (!fitsBelow && !fitsAbove) top = clamp(below, MARGIN, viewport.height - MARGIN - menu.height);
  const left = clamp((anchor.left + anchor.right) / 2 - menu.width / 2, MARGIN, viewport.width - MARGIN - menu.width);
  return { left, top, placement };
}

/**
 * Opens the menu for `person` by `anchor` (the button that opened it). A relation relativeBlocked() refuses,
 * as the details panel's buttons do, is shown disabled with its reason. A tap on the anchor is left to the
 * anchor, which closes the menu itself.
 * @param anchor    the button that opened it: it gets aria-expanded, and focus back when the menu closes
 * @param person    the person record a relative is added to
 * @param onChoose  (relation) 'parent' | 'spouse' | 'child' | 'sibling', called once the menu has closed
 * @returns `{ close, isOpen }`
 */
export function openAddRelativeMenu({ anchor, person, onChoose }) {
  current?.close();

  const id = uniqueId('add-relative-menu');
  const items = RELATIONS.map(([relation, text]) => {
    const blocked = relativeBlocked(person, relation);
    const labelId = `${id}-${relation}`;
    return el('div', {
      class: 'add-relative-menu-item', role: 'menuitem', tabindex: '-1', 'data-relation': relation,
      'aria-labelledby': labelId, 'aria-disabled': blocked ? 'true' : null, 'aria-describedby': blocked ? `${labelId}-reason` : null
    },
    el('span', { class: 'add-relative-menu-label', id: labelId, text }),
    blocked ? el('span', { class: 'add-relative-menu-reason', id: `${labelId}-reason`, text: blocked }) : null);
  });
  const title = el('div', { class: 'add-relative-menu-title', id: `${id}-title`, text: `Add a relative to ${nameOf(person)}` });
  const list = el('div', { class: 'add-relative-menu-items', role: 'menu', id, 'aria-labelledby': `${id}-title` }, ...items);
  // tabindex -1: a press on the menu between its items keeps focus (and so the keys) in the menu.
  const popover = el('div', { class: 'add-relative-menu', tabindex: '-1' }, title, list);

  let open = true;
  const handle = { close, isOpen: () => open && popover.isConnected };
  const isBlocked = (item) => item.getAttribute('aria-disabled') === 'true';

  function place() {
    const { left, top, placement } = placeMenu(anchor.getBoundingClientRect(), popover.getBoundingClientRect(),
      { width: window.innerWidth, height: window.innerHeight });
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
    popover.dataset.placement = placement;
  }

  function close() {
    if (!open) return;
    open = false;
    if (current === handle) current = null;
    document.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('resize', place);
    anchor.removeEventListener('keydown', onAnchorKeyDown);
    const hadFocus = popover.contains(document.activeElement);
    popover.remove();
    anchor.setAttribute('aria-expanded', 'false');
    anchor.removeAttribute('aria-controls');
    if (hadFocus && anchor.isConnected && !anchor.closest('[hidden]')) anchor.focus();
  }

  function choose(item) {
    if (!item || isBlocked(item)) return;
    close(); // first, so a dialog opened by onChoose gives focus back to the anchor when it closes
    callSafely(onChoose, item.dataset.relation);
  }

  function focusItem(index) {
    items[(index + items.length) % items.length].focus();
  }

  function onKeyDown(event) {
    const index = items.indexOf(event.target.closest?.('[role="menuitem"]'));
    switch (event.key) {
      case 'ArrowDown': focusItem(index + 1); break;
      case 'ArrowUp': focusItem(index < 0 ? -1 : index - 1); break;
      case 'Home': focusItem(0); break;
      case 'End': focusItem(-1); break;
      case 'Enter':
      case ' ':
        if (!event.repeat) choose(items[index]); // a held key that opened the menu mustn't also choose
        break;
      case 'Escape':
        event.stopPropagation(); // this Escape was for the menu only
        close();
        break;
      case 'Tab': close(); break;
      default: return;
    }
    event.preventDefault();
  }

  // Focus can be back on the anchor while the menu is open (pressed, then released off it): Escape still closes.
  function onAnchorKeyDown(event) {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close();
  }

  // Capture phase: the tree's canvas handles its own presses, and a press that starts a pan must close the menu too.
  function onPointerDown(event) {
    if (popover.contains(event.target) || anchor.contains(event.target)) return;
    close();
  }

  popover.addEventListener('keydown', onKeyDown);
  popover.addEventListener('click', (event) => choose(event.target.closest('[role="menuitem"]')));
  anchor.addEventListener('keydown', onAnchorKeyDown);
  document.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('resize', place);

  document.body.appendChild(popover);
  anchor.setAttribute('aria-expanded', 'true');
  anchor.setAttribute('aria-controls', id);
  place();
  current = handle;
  (items.find(item => !isBlocked(item)) ?? items[0]).focus();
  return handle;
}
