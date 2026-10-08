import { FamilyTreeView } from './familyTreeView.js';
import { PersonDetails } from './personDetails.js';
import { PersonNotFoundError } from './dataLoader.js';

const DEFAULT_PERSON_ID = 'I122';
const SLOW_LOAD_MS = 300;

function personIdFromUrl() {
  return new URLSearchParams(window.location.search).get('person') || DEFAULT_PERSON_ID;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function initApp() {
  const loadingEl = document.getElementById('loading');
  const treeView = new FamilyTreeView(document.getElementById('cy'));
  const personDetails = new PersonDetails(document.getElementById('details'));

  const overlay = {
    hide() {
      loadingEl.classList.add('hidden');
      loadingEl.classList.remove('interactive');
    },
    loading(text = 'Loading...') {
      loadingEl.textContent = text;
      loadingEl.classList.remove('hidden', 'interactive');
    },
    message(html) {
      loadingEl.innerHTML = html;
      loadingEl.classList.remove('hidden');
      loadingEl.classList.add('interactive');
    }
  };

  let currentRequest = 0;
  let requestedPersonId = null;

  async function showPerson(personId) {
    const request = ++currentRequest;
    const isCurrent = () => request === currentRequest;
    requestedPersonId = personId;
    const slowTimer = setTimeout(() => {
      if (isCurrent() && loadingEl.classList.contains('hidden')) overlay.loading();
    }, SLOW_LOAD_MS);
    try {
      const result = await treeView.loadPerson(personId);
      if (!result || !isCurrent()) return; // superseded by a newer selection
      personDetails.showPerson(result.person, result.relationships);
      overlay.hide();
    } catch (error) {
      if (!isCurrent()) return;
      console.error('Failed to load person', personId, error);
      if (error instanceof PersonNotFoundError) {
        overlay.message(`<p>Person not found.</p><p><a href="?person=${DEFAULT_PERSON_ID}">Go to the start of the tree</a></p>`);
      } else {
        overlay.message(`<p>Couldn't load this person.</p><p class="loading-error-detail">${escapeHtml(error.message)}</p><button type="button" class="loading-retry">Retry</button>`);
        loadingEl.querySelector('.loading-retry').addEventListener('click', () => {
          overlay.loading();
          showPerson(personId);
        });
      }
    } finally {
      clearTimeout(slowTimer);
    }
  }

  treeView.onPersonSelect(personId => {
    if (personId === requestedPersonId) return; // double tap on the person already being shown
    const newUrl = new URL(window.location);
    newUrl.searchParams.set('person', personId);
    window.history.pushState({}, '', newUrl);
    showPerson(personId);
  });

  window.addEventListener('popstate', () => showPerson(personIdFromUrl()));

  overlay.loading('Loading family tree...');
  showPerson(personIdFromUrl());
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}
