import cytoscape from 'cytoscape';
import { loadPersonWithFamily, prefetchFamily } from './dataLoader.js';
import { avatarUrl } from './media.js';
import { nameOf } from './familyLinks.js';
import { MIN_TARGET_PX, chooseZoom, horizontalPan } from './treePlacement.js';
import { layoutFamily } from './treeLayout.js';

/** The editors' "+" node, joined to the highlighted person, and the edge to it. */
const ADD_NODE_ID = 'add-relative';
const ADD_EDGE_ID = 'add-relative-edge';
/** The cytoscape events after which the "+" node is drawn somewhere else. */
const VIEWPORT_EVENTS = 'pan zoom resize';
/** A colour for each couple (treeLayout.js gives each family an index): its dot and every line of its family. */
const FAMILY_COLOURS = ['#f472b6', '#a78bfa', '#34d399', '#fbbf24', '#38bdf8', '#fb7185'];
/** How rounded the bends in the lines down to the children are (graph units). */
const BEND_RADIUS = 18;
/** How long the lines take to fade in when someone is shown (none for those who prefer reduced motion). */
const FADE_MS = 240;
const colourOf = (index) => FAMILY_COLOURS[index % FAMILY_COLOURS.length];

export class FamilyTreeView {
  constructor(containerElement) {
    this.container = containerElement;
    this.cy = null;
    this.selectedPersonId = null;
    this.onPersonSelectCallback = null;
    this.shownPerson = null;        // the highlighted person's record, from the last buildGraph
    this.graphData = null;          // buildGraph's arguments, to rebuild when the "+" node comes or goes
    this.addRelativeHandler = null; // ({ anchor, person }) → menu handle, for editors; null for everyone else
    this.addButton = null;          // the button over the "+" node, while there is a handler
    this.addMenu = null;            // what the handler returned (the open menu), until it is closed
    this.placeAddButton = this.placeAddButton.bind(this);

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
            // Within the node and a little of the gap either side, clear of the lines down from a couple's dot.
            'text-max-width': '160px',
            // Nearly opaque, so a line down from a lone parent passes cleanly behind the label.
            'text-background-color': 'rgb(17, 17, 28)',
            'text-background-opacity': 0.9,
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
        // A couple's dot, on their marriage line (treeLayout.js), ringed in the background colour so the lines
        // meeting it stop just short.
        {
          selector: 'node[type="partnership"]',
          style: {
            'width': 14,
            'height': 14,
            'background-color': 'data(colour)',
            'background-image': 'none',
            'border-width': 3,
            'border-color': 'rgb(17, 17, 28)',
            'label': '',
            'events': 'no',
            'z-index': 10
          }
        },
        // The invisible ends of the lines (treeLayout.js): every line runs straight from one to another.
        {
          selector: 'node[type="joint"]',
          style: {
            'width': 1,
            'height': 1,
            'opacity': 0,
            'background-image': 'none',
            'border-width': 0,
            'label': '',
            'events': 'no'
          }
        },
        // The editors' "+" node (setAddRelative): a dashed circle, a little smaller than a relative.
        {
          selector: 'node[type="add"]',
          style: {
            'width': 110,
            'height': 110,
            'background-color': '#1e1e2e',
            'background-image': 'none',
            'border-width': 4,
            'border-style': 'dashed',
            'border-color': '#00d4ff',
            'label': '+',
            'color': '#00d4ff',
            'font-size': '72px',
            'font-weight': '300',
            'text-valign': 'center',
            'text-halign': 'center',
            'text-margin-y': 0,
            'text-background-opacity': 0
          }
        },
        // Lines, under the people, in their family's colour: a couple's marriage line is straight; each child hangs
        // from their family's dot by one elbow, down to the family's bar, across and down, its bends rounded.
        {
          selector: 'edge',
          style: {
            'curve-style': 'straight',
            'width': 3,
            'line-color': 'data(colour)',
            'line-cap': 'round',
            'opacity': 1,
            'events': 'no'
          }
        },
        {
          selector: 'edge[type="link"]',
          style: {
            'curve-style': 'round-taxi',
            'taxi-direction': 'downward',
            'taxi-turn': 'data(turn)',
            'taxi-turn-min-distance': 0,
            'taxi-radius': BEND_RADIUS
          }
        },
        {
          selector: 'edge[type="add"]',
          style: {
            'line-color': '#00d4ff',
            'line-style': 'dashed',
            'line-cap': 'butt',
            'width': 2.5,
            'opacity': 0.7
          }
        },
        // Hover effects
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

      // Skip dots and line ends, and the "+" node (its button over it takes the taps)
      const type = node.data('type');
      if (type === 'partnership' || type === 'joint' || type === 'add') {
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
   * Load and display a person and their immediate family.
   * Returns null if a newer loadPerson() call started while this one was in flight.
   */
  async loadPerson(personId) {
    this.pendingPersonId = personId;
    const result = await loadPersonWithFamily(personId);
    if (this.pendingPersonId !== personId) return null;

    this.selectedPersonId = personId;
    this.buildGraph(result.person, result.family, result.relationships);
    prefetchFamily(result);
    return { person: result.person, relationships: result.relationships };
  }

  /**
   * Draws the person and their family where treeLayout.js puts them: people, couples' dots, and the straight lines
   * between them (from one invisible joint to another); for editors, the "+" node beside the person.
   */
  buildGraph(selectedPerson, familyMembers, relationships) {
    this.closeAddMenu();
    this.shownPerson = selectedPerson;
    this.graphData = [selectedPerson, familyMembers, relationships];
    const layout = layoutFamily({
      selected: selectedPerson, family: familyMembers, relationships, withAdd: Boolean(this.addRelativeHandler)
    });
    const records = new Map([[selectedPerson.id, selectedPerson], ...familyMembers.map(member => [member.id, member])]);
    const elements = [];

    for (const { id, x, y } of layout.people) {
      const record = records.get(id);
      elements.push({
        group: 'nodes',
        position: { x, y },
        data: {
          id,
          label: this.formatLabel(record),
          type: id === selectedPerson.id ? 'selected' : 'family',
          sex: record.sex,
          avatar: this.getAvatarPath(record)
        }
      });
    }
    for (const { id, x, y, color } of layout.dots) {
      elements.push({ group: 'nodes', position: { x, y }, data: { id, type: 'partnership', colour: colourOf(color) } });
    }
    // Marriage lines are drawn straight between their joints; the lines down to the children as one elbow each.
    const marriages = layout.lines.filter(line => line.kind === 'marriage');
    const used = new Set([...marriages.flatMap(line => [line.source, line.target]), ...layout.links.map(link => link.source)]);
    for (const { id, x, y } of layout.joints.filter(joint => used.has(joint.id))) {
      elements.push({ group: 'nodes', position: { x, y }, data: { id, type: 'joint' } });
    }
    for (const { id, source, target, color } of marriages) {
      elements.push({ group: 'edges', data: { id, source, target, type: 'line', colour: colourOf(color) } });
    }
    for (const { id, source, target, turn, color } of layout.links) {
      elements.push({ group: 'edges', data: { id, source, target, type: 'link', turn, colour: colourOf(color) } });
    }

    // For editors, the "+" node, joined to the selected person
    if (layout.add) {
      elements.push({ group: 'nodes', position: layout.add, data: { id: ADD_NODE_ID, type: 'add' } });
      elements.push({
        group: 'edges',
        data: { id: ADD_EDGE_ID, source: selectedPerson.id, target: ADD_NODE_ID, type: 'add' }
      });
    }

    this.updateGraph(elements);
  }

  /**
   * Update the graph when switching between people (without animation)
   */
  updateGraph(elements) {
    this.cy.elements().remove();
    this.cy.add(elements);
    // Fit to fill height and center horizontally
    this.fitToHeight();
    this.placeAddButton();
    this.fadeInLines();
  }

  /** The family's lines fade in as someone is shown, unless the reader prefers reduced motion. */
  fadeInLines() {
    if (globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const lines = this.cy.edges('[type="line"], [type="link"]');
    lines.style('opacity', 0);
    lines.animate({ style: { opacity: 1 } }, { duration: FADE_MS, easing: 'ease-out-quad' });
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

    // Cap zoom to prevent nodes from being too large when there are fewer generations
    // Maximum zoom of 1.0 keeps nodes at their natural size (135-180px)
    const maxZoom = 1.0;

    // Zoom to fit the height; an editor's tree, widened by the "+", may zoom out a little to fit the width
    const addNode = cy.getElementById(ADD_NODE_ID);
    const zoom = chooseZoom({ bb, width: w, height: h, margin: verticalMargin, maxZoom, hasAdd: !addNode.empty() });

    // Centred when the graph fits the width; else the selected person on the left with a margin, and an
    // editor's "+" on their left kept in view
    const selectedNode = cy.nodes('[type="selected"]');
    const panX = horizontalPan({
      bb, zoom, width: w,
      selectedX: selectedNode.length > 0 ? selectedNode.position().x : null,
      add: selectedNode.length > 0 && !addNode.empty() ? { x: addNode.position().x, width: addNode.outerWidth() } : null
    });

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
   * Get avatar path for a person, with fallback to man.png or woman.png
   */
  getAvatarPath(person) {
    return avatarUrl(person);
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
   * Select a different person (main.js loads and renders them)
   */
  selectPerson(personId) {
    this.onPersonSelectCallback?.(personId);
  }

  /**
   * Set callback for when a person is selected
   */
  onPersonSelect(callback) {
    this.onPersonSelectCallback = callback;
  }

  /**
   * For editors, a "+" node joined to the highlighted person, with a button over it that calls
   * `handler({ anchor: button, person })` (person: the record shown when it was pressed). What the handler
   * returns (the menu it opened, `{ close, isOpen }`) is closed when the tree is rebuilt, when the handler is
   * cleared, or on a second press. With null (viewers, signed out) there is no node and no button. The tree
   * already shown is rebuilt when the node comes or goes.
   */
  setAddRelative(handler) {
    const next = typeof handler === 'function' ? handler : null;
    const changed = Boolean(next) !== Boolean(this.addRelativeHandler);
    this.addRelativeHandler = next;
    if (!changed) return;
    if (next) {
      this.createAddButton();
    } else {
      this.closeAddMenu();
      this.removeAddButton();
    }
    if (this.graphData) this.buildGraph(...this.graphData);
  }

  /** The button over the "+" node: a real button, so it can take focus and has a name, kept over the node. */
  createAddButton() {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tree-add-relative';
    button.hidden = true; // until there is a node to sit over
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'false');
    // Cytoscape listens on its container, which holds the button: it would take a press here for a tap on the
    // node or the start of a pan, and its touch handling would cancel the click.
    for (const type of ['pointerdown', 'mousedown', 'touchstart']) {
      button.addEventListener(type, (event) => event.stopPropagation());
    }
    button.addEventListener('click', () => {
      if (this.addMenu?.isOpen?.()) {
        this.closeAddMenu();
        return;
      }
      if (!this.addRelativeHandler || !this.shownPerson) return;
      this.addMenu = this.addRelativeHandler({ anchor: button, person: this.shownPerson }) ?? null;
    });
    this.container.appendChild(button);
    this.addButton = button;
    this.cy.on(VIEWPORT_EVENTS, this.placeAddButton);
  }

  removeAddButton() {
    this.cy.off(VIEWPORT_EVENTS, this.placeAddButton);
    const button = this.addButton;
    this.addButton = null;
    if (!button) return;
    // Focus on the button (or given back to it by its closing menu) would fall to the page when it goes, as on
    // signing out: it goes to the tree instead, focusable by script only.
    if (button.contains(document.activeElement)) {
      if (!this.container.hasAttribute('tabindex')) this.container.tabIndex = -1;
      this.container.focus({ preventScroll: true });
    }
    button.remove();
  }

  closeAddMenu() {
    const menu = this.addMenu;
    this.addMenu = null;
    menu?.close?.();
  }

  /**
   * Puts the button over the "+" node as drawn now, at least MIN_TARGET_PX square, with the person's name;
   * hidden while there is no node, or the node is panned out of the tree.
   */
  placeAddButton() {
    const button = this.addButton;
    if (!button) return;
    const node = this.cy.getElementById(ADD_NODE_ID);
    if (!this.shownPerson || node.empty()) {
      button.hidden = true;
      return;
    }
    button.setAttribute('aria-label', `Add a relative to ${nameOf(this.shownPerson)}`);
    const { x, y } = node.renderedPosition();
    const size = Math.max(MIN_TARGET_PX, node.renderedOuterWidth(), node.renderedOuterHeight());
    const half = size / 2;
    button.hidden = x + half < 0 || y + half < 0 || x - half > this.cy.width() || y - half > this.cy.height();
    button.style.left = `${x - half}px`;
    button.style.top = `${y - half}px`;
    button.style.width = `${size}px`;
    button.style.height = `${size}px`;
  }
}
