/**
 * The search page's relationship chain (relationshipPage.js): the people on the path from the relative to the
 * person found, drawn as the tree is (treeStyle.js) where chainLayout.js puts them, fitted to the room, and the
 * person found larger, as the highlighted person is on the tree. Tapping someone calls `onPersonSelect(id)`.
 */
import cytoscape from 'cytoscape';
import { layoutChain } from './chainLayout.js';
import { colourOf, personAvatar, personLabel, treeStyle } from './treeStyle.js';

/** Blood relations in the first family colour, marriages in the second. */
const BLOOD = colourOf(0);
const MARRIAGE = colourOf(1);

export class ChainView {
  constructor(container, { onPersonSelect } = {}) {
    this.cy = cytoscape({
      container,
      style: treeStyle(),
      layout: { name: 'preset' },
      userZoomingEnabled: false,
      userPanningEnabled: true,
      boxSelectionEnabled: false,
      autoungrabify: true
    });
    this.cy.on('tap', 'node[type="selected"], node[type="family"]', (event) => onPersonSelect?.(event.target.id()));
  }

  /** Draws `path` (GET /relationship's `[{ id, name, sex, birthDate, avatarKey, step }]`), the last person larger. */
  show(path) {
    const layout = layoutChain(path);
    const records = new Map(path.map(person => [person.id, person]));
    const found = path[path.length - 1].id;
    const elements = [
      ...layout.people.map(({ id, x, y }) => {
        const record = records.get(id);
        return {
          group: 'nodes',
          position: { x, y },
          data: { id, type: id === found ? 'selected' : 'family', label: personLabel(record), sex: record.sex, avatar: personAvatar(record) }
        };
      }),
      ...layout.dots.map(({ id, x, y }) => ({ group: 'nodes', position: { x, y }, data: { id, type: 'partnership', colour: MARRIAGE } })),
      ...layout.joints.map(({ id, x, y }) => ({ group: 'nodes', position: { x, y }, data: { id, type: 'joint' } })),
      ...layout.links.map(({ id, source, target, kind, turn }) => ({
        group: 'edges',
        data: { id, source, target, type: kind, colour: kind === 'marriage' ? MARRIAGE : BLOOD, ...(turn === undefined ? {} : { turn }) }
      }))
    ];
    this.cy.elements().remove();
    this.cy.add(elements);
    this.fit();
  }

  /** Fits the chain to the room, never larger than natural size. */
  fit() {
    this.cy.resize();
    this.cy.fit(undefined, 24);
    if (this.cy.zoom() > 1) {
      this.cy.zoom(1);
      this.cy.center();
    }
  }

  clear() {
    this.cy.elements().remove();
  }

  destroy() {
    this.cy.destroy();
  }
}
