/**
 * Choose several people from the tree, as for the people a photo is shown for: the chosen show as chips with a
 * × to remove them, and a person search below lists matches with an "Add" button each.
 *
 * Every data value is set with `textContent` or as an attribute, never as HTML.
 */
import { el, callSafely, VISUALLY_HIDDEN } from './editorDialog.js';
import { nameOf } from './familyLinks.js';
import { createPersonSearch, lifeYears } from './personSearch.js';

/**
 * Builds the picker; the caller places `element`.
 * @param api       `{ search }` (editApi.js)
 * @param chosen    `[{ id, name }]` chosen to start with (a repeated id is shown once)
 * @param fixedIds  ids that can't be removed: their chips have no ×
 * @param onChange  (chosen) after each add or remove, with a copy of everyone chosen
 * @param label     the search box's label
 * @returns `{ element, chosen() (a copy of `[{ id, name }]`), destroy() (stops any search under way) }`
 */
export function createPersonPicker({ api, chosen = [], fixedIds = [], onChange, label = 'Search the tree' }) {
  const fixed = new Set(fixedIds);
  const people = [];
  for (const { id, name } of chosen) {
    if (!people.some(someone => someone.id === id)) people.push({ id, name });
  }
  const isChosen = (id) => people.some(someone => someone.id === id);
  let rows = []; // the results shown: { someone, button, row }
  const removeButtons = new Map(); // id -> its chip's × button

  const chips = el('ul', { class: 'person-picker-chips', 'aria-label': 'Chosen people' });
  const results = el('ul', { class: 'person-picker-results', 'aria-label': 'People found' });
  const announcer = el('p', { class: 'person-picker-announcer', 'aria-live': 'polite', style: VISUALLY_HIDDEN });
  const element = el('div', { class: 'person-picker' });
  const search = createPersonSearch({ api, label, isActive: () => element.isConnected, onResults: showResults });
  element.append(chips, search.element, results, announcer);

  function changed(announcement) {
    renderChips();
    updateButtons();
    announcer.textContent = announcement;
    callSafely(onChange, people.map(someone => ({ ...someone })));
  }

  function add(someone) {
    if (isChosen(someone.id)) return;
    people.push({ id: someone.id, name: someone.name ?? '' });
    changed(`Added ${nameOf(someone)}`);
  }

  function remove(id) {
    const index = people.findIndex(someone => someone.id === id);
    if (index === -1 || fixed.has(id)) return;
    const [removed] = people.splice(index, 1);
    changed(`Removed ${nameOf(removed)}`);
    // The × that was pressed has gone: focus the next one, else the one before, else the search box.
    const removable = (someone) => !fixed.has(someone.id);
    const next = people.slice(index).find(removable) ?? people.slice(0, index).reverse().find(removable);
    (removeButtons.get(next?.id) ?? search.input).focus();
  }

  function renderChips() {
    removeButtons.clear();
    chips.replaceChildren(...people.map(someone => {
      const name = nameOf(someone);
      const chip = el('li', { class: fixed.has(someone.id) ? 'person-picker-chip person-picker-chip-fixed' : 'person-picker-chip', 'data-id': someone.id },
        el('span', { class: 'person-picker-chip-name', text: name }));
      if (!fixed.has(someone.id)) {
        const button = el('button', { type: 'button', class: 'person-picker-remove', 'aria-label': `Remove ${name}`, text: '×' });
        button.addEventListener('click', () => remove(someone.id));
        removeButtons.set(someone.id, button);
        chip.append(button);
      }
      return chip;
    }));
  }

  function showResults(found) {
    rows = found.map(someone => {
      const years = lifeYears(someone);
      const button = el('button', { type: 'button', class: 'person-picker-add' });
      button.addEventListener('click', () => add(someone));
      const row = el('li', { class: 'person-picker-result', 'data-id': someone.id },
        el('span', { class: 'person-picker-result-label' },
          el('span', { class: 'person-picker-result-name', text: nameOf(someone) }),
          ...(years ? [' ', el('span', { class: 'person-picker-result-years', text: `(${years})` })] : [])),
        button);
      return { someone, button, row };
    });
    results.replaceChildren(...rows.map(({ row }) => row));
    updateButtons();
  }

  /**
   * "Add", or "Added" for someone already chosen. It stays focusable (aria-disabled), so focus isn't lost. Its
   * label has the years too, so namesakes can be told apart.
   */
  function updateButtons() {
    for (const { someone, button } of rows) {
      const years = lifeYears(someone);
      const who = years ? `${nameOf(someone)}, ${years}` : nameOf(someone);
      if (isChosen(someone.id)) {
        button.textContent = 'Added';
        button.setAttribute('aria-label', `Added ${who}`);
        button.setAttribute('aria-disabled', 'true');
      } else {
        button.textContent = 'Add';
        button.setAttribute('aria-label', `Add ${who}`);
        button.removeAttribute('aria-disabled');
      }
    }
  }

  renderChips();

  return {
    element,
    chosen: () => people.map(someone => ({ ...someone })),
    destroy: () => search.destroy()
  };
}
