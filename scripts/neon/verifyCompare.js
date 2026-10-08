const SCALAR_KEYS = ['id', 'name', 'givenName', 'surname', 'sex', 'birthDate', 'birthPlace', 'deathDate', 'deathPlace',
  'baptismDate', 'baptismPlace', 'burialDate', 'burialPlace', 'occupations', 'notes', 'email', 'phone', 'religion',
  'education', 'censusRecords', 'residences'];

const canonical = (value) => JSON.stringify(value, (_, v) =>
  v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);

/** What the legacy loadPersonWithFamily() would show for `id`, from the legacy JSON files. */
export function legacyExpected(people, id) {
  const person = people.get(id);
  const known = (pid) => people.has(pid);
  const parents = person.parentIds.filter(known);
  const candidates = new Set();
  for (const pid of parents) {
    for (const cid of people.get(pid).childIds) if (cid !== id) candidates.add(cid);
  }
  const siblings = [...candidates].filter(known)
    .filter(sid => person.parentIds.some(pid => people.get(sid).parentIds.includes(pid)));
  const otherParents = new Set();
  for (const sid of siblings) {
    for (const spid of people.get(sid).parentIds) if (!person.parentIds.includes(spid)) otherParents.add(spid);
  }
  const familyIds = new Set([...person.parentIds, ...person.spouseIds, ...person.childIds, ...candidates, ...otherParents].filter(known));
  familyIds.delete(id);
  return {
    person,
    relationships: {
      parents,
      spouses: person.spouseIds.filter(known),
      children: person.childIds.filter(known),
      siblings
    },
    familyIds
  };
}

/** Differences between the legacy expectation and a person_view() result. Empty array = match. */
export function diffView(expected, actual, manifest, people) {
  if (!actual) return ['person_view returned null'];
  const diffs = [];
  const sameSet = (label, a, b) => {
    const A = new Set(a);
    const B = new Set(b);
    if (A.size !== B.size || [...A].some(x => !B.has(x))) {
      diffs.push(`${label}: expected [${[...A].sort()}] got [${[...B].sort()}]`);
    }
  };

  for (const key of ['parents', 'spouses', 'children', 'siblings']) {
    sameSet(key, expected.relationships[key], actual.relationships[key]);
  }
  sameSet('family', expected.familyIds, actual.family.map(m => m.id));

  const p = expected.person;
  const q = actual.person;
  for (const key of SCALAR_KEYS) {
    if (canonical(p[key] ?? null) !== canonical(q[key] ?? null)) {
      diffs.push(`${key}: expected ${canonical(p[key] ?? null)} got ${canonical(q[key] ?? null)}`);
    }
  }
  sameSet('parentIds', p.parentIds, q.parentIds);
  sameSet('spouseIds', p.spouseIds, q.spouseIds);
  sameSet('childIds', p.childIds, q.childIds);
  sameSet('marriages', (p.marriages ?? []).map(canonical), (q.marriages ?? []).map(canonical));

  const expectedShas = [...new Set(p.photos.map(path => manifest.files[path]?.sha256 ?? `missing:${path}`))];
  const actualShas = q.photos.map(photo => /^originals\/([0-9a-f]{64})/.exec(photo.key)?.[1] ?? photo.key);
  if (canonical(expectedShas) !== canonical(actualShas)) {
    diffs.push(`photos: expected ${canonical(expectedShas)} got ${canonical(actualShas)}`);
  }

  const expectedAvatar = p.avatar ? (manifest.avatars[p.avatar] ?? `missing:${p.avatar}`) : null;
  if (expectedAvatar !== q.avatarKey) diffs.push(`avatarKey: expected ${expectedAvatar} got ${q.avatarKey}`);

  for (const member of actual.family) {
    const legacy = people.get(member.id);
    if (!legacy) {
      diffs.push(`family ${member.id}: not in legacy data`);
      continue;
    }
    for (const key of ['name', 'sex', 'birthDate']) {
      if ((legacy[key] ?? null) !== (member[key] ?? null)) diffs.push(`family ${member.id}.${key}: expected ${legacy[key]} got ${member[key]}`);
    }
    sameSet(`family ${member.id}.parentIds`, legacy.parentIds, member.parentIds);
    const memberAvatar = legacy.avatar ? (manifest.avatars[legacy.avatar] ?? `missing:${legacy.avatar}`) : null;
    if (memberAvatar !== member.avatarKey) diffs.push(`family ${member.id}.avatarKey: expected ${memberAvatar} got ${member.avatarKey}`);
  }
  return diffs;
}
