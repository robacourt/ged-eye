import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openPhotoEditDialog } from '../src/photoEditDialog.js';
import { showToast } from '../src/toast.js';

vi.mock('../src/toast.js', () => ({ showToast: vi.fn() }));

const XSS = '<img src=x onerror="window.__xss = 1">';
const ROSE = { id: 'I7', name: 'Rose Smith' };
const TOM = { id: 'I1', name: 'Tom Smith' };
const ANN = { id: 'I2', name: 'Ann Jones', birthYear: 1850, deathYear: 1910 };
const PERSON = { id: 'I7', name: 'Rose Smith', photos: [] };
const PHOTO = {
  id: 42,
  key: 'originals/abc.jpg',
  thumbKey: 'thumbs/abc.webp',
  displayKey: 'display/abc.webp',
  fileName: 'wedding.jpg',
  contentType: 'image/jpeg',
  caption: 'The wedding',
  date: '1920',
  width: 400,
  height: 300,
  people: [ROSE, TOM]
};
const RESULT = { change: { id: 31, summary: 'Edited a photo of Rose Smith', personIds: ['I7', 'I1'] }, view: { person: { id: 'I7' } } };
const apiError = (status, code, body = {}) =>
  Object.assign(new Error(body.message ?? code), { name: 'ApiError', status, code, field: body.field ?? null, body });

let api;
let onSaved;

const open = (options = {}) => openPhotoEditDialog({ photo: PHOTO, person: PERSON, api, onSaved, ...options });
const dialog = () => document.querySelector('.photo-edit-dialog');
const $ = (selector) => dialog().querySelector(selector);
const $$ = (selector) => [...dialog().querySelectorAll(selector)];
const field = (name) => $(`[name="${name}"]`);
const chips = () => $$('.person-picker-chip').map(chip => chip.querySelector('.person-picker-chip-name').textContent);
const type = (input, value) => {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
};
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const save = async () => {
  $('.photo-edit-save').click();
  await flush();
};
const message = () => ($('.editor-form-message').hidden ? null : $('.editor-form-message .editor-error').textContent);
const peopleError = () => $('[data-error-for="personIds"]');
const pressEscape = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

async function searchAndAdd(text, id) {
  vi.useFakeTimers();
  try {
    const input = $('.person-picker input[type="search"]');
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(250);
    $(`.person-picker-result[data-id="${id}"] .person-picker-add`).click();
  } finally {
    vi.useRealTimers();
  }
}

beforeEach(() => {
  document.body.innerHTML = '';
  vi.stubEnv('VITE_MEDIA_BASE_URL', 'https://media.test/bucket');
  api = { runChange: vi.fn().mockResolvedValue(RESULT), search: vi.fn().mockResolvedValue([ANN]) };
  onSaved = vi.fn();
  showToast.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  delete window.__xss;
});

