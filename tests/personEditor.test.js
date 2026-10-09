import { describe, it, expect, vi, beforeEach } from 'vitest';
import { openPersonEditor } from '../src/personEditor.js';
import { isEditorDialogOpen } from '../src/editorDialog.js';
import { showToast } from '../src/toast.js';

vi.mock('../src/toast.js', () => ({ showToast: vi.fn() }));

const XSS = '<img src=x onerror="window.__xss = 1">';
const STAMP = '2026-10-09T12:00:00.123456Z';
const STAMP2 = '2026-10-09T12:05:00.654321Z';

// A pre-backfill person, as on the `editing` branch today.
const record = (extra = {}) => ({
  id: 'I7', name: 'Rose Smith', givenName: 'Rose', surname: 'Smith', sex: 'F',
  birthDate: '12 MAR 1890', birthPlace: 'Leeds', deathDate: null, deathPlace: null, baptismDate: '1890',
  photos: [], parentIds: [], spouseIds: [], childIds: [], avatarKey: null, updatedAt: STAMP, parentFamilies: [], marriages: [],
  notes: ['A note'],
  occupations: ['Farmer'],
  censusRecords: [{ date: '1891', place: null }],
  religion: 'Methodist',
  ...extra
});
const STORED_FACTS = { notes: ['A note'], occupations: ['Farmer'], censusRecords: [{ date: '1891', place: null }], religion: 'Methodist' };

const apiError = (status, code, body = {}) => Object.assign(new Error(body.message ?? code), { name: 'ApiError', status, code, field: body.field ?? null, body });
const RESULT = { change: { id: 41, summary: 'Edited Rose Smith (given name)', personIds: ['I7'] }, view: { person: { id: 'I7' } } };

let api;
let loader;
let onSaved;
let onDeleted;
let onReloaded;

async function open(extra = {}, options = {}) {
  return openPersonEditor({ person: record(extra), api, loader, onSaved, onDeleted, onReloaded, ...options });
}

const dialog = () => document.querySelector('.person-editor');
const $ = (selector) => dialog().querySelector(selector);
const $$ = (selector) => [...dialog().querySelectorAll(selector)];
const field = (name) => $(`[name="${name}"]`);
const rows = () => $$('.fact-row');
const inRow = (row, name) => row.querySelector(`[name="${name}"]`);
const change = (element, value) => {
  element.value = value;
  element.dispatchEvent(new Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
};
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const save = async () => {
  $('.person-editor-save').click();
  await flush();
};
const sent = () => api.runChange.mock.calls.at(-1);
const message = () => ($('.editor-form-message')?.hidden === false ? $('.editor-form-message .editor-error').textContent : null);
const keydown = (target, key) => target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));

beforeEach(() => {
  document.body.innerHTML = '<button id="opener">Edit</button>';
  document.getElementById('opener').focus();
  api = { runChange: vi.fn().mockResolvedValue(RESULT) };
  loader = { reload: vi.fn() };
  onSaved = vi.fn();
  onDeleted = vi.fn();
  onReloaded = vi.fn();
  showToast.mockClear();
  delete window.__xss;
});

