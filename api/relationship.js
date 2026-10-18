/**
 * How two people are related (GET /relationship; spec: specs/2026-10-18-relationship-search-design.md): the
 * family as a graph of parent, child, sibling and partner links, and the cheapest path through it. Pure, so it
 * can be tested without a database.
 */

/**
 * What each link costs: the shortest chain wins, and among equal ones, blood relations over marriage. A half
 * brother or sister costs a little more than a marriage, so a wife's son from her earlier marriage is reached as
 * her son (a stepson) rather than as one's own son's half-brother.
 */
const WEIGHTS = { parent: 10, child: 10, sibling: 10, halfSibling: 13, spouse: 12 };

/**
 * The family as a graph, from `family` rows (`{ id, partner1_id, partner2_id }`) and `family_child` rows
 * (`{ family_id, child_id }`). Links: a child to each parent ('parent') and back ('child'); partners to each
 * other ('spouse'); and anyone sharing a parent ('sibling' with the same parents, else 'halfSibling'), or a
 * family with no partners recorded ('sibling'). → Map id → [{ to, step }]
 */
export function familyGraph(families, children) {
  const links = new Map();
  const seen = new Set(); // "from to step", so a link is added once however many ways it is found
  const add = (from, to, step) => {
    if (!from || !to || from === to) return;
    const key = `${from} ${to} ${step}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (!links.has(from)) links.set(from, []);
    links.get(from).push({ to, step });
  };

  const partnersOf = new Map(families.map(family => [family.id, [family.partner1_id, family.partner2_id].filter(Boolean)]));
  for (const partners of partnersOf.values()) {
    if (partners.length === 2) {
      add(partners[0], partners[1], 'spouse');
      add(partners[1], partners[0], 'spouse');
    }
  }

  const parentsOf = new Map(); // child → Set of parents
  const childrenOf = new Map(); // parent → Set of children
  const inFamily = new Map(); // family → [children]
  for (const { family_id: familyId, child_id: child } of children) {
    if (!inFamily.has(familyId)) inFamily.set(familyId, []);
    inFamily.get(familyId).push(child);
    for (const parent of partnersOf.get(familyId) ?? []) {
      add(child, parent, 'parent');
      add(parent, child, 'child');
      if (!parentsOf.has(child)) parentsOf.set(child, new Set());
      parentsOf.get(child).add(parent);
      if (!childrenOf.has(parent)) childrenOf.set(parent, new Set());
      childrenOf.get(parent).add(child);
    }
  }

  const sameParents = (a, b) => {
    const pa = parentsOf.get(a) ?? new Set();
    const pb = parentsOf.get(b) ?? new Set();
    return pa.size === pb.size && [...pa].every(parent => pb.has(parent));
  };
  const siblings = (group) => {
    for (const a of group) {
      for (const b of group) {
        if (a !== b) add(a, b, sameParents(a, b) ? 'sibling' : 'halfSibling');
      }
    }
  };
  for (const group of childrenOf.values()) siblings([...group]);
  // Children of a family with no partners recorded are still brothers and sisters.
  for (const [familyId, group] of inFamily) if (!(partnersOf.get(familyId) ?? []).length) siblings(group);

  return links;
}

/**
 * The cheapest path from `from` to `to` (Dijkstra, by WEIGHTS). → `[{ id, step }]`, from `from` to `to`, where
 * `step` is how that person is related to the one before (null for the first); or null when there is none.
 */
export function shortestPath(graph, from, to) {
  if (from === to) return [{ id: from, step: null }];
  const cost = new Map([[from, 0]]);
  const previous = new Map(); // id → { id, step }
  const done = new Set();
  const queue = new MinQueue();
  queue.push(0, from);
  while (queue.size) {
    const id = queue.pop();
    if (done.has(id)) continue;
    done.add(id);
    if (id === to) break;
    for (const { to: next, step } of graph.get(id) ?? []) {
      if (done.has(next)) continue;
      const total = cost.get(id) + WEIGHTS[step];
      if (!cost.has(next) || total < cost.get(next)) {
        cost.set(next, total);
        previous.set(next, { id, step });
        queue.push(total, next);
      }
    }
  }
  if (!previous.has(to)) return null;
  const path = [];
  for (let id = to; id !== from; id = previous.get(id).id) path.unshift({ id, step: previous.get(id).step });
  path.unshift({ id: from, step: null });
  return path;
}

/** A small binary heap of (priority, value), lowest first; equal priorities come out in the order they went in. */
class MinQueue {
  constructor() {
    this.items = [];
    this.count = 0;
  }

  get size() {
    return this.items.length;
  }

  push(priority, value) {
    const items = this.items;
    items.push({ priority, order: this.count++, value });
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.less(items[i], items[parent])) break;
      [items[i], items[parent]] = [items[parent], items[i]];
      i = parent;
    }
  }

  pop() {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (items.length) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        const right = left + 1;
        let smallest = i;
        if (left < items.length && this.less(items[left], items[smallest])) smallest = left;
        if (right < items.length && this.less(items[right], items[smallest])) smallest = right;
        if (smallest === i) break;
        [items[i], items[smallest]] = [items[smallest], items[i]];
        i = smallest;
      }
    }
    return top.value;
  }

  less(a, b) {
    return a.priority < b.priority || (a.priority === b.priority && a.order < b.order);
  }
}
