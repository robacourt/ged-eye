/**
 * The search page (`?relative=<id>[&person=<id>]`; spec: specs/2026-10-18-relationship-search-design.md): find
 * someone by name, and see how they are related to the relative (the person who was on screen) as a chain drawn
 * like the tree, and in words below it. It opens over the tree, which stays drawn underneath.
 *
 * Every data value is set with `textContent`, never as HTML.
 */
import { el } from './editorDialog.js';
import { nameOf } from './familyLinks.js';
import { createPersonSearch, lifeYears } from './personSearch.js';
import { ChainView } from './chainView.js';
import { describeRelationship } from './relationshipWords.js';
import './relationshipPage.css';

const FINDING = 'Finding how they’re related…';
const FAILED = 'Couldn’t find how they’re related. Check your connection and try again.';
const NOT_CONNECTED = 'No family connection found.';
const NOT_FOUND = 'Couldn\u2019t find one of them in the tree. They may have been removed.';

/**
 * Opens the page in `container`.
 * @param api           `{ search, relationship }` (editApi.js)
 * @param relative      `{ id, name }`: whom the chain starts from
 * @param onChoose      (id) when someone is chosen from the results (main.js puts them in the URL, then calls
 *                      `setPerson`)
 * @param onOpenPerson  (id) when someone in the chain is tapped: the tree, with them selected
 * @param onBack        () for Back: the tree, with the relative selected
 * @returns `{ element, setRelative(relative), setPerson(id | null), focusSearch(), close() }`
 */
export function openRelationshipPage({ container, api, relative, onChoose, onOpenPerson, onBack }) {
  // The search box, then Back, on one row at the top; the page is named for screen readers only.
  const back = el('button', { type: 'button', class: 'relationship-back', text: 'Back' });
  const results = el('ul', { class: 'relationship-results', 'aria-label': 'People found' });
  const status = el('p', { class: 'relationship-status', role: 'status' });
  const chainBox = el('div', { class: 'relationship-chain' });
  const words = el('p', { class: 'relationship-words', 'aria-live': 'polite' });
  const page = el('section', { class: 'relationship-page', tabindex: '-1' });
  const search = createPersonSearch({ api, isActive: () => page.isConnected, onResults: showResults });
  search.input.setAttribute('aria-label', 'Search for someone by name');
  search.input.placeholder = 'Search for someone by name';
  page.append(
    el('div', { class: 'relationship-search-row' }, search.input, back),
    search.status, results, status, chainBox, words);
  container.append(page);

  const chain = new ChainView(chainBox, { onPersonSelect: (id) => onOpenPerson?.(id) });
  // The chain is fitted again whenever its room changes (the words below it appearing, a turned phone).
  const refit = () => chain.fit();
  const resizes = typeof ResizeObserver === 'function' ? new ResizeObserver(refit) : null;
  resizes?.observe(chainBox);
  window.addEventListener('resize', refit);
  let current = relative;
  let loading = 0; // bumped per chain asked for, so only the latest answer is shown

  function setRelative(next) {
    current = next;
    page.setAttribute('aria-label', `How someone is related to ${nameOf(next)}`);
  }

  function showResults(found) {
    results.replaceChildren(...found.map(someone => {
      const years = lifeYears(someone);
      const button = el('button', { type: 'button', class: 'relationship-result' },
        el('span', { class: 'relationship-result-name', text: nameOf(someone) }),
        years ? el('span', { class: 'relationship-result-years', text: years }) : null);
      button.addEventListener('click', () => {
        // The box keeps their name; the results and their count go.
        search.clear();
        search.input.value = nameOf(someone);
        search.status.textContent = '';
        // The button pressed has gone: focus stays on the page, without bringing up a phone's keyboard.
        page.focus({ preventScroll: true });
        onChoose?.(someone.id);
      });
      return el('li', {}, button);
    }));
  }

  /** Shows how `personId` is related to the relative (nothing for null). */
  async function setPerson(personId) {
    const number = ++loading;
    words.textContent = '';
    if (!personId) {
      status.textContent = '';
      chain.clear();
      return;
    }
    status.textContent = FINDING;
    let path;
    try {
      path = await api.relationship(current.id, personId);
    } catch (error) {
      if (number !== loading || !page.isConnected) return;
      chain.clear();
      if (error?.status === 404 || error?.status === 409) {
        status.textContent = NOT_FOUND; // one of them isn't in the tree (any more)
        return;
      }
      console.error('Could not find the relationship', error);
      status.textContent = FAILED;
      return;
    }
    if (number !== loading || !page.isConnected) return;
    status.textContent = '';
    if (!path) {
      chain.clear();
      words.textContent = NOT_CONNECTED;
      return;
    }
    chain.show(path);
    words.textContent = describeRelationship(path);
  }

  back.addEventListener('click', () => onBack?.());
  setRelative(relative);

  return {
    element: page,
    setRelative,
    setPerson,
    /** Focus in the search box, for a page opened with nobody chosen yet. */
    focusSearch: () => search.input.focus({ preventScroll: true }),
    close() {
      loading++;
      window.removeEventListener('resize', refit);
      resizes?.disconnect();
      search.destroy();
      chain.destroy();
      page.remove();
    }
  };
}
