import { FamilyTreeView } from './familyTreeView.js';
import { PersonDetails } from './personDetails.js';
import { loadIndex } from './dataLoader.js';

async function initApp() {
  const loadingEl = document.getElementById('loading');
  const cyEl = document.getElementById('cy');
  const detailsEl = document.getElementById('details');

  try {
    // Show loading
    loadingEl.textContent = 'Loading family tree...';

    // Get the index to find the first person
    const index = await loadIndex();

    if (!index.firstPersonId) {
      throw new Error('No people found in database');
    }

    // Create the family tree view and details panel
    const treeView = new FamilyTreeView(cyEl);
    const personDetails = new PersonDetails(detailsEl);

    // Check URL for person ID, otherwise use default
    const urlParams = new URLSearchParams(window.location.search);
    const personId = urlParams.get('person') || 'I122';

    // Load the person
    loadingEl.textContent = 'Rendering...';
    const personData = await treeView.loadPerson(personId);
    personDetails.showPerson(personData);

    // Listen for person selection to update URL and details
    treeView.onPersonSelect(async (selectedPersonId) => {
      const newUrl = new URL(window.location);
      newUrl.searchParams.set('person', selectedPersonId);
      window.history.pushState({}, '', newUrl);

      // Load and show person details
      const personData = await treeView.loadPerson(selectedPersonId);
      personDetails.showPerson(personData);
    });

    // Handle browser back/forward buttons
    window.addEventListener('popstate', async () => {
      const urlParams = new URLSearchParams(window.location.search);
      const personId = urlParams.get('person') || 'I122';
      const personData = await treeView.loadPerson(personId);
      personDetails.showPerson(personData);
    });

    // Hide loading
    loadingEl.classList.add('hidden');

    console.log(`Family tree loaded with ${index.totalPeople} people`);
    console.log('Click on any person to view their immediate family');

  } catch (error) {
    console.error('Failed to initialize app:', error);
    loadingEl.innerHTML = `
      <div style="color: #ff4444; max-width: 600px; text-align: left;">
        <strong>Error:</strong> ${error.message}<br><br>
        <strong>Stack:</strong><br>
        <pre style="background: rgba(0,0,0,0.5); padding: 10px; border-radius: 5px; overflow: auto; font-size: 12px; user-select: text;">${error.stack}</pre>
      </div>
    `;
    loadingEl.style.pointerEvents = 'auto';
  }
}

// Start the app when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}
