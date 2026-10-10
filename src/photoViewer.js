import { displayUrl, mediaUrl } from './media.js';
import { nameOf } from './familyLinks.js';

/**
 * The editor actions under a photo, in order: `hook` is the editor hook each calls. Icons are literals, never data.
 * Caption and People open the same editor; Avatar shows only for a photo with a display image (to crop).
 */
const ACTIONS = [
  {
    name: 'caption', label: 'Caption', hook: 'onEdit',
    icon: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>'
  },
  {
    name: 'avatar', label: 'Avatar', hook: 'onUseAsAvatar',
    icon: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="10" r="3"/><path d="M6.2 18.4a7 7 0 0 1 11.6 0"/>'
  },
  {
    name: 'people', label: 'People', hook: 'onEdit',
    icon: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8"/>' +
      '<path d="M18 14.2a6.5 6.5 0 0 1 3.5 5.8"/>'
  },
  {
    name: 'remove', label: 'Remove', hook: 'onRemove',
    icon: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v5"/><path d="M14 11v5"/>'
  }
];

const ICON_ATTRIBUTES = 'viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"';

/** Runs a caller's hook without letting its failure break the viewer. */
function callSafely(hook, ...args) {
  try {
    hook?.(...args);
  } catch (error) {
    console.error('Photo viewer hook failed', error);
  }
}

const hasId = (photo) => photo?.id !== undefined && photo?.id !== null;

/**
 * Full-screen viewer for a person's photos: the display image (or a download panel for a document), its caption,
 * date and the people it is shown for, and "Download original". Editors also get Caption, Avatar, People and
 * Remove (setEditorHooks). Every data value is set with `textContent` or as a property, never as HTML.
 *
 * `onOpenPerson` (personId), set by the details panel, opens someone from the "Shown for" links.
 *
 * It is a modal dialog: opening it moves focus to its close button, and a plain close (×, Escape, the overlay)
 * gives focus back to whatever had it. Closing for an editor hook or a person link doesn't: what opens next
 * takes over.
 */
export class PhotoViewer {
  constructor() {
    this.currentIndex = 0;
    this.photos = [];
    this.personName = '';
    this.isOpen = false;
    /** (personId) → void: opens a person from a "Shown for" link, after the viewer has closed. */
    this.onOpenPerson = null;
    this.editorHooks = null;
    this.opener = null; // the element focused when the viewer opened, given focus back on a plain close

    this.createViewer();
    this.attachEventListeners();
  }

  createViewer() {
    // Create modal overlay
    const modal = document.createElement('div');
    modal.id = 'photo-viewer';
    modal.className = 'photo-viewer';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'Photos');
    modal.innerHTML = `
      <div class="photo-viewer-overlay"></div>
      <div class="photo-viewer-content">
        <button class="photo-viewer-close" aria-label="Close viewer">×</button>
        <div class="photo-viewer-header">
          <h2 class="photo-viewer-title"></h2>
          <p class="photo-viewer-counter"></p>
        </div>
        <div class="photo-viewer-main">
          <div class="photo-viewer-image-wrapper">
            <button class="photo-viewer-nav photo-viewer-prev" aria-label="Previous photo">‹</button>
            <div class="photo-viewer-image-container">
              <img class="photo-viewer-image" alt="Person photo" />
              <div class="photo-viewer-loading">Loading...</div>
              <div class="photo-viewer-download">
                <p class="photo-viewer-download-filename"></p>
                <p class="photo-viewer-download-message">This file cannot be displayed</p>
                <a class="photo-viewer-download-button" target="_blank" rel="noopener" download>Download File</a>
              </div>
            </div>
            <button class="photo-viewer-nav photo-viewer-next" aria-label="Next photo">›</button>
          </div>
        </div>
        <div class="photo-viewer-footer">
          <div class="photo-viewer-caption-block">
            <p class="photo-viewer-caption"></p>
            <p class="photo-viewer-date"></p>
            <div class="photo-viewer-people">
              <span class="photo-viewer-people-label">Shown for</span>
              <span class="photo-viewer-people-list"></span>
            </div>
          </div>
          <div class="photo-viewer-file">
            <p class="photo-viewer-filename"></p>
            <a class="photo-viewer-original" target="_blank" rel="noopener">Download original</a>
          </div>
          <div class="photo-viewer-actions" role="group" aria-label="Edit this photo" hidden></div>
        </div>
      </div>
    `;

