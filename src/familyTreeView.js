import cytoscape from 'cytoscape';
import dagre from 'cytoscape-dagre';
import { loadPersonWithFamily } from './dataLoader.js';

// Register the dagre layout
cytoscape.use(dagre);

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
            'width': 90,
            'height': 90,
            'background-color': '#3a3a4a',
            'border-width': 3,
            'border-color': '#555',
            'label': 'data(label)',
            'text-valign': 'bottom',
            'text-halign': 'center',
            'text-margin-y': 15,
            'color': '#fff',
            'font-size': '13px',
            'font-weight': '500',
            'text-wrap': 'wrap',
            'text-max-width': '180px',
            'text-background-color': 'rgba(0, 0, 0, 0.6)',
            'text-background-opacity': 1,
            'text-background-padding': '4px',
            'text-background-shape': 'roundrectangle',
            'transition-property': 'width, height, border-color, background-color',
            'transition-duration': '0.3s',
            'cursor': 'pointer'
          }
        },
        {
          selector: 'node[type="selected"]',
          style: {
            'width': 130,
            'height': 130,
            'border-color': '#00d4ff',
            'border-width': 5,
            'z-index': 100,
            'font-size': '15px',
            'font-weight': '600'
          }
        },
        {
          selector: 'node[sex="M"]',
          style: {
            'background-color': '#4a8fc7'
          }
        },
        {
          selector: 'node[sex="F"]',
          style: {
            'background-color': '#c74a8f'
          }
        },
        {
          selector: 'node[type="partnership"]',
          style: {
            'width': 12,
            'height': 12,
            'background-color': '#aaa',
            'border-width': 2,
            'border-color': '#666',
            'label': ''
          }
        },
        // Edge styles
        {
          selector: 'edge',
          style: {
            'width': 3,
            'line-color': '#666',
            'target-arrow-color': '#666',
            'curve-style': 'bezier',
            'opacity': 0.8
          }
        },
        {
          selector: 'edge[type="spouse"]',
          style: {
            'line-color': '#ff6b9d',
            'width': 4,
            'opacity': 0.9
          }
        },
        {
          selector: 'edge[type="parent"]',
          style: {
            'line-color': '#8ab4f8',
            'target-arrow-shape': 'triangle',
            'target-arrow-color': '#8ab4f8',
            'width': 3,
            'opacity': 0.9
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
      const { person, family, relationships } = await loadPersonWithFamily(personId);
      this.selectedPersonId = personId;

      // Build the graph
      this.buildGraph(person, family, relationships);

      return person;
    } catch (error) {
      console.error('Error loading person:', error);
      throw error;
    }
  }

  /**
   * Build the Cytoscape graph from person and family data
   */
  buildGraph(selectedPerson, familyMembers, relationships) {
    const elements = [];

    // Add selected person node
    elements.push({
      group: 'nodes',
      data: {
        id: selectedPerson.id,
        label: this.formatLabel(selectedPerson),
        type: 'selected',
        sex: selectedPerson.sex
      }
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
        }
      });
    }

    // Add partnership nodes and edges for spouses
    selectedPerson.spouseIds.forEach((spouseId, index) => {
      const partnershipId = `partnership-${selectedPerson.id}-${spouseId}`;

      // Add partnership node
      elements.push({
        group: 'nodes',
        data: {
          id: partnershipId,
          type: 'partnership'
        }
      });

      // Connect selected person to partnership
      elements.push({
        group: 'edges',
        data: {
          id: `${selectedPerson.id}-${partnershipId}`,
          source: selectedPerson.id,
          target: partnershipId,
          type: 'spouse'
        }
      });

      // Connect spouse to partnership
      elements.push({
        group: 'edges',
        data: {
          id: `${spouseId}-${partnershipId}`,
          source: spouseId,
          target: partnershipId,
          type: 'spouse'
        }
      });
    });

    // Add partnership node for parents
    if (relationships?.parents && relationships.parents.length === 2) {
      const parent1 = relationships.parents[0];
      const parent2 = relationships.parents[1];
      const parentsPartnershipId = `partnership-${parent1.id}-${parent2.id}`;

      elements.push({
        group: 'nodes',
        data: {
          id: parentsPartnershipId,
          type: 'partnership'
        }
      });

      // Connect parents to their partnership
      elements.push({
        group: 'edges',
        data: {
          id: `${parent1.id}-${parentsPartnershipId}`,
          source: parent1.id,
          target: parentsPartnershipId,
          type: 'spouse'
        }
      });

      elements.push({
        group: 'edges',
        data: {
          id: `${parent2.id}-${parentsPartnershipId}`,
          source: parent2.id,
          target: parentsPartnershipId,
          type: 'spouse'
        }
      });

      // Connect partnership to selected person
      elements.push({
        group: 'edges',
        data: {
          id: `${parentsPartnershipId}-${selectedPerson.id}`,
          source: parentsPartnershipId,
          target: selectedPerson.id,
          type: 'parent'
        }
      });

      // Connect partnership to siblings
      if (relationships?.siblings) {
        for (const sibling of relationships.siblings) {
          elements.push({
            group: 'edges',
            data: {
              id: `${parentsPartnershipId}-${sibling.id}`,
              source: parentsPartnershipId,
              target: sibling.id,
              type: 'parent'
            }
          });
        }
      }
    } else if (selectedPerson.parentIds.length > 0) {
      // Single parent or missing parent data
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

      // Connect to siblings too
      if (relationships?.siblings) {
        for (const sibling of relationships.siblings) {
          for (const parentId of sibling.parentIds) {
            if (selectedPerson.parentIds.includes(parentId)) {
              elements.push({
                group: 'edges',
                data: {
                  id: `${parentId}-${sibling.id}`,
                  source: parentId,
                  target: sibling.id,
                  type: 'parent'
                }
              });
            }
          }
        }
      }
    }

    // Add edges for grandparents to parents
    if (relationships?.grandparents && relationships?.parents) {
      for (const grandparent of relationships.grandparents) {
        for (const parent of relationships.parents) {
          if (parent.parentIds.includes(grandparent.id)) {
            elements.push({
              group: 'edges',
              data: {
                id: `${grandparent.id}-${parent.id}`,
                source: grandparent.id,
                target: parent.id,
                type: 'parent'
              }
            });
          }
        }
      }
    }

    // Add edges from partnership nodes to children
    // For now, connect to first partnership if multiple spouses
    if (selectedPerson.childIds.length > 0 && selectedPerson.spouseIds.length > 0) {
      const partnershipId = `partnership-${selectedPerson.id}-${selectedPerson.spouseIds[0]}`;
      for (const childId of selectedPerson.childIds) {
        elements.push({
          group: 'edges',
          data: {
            id: `${partnershipId}-${childId}`,
            source: partnershipId,
            target: childId,
            type: 'parent'
          }
        });
      }
    } else if (selectedPerson.childIds.length > 0) {
      // No spouse, connect directly
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
    }

    // Add edges for grandchildren to children
    if (relationships?.grandchildren && relationships?.children) {
      for (const grandchild of relationships.grandchildren) {
        for (const child of relationships.children) {
          if (child.childIds.includes(grandchild.id)) {
            elements.push({
              group: 'edges',
              data: {
                id: `${child.id}-${grandchild.id}`,
                source: child.id,
                target: grandchild.id,
                type: 'parent'
              }
            });
          }
        }
      }
    }

    // Clear existing graph and add new elements
    this.cy.elements().remove();
    this.cy.add(elements);

    // Run dagre layout
    const layout = this.cy.layout({
      name: 'dagre',
      rankDir: 'TB', // Top to bottom
      nodeSep: 100,  // Horizontal spacing between nodes
      rankSep: 150,  // Vertical spacing between ranks
      padding: 50
    });

    layout.run();

    // Fit to viewport after layout completes
    setTimeout(() => {
      this.cy.fit(50);
    }, 100);
  }

  /**
   * Calculate positions for all nodes in a family tree layout
   */
  calculatePositions(selectedPerson, familyMembers, relationships) {
    const positions = {};
    const centerX = 0;
    const centerY = 0;
    const spacing = 200;

    // Get relationship groups
    const siblings = relationships?.siblings || [];
    const parents = relationships?.parents || [];
    const spouses = relationships?.spouses || [];
    const children = relationships?.children || [];
    const grandparents = relationships?.grandparents || [];
    const grandchildren = relationships?.grandchildren || [];

    // Selected person and siblings on same row
    const siblingRow = [selectedPerson, ...siblings];
    siblingRow.forEach((person, index) => {
      const offset = (index - (siblingRow.length - 1) / 2) * spacing;
      positions[person.id] = { x: centerX + offset, y: centerY };
    });

    // Position parents above
    parents.forEach((parent, index) => {
      const offset = (index - (parents.length - 1) / 2) * spacing;
      positions[parent.id] = {
        x: centerX + offset,
        y: centerY - spacing * 1.5
      };
    });

    // Position parents' partnership node
    if (parents.length === 2) {
      const parent1Pos = positions[parents[0].id];
      const parent2Pos = positions[parents[1].id];
      const parentsPartnershipId = `partnership-${parents[0].id}-${parents[1].id}`;
      positions[parentsPartnershipId] = {
        x: (parent1Pos.x + parent2Pos.x) / 2,
        y: (parent1Pos.y + parent2Pos.y) / 2
      };
    }

    // Position grandparents above parents
    grandparents.forEach((grandparent, index) => {
      const offset = (index - (grandparents.length - 1) / 2) * spacing;
      positions[grandparent.id] = {
        x: centerX + offset,
        y: centerY - spacing * 3
      };
    });

    // Position spouses to the sides and create partnership nodes
    spouses.forEach((spouse, index) => {
      const side = index % 2 === 0 ? 1 : -1;
      const row = Math.floor(index / 2);
      const spouseX = centerX + side * spacing * 1.5;
      const spouseY = centerY + row * spacing * 0.5;

      positions[spouse.id] = { x: spouseX, y: spouseY };

      // Position partnership node midway between selected person and spouse
      const partnershipId = `partnership-${selectedPerson.id}-${spouse.id}`;
      positions[partnershipId] = {
        x: (centerX + spouseX) / 2,
        y: (centerY + spouseY) / 2
      };
    });

    // Position children below
    children.forEach((child, index) => {
      const offset = (index - (children.length - 1) / 2) * spacing;
      positions[child.id] = {
        x: centerX + offset,
        y: centerY + spacing * 1.5
      };
    });

    // Position grandchildren below children
    grandchildren.forEach((grandchild, index) => {
      const offset = (index - (grandchildren.length - 1) / 2) * spacing;
      positions[grandchild.id] = {
        x: centerX + offset,
        y: centerY + spacing * 3
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