describe('openPersonEditor: the form', () => {
  it('opens a dialog filled with the person, focused on the given name', async () => {
    const editor = await open();
    expect(editor.isOpen()).toBe(true);
    expect(isEditorDialogOpen()).toBe(true);
    expect(dialog().getAttribute('role')).toBe('dialog');
    expect($('.editor-dialog-title').textContent).toBe('Edit Rose Smith');
    expect(document.activeElement).toBe(field('given_name'));
    expect(field('given_name').value).toBe('Rose');
    expect(field('surname').value).toBe('Smith');
    expect(field('sex').value).toBe('F');
    expect(field('birth_date').value).toBe('12 MAR 1890');
    expect(field('birth_place').value).toBe('Leeds');
    expect(field('death_date').value).toBe('');
    expect(field('baptism_date').value).toBe('1890');
    expect(dialog().textContent).toContain('e.g. 12 MAR 1890, ABT 1850, BEF 1900');
    expect($$('.person-editor-notes .editor-note textarea').map(t => t.value)).toEqual(['A note']);
  });

  it('shows old-shape facts as rows: an occupation string, a census record with a null place, religion', async () => {
    await open();
    expect(rows().map(row => inRow(row, 'kind').value)).toEqual(['occupation', 'other', 'census']);
    expect(inRow(rows()[0], 'value').value).toBe('Farmer');
    expect(inRow(rows()[1], 'tag').value).toBe('RELI');
    expect(inRow(rows()[1], 'tag').selectedOptions[0].textContent).toBe('Religion');
    expect(inRow(rows()[1], 'value').value).toBe('Methodist');
    expect(inRow(rows()[2], 'date').value).toBe('1891');
    expect(inRow(rows()[2], 'place').value).toBe('');
    // Tag, type and cause belong to "other" facts only.
    expect(inRow(rows()[0], 'tag').closest('[hidden]')).not.toBeNull();
    expect(inRow(rows()[1], 'type').closest('[hidden]')).toBeNull();
  });

  it('shows new-shape facts, life event notes and an unknown tag as free text', async () => {
    await open({
      occupations: [{ value: 'Weaver', date: '1881', notes: ['At the mill'] }],
      otherFacts: [{ tag: '_FOO', value: 'x' }],
      deathNotes: ['Died as an infant'],
      causeOfDeath: 'Fever',
      email: 'rose@example.test'
    });
    expect($$('[data-event="death"] .editor-note textarea').map(t => t.value)).toEqual(['Died as an infant']);
    expect(field('cause_of_death').value).toBe('Fever');
    expect(field('email').value).toBe('rose@example.test');
    const [weaver, foo] = rows();
    expect([...weaver.querySelectorAll('.editor-note textarea')].map(t => t.value)).toEqual(['At the mill']);
    expect(inRow(foo, 'tag').value).toBe('__custom');
    expect(inRow(foo, 'custom_tag').value).toBe('_FOO');
    expect(inRow(foo, 'custom_tag').closest('[hidden]')).toBeNull();
  });

  it('shows every value as text', async () => {
    await open({ name: XSS, givenName: XSS, notes: [XSS], occupations: [XSS], otherFacts: [{ tag: XSS, type: XSS }] });
    expect($('.editor-dialog-title').textContent).toBe(`Edit ${XSS}`);
    expect(field('given_name').value).toBe(XSS);
    expect(document.querySelector('img')).toBeNull();
    expect(window.__xss).toBeUndefined();
  });

  it('closes on Escape and Cancel without saving, and gives focus back', async () => {
    const editor = await open();
    keydown(field('surname'), 'Escape');
    expect(editor.isOpen()).toBe(false);
    expect(dialog()).toBeNull();
    expect(isEditorDialogOpen()).toBe(false);
    expect(document.activeElement.id).toBe('opener');

    await open();
    $('.person-editor-cancel').click();
    expect(dialog()).toBeNull();
    expect(api.runChange).not.toHaveBeenCalled();
  });
});

