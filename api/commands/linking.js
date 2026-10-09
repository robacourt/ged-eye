/**
 * Family lookups, the linking rules (spec: Linking rules), cycle checks and cleanup, shared by the
 * edit commands. Every function takes the command's transaction client, which already holds the
 * global write lock (begin_change), so what it reads can't change before it writes.
 */
import { ApiError, invalid } from '../http.js';
import { nameOf, possessive, relationWord } from './summary.js';

/** person.updated_at exactly as person_record sends it (`updatedAt`), for optimistic concurrency. */
const UPDATED_AT_TEXT = `to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export const notFound = (field, id) => new ApiError(404, 'not_found', { field, id });
export const stale = (message) => new ApiError(409, 'stale', { message });
export const noChange = () => new ApiError(400, 'no_change');

/** The person row plus `updated_at_text`, or null. */
export async function findPerson(tx, id) {
  const { rows: [row] } = await tx.query(`select *, ${UPDATED_AT_TEXT} as updated_at_text from person where id = $1`, [id]);
  return row ?? null;
}

/** The person row, or 404 not_found naming `field`. */
export async function requirePerson(tx, id, field) {
  const row = await findPerson(tx, id);
  if (!row) throw notFound(field, id);
  return row;
}

/** The person, or 409 stale when `stamp` isn't their current updatedAt (404 when they don't exist). */
export async function requireFreshPerson(tx, id, stamp) {
  const row = await requirePerson(tx, id, 'id');
  if (row.updated_at_text !== stamp) {
    throw stale(`Someone else changed ${nameOf(row)} since you opened them. Reload to see their changes.`);
  }
  return row;
}

/** `id` when that person exists, else `fallback` (for an optional focusId the client sent). */
export async function existingPersonOr(tx, id, fallback) {
  if (id === null) return fallback;
  const { rows } = await tx.query('select 1 from person where id = $1', [id]);
  return rows.length > 0 ? id : fallback;
}

export async function findFamily(tx, id) {
  const { rows: [row] } = await tx.query(
    `select id, partner1_id, partner2_id, marriage_date, marriage_place, divorce_date, divorce_place
     from family where id = $1`, [id]);
  return row ?? null;
}

export const partnersOf = (family) => [family.partner1_id, family.partner2_id].filter((id) => id !== null);

/** Rows (id, display_name, sex) for `ids`, in the same order; missing people are skipped. */
export async function peopleByIds(tx, ids) {
  const { rows } = await tx.query('select id, display_name, sex from person where id = any ($1::text[])', [ids]);
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

/** Every partner then child (by position) of each family, in order, without repeats. */
export async function familyMembers(tx, familyIds) {
  const { rows } = await tx.query(
    `select m.id
     from unnest($1::text[]) with ordinality as fam (id, ord)
     join family f on f.id = fam.id
     cross join lateral (
       select f.partner1_id as id, 0 as grp, 0 as pos
       union all select f.partner2_id, 1, 0
       union all select fc.child_id, 2, fc.position from family_child fc where fc.family_id = f.id
     ) m
     where m.id is not null
     order by fam.ord, m.grp, m.pos`, [familyIds]);
  return unique(rows.map((row) => row.id));
}

export const unique = (ids) => [...new Set(ids.filter((id) => id !== null && id !== undefined))];

export async function nextPersonId(tx) {
  return (await tx.query(`select 'I' || nextval('person_number_seq') as id`)).rows[0].id;
}

async function nextFamilyId(tx) {
  return (await tx.query(`select 'F' || nextval('family_number_seq') as id`)).rows[0].id;
}

/** Families where the person is a child, oldest first (as person_record's parentFamilies). */
async function parentFamiliesOf(tx, personId) {
  const { rows } = await tx.query(
    `select f.id, f.partner1_id, f.partner2_id
     from family_child fc
     join dated_family f on f.id = fc.family_id
     where fc.child_id = $1
     order by f.start_year nulls last, f.sort_key, f.id`, [personId]);
  return rows;
}

/** Families where the person is a partner. */
async function partnerFamiliesOf(tx, personId) {
  const { rows } = await tx.query(
    `select id, partner1_id, partner2_id from family where $1 in (partner1_id, partner2_id) order by sort_key, id`, [personId]);
  return rows;
}

async function isChildIn(tx, familyId, personId) {
  const { rows } = await tx.query('select 1 from family_child where family_id = $1 and child_id = $2', [familyId, personId]);
  return rows.length > 0;
}

async function childIdsOf(tx, familyId) {
  const { rows } = await tx.query('select child_id from family_child where family_id = $1', [familyId]);
  return rows.map((row) => row.child_id);
}

/** Is `ancestorId` an ancestor of `personId`? */
async function isAncestor(tx, ancestorId, personId) {
  const { rows } = await tx.query('select 1 from ancestors_of($1) a where a.id = $2', [personId, ancestorId]);
  return rows.length > 0;
}

/** Is `personId` one of `ids`, or a descendant of one of them? */
async function isDescendantOrSelfOfAny(tx, personId, ids) {
  if (ids.includes(personId)) return true;
  const { rows } = await tx.query('select 1 from ancestors_of($1) a where a.id = any ($2::text[]) limit 1', [personId, ids]);
  return rows.length > 0;
}

/** Is `personId` one of `ids`, or an ancestor of one of them? */
async function isAncestorOrSelfOfAny(tx, personId, ids) {
  if (ids.includes(personId)) return true;
  const { rows } = await tx.query('select 1 from descendants_of($1) d where d.id = any ($2::text[]) limit 1', [personId, ids]);
  return rows.length > 0;
}

/**
 * Partner order for a new family F(a, b): the male partner first when exactly one of them is male,
 * else `a` first. `b` may be null (a one-partner family).
 */
export function partnerOrder(a, b) {
  return b && b.sex === 'M' && a.sex !== 'M' ? [b, a] : [a, b];
}

async function createFamily(tx, a, b) {
  const id = await nextFamilyId(tx);
  const [first, second] = partnerOrder(a, b);
  await tx.query('insert into family (id, partner1_id, partner2_id) values ($1, $2, $3)', [id, first.id, second?.id ?? null]);
  return id;
}

async function appendChild(tx, familyId, childId) {
  await tx.query(
    `insert into family_child (family_id, child_id, position)
     select $1, $2, coalesce(max(position), -1) + 1 from family_child where family_id = $1`, [familyId, childId]);
}

const cycle = (field, b) => invalid(field, `That would make ${nameOf(b)} their own ancestor.`);

/**
 * "That would make Ann both Tom's wife and his daughter": the error for partners `highId` and
 * `lowId` (an ancestor and a descendant). `direct` says the link makes `lowId` a child of `highId`.
 */
async function partnersRelated(tx, highId, lowId, field, direct) {
  const [high, low] = await peopleByIds(tx, [highId, lowId]);
  let child = direct;
  if (!child) {
    const { rows } = await tx.query(
      `select 1 from family_child fc join family f on f.id = fc.family_id
       where fc.child_id = $2 and $1 in (f.partner1_id, f.partner2_id)`, [highId, lowId]);
    child = rows.length > 0;
  }
  const kin = child ? relationWord('child', low.sex) : 'descendant';
  return invalid(field,
    `That would make ${nameOf(low)} both ${nameOf(high)}'s ${relationWord('spouse', low.sex)} and ${possessive(high.sex)} ${kin}.`);
}

