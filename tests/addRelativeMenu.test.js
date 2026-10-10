import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openAddRelativeMenu, placeMenu } from '../src/addRelativeMenu.js';

const XSS = '<img src=x onerror="window.__xss = 1">';

// A person with one parent: every relation can be added.
const rose = {
  id: 'I7', name: 'Rose Smith', sex: 'F',
  parentFamilies: [{ familyId: 'F1', partnerIds: ['I1'] }], marriages: []
};

let anchor;
let onChoose;
let menu;

function open(person = rose) {
  menu = openAddRelativeMenu({ anchor, person, onChoose });
  return menu;
}

const popover = () => document.querySelector('.add-relative-menu');
const menuElement = () => document.querySelector('[role="menu"]');
const items = () => [...document.querySelectorAll('[role="menuitem"]')];
const item = (text) => items().find(candidate => candidate.querySelector('.add-relative-menu-label').textContent === text);
/** An item's accessible name: the text of the elements its aria-labelledby names. */
const nameOf = (element) => element.getAttribute('aria-labelledby').split(' ')
  .map(id => document.getElementById(id).textContent).join(' ');
const descriptionOf = (element) => document.getElementById(element.getAttribute('aria-describedby'))?.textContent;

/** Presses a key on the focused element (default) and resolves to the event. */
function press(key, target = document.activeElement, modifiers = {}) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...modifiers });
  target.dispatchEvent(event);
  return event;
}

