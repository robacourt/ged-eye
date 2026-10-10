import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openAvatarDialog } from '../src/avatarDialog.js';
import { createUploadQueue } from '../src/uploadQueue.js';
import { ApiError } from '../src/editApi.js';
import { showToast } from '../src/toast.js';

vi.mock('../src/toast.js', () => ({ showToast: vi.fn() }));

const XSS = '<img src=x onerror="window.__xss = 1">';
const sha = (letter) => letter.repeat(64);
const AVATAR_KEY = `avatars/${sha('9')}-0123456789ab.webp`;
const RESULT = { change: { id: 40, summary: 'Changed the avatar of Rose Smith', personIds: ['I7'] }, view: { person: { id: 'I7' } } };
const CROP = { x: 0.25, y: 0.1, w: 0.5, h: 0.6667 };
const SAVED_CROP = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 };

/** A photo as person_record gives it: an image with a display image unless `extra` says otherwise. */
const photo = (id, letter, extra = {}) => ({
  id,
  key: `originals/${sha(letter)}.jpg`,
  thumbKey: `thumbs/${sha(letter)}.webp`,
  displayKey: `display/${sha(letter)}.webp`,
  fileName: `${letter}.jpg`,
  contentType: 'image/jpeg',
  caption: null,
  date: null,
  width: 4000,
  height: 3000,
  people: [{ id: 'I7', name: 'Rose Smith' }],
  ...extra
});

const WEDDING = photo(11, 'a', { caption: 'The wedding' });
const PICNIC = photo(12, 'b');
const CENSUS = photo(13, 'c', { key: `originals/${sha('c')}.pdf`, thumbKey: null, displayKey: null, contentType: 'application/pdf', fileName: 'Census.pdf' });
const SCAN = photo(14, 'd', { key: `originals/${sha('d')}.tif`, displayKey: null, contentType: 'image/tiff', fileName: 'Scan.tif' });

const person = (extra = {}) => ({
  id: 'I7',
  name: 'Rose Smith',
  sex: 'F',
  photos: [WEDDING, CENSUS, PICNIC, SCAN],
  avatarKey: AVATAR_KEY,
  avatarSource: { mediaId: 12, crop: SAVED_CROP },
  ...extra
});

/** processUpload's result for an uploaded JPEG. */
const mediaFor = (fileName, extra = {}) => ({
  mediaId: null,
  sha256: sha('e'),
  ext: 'jpg',
  objectKey: `originals/${sha('e')}.jpg`,
  displayKey: `display/${sha('e')}.webp`,
  thumbKey: `thumbs/${sha('e')}.webp`,
  contentType: 'image/jpeg',
  byteSize: 10,
  width: 1200,
  height: 900,
  fileName,
  caption: null,
  date: null,
  ...extra
});

const file = (name, type = 'image/jpeg') => new File([`bytes of ${name}`], name, { type });

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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

/** Fake mediaApi functions that succeed at once. Tests override them per case. */
function fakeMediaApi() {
  return {
    requestUpload: vi.fn(async ({ contentType }) => ({ uploadId: 'up-1', url: 'https://storage.test/incoming/up-1', headers: { 'Content-Type': contentType } })),
    uploadFile: vi.fn(async (slot, uploaded, { onProgress }) => onProgress(1)),
    processUpload: vi.fn(async (uploadId, fileName) => mediaFor(fileName)),
    discardUpload: vi.fn(async () => {}),
    renderAvatar: vi.fn(async () => AVATAR_KEY)
  };
}

let api;
let mediaApi;
let onSaved;
let croppers;
let clicks;
let dialogs;
let queue;

