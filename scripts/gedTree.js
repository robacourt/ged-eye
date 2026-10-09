/**
 * Stage 1 of the GEDCOM parser: lines → node tree.
 * CONT and CONC lines are folded into their parent's value (CONT adds a newline, CONC joins
 * directly) and never appear as nodes. Values are kept verbatim apart from the line ending and the
 * GEDCOM `@@` escape (a literal `@` in a value is written `@@`; GEDCOM 5.5.1).
 */

const LINE = /^\s*(\d+) (?:(@[^@]+@) )?(\S+)(?: (.*))?$/;

/**
 * @returns {{level: number, xref: string|null, tag: string, value: string, children: object[]}[]}
 *   the level-0 nodes, in file order
 */
export function parseGedcomTree(gedcomText) {
  const roots = [];
  const open = [];
  for (const raw of gedcomText.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (!line.trim()) continue;
    const match = LINE.exec(line);
    if (!match) continue;
    const level = Number(match[1]);
    const tag = match[3];
    const value = (match[4] ?? '').replaceAll('@@', '@');
    while (open.length && open[open.length - 1].level >= level) open.pop();
    const parent = open[open.length - 1];
    if (level > 0 && !parent) continue;
    if (parent && (tag === 'CONT' || tag === 'CONC')) {
      parent.value += (tag === 'CONT' ? '\n' : '') + value;
      continue;
    }
    const node = { level, xref: match[2] ? match[2].replace(/@/g, '') : null, tag, value, children: [] };
    if (parent) parent.children.push(node);
    else roots.push(node);
    open.push(node);
  }
  return roots;
}

/** The last direct child with this tag, or undefined. */
export const lastChild = (node, tag) => node.children.findLast(child => child.tag === tag);

/** A node's value with surrounding whitespace removed: names, dates, places, pointers. */
export const text = (node) => node.value.trim();