/**
 * A new parent→child edge X→Y makes X and X's ancestors ancestors of Y and Y's descendants. Refuses
 * it if two partners of any family would end up on either side: one in {X} ∪ ancestors(X), the
 * other in {Y} ∪ descendants(Y). Checked before the write, after the cycle check.
 */
async function checkEdgeKeepsPartnersUnrelated(tx, parentId, childId, field) {
  const { rows: [hit] } = await tx.query(
    `with up as (select $1::text as id union select id from ancestors_of($1)),
          down as (select $2::text as id union select id from descendants_of($2))
     select u.id as high_id, d.id as low_id
     from family f
     join up u on u.id in (f.partner1_id, f.partner2_id)
     join down d on d.id in (f.partner1_id, f.partner2_id)
     where u.id <> d.id
     limit 1`, [parentId, childId]);
  if (hit) throw await partnersRelated(tx, hit.high_id, hit.low_id, field, hit.high_id === parentId && hit.low_id === childId);
}

/**
 * The spouse rules for a new couple (a new spouse family, or a parent filling the free slot of a
 * family): `aId` and `bId` mustn't already be partners in a family, and neither may be the other's
 * ancestor. `elsewhere` words the duplicate for a parent, whose couple is already in another family.
 */
async function checkNewCouple(tx, aId, bId, field, { elsewhere = false } = {}) {
  const { rows } = await tx.query(
    `select 1 from family where (partner1_id = $1 and partner2_id = $2) or (partner1_id = $2 and partner2_id = $1)`, [aId, bId]);
  if (rows.length > 0) {
    const [a, b] = await peopleByIds(tx, [aId, bId]);
    throw invalid(field, `${nameOf(a)} and ${nameOf(b)} are already partners${elsewhere ? ' in another family' : ''}.`);
  }
  if (await isAncestor(tx, aId, bId)) throw await partnersRelated(tx, aId, bId, field, false);
  if (await isAncestor(tx, bId, aId)) throw await partnersRelated(tx, bId, aId, field, false);
}

/**
 * P for "+ Parent" and "+ Sibling": `familyId` if given (one of A's parent families), else A's
 * only parent family; null when A has none.
 */
async function chooseParentFamily(tx, a, familyId) {
  const families = await parentFamiliesOf(tx, a.id);
  if (familyId !== null) {
    const chosen = families.find((family) => family.id === familyId);
    if (!chosen) throw invalid('familyId', `That family isn't one of ${nameOf(a)}'s parent families.`);
    return chosen;
  }
  if (families.length > 1) throw invalid('familyId', `${nameOf(a)} has more than one set of parents: choose which.`);
  return families[0] ?? null;
}

