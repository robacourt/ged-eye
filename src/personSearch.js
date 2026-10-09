/**
 * The search half of "find someone in the tree", shared by the relative dialog and the person picker: a search
 * box that asks the server 250 ms after the last keystroke (or at once on Enter), with a polite status line.
 *
 * Every data value is set with `textContent`, never as HTML.
 */
import { el } from './editorDialog.js';

const SEARCH_DELAY_MS = 250;
const SEARCH_MIN_CHARS = 2;
const SEARCH_LIMIT = 20;

const HINT = `Type at least ${SEARCH_MIN_CHARS} letters of their name.`;
const FAILED = "Couldn't search. Check your connection and try again.";

/** "1850–1910", "b. 1850", "d. 1910" or "", from a search result's `birthYear` and `deathYear`. */
export function lifeYears({ birthYear, deathYear }) {
  const born = birthYear ?? '';
  const died = deathYear ?? '';
  if (born !== '' && died !== '') return `${born}–${died}`;
  if (born !== '') return `b. ${born}`;
  if (died !== '') return `d. ${died}`;
  return '';
}

/**
 * The search box. Fewer than 2 letters clears the results; a search that answers after a newer one has started,
 * or once `isActive()` is false, is ignored; a failed search is logged and clears the results.
 * @param api        `{ search(text, { limit }) }` (editApi.js), giving `[{ id, name, birthYear, deathYear }]`
 * @param isActive   () => false once the box's dialog has closed
 * @param onResults  (people) with each search's results, after `filter`; ([]) when they are cleared
 * @param filter     (person) => false to leave someone out of the results and the count
 * @param label      the search box's label, shown in `element`
 * @returns `{ input, status, element (label + input + status), runNow(), clear(), destroy() }`: callers that lay
 *   out their own label place `input` and `status` themselves
 */
export function createPersonSearch({ api, isActive = () => true, onResults, filter = () => true, label = 'Search the tree' }) {
  const input = el('input', {
    class: 'editor-input', type: 'search', name: 'search', autocomplete: 'off', placeholder: 'Type a name'
  });
  const status = el('p', { class: 'editor-hint person-search-status', 'aria-live': 'polite', text: HINT });
  const element = el('div', { class: 'person-search' },
    el('label', { class: 'editor-field' }, el('span', { text: label }), input), status);
  let timer = null;
  let searchNumber = 0;
  let destroyed = false;

  const active = () => !destroyed && isActive();

  function show(people, text) {
    onResults?.(people);
    status.textContent = text;
  }

  async function runNow() {
    clearTimeout(timer);
    if (!active()) return; // closed while the search was waiting
    const text = input.value.trim();
    const number = ++searchNumber;
    if ([...text].length < SEARCH_MIN_CHARS) {
      show([], HINT);
      return;
    }
    status.textContent = 'Searching…';
    let people;
    try {
      people = await api.search(text, { limit: SEARCH_LIMIT });
    } catch (error) {
      if (number !== searchNumber || !active()) return;
      console.error('Search failed', error);
      show([], FAILED);
      return;
    }
    if (number !== searchNumber || !active()) return; // a newer search has started, or the box has gone
    const found = (Array.isArray(people) ? people : []).filter(someone => filter(someone));
    show(found, found.length === 0 ? 'No one matches.'
      : found.length === 1 ? '1 person found.' : `${found.length} people found.`);
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(runNow, SEARCH_DELAY_MS);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault(); // search now rather than submit the form
    runNow();
  });

  return {
    input,
    status,
    element,
    runNow,
    /** Empties the box and the results, and forgets any search under way. */
    clear() {
      clearTimeout(timer);
      searchNumber++;
      input.value = '';
      show([], HINT);
    },
    /** Stops any waiting search and ignores any answer still to come. */
    destroy() {
      clearTimeout(timer);
      searchNumber++;
      destroyed = true;
    }
  };
}