/** A stand-in for createAvatarCropper: jsdom has no layout. `ready()` and `fail()` play the image loading. */
function createCropper(options) {
  const element = document.createElement('div');
  element.className = 'fake-cropper';
  const cropper = {
    options,
    element,
    crop: CROP,
    getCrop: vi.fn(() => cropper.crop),
    destroy: vi.fn(),
    ready: () => options.onReady?.(),
    fail: () => options.onError?.(new Event('error'))
  };
  croppers.push(cropper);
  return cropper;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => {
  for (let i = 0; i < 5; i++) await flush();
};

function open(options = {}) {
  const handle = openAvatarDialog({
    person: person(),
    api,
    mediaApi,
    onSaved,
    createCropper,
    createQueue: (queueOptions) => {
      queue = createUploadQueue(queueOptions);
      return queue;
    },
    ...options
  });
  dialogs.push(handle);
  return handle;
}

const dialog = () => document.querySelector('.avatar-dialog');
const $ = (selector) => dialog().querySelector(selector);
const visible = (selector) => {
  const element = $(selector);
  return Boolean(element) && !element.closest('[hidden]');
};
const tiles = () => [...dialog().querySelectorAll('.avatar-photo')];
const tile = (mediaId) => dialog().querySelector(`.avatar-photo[data-media-id="${mediaId}"]`);
const fileInput = () => document.querySelector('.avatar-input');
const message = () => (visible('.editor-form-message') ? $('.editor-form-message .editor-error').textContent : null);
const lastCropper = () => croppers[croppers.length - 1];
const escape = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));

function choose(files) {
  Object.defineProperty(fileInput(), 'files', { value: files, configurable: true });
  fileInput().dispatchEvent(new Event('change', { bubbles: true }));
}

/** Picks the photo `mediaId`, and lets its image load. */
function crop(mediaId) {
  tile(mediaId).click();
  lastCropper().ready();
}

async function save() {
  $('.avatar-save').click();
  await settle();
}

beforeEach(() => {
  document.body.innerHTML = '';
  vi.stubEnv('VITE_MEDIA_BASE_URL', 'https://media.test/bucket');
  api = { runChange: vi.fn().mockResolvedValue(RESULT) };
  mediaApi = fakeMediaApi();
  onSaved = vi.fn();
  croppers = [];
  dialogs = [];
  queue = null;
  showToast.mockClear();
  clicks = [];
  vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function click() {
    if (this.type === 'file') clicks.push({ input: this, connected: this.isConnected });
  });
});

