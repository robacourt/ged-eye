import cytoscape from 'cytoscape';
import { loadPersonWithFamily } from './dataLoader.js';

export class FamilyTreeView {
  constructor(containerElement) {
    this.container = containerElement;
    this.cy = null;
    this.selectedPersonId = null;
    this.onPersonSelectCallback = null;

    this.init();
  }

  init() {
    // Initialize Cytoscape
    this.cy = cytoscape({
      container: this.container,

      style: [
        // Node styles
        {
          selector: 'node',
          style: {
            'width': 80,
            'height': 80,
            'background-color': '#333',
            'border-width': 3,
            'border-color': '#666',
            'label': 'data(label)',
            'text-valign': 'bottom',
            'text-halign': 'center',
            'text-margin-y': 10,
            'color': '#fff',
            'font-size': '14px',
            'text-wrap': 'wrap',
            'text-max-width': '150px',
            'transition-property': 'width, height, border-color, background-color',
            'transition-duration': '0.3s'
          }
        },
        {
          selector: 'node[type="selected"]',
          style: {
            'width': 120,
            'height': 120,
            'border-color': '#4a90e2',
            'border-width': 4,
            'z-index': 100
          }
        },
        {
          selector: 'node[sex="M"]',
          style: {
            'background-color': '#4a7ba7'
          }
        },
        {
          selector: 'node[sex="F"]',
          style: {
            'background-color': '#b74a7b'
          }
        },
        // Edge styles
        {
          selector: 'edge',
          style: {
            'width': 2,
            'line-color': '#666',
            'target-arrow-color': '#666',
            'curve-style': 'bezier',
            'opacity': 0.6
          }
        },
        {
          selector: 'edge[type="spouse"]',
          style: {
            'line-color': '#e24a4a',
            'width': 3
          }
        },
        {
          selector: 'edge[type="parent"]',
          style: {
            'line-color': '#4ae24a',
            'target-arrow-shape': 'triangle'
          }
        }
      ],

      layout: {
        name: 'preset'
      },

      userZoomingEnabled: true,
      userPanningEnabled: true,
      boxSelectionEnabled: false
    });

    // Add click handler
    this.cy.on('tap', 'node', (event) => {
      const node = event.target;
      const personId = node.data('id');

      if (personId !== this.selectedPersonId) {
        this.selectPerson(personId);
      }
    });
  }

  /**
   * Load and display a person and their immediate family
   */
  async loadPerson(personId) {
    try {
      const { person, family } = await loadPersonWithFamily(personId);
      this.selectedPersonId = personId;

      // Build the graph
      this.buildGraph(person, family);

      return person;
    } catch (error) {
      console.error('Error loading person:', error);
      throw error;
    }
  }

  /**
   * Build the Cytoscape graph from person and family data
   */
  buildGraph(selectedPerson, familyMembers) {
    const elements = [];
    const positions = this.calculatePositions(selectedPerson, familyMembers);

    // Add selected person node
    elements.push({
      group: 'nodes',
      data: {
        id: selectedPerson.id,
        label: this.formatLabel(selectedPerson),
        type: 'selected',
        sex: selectedPerson.sex
      },
      position: positions[selectedPerson.id]
    });

    // Add family member nodes
    for (const member of familyMembers) {
      elements.push({
        group: 'nodes',
        data: {
          id: member.id,
          label: this.formatLabel(member),
          type: 'family',
          sex: member.sex
        },
        position: positions[member.id]
      });
    }

    // Add edges for spouses
    for (const spouseId of selectedPerson.spouseIds) {
      elements.push({
        group: 'edges',
        data: {
          id: `${selectedPerson.id}-${spouseId}`,
          source: selectedPerson.id,
          target: spouseId,
          type: 'spouse'
        }
      });
    }

    // Add edges for parents
    for (const parentId of selectedPerson.parentIds) {
      elements.push({
        group: 'edges',
        data: {
          id: `${parentId}-${selectedPerson.id}`,
          source: parentId,
          target: selectedPerson.id,
          type: 'parent'
        }
      });
    }

    // Add edges for children
    for (const childId of selectedPerson.childIds) {
      elements.push({
        group: 'edges',
        data: {
          id: `${selectedPerson.id}-${childId}`,
          source: selectedPerson.id,
          target: childId,
          type: 'parent'
        }
      });
    }

    // Clear existing graph and add new elements
    this.cy.elements().remove();
    this.cy.add(elements);

    // Fit to viewport
    this.cy.fit(50);
  }

  /**
   * Calculate positions for all nodes in a family tree layout
   */
  calculatePositions(selectedPerson, familyMembers) {
    const positions = {};
    const centerX = 0;
    const centerY = 0;
    const spacing = 200;

    // Selected person in center
    positions[selectedPerson.id] = { x: centerX, y: centerY };

    // Position parents above
    const parents = familyMembers.filter(m => selectedPerson.parentIds.includes(m.id));
    parents.forEach((parent, index) => {
      const offset = (index - (parents.length - 1) / 2) * spacing;
      positions[parent.id] = {
        x: centerX + offset,
        y: centerY - spacing * 1.5
      };
    });

    // Position spouses to the sides
    const spouses = familyMembers.filter(m => selectedPerson.spouseIds.includes(m.id));
    spouses.forEach((spouse, index) => {
      const side = index % 2 === 0 ? 1 : -1;
      const row = Math.floor(index / 2);
      positions[spouse.id] = {
        x: centerX + side * spacing * 1.5,
        y: centerY + row * spacing * 0.5
      };
    });

    // Position children below
    const children = familyMembers.filter(m => selectedPerson.childIds.includes(m.id));
    children.forEach((child, index) => {
      const offset = (index - (children.length - 1) / 2) * spacing;
      positions[child.id] = {
        x: centerX + offset,
        y: centerY + spacing * 1.5
      };
    });

    return positions;
  }

  /**
   * Format a person's name and dates for display
   */
  formatLabel(person) {
    const name = person.name || 'Unknown';
    const birthYear = person.birthDate ? person.birthDate.match(/\d{4}/)?.[0] || '' : '';

    if (birthYear) {
      return `${name}\nb. ${birthYear}`;
    }
    return name;
  }

  /**
   * Select a different person
   */
  async selectPerson(personId) {
    await this.loadPerson(personId);

    if (this.onPersonSelectCallback) {
      this.onPersonSelectCallback(personId);
    }
  }

  /**
   * Set callback for when a person is selected
   */
  onPersonSelect(callback) {
    this.onPersonSelectCallback = callback;
  }
}