describe('openPhotoEditDialog', () => {
  it('opens with the caption, date and the people the photo is shown for, none of them fixed', () => {
    const editor = open();
    expect(editor.isOpen()).toBe(true);
    expect($('.editor-dialog-title').textContent).toBe('Edit photo');
    expect(field('caption').value).toBe('The wedding');
    expect(field('date').value).toBe('1920');
    expect(field('caption').maxLength).toBe(500);
    expect(field('date').maxLength).toBe(100);
    expect(chips()).toEqual(['Rose Smith', 'Tom Smith']);
    expect($('.person-picker-remove[aria-label="Remove Rose Smith"]')).not.toBeNull();
    expect($('.person-picker-remove[aria-label="Remove Tom Smith"]')).not.toBeNull();
    expect($('.photo-edit-people legend').textContent).toBe('Shown for');
    expect(dialog().textContent).toContain('e.g. 12 MAR 1890, ABT 1850, BEF 1900');
    expect(document.activeElement).toBe(field('caption'));
  });

  it('shows the photo it edits, by its thumbnail and file name', () => {
    open();
    expect($('.photo-edit-preview img').getAttribute('src')).toBe('https://media.test/bucket/thumbs/abc.webp');
    expect($('.photo-edit-file-name').textContent).toBe('wedding.jpg');
  });

  it('shows a document icon for a photo with no thumbnail', () => {
    open({ photo: { ...PHOTO, thumbKey: null, displayKey: null, fileName: 'letter.pdf' } });
    expect($('.photo-edit-preview img')).toBeNull();
    expect($('.photo-edit-preview').textContent).toContain('📄');
  });

  it('sets every data value as text', () => {
    const name = XSS;
    open({
      photo: { ...PHOTO, caption: XSS, date: XSS, fileName: XSS, people: [{ id: 'I7', name }, { id: 'I9', name: '' }] },
      person: { ...PERSON, name }
    });
    expect(field('caption').value).toBe(XSS);
    expect(field('date').value).toBe(XSS);
    expect($('.photo-edit-file-name').textContent).toBe(XSS);
    expect(chips()).toEqual([XSS, 'Unnamed person']);
    expect(dialog().querySelector('img[src="x"]')).toBeNull();
    expect(window.__xss).toBeUndefined();
  });

  it('sends update_photo with the edited fields and the values it opened with, then calls onSaved', async () => {
    open();
    type(field('caption'), '  The wedding of Rose and Tom ');
    type(field('date'), '');
    await save();
    expect(api.runChange).toHaveBeenCalledWith('update_photo', {
      mediaId: 42,
      caption: 'The wedding of Rose and Tom',
      date: null,
      personIds: ['I7', 'I1'],
      expected: { caption: 'The wedding', date: '1920', personIds: ['I7', 'I1'] },
      focusId: 'I7'
    });
    expect(onSaved).toHaveBeenCalledWith(RESULT);
    expect(dialog()).toBeNull();
  });

  it('sends the people as chosen: added and removed', async () => {
    open();
    $('.person-picker-remove[aria-label="Remove Tom Smith"]').click();
    await searchAndAdd('Ann', 'I2');
    expect(chips()).toEqual(['Rose Smith', 'Ann Jones']);
    await save();
    const params = api.runChange.mock.calls[0][1];
    expect(params.personIds).toEqual(['I7', 'I2']);
    expect(params.expected.personIds).toEqual(['I7', 'I1']);
    expect(params.caption).toBe('The wedding');
    expect(params.date).toBe('1920');
  });

  it('can stop showing the photo for the person it was opened from', async () => {
    open();
    $('.person-picker-remove[aria-label="Remove Rose Smith"]').click();
    await save();
    expect(api.runChange.mock.calls[0][1]).toMatchObject({ personIds: ['I1'], focusId: 'I7' });
  });

  it('refuses inline to save with nobody chosen, until someone is added', async () => {
    open();
    $('.person-picker-remove[aria-label="Remove Rose Smith"]').click();
    $('.person-picker-remove[aria-label="Remove Tom Smith"]').click();
    await save();
    expect(api.runChange).not.toHaveBeenCalled();
    expect(peopleError().hidden).toBe(false);
    expect(peopleError().textContent).toBe('A photo must be shown for at least one person.');
    expect(document.activeElement).toBe($('.person-picker input[type="search"]'));
    expect(dialog()).not.toBeNull();

    await searchAndAdd('Ann', 'I2');
    expect(peopleError().hidden).toBe(true);
    await save();
    expect(api.runChange.mock.calls[0][1].personIds).toEqual(['I2']);
  });

  it('closes quietly when the server finds nothing changed', async () => {
    api.runChange.mockRejectedValue(apiError(400, 'no_change'));
    open();
    await save();
    expect(api.runChange).toHaveBeenCalledTimes(1);
    expect(dialog()).toBeNull();
    expect(onSaved).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('on a stale save offers Reload, which closes and asks the caller to reload', async () => {
    api.runChange.mockRejectedValue(apiError(409, 'stale', { message: 'Someone else changed this photo since you opened it.' }));
    open();
    type(field('caption'), 'New');
    await save();
    expect(message()).toBe('Someone else changed this photo. Reload to see their changes.');
    const reload = $('.editor-reload');
    expect(reload.hidden).toBe(false);
    expect(reload.textContent).toBe('Reload');
    expect(onSaved).not.toHaveBeenCalled();
    reload.click();
    expect(dialog()).toBeNull();
    expect(onSaved).toHaveBeenCalledWith(null);
  });

  it('shows a validation error next to its field', async () => {
    api.runChange.mockRejectedValue(apiError(400, 'invalid', { field: 'caption', message: 'Caption must be a single line.' }));
    open();
    type(field('caption'), 'x');
    await save();
    const error = $('[data-error-for="caption"]');
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe('Caption must be a single line.');
    expect(field('caption').getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(field('caption'));
    expect(message()).toBeNull();

    // A second try clears it.
    api.runChange.mockResolvedValue(RESULT);
    await save();
    expect(dialog()).toBeNull();
  });

  it('names someone chosen who no longer exists', async () => {
    api.runChange.mockRejectedValue(apiError(404, 'not_found', { field: 'personIds', id: 'I1' }));
    open();
    await save();
    expect(peopleError().hidden).toBe(false);
    expect(peopleError().textContent).toBe('Tom Smith no longer exists: someone else deleted them. Remove them, then save.');
  });

  it('offers Reload when the photo itself has gone', async () => {
    api.runChange.mockRejectedValue(apiError(404, 'not_found', { field: 'mediaId', id: 42 }));
    open();
    await save();
    expect(message()).toBe('This photo no longer exists: someone else removed it.');
    expect($('.editor-reload').hidden).toBe(false);
  });

  it('shows other errors at the foot of the form and stays open', async () => {
    api.runChange.mockRejectedValue(apiError(401, 'unauthenticated'));
    open();
    await save();
    expect(message()).toBe("You're signed out. Sign in again, then try again. Your changes are still here.");
    expect($('.editor-reload').hidden).toBe(true);
    expect($('.photo-edit-save').disabled).toBe(false);
    expect(dialog()).not.toBeNull();
  });

  it('is busy while saving: Save says so, and Escape and Cancel wait', async () => {
    let finish;
    api.runChange.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    open();
    $('.photo-edit-save').click();
    expect($('.photo-edit-save').textContent).toBe('Saving…');
    expect(field('caption').disabled).toBe(true);
    pressEscape();
    $('.photo-edit-cancel').click();
    expect(dialog()).not.toBeNull();
    finish(RESULT);
    await flush();
    expect(dialog()).toBeNull();
    expect(onSaved).toHaveBeenCalledWith(RESULT);
  });

  it('Cancel and Escape close without saving', () => {
    open();
    $('.photo-edit-cancel').click();
    expect(dialog()).toBeNull();
    open();
    pressEscape();
    expect(dialog()).toBeNull();
    expect(api.runChange).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('copes with a photo from an older view, with no caption, date or people', async () => {
    const photo = { id: 42, key: 'originals/abc.jpg', thumbKey: 'thumbs/abc.webp', fileName: 'old.jpg', contentType: 'image/jpeg' };
    open({ photo });
    expect(field('caption').value).toBe('');
    expect(field('date').value).toBe('');
    // The person it was opened from is always tagged on their own photos.
    expect(chips()).toEqual(['Rose Smith']);
    type(field('caption'), 'Found it');
    await save();
    expect(api.runChange).toHaveBeenCalledWith('update_photo', {
      mediaId: 42,
      caption: 'Found it',
      date: null,
      personIds: ['I7'],
      expected: { caption: null, date: null, personIds: ['I7'] },
      focusId: 'I7'
    });
  });
});