/** B becomes a parent of A (and of every other child of A's parent family). */
async function linkParent(tx, a, b, familyId, field) {
  const family = await chooseParentFamily(tx, a, familyId);
  if (!family) {
    if (await isDescendantOrSelfOfAny(tx, b.id, [a.id])) throw cycle(field, b);
    await checkEdgeKeepsPartnersUnrelated(tx, b.id, a.id, field);
    const id = await createFamily(tx, b, null);
    await appendChild(tx, id, a.id);
    return id;
  }
  if (partnersOf(family).includes(b.id)) throw invalid(field, `${nameOf(b)} is already a parent in that family.`);
  const slot = family.partner1_id === null ? 'partner1_id' : family.partner2_id === null ? 'partner2_id' : null;
  if (!slot) throw invalid('familyId', `${nameOf(a)} already has two parents in that family.`);
  // B becomes a parent of all of P's children, so B must not be one of them or their descendant.
  const childIds = await childIdsOf(tx, family.id);
  if (await isDescendantOrSelfOfAny(tx, b.id, childIds)) throw cycle(field, b);
  // B becomes the partner of P's other parent (the spouse rules apply), and a parent of each child.
  for (const partnerId of partnersOf(family)) await checkNewCouple(tx, b.id, partnerId, field, { elsewhere: true });
  for (const childId of childIds) await checkEdgeKeepsPartnersUnrelated(tx, b.id, childId, field);
  await tx.query(`update family set ${slot} = $2 where id = $1`, [family.id, b.id]);
  return family.id;
}

/** B becomes a partner of A in a new family. */
async function linkSpouse(tx, a, b, field) {
  await checkNewCouple(tx, a.id, b.id, field);
  return createFamily(tx, a, b);
}

/** Adds B as a child of P (an existing family, or a new F(A, none) when `family` is null). */
async function addChildTo(tx, a, b, family, field) {
  const partnerIds = family ? partnersOf(family) : [a.id];
  if (family && await isChildIn(tx, family.id, b.id)) throw invalid(field, `${nameOf(b)} is already a child in that family.`);
  // B becomes a child of every partner of P, so B must not be one of them or their ancestor.
  if (await isAncestorOrSelfOfAny(tx, b.id, partnerIds)) throw cycle(field, b);
  for (const partnerId of partnerIds) await checkEdgeKeepsPartnersUnrelated(tx, partnerId, b.id, field);
  const id = family?.id ?? await createFamily(tx, a, null);
  await appendChild(tx, id, b.id);
  return id;
}

/** B becomes a child of A, in `familyId` (a family where A is a partner) or 'new'. */
async function linkChild(tx, a, b, familyId, field) {
  const families = await partnerFamiliesOf(tx, a.id);
  if (familyId === 'new') {
    // A's existing single-parent family if there is exactly one, else a new F(A, none).
    const alone = families.filter((family) => partnersOf(family).length === 1);
    return addChildTo(tx, a, b, alone.length === 1 ? alone[0] : null, field);
  }
  const family = families.find((candidate) => candidate.id === familyId);
  if (!family) throw invalid('familyId', `${nameOf(a)} isn't a parent in that family.`);
  return addChildTo(tx, a, b, family, field);
}

/** B becomes a sibling of A: a child of A's parent family. */
async function linkSibling(tx, a, b, familyId, field) {
  const family = await chooseParentFamily(tx, a, familyId);
  if (!family) throw invalid('relation', `Add a parent first: ${nameOf(a)} has no parents to share.`);
  if (partnersOf(family).length === 0) throw invalid('familyId', "That family has no parents, so a sibling couldn't be shown.");
  return addChildTo(tx, a, b, family, field);
}

/**
 * Links B (an existing person row; for add_relative, the person just created) to the anchor A by
 * `relation`, following the spec's Linking rules, and returns the family the link is in.
 * `familyId` is null when not given. Rule violations are 400 invalid; `field` names B's parameter.
 */
export async function linkPeople(tx, { relation, anchor: a, other: b, familyId, field }) {
  if (a.id === b.id) throw invalid(field, "A person can't be linked to themselves.");
  switch (relation) {
    case 'parent': return linkParent(tx, a, b, familyId, field);
    case 'spouse': return linkSpouse(tx, a, b, field);
    case 'child': return linkChild(tx, a, b, familyId, field);
    case 'sibling': return linkSibling(tx, a, b, familyId, field);
    default: throw invalid('relation', `Unknown relation: ${relation}.`);
  }
}

/**
 * Cleanup after unlink and delete_person: of `familyIds`, deletes each family left with no partners
 * (its child links cascade), or with one partner and no children. Returns the deleted ids.
 */
export async function cleanupFamilies(tx, familyIds) {
  const { rows } = await tx.query(
    `delete from family f
     where f.id = any ($1::text[])
       and (f.partner1_id is null and f.partner2_id is null
            or (f.partner1_id is null or f.partner2_id is null)
               and not exists (select 1 from family_child fc where fc.family_id = f.id))
     returning f.id`, [familyIds]);
  return rows.map((row) => row.id);
}
