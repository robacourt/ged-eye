import { describe, it, expect, vi, beforeEach } from 'vitest';
import { openFamilyEditor } from '../src/familyEditor.js';
import { showToast } from '../src/toast.js';

vi.mock('../src/toast.js', () => ({ showToast: vi.fn() }));

const XSS = '<img src=x onerror="window.__xss = 1">';
const RESULT = { change: { id: 9, summary: 'Edited the marriage of Tom Smith and Ann Jones', personIds: ['I1', 'I2'] }, view: { person: { id: 'I1' } } };
const apiError = (status, code, body = {}) => Object.assign(new Error(body.message ?? code), { name: 'ApiError', status, code, field: body.field ?? null, body });

const FAMILY = {
  familyId: 'F1',
  partners: [{ id: 'I1', name: 'Tom Smith' }, { id: 'I2', name: 'Ann Jones' }],
  marriageDate: '1920',
  marriagePlace: undefined,
  divorceDate: null
};

let api;
let loader;
let onSaved;
let onReloaded;

const open = (options = {}) => openFamilyEditor({ family: FAMILY, api, onSaved, ...options });
const dialog = () => document.querySelector('.family-editor');
const $ = (selector) => dialog().querySelector(selector);
const field = (name) => $(`[name="${name}"]`);
const type = (input, value) => {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
};
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const save = async () => {
  $('.family-editor-save').click();
  await flush();
};
const message = () => ($('.editor-form-message').hidden ? null : $('.editor-form-message .editor-error').textContent);

beforeEach(() => {
  document.body.innerHTML = '';
  api = { runChange: vi.fn().mockResolvedValue(RESULT) };
  loader = { reload: vi.fn() };
  onSaved = vi.fn();
  onReloaded = vi.fn();
  showToast.mockClear();
});

