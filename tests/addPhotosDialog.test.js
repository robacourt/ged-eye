import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openAddPhotosDialog } from '../src/addPhotosDialog.js';
import { uploadErrorMessage } from '../src/uploadMessages.js';
import { createUploadQueue } from '../src/uploadQueue.js';
import { ApiError } from '../src/editApi.js';
import { showToast } from '../src/toast.js';

vi.mock('../src/toast.js', () => ({ showToast: vi.fn() }));

const XSS = '<img src=x onerror="window.__xss = 1">';
const PERSON = { id: 'I7', name: 'Rose Smith', photos: [] };
const TOM = { id: 'I1', name: 'Tom Smith', birthYear: 1888, deathYear: 1950 };
const RESULT = { change: { id: 31, summary: 'Added 2 photos for Rose Smith', personIds: ['I7'] }, view: { person: { id: 'I7' } } };
const TYPES = { jpg: 'image/jpeg', png: 'image/png', pdf: 'application/pdf', tif: 'image/tiff', heic: 'image/heic' };

const extOf = (name) => name.split('.').pop();
const file = (name, bytes = `bytes of ${name}`) => new File([bytes], name, { type: TYPES[extOf(name)] ?? '' });

/** processUpload's result for `fileName`: a document for a PDF, else an image with a thumbnail. */
function mediaFor(fileName, sha256 = `sha-${fileName}`) {
  const ext = extOf(fileName);
  const image = ext !== 'pdf';
  return {
    mediaId: null,
    sha256,
    ext,
    objectKey: `originals/${sha256}.${ext}`,
    displayKey: image ? `display/${sha256}.webp` : null,
    thumbKey: image ? `thumbs/${sha256}.webp` : null,
    contentType: TYPES[ext],
    byteSize: 10,
    width: image ? 400 : null,
    height: image ? 300 : null,
    fileName,
    caption: null,
    date: null
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Fake mediaApi functions that succeed at once. Tests override them per case. */
function fakeMediaApi() {
  let slots = 0;
  return {
    requestUpload: vi.fn(async ({ contentType }) => {
      slots += 1;
      return { uploadId: `up-${slots}`, url: `https://storage.test/incoming/up-${slots}`, headers: { 'Content-Type': contentType } };
    }),
    uploadFile: vi.fn(async (slot, uploaded, { onProgress }) => onProgress(1)),
    processUpload: vi.fn(async (uploadId, fileName) => mediaFor(fileName)),
    discardUpload: vi.fn(async () => {})
  };
}

/** Makes `fn` return a promise the test settles, per call. → the calls, each `{ args, resolve, reject }`. */
function hold(fn) {
  const calls = [];
  fn.mockImplementation((...args) => {
    const { promise, resolve, reject } = deferred();
    calls.push({ args, resolve, reject });
    return promise;
  });
  return calls;
}

/** hold() for uploadFile, whose uploads also reject with ApiError(0, 'aborted') when their signal aborts. */
function holdUploads(api) {
  const calls = [];
  api.uploadFile.mockImplementation((slot, uploaded, options) => {
    const { promise, resolve, reject } = deferred();
    options.signal?.addEventListener('abort', () => reject(new ApiError(0, 'aborted')), { once: true });
    calls.push({ slot, file: uploaded, options, resolve, reject });
    return promise;
  });
  return calls;
}

let api;
let mediaApi;
let onSaved;
let clicks;
let queue;
let sheets;

/** Lets every pending promise callback run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => {
  for (let i = 0; i < 5; i++) await flush();
};

function open(options = {}) {
  const sheet = openAddPhotosDialog({
    person: PERSON,
    api,
    mediaApi,
    onSaved,
    createQueue: (queueOptions) => {
      queue = createUploadQueue(queueOptions);
      vi.spyOn(queue, 'cancel');
      return queue;
    },
    ...options
  });
  sheets.push(sheet);
  return sheet;
}

const dialog = () => document.querySelector('.add-photos-dialog');
const $ = (selector) => dialog().querySelector(selector);
const fileInput = () => document.querySelector('.add-photos-input');
const pdfInput = () => document.querySelector('.add-photos-pdf-input');
const cards = () => [...document.querySelectorAll('.add-photos-card')];
const card = (n) => cards()[n];
const status = (n) => card(n).querySelector('.add-photos-status').textContent;
const caption = (n) => card(n).querySelector('input[name="caption"]');
const date = (n) => card(n).querySelector('input[name="date"]');
const retryButton = (n) => card(n).querySelector('.add-photos-retry');
const removeButton = (n) => card(n).querySelector('.add-photos-remove');
const preview = (n) => card(n).querySelector('.add-photos-preview img');
const saveButton = () => $('.add-photos-save');
const message = () => ($('.editor-form-message').hidden ? null : $('.editor-form-message .editor-error').textContent);
const type = (input, value) => {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
};
const escape = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
const save = async () => {
  saveButton().click();
  await settle();
};

/** Chooses `files` in the sheet's photo picker (or, with `input`, another of its pickers). */
function choose(files, input = fileInput()) {
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

beforeEach(() => {
  document.body.innerHTML = '';
  vi.stubEnv('VITE_MEDIA_BASE_URL', 'https://media.test/bucket');
  api = { runChange: vi.fn().mockResolvedValue(RESULT), search: vi.fn().mockResolvedValue([TOM]) };
  mediaApi = fakeMediaApi();
  onSaved = vi.fn();
  queue = null;
  sheets = [];
  showToast.mockClear();
  clicks = [];
  vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function click() {
    clicks.push({ input: this, connected: this.isConnected, inSheet: Boolean(this.closest('.editor-dialog-backdrop')) });
  });
  URL.createObjectURL = vi.fn((blob) => `blob:${blob.name}`);
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  for (const sheet of sheets) sheet.close(); // stops their uploads and beforeunload warnings
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  delete URL.createObjectURL;
  delete URL.revokeObjectURL;
});

describe('openAddPhotosDialog: opening', () => {
  it('opens a sheet for the person and, with no files, opens the file picker at once from inside the sheet', () => {
    const sheet = open();
    expect(sheet.isOpen()).toBe(true);
    expect($('.editor-dialog-title').textContent).toBe('Add photos for Rose Smith');
    // Clicked before openAddPhotosDialog returned (no await before it), on an input in the page, inside the sheet.
    expect(clicks).toEqual([{ input: fileInput(), connected: true, inSheet: true }]);
    expect(fileInput().type).toBe('file');
    // Images only: anything else in `accept` makes Android show its file browser instead of the photo picker
    // (with Google Photos). PDFs have their own picker, behind "Add a PDF".
    expect(fileInput().accept).toBe('image/*');
    expect(fileInput().multiple).toBe(true);
    expect(fileInput().hasAttribute('capture')).toBe(false);
    expect(cards()).toHaveLength(0);
    expect($('.add-photos-more').textContent).toBe('Choose photos');
  });

  it('has a separate PDF picker, behind Add a PDF, that adds cards like the photo picker', () => {
    open();
    expect(pdfInput().type).toBe('file');
    expect(pdfInput().accept).toBe('application/pdf');
    expect(pdfInput().multiple).toBe(true);
    expect(pdfInput().closest('.editor-dialog-backdrop')).not.toBeNull();
    clicks = [];
    $('.add-photos-pdf').click();
    expect($('.add-photos-pdf').textContent).toBe('Add a PDF');
    expect(clicks).toEqual([{ input: pdfInput(), connected: true, inSheet: true }]);
    choose([file('certificate.pdf')], pdfInput());
    expect(cards()).toHaveLength(1);
    expect(card(0).querySelector('.add-photos-file-name').textContent).toBe('certificate.pdf');
    expect(mediaApi.requestUpload).toHaveBeenCalledWith({ fileName: 'certificate.pdf', contentType: 'application/pdf', byteSize: expect.any(Number) });
  });

  it('closes when the first photo picker is dismissed with nothing chosen, but not when the PDF picker is', () => {
    const sheet = open();
    $('.add-photos-pdf').click();
    pdfInput().dispatchEvent(new Event('cancel'));
    expect(sheet.isOpen()).toBe(true);
    fileInput().dispatchEvent(new Event('cancel'));
    expect(sheet.isOpen()).toBe(false);
  });

  it('opens at the PDF picker instead with pick: pdf, and closes when that picker is dismissed with nothing chosen', () => {
    const sheet = open({ pick: 'pdf' });
    expect(clicks).toEqual([{ input: pdfInput(), connected: true, inSheet: true }]);
    fileInput().dispatchEvent(new Event('cancel'));
    expect(sheet.isOpen()).toBe(true);
    pdfInput().dispatchEvent(new Event('cancel'));
    expect(sheet.isOpen()).toBe(false);
  });

  it('starts uploading dropped files at once, without opening the picker', () => {
    const files = [file('a.jpg'), file('b.pdf')];
    open({ files });
    expect(clicks).toEqual([]);
    expect(cards()).toHaveLength(2);
    expect(mediaApi.requestUpload).toHaveBeenCalledWith({ fileName: 'a.jpg', contentType: 'image/jpeg', byteSize: files[0].size });
    expect(mediaApi.requestUpload).toHaveBeenCalledWith({ fileName: 'b.pdf', contentType: 'application/pdf', byteSize: files[1].size });
    expect($('.add-photos-more').textContent).toBe('Add more');
  });

  it('adds a card for each file chosen, and Add more opens the picker again', async () => {
    open();
    choose([file('a.jpg'), file('b.jpg')]);
    expect(cards().map((element) => element.querySelector('.add-photos-file-name').textContent)).toEqual(['a.jpg', 'b.jpg']);
    expect(cards().map((element) => element.querySelector('.add-photos-card-title').textContent)).toEqual(['Photo 1', 'Photo 2']);
    expect(fileInput().value).toBe(''); // so choosing the same file again is still a change

    $('.add-photos-more').click();
    expect(clicks).toHaveLength(2);
    choose([file('c.jpg')]);
    expect(cards()).toHaveLength(3);
  });

  it('closes the sheet when the first picker is dismissed with nothing chosen', () => {
    const sheet = open();
    fileInput().dispatchEvent(new Event('cancel'));
    expect(sheet.isOpen()).toBe(false);
    expect(dialog()).toBeNull();
  });

  it('stays open when the picker is dismissed once there are photos', () => {
    const sheet = open({ files: [file('a.jpg')] });
    $('.add-photos-more').click();
    fileInput().dispatchEvent(new Event('cancel'));
    expect(sheet.isOpen()).toBe(true);
  });

  it('keeps the first 20 photos of a larger batch, saying so', () => {
    open();
    choose(Array.from({ length: 22 }, (_, i) => file(`${i + 1}.jpg`)));
    expect(cards()).toHaveLength(20);
    expect(card(19).querySelector('.add-photos-file-name').textContent).toBe('20.jpg');
    expect(message()).toBe('Up to 20 photos can be added at once, so only the first 20 were kept. ' +
      'Remove failed or duplicate photos to make room.');

    choose([file('21.jpg')]);
    expect(cards()).toHaveLength(20);
    expect(message()).toBe('Up to 20 photos can be added at once. Save these first, or remove failed or duplicate photos to make room.');
  });

  it('counts the photos already in the sheet towards the 20', () => {
    open({ files: Array.from({ length: 18 }, (_, i) => file(`${i + 1}.jpg`)) });
    choose([file('a.jpg'), file('b.jpg'), file('c.jpg')]);
    expect(cards()).toHaveLength(20);
    expect(message()).toBe('Up to 20 photos can be added at once, so only the first 2 were kept. ' +
      'Remove failed or duplicate photos to make room.');
  });

  it('shows file names as text', () => {
    open({ files: [file(`${XSS}.jpg`)] });
    expect(card(0).querySelector('.add-photos-file-name').textContent).toBe(`${XSS}.jpg`);
    expect(document.querySelector('img[src="x"]')).toBeNull();
    expect(window.__xss).toBeUndefined();
  });
});

describe('openAddPhotosDialog: cards', () => {
  it('shows upload progress, then processing, then ready', async () => {
    const uploads = holdUploads(mediaApi);
    const processing = hold(mediaApi.processUpload);
    open({ files: [file('a.jpg')] });
    expect(status(0)).toBe('Uploading 0%');
    await flush();

    uploads[0].options.onProgress(0.62);
    expect(status(0)).toBe('Uploading 62%');
    const bar = card(0).querySelector('progress.add-photos-progress');
    expect(bar.hidden).toBe(false);
    expect(Number(bar.value)).toBeCloseTo(0.62);

    uploads[0].resolve();
    await flush();
    expect(status(0)).toBe('Processing…');
    expect(bar.hidden).toBe(true);

    processing[0].resolve(mediaFor('a.jpg'));
    await flush();
    expect(status(0)).toBe('Ready');
    expect(retryButton(0).hidden).toBe(true);
    expect(removeButton(0).hidden).toBe(false);
  });

  it('shows files waiting their turn', () => {
    holdUploads(mediaApi);
    open({ files: [file('a.jpg'), file('b.jpg'), file('c.jpg')] });
    expect(status(2)).toBe('Waiting to upload…');
  });

  it('previews images the browser can show, a document icon otherwise, then the thumbnail once ready', async () => {
    const processing = hold(mediaApi.processUpload);
    open({ files: [file('a.jpg'), file('b.pdf'), file('c.tif')] });
    expect(preview(0).getAttribute('src')).toBe('blob:a.jpg');
    expect(preview(0).alt).toBe('');
    expect(preview(1)).toBeNull();
    expect(card(1).querySelector('.add-photos-doc')).not.toBeNull();
    expect(preview(2)).toBeNull(); // most browsers can't show a TIFF
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);

    await settle();
    processing[0].resolve(mediaFor('a.jpg'));
    processing[1].resolve(mediaFor('b.pdf'));
    await settle();
    processing[2].resolve(mediaFor('c.tif'));
    await settle();

    expect(preview(0).getAttribute('src')).toBe('https://media.test/bucket/thumbs/sha-a.jpg.webp');
    expect(URL.revokeObjectURL).not.toHaveBeenCalled(); // not until the thumbnail has loaded
    preview(0).dispatchEvent(new Event('load'));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:a.jpg');
    expect(preview(1)).toBeNull();
    expect(preview(2).getAttribute('src')).toBe('https://media.test/bucket/thumbs/sha-c.tif.webp');
  });

  it("goes back to the file's own preview when the thumbnail won't load, else to a document icon", async () => {
    open({ files: [file('a.jpg'), file('c.tif')] });
    await settle();
    preview(0).dispatchEvent(new Event('error'));
    expect(preview(0).getAttribute('src')).toBe('blob:a.jpg');
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    preview(1).dispatchEvent(new Event('error'));
    expect(preview(1)).toBeNull();
    expect(card(1).querySelector('.add-photos-doc')).not.toBeNull();
  });

  it('has Caption, Date and Shown for, with the person fixed', async () => {
    open({ files: [file('a.jpg')] });
    expect(caption(0).value).toBe('');
    expect(date(0).placeholder).toBe('e.g. 12 MAR 1890');
    const people = card(0).querySelector('.add-photos-people');
    expect(people.querySelector('legend').textContent).toBe('Shown for');
    expect([...people.querySelectorAll('.person-picker-chip-name')].map((chip) => chip.textContent)).toEqual(['Rose Smith']);
    expect(people.querySelector('.person-picker-remove')).toBeNull();
  });

  it('shows a file already in the tree as such, with its caption read-only', async () => {
    mediaApi.processUpload.mockResolvedValue({ ...mediaFor('a.jpg'), mediaId: 9, caption: 'At the church', date: null });
    open({ files: [file('a.jpg')] });
    await settle();
    expect(status(0)).toBe('Already in the tree');
    expect(caption(0).value).toBe('At the church');
    expect(caption(0).readOnly).toBe(true);
    expect(date(0).readOnly).toBe(false);
    const hint = card(0).querySelector('[data-hint-for="caption"]');
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toBe('This photo is already in the tree; edit its caption from the photo.');
    expect(caption(0).getAttribute('aria-describedby').split(' ')).toContain(hint.id);
    expect(card(0).querySelector('[data-hint-for="date"]').hidden).toBe(true);
  });

  it("replaces a caption typed before the file turned out to be in the tree, saying why", async () => {
    const processing = hold(mediaApi.processUpload);
    open({ files: [file('a.jpg')] });
    await settle();
    type(caption(0), 'My own words');
    processing[0].resolve({ ...mediaFor('a.jpg'), mediaId: 9, caption: 'At the church', date: null });
    await settle();
    expect(caption(0).value).toBe('At the church');
    expect(card(0).querySelector('[data-hint-for="caption"]').hidden).toBe(false);
  });

  it("shows the shared caption read-only on a copy of a file in the tree once it takes over from photo 1", async () => {
    mediaApi.processUpload.mockImplementation(async (uploadId, fileName) =>
      ({ ...mediaFor(fileName, 'same-sha'), mediaId: 9, caption: 'At the church', date: null }));
    open({ files: [file('a.jpg'), file('copy of a.jpg')] });
    await settle();
    expect(status(1)).toBe('Same as photo 1');
    removeButton(0).click();
    expect(status(0)).toBe('Already in the tree');
    expect(card(0).querySelector('.add-photos-fields').hidden).toBe(false);
    expect(caption(0).value).toBe('At the church');
    expect(caption(0).readOnly).toBe(true);
    expect(card(0).querySelector('[data-hint-for="caption"]').hidden).toBe(false);
    await save();
    expect(api.runChange).toHaveBeenCalledWith('add_photos', {
      personId: 'I7',
      photos: [{ mediaId: 9, caption: null, date: null, personIds: ['I7'] }]
    });
  });

  it('announces cards that settle together, all of them', async () => {
    const processing = hold(mediaApi.processUpload);
    open({ files: [file('a.jpg'), file('b.heic')] });
    await settle();
    processing[0].resolve(mediaFor('a.jpg'));
    processing[1].reject(new ApiError(400, 'heic_unsupported'));
    await settle();
    expect($('.add-photos-announcer').textContent)
      .toBe("Photo 1: Ready. Photo 2: This HEIC file couldn't be read. Export it as JPEG and try again.");
  });

  it('marks a later copy of the same file "Same as photo 1", without its own fields', async () => {
    mediaApi.processUpload.mockImplementation(async (uploadId, fileName) => mediaFor(fileName, 'same-sha'));
    open({ files: [file('a.jpg'), file('copy of a.jpg')] });
    await settle();
    expect(status(0)).toBe('Ready');
    expect(status(1)).toBe('Same as photo 1');
    expect(card(1).querySelector('.add-photos-fields').hidden).toBe(true);
    expect(saveButton().textContent).toBe('Save 1 photo');
  });

  it('moves focus to the card when its fields go while being typed in', async () => {
    const processing = hold(mediaApi.processUpload);
    open({ files: [file('a.jpg'), file('copy of a.jpg')] });
    await settle();
    processing[0].resolve(mediaFor('a.jpg', 'same-sha'));
    await settle();
    caption(1).focus();
    processing[1].resolve(mediaFor('copy of a.jpg', 'same-sha'));
    await settle();
    expect(status(1)).toBe('Same as photo 1');
    expect(document.activeElement).toBe(card(1));
  });

  it('shows why a file was refused, with Remove but no Retry', async () => {
    mediaApi.processUpload.mockRejectedValue(new ApiError(400, 'heic_unsupported'));
    open({ files: [file('a.heic')] });
    await settle();
    expect(status(0)).toBe("This HEIC file couldn't be read. Export it as JPEG and try again.");
    expect(retryButton(0).hidden).toBe(true);
    expect(removeButton(0).hidden).toBe(false);
    expect(card(0).querySelector('.add-photos-fields').hidden).toBe(true);
    expect(saveButton().textContent).toBe('Save photos'); // it can't be saved
  });

  it('offers Retry after a network failure, which resumes the upload', async () => {
    mediaApi.processUpload.mockRejectedValueOnce(new ApiError(0, 'network', { message: "Couldn't reach the server." }));
    open({ files: [file('a.jpg')] });
    await settle();
    expect(status(0)).toBe('Upload failed. Check your connection, then retry.');
    expect(retryButton(0).hidden).toBe(false);
    expect(retryButton(0).getAttribute('aria-label')).toBe('Retry photo 1');

    retryButton(0).click();
    expect(document.activeElement).toBe(card(0));
    await settle();
    expect(status(0)).toBe('Ready');
    expect(mediaApi.processUpload).toHaveBeenCalledTimes(2);
    expect(mediaApi.requestUpload).toHaveBeenCalledTimes(1);
  });

  it('removes a card, deleting its upload if it was uploaded but not processed, and renumbers the rest', async () => {
    const processing = hold(mediaApi.processUpload);
    open({ files: [file('a.jpg'), file('b.jpg')] });
    await settle();
    removeButton(0).click();
    expect(cards()).toHaveLength(1);
    expect(card(0).querySelector('.add-photos-card-title').textContent).toBe('Photo 1');
    expect(card(0).querySelector('.add-photos-file-name').textContent).toBe('b.jpg');
    expect(mediaApi.discardUpload).toHaveBeenCalledWith('up-1');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:a.jpg');
    expect(document.activeElement).toBe(card(0));
    processing[1].resolve(mediaFor('b.jpg'));
  });
});

describe('uploadErrorMessage', () => {
  it.each([
    ['unsupported_type', 400, 'PDFs and images only, up to 50 MB.'],
    ['too_large', 413, 'PDFs and images only, up to 50 MB.'],
    ['heic_unsupported', 400, "This HEIC file couldn't be read. Export it as JPEG and try again."],
    ['unreadable', 400, "This file couldn't be read."],
    ['empty', 400, 'This file is empty.'],
    ['too_many_pixels', 400, 'This image is too large to process. Make it smaller than 100 megapixels and try again.'],
    ['invalid', 400, "This file can't be uploaded."],
    ['missing_upload', 400, 'This upload has gone missing. Retry to upload it again.'],
    ['busy', 503, 'The server is busy. Retry in a moment.'],
    ['unauthenticated', 401, "You're signed out. Sign in again, then retry."],
    ['not_an_editor', 403, "You're not on the editors list. Use \"Request edit access\" in your account menu."],
    ['network', 0, 'Upload failed. Check your connection, then retry.'],
    ['upload_failed', 403, 'Upload failed.'],
    ['internal', 500, 'Upload failed.']
  ])('words %s (%i) for a card', (code, status, text) => {
    expect(uploadErrorMessage(new ApiError(status, code))).toBe(text);
  });

  it("gives the server's own words for an invalid file", () => {
    const error = new ApiError(400, 'invalid', { field: 'fileName', message: 'The file name must be 1 to 255 characters.' });
    expect(uploadErrorMessage(error)).toBe('The file name must be 1 to 255 characters.');
  });

  it('shows the message on the card of a file refused when asking for a slot', async () => {
    mediaApi.requestUpload.mockRejectedValue(new ApiError(413, 'too_large'));
    open({ files: [file('huge.jpg')] });
    await settle();
    expect(status(0)).toBe('PDFs and images only, up to 50 MB.');
    expect(retryButton(0).hidden).toBe(true);
  });
});

describe('openAddPhotosDialog: saving', () => {
  it('sends one add_photos with every photo, then calls onSaved and closes', async () => {
    const sheet = open({ files: [file('a.jpg'), file('b.pdf')] });
    await settle();
    type(caption(0), ' The wedding ');
    type(date(0), 'ABT 1923');
    expect(saveButton().textContent).toBe('Save 2 photos');
    await save();
    expect(api.runChange).toHaveBeenCalledTimes(1);
    expect(api.runChange).toHaveBeenCalledWith('add_photos', {
      personId: 'I7',
      photos: [
        { upload: { sha256: 'sha-a.jpg', ext: 'jpg', fileName: 'a.jpg' }, caption: 'The wedding', date: 'ABT 1923', personIds: ['I7'] },
        { upload: { sha256: 'sha-b.pdf', ext: 'pdf', fileName: 'b.pdf' }, caption: null, date: null, personIds: ['I7'] }
      ]
    });
    expect(onSaved).toHaveBeenCalledWith(RESULT);
    expect(sheet.isOpen()).toBe(false);
    expect(dialog()).toBeNull();
    expect(mediaApi.discardUpload).not.toHaveBeenCalled();
  });

  it('sends everyone chosen in "Shown for"', async () => {
    open({ files: [file('a.jpg')] });
    await settle();
    const search = card(0).querySelector('.person-picker input[type="search"]');
    search.value = 'Tom';
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await settle();
    card(0).querySelector('.person-picker-result[data-id="I1"] .person-picker-add').click();
    await save();
    expect(api.runChange.mock.calls[0][1].photos[0].personIds).toEqual(['I7', 'I1']);
  });

  it('sends a file already in the tree by its media id, leaving its caption alone', async () => {
    mediaApi.processUpload.mockResolvedValue({ ...mediaFor('a.jpg'), mediaId: 9, caption: 'At the church', date: null });
    open({ files: [file('a.jpg')] });
    await settle();
    type(date(0), '1923');
    await save();
    expect(api.runChange).toHaveBeenCalledWith('add_photos', {
      personId: 'I7',
      photos: [{ mediaId: 9, caption: null, date: '1923', personIds: ['I7'] }]
    });
  });

  it('leaves out later copies of the same file', async () => {
    mediaApi.processUpload.mockImplementation(async (uploadId, fileName) => mediaFor(fileName, fileName === 'b.jpg' ? 'sha-b' : 'same-sha'));
    open({ files: [file('a.jpg'), file('copy of a.jpg'), file('b.jpg')] });
    await settle();
    await save();
    expect(api.runChange.mock.calls[0][1].photos.map((photo) => photo.upload.fileName)).toEqual(['a.jpg', 'b.jpg']);
  });

  it('waits for uploads still under way, then saves', async () => {
    const processing = hold(mediaApi.processUpload);
    open({ files: [file('a.jpg')] });
    await settle();
    saveButton().click();
    await settle();
    expect(saveButton().textContent).toBe('Waiting for uploads…');
    expect(saveButton().disabled).toBe(false);
    expect(api.runChange).not.toHaveBeenCalled();
    type(caption(0), 'Typed while waiting');

    processing[0].resolve(mediaFor('a.jpg'));
    await settle();
    expect(api.runChange).toHaveBeenCalledTimes(1);
    expect(api.runChange.mock.calls[0][1].photos[0].caption).toBe('Typed while waiting');
    expect(onSaved).toHaveBeenCalledWith(RESULT);
  });

  it("doesn't save while waiting if an upload then fails", async () => {
    const processing = hold(mediaApi.processUpload);
    open({ files: [file('a.jpg')] });
    await settle();
    saveButton().click();
    await settle();
    processing[0].reject(new ApiError(0, 'network'));
    await settle();
    expect(api.runChange).not.toHaveBeenCalled();
    expect(saveButton().textContent).toBe('Save 1 photo');
    expect(message()).toBe('Retry or remove the photos that failed, then save.');
  });

  it('asks for failed photos to be retried or removed first', async () => {
    mediaApi.processUpload.mockImplementation(async (uploadId, fileName) => {
      if (fileName === 'b.heic') throw new ApiError(400, 'heic_unsupported');
      return mediaFor(fileName);
    });
    open({ files: [file('a.jpg'), file('b.heic')] });
    await settle();
    await save();
    expect(api.runChange).not.toHaveBeenCalled();
    expect(message()).toBe('Retry or remove the photos that failed, then save.');

    removeButton(1).click();
    await save();
    expect(api.runChange).toHaveBeenCalledTimes(1);
    expect(api.runChange.mock.calls[0][1].photos).toHaveLength(1);
  });

  it('asks for photos when there are none', async () => {
    open();
    await save();
    expect(api.runChange).not.toHaveBeenCalled();
    expect(saveButton().textContent).toBe('Save photos');
    expect(message()).toBe('Choose some photos first.');
  });

  it('closes with a toast, without onSaved, when every photo is already shown for everyone chosen', async () => {
    api.runChange.mockRejectedValue(new ApiError(400, 'no_change'));
    const sheet = open({ files: [file('a.jpg')] });
    await settle();
    await save();
    expect(showToast).toHaveBeenCalledWith('Already shown for everyone selected');
    expect(onSaved).not.toHaveBeenCalled();
    expect(sheet.isOpen()).toBe(false);
  });

  it('fails the card of a missing upload, retryably, leaving the others ready', async () => {
    api.runChange.mockRejectedValueOnce(new ApiError(400, 'missing_upload', { index: 1, field: 'photos' }));
    mediaApi.processUpload.mockImplementation(async (uploadId, fileName) => mediaFor(fileName, fileName === 'c.jpg' ? 'sha-c' : 'same-sha'));
    // Photo 2 is a copy of photo 1, so it isn't sent: index 1 is the third card.
    open({ files: [file('a.jpg'), file('b.jpg'), file('c.jpg')] });
    await settle();
    await save();
    expect(status(0)).toBe('Ready');
    expect(status(2)).toBe('This upload has gone missing. Retry to upload it again.');
    expect(retryButton(2).hidden).toBe(false);
    expect(message()).toBe('Photo 3 has to be uploaded again. Retry it, then save.');
    expect(dialog()).not.toBeNull();

    retryButton(2).click();
    await settle();
    expect(mediaApi.processUpload).toHaveBeenLastCalledWith('up-3', 'c.jpg');
    expect(status(2)).toBe('Ready');
    await save();
    expect(api.runChange).toHaveBeenCalledTimes(2);
    expect(onSaved).toHaveBeenCalledWith(RESULT);
  });

  it("shows a caption the server refused on that photo's card", async () => {
    api.runChange.mockRejectedValue(new ApiError(400, 'invalid', { field: 'photos.0.caption', message: 'Caption must be a single line.' }));
    open({ files: [file('a.jpg')] });
    await settle();
    await save();
    const error = card(0).querySelector('[data-error-for="caption"]');
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe('Caption must be a single line.');
    expect(caption(0).getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(caption(0));
    expect(message()).toBeNull();
  });

  it('shows other failures inline, keeping the sheet open', async () => {
    api.runChange.mockRejectedValue(new ApiError(401, 'unauthenticated'));
    open({ files: [file('a.jpg')] });
    await settle();
    await save();
    expect(message()).toBe("You're signed out. Sign in again, then try again. Your changes are still here.");
    expect(saveButton().textContent).toBe('Save 1 photo');
    expect(saveButton().disabled).toBe(false);
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('says when the server is busy', async () => {
    api.runChange.mockRejectedValue(new ApiError(503, 'busy', { message: "Couldn't check the uploaded files — please try again." }));
    open({ files: [file('a.jpg')] });
    await settle();
    await save();
    expect(message()).toBe('The server is busy. Try again in a moment.');
  });

  it('says when someone a photo is shown for was deleted meanwhile', async () => {
    api.runChange.mockRejectedValue(new ApiError(404, 'not_found', { field: 'photos.1.personIds' }));
    open({ files: [file('a.jpg'), file('b.jpg')] });
    await settle();
    await save();
    expect(message()).toBe('Someone chosen for photo 2 no longer exists: someone else deleted them. Remove them, then save.');
  });

  it("names the photo for a refusal that has no field of its own on the card", async () => {
    api.runChange.mockRejectedValue(new ApiError(400, 'invalid', {
      field: 'photos.1.upload.ext', index: 1, message: "The stored file isn't a jpg."
    }));
    mediaApi.processUpload.mockImplementation(async (uploadId, fileName) =>
      mediaFor(fileName, fileName === 'c.jpg' ? 'sha-c' : 'same-sha'));
    // Photo 2 is a copy of photo 1, so it isn't sent: photos.1 is the third card.
    open({ files: [file('a.jpg'), file('b.jpg'), file('c.jpg')] });
    await settle();
    await save();
    expect(message()).toBe("Photo 3: The stored file isn't a jpg.");
  });

  it('names the person when they were deleted meanwhile', async () => {
    api.runChange.mockRejectedValue(new ApiError(404, 'not_found', { field: 'personId' }));
    open({ files: [file('a.jpg')] });
    await settle();
    await save();
    expect(message()).toBe('Rose Smith no longer exists: someone else deleted them.');
  });

  it('disables the sheet while saving', async () => {
    const runs = hold(api.runChange);
    open({ files: [file('a.jpg')] });
    await settle();
    saveButton().click();
    await flush();
    expect(saveButton().textContent).toBe('Saving…');
    expect(saveButton().disabled).toBe(true);
    expect(caption(0).disabled).toBe(true);
    escape();
    expect(dialog()).not.toBeNull();
    runs[0].resolve(RESULT);
    await settle();
    expect(dialog()).toBeNull();
  });
});

describe('openAddPhotosDialog: closing', () => {
  it('asks before stopping uploads, and Keep uploading goes back', async () => {
    holdUploads(mediaApi);
    open({ files: [file('a.jpg'), file('b.jpg')] });
    await flush();
    $('.add-photos-cancel').click();
    expect($('.add-photos-confirm').hidden).toBe(false);
    expect($('.add-photos-confirm-text').textContent).toBe('Stop uploading and discard 2 photos?');
    expect($('.add-photos-cards').closest('[hidden]')).not.toBeNull();
    expect(document.activeElement).toBe($('.add-photos-keep'));

    $('.add-photos-keep').click();
    expect($('.add-photos-confirm').hidden).toBe(true);
    expect($('.add-photos-cards').closest('[hidden]')).toBeNull();
    expect(queue.cancel).not.toHaveBeenCalled();
  });

  it('discards the uploads and closes on Discard, from Escape or ×', async () => {
    const uploads = holdUploads(mediaApi);
    const processing = hold(mediaApi.processUpload);
    const sheet = open({ files: [file('a.jpg'), file('b.jpg')] });
    await flush();
    uploads[0].resolve(); // a.jpg uploaded, now processing
    await flush();
    escape();
    expect($('.add-photos-confirm').hidden).toBe(false);
    escape(); // Escape again keeps uploading
    expect($('.add-photos-confirm').hidden).toBe(true);
    $('.editor-dialog-close').click();
    expect($('.add-photos-confirm').hidden).toBe(false);

    $('.add-photos-discard').click();
    expect(queue.cancel).toHaveBeenCalledTimes(1);
    expect(sheet.isOpen()).toBe(false);
    expect(uploads[1].options.signal.aborted).toBe(true);
    expect(mediaApi.discardUpload).toHaveBeenCalledWith('up-1');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:a.jpg');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:b.jpg');
    processing[0]?.resolve(mediaFor('a.jpg'));
  });

  it('goes back to the photos, discarding nothing, when the uploads finish while it asks', async () => {
    const processing = hold(mediaApi.processUpload);
    const sheet = open({ files: [file('a.jpg'), file('b.jpg')] });
    await settle();
    escape();
    expect($('.add-photos-confirm-text').textContent).toBe('Stop uploading and discard 2 photos?');
    processing[0].resolve(mediaFor('a.jpg'));
    await settle();
    expect($('.add-photos-confirm').hidden).toBe(false); // b.jpg is still processing

    processing[1].resolve(mediaFor('b.jpg'));
    await settle();
    expect($('.add-photos-confirm').hidden).toBe(true);
    expect($('.add-photos-cards').closest('[hidden]')).toBeNull();
    expect(document.activeElement).toBe($('.add-photos-cancel'));
    expect($('.add-photos-announcer').textContent).toContain('The uploads have finished.');
    expect(sheet.isOpen()).toBe(true);
    expect(queue.cancel).not.toHaveBeenCalled();
  });

  it('calls off a save waiting for uploads when asked to stop', async () => {
    const processing = hold(mediaApi.processUpload);
    open({ files: [file('a.jpg')] });
    await settle();
    saveButton().click();
    await settle();
    expect(saveButton().textContent).toBe('Waiting for uploads…');
    escape();
    processing[0].resolve(mediaFor('a.jpg'));
    await settle();
    expect($('.add-photos-confirm').hidden).toBe(true); // back to the photos
    expect(api.runChange).not.toHaveBeenCalled();
    expect(saveButton().textContent).toBe('Save 1 photo');

    await save();
    expect(api.runChange).toHaveBeenCalledTimes(1);
  });

  it('closes at once when nothing is uploading', async () => {
    const sheet = open({ files: [file('a.jpg')] });
    await settle();
    $('.add-photos-cancel').click();
    expect(sheet.isOpen()).toBe(false);
    expect(queue.cancel).toHaveBeenCalledTimes(1);
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('warns before leaving the page while uploads are under way, and stops on close', async () => {
    const added = vi.spyOn(window, 'addEventListener');
    const removed = vi.spyOn(window, 'removeEventListener');
    holdUploads(mediaApi);
    const sheet = open({ files: [file('a.jpg')] });
    expect(added).toHaveBeenCalledWith('beforeunload', expect.any(Function));
    const leaving = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(leaving);
    expect(leaving.defaultPrevented).toBe(true);

    sheet.close();
    const handler = added.mock.calls.find(([name]) => name === 'beforeunload')[1];
    expect(removed).toHaveBeenCalledWith('beforeunload', handler);
    const later = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(later);
    expect(later.defaultPrevented).toBe(false);
  });

  it('stops warning once the uploads have finished', async () => {
    const processing = hold(mediaApi.processUpload);
    open({ files: [file('a.jpg')] });
    await settle();
    processing[0].resolve(mediaFor('a.jpg'));
    await settle();
    const leaving = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(leaving);
    expect(leaving.defaultPrevented).toBe(false);
  });
});
