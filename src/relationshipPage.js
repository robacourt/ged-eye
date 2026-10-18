/**
 * The search page (`?relative=<id>[&person=<id>]`; spec: specs/2026-10-18-relationship-search-design.md): find
 * someone by name, and see how they are related to the relative (the person who was on screen) as a chain drawn
 * like the tree, and in words below it. It opens over the tree, which stays drawn underneath.
 *
 * Every data value is set with `textContent`, never as HTML.
 */
import { el, uniqueId } from './editorDialog.js';
import { nameOf } from './familyLinks.js';
import { createPersonSearch, lifeYears } from './personSearch.js';
import { ChainView } from './chainView.js';
import { describeRelationship } from './relationshipWords.js';
import './relationshipPage.css';

const FINDING = 'Finding how they’re related…';
const FAILED = 'Couldn’t find how they’re related. Check your connection and try again.';
const NOT_CONNECTED = 'No family connection found.';

/**
 * Opens the page in `container`.
 * @param api           `{ search, relationship }` (editApi.js)
 * @param relative      `{ id, name }`: whom the chain starts from
 * @param onChoose      (id) when someone is chosen from the results (main.js puts them in the URL, then calls
 *                      `setPerson`)
 * @param onOpenPerson  (id) when someone in the chain is tapped: the tree, with them selected
 * @param onBack        () for Back: the tree, with the relative selected
 * @returns `{ element, setRelative(relative), setPerson(id | null), close() }`
 */
export function openRelationshipPage({ container, api, relative, onChoose, onOpenPerson, onBack }) {
  const titleId = uniqueId('relationship-title');
  const back = el('button', { type: 'button', class: 'relationship-back', text: '← Back to the tree' });
  const title = el('h1', { class: 'relationship-title', id: titleId });
  const results = el('ul', { class: 'relationship-results', 'aria-label': 'People found' });
  const status = el('p', { class: 'relationship-status', role: 'status' });
  const chainBox = el('div', { class: 'relationship-chain' });
  const words = el('p', { class: 'relationship-words', 'aria-live': 'polite' });
  const page = el('section', { class: 'relationship-page', 'aria-labelledby': titleId },
    el('header', { class: 'relationship-header' }, back, title));
  const search = createPersonSearch({
    api, label: 'Search for someone by name', isActive: () => page.isConnected, onResults: showResults
  });
  page.append(search.element, results, status, chainBox, words);
  container.append(page);

  const chain = new ChainView(chainBox, { onPersonSelect: (id) => onOpenPerson?.(id) });
  const refit = () => chain.fit();
  window.addEventListener('resize', refit);
  let current = relative;
  let loading = 0; // bumped per chain asked for, so only the latest answer is shown

  function setRelative(next) {
    current = next;
    title.textContent = `How is someone related to ${nameOf(next)}?`;
  }

  function showResults(found) {
    results.replaceChildren(...found.map(someone => {
      const years = lifeYears(someone);
      const button = el('button', { type: 'button', class: 'relationship-result' },
        el('span', { class: 'relationship-result-name', text: nameOf(someone) }),
        years ? el('span', { class: 'relationship-result-years', text: years }) : null);
      button.addEventListener('click', () => {
        results.replaceChildren();
        search.input.value = nameOf(someone);
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
      console.error('Could not find the relationship', error);
      chain.clear();
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
    close() {
      loading++;
      window.removeEventListener('resize', refit);
      search.destroy();
      chain.destroy();
      page.remove();
    }
  };
}
