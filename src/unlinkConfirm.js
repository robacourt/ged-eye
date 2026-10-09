/**
 * The confirmation for × on a parent, spouse or child row of the details panel, which sends `unlink`.
 * Its text follows the spec's Cleanup rule: removing a family's last parent also removes the family, and so
 * the sibling links between its children; a spouse removed from a childless marriage takes the marriage with
 * them. Every data value is set with `textContent`, never as HTML.
 */
import { el, openEditorDialog, callSafely, setBusy, commandErrorMessage } from './editorDialog.js';
import { childrenInFamily, listNames, nameById, nameOf } from './familyLinks.js';

const TITLES = { parent: 'Remove a parent', spouse: 'Remove a spouse', child: 'Remove a child' };
const FAMILY_DETAILS = [
  ['marriageDate', 'marriage date'], ['marriagePlace', 'marriage place'], ['divorceDate', 'divorce date'], ['divorcePlace', 'divorce place']
];

/** What the parent's removal does to the rest of their family `familyId` (one of the person's parent families). */
function parentDetails(person, relationships, personId, familyId) {
  const family = (person?.parentFamilies ?? []).find(candidate => candidate.familyId === familyId);
  if (!family) return [];
  const parent = nameById(person, relationships, personId);
  const others = (family.childIds ?? []).filter(id => id !== person.id).map(id => nameById(person, relationships, id));
  const lastParent = (family.partnerIds ?? []).every(id => id === personId);
  if (!lastParent) return others.length ? [`This also removes ${parent} as a parent of ${listNames(others)}.`] : [];
  const removed = `${parent} is the only parent in this family, so the family will be removed too.`;
  if (!others.length) return [removed];
  const links = others.length === 1 ? 'the sibling link' : 'the sibling links';
  return [`${removed} That also removes ${links} between ${listNames([nameOf(person), ...others])}.`];
}

/** What the spouse's removal does: their children together lose them as a parent, or a childless marriage goes. */
function spouseDetails(person, relationships, spouse, familyId) {
  const children = childrenInFamily(person, relationships, familyId);
  if (children === null) return [`${spouse} will also no longer be a parent of their children together, if they have any.`];
  if (children.length) return [`This also removes ${spouse} as a parent of ${listNames(children.map(nameOf))}.`];
  return ['This also removes their marriage record.'];
}

/** A family with no other parent goes when its only child is removed (Cleanup), with its marriage details. */
function childDetails(person, relationships, marriage, child) {
  if (!marriage || marriage.spouseId) return [];
  const children = childrenInFamily(person, relationships, marriage.familyId);
  if (children?.length !== 1 || children[0].id !== child.id) return [];
  const details = FAMILY_DETAILS.filter(([key]) => marriage[key]).map(([, label]) => label);
  const record = details.length ? `the family record, with its ${listNames(details)},` : 'the family record';
  return [`${nameOf(child)} is the only child in this family and there is no other parent, so ${record} will be removed too.`];
}

/**
 * The words of the confirmation.
 * @param person         the person being viewed (a person record)
 * @param relationships  the loader's `{ parents, spouses, children, siblings }`
 * @param relation       'parent' | 'spouse' | 'child': what `personId` is to the person
 * @param personId       the relative to remove
 * @param familyId       the family the link is in; null when the details panel couldn't tell which (a child
 *                       of an older view), and then the confirmation only explains that (`blocked`)
 * @returns `{ title, question, details: [sentences], blocked }`
 */
export function unlinkConfirmText({ person, relationships, relation, personId, familyId }) {
  const name = nameOf(person);
  const other = nameById(person, relationships, personId);
  const title = TITLES[relation] ?? 'Remove a link';
  if (!familyId) {
    return {
      title,
      question: `Can't tell which of ${name}'s families ${other} is in, so this link can't be removed here.`,
      details: ['Reload this person, then try again.'],
      blocked: true
    };
  }
  if (relation === 'parent') {
    return {
      title, question: `Remove ${other} as a parent of ${name}?`,
      details: parentDetails(person, relationships, personId, familyId), blocked: false
    };
  }
  if (relation === 'spouse') {
    return {
      title, question: `Remove ${other} as the spouse of ${name}?`,
      details: spouseDetails(person, relationships, other, familyId), blocked: false
    };
  }
  const marriage = (person?.marriages ?? []).find(candidate => candidate.familyId === familyId);
  const parents = [name, ...(marriage?.spouseId ? [nameById(person, relationships, marriage.spouseId)] : [])];
  return {
    title, question: `Remove ${other} as a child of ${listNames(parents)}?`,
    details: childDetails(person, relationships, marriage, { id: personId, name: other }), blocked: false
  };
}

