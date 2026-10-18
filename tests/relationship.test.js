// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { familyGraph, shortestPath } from '../api/relationship.js';

/**
 * A family tree:
 *   GGF+GGM ─ GF (+GM) ─ F (+M) ─ ME, SIS          F (+M2) ─ HALF
 *                      └ UNC (+AUNTW) ─ COUS ─ COUSKID
 *   ME + WIFE ─ SON (+SONW) ;  WIFE's parents WF+WM, WIFE's brother WB ; WIFE's earlier child STEP (with EX)
 *   LONER: no family at all. ORPH1, ORPH2: children of a family with no partners.
 */
const families = [
  { id: 'F1', partner1_id: 'GGF', partner2_id: 'GGM' },
  { id: 'F2', partner1_id: 'GF', partner2_id: 'GM' },
  { id: 'F3', partner1_id: 'F', partner2_id: 'M' },
  { id: 'F4', partner1_id: 'F', partner2_id: 'M2' },
  { id: 'F5', partner1_id: 'UNC', partner2_id: 'AUNTW' },
  { id: 'F6', partner1_id: 'COUS', partner2_id: null },
  { id: 'F7', partner1_id: 'ME', partner2_id: 'WIFE' },
  { id: 'F8', partner1_id: 'SON', partner2_id: 'SONW' },
  { id: 'F9', partner1_id: 'WF', partner2_id: 'WM' },
  { id: 'F10', partner1_id: 'EX', partner2_id: 'WIFE' },
  { id: 'F11', partner1_id: null, partner2_id: null }
];
const children = [
  ['F1', 'GF'], ['F2', 'F'], ['F2', 'UNC'], ['F3', 'ME'], ['F3', 'SIS'], ['F4', 'HALF'], ['F5', 'COUS'], ['F6', 'COUSKID'],
  ['F7', 'SON'], ['F9', 'WIFE'], ['F9', 'WB'], ['F10', 'STEP'], ['F11', 'ORPH1'], ['F11', 'ORPH2']
].map(([family_id, child_id]) => ({ family_id, child_id }));

const graph = familyGraph(families, children);
const path = (from, to) => shortestPath(graph, from, to)?.map(({ id, step }) => (step ? `${step}:${id}` : id)) ?? null;

describe('familyGraph', () => {
  it('links children and parents both ways, and partners', () => {
    const steps = (from) => (graph.get(from) ?? []).map(({ to, step }) => `${step}:${to}`).sort();
    expect(steps('ME')).toEqual(['parent:F', 'parent:M', 'sibling:SIS', 'halfSibling:HALF', 'spouse:WIFE', 'child:SON'].sort());
    expect(steps('COUSKID')).toEqual(['parent:COUS']);
  });

  it('makes brothers and sisters of a family with no partners recorded', () => {
    expect(path('ORPH1', 'ORPH2')).toEqual(['ORPH1', 'sibling:ORPH2']);
  });
});

describe('shortestPath', () => {
  it('goes up and down generations', () => {
    expect(path('ME', 'GGF')).toEqual(['ME', 'parent:F', 'parent:GF', 'parent:GGF']);
    expect(path('GGF', 'ME')).toEqual(['GGF', 'child:GF', 'child:F', 'child:ME']);
  });

  it('crosses to a brother or sister by the sibling link, not up and down', () => {
    expect(path('ME', 'SIS')).toEqual(['ME', 'sibling:SIS']);
    expect(path('ME', 'HALF')).toEqual(['ME', 'halfSibling:HALF']);
    expect(path('ME', 'COUS')).toEqual(['ME', 'parent:F', 'sibling:UNC', 'child:COUS']);
    expect(path('ME', 'COUSKID')).toEqual(['ME', 'parent:F', 'sibling:UNC', 'child:COUS', 'child:COUSKID']);
  });

  it('goes through a marriage only when it must', () => {
    expect(path('ME', 'WF')).toEqual(['ME', 'spouse:WIFE', 'parent:WF']);
    expect(path('ME', 'WB')).toEqual(['ME', 'spouse:WIFE', 'sibling:WB']);
    expect(path('ME', 'STEP')).toEqual(['ME', 'spouse:WIFE', 'child:STEP']);
    expect(path('SONW', 'GF')).toEqual(['SONW', 'spouse:SON', 'parent:ME', 'parent:F', 'parent:GF']);
  });

  it('prefers blood to marriage between equally long paths', () => {
    // ME → SON is one step either way of thinking; ME → SONW must use SON's marriage.
    expect(path('ME', 'SON')).toEqual(['ME', 'child:SON']);
    expect(path('ME', 'SONW')).toEqual(['ME', 'child:SON', 'spouse:SONW']);
  });

  it('answers the same person, and no path', () => {
    expect(path('ME', 'ME')).toEqual(['ME']);
    expect(path('ME', 'LONER')).toBeNull();
    expect(path('ORPH1', 'ME')).toBeNull();
  });
});