function tap(target) {
  const event = new Event('pointerdown', { bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  document.body.innerHTML = '<div id="cy"><button type="button" class="tree-add-relative" aria-expanded="false">+</button></div>' +
    '<div id="details"><button type="button" class="details-button">Edit</button></div>';
  anchor = document.querySelector('.tree-add-relative');
  anchor.focus();
  onChoose = vi.fn();
});

afterEach(() => {
  menu?.close();
  menu = null;
  delete window.__xss;
  vi.restoreAllMocks();
});

describe('openAddRelativeMenu', () => {
  it('shows Parent, Spouse, Child and Sibling as menu items, labelled with the person', () => {
    open();
    expect(menuElement()).not.toBeNull();
    expect(items().map(nameOf)).toEqual(['Parent', 'Spouse', 'Child', 'Sibling']);
    expect(items().every(element => element.getAttribute('aria-disabled') === null)).toBe(true);
    expect(document.getElementById(menuElement().getAttribute('aria-labelledby')).textContent)
      .toBe('Add a relative to Rose Smith');
    expect(menu.isOpen()).toBe(true);
  });

  it('marks the anchor as expanded while open, and focuses the first item', () => {
    open();
    expect(anchor.getAttribute('aria-expanded')).toBe('true');
    expect(anchor.getAttribute('aria-controls')).toBe(menuElement().id);
    expect(document.activeElement).toBe(item('Parent'));
    menu.close();
    expect(anchor.getAttribute('aria-expanded')).toBe('false');
    expect(anchor.hasAttribute('aria-controls')).toBe(false);
  });

  it('blocks Sibling for someone with no parents, with the reason, and doesn\'t choose it', () => {
    open({ ...rose, parentFamilies: [] });
    const sibling = item('Sibling');
    expect(sibling.getAttribute('aria-disabled')).toBe('true');
    expect(descriptionOf(sibling)).toBe('Add a parent first');
    expect(sibling.textContent).toContain('Add a parent first');
    expect(nameOf(sibling)).toBe('Sibling');
    sibling.click();
    sibling.focus();
    press('Enter');
    press(' ');
    expect(onChoose).not.toHaveBeenCalled();
    expect(menu.isOpen()).toBe(true);
  });

  it('blocks Parent for someone with two parents, and focuses the first item that can be chosen', () => {
    open({ ...rose, parentFamilies: [{ familyId: 'F1', partnerIds: ['I1', 'I2'] }] });
    expect(item('Parent').getAttribute('aria-disabled')).toBe('true');
    expect(descriptionOf(item('Parent'))).toBe('Already has two parents');
    expect(item('Sibling').getAttribute('aria-disabled')).toBeNull();
    expect(document.activeElement).toBe(item('Spouse'));
  });

  it('chooses by click: closes, gives focus back to the anchor, then calls onChoose', () => {
    let focusedWhenChosen = null;
    onChoose.mockImplementation(() => { focusedWhenChosen = document.activeElement; });
    open();
    item('Child').click();
    expect(onChoose).toHaveBeenCalledWith('child');
    expect(onChoose).toHaveBeenCalledTimes(1);
    expect(focusedWhenChosen).toBe(anchor);
    expect(menu.isOpen()).toBe(false);
    expect(popover()).toBeNull();
  });

  it('moves between items with the arrow keys, Home and End, wrapping round', () => {
    open();
    press('ArrowDown');
    expect(document.activeElement).toBe(item('Spouse'));
    press('End');
    expect(document.activeElement).toBe(item('Sibling'));
    press('ArrowDown');
    expect(document.activeElement).toBe(item('Parent'));
    press('ArrowUp');
    expect(document.activeElement).toBe(item('Sibling'));
    press('Home');
    expect(document.activeElement).toBe(item('Parent'));
    const event = press('ArrowDown');
    expect(event.defaultPrevented).toBe(true);
  });

  it('reaches a blocked item with the keys, so its reason can be read', () => {
    open({ ...rose, parentFamilies: [] });
    press('End');
    expect(document.activeElement).toBe(item('Sibling'));
  });

  it('chooses by keyboard with Enter or Space', () => {
    open();
    press('ArrowDown');
    const event = press('Enter');
    expect(event.defaultPrevented).toBe(true);
    expect(onChoose).toHaveBeenCalledWith('spouse');
    expect(document.activeElement).toBe(anchor);

    onChoose.mockClear();
    open();
    press('End');
    press(' ');
    expect(onChoose).toHaveBeenCalledWith('sibling');
    expect(menu.isOpen()).toBe(false);
  });

  it('closes on Escape, giving focus back, without letting the Escape reach anything else', () => {
    const seen = [];
    const onDocumentKey = (event) => seen.push(event.key);
    document.addEventListener('keydown', onDocumentKey);
    try {
      open();
      press('ArrowDown');
      const event = press('Escape');
      expect(event.defaultPrevented).toBe(true);
      expect(seen).toEqual(['ArrowDown']);
      expect(menu.isOpen()).toBe(false);
      expect(popover()).toBeNull();
      expect(document.activeElement).toBe(anchor);
      expect(onChoose).not.toHaveBeenCalled();

      // Closed, it leaves Escape alone.
      const later = press('Escape', anchor);
      expect(later.defaultPrevented).toBe(false);
      expect(seen).toEqual(['ArrowDown', 'Escape']);
    } finally {
      document.removeEventListener('keydown', onDocumentKey);
    }
  });

  it('keeps the keys when a press between its items moves focus to the menu itself', () => {
    open();
    popover().focus();
    press('ArrowDown');
    expect(document.activeElement).toBe(item('Parent'));
    popover().focus();
    press('Escape');
    expect(menu.isOpen()).toBe(false);
    expect(document.activeElement).toBe(anchor);
  });

  it('ignores a held Enter or Space, so the press that opened it doesn\'t also choose', () => {
    open();
    expect(press('Enter', document.activeElement, { repeat: true }).defaultPrevented).toBe(true);
    press(' ', document.activeElement, { repeat: true });
    expect(onChoose).not.toHaveBeenCalled();
    expect(menu.isOpen()).toBe(true);
  });

  it('also closes on Escape pressed on the anchor while open (focus went back to it without a click)', () => {
    open();
    anchor.focus();
    const event = press('Escape', anchor);
    expect(event.defaultPrevented).toBe(true);
    expect(menu.isOpen()).toBe(false);
    expect(document.activeElement).toBe(anchor);
    expect(press('Escape', anchor).defaultPrevented).toBe(false);
  });

  it('closes on Tab and Shift+Tab, giving focus back to the anchor', () => {
    open();
    press('Tab');
    expect(menu.isOpen()).toBe(false);
    expect(document.activeElement).toBe(anchor);

    open();
    press('Tab', document.activeElement, { shiftKey: true });
    expect(menu.isOpen()).toBe(false);
    expect(document.activeElement).toBe(anchor);
  });

  it('closes on a tap outside, giving focus back, but not on a tap inside it or on the anchor', () => {
    open();
    tap(item('Spouse'));
    tap(menuElement());
    expect(menu.isOpen()).toBe(true);
    tap(anchor); // left to the anchor, which closes the menu itself (familyTreeView.js)
    expect(menu.isOpen()).toBe(true);

    const outside = tap(document.querySelector('.details-button'));
    expect(outside.defaultPrevented).toBe(false); // the tap still does what it does
    expect(menu.isOpen()).toBe(false);
    expect(document.activeElement).toBe(anchor);
    expect(onChoose).not.toHaveBeenCalled();
  });

  it('stops listening once closed', () => {
    open();
    menu.close();
    menu.close(); // twice is fine
    anchor.setAttribute('aria-expanded', 'false');
    tap(document.body);
    expect(press('Escape', document.body).defaultPrevented).toBe(false);
    expect(anchor.getAttribute('aria-expanded')).toBe('false');
  });

  it('closes a menu already open when another opens', () => {
    const first = open();
    const second = open();
    expect(first.isOpen()).toBe(false);
    expect(second.isOpen()).toBe(true);
    expect(document.querySelectorAll('.add-relative-menu')).toHaveLength(1);
  });

  it('shows the name as text', () => {
    open({ ...rose, name: XSS });
    expect(document.querySelector('[onerror]')).toBeNull();
    expect(popover().querySelector('img')).toBeNull();
    expect(document.getElementById(menuElement().getAttribute('aria-labelledby')).textContent)
      .toBe(`Add a relative to ${XSS}`);
    expect(window.__xss).toBeUndefined();
  });

  it('names an unnamed person', () => {
    open({ ...rose, name: '' });
    expect(document.getElementById(menuElement().getAttribute('aria-labelledby')).textContent)
      .toBe('Add a relative to Unnamed person');
  });

  it('places itself from the anchor\'s and its own rectangles', () => {
    const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      return this === anchor ? rect(100, 200, 50, 50) : rect(0, 0, 220, 240);
    });
    open();
    expect(popover().style.left).toBe('15px'); // centred on the anchor: 125 - 220 / 2
    expect(popover().style.top).toBe('258px'); // below it, 8px clear
  });
});

