import { describe, it, expect } from 'vitest';
import { layoutChain, COLUMN, ROW } from '../src/chainLayout.js';

const chain = (...steps) => [{ id: 'R', step: null }, ...steps.map((text) => {
  const [step, id] = text.split(':');
  return { id, step };
})];
const at = (layout) => Object.fromEntries(layout.people.map(({ id, x, y }) => [id, [x / COLUMN, y / ROW]]));

describe('layoutChain', () => {
  it('stacks ancestors above the relative', () => {
    const layout = layoutChain(chain('parent:F', 'parent:GF', 'parent:GGF'));
    expect(at(layout)).toEqual({ R: [0, 0], F: [0, -1], GF: [0, -2], GGF: [0, -3] });
    expect(layout.links.map(({ source, target, kind, turn }) => [source, target, kind, turn])).toEqual([
      ['F', 'R', 'descent', undefined], ['GF', 'F', 'descent', undefined], ['GGF', 'GF', 'descent', undefined]
    ]);
  });

  it('puts a brother, sister or partner beside, to the right, and goes down to children', () => {
    const layout = layoutChain(chain('parent:F', 'sibling:U', 'child:C'));
    expect(at(layout)).toEqual({ R: [0, 0], F: [0, -1], U: [1, -1], C: [1, 0] });
    const bracket = layout.joints[0];
    expect(bracket.x).toBe(COLUMN / 2);
    expect(bracket.y).toBeLessThan(-ROW);
    expect(layout.links.filter(link => link.kind === 'siblings').map(link => [link.source, link.target])).toEqual([
      [bracket.id, 'F'], [bracket.id, 'U']
    ]);
    expect(layout.links.at(-1)).toMatchObject({ source: 'U', target: 'C', kind: 'descent' });
  });

  it('marks half brothers and sisters, and joins partners with a dot between them', () => {
    const layout = layoutChain(chain('halfSibling:H', 'spouse:W'));
    expect(at(layout)).toEqual({ R: [0, 0], H: [1, 0], W: [2, 0] });
    expect(layout.links.filter(link => link.kind === 'halfSiblings')).toHaveLength(2);
    const [dot] = layout.dots;
    expect(dot).toMatchObject({ x: 1.5 * COLUMN, y: 0 });
    expect(layout.links.filter(link => link.kind === 'marriage').map(link => [link.source, link.target])).toEqual([
      ['H', dot.id], ['W', dot.id]
    ]);
  });

  it('moves along to a free place when the path turns back on itself, and bends the line down', () => {
    // A child, then their other parent (no partner link between the two parents): back on the relative's row.
    const layout = layoutChain(chain('child:C', 'parent:O'));
    expect(at(layout)).toEqual({ R: [0, 0], C: [0, 1], O: [1, 0] });
    expect(layout.links[1]).toMatchObject({ source: 'O', target: 'C', kind: 'descent', turn: ROW / 2 });
    const places = layout.people.map(({ x, y }) => `${x},${y}`);
    expect(new Set(places).size).toBe(places.length);
  });

  it('draws one person alone', () => {
    expect(layoutChain(chain())).toEqual({ people: [{ id: 'R', x: 0, y: 0 }], dots: [], joints: [], links: [] });
  });
});
