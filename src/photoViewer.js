/**
 * Full-screen photo viewer for viewing a person's photos
 */
export class PhotoViewer {
  constructor() {
    this.currentIndex = 0;
    this.photos = [];
    this.personName = '';
    this.isOpen = false;

    this.createViewer();
    this.attachEventListeners();
  }

  createViewer() {
    // Create modal overlay
    const modal = document.createElement('div');
    modal.id = 'photo-viewer';
    modal.className = 'photo-viewer';
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
            <button class="photo-viewer-nav photo-viewer-prev photo-viewer-nav-desktop" aria-label="Previous photo">‹</button>
            <div class="photo-viewer-image-container">
              <img class="photo-viewer-image" alt="Person photo" />
              <div class="photo-viewer-loading">Loading...</div>
              <div class="photo-viewer-download">
                <p class="photo-viewer-download-filename"></p>
                <p class="photo-viewer-download-message">This file cannot be displayed</p>
                <a class="photo-viewer-download-button" download>Download File</a>
              </div>
            </div>
            <button class="photo-viewer-nav photo-viewer-next photo-viewer-nav-desktop" aria-label="Next photo">›</button>
          </div>
          <div class="photo-viewer-nav-mobile">
            <button class="photo-viewer-nav photo-viewer-prev" aria-label="Previous photo">‹</button>
            <button class="photo-viewer-nav photo-viewer-next" aria-label="Next photo">›</button>
          </div>
        </div>
        <div class="photo-viewer-footer">
          <p class="photo-viewer-filename"></p>
        </div>
      </div>
    `;

    document.body.appendChild(modal);
    this.modal = modal;
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
  }

  attachEventListeners() {
    // Close button
    this.modal.querySelector('.photo-viewer-close').addEventListener('click', () => {
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

    // Keyboard navigation
    document.addEventListener('keydown', (e) => {
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
    });

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
   * Open viewer with person's photos
   */
  open(personName, photos) {
    this.personName = personName;
    this.photos = photos || [];
    this.currentIndex = 0;
    this.isOpen = true;

    if (this.photos.length === 0) {
      this.photos = [{ path: null, message: 'No photos available' }];
    }

    this.modal.classList.add('photo-viewer-open');
    document.body.style.overflow = 'hidden'; // Prevent scrolling

    this.updateDisplay();
  }

  /**
   * Close viewer
   */
  close() {
    this.isOpen = false;
    this.modal.classList.remove('photo-viewer-open');
    document.body.style.overflow = ''; // Restore scrolling
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

    // Handle no photo case
    if (!currentPhoto || !currentPhoto.path) {
      this.loading.style.display = 'flex';
      this.loading.textContent = currentPhoto?.message || 'No photo available';
      this.image.style.opacity = '0';
      this.image.src = '';
      this.filename.textContent = '';
      this.downloadContainer.style.display = 'none';
      return;
    }

    // Extract filename from path
    const pathParts = currentPhoto.path.split('/');
    const fileName = pathParts[pathParts.length - 1];
    this.filename.textContent = fileName;

    // Check if file is an image
    const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg'];
    const fileExtension = fileName.toLowerCase().substring(fileName.lastIndexOf('.'));
    const isImage = imageExtensions.includes(fileExtension);

    if (isImage) {
      // Load new image
      this.loading.style.display = 'flex';
      this.loading.textContent = 'Loading...';
      this.image.style.opacity = '0';
      this.image.src = `${import.meta.env.BASE_URL}${currentPhoto.path}`;
      this.downloadContainer.style.display = 'none';
    } else {
      // Show download button for non-image files
      this.image.style.opacity = '0';
      this.image.src = '';
      this.loading.style.display = 'none';
      this.downloadContainer.style.display = 'flex';
      this.downloadFilename.textContent = fileName;
      this.downloadButton.href = `${import.meta.env.BASE_URL}${currentPhoto.path}`;
      this.downloadButton.download = fileName;
    }
  }
}
