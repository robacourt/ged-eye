import fs from 'fs';
import path from 'path';

// Legacy per-person JSON lives at <legacyRoot>/data/people/I*.json; avatars at <legacyRoot>/<avatar>.
export function readLegacyPeople(legacyRoot) {
  const dir = path.join(legacyRoot, 'data', 'people');
  const people = new Map();
  for (const name of fs.readdirSync(dir)) {
    if (!/^I[^/]*\.json$/.test(name)) continue; // skips index.json and dotfiles
    const person = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf-8'));
    people.set(person.id, person);
  }
  return people;
}

export function readLegacyAvatars(legacyRoot) {
  const avatars = new Map();
  for (const [id, person] of readLegacyPeople(legacyRoot)) {
    if (person.avatar) avatars.set(id, person.avatar);
  }
  return avatars;
}
