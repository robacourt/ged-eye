import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openRelativeDialog, familyChoice } from '../src/relativeDialog.js';
import { openUnlinkConfirm, unlinkConfirmText } from '../src/unlinkConfirm.js';
import { familyOfChild, relativeBlocked } from '../src/familyLinks.js';
import { isEditorDialogOpen } from '../src/editorDialog.js';

vi.mock('../src/toast.js', () => ({ showToast: vi.fn() }));

const XSS = '<img src=x onerror="window.__xss = 1">';
const apiError = (status, code, body = {}) =>
  Object.assign(new Error(body.message ?? code), { name: 'ApiError', status, code, field: body.field ?? null, body });
const RESULT = { change: { id: 12, summary: 'Added Tom Smith as the father of Rose Smith', personIds: ['I9', 'I7'] }, view: { person: { id: 'I7' } } };

// Rose (I7) and her relatives.
const TOM = { id: 'I1', name: 'Tom Smith', sex: 'M', parentIds: [] };
const ANN = { id: 'I2', name: 'Ann Jones', sex: 'F', parentIds: [] };
const MARY = { id: 'I4', name: 'Mary Brown', sex: 'F', parentIds: [] };
const JOHN = { id: 'I3', name: 'John Brown', sex: 'M', parentIds: [] };
const PAUL = { id: 'I5', name: 'Paul White', sex: 'M', parentIds: [] };
const JACK = { id: 'I8', name: 'Jack Smith', sex: 'M', parentIds: ['I1', 'I2'] };
const JILL = { id: 'I10', name: 'Jill Smith', sex: 'F', parentIds: ['I1', 'I2'] };
const LILY = { id: 'I11', name: 'Lily Brown', sex: 'F', parentIds: ['I7', 'I3'] };
const OLIVE = { id: 'I12', name: 'Olive Smith', sex: 'F', parentIds: ['I7'] };

const record = (extra = {}) => ({ id: 'I7', name: 'Rose Smith', sex: 'F', parentFamilies: [], marriages: [], ...extra });
const rels = (extra = {}) => ({ parents: [], spouses: [], children: [], siblings: [], ...extra });

const BOTH_PARENTS = { familyId: 'F1', partnerIds: ['I1', 'I2'], childIds: ['I7', 'I8', 'I10'] };
const ANN_ALONE = { familyId: 'F2', partnerIds: ['I2'], childIds: ['I7'] };
const MARY_ALONE = { familyId: 'F3', partnerIds: ['I4'], childIds: ['I7'] };
const WITH_JOHN = { spouseId: 'I3', familyId: 'F5', marriageDate: '1920' };
const WITH_PAUL = { spouseId: 'I5', familyId: 'F6' };
const NO_SPOUSE = { spouseId: null, familyId: 'F7' };

let api;
let loader;
let onAdded;
let onReloaded;

const open = (relation, person = record(), relationships = rels(), options = {}) =>
  openRelativeDialog({ person, relationships, relation, api, loader, onAdded, onReloaded, ...options });

