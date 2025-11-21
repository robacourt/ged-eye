import cytoscape from 'cytoscape';
import dagre from 'cytoscape-dagre';
import { loadPersonWithFamily } from './dataLoader.js';
import { PhotoViewer } from './photoViewer.js';

// Register the dagre layout
cytoscape.use(dagre);

export class FamilyTreeView {
  constructor(containerElement) {
    this.container = containerElement;
    this.cy = null;
    this.selectedPersonId = null;
    this.onPersonSelectCallback = null;
    this.photoViewer = new PhotoViewer();
    this.personDataCache = new Map(); // Cache person data for photo viewer

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
            'width': 135,
            'height': 135,
            'background-color': '#3a3a4a',
            'background-fit': 'cover',
            'background-clip': 'node',
            'background-image': 'data(avatar)',
            'border-width': 4,
            'border-color': '#555',
            'shape': 'ellipse',
            'label': 'data(label)',
            'text-valign': 'bottom',
            'text-halign': 'center',
            'text-margin-y': 15,
            'color': '#fff',
            'font-size': '14px',
            'font-weight': '500',
            'text-wrap': 'wrap',
            'text-max-width': '200px',
            'text-background-color': 'rgba(0, 0, 0, 0.6)',
            'text-background-opacity': 1,
            'text-background-padding': '5px',
            'text-background-shape': 'roundrectangle',
            'transition-property': 'width, height, border-color, background-color',
            'transition-duration': '0.3s',
            'cursor': 'pointer'
          }
        },
        {
          selector: 'node[type="selected"]',
          style: {
            'width': 180,
            'height': 180,
            'border-color': '#00d4ff',
            'border-width': 6,
            'z-index': 100,
            'font-size': '16px',
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

      // Skip partnership nodes
      if (node.data('type') === 'partnership') {
        return;
      }

      // Select the person (no action on re-clicking selected person)
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

      // Cache person data for photo viewer
      this.personDataCache.set(person.id, person);
      family.forEach(member => {
        this.personDataCache.set(member.id, member);
      });

      // Build the graph
      this.buildGraph(person, family, relationships);

      return { person, relationships };
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
        sex: selectedPerson.sex,
        avatar: selectedPerson.avatar ? `${import.meta.env.BASE_URL}${selectedPerson.avatar}` : null
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
          sex: member.sex,
          avatar: member.avatar ? `${import.meta.env.BASE_URL}${member.avatar}` : null
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


    // Animate transitions between graph states
    this.animateGraphTransition(elements);
  }

  /**
   * Animate smooth transitions when switching between people
   */
  animateGraphTransition(newElements) {
    // Save current positions of all existing nodes
    const oldPositions = new Map();
    this.cy.nodes().forEach(node => {
      oldPositions.set(node.id(), { x: node.position().x, y: node.position().y });
    });

    // Create sets of IDs for comparison
    const newNodeIds = new Set(newElements.filter(e => e.group === 'nodes').map(e => e.data.id));
    const newEdgeIds = new Set(newElements.filter(e => e.group === 'edges').map(e => e.data.id));
    const existingNodeIds = new Set(this.cy.nodes().map(n => n.id()));
    const existingEdgeIds = new Set(this.cy.edges().map(e => e.id()));

    // Identify nodes/edges to keep, add, or remove
    const nodesToRemove = [...existingNodeIds].filter(id => !newNodeIds.has(id));
    const edgesToRemove = [...existingEdgeIds].filter(id => !newEdgeIds.has(id));
    const edgesToAdd = newElements.filter(e => e.group === 'edges' && !existingEdgeIds.has(e.data.id));
    const nodesToAdd = [...newNodeIds].filter(id => !existingNodeIds.has(id));

    // Remove old elements immediately (no animation for now, to keep it simple)
    const elementsToRemove = this.cy.collection();
    nodesToRemove.forEach(id => elementsToRemove.merge(this.cy.getElementById(id)));
    edgesToRemove.forEach(id => elementsToRemove.merge(this.cy.getElementById(id)));
    elementsToRemove.remove();

    // Update data for nodes that are staying
    newElements.filter(e => e.group === 'nodes' && existingNodeIds.has(e.data.id)).forEach(element => {
      const node = this.cy.getElementById(element.data.id);
      Object.keys(element.data).forEach(key => {
        node.data(key, element.data[key]);
      });
    });

    // Add new nodes and edges
    const elementsToAdd = [];
    nodesToAdd.forEach(id => {
      const element = newElements.find(e => e.group === 'nodes' && e.data.id === id);
      if (element) elementsToAdd.push(element);
    });
    edgesToAdd.forEach(edge => elementsToAdd.push(edge));

    if (elementsToAdd.length > 0) {
      this.cy.add(elementsToAdd);
    }

    // Run layout to calculate new positions
    const layout = this.cy.layout({
      name: 'dagre',
      rankDir: 'TB',
      nodeSep: 40,
      rankSep: 80,
      padding: 30,
      ranker: 'network-simplex',
      animate: false
    });

    layout.run();

    // Adjust partnership positions
    this.cy.nodes('[type="partnership"]').forEach(node => {
      const index = node.data('partnershipIndex');
      if (index !== undefined && index > 0) {
        const pos = node.position();
        node.position({ x: pos.x, y: pos.y + index * 50 });
      }
    });

    // Now animate nodes from old positions to new positions
    this.cy.nodes().forEach(node => {
      const oldPos = oldPositions.get(node.id());
      const newPos = { x: node.position().x, y: node.position().y };

      if (oldPos) {
        // Node existed before - animate from old to new position
        node.position(oldPos);
        node.animate({
          position: newPos,
          duration: 500,
          easing: 'ease-in-out-cubic'
        });
      } else {
        // New node - fade in at its position
        node.style('opacity', 0);
        node.animate({
          style: { opacity: 1 },
          duration: 500,
          easing: 'ease-in-out-cubic'
        });
      }
    });

    // Fit the view
    setTimeout(() => {
      this.cy.fit(50);
    }, 500);
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
