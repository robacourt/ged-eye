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

      userZoomingEnabled: false,
      userPanningEnabled: true,
      boxSelectionEnabled: false,
      autoungrabify: true  // Prevent nodes from being dragged
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

    // Allow right-click context menu by not preventing default on the canvas
    // Wait for canvas to be created
    setTimeout(() => {
      const canvas = this.container.querySelector('canvas');
      if (canvas) {
        canvas.addEventListener('contextmenu', (event) => {
          // Allow the default context menu - don't call preventDefault
          event.stopPropagation();
        }, true);
      }
    }, 100);
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

    // Create a map of person IDs to names for debugging
    const personNames = new Map();
    personNames.set(selectedPerson.id, selectedPerson.name);
    familyMembers.forEach(m => personNames.set(m.id, m.name));
    relationships?.spouses?.forEach(s => personNames.set(s.id, s.name));
    relationships?.children?.forEach(c => personNames.set(c.id, c.name));
    relationships?.parents?.forEach(p => personNames.set(p.id, p.name));
    relationships?.siblings?.forEach(s => personNames.set(s.id, s.name));

    // Add selected person node
    elements.push({
      group: 'nodes',
      data: {
        id: selectedPerson.id,
        label: this.formatLabel(selectedPerson),
        type: 'selected',
        sex: selectedPerson.sex,
        avatar: this.getAvatarPath(selectedPerson)
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
          avatar: this.getAvatarPath(member)
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

    // Get set of all node IDs that exist in the graph (for checking spouse existence)
    const existingNodeIds = new Set([
      selectedPerson.id,
      ...familyMembers.map(m => m.id)
    ]);

    // Track which partnerships have been created to avoid duplicates
    const createdPartnerships = new Set();
    const partnershipIdMap = new Map(); // Map partnershipKey -> actual partnershipId

    // Add partnership nodes and edges for spouses
    selectedPerson.spouseIds.forEach((spouseId, index) => {
      const partnershipKey = [selectedPerson.id, spouseId].sort().join('-');
      const partnershipId = `partnership-${selectedPerson.id}-${spouseId}`;
      const color = partnershipColors[index % partnershipColors.length];

      // Check if spouse exists in graph
      const spouseExists = existingNodeIds.has(spouseId);

      // Check if this partnership has children that are visible in the graph
      const hasVisibleChildren = relationships?.children?.some(child => {
        if (child.parentIds && child.parentIds.length === 2) {
          const childParentKey = child.parentIds.sort().join('-');
          // Child must match this partnership AND be in the graph
          return childParentKey === partnershipKey && existingNodeIds.has(child.id);
        }
        return false;
      });

      // Skip partnership node if spouse doesn't exist AND there are no visible children
      if (!spouseExists && !hasVisibleChildren) {
        console.log(`Skipping partnership: ${selectedPerson.name} + ${personNames.get(spouseId) || spouseId} (spouse not in graph, no visible children)`);
        return;
      }

      if (spouseExists || hasVisibleChildren) {
        console.log(`Creating partnership: ${selectedPerson.name} + ${personNames.get(spouseId) || spouseId} (spouse exists: ${spouseExists}, has visible children: ${hasVisibleChildren})`);
      }

      // Mark this partnership as created and store the ID
      createdPartnerships.add(partnershipKey);
      partnershipIdMap.set(partnershipKey, partnershipId);

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

      // Connect spouse to partnership (only if spouse exists)
      if (spouseExists) {
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
      }
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

      // If this partnership was already created in the spouse section, just add the child edges
      if (createdPartnerships.has(parentKey)) {
        console.log(`Partnership already exists: ${personNames.get(parent1Id) || parent1Id} + ${personNames.get(parent2Id) || parent2Id}, adding child connections`);

        // The partnership node already exists, get the actual partnership ID that was created
        const partnershipId = partnershipIdMap.get(parentKey);
        const partnershipColor = partnershipColorMap.get(parentKey) || '#aaa';

        for (const child of children) {
          if (existingNodeIds.has(child.id)) {
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
        continue;
      }

      const parent1Exists = existingNodeIds.has(parent1Id);
      const parent2Exists = existingNodeIds.has(parent2Id);

      // Check if any children from this partnership are visible in the graph
      const hasVisibleChildren = children.some(child => existingNodeIds.has(child.id));

      // Skip partnership if both parents aren't in graph OR if there are no visible children
      if (!parent1Exists || !parent2Exists || !hasVisibleChildren) {
        console.log(`Skipping parent partnership: ${personNames.get(parent1Id) || parent1Id} + ${personNames.get(parent2Id) || parent2Id} (parent1 exists: ${parent1Exists}, parent2 exists: ${parent2Exists}, has visible children: ${hasVisibleChildren})`);
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


    // Update graph without animation
    this.updateGraph(elements);
  }

  /**
   * Update the graph when switching between people (without animation)
   */
  updateGraph(elements) {
    // Clear the existing graph
    this.cy.elements().remove();

    // Add all new elements
    this.cy.add(elements);

    // Run layout to calculate positions
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

    // Fit to fill height and center horizontally
    this.fitToHeight();
  }

  /**
   * Fit graph to fill the full height with margins, ensuring selected person is visible
   */
  fitToHeight() {
    const cy = this.cy;
    const bb = cy.elements().boundingBox();
    const w = cy.width();
    const h = cy.height();

    // Calculate vertical margins (top and bottom)
    const verticalMargin = 20;
    const availableHeight = h - (2 * verticalMargin);

    // Calculate zoom to fit height
    let zoom = availableHeight / bb.h;

    // Cap zoom to prevent nodes from being too large when there are fewer generations
    // Maximum zoom of 1.0 keeps nodes at their natural size (135-180px)
    const maxZoom = 1.0;
    zoom = Math.min(zoom, maxZoom);

    // Get the selected person's position
    const selectedNode = cy.nodes('[type="selected"]');
    let panX;

    const graphWidth = bb.w * zoom;

    if (graphWidth <= w) {
      // Graph fits within viewport - center it horizontally
      panX = (w - graphWidth) / 2 - bb.x1 * zoom;
    } else if (selectedNode.length > 0) {
      // Graph is wider than viewport - position selected person on left with margin
      const selectedPos = selectedNode.position();
      const horizontalMargin = 100;
      panX = horizontalMargin - selectedPos.x * zoom;
    } else {
      // Fallback: center horizontally
      panX = (w - graphWidth) / 2 - bb.x1 * zoom;
    }

    const pan = {
      x: panX,
      y: verticalMargin - bb.y1 * zoom
    };

    cy.viewport({
      zoom: zoom,
      pan: pan
    });
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
   * Get avatar path for a person, with fallback to man.png or woman.png
   */
  getAvatarPath(person) {
    if (person.avatar) {
      return `${import.meta.env.BASE_URL}${person.avatar}`;
    }

    // Use gender-specific fallback
    if (person.sex === 'M') {
      return `${import.meta.env.BASE_URL}avatars/man.png`;
    } else if (person.sex === 'F') {
      return `${import.meta.env.BASE_URL}avatars/woman.png`;
    }

    // Default fallback if sex is not specified
    return `${import.meta.env.BASE_URL}avatars/man.png`;
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
