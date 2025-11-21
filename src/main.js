import { FamilyTreeView } from './familyTreeView.js';
import { loadIndex } from './dataLoader.js';

async function initApp() {
  const loadingEl = document.getElementById('loading');
  const cyEl = document.getElementById('cy');

  try {
    // Show loading
    loadingEl.textContent = 'Loading family tree...';

    // Get the index to find the first person
    const index = await loadIndex();

    if (!index.firstPersonId) {
      throw new Error('No people found in database');
    }

    // Create the family tree view
    const treeView = new FamilyTreeView(cyEl);

    // Load the first person
    loadingEl.textContent = 'Rendering...';
    await treeView.loadPerson(index.firstPersonId);

    // Hide loading
    loadingEl.classList.add('hidden');

    console.log(`Family tree loaded with ${index.totalPeople} people`);
    console.log('Click on any person to view their immediate family');

  } catch (error) {
    console.error('Failed to initialize app:', error);
    loadingEl.textContent = `Error: ${error.message}`;
    loadingEl.style.color = '#ff4444';
  }
}

// Start the app when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}