/** The `unlink` params for removing `personId` (what they are to `person`: `relation`) from `familyId`. */
export function unlinkParams({ person, relation, personId, familyId }) {
  return { familyId, personId, role: relation === 'child' ? 'child' : 'partner', focusId: person.id };
}

/**
 * Opens the confirmation; Remove sends `unlink` with the viewed person as `focusId`, so the returned view is
 * theirs.
 * @param person, relationships, relation, personId, familyId  as for unlinkConfirmText (a null familyId only
 *                    explains, with Close and, given a loader, Reload this person)
 * @param api         `{ runChange }` (editApi.js)
 * @param onUnlinked  ({ change, view }) after the command: the caller invalidates caches, re-renders and shows
 *                    `change.summary` in a toast with Undo
 * @param loader      optional `{ reload }` (dataLoader.js): a stale error then offers "Reload this person"
 * @param onReloaded  (loadPersonWithFamily result) after that reload; the dialog has closed by then
 * @returns `{ close, isOpen, element }`
 */
export function openUnlinkConfirm(options) {
  const { person, api, onUnlinked, loader, onReloaded } = options;
  const text = unlinkConfirmText(options);
  let busy = false;

  const dialog = openEditorDialog({
    title: text.title,
    className: 'unlink-confirm',
    onRequestClose: () => {
      if (!busy) dialog.close();
    }
  });

  const messageText = el('p', { class: 'editor-error', role: 'alert' });
  const reloadButton = el('button', { type: 'button', class: 'editor-btn editor-reload', text: 'Reload this person', hidden: true });
  const message = el('div', { class: 'editor-form-message', hidden: true }, messageText, reloadButton);
  const cancelButton = el('button', { type: 'button', class: 'editor-btn unlink-cancel', text: text.blocked ? 'Close' : 'Cancel' });
  const removeButton = el('button', { type: 'button', class: 'editor-btn editor-btn-danger-solid unlink-remove', text: 'Remove', hidden: text.blocked });

  const root = el('div', { class: 'editor-form unlink-form' },
    el('div', { class: 'unlink-confirm-text' },
      el('p', { class: 'unlink-question', text: text.question }),
      ...text.details.map(detail => el('p', { text: detail })),
      text.blocked ? null : el('p', { class: 'editor-hint', text: 'You can undo this from History.' })),
    message,
    el('div', { class: 'editor-actions' }, el('span', { class: 'editor-actions-spacer' }), cancelButton, removeButton));
  dialog.body.append(root);

  function showMessage(words, { reload = false } = {}) {
    messageText.textContent = words;
    messageText.hidden = false;
    reloadButton.hidden = !(reload && loader);
    message.hidden = false;
  }

  async function remove() {
    if (busy || text.blocked) return;
    message.hidden = true;
    busy = true;
    setBusy(root, true, removeButton, 'Removing…');
    let result;
    try {
      result = await api.runChange('unlink', unlinkParams(options));
    } catch (error) {
      if (error?.code === 'stale') showMessage(error.message || 'Someone else changed this family.', { reload: true });
      else showMessage(commandErrorMessage(error, { missing: 'Someone else has already removed this.' }));
      busy = false;
      setBusy(root, false, removeButton);
      return;
    }
    busy = false;
    dialog.close();
    callSafely(onUnlinked, result);
  }

  async function reload() {
    if (busy || !loader) return;
    busy = true;
    setBusy(root, true, reloadButton, 'Reloading…');
    let fresh;
    try {
      fresh = await loader.reload(person.id);
    } catch (error) {
      const gone = error?.name === 'PersonNotFoundError';
      showMessage(gone ? `${nameOf(person)} no longer exists: someone else deleted them.`
        : "Couldn't reload this person. Check your connection and try again.", { reload: !gone });
      busy = false;
      setBusy(root, false, reloadButton);
      return;
    }
    busy = false;
    dialog.close();
    callSafely(onReloaded, fresh);
  }

  cancelButton.addEventListener('click', () => {
    if (!busy) dialog.close();
  });
  removeButton.addEventListener('click', remove);
  reloadButton.addEventListener('click', reload);
  if (text.blocked && loader) { // nothing to remove: offer the reload straight away
    messageText.hidden = true;
    reloadButton.hidden = false;
    message.hidden = false;
  }
  cancelButton.focus();

  return { close: () => dialog.close(), isOpen: dialog.isOpen, element: dialog.dialog };
}