describe('openPersonEditor: saving', () => {
  it('sends only the changed fields, and no facts when they are unchanged', async () => {
    await open();
    change(field('given_name'), '  Rosie ');
    change(field('birth_place'), '');
    change(field('surname'), 'Smyth');
    change(field('surname'), 'Smith'); // changed back
    await save();
    expect(api.runChange).toHaveBeenCalledTimes(1);
    expect(sent()).toEqual(['update_person', { id: 'I7', expectedUpdatedAt: STAMP, fields: { given_name: 'Rosie', birth_place: '' } }]);
    expect(onSaved).toHaveBeenCalledWith(RESULT);
    expect(dialog()).toBeNull();
  });

  it('sends a sex change, with null for "not recorded"', async () => {
    await open();
    change(field('sex'), '');
    await save();
    expect(sent()[1].fields).toEqual({ sex: null });
  });

  it('sends the whole facts object when a fact changed, keeping the untouched old shapes', async () => {
    await open();
    change($('.person-editor-notes .editor-note textarea'), 'A changed note\n\n');
    await save();
    expect(sent()).toEqual(['update_person', {
      id: 'I7', expectedUpdatedAt: STAMP, fields: {},
      facts: { ...STORED_FACTS, notes: ['A changed note'] }
    }]);
  });

  it('saves an edited old-shape row in the new shape', async () => {
    await open();
    change(inRow(rows()[0], 'value'), 'Farm labourer');
    change(inRow(rows()[2], 'place'), 'Leeds');
    change(inRow(rows()[1], 'value'), 'Quaker');
    await save();
    expect(sent()[1].facts).toEqual({
      notes: ['A note'],
      occupations: [{ value: 'Farm labourer' }],
      censusRecords: [{ date: '1891', place: 'Leeds' }],
      otherFacts: [{ tag: 'RELI', value: 'Quaker' }]
    });
  });

  it('adds facts, notes and life event notes, dropping notes left blank', async () => {
    await open();
    $('.fact-add').click();
    const added = rows().at(-1);
    expect(document.activeElement).toBe(inRow(added, 'kind'));
    change(inRow(added, 'kind'), 'other');
    expect(inRow(added, 'tag').closest('[hidden]')).toBeNull();
    change(inRow(added, 'tag'), '_MILT');
    change(inRow(added, 'type'), 'Army');
    change(inRow(added, 'value'), 'Private');
    added.querySelector('.editor-notes-add').click();
    change(added.querySelector('.editor-note textarea'), 'Wounded at the Somme');

    $('[data-event="birth"] .editor-notes-add').click();
    expect(document.activeElement).toBe($('[data-event="birth"] .editor-note textarea'));
    change($('[data-event="birth"] .editor-note textarea'), 'Born at home');
    $('.person-editor-notes .editor-notes-add').click(); // left blank
    change(field('cause_of_death'), ' Fever ');
    change(field('phone'), '0113 496 0000');
    await save();
    expect(sent()[1].facts).toEqual({
      ...STORED_FACTS,
      otherFacts: [{ tag: '_MILT', type: 'Army', value: 'Private', notes: ['Wounded at the Somme'] }],
      birthNotes: ['Born at home'],
      causeOfDeath: 'Fever',
      phone: '0113 496 0000'
    });
  });

  it('types a custom tag', async () => {
    await open();
    $('.fact-add').click();
    const added = rows().at(-1);
    change(inRow(added, 'kind'), 'other');
    change(inRow(added, 'tag'), '__custom');
    expect(inRow(added, 'custom_tag').closest('[hidden]')).toBeNull();
    change(inRow(added, 'custom_tag'), ' _CUST ');
    await save();
    expect(sent()[1].facts.otherFacts).toEqual([{ tag: '_CUST' }]);
  });

  it('removes facts and notes', async () => {
    await open();
    rows()[0].querySelector('.fact-row-remove').click();
    $('.person-editor-notes .editor-note-remove').click();
    expect(rows()).toHaveLength(2);
    await save();
    expect(sent()[1].facts).toEqual({ censusRecords: [{ date: '1891', place: null }], religion: 'Methodist' });
  });

  it('keeps an untouched unknown tag and blank stored occupations', async () => {
    await open({ occupations: ['', 'Miller'], otherFacts: [{ tag: '_FOO', value: 'x' }] });
    change(field('given_name'), 'Rosa');
    await save();
    expect(sent()[1]).not.toHaveProperty('facts');
  });

  it('says "Nothing changed" and closes without calling the API when nothing changed', async () => {
    await open();
    change(field('given_name'), 'Rose ');
    await save();
    expect(api.runChange).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith('Nothing changed');
    expect(dialog()).toBeNull();
  });

  it('says "Nothing changed" and closes when the server found no change', async () => {
    api.runChange.mockRejectedValue(apiError(400, 'no_change'));
    await open();
    change(field('given_name'), 'Rosa');
    await save();
    expect(showToast).toHaveBeenCalledWith('Nothing changed');
    expect(dialog()).toBeNull();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('is busy while saving: controls disabled, Escape ignored', async () => {
    let resolve;
    api.runChange.mockReturnValue(new Promise(r => { resolve = r; }));
    await open();
    change(field('given_name'), 'Rosa');
    $('.person-editor-save').click();
    expect($('.person-editor-save').disabled).toBe(true);
    expect($('.person-editor-save').textContent).toBe('Saving…');
    expect(field('surname').disabled).toBe(true);
    keydown(field('surname'), 'Escape');
    expect(dialog()).not.toBeNull();
    $('.person-editor-save').click();
    expect(api.runChange).toHaveBeenCalledTimes(1);
    resolve(RESULT);
    await flush();
    expect(dialog()).toBeNull();
    expect(onSaved).toHaveBeenCalledWith(RESULT);
  });
});

describe('openPersonEditor: errors', () => {
  it('shows a validation error next to its field and keeps the form open', async () => {
    api.runChange.mockRejectedValue(apiError(400, 'invalid', { field: 'birth_date', message: 'Birth date must be at most 500 characters.' }));
    await open();
    change(field('birth_date'), 'x'.repeat(501));
    await save();
    const error = $('[data-error-for="birth_date"]');
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe('Birth date must be at most 500 characters.');
    expect(field('birth_date').getAttribute('aria-invalid')).toBe('true');
    expect(field('birth_date').getAttribute('aria-describedby')).toBe(error.id);
    expect(document.activeElement).toBe(field('birth_date'));
    expect($('.person-editor-save').disabled).toBe(false);
    expect($('.person-editor-save').textContent).toBe('Save');
    expect(onSaved).not.toHaveBeenCalled();

    // The next attempt clears it.
    api.runChange.mockResolvedValue(RESULT);
    change(field('birth_date'), '1890');
    await save();
    expect(onSaved).toHaveBeenCalled();
  });

  it('shows a facts error in the section that edits it', async () => {
    api.runChange.mockRejectedValue(apiError(400, 'invalid', { field: 'facts.notes', message: 'Notes are too long.' }));
    await open();
    change($('.person-editor-notes .editor-note textarea'), 'Longer');
    await save();
    expect($('.person-editor-notes [data-error-for="notes"]').textContent).toBe('Notes are too long.');
    expect(message()).toBeNull();
  });

  it('shows an error for a field it has no place for at the foot of the form', async () => {
    api.runChange.mockRejectedValue(apiError(400, 'invalid', { field: 'expectedUpdatedAt', message: 'expectedUpdatedAt must be the updatedAt the person was read with.' }));
    await open();
    change(field('given_name'), 'Rosa');
    await save();
    expect(message()).toBe('expectedUpdatedAt must be the updatedAt the person was read with.');
  });

  it('shows network and server errors inline, keeping the edits', async () => {
    api.runChange.mockRejectedValue(apiError(0, 'network', { message: "Couldn't reach the server. Check your connection." }));
    await open();
    change(field('given_name'), 'Rosa');
    await save();
    expect(message()).toBe("Couldn't reach the server. Check your connection.");
    expect(field('given_name').value).toBe('Rosa');
    expect($('.editor-reload').hidden).toBe(true);

    api.runChange.mockRejectedValue(apiError(500, 'internal'));
    await save();
    expect(message()).toBe('The server had a problem (internal). Try again.');

    api.runChange.mockRejectedValue(apiError(401, 'unauthenticated'));
    await save();
    expect(message()).toMatch(/signed out/i);
    expect(dialog()).not.toBeNull();
  });

  it('offers Reload when someone else changed the person, reopening the editor with fresh data', async () => {
    api.runChange.mockRejectedValueOnce(apiError(409, 'stale'));
    await open();
    change(field('given_name'), 'Rosa');
    await save();
    expect(message()).toBe('Someone else changed this person. Reload to see their changes.');
    const reloadButton = $('.editor-reload');
    expect(reloadButton.hidden).toBe(false);

    const fresh = { person: record({ givenName: 'Rosalind', name: 'Rosalind Smith', updatedAt: STAMP2 }), masked: false, family: [], relationships: {} };
    loader.reload.mockResolvedValue(fresh);
    reloadButton.click();
    await flush();
    expect(loader.reload).toHaveBeenCalledWith('I7');
    expect(onReloaded).toHaveBeenCalledWith(fresh);
    expect(document.querySelectorAll('.person-editor')).toHaveLength(1);
    expect(field('given_name').value).toBe('Rosalind');

    change(field('given_name'), 'Rosa');
    await save();
    expect(sent()[1]).toEqual({ id: 'I7', expectedUpdatedAt: STAMP2, fields: { given_name: 'Rosa' } });
  });

  it('says so when the person was deleted meanwhile', async () => {
    api.runChange.mockRejectedValueOnce(apiError(409, 'stale'));
    await open();
    change(field('given_name'), 'Rosa');
    await save();
    loader.reload.mockRejectedValue(Object.assign(new Error('Person I7 not found'), { name: 'PersonNotFoundError' }));
    $('.editor-reload').click();
    await flush();
    expect(message()).toBe('Rose Smith no longer exists: someone else deleted them.');
    expect($('.editor-reload').hidden).toBe(true);
  });
});

describe('openPersonEditor: delete', () => {
  it('confirms, then sends delete_person with the updatedAt it was read with', async () => {
    const DELETED = { change: { id: 42, summary: 'Deleted Rose Smith', personIds: ['I7'] }, view: null };
    api.runChange.mockResolvedValue(DELETED);
    await open();
    $('.person-editor-delete').click();
    expect($('.person-editor-confirm-text').textContent).toBe('Delete Rose Smith? You can undo this from History.');
    expect($('.person-editor-fields').hidden).toBe(true);
    expect(document.activeElement).toBe($('.person-editor-confirm-cancel'));
    expect(api.runChange).not.toHaveBeenCalled();

    $('.person-editor-confirm-delete').click();
    await flush();
    expect(sent()).toEqual(['delete_person', { id: 'I7', expectedUpdatedAt: STAMP }]);
    expect(onDeleted).toHaveBeenCalledWith(DELETED);
    expect(onSaved).not.toHaveBeenCalled();
    expect(dialog()).toBeNull();
  });

  it('goes back to the form on Cancel or Escape', async () => {
    await open();
    $('.person-editor-delete').click();
    $('.person-editor-confirm-cancel').click();
    expect($('.person-editor-fields').hidden).toBe(false);
    expect($('.person-editor-confirm').hidden).toBe(true);
    $('.person-editor-delete').click();
    keydown($('.person-editor-confirm-cancel'), 'Escape');
    expect(dialog()).not.toBeNull();
    expect($('.person-editor-fields').hidden).toBe(false);
    expect(api.runChange).not.toHaveBeenCalled();
  });

  it('names an unnamed person', async () => {
    await open({ name: '', givenName: '', surname: '' });
    expect($('.editor-dialog-title').textContent).toBe('Edit Unnamed person');
    $('.person-editor-delete').click();
    expect($('.person-editor-confirm-text').textContent).toBe('Delete Unnamed person? You can undo this from History.');
  });

  it('offers Reload when the person changed meanwhile', async () => {
    api.runChange.mockRejectedValue(apiError(409, 'stale'));
    await open();
    $('.person-editor-delete').click();
    $('.person-editor-confirm-delete').click();
    await flush();
    expect(message()).toBe('Someone else changed this person. Reload to see their changes.');
    expect($('.editor-reload').hidden).toBe(false);
    expect(onDeleted).not.toHaveBeenCalled();
  });
});

describe('openPersonEditor: masked views', () => {
  const unmasked = () => ({ person: record({ notes: ['Write to rose@example.test'] }), masked: false, family: [], relationships: {} });

  it('reloads a masked view before editing it', async () => {
    loader.reload.mockResolvedValue(unmasked());
    const editor = await open({ notes: ['Write to [email hidden]'] }, { masked: true });
    expect(loader.reload).toHaveBeenCalledWith('I7');
    expect(editor).not.toBeNull();
    expect($('.person-editor-notes .editor-note textarea').value).toBe('Write to rose@example.test');
    expect(onReloaded).toHaveBeenCalled();
  });

  it('also notices `masked` on the person record', async () => {
    loader.reload.mockResolvedValue(unmasked());
    await open({ masked: true });
    expect(loader.reload).toHaveBeenCalledWith('I7');
  });

  it('does not reload an unmasked view', async () => {
    await open({}, { masked: false });
    expect(loader.reload).not.toHaveBeenCalled();
  });

  it('refuses when the view is still masked, or cannot be reloaded', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    loader.reload.mockResolvedValue({ ...unmasked(), masked: true });
    expect(await open({}, { masked: true })).toBeNull();
    expect(dialog()).toBeNull();
    expect(showToast).toHaveBeenLastCalledWith(expect.stringMatching(/can't be edited/), { kind: 'error' });

    loader.reload.mockRejectedValue(new Error('offline'));
    expect(await open({}, { masked: true })).toBeNull();
    expect(dialog()).toBeNull();
    expect(api.runChange).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});
