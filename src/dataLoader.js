/**
 * Lazy loads person data from JSON files
 */

const cache = new Map();
const BASE_URL = '/data/people';

/**
 * Load a person's data by ID
 * @param {string} personId - The person ID (e.g., 'I1')
 * @returns {Promise<Object>} Person data
 */
export async function loadPerson(personId) {
  // Check cache first
  if (cache.has(personId)) {
    return cache.get(personId);
  }

  try {
    const response = await fetch(`${BASE_URL}/${personId}.json`);
    if (!response.ok) {
      throw new Error(`Failed to load person ${personId}: ${response.statusText}`);
    }

    const data = await response.json();
    cache.set(personId, data);
    return data;
  } catch (error) {
    console.error(`Error loading person ${personId}:`, error);
    throw error;
  }
}

/**
 * Load multiple people at once
 * @param {string[]} personIds - Array of person IDs
 * @returns {Promise<Object[]>} Array of person data
 */
export async function loadPeople(personIds) {
  const promises = personIds.map(id => loadPerson(id));
  return Promise.all(promises);
}

/**
 * Get the index file with all person IDs
 * @returns {Promise<Object>} Index data
 */
export async function loadIndex() {
  if (cache.has('_index')) {
    return cache.get('_index');
  }

  try {
    const response = await fetch(`${BASE_URL}/index.json`);
    if (!response.ok) {
      throw new Error(`Failed to load index: ${response.statusText}`);
    }

    const data = await response.json();
    cache.set('_index', data);
    return data;
  } catch (error) {
    console.error('Error loading index:', error);
    throw error;
  }
}

/**
 * Preload a person and their extended family
 * @param {string} personId - The person ID
 * @returns {Promise<Object>} Object with person and family data
 */
export async function loadPersonWithFamily(personId) {
  const person = await loadPerson(personId);

  // Collect all immediate family IDs
  const familyIds = new Set([
    ...person.parentIds,
    ...person.spouseIds,
    ...person.childIds
  ]);

  // Load immediate family first
  const immediateFamilyResults = await Promise.allSettled(
    Array.from(familyIds).map(id => loadPerson(id))
  );

  const immediateFamily = immediateFamilyResults
    .filter(result => result.status === 'fulfilled')
    .map(result => result.value);

  // Now collect extended family IDs
  const extendedIds = new Set();

  // Get siblings (children of person's parents) and their other parents
  for (const parent of immediateFamily.filter(m => person.parentIds.includes(m.id))) {
    parent.childIds.forEach(id => {
      if (id !== personId) extendedIds.add(id);
    });
  }

  // Load siblings first to get their parents
  const siblingsResults = await Promise.allSettled(
    Array.from(extendedIds).map(id => loadPerson(id))
  );

  const siblings = siblingsResults
    .filter(result => result.status === 'fulfilled')
    .map(result => result.value)
    .filter(sibling => person.parentIds.some(parentId => sibling.parentIds.includes(parentId)));

  // Get other parents of half-siblings
  for (const sibling of siblings) {
    for (const siblingParentId of sibling.parentIds) {
      if (!person.parentIds.includes(siblingParentId)) {
        extendedIds.add(siblingParentId);
      }
    }
  }

  // Load extended family
  const extendedFamilyResults = await Promise.allSettled(
    Array.from(extendedIds).map(id => loadPerson(id))
  );

  const extendedFamily = extendedFamilyResults
    .filter(result => result.status === 'fulfilled')
    .map(result => result.value);

  // Combine and deduplicate
  const allFamily = [...immediateFamily, ...extendedFamily];

  return {
    person,
    family: allFamily,
    relationships: {
      parents: immediateFamily.filter(m => person.parentIds.includes(m.id)),
      spouses: immediateFamily.filter(m => person.spouseIds.includes(m.id)),
      children: immediateFamily.filter(m => person.childIds.includes(m.id)),
      siblings: extendedFamily.filter(m => extendedIds.has(m.id) &&
        person.parentIds.some(parentId => m.parentIds.includes(parentId)))
    }
  };
}
