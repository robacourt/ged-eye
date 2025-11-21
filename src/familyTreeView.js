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
            'background-color': 'data(partnershipColor)',
            'border-width': 2,
            'border-color': '#666',
            'label': ''
          }
        },
        {
          selector: 'node[type="partnership"][!partnershipColor]',
          style: {
            'background-color': '#aaa'
          }
        },
        // Edge styles
        {
          selector: 'edge',
          style: {
            'width': 3,
            'line-color': '#666',
            'target-arrow-color': '#666',
            'curve-style': 'unbundled-bezier',
            'control-point-distances': [40, -40],
            'control-point-weights': [0.25, 0.75],
            'opacity': 0.8
          }
        },
        {
          selector: 'edge[type="spouse"]',
          style: {
            'line-color': 'data(partnershipColor)',
            'width': 3,
            'opacity': 0.85,
            'curve-style': 'round-taxi',
            'taxi-direction': 'horizontal',
            'taxi-turn': 20,
            'taxi-turn-min-distance': 5
          }
        },
        {
          selector: 'edge[type="spouse"][!partnershipColor]',
          style: {
            'line-color': '#ff6b9d'
          }
        },
        {
          selector: 'edge[type="parent"]',
          style: {
            'line-color': 'data(partnershipColor)',
            'target-arrow-shape': 'triangle',
            'target-arrow-color': 'data(partnershipColor)',
            'width': 2.5,
            'opacity': 0.85,
            'curve-style': 'round-taxi',
            'taxi-direction': 'vertical',
            'taxi-turn': 20,
            'taxi-turn-min-distance': 5
          }
        },
        {
          selector: 'edge[type="parent"][!partnershipColor]',
          style: {
            'line-color': '#8ab4f8',
            'target-arrow-color': '#8ab4f8'
          }
        },
        // Hover effects
        {
          selector: 'edge:active',
          style: {
            'opacity': 1,
            'width': 4,
            'z-index': 999
          }
        },
        {
          selector: 'node:active',
          style: {
            'overlay-opacity': 0.2,
            'overlay-color': '#fff'
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

      console.log('Person data:', person);
      console.log('Relationships:', relationships);

      // Build the graph
      this.buildGraph(person, family, relationships);

      return person;
    } catch (error) {
      console.error('Error loading person:', error);
      console.error('Person ID:', personId);
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

    // Partnership colors for multiple relationships
    const partnershipColors = [
      '#ff6b9d', // Pink
      '#9d6bff', // Purple
      '#6bffa8', // Green
      '#ffb36b', // Orange
      '#6bb3ff', // Light blue
      '#ff6b6b'  // Red
    ];

    // Add partnership nodes and edges for spouses
    selectedPerson.spouseIds.forEach((spouseId, index) => {
      const partnershipId = `partnership-${selectedPerson.id}-${spouseId}`;
      const color = partnershipColors[index % partnershipColors.length];

      // Add partnership node with color and index
      elements.push({
        group: 'nodes',
        data: {
          id: partnershipId,
          type: 'partnership',
          partnershipIndex: index,
          partnershipColor: color
        }
      });

      // Connect selected person to partnership
      elements.push({
        group: 'edges',
        data: {
          id: `${selectedPerson.id}-${partnershipId}`,
          source: selectedPerson.id,
          target: partnershipId,
          type: 'spouse',
          partnershipColor: color
        }
      });

      // Connect spouse to partnership
      elements.push({
        group: 'edges',
        data: {
          id: `${spouseId}-${partnershipId}`,
          source: spouseId,
          target: partnershipId,
          type: 'spouse',
          partnershipColor: color
        }
      });
    });

    // Create partnership nodes for all unique parent pairs (including half-siblings' parents)
    const parentPartnerships = new Map(); // Map of "parentId1-parentId2" -> [children]

    // Add selected person's parents partnership (when selected person is a child)
    if (selectedPerson.parentIds.length === 2) {
      const key = selectedPerson.parentIds.sort().join('-');
      if (!parentPartnerships.has(key)) {
        parentPartnerships.set(key, []);
      }
      parentPartnerships.get(key).push(selectedPerson);
    }

    // Add siblings to their parent partnerships
    if (relationships?.siblings) {
      for (const sibling of relationships.siblings) {
        if (sibling.parentIds && sibling.parentIds.length === 2) {
          const key = sibling.parentIds.sort().join('-');
          if (!parentPartnerships.has(key)) {
            parentPartnerships.set(key, []);
          }
          parentPartnerships.get(key).push(sibling);
        }
      }
    }

    // Add selected person's children partnerships (when selected person is a parent)
    if (relationships?.children) {
      for (const child of relationships.children) {
        if (child.parentIds && child.parentIds.length === 2) {
          const key = child.parentIds.sort().join('-');
          if (!parentPartnerships.has(key)) {
            parentPartnerships.set(key, []);
          }
          parentPartnerships.get(key).push(child);
        }
      }
    }

    // Add grandchildren partnerships
    if (relationships?.grandchildren) {
      for (const grandchild of relationships.grandchildren) {
        if (grandchild.parentIds && grandchild.parentIds.length === 2) {
          const key = grandchild.parentIds.sort().join('-');
          if (!parentPartnerships.has(key)) {
            parentPartnerships.set(key, []);
          }
          parentPartnerships.get(key).push(grandchild);
        }
      }
    }

    // Get set of all node IDs that exist in the graph
    const existingNodeIds = new Set([
      selectedPerson.id,
      ...familyMembers.map(m => m.id)
    ]);

    // Track children whose partnerships were skipped
    const childrenWithSkippedPartnerships = [];

    // Track partnership colors and indices
    const partnershipColorMap = new Map();
    const partnershipIndexMap = new Map();

    // Group partnerships by each parent to assign indices
    const partnershipsByParent = new Map(); // parent ID -> array of partnership keys

    // Collect all partnerships and group by parent
    for (const [parentKey] of parentPartnerships.entries()) {
      const [parent1Id, parent2Id] = parentKey.split('-');

      if (!partnershipsByParent.has(parent1Id)) {
        partnershipsByParent.set(parent1Id, []);
      }
      partnershipsByParent.get(parent1Id).push(parentKey);

      if (!partnershipsByParent.has(parent2Id)) {
        partnershipsByParent.set(parent2Id, []);
      }
      partnershipsByParent.get(parent2Id).push(parentKey);
    }

    // Assign indices and colors for each person's partnerships
    partnershipsByParent.forEach((partnerships, parentId) => {
      partnerships.forEach((partnershipKey, index) => {
        // Only set if not already set (avoid overwriting)
        if (!partnershipIndexMap.has(partnershipKey)) {
          partnershipIndexMap.set(partnershipKey, index);
          const color = partnershipColors[index % partnershipColors.length];
          partnershipColorMap.set(partnershipKey, color);
        }
      });
    });

    // Create partnership nodes and connections for each parent pair
    for (const [parentKey, children] of parentPartnerships.entries()) {
      const [parent1Id, parent2Id] = parentKey.split('-');

      // Only create partnership if both parents are in the graph
      if (!existingNodeIds.has(parent1Id) || !existingNodeIds.has(parent2Id)) {
        console.warn(`Skipping partnership ${parent1Id}-${parent2Id}: one or both parents not in graph`);
        // Track these children for direct connection
        for (const child of children) {
          childrenWithSkippedPartnerships.push({
            child,
            parentIds: [parent1Id, parent2Id]
          });
        }
        continue;
      }

      const partnershipId = `partnership-${parent1Id}-${parent2Id}`;
      const partnershipColor = partnershipColorMap.get(parentKey) || '#aaa';
      const partnershipIndex = partnershipIndexMap.get(parentKey) || 0;

      // Add partnership node
      elements.push({
        group: 'nodes',
        data: {
          id: partnershipId,
          type: 'partnership',
          partnershipColor: partnershipColor,
          partnershipIndex: partnershipIndex
        }
      });

      // Connect parents to partnership
      elements.push({
        group: 'edges',
        data: {
          id: `${parent1Id}-${partnershipId}`,
          source: parent1Id,
          target: partnershipId,
          type: 'spouse',
          partnershipColor: partnershipColor
        }
      });

      elements.push({
        group: 'edges',
        data: {
          id: `${parent2Id}-${partnershipId}`,
          source: parent2Id,
          target: partnershipId,
          type: 'spouse',
          partnershipColor: partnershipColor
        }
      });

      // Connect partnership to all children from this partnership
      for (const child of children) {
        elements.push({
          group: 'edges',
          data: {
            id: `${partnershipId}-${child.id}`,
            source: partnershipId,
            target: child.id,
            type: 'parent',
            partnershipColor: partnershipColor
          }
        });
      }
    }

    // Handle children whose partnerships were skipped (parent not in graph)
    for (const { child, parentIds } of childrenWithSkippedPartnerships) {
      // Connect to whichever parent IS in the graph
      for (const parentId of parentIds) {
        if (existingNodeIds.has(parentId)) {
          elements.push({
            group: 'edges',
            data: {
              id: `${parentId}-${child.id}-partial`,
              source: parentId,
              target: child.id,
              type: 'parent'
            }
          });
          break; // Only connect once
        }
      }
    }

    // Handle single parent cases (children who only have one parent listed)
    if (selectedPerson.parentIds.length === 1) {
      const parentId = selectedPerson.parentIds[0];
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

    // Handle siblings with single parents
    if (relationships?.siblings) {
      for (const sibling of relationships.siblings) {
        if (sibling.parentIds && sibling.parentIds.length === 1) {
          const parentId = sibling.parentIds[0];
          elements.push({
            group: 'edges',
            data: {
              id: `${parentId}-${sibling.id}-single`,
              source: parentId,
              target: sibling.id,
              type: 'parent'
            }
          });
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

    // Handle children with single parents (no partnership)
    if (relationships?.children) {
      for (const child of relationships.children) {
        if (child.parentIds && child.parentIds.length === 1 && child.parentIds[0] === selectedPerson.id) {
          elements.push({
            group: 'edges',
            data: {
              id: `${selectedPerson.id}-${child.id}-single`,
              source: selectedPerson.id,
              target: child.id,
              type: 'parent'
            }
          });
        }
      }
    }

    // Handle grandchildren with single parents (no partnership)
    if (relationships?.grandchildren) {
      for (const grandchild of relationships.grandchildren) {
        if (grandchild.parentIds && grandchild.parentIds.length === 1) {
          const parentId = grandchild.parentIds[0];
          elements.push({
            group: 'edges',
            data: {
              id: `${parentId}-${grandchild.id}-single`,
              source: parentId,
              target: grandchild.id,
              type: 'parent'
            }
          });
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
      padding: 50,
      ranker: 'network-simplex' // Better ranking algorithm
    });

    layout.run();

    // After layout, adjust partnership node positions to spread them vertically
    setTimeout(() => {
      const partnershipNodes = this.cy.nodes('[type="partnership"]');

      // Offset each partnership based on its index
      partnershipNodes.forEach(node => {
        const index = node.data('partnershipIndex');
        if (index !== undefined && index > 0) {
          const currentPos = node.position();
          const verticalOffset = index * 50; // 50px per additional partnership
          node.position({
            x: currentPos.x,
            y: currentPos.y + verticalOffset
          });
        }
      });

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
