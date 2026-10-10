import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PhotoViewer } from '../src/photoViewer.js';

const XSS = '<img src=x onerror="window.__xss = 1">';
const BASE = 'https://media.test/bucket';

const PHOTO = {
  id: 42,
  key: 'originals/abc.jpg',
  thumbKey: 'thumbs/abc.webp',
  displayKey: 'display/abc.webp',
  fileName: 'wedding.jpg',
  contentType: 'image/jpeg',
  caption: 'The wedding',
  date: '12 MAR 1920',
  width: 2000,
  height: 1500,
  people: [{ id: 'I7', name: 'Alice Smith' }, { id: 'I1', name: 'Tom Smith' }]
};
const LETTER = {
  id: 43,
  key: 'originals/def.pdf',
  thumbKey: null,
  displayKey: null,
  fileName: 'letter.pdf',
  contentType: 'application/pdf',
  caption: null,
  date: null,
  width: null,
  height: null,
  people: [{ id: 'I7', name: 'Alice Smith' }]
};
/** As views before migration 008 gave a photo: no id, display image, caption, date or people. */
const OLD = { key: 'originals/old.jpg', thumbKey: 'thumbs/old.webp', fileName: 'old.jpg', contentType: 'image/jpeg' };

let viewer;
let hooks;

const $ = (selector) => viewer.modal.querySelector(selector);
const $$ = (selector) => [...viewer.modal.querySelectorAll(selector)];
/** Shown, as far as jsdom can tell: neither it nor anything around it hidden by attribute or inline style. */
const visible = (element) => Boolean(element) && !element.closest('[hidden]') && element.style.display !== 'none';
const action = (name) => $(`.photo-viewer-action[data-action="${name}"]`);
const actionLabels = () => $$('.photo-viewer-action').map(button => button.textContent.trim());
const people = () => $$('.photo-viewer-person').map(button => button.textContent);
const key = (name) => document.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));

/** Whether the viewer is open, by its flag and its class: hooks must see it closed. */
const openState = () => ({ isOpen: viewer.isOpen, shown: viewer.modal.classList.contains('photo-viewer-open') });
const CLOSED = { isOpen: false, shown: false };

function open(photos = [PHOTO, LETTER], { name = 'Alice Smith', start = 0 } = {}) {
  viewer.open(name, photos, start);
}

beforeEach(() => {
  document.body.innerHTML = '';
  vi.stubEnv('VITE_MEDIA_BASE_URL', BASE);
  vi.stubEnv('VITE_MEDIA_API_URL', 'https://media-api.test');
  viewer = new PhotoViewer();
  hooks = { onEdit: vi.fn(), onUseAsAvatar: vi.fn(), onRemove: vi.fn() };
});

afterEach(() => {
  viewer.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  delete window.__xss;
});