const dialog = () => document.querySelector('.relative-dialog');
const $ = (selector) => dialog().querySelector(selector);
const $$ = (selector) => [...dialog().querySelectorAll(selector)];
const field = (name) => $(`[name="${name}"]`);
const type = (input, value) => {
  input.value = value;
  input.dispatchEvent(new Event(input.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
};
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const submit = async () => {
  $('.relative-submit').click();
  await flush();
};
const sent = () => api.runChange.mock.calls.at(-1);
const message = () => ($('.editor-form-message').hidden ? null : $('.editor-form-message .editor-error').textContent);
const errorFor = (key) => {
  const element = $(`[data-error-for="${key}"]`);
  return element && !element.hidden ? element.textContent : null;
};
const choiceShown = () => Boolean($('.relative-family-choice')) && !$('.relative-family-choice').hidden;
const choiceLabels = () => $$('.relative-family-choice .relative-choice').map(label => label.textContent);
const choose = (value) => {
  const radio = $(`.relative-family-choice input[value="${value}"]`);
  radio.checked = true;
  radio.dispatchEvent(new Event('change', { bubbles: true }));
};
const tab = (name) => $(`.relative-tab[data-tab="${name}"]`);

beforeEach(() => {
  document.body.innerHTML = '';
  api = { runChange: vi.fn().mockResolvedValue(RESULT), search: vi.fn().mockResolvedValue([]) };
  loader = { reload: vi.fn() };
  onAdded = vi.fn();
  onReloaded = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('openRelativeDialog: new person', () => {
  it('opens on the New person tab with the fields, titled by relation, focused on the given name', () => {
    const handle = open('parent');
    expect(handle.isOpen()).toBe(true);
    expect(isEditorDialogOpen()).toBe(true);
    expect($('.editor-dialog-title').textContent).toBe('Add a parent of Rose Smith');
    expect(tab('new').getAttribute('aria-selected')).toBe('true');
    expect(tab('existing').getAttribute('aria-selected')).toBe('false');
    for (const name of ['given_name', 'surname', 'sex', 'birth_date', 'birth_place', 'death_date']) expect(field(name)).not.toBeNull();
    expect([...field('sex').options].map(option => option.value)).toEqual(['', 'M', 'F', 'U']);
    expect(dialog().textContent).toContain('e.g. 12 MAR 1890, ABT 1850, BEF 1900');
    expect($('.relative-submit').textContent).toBe('Add');
    expect(document.activeElement).toBe(field('given_name'));
  });

  it('titles each relation', () => {
    const titles = {};
    for (const relation of ['parent', 'spouse', 'child', 'sibling']) {
      const person = record({ parentFamilies: [BOTH_PARENTS] });
      const handle = open(relation, person, rels({ parents: [TOM, ANN] }));
      titles[relation] = $('.editor-dialog-title').textContent;
      handle.close();
    }
    expect(titles).toEqual({
      parent: 'Add a parent of Rose Smith', spouse: 'Add a spouse of Rose Smith',
      child: 'Add a child of Rose Smith', sibling: 'Add a sibling of Rose Smith'
    });
  });

  it('sends add_relative with only the filled fields, trimmed, and no familyId for a first parent', async () => {
    open('parent');
    type(field('given_name'), ' Tom ');
    type(field('surname'), 'Smith');
    type(field('sex'), 'M');
    type(field('birth_date'), 'ABT 1850');
    await submit();
    expect(api.runChange).toHaveBeenCalledTimes(1);
    expect(sent()).toEqual(['add_relative', {
      anchorId: 'I7', relation: 'parent', person: { fields: { given_name: 'Tom', surname: 'Smith', sex: 'M', birth_date: 'ABT 1850' } }
    }]);
    expect('familyId' in sent()[1]).toBe(false);
    expect(dialog()).toBeNull();
    expect(onAdded).toHaveBeenCalledWith(RESULT);
  });

  it('allows an unnamed person', async () => {
    open('spouse');
    await submit();
    expect(sent()).toEqual(['add_relative', { anchorId: 'I7', relation: 'spouse', person: { fields: {} } }]);
  });

  it('sends birth place and death date too', async () => {
    open('spouse');
    type(field('birth_place'), 'Leeds');
    type(field('death_date'), '1901');
    await submit();
    expect(sent()[1].person.fields).toEqual({ birth_place: 'Leeds', death_date: '1901' });
  });

  it('never sends a familyId for a spouse', async () => {
    open('spouse', record({ parentFamilies: [BOTH_PARENTS], marriages: [WITH_JOHN] }), rels({ parents: [TOM, ANN], spouses: [JOHN] }));
    expect(choiceShown()).toBe(false);
    type(field('given_name'), 'Paul');
    await submit();
    expect(sent()).toEqual(['add_relative', { anchorId: 'I7', relation: 'spouse', person: { fields: { given_name: 'Paul' } } }]);
  });

  it('adds a parent to the only parent family without asking', async () => {
    open('parent', record({ parentFamilies: [ANN_ALONE] }), rels({ parents: [ANN] }));
    expect(choiceShown()).toBe(false);
    type(field('given_name'), 'Tom');
    await submit();
    expect(sent()[1]).toEqual({ anchorId: 'I7', relation: 'parent', person: { fields: { given_name: 'Tom' } }, familyId: 'F2' });
  });

  it('adds a sibling to the only parent family without asking', async () => {
    open('sibling', record({ parentFamilies: [BOTH_PARENTS] }), rels({ parents: [TOM, ANN] }));
    expect(choiceShown()).toBe(false);
    type(field('given_name'), 'Joe');
    await submit();
    expect(sent()[1]).toEqual({ anchorId: 'I7', relation: 'sibling', person: { fields: { given_name: 'Joe' } }, familyId: 'F1' });
  });

  it('adds a child with "Other parent unknown" when the person has no spouse', async () => {
    open('child', record({ marriages: [NO_SPOUSE] }));
    expect(choiceShown()).toBe(false);
    type(field('given_name'), 'Olive');
    await submit();
    expect(sent()[1]).toEqual({ anchorId: 'I7', relation: 'child', person: { fields: { given_name: 'Olive' } }, familyId: 'new' });
  });
});

describe('openRelativeDialog: family choice', () => {
  it('asks "with which partner?" for a child, preselecting the only spouse', async () => {
    open('child', record({ marriages: [WITH_JOHN, NO_SPOUSE] }), rels({ spouses: [JOHN] }));
    expect(choiceShown()).toBe(true);
    expect($('.relative-family-choice legend').textContent).toBe('With which partner?');
    expect(choiceLabels()).toEqual(['John Brown (married 1920)', 'Other parent unknown']);
    expect($('.relative-family-choice input:checked').value).toBe('F5');
    await submit();
    expect(sent()[1].familyId).toBe('F5');
  });

  it("sends 'new' for Other parent unknown", async () => {
    open('child', record({ marriages: [WITH_JOHN] }), rels({ spouses: [JOHN] }));
    choose('new');
    await submit();
    expect(sent()[1].familyId).toBe('new');
  });

  it('requires a choice among several spouses', async () => {
    open('child', record({ marriages: [WITH_JOHN, WITH_PAUL] }), rels({ spouses: [JOHN, PAUL] }));
    expect(choiceLabels()).toEqual(['John Brown (married 1920)', 'Paul White', 'Other parent unknown']);
    expect($('.relative-family-choice input:checked')).toBeNull();
    await submit();
    expect(api.runChange).not.toHaveBeenCalled();
    expect(errorFor('familyId')).toBe('Choose one.');
    expect(document.activeElement).toBe($('.relative-family-choice input'));
    choose('F6');
    await submit();
    expect(sent()[1].familyId).toBe('F6');
    expect(sent()[1].relation).toBe('child');
  });

  it('focuses the choice first when it has no default', () => {
    open('child', record({ marriages: [WITH_JOHN, WITH_PAUL] }), rels({ spouses: [JOHN, PAUL] }));
    expect(document.activeElement).toBe($('.relative-family-choice input'));
  });

  it('asks which parents a sibling shares when there are several parent families', async () => {
    open('sibling', record({ parentFamilies: [BOTH_PARENTS, MARY_ALONE] }), rels({ parents: [TOM, ANN, MARY] }));
    expect($('.relative-family-choice legend').textContent).toBe('Through which parents?');
    expect(choiceLabels()).toEqual(['Tom Smith and Ann Jones', 'Mary Brown']);
    await submit();
    expect(api.runChange).not.toHaveBeenCalled();
    choose('F3');
    await submit();
    expect(sent()[1].familyId).toBe('F3');
  });

  it('offers a parent only the parent families with a free place', async () => {
    open('parent', record({ parentFamilies: [BOTH_PARENTS, ANN_ALONE] }), rels({ parents: [TOM, ANN] }));
    expect(choiceShown()).toBe(false);
    await submit();
    expect(sent()[1].familyId).toBe('F2');
  });

  it('asks which family a parent joins when several have a free place', async () => {
    open('parent', record({ parentFamilies: [ANN_ALONE, MARY_ALONE] }), rels({ parents: [ANN, MARY] }));
    expect($('.relative-family-choice legend').textContent).toBe('Alongside which parent?');
    expect(choiceLabels()).toEqual(['Ann Jones', 'Mary Brown']);
    choose('F2');
    await submit();
    expect(sent()[1].familyId).toBe('F2');
  });

  it('blocks a sibling without parents: "Add a parent first"', async () => {
    open('sibling');
    expect($('.relative-blocked').textContent).toContain('Add a parent first');
    expect($('.relative-submit').disabled).toBe(true);
    await submit();
    expect(api.runChange).not.toHaveBeenCalled();
  });

  it('blocks a parent when every parent family has two parents', () => {
    open('parent', record({ parentFamilies: [BOTH_PARENTS] }), rels({ parents: [TOM, ANN] }));
    expect($('.relative-blocked').textContent).toBe('Rose Smith already has two parents.');
    expect($('.relative-submit').disabled).toBe(true);
  });

  it('shows names as text', () => {
    open('child', record({ name: XSS, marriages: [WITH_JOHN, WITH_PAUL] }), rels({ spouses: [{ ...JOHN, name: XSS }, PAUL] }));
    expect($('.editor-dialog-title').textContent).toBe(`Add a child of ${XSS}`);
    expect(choiceLabels()[0]).toBe(`${XSS} (married 1920)`);
    expect(document.querySelector('img')).toBeNull();
  });

  it('familyChoice describes each case', () => {
    expect(familyChoice(record(), rels(), 'spouse')).toMatchObject({ ask: false, value: null, blocked: null });
    expect(familyChoice(record(), rels(), 'parent')).toMatchObject({ ask: false, value: null, blocked: null });
    expect(familyChoice(record(), rels(), 'child')).toMatchObject({ ask: false, value: 'new', blocked: null });
    expect(familyChoice(record(), rels(), 'sibling').blocked).toContain('Add a parent first');
    const child = familyChoice(record({ marriages: [WITH_JOHN] }), rels({ spouses: [JOHN] }), 'child');
    expect(child).toMatchObject({ ask: true, value: 'F5' });
    expect(child.options).toEqual([{ value: 'F5', label: 'John Brown (married 1920)' }, { value: 'new', label: 'Other parent unknown' }]);
  });
});

describe('openRelativeDialog: existing person', () => {
  const RESULTS = [
    { id: 'I2', name: 'Ann Jones', birthYear: 1850, deathYear: 1910 },
    { id: 'I7', name: 'Rose Smith', birthYear: 1890, deathYear: null },
    { id: 'I20', name: 'Ann Smith', birthYear: null, deathYear: 1899 },
    { id: 'I21', name: 'Ann Other', birthYear: 1801, deathYear: null },
    { id: 'I22', name: '', birthYear: null, deathYear: null }
  ];

  async function openExisting(relation = 'spouse', person = record(), relationships = rels()) {
    vi.useFakeTimers();
    open(relation, person, relationships);
    tab('existing').click();
  }

  async function search(text) {
    type(field('search'), text);
    await vi.advanceTimersByTimeAsync(250);
  }

  const results = () => $$('.relative-result').map(result =>
    [result.querySelector('.relative-result-name').textContent, result.querySelector('.relative-result-years')?.textContent]
      .filter(Boolean).join(' '));
  const pick = (id) => {
    const radio = $(`.relative-result input[value="${id}"]`);
    radio.checked = true;
    radio.dispatchEvent(new Event('change', { bubbles: true }));
  };

  it('switches tabs, focusing the search and relabelling the button', async () => {
    await openExisting();
    expect(tab('existing').getAttribute('aria-selected')).toBe('true');
    expect($('[data-panel="existing"]').hidden).toBe(false);
    expect($('[data-panel="new"]').hidden).toBe(true);
    expect(document.activeElement).toBe(field('search'));
    expect($('.relative-submit').textContent).toBe('Link');
    tab('new').click();
    expect($('[data-panel="new"]').hidden).toBe(false);
    expect($('.relative-submit').textContent).toBe('Add');
  });

  it('searches 250 ms after the last keystroke, with names and years, without the person themselves', async () => {
    api.search.mockResolvedValue(RESULTS);
    await openExisting();
    type(field('search'), 'A');
    type(field('search'), 'An');
    await vi.advanceTimersByTimeAsync(200);
    type(field('search'), 'Ann');
    await vi.advanceTimersByTimeAsync(249);
    expect(api.search).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(api.search).toHaveBeenCalledTimes(1);
    expect(api.search).toHaveBeenCalledWith('Ann', { limit: 20 });
    expect(results()).toEqual(['Ann Jones 1850–1910', 'Ann Smith d. 1899', 'Ann Other b. 1801', 'Unnamed person']);
  });

  it("doesn't search for fewer than two letters, and clears the results", async () => {
    api.search.mockResolvedValue(RESULTS);
    await openExisting();
    await search('Ann');
    expect(results()).toHaveLength(4);
    await search('A');
    expect(api.search).toHaveBeenCalledTimes(1);
    expect(results()).toHaveLength(0);
  });

  it('ignores an older search that answers late', async () => {
    let answerFirst;
    api.search
      .mockImplementationOnce(() => new Promise(resolve => { answerFirst = resolve; }))
      .mockResolvedValueOnce([{ id: 'I30', name: 'Annie Hall', birthYear: null, deathYear: null }]);
    await openExisting();
    await search('Ann');
    await search('Annie');
    answerFirst(RESULTS);
    await vi.advanceTimersByTimeAsync(0);
    expect(results()).toEqual(['Annie Hall']);
  });

  it('says when nobody matches, and when the search fails', async () => {
    await openExisting();
    await search('Zebedee');
    expect($('.relative-status').textContent).toBe('No one matches.');
    api.search.mockRejectedValueOnce(apiError(0, 'network', { message: "Couldn't reach the server." }));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    await search('Zeb');
    expect($('.relative-status').textContent).toBe("Couldn't search. Check your connection and try again.");
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it('sends link_existing with the chosen person', async () => {
    api.search.mockResolvedValue(RESULTS);
    await openExisting('parent', record({ parentFamilies: [ANN_ALONE] }), rels({ parents: [ANN] }));
    await search('Ann');
    pick('I20');
    $('.relative-submit').click();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent()).toEqual(['link_existing', { anchorId: 'I7', relation: 'parent', otherId: 'I20', familyId: 'F2' }]);
    expect(onAdded).toHaveBeenCalledWith(RESULT);
  });

  it('links a spouse without a familyId, and a child with the chosen partner', async () => {
    api.search.mockResolvedValue(RESULTS);
    await openExisting('spouse');
    await search('Ann');
    pick('I21');
    $('.relative-submit').click();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent()).toEqual(['link_existing', { anchorId: 'I7', relation: 'spouse', otherId: 'I21' }]);

    await openExisting('child', record({ marriages: [WITH_JOHN] }), rels({ spouses: [JOHN] }));
    await search('Ann');
    pick('I20');
    choose('new');
    $('.relative-submit').click();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent()).toEqual(['link_existing', { anchorId: 'I7', relation: 'child', otherId: 'I20', familyId: 'new' }]);
  });

  it('requires someone to be chosen', async () => {
    await openExisting();
    $('.relative-submit').click();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.runChange).not.toHaveBeenCalled();
    expect(errorFor('otherId')).toBe('Search for someone, then choose them.');
  });

  it('warns that a linked child or sibling may get two sets of parents', async () => {
    api.search.mockResolvedValue(RESULTS);
    for (const relation of ['child', 'sibling']) {
      await openExisting(relation, record({ parentFamilies: [BOTH_PARENTS] }), rels({ parents: [TOM, ANN] }));
      await search('Ann');
      expect($('.relative-warning').hidden).toBe(true);
      pick('I2');
      expect($('.relative-warning').hidden).toBe(false);
      expect($('.relative-warning').textContent).toBe('If Ann Jones already has parents, they will have two sets of parents.');
      dialog().closest('.editor-dialog-backdrop').remove();
    }
    for (const relation of ['parent', 'spouse']) {
      await openExisting(relation);
      await search('Ann');
      pick('I2');
      expect($('.relative-warning')?.hidden ?? true).toBe(true);
      dialog().closest('.editor-dialog-backdrop').remove();
    }
  });

  it('shows results as text', async () => {
    api.search.mockResolvedValue([{ id: 'I40', name: XSS, birthYear: XSS, deathYear: null }]);
    await openExisting('child');
    await search('img');
    expect(results()).toEqual([`${XSS} b. ${XSS}`]);
    pick('I40');
    expect($('.relative-warning').textContent).toContain(XSS);
    expect(document.querySelector('img')).toBeNull();
  });

  it('shows an otherId error at the search', async () => {
    api.search.mockResolvedValue(RESULTS);
    api.runChange.mockRejectedValueOnce(apiError(400, 'invalid', { field: 'otherId', message: 'That would make Ann Jones their own ancestor.' }));
    await openExisting('child');
    await search('Ann');
    pick('I2');
    $('.relative-submit').click();
    await vi.advanceTimersByTimeAsync(0);
    expect(errorFor('otherId')).toBe('That would make Ann Jones their own ancestor.');
    expect(dialog()).not.toBeNull();
  });

  it('says when the chosen person no longer exists', async () => {
    api.search.mockResolvedValue(RESULTS);
    api.runChange.mockRejectedValueOnce(apiError(404, 'not_found', { field: 'otherId' }));
    await openExisting();
    await search('Ann');
    pick('I2');
    $('.relative-submit').click();
    await vi.advanceTimersByTimeAsync(0);
    expect(errorFor('otherId')).toBe('That person no longer exists: someone else deleted them.');
  });
});

describe('openRelativeDialog: errors', () => {
  it('shows a field error next to its field', async () => {
    api.runChange.mockRejectedValueOnce(apiError(400, 'invalid', { field: 'birth_date', message: 'Birth date must be a single line.' }));
    open('spouse');
    type(field('birth_date'), '1850');
    await submit();
    expect(errorFor('birth_date')).toBe('Birth date must be a single line.');
    expect(field('birth_date').getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(field('birth_date'));
    expect(message()).toBeNull();
    expect(onAdded).not.toHaveBeenCalled();
    // Trying again clears it.
    api.runChange.mockRejectedValueOnce(apiError(0, 'network', { message: "Couldn't reach the server. Check your connection." }));
    await submit();
    expect(errorFor('birth_date')).toBeNull();
    expect(message()).toBe("Couldn't reach the server. Check your connection.");
    expect(field('birth_date').hasAttribute('aria-invalid')).toBe(false);
  });

  it('shows a familyId error at the family choice', async () => {
    api.runChange.mockRejectedValueOnce(apiError(400, 'invalid', { field: 'familyId', message: "Tom Smith isn't a parent in that family." }));
    open('child', record({ marriages: [WITH_JOHN] }), rels({ spouses: [JOHN] }));
    await submit();
    expect(errorFor('familyId')).toBe("Tom Smith isn't a parent in that family.");
  });

  it('shows relation and person errors in the message area', async () => {
    api.runChange.mockRejectedValueOnce(apiError(400, 'invalid', { field: 'relation', message: 'Add a parent first: Rose Smith has no parents to share.' }));
    open('sibling', record({ parentFamilies: [BOTH_PARENTS] }), rels({ parents: [TOM, ANN] }));
    await submit();
    expect(message()).toBe('Add a parent first: Rose Smith has no parents to share.');
    api.runChange.mockRejectedValueOnce(apiError(400, 'invalid', { field: 'person', message: 'Tom Smith is already a parent in that family.' }));
    await submit();
    expect(message()).toBe('Tom Smith is already a parent in that family.');
  });

  it('says when the person themselves was deleted', async () => {
    api.runChange.mockRejectedValueOnce(apiError(404, 'not_found', { field: 'anchorId' }));
    open('spouse');
    await submit();
    expect(message()).toBe('Rose Smith no longer exists: someone else deleted them.');
  });

  it('offers to reload this person on a stale error', async () => {
    api.runChange.mockRejectedValueOnce(apiError(409, 'stale', { message: 'That family no longer exists. Reload to see the latest.' }));
    const fresh = { person: record({ parentFamilies: [ANN_ALONE] }), relationships: rels({ parents: [ANN] }), masked: false };
    loader.reload.mockResolvedValue(fresh);
    open('spouse');
    await submit();
    expect(message()).toBe('That family no longer exists. Reload to see the latest.');
    const reload = $('.editor-reload');
    expect(reload.hidden).toBe(false);
    reload.click();
    await flush();
    expect(loader.reload).toHaveBeenCalledWith('I7');
    expect(dialog()).toBeNull();
    expect(onReloaded).toHaveBeenCalledWith(fresh);
  });

  it('shows network and permission errors in words', async () => {
    api.runChange.mockRejectedValueOnce(apiError(0, 'network', { message: "Couldn't reach the server. Check your connection." }));
    open('spouse');
    await submit();
    expect(message()).toBe("Couldn't reach the server. Check your connection.");
    api.runChange.mockRejectedValueOnce(apiError(403, 'not_an_editor'));
    await submit();
    expect(message()).toBe("Your account can't edit the tree. Ask Rob for access.");
  });

  it('is busy while saving and closes with Cancel or Escape', async () => {
    let finish;
    api.runChange.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const handle = open('spouse');
    $('.relative-submit').click();
    await flush();
    expect($('.relative-submit').disabled).toBe(true);
    expect($('.relative-submit').textContent).toBe('Adding…');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(handle.isOpen()).toBe(true);
    finish(RESULT);
    await flush();
    expect(handle.isOpen()).toBe(false);

    open('spouse');
    $('.relative-cancel').click();
    expect(dialog()).toBeNull();
    open('spouse');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(dialog()).toBeNull();
    expect(api.runChange).toHaveBeenCalledTimes(1);
  });
});

describe('familyLinks', () => {
  it('works out which of the person\'s families a child is in', () => {
    const person = record({ marriages: [WITH_JOHN, NO_SPOUSE] });
    expect(familyOfChild(person, LILY)).toBe('F5');
    expect(familyOfChild(person, OLIVE)).toBe('F7');
    expect(familyOfChild(record({ marriages: [WITH_JOHN] }), OLIVE)).toBe('F5');
    expect(familyOfChild(record({ marriages: [WITH_JOHN, WITH_PAUL] }), OLIVE)).toBeNull();
  });

  it('blocks a sibling without parents and a parent when the parents are complete', () => {
    expect(relativeBlocked(record(), 'sibling')).toBe('Add a parent first');
    expect(relativeBlocked(record({ parentFamilies: [ANN_ALONE] }), 'sibling')).toBeNull();
    expect(relativeBlocked(record(), 'parent')).toBeNull();
    expect(relativeBlocked(record({ parentFamilies: [BOTH_PARENTS] }), 'parent')).toBe('Already has two parents');
    expect(relativeBlocked(record({ parentFamilies: [BOTH_PARENTS, ANN_ALONE] }), 'parent')).toBeNull();
    expect(relativeBlocked(record(), 'spouse')).toBeNull();
    expect(relativeBlocked(record(), 'child')).toBeNull();
  });
});

describe('unlink confirmation', () => {
  const ROSE_WITH_PARENTS = record({ parentFamilies: [BOTH_PARENTS] });
  const FAMILY_RELS = rels({ parents: [TOM, ANN], siblings: [JACK, JILL], spouses: [JOHN], children: [LILY, OLIVE] });

  it('says a parent stops being a parent of the siblings in that family too', () => {
    const text = unlinkConfirmText({ person: ROSE_WITH_PARENTS, relationships: FAMILY_RELS, relation: 'parent', personId: 'I1', familyId: 'F1' });
    expect(text.title).toBe('Remove a parent');
    expect(text.question).toBe('Remove Tom Smith as a parent of Rose Smith?');
    expect(text.details).toEqual(['This also removes Tom Smith as a parent of Jack Smith and Jill Smith.']);
  });

  it('says when removing the last parent also removes the family and the sibling links', () => {
    const person = record({ parentFamilies: [{ familyId: 'F2', partnerIds: ['I2'], childIds: ['I7', 'I8', 'I10'] }] });
    const text = unlinkConfirmText({ person, relationships: rels({ parents: [ANN], siblings: [JACK, JILL] }), relation: 'parent', personId: 'I2', familyId: 'F2' });
    expect(text.question).toBe('Remove Ann Jones as a parent of Rose Smith?');
    expect(text.details).toEqual([
      'Ann Jones is the only parent in this family, so the family will be removed too. ' +
      'That also removes the sibling links between Rose Smith, Jack Smith and Jill Smith.'
    ]);
    const two = record({ parentFamilies: [{ familyId: 'F2', partnerIds: ['I2'], childIds: ['I7', 'I8'] }] });
    expect(unlinkConfirmText({ person: two, relationships: rels({ parents: [ANN], siblings: [JACK] }), relation: 'parent', personId: 'I2', familyId: 'F2' }).details[0])
      .toContain('That also removes the sibling link between Rose Smith and Jack Smith.');
  });

  it('says when the last parent is removed from an only child', () => {
    const person = record({ parentFamilies: [ANN_ALONE] });
    const text = unlinkConfirmText({ person, relationships: rels({ parents: [ANN] }), relation: 'parent', personId: 'I2', familyId: 'F2' });
    expect(text.details).toEqual(['Ann Jones is the only parent in this family, so the family will be removed too.']);
  });

  it('says a removed spouse stops being a parent of their children together', () => {
    const person = record({ marriages: [WITH_JOHN, NO_SPOUSE] });
    const text = unlinkConfirmText({ person, relationships: FAMILY_RELS, relation: 'spouse', personId: 'I3', familyId: 'F5' });
    expect(text.title).toBe('Remove a spouse');
    expect(text.question).toBe('Remove John Brown as the spouse of Rose Smith?');
    expect(text.details).toEqual(['This also removes John Brown as a parent of Lily Brown.']);
  });

  it('says a childless marriage is removed with the spouse', () => {
    const person = record({ marriages: [WITH_PAUL] });
    const text = unlinkConfirmText({ person, relationships: rels({ spouses: [PAUL] }), relation: 'spouse', personId: 'I5', familyId: 'F6' });
    expect(text.details).toEqual(['This also removes their marriage record.']);
  });

  it('names both parents of a removed child', () => {
    const person = record({ marriages: [WITH_JOHN, NO_SPOUSE] });
    const child = unlinkConfirmText({ person, relationships: FAMILY_RELS, relation: 'child', personId: 'I11', familyId: 'F5' });
    expect(child.title).toBe('Remove a child');
    expect(child.question).toBe('Remove Lily Brown as a child of Rose Smith and John Brown?');
    expect(child.details).toEqual([]);
    const alone = unlinkConfirmText({ person, relationships: FAMILY_RELS, relation: 'child', personId: 'I12', familyId: 'F7' });
    expect(alone.question).toBe('Remove Olive Smith as a child of Rose Smith?');
  });

  describe('openUnlinkConfirm', () => {
    let onUnlinked;
    const confirmDialog = () => document.querySelector('.unlink-confirm');
    const confirm$ = (selector) => confirmDialog().querySelector(selector);
    const openConfirm = (extra = {}) => openUnlinkConfirm({
      person: ROSE_WITH_PARENTS, relationships: FAMILY_RELS, relation: 'parent', personId: 'I1', familyId: 'F1',
      api, loader, onUnlinked, onReloaded, ...extra
    });

    beforeEach(() => {
      onUnlinked = vi.fn();
    });

    it('shows the question, the consequences and undo, focused on Cancel', () => {
      openConfirm();
      expect(confirm$('.editor-dialog-title').textContent).toBe('Remove a parent');
      expect([...confirm$('.unlink-confirm-text').querySelectorAll('p')].map(p => p.textContent)).toEqual([
        'Remove Tom Smith as a parent of Rose Smith?',
        'This also removes Tom Smith as a parent of Jack Smith and Jill Smith.',
        'You can undo this from History.'
      ]);
      expect(document.activeElement).toBe(confirm$('.unlink-cancel'));
    });

    it('sends unlink with the role and the viewed person as focus', async () => {
      openConfirm();
      confirm$('.unlink-remove').click();
      await flush();
      expect(api.runChange).toHaveBeenCalledWith('unlink', { familyId: 'F1', personId: 'I1', role: 'partner', focusId: 'I7' });
      expect(confirmDialog()).toBeNull();
      expect(onUnlinked).toHaveBeenCalledWith(RESULT);
    });

    it('sends role child for a child', async () => {
      openConfirm({ person: record({ marriages: [WITH_JOHN] }), relation: 'child', personId: 'I11', familyId: 'F5' });
      confirm$('.unlink-remove').click();
      await flush();
      expect(api.runChange).toHaveBeenCalledWith('unlink', { familyId: 'F5', personId: 'I11', role: 'child', focusId: 'I7' });
    });

    it('sends role partner for a spouse', async () => {
      openConfirm({ person: record({ marriages: [WITH_JOHN] }), relation: 'spouse', personId: 'I3', familyId: 'F5' });
      confirm$('.unlink-remove').click();
      await flush();
      expect(api.runChange).toHaveBeenCalledWith('unlink', { familyId: 'F5', personId: 'I3', role: 'partner', focusId: 'I7' });
    });

    it('cancels without sending', () => {
      openConfirm();
      confirm$('.unlink-cancel').click();
      expect(confirmDialog()).toBeNull();
      expect(api.runChange).not.toHaveBeenCalled();
    });

    it('shows a stale error with Reload this person', async () => {
      api.runChange.mockRejectedValueOnce(apiError(409, 'stale', { message: 'They are no longer a partner in that family. Reload to see the latest.' }));
      const fresh = { person: record(), relationships: rels(), masked: false };
      loader.reload.mockResolvedValue(fresh);
      openConfirm();
      confirm$('.unlink-remove').click();
      await flush();
      expect(confirm$('.editor-form-message .editor-error').textContent).toBe('They are no longer a partner in that family. Reload to see the latest.');
      expect(onUnlinked).not.toHaveBeenCalled();
      confirm$('.editor-reload').click();
      await flush();
      expect(loader.reload).toHaveBeenCalledWith('I7');
      expect(confirmDialog()).toBeNull();
      expect(onReloaded).toHaveBeenCalledWith(fresh);
    });

    it('shows other errors in words', async () => {
      api.runChange.mockRejectedValueOnce(apiError(0, 'network', { message: "Couldn't reach the server. Check your connection." }));
      openConfirm();
      confirm$('.unlink-remove').click();
      await flush();
      expect(confirm$('.editor-form-message .editor-error').textContent).toBe("Couldn't reach the server. Check your connection.");
      expect(confirm$('.editor-reload').hidden).toBe(true);
      expect(confirm$('.unlink-remove').disabled).toBe(false);
    });

    it('shows names as text', () => {
      openConfirm({ relationships: rels({ parents: [{ ...TOM, name: XSS }, ANN], siblings: [JACK, JILL] }) });
      expect(confirm$('.unlink-confirm-text').textContent).toContain(XSS);
      expect(document.querySelector('img')).toBeNull();
    });
  });
});