afterEach(() => {
  for (const handle of dialogs) handle.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('openAvatarDialog: choosing a photo', () => {
  it("shows the person's photos that have a display image, as thumbnails, marking the current one", () => {
    const handle = open();
    expect(handle.isOpen()).toBe(true);
    expect($('.editor-dialog-title').textContent).toBe('Change avatar for Rose Smith');
    // The PDF has no display image, and nor has the TIFF until it is backfilled.
    expect(tiles().map((element) => element.dataset.mediaId)).toEqual(['11', '12']);
    expect(tile(11).querySelector('img').getAttribute('src')).toBe(`https://media.test/bucket/thumbs/${sha('a')}.webp`);
    expect(tile(11).querySelector('img').alt).toBe('');
    expect(tile(11).getAttribute('aria-label')).toBe('The wedding');
    expect(tile(12).getAttribute('aria-label')).toBe('b.jpg, the current avatar');
    expect(tile(11).querySelector('.avatar-photo-current')).toBeNull();
    expect(tile(12).querySelector('.avatar-photo-current').textContent).toBe('Current');
    expect(tile(12).classList.contains('avatar-photo-is-current')).toBe(true);
    expect(visible('.avatar-upload-tile')).toBe(true);
    expect($('.avatar-upload-tile').textContent).toContain('Upload new');
    expect(visible('.avatar-remove')).toBe(true);
    expect(croppers).toHaveLength(0);
  });

  it('offers no Remove avatar when there is no avatar, and says so when there are no photos to choose from', () => {
    open({ person: person({ photos: [CENSUS], avatarKey: null, avatarSource: undefined }) });
    expect(tiles()).toHaveLength(0);
    expect(visible('.avatar-remove')).toBe(false);
    expect(visible('.avatar-upload-tile')).toBe(true);
    expect($('.avatar-pick-hint').textContent).toBe('Rose Smith has no photos to use yet. Upload one.');
  });

  it('sets captions and file names as text', () => {
    open({ person: person({ photos: [photo(21, 'f', { caption: XSS })] }) });
    expect(tile(21).getAttribute('aria-label')).toBe(XSS);
    expect(document.querySelector('img[src="x"]')).toBeNull();
    expect(window.__xss).toBeUndefined();
  });

  it('opens the cropper on the display image of the chosen photo, centred by default', () => {
    open();
    tile(11).click();
    expect(croppers).toHaveLength(1);
    expect(lastCropper().options.imageUrl).toBe(`https://media.test/bucket/display/${sha('a')}.webp`);
    expect(lastCropper().options.initialCrop).toBeNull();
    expect($('.avatar-crop-area').contains(lastCropper().element)).toBe(true);
    expect(visible('.avatar-crop-area')).toBe(true);
    expect(visible('.avatar-photos')).toBe(false);
    expect($('.avatar-save').textContent).toBe('Use as avatar');
    expect($('.avatar-save').disabled).toBe(true); // until the photo has loaded
    lastCropper().ready();
    expect($('.avatar-save').disabled).toBe(false);
  });

  it("starts from the saved crop when the current avatar's photo is chosen", () => {
    open();
    tile(12).click();
    expect(lastCropper().options.initialCrop).toEqual(SAVED_CROP);
  });

  it('goes Back to the photos, closing the cropper', () => {
    open();
    crop(11);
    $('.avatar-back').click();
    expect(lastCropper().destroy).toHaveBeenCalled();
    expect(visible('.avatar-photos')).toBe(true);
    expect(visible('.avatar-crop-area')).toBe(false);
    expect(document.activeElement).toBe(tile(11));
  });

  it('opens straight at the crop step for `startWith`, as the viewer\'s Avatar button does', () => {
    open({ startWith: PICNIC });
    expect(visible('.avatar-crop-area')).toBe(true);
    expect(lastCropper().options.imageUrl).toBe(`https://media.test/bucket/display/${sha('b')}.webp`);
    expect(lastCropper().options.initialCrop).toEqual(SAVED_CROP);
    $('.avatar-back').click();
    expect(visible('.avatar-photos')).toBe(true);
  });

  it('opens at the photos when `startWith` has no display image', () => {
    open({ startWith: SCAN });
    expect(croppers).toHaveLength(0);
    expect(visible('.avatar-photos')).toBe(true);
  });

  it("says so when the photo won't load, and Retry loads it again", () => {
    open();
    tile(11).click();
    lastCropper().fail();
    expect(message()).toBe("Couldn't load the photo. Check your connection, then retry.");
    expect($('.avatar-save').disabled).toBe(true);
    $('.avatar-retry').click();
    expect(croppers[0].destroy).toHaveBeenCalled();
    expect(croppers).toHaveLength(2);
    expect(message()).toBeNull();
    lastCropper().ready();
    expect($('.avatar-save').disabled).toBe(false);
  });

  it('closes on Escape, closing the cropper', () => {
    const handle = open();
    crop(11);
    escape();
    expect(handle.isOpen()).toBe(false);
    expect(dialog()).toBeNull();
    expect(lastCropper().destroy).toHaveBeenCalled();
  });
});

describe('openAvatarDialog: saving', () => {
  it('renders the crop of the original, then sends set_avatar with the media id, then calls onSaved', async () => {
    const handle = open();
    crop(11);
    await save();
    expect(mediaApi.renderAvatar).toHaveBeenCalledWith(WEDDING.key, CROP);
    expect(api.runChange).toHaveBeenCalledWith('set_avatar', { personId: 'I7', mediaId: 11, crop: CROP, avatarKey: AVATAR_KEY });
    expect(onSaved).toHaveBeenCalledWith(RESULT);
    expect(handle.isOpen()).toBe(false);
    expect(lastCropper().destroy).toHaveBeenCalled();
  });

  it('shows Saving… and ignores Escape while it saves', async () => {
    const renders = hold(mediaApi.renderAvatar);
    const handle = open();
    crop(11);
    $('.avatar-save').click();
    expect($('.avatar-save').textContent).toBe('Saving…');
    expect($('.avatar-save').disabled).toBe(true);
    expect($('.avatar-back').disabled).toBe(true);
    escape();
    expect(handle.isOpen()).toBe(true);
    $('.avatar-save').click();
    renders[0].resolve(AVATAR_KEY);
    await settle();
    expect(mediaApi.renderAvatar).toHaveBeenCalledTimes(1);
    expect(api.runChange).toHaveBeenCalledTimes(1);
    expect(handle.isOpen()).toBe(false);
  });

  it('closes with "Avatar unchanged" when the same crop is saved again', async () => {
    api.runChange.mockRejectedValue(new ApiError(400, 'no_change'));
    const handle = open();
    crop(12);
    await save();
    expect(showToast).toHaveBeenCalledWith('Avatar unchanged');
    expect(onSaved).not.toHaveBeenCalled();
    expect(handle.isOpen()).toBe(false);
  });

  it('shows a failed render inline, and Retry saves again', async () => {
    mediaApi.renderAvatar.mockRejectedValueOnce(new ApiError(503, 'busy'));
    const handle = open();
    crop(11);
    await save();
    expect(message()).toBe('The server is busy. Try again in a moment.');
    expect(visible('.avatar-retry')).toBe(true);
    expect(api.runChange).not.toHaveBeenCalled();
    expect(handle.isOpen()).toBe(true);
    expect($('.avatar-save').disabled).toBe(false);

    $('.avatar-retry').click();
    await settle();
    expect(mediaApi.renderAvatar).toHaveBeenCalledTimes(2);
    expect(api.runChange).toHaveBeenCalledTimes(1);
    expect(onSaved).toHaveBeenCalledWith(RESULT);
    expect(handle.isOpen()).toBe(false);
  });

  it("shows the server's words for an invalid crop or photo", async () => {
    api.runChange.mockRejectedValueOnce(new ApiError(400, 'invalid', { field: 'mediaId', message: "That photo isn't one of Rose Smith's photos." }));
    open();
    crop(11);
    await save();
    expect(message()).toBe("That photo isn't one of Rose Smith's photos.");
    mediaApi.renderAvatar.mockRejectedValueOnce(new ApiError(400, 'invalid', { field: 'crop', message: 'The crop is too small: it must be at least 32 pixels.' }));
    $('.avatar-retry').click();
    await settle();
    expect(message()).toBe('The crop is too small: it must be at least 32 pixels.');
  });

  it('explains other failures as other dialogs do', async () => {
    api.runChange.mockRejectedValueOnce(new ApiError(401, 'unauthorized'));
    open();
    crop(11);
    await save();
    expect(message()).toBe("You're signed out. Sign in again, then try again. Your changes are still here.");
    api.runChange.mockRejectedValueOnce(new ApiError(404, 'not_found', { field: 'personId' }));
    $('.avatar-retry').click();
    await settle();
    expect(message()).toBe('Rose Smith no longer exists: someone else deleted them.');
    api.runChange.mockRejectedValueOnce(new ApiError(404, 'not_found', { field: 'mediaId' }));
    $('.avatar-retry').click();
    await settle();
    expect(message()).toBe('This photo no longer exists: someone else deleted it.');
  });

  it('clears the message when going Back', async () => {
    api.runChange.mockRejectedValueOnce(new ApiError(503, 'busy'));
    open();
    crop(11);
    await save();
    $('.avatar-back').click();
    expect(message()).toBeNull();
  });
});

describe('openAvatarDialog: Remove avatar', () => {
  it('asks first, then sends clear_avatar and calls onSaved', async () => {
    const handle = open();
    $('.avatar-remove').click();
    expect(visible('.avatar-photos')).toBe(false);
    expect($('.avatar-confirm-text').textContent).toBe('Remove the avatar of Rose Smith? The photo stays in their photos.');
    expect($('.avatar-confirm-yes').textContent).toBe('Remove avatar');
    expect(document.activeElement).toBe($('.avatar-confirm-no'));
    expect(api.runChange).not.toHaveBeenCalled();

    $('.avatar-confirm-yes').click();
    await settle();
    expect(api.runChange).toHaveBeenCalledWith('clear_avatar', { personId: 'I7' });
    expect(onSaved).toHaveBeenCalledWith(RESULT);
    expect(handle.isOpen()).toBe(false);
  });

  it('goes back to the photos on Cancel or Escape, sending nothing', () => {
    const handle = open();
    $('.avatar-remove').click();
    $('.avatar-confirm-no').click();
    expect(visible('.avatar-photos')).toBe(true);
    expect(document.activeElement).toBe($('.avatar-remove'));
    $('.avatar-remove').click();
    escape();
    expect(handle.isOpen()).toBe(true);
    expect(visible('.avatar-photos')).toBe(true);
    expect(api.runChange).not.toHaveBeenCalled();
  });

  it('shows a failure inline with Retry', async () => {
    api.runChange.mockRejectedValueOnce(new ApiError(0, 'network', { message: "Couldn't reach the server. Check your connection." }));
    const handle = open();
    $('.avatar-remove').click();
    $('.avatar-confirm-yes').click();
    await settle();
    expect(message()).toBe("Couldn't reach the server. Check your connection.");
    $('.avatar-retry').click();
    await settle();
    expect(api.runChange).toHaveBeenCalledTimes(2);
    expect(handle.isOpen()).toBe(false);
  });

  it('closes with a toast when someone else already removed it', async () => {
    api.runChange.mockRejectedValueOnce(new ApiError(400, 'no_change'));
    const handle = open();
    $('.avatar-remove').click();
    $('.avatar-confirm-yes').click();
    await settle();
    expect(showToast).toHaveBeenCalledWith('The avatar was already removed');
    expect(onSaved).not.toHaveBeenCalled();
    expect(handle.isOpen()).toBe(false);
  });
});

describe('openAvatarDialog: Upload new', () => {
  it('opens the picker for one image from inside the dialog, at once', () => {
    open();
    $('.avatar-upload-tile').click();
    expect(clicks).toEqual([{ input: fileInput(), connected: true }]);
    expect(fileInput().closest('.editor-dialog-backdrop')).not.toBeNull();
    expect(fileInput().accept).toBe('image/*');
    expect(fileInput().multiple).toBe(false);
    expect(fileInput().hasAttribute('capture')).toBe(false);
  });

  it('shows the upload, then crops the processed photo, then saves it as a new photo shown for the person', async () => {
    const uploads = hold(mediaApi.uploadFile);
    const processing = hold(mediaApi.processUpload);
    open();
    $('.avatar-upload-tile').click();
    choose([file('Rose.jpg')]);
    expect(visible('.avatar-upload')).toBe(true);
    expect($('.avatar-upload-name').textContent).toBe('Rose.jpg');
    await flush();
    expect(mediaApi.requestUpload).toHaveBeenCalledWith({ fileName: 'Rose.jpg', contentType: 'image/jpeg', byteSize: expect.any(Number) });
    expect($('.avatar-upload-status').textContent).toBe('Uploading 0%');

    uploads[0].args[2].onProgress(0.4);
    expect($('.avatar-upload-status').textContent).toBe('Uploading 40%');
    expect(Number($('.avatar-upload-progress').value)).toBeCloseTo(0.4);
    uploads[0].resolve();
    await flush();
    expect($('.avatar-upload-status').textContent).toBe('Processing…');
    expect(croppers).toHaveLength(0);

    processing[0].resolve(mediaFor('Rose.jpg'));
    await settle();
    expect(visible('.avatar-crop-area')).toBe(true);
    expect(lastCropper().options.imageUrl).toBe(`https://media.test/bucket/display/${sha('e')}.webp`);
    expect(lastCropper().options.initialCrop).toBeNull();

    lastCropper().ready();
    await save();
    expect(mediaApi.renderAvatar).toHaveBeenCalledWith(`originals/${sha('e')}.jpg`, CROP);
    expect(api.runChange).toHaveBeenCalledWith('set_avatar', {
      personId: 'I7',
      photo: { upload: { sha256: sha('e'), ext: 'jpg', fileName: 'Rose.jpg' }, caption: null, date: null, personIds: ['I7'] },
      crop: CROP,
      avatarKey: AVATAR_KEY
    });
    expect(onSaved).toHaveBeenCalledWith(RESULT);
  });

  it('sends a file already in the tree by its media id, starting from the saved crop when it is the current photo', async () => {
    mediaApi.processUpload.mockResolvedValue(mediaFor('Again.jpg', { mediaId: 12, sha256: sha('b'), objectKey: PICNIC.key }));
    open();
    choose([file('Again.jpg')]);
    await settle();
    expect(lastCropper().options.initialCrop).toEqual(SAVED_CROP);
    lastCropper().ready();
    await save();
    expect(api.runChange).toHaveBeenCalledWith('set_avatar', {
      personId: 'I7',
      photo: { mediaId: 12, caption: null, date: null, personIds: ['I7'] },
      crop: CROP,
      avatarKey: AVATAR_KEY
    });
  });

  it("refuses a file that can't be an avatar, without cropping it", async () => {
    mediaApi.processUpload.mockResolvedValue(mediaFor('Census.pdf', { ext: 'pdf', contentType: 'application/pdf', displayKey: null, thumbKey: null }));
    open();
    choose([file('Census.pdf', 'application/pdf')]);
    await settle();
    expect(croppers).toHaveLength(0);
    expect($('.avatar-upload-status').textContent).toBe("A PDF can't be an avatar: choose a photo.");
    expect(visible('.avatar-upload-retry')).toBe(false);
  });

  it("refuses a photo already in the tree that hasn't been prepared for viewing yet", async () => {
    mediaApi.processUpload.mockResolvedValue(mediaFor('Scan.tif', { mediaId: 14, ext: 'tif', contentType: 'image/tiff', displayKey: null }));
    open();
    choose([file('Scan.tif', 'image/tiff')]);
    await settle();
    expect(croppers).toHaveLength(0);
    expect($('.avatar-upload-status').textContent)
      .toBe("This photo is already in the tree but hasn't been prepared for viewing yet, so it can't be an avatar.");
  });

  it('shows why an upload failed, and Retry resumes it', async () => {
    mediaApi.uploadFile.mockRejectedValueOnce(new ApiError(0, 'network'));
    open();
    choose([file('Rose.jpg')]);
    await settle();
    expect($('.avatar-upload-status').textContent).toBe('Upload failed. Check your connection, then retry.');
    expect($('.avatar-upload-status').classList.contains('avatar-upload-status-error')).toBe(true);
    expect(visible('.avatar-upload-retry')).toBe(true);

    $('.avatar-upload-retry').click();
    await settle();
    expect(mediaApi.uploadFile).toHaveBeenCalledTimes(2);
    expect(visible('.avatar-crop-area')).toBe(true);
  });

  it("shows a refused file's reason, with no Retry", async () => {
    mediaApi.processUpload.mockRejectedValue(new ApiError(400, 'heic_unsupported'));
    open();
    choose([file('Rose.heic', 'image/heic')]);
    await settle();
    expect($('.avatar-upload-status').textContent).toBe("This HEIC file couldn't be read. Export it as JPEG and try again.");
    expect(visible('.avatar-upload-retry')).toBe(false);
  });

  it('goes Back to the photos, discarding the upload', async () => {
    hold(mediaApi.processUpload);
    open();
    choose([file('Rose.jpg')]);
    await settle();
    $('.avatar-upload-back').click();
    expect(visible('.avatar-photos')).toBe(true);
    expect(mediaApi.discardUpload).toHaveBeenCalledWith('up-1');
    expect(queue.items()).toHaveLength(0);
  });

  it('goes Back from cropping an upload to the photos', async () => {
    open();
    choose([file('Rose.jpg')]);
    await settle();
    $('.avatar-back').click();
    expect(visible('.avatar-photos')).toBe(true);
    expect(queue.items()).toHaveLength(0);
  });

  it('asks before closing during an upload; Keep uploading carries on, Discard stops it', async () => {
    const processing = hold(mediaApi.processUpload);
    const handle = open();
    choose([file('Rose.jpg')]);
    await settle();
    escape();
    expect(handle.isOpen()).toBe(true);
    expect($('.avatar-confirm-text').textContent).toBe('Stop uploading this photo?');
    expect(document.activeElement).toBe($('.avatar-confirm-no'));
    expect($('.avatar-confirm-no').textContent).toBe('Keep uploading');

    $('.avatar-confirm-no').click();
    expect(visible('.avatar-upload')).toBe(true);
    processing[0].resolve(mediaFor('Rose.jpg'));
    await settle();
    expect(visible('.avatar-crop-area')).toBe(true);

    $('.avatar-back').click();
    choose([file('Other.jpg')]);
    await settle();
    $('.editor-dialog-close').click();
    $('.avatar-confirm-yes').click();
    expect(handle.isOpen()).toBe(false);
    expect(mediaApi.discardUpload).toHaveBeenCalledWith('up-1');
  });

  it('waits on the confirmation when the upload finishes behind it, then crops on Keep uploading', async () => {
    const processing = hold(mediaApi.processUpload);
    open();
    choose([file('Rose.jpg')]);
    await settle();
    escape();
    processing[0].resolve(mediaFor('Rose.jpg'));
    await settle();
    expect(croppers).toHaveLength(0);
    expect(visible('.avatar-confirm-text')).toBe(true);
    $('.avatar-confirm-no').click();
    expect(visible('.avatar-crop-area')).toBe(true);
    expect(croppers).toHaveLength(1);
  });

  it('warns before leaving the page only while uploading', async () => {
    const processing = hold(mediaApi.processUpload);
    open();
    const before = () => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(before()).toBe(false);
    choose([file('Rose.jpg')]);
    await settle();
    expect(before()).toBe(true);
    processing[0].resolve(mediaFor('Rose.jpg'));
    await settle();
    expect(before()).toBe(false);
  });
});
