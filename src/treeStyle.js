/**
 * How the family tree looks (Cytoscape styles), shared by the tree (familyTreeView.js) and the search page's
 * relationship chain (chainView.js), so the two look the same.
 */
import { avatarUrl } from './media.js';

/** A colour for each couple (treeLayout.js gives each family an index): its dot and every line of its family. */
export const FAMILY_COLOURS = ['#f472b6', '#a78bfa', '#34d399', '#fbbf24', '#38bdf8', '#fb7185'];
/** How rounded the bends in the lines down to the children are (graph units). */
export const BEND_RADIUS = 18;
export const colourOf = (index) => FAMILY_COLOURS[index % FAMILY_COLOURS.length];

/** A person's label: their name, and "b. 1901" under it when their birth year is known. */
export function personLabel(person) {
  const name = person.name || 'Unknown';
  const birthYear = person.birthDate ? person.birthDate.match(/\d{4}/)?.[0] || '' : '';
  return birthYear ? `${name}\nb. ${birthYear}` : name;
}

/** A person's picture, or the placeholder (media.js). */
export const personAvatar = (person) => avatarUrl(person);

/** The styles for Cytoscape's `style` option. */
export function treeStyle() {
  return [
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
      // The search page's relationship chain (chainView.js): a parent's line down to a child, an elbow when they
      // aren't in line; brothers and sisters joined by a bracket above them, dashed for half ones.
      selector: 'edge[type="descent"][turn]',
      style: {
        'curve-style': 'round-taxi',
        'taxi-direction': 'downward',
        'taxi-turn': 'data(turn)',
        'taxi-turn-min-distance': 0,
        'taxi-radius': BEND_RADIUS
      }
    },
    {
      // From the bracket's middle across to over a brother or sister, then down to them (all the way across first).
      selector: 'edge[type="siblings"], edge[type="halfSiblings"]',
      style: {
        'curve-style': 'round-taxi',
        'taxi-direction': 'horizontal',
        'taxi-turn': '100%',
        'taxi-turn-min-distance': 0,
        'taxi-radius': BEND_RADIUS
      }
    },
    {
      selector: 'edge[type="halfSiblings"]',
      style: {
        'line-style': 'dashed',
        'line-dash-pattern': [10, 7],
        'line-cap': 'butt'
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
  ];
}