    document.body.appendChild(modal);
    this.modal = modal;
    this.closeButton = modal.querySelector('.photo-viewer-close');
    this.image = modal.querySelector('.photo-viewer-image');
    this.title = modal.querySelector('.photo-viewer-title');
    this.counter = modal.querySelector('.photo-viewer-counter');
    this.loading = modal.querySelector('.photo-viewer-loading');
    this.prevBtns = modal.querySelectorAll('.photo-viewer-prev');
    this.nextBtns = modal.querySelectorAll('.photo-viewer-next');
    this.filename = modal.querySelector('.photo-viewer-filename');
    this.downloadContainer = modal.querySelector('.photo-viewer-download');
    this.downloadFilename = modal.querySelector('.photo-viewer-download-filename');
    this.downloadButton = modal.querySelector('.photo-viewer-download-button');
    this.captionBlock = modal.querySelector('.photo-viewer-caption-block');
    this.caption = modal.querySelector('.photo-viewer-caption');
    this.date = modal.querySelector('.photo-viewer-date');
    this.people = modal.querySelector('.photo-viewer-people');
    this.peopleList = modal.querySelector('.photo-viewer-people-list');
    this.fileRow = modal.querySelector('.photo-viewer-file');
    this.originalLink = modal.querySelector('.photo-viewer-original');
    this.actions = modal.querySelector('.photo-viewer-actions');
  }

  attachEventListeners() {
    // Close button
    this.closeButton.addEventListener('click', () => {
      this.close();
    });

    // Click overlay to close
    this.modal.querySelector('.photo-viewer-overlay').addEventListener('click', () => {
      this.close();
    });

    // Navigation buttons - attach to all prev/next buttons
    this.prevBtns.forEach(btn => {
      btn.addEventListener('click', () => this.showPrevious());
    });
    this.nextBtns.forEach(btn => {
      btn.addEventListener('click', () => this.showNext());
    });

    // Keyboard navigation (removed by destroy)
    this.onKeyDown = (e) => {
      if (!this.isOpen) return;

      switch (e.key) {
        case 'Escape':
          this.close();
          break;
        case 'ArrowLeft':
          this.showPrevious();
          break;
        case 'ArrowRight':
          this.showNext();
          break;
      }
    };
    document.addEventListener('keydown', this.onKeyDown);

    // Image load event
    this.image.addEventListener('load', () => {
      this.loading.style.display = 'none';
      this.image.style.opacity = '1';
    });

    this.image.addEventListener('error', () => {
      this.loading.textContent = 'Failed to load image';
    });
  }

  /**
   * Opens the viewer on a person's photos (person_record's `photos`), at `startIndex`, and moves focus into it.
   */
  open(personName, photos, startIndex = 0) {
    if (!this.isOpen) {
      const active = document.activeElement;
      this.opener = active && active !== document.body && !this.modal.contains(active) ? active : null;
    }
    this.personName = personName;
    this.photos = photos || [];
    this.isOpen = true;

    if (this.photos.length === 0) {
      this.photos = [{ key: null, message: 'No photos available' }];
    }
    const index = Number.isInteger(startIndex) ? startIndex : 0;
    this.currentIndex = Math.min(Math.max(index, 0), this.photos.length - 1);

    this.modal.setAttribute('aria-label', `Photos of ${nameOf({ name: personName })}`);
    this.modal.classList.add('photo-viewer-open');
    document.body.style.overflow = 'hidden'; // Prevent scrolling

    this.updateDisplay();
    this.closeButton.focus();
  }

  /**
   * Closes the viewer and gives focus back to the element that opened it, if it is still on the page.
   */
  close() {
    const opener = this.opener;
    this.hide();
    if (opener?.isConnected && !opener.closest('[hidden]')) opener.focus();
  }

  /**
   * Closes the viewer for an editor hook or a person link, without giving focus back: what opens next takes over.
   * Focus leaves the viewer, so a dialog opened next doesn't hand focus back to a hidden button.
   */
  hide() {
    this.isOpen = false;
    this.opener = null;
    this.modal.classList.remove('photo-viewer-open');
    document.body.style.overflow = ''; // Restore scrolling
    if (this.modal.contains(document.activeElement)) document.activeElement.blur();
  }

  /** Removes the viewer from the page and stops it listening for keys. */
  destroy() {
    if (this.isOpen) this.hide();
    document.removeEventListener('keydown', this.onKeyDown);
    this.modal.remove();
  }

  /**
   * Shows the editor actions (Caption, Avatar, People, Remove) under each photo, or none.
   * @param hooks  `{ onEdit(photo), onUseAsAvatar(photo), onRemove(photo) }`, or null for a viewer. Each is
   *               called after the viewer has closed; onRemove only once the editor has confirmed.
   */
  setEditorHooks(hooks) {
    this.editorHooks = hooks ?? null;
    if (this.isOpen) this.renderActions(this.photos[this.currentIndex]);
  }

  /**
   * Show previous photo
   */
  showPrevious() {
    if (this.photos.length <= 1) return;
    this.currentIndex = (this.currentIndex - 1 + this.photos.length) % this.photos.length;
    this.updateDisplay();
  }

  /**
   * Show next photo
   */
  showNext() {
    if (this.photos.length <= 1) return;
    this.currentIndex = (this.currentIndex + 1) % this.photos.length;
    this.updateDisplay();
  }

  /**
   * Update display with current photo
   */
  updateDisplay() {
    this.title.textContent = this.personName;
    this.counter.textContent = `Photo ${this.currentIndex + 1} of ${this.photos.length}`;

    const currentPhoto = this.photos[this.currentIndex];

    // Show/hide navigation buttons
    if (this.photos.length <= 1) {
      this.prevBtns.forEach(btn => btn.style.display = 'none');
      this.nextBtns.forEach(btn => btn.style.display = 'none');
    } else {
      this.prevBtns.forEach(btn => btn.style.display = 'flex');
      this.nextBtns.forEach(btn => btn.style.display = 'flex');
    }

    this.renderCaption(currentPhoto);
    this.renderActions(currentPhoto);

    // Handle no photo case
    if (!currentPhoto || !currentPhoto.key) {
      this.loading.style.display = 'flex';
      this.loading.textContent = currentPhoto?.message || 'No photo available';
      this.image.style.opacity = '0';
      this.image.src = '';
      this.filename.textContent = '';
      this.filename.title = '';
      this.downloadContainer.style.display = 'none';
      this.fileRow.hidden = true;
      return;
    }

    const fileName = currentPhoto.fileName ?? '';
    this.fileRow.hidden = false;
    this.filename.textContent = fileName;
    this.filename.title = fileName; // shown in full on hover: one line, shortened, fits beside the link

    // The display image, else (an image not yet backfilled) the original; a document has neither.
    const imageUrl = displayUrl(currentPhoto);

    if (imageUrl) {
      // Load new image
      this.loading.style.display = 'flex';
      this.loading.textContent = 'Loading...';
      this.image.style.opacity = '0';
      this.image.alt = currentPhoto.caption || `Photo ${this.currentIndex + 1}`;
      this.image.src = imageUrl;
      this.downloadContainer.style.display = 'none';
      this.originalLink.hidden = false;
      this.originalLink.href = mediaUrl(currentPhoto.key);
    } else {
      // Show download button for non-image files
      this.image.style.opacity = '0';
      this.image.src = '';
      this.loading.style.display = 'none';
      this.downloadContainer.style.display = 'flex';
      this.downloadFilename.textContent = fileName;
      this.downloadButton.href = mediaUrl(currentPhoto.key);
      this.downloadButton.download = fileName;
      this.originalLink.hidden = true; // the panel is the download
    }
  }

  /** The caption, the date and a link to each person the photo is shown for; a photo from an older view has none. */
  renderCaption(photo) {
    const caption = photo?.caption ?? '';
    const date = photo?.date ?? '';
    const people = Array.isArray(photo?.people) ? photo.people.filter(someone => someone?.id) : [];

    this.caption.textContent = caption;
    this.caption.hidden = !caption;
    this.date.textContent = date;
    this.date.hidden = !date;
    this.peopleList.replaceChildren(...people.map(someone => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'photo-viewer-person';
      button.textContent = nameOf(someone);
      button.addEventListener('click', () => this.openPerson(someone.id));
      return button;
    }));
    this.people.hidden = people.length === 0;
    this.captionBlock.hidden = !caption && !date && people.length === 0;
  }

  /** The editor actions for `photo`, when there are editor hooks and the photo has an id to act on. */
  renderActions(photo) {
    const hooks = this.editorHooks;
    const buttons = [];
    if (hooks && photo?.key && hasId(photo)) {
      const name = nameOf({ name: this.personName });
      const canCrop = Boolean(photo.displayKey) && Boolean(import.meta.env.VITE_MEDIA_API_URL);
      for (const action of ACTIONS) {
        if (typeof hooks[action.hook] !== 'function') continue;
        if (action.name === 'avatar' && !canCrop) continue;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `photo-viewer-action photo-viewer-action-${action.name}`;
        button.dataset.action = action.name;
        button.innerHTML = `<svg ${ICON_ATTRIBUTES}>${action.icon}</svg>`; // literals only
        const label = document.createElement('span');
        label.textContent = action.label;
        button.append(label);
        if (action.name === 'avatar') button.setAttribute('aria-label', `Use as avatar for ${name}`);
        if (action.name === 'remove') button.setAttribute('aria-label', `Remove this photo from ${name}`);
        if (action.name === 'people') button.title = 'Who this photo is shown for';
        button.addEventListener('click', () => {
          if (action.name === 'remove') this.confirmRemove(photo);
          else this.runHook(action.hook, photo);
        });
        buttons.push(button);
      }
    }
    this.actions.replaceChildren(...buttons);
    this.actions.hidden = buttons.length === 0;
  }

  /** Closes the viewer, then opens `personId`. */
  openPerson(personId) {
    this.hide();
    callSafely(this.onOpenPerson, personId);
  }

  /** Closes the viewer, then calls the editor hook `name` with `photo`: its dialog opens over the page. */
  runHook(name, photo) {
    const hook = this.editorHooks?.[name];
    this.hide();
    callSafely(hook, photo);
  }

  /** Closes the viewer and asks first; Cancel goes back to the photo, with focus on Remove. */
  confirmRemove(photo) {
    const hook = this.editorHooks?.onRemove;
    const { personName, photos, currentIndex, opener } = this;
    this.hide();
    const question = `Remove this photo from ${nameOf({ name: personName })}? It stays for anyone else it's shown for.`;
    if (!window.confirm(question)) {
      this.open(personName, photos, currentIndex);
      this.opener = opener; // a plain close still goes back to what first opened the viewer
      this.modal.querySelector('.photo-viewer-action[data-action="remove"]')?.focus();
      return;
    }
    callSafely(hook, photo);
  }
}
