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
 * Preload a person and their immediate family
 * @param {string} personId - The person ID
 * @returns {Promise<Object>} Object with person and family data
 */
export async function loadPersonWithFamily(personId) {
  const person = await loadPerson(personId);

  // Collect all immediate family IDs
  const familyIds = [
    ...person.parentIds,
    ...person.spouseIds,
    ...person.childIds
  ];

  // Load all family members in parallel
  const familyMembers = await Promise.allSettled(
    familyIds.map(id => loadPerson(id))
  );

  // Filter out any that failed to load
  const loadedFamily = familyMembers
    .filter(result => result.status === 'fulfilled')
    .map(result => result.value);

  return {
    person,
    family: loadedFamily
  };
}
