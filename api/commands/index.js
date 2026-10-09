/**
 * The edit commands, by kind. Each module exports { kind, validate(params) → clean params (or throws
 * ApiError 400 invalid), run(tx, params, user) → { summary, personIds, focusId } }; api/changes.js
 * runs them inside a recorded change.
 */
import * as updatePerson from './updatePerson.js';
import * as addRelative from './addRelative.js';
import * as linkExisting from './linkExisting.js';
import * as updateFamily from './updateFamily.js';
import * as unlink from './unlink.js';
import * as deletePerson from './deletePerson.js';

// A Map, so a kind like "constructor" is never mistaken for a command.
export const COMMANDS = new Map([updatePerson, addRelative, linkExisting, updateFamily, unlink, deletePerson]
  .map((command) => [command.kind, command]));

export const commandFor = (kind) => COMMANDS.get(kind) ?? null;