describe('placeMenu', () => {
  const viewport = { width: 375, height: 812 };
  const menuSize = { width: 220, height: 240 };
  const anchorAt = (left, top, size = 50) => ({ left, top, right: left + size, bottom: top + size });

  it('puts the menu below the anchor, centred on it', () => {
    expect(placeMenu(anchorAt(160, 200), menuSize, viewport)).toEqual({ left: 75, top: 258, placement: 'below' });
  });

  it('puts it above when there isn\'t room below', () => {
    expect(placeMenu(anchorAt(160, 600), menuSize, viewport)).toEqual({ left: 75, top: 352, placement: 'above' });
  });

  it('keeps it below when it only just fits, leaving the margin', () => {
    // An anchor at 502 ends at 552, so the menu ends at 552 + 8 + 240 = 800 = 812 - 12.
    expect(placeMenu(anchorAt(160, 502), menuSize, viewport)).toEqual({ left: 75, top: 560, placement: 'below' });
    expect(placeMenu(anchorAt(160, 503), menuSize, viewport).placement).toBe('above');
  });

  it('clamps it inside the viewport horizontally, with a 12px margin', () => {
    expect(placeMenu(anchorAt(0, 200), menuSize, viewport).left).toBe(12);
    expect(placeMenu(anchorAt(340, 200, 35), menuSize, viewport).left).toBe(375 - 12 - 220);
  });

  it('keeps a menu wider than the viewport at the left margin', () => {
    expect(placeMenu(anchorAt(100, 200), { width: 400, height: 240 }, viewport).left).toBe(12);
  });

  it('keeps it on screen when it fits neither below nor above', () => {
    const short = { width: 667, height: 300 };
    const place = placeMenu(anchorAt(300, 120), menuSize, short);
    expect(place.top).toBeGreaterThanOrEqual(12);
    expect(place.top + menuSize.height).toBeLessThanOrEqual(300 - 12);
  });
});