describe('openFamilyEditor', () => {
  it('opens a dialog for the couple with the marriage and divorce details', () => {
    const editor = open();
    expect(editor.isOpen()).toBe(true);
    expect($('.editor-dialog-title').textContent).toBe('Edit the marriage of Tom Smith and Ann Jones');
    expect(field('marriage_date').value).toBe('1920');
    expect(field('marriage_place').value).toBe('');
    expect(field('divorce_date').value).toBe('');
    expect(field('divorce_place').value).toBe('');
    expect(dialog().textContent).toContain('e.g. 12 MAR 1890, ABT 1850, BEF 1900');
    expect(document.activeElement).toBe(field('marriage_date'));
  });

  it('names one partner, unnamed partners and partners given as names, all as text', () => {
    open({ family: { ...FAMILY, partners: ['Tom Smith'] } });
    expect($('.editor-dialog-title').textContent).toBe('Edit the marriage of Tom Smith');
    dialog().closest('.editor-dialog-backdrop').remove();
    open({ family: { ...FAMILY, partners: [{ id: 'I1', name: '' }, { id: 'I2', name: XSS }] } });
    expect($('.editor-dialog-title').textContent).toBe(`Edit the marriage of Unnamed person and ${XSS}`);
    expect(document.querySelector('img')).toBeNull();
  });

  it('sends update_family with the four fields as seen and only the changed ones', async () => {
    open({ focusId: 'I2' });
    type(field('marriage_place'), ' Leeds ');
    type(field('marriage_date'), '1920 ');
    await save();
    expect(api.runChange).toHaveBeenCalledWith('update_family', {
      id: 'F1',
      expected: { marriage_date: '1920', marriage_place: null, divorce_date: null, divorce_place: null },
      fields: { marriage_place: 'Leeds' },
      focusId: 'I2'
    });
    expect(onSaved).toHaveBeenCalledWith(RESULT);
    expect(dialog()).toBeNull();
  });

  it('sends a cleared field as empty, and leaves focusId out when not given', async () => {
    open();
    type(field('marriage_date'), '');
    await save();
    expect(api.runChange.mock.calls[0][1]).toEqual({
      id: 'F1',
      expected: { marriage_date: '1920', marriage_place: null, divorce_date: null, divorce_place: null },
      fields: { marriage_date: '' }
    });
  });

  it('says "Nothing changed" without calling the API, or when the server found none', async () => {
    open();
    await save();
    expect(api.runChange).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith('Nothing changed');
    expect(dialog()).toBeNull();

    api.runChange.mockRejectedValue(apiError(400, 'no_change'));
    open();
    type(field('divorce_date'), '1930');
    await save();
    expect(showToast).toHaveBeenCalledTimes(2);
    expect(dialog()).toBeNull();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('shows a validation error next to its field', async () => {
    api.runChange.mockRejectedValue(apiError(400, 'invalid', { field: 'divorce_place', message: 'Divorce place must be at most 500 characters.' }));
    open();
    type(field('divorce_place'), 'x'.repeat(501));
    await save();
    const error = $('[data-error-for="divorce_place"]');
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe('Divorce place must be at most 500 characters.');
    expect(field('divorce_place').getAttribute('aria-invalid')).toBe('true');
    expect(message()).toBeNull();
    expect(dialog()).not.toBeNull();
  });

  it('shows other errors at the foot of the form', async () => {
    api.runChange.mockRejectedValue(apiError(404, 'not_found'));
    open();
    type(field('divorce_date'), '1930');
    await save();
    expect(message()).toBe('This marriage no longer exists: someone else removed it.');
    expect($('.family-editor-save').disabled).toBe(false);
  });

  it('on a stale save, reloads the person and reopens with the fresh marriage', async () => {
    api.runChange.mockRejectedValueOnce(apiError(409, 'stale'));
    const editor = open({ loader, focusId: 'I1', onReloaded });
    type(field('marriage_place'), 'Leeds');
    await save();
    expect(message()).toBe('Someone else changed this marriage. Reload to see their changes.');
    const fresh = {
      person: { id: 'I1', marriages: [{ spouseId: 'I2', familyId: 'F1', marriageDate: '1921', marriagePlace: 'York' }] },
      masked: false
    };
    loader.reload.mockResolvedValue(fresh);
    $('.editor-reload').click();
    await flush();
    expect(loader.reload).toHaveBeenCalledWith('I1');
    expect(onReloaded).toHaveBeenCalledWith(fresh);
    expect(document.querySelectorAll('.family-editor')).toHaveLength(1);
    expect($('.editor-dialog-title').textContent).toBe('Edit the marriage of Tom Smith and Ann Jones');
    expect(field('marriage_date').value).toBe('1921');
    expect(field('marriage_place').value).toBe('York');
    expect(editor.isOpen()).toBe(true); // the first handle now stands for the reopened editor
    expect(editor.element).toBe(dialog());

    type(field('divorce_date'), '1930');
    await save();
    expect(api.runChange.mock.calls.at(-1)[1].expected).toEqual({
      marriage_date: '1921', marriage_place: 'York', divorce_date: null, divorce_place: null
    });
  });

  it('says so when the reloaded person no longer has the marriage', async () => {
    api.runChange.mockRejectedValueOnce(apiError(409, 'stale'));
    open({ loader, focusId: 'I1' });
    type(field('marriage_place'), 'Leeds');
    await save();
    loader.reload.mockResolvedValue({ person: { id: 'I1', marriages: [] }, masked: false });
    $('.editor-reload').focus();
    $('.editor-reload').click();
    expect($('.family-editor-save').disabled).toBe(true);
    document.activeElement.blur(); // what browsers do when the focused button is disabled
    await flush();
    expect(message()).toBe('This marriage no longer exists: someone else removed it.');
    // Usable again: not busy, controls enabled, focus back inside.
    expect($('.editor-reload').hidden).toBe(true);
    expect($('form').getAttribute('aria-busy')).toBe('false');
    for (const control of dialog().querySelectorAll('input, button')) expect(control.disabled).toBe(false);
    expect(dialog().contains(document.activeElement)).toBe(true);
    $('.family-editor-cancel').click();
    expect(dialog()).toBeNull();
  });

  it('offers Reload again when the reload itself failed', async () => {
    api.runChange.mockRejectedValueOnce(apiError(409, 'stale'));
    open({ loader, focusId: 'I1' });
    type(field('marriage_place'), 'Leeds');
    await save();
    loader.reload.mockRejectedValue(new Error('offline'));
    $('.editor-reload').click();
    await flush();
    expect(message()).toBe("Couldn't reload. Check your connection and try again.");
    expect($('.editor-reload').hidden).toBe(false);
    expect($('.editor-reload').disabled).toBe(false);
  });

  it('without a loader, says to reopen instead of offering Reload', async () => {
    api.runChange.mockRejectedValue(apiError(409, 'stale'));
    open();
    type(field('marriage_place'), 'Leeds');
    await save();
    expect(message()).toBe('Someone else changed this marriage. Close this and open it again to see their changes.');
    expect($('.editor-reload').hidden).toBe(true);
  });

  it('closes on Escape and Cancel', () => {
    const editor = open();
    field('marriage_date').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(editor.isOpen()).toBe(false);
    open();
    $('.family-editor-cancel').click();
    expect(dialog()).toBeNull();
    expect(api.runChange).not.toHaveBeenCalled();
  });
});