describe('PhotoViewer', () => {
  describe('the photo', () => {
    it('shows the display image of an image, with its counter and name', () => {
      open();
      expect(viewer.isOpen).toBe(true);
      expect(viewer.modal.classList.contains('photo-viewer-open')).toBe(true);
      expect($('.photo-viewer-image').getAttribute('src')).toBe(`${BASE}/display/abc.webp`);
      expect($('.photo-viewer-title').textContent).toBe('Alice Smith');
      expect($('.photo-viewer-counter').textContent).toBe('Photo 1 of 2');
      expect(visible($('.photo-viewer-download'))).toBe(false);
    });

    it('falls back to the original for an image with no display image yet', () => {
      open([OLD]);
      expect($('.photo-viewer-image').getAttribute('src')).toBe(`${BASE}/originals/old.jpg`);
    });

    it('opens at the photo asked for', () => {
      open([PHOTO, LETTER], { start: 1 });
      expect(viewer.currentIndex).toBe(1);
      expect($('.photo-viewer-counter').textContent).toBe('Photo 2 of 2');
    });

    it('keeps the download panel for a document, opening it in a new tab', () => {
      open([LETTER]);
      expect(visible($('.photo-viewer-download'))).toBe(true);
      expect($('.photo-viewer-download-filename').textContent).toBe('letter.pdf');
      const button = $('.photo-viewer-download-button');
      expect(button.getAttribute('href')).toBe(`${BASE}/originals/def.pdf`);
      expect(button.getAttribute('target')).toBe('_blank');
      expect(button.getAttribute('rel')).toBe('noopener');
      expect($('.photo-viewer-image').getAttribute('src') ?? '').toBe('');
      // The panel is the download: no second link below.
      expect(visible($('.photo-viewer-original'))).toBe(false);
    });

    it('links "Download original" to the original, in a new tab', () => {
      open();
      const link = $('.photo-viewer-original');
      expect(visible(link)).toBe(true);
      expect(link.textContent).toContain('Download original');
      expect(link.getAttribute('href')).toBe(`${BASE}/originals/abc.jpg`);
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')).toBe('noopener');
      expect(link.hasAttribute('download')).toBe(false);
    });

    it('moves between photos with the buttons and arrow keys, and closes with Escape', () => {
      open();
      $('.photo-viewer-next').click();
      expect($('.photo-viewer-counter').textContent).toBe('Photo 2 of 2');
      key('ArrowRight');
      expect($('.photo-viewer-counter').textContent).toBe('Photo 1 of 2');
      key('ArrowLeft');
      expect($('.photo-viewer-counter').textContent).toBe('Photo 2 of 2');
      key('Escape');
      expect(viewer.isOpen).toBe(false);
      expect(viewer.modal.classList.contains('photo-viewer-open')).toBe(false);
    });

    it('says when there are no photos, with no caption or actions', () => {
      viewer.setEditorHooks(hooks);
      open([]);
      expect($('.photo-viewer-loading').textContent).toBe('No photos available');
      expect(visible($('.photo-viewer-caption-block'))).toBe(false);
      expect($$('.photo-viewer-action')).toHaveLength(0);
      expect(visible($('.photo-viewer-original'))).toBe(false);
    });
  });

  describe('the caption block', () => {
    it('shows the caption, the date and who the photo is shown for', () => {
      open();
      expect($('.photo-viewer-caption').textContent).toBe('The wedding');
      expect($('.photo-viewer-date').textContent).toBe('12 MAR 1920');
      expect(visible($('.photo-viewer-people'))).toBe(true);
      expect($('.photo-viewer-people').textContent).toContain('Shown for');
      expect(people()).toEqual(['Alice Smith', 'Tom Smith']);
      expect($('.photo-viewer-person').getAttribute('type')).toBe('button');
    });

    it('hides what a photo has not got', () => {
      open([LETTER]);
      expect(visible($('.photo-viewer-caption'))).toBe(false);
      expect(visible($('.photo-viewer-date'))).toBe(false);
      expect(people()).toEqual(['Alice Smith']);
    });

    it('copes with a photo from an older view', () => {
      open([OLD]);
      expect(visible($('.photo-viewer-caption'))).toBe(false);
      expect(visible($('.photo-viewer-date'))).toBe(false);
      expect(visible($('.photo-viewer-people'))).toBe(false);
      expect($('.photo-viewer-filename').textContent).toBe('old.jpg');
    });

    it('names an unnamed person', () => {
      open([{ ...PHOTO, people: [{ id: 'I9', name: '' }] }]);
      expect(people()).toEqual(['Unnamed person']);
    });

    it('sets every data value as text', () => {
      open([{ ...PHOTO, caption: XSS, date: XSS, fileName: XSS, people: [{ id: 'I9', name: XSS }] }], { name: XSS });
      expect($('.photo-viewer-caption').textContent).toBe(XSS);
      expect($('.photo-viewer-date').textContent).toBe(XSS);
      expect($('.photo-viewer-filename').textContent).toBe(XSS);
      expect($('.photo-viewer-title').textContent).toBe(XSS);
      expect(people()).toEqual([XSS]);
      expect(viewer.modal.querySelector('img[src="x"]')).toBeNull();
      expect(window.__xss).toBeUndefined();
    });

    it('opens a person from their link, closing the viewer first', () => {
      const seen = [];
      viewer.onOpenPerson = vi.fn(() => seen.push(openState()));
      open();
      $$('.photo-viewer-person')[1].click();
      expect(viewer.onOpenPerson).toHaveBeenCalledWith('I1');
      expect(seen).toEqual([CLOSED]);
    });

    it('still closes when nothing opens people', () => {
      open();
      $('.photo-viewer-person').click();
      expect(viewer.isOpen).toBe(false);
    });
  });

  describe('editor actions', () => {
    it('shows none for viewers', () => {
      open();
      expect($$('.photo-viewer-action')).toHaveLength(0);
      expect(visible($('.photo-viewer-actions'))).toBe(false);
    });

    it('shows Caption, Avatar, People and Remove for editors, each at least an icon and a label', () => {
      viewer.setEditorHooks(hooks);
      open();
      expect(actionLabels()).toEqual(['Caption', 'Avatar', 'People', 'Remove']);
      for (const button of $$('.photo-viewer-action')) {
        expect(button.getAttribute('type')).toBe('button');
        expect(button.querySelector('svg').getAttribute('aria-hidden')).toBe('true');
      }
      expect(action('avatar').getAttribute('aria-label')).toBe('Use as avatar for Alice Smith');
      expect(action('remove').getAttribute('aria-label')).toBe('Remove this photo from Alice Smith');
    });

    it('adds and takes away the actions while open', () => {
      open();
      viewer.setEditorHooks(hooks);
      expect(actionLabels()).toEqual(['Caption', 'Avatar', 'People', 'Remove']);
      viewer.setEditorHooks(null);
      expect($$('.photo-viewer-action')).toHaveLength(0);
    });

    it('Caption and People close the viewer, then edit the photo shown', () => {
      const seen = [];
      hooks.onEdit.mockImplementation(() => seen.push(openState()));
      viewer.setEditorHooks(hooks);
      open();
      action('caption').click();
      expect(hooks.onEdit).toHaveBeenCalledWith(PHOTO);
      expect(seen).toEqual([CLOSED]);

      open([PHOTO, LETTER], { start: 1 });
      action('people').click();
      expect(hooks.onEdit).toHaveBeenLastCalledWith(LETTER);
      expect(seen).toEqual([CLOSED, CLOSED]);
    });

    it('Avatar closes the viewer, then uses the photo as the avatar', () => {
      const seen = [];
      hooks.onUseAsAvatar.mockImplementation(() => seen.push(openState()));
      viewer.setEditorHooks(hooks);
      open();
      action('avatar').click();
      expect(hooks.onUseAsAvatar).toHaveBeenCalledWith(PHOTO);
      expect(seen).toEqual([CLOSED]);
      expect(hooks.onEdit).not.toHaveBeenCalled();
    });

    it('acts on the photo shown after moving', () => {
      viewer.setEditorHooks(hooks);
      open([PHOTO, { ...PHOTO, id: 44, key: 'originals/ghi.jpg' }]);
      key('ArrowRight');
      action('caption').click();
      expect(hooks.onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: 44 }));
    });

    it('hides Avatar for a photo with no display image', () => {
      viewer.setEditorHooks(hooks);
      open([LETTER]);
      expect(actionLabels()).toEqual(['Caption', 'People', 'Remove']);
      open([{ ...PHOTO, displayKey: null }]);
      expect(actionLabels()).toEqual(['Caption', 'People', 'Remove']);
    });

    it('hides Avatar when the media service is not configured', () => {
      vi.stubEnv('VITE_MEDIA_API_URL', '');
      viewer.setEditorHooks(hooks);
      open();
      expect(actionLabels()).toEqual(['Caption', 'People', 'Remove']);
    });

    it('shows no actions for a photo from an older view, which has no id to act on', () => {
      viewer.setEditorHooks(hooks);
      open([OLD]);
      expect($$('.photo-viewer-action')).toHaveLength(0);
    });

    it('Remove closes the viewer, confirms, then removes the photo', () => {
      const seen = [];
      const confirm = vi.spyOn(window, 'confirm').mockImplementation(() => {
        seen.push(openState());
        return true;
      });
      hooks.onRemove.mockImplementation(() => seen.push(openState()));
      viewer.setEditorHooks(hooks);
      open();
      action('remove').click();
      expect(confirm).toHaveBeenCalledWith("Remove this photo from Alice Smith? It stays for anyone else it's shown for.");
      expect(hooks.onRemove).toHaveBeenCalledWith(PHOTO);
      expect(seen).toEqual([CLOSED, CLOSED]);
    });

    it('Remove, cancelled, goes back to the photo without removing it', () => {
      vi.spyOn(window, 'confirm').mockReturnValue(false);
      viewer.setEditorHooks(hooks);
      open([PHOTO, LETTER], { start: 1 });
      action('remove').click();
      expect(hooks.onRemove).not.toHaveBeenCalled();
      expect(viewer.isOpen).toBe(true);
      expect(viewer.currentIndex).toBe(1);
      expect($('.photo-viewer-counter').textContent).toBe('Photo 2 of 2');
    });

    it('names an unnamed person in the confirmation', () => {
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
      viewer.setEditorHooks(hooks);
      open([PHOTO], { name: '' });
      action('remove').click();
      expect(confirm).toHaveBeenCalledWith("Remove this photo from Unnamed person? It stays for anyone else it's shown for.");
    });

    it('survives a hook that throws', () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      hooks.onEdit.mockImplementation(() => { throw new Error('boom'); });
      viewer.setEditorHooks(hooks);
      open();
      action('caption').click();
      expect(error).toHaveBeenCalled();
      expect(viewer.isOpen).toBe(false);
      open();
      expect(viewer.isOpen).toBe(true);
    });

    it('takes focus out of the viewer as it closes, so a dialog opened next does not return focus into it', () => {
      viewer.setEditorHooks(hooks);
      open();
      action('caption').focus();
      expect(document.activeElement).toBe(action('caption'));
      const focusInside = [];
      hooks.onEdit.mockImplementation(() => focusInside.push(viewer.modal.contains(document.activeElement)));
      action('caption').click();
      expect(focusInside).toEqual([false]);
    });
  });
});
