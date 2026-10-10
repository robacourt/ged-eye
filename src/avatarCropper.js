/**
 * The avatar cropper: Cropper.js set up as a fixed circle with the photo moved and zoomed underneath it, by dragging,
 * pinching, the mouse wheel, a zoom slider, or the keyboard (arrow keys move, + and − zoom). It works on the
 * display image, and returns the crop as fractions of it, which carry over to the original because the display
 * image has the original's (oriented) shape.
 *
 * Imported only by the editing chunk, so viewers never download Cropper.js.
 */
import Cropper from 'cropperjs';
import 'cropperjs/dist/cropper.css';
import { el, uniqueId } from './editorDialog.js';

/**
 * How far in the photo may be zoomed: until the circle covers this many pixels of the display image. The media
 * Function refuses a crop under 32 pixels of the original (MIN_SIDE_PX in media/crop.js, which can't be imported
 * here: it needs node:crypto). The original is at least as big as the display image, and 2 more pixels leave room
 * for rounding the crop's fractions.
 */
export const MIN_CROP_PX = 34;
/** How far an arrow key moves the photo, in screen pixels, and how much + and − zoom by (as Cropper's zoom(0.1)). */
const MOVE_STEP = 10;
const ZOOM_STEP = 0.1;

const round4 = (n) => Math.round(n * 10_000) / 10_000 + 0; // + 0 turns -0 into 0
const clamp = (n, low, high) => Math.min(Math.max(n, low), high);

/**
 * Cropper's `getData()` (`{ x, y, width, height }` in pixels of the loaded image, `naturalWidth` x
 * `naturalHeight`) as fractions `{ x, y, w, h }` of it, each rounded to 4 decimal places. The crop box is square,
 * so a side that came out longer (by a rounding error, or a pixel from `getData(true)`) takes the shorter's length.
 */
export function toFractions({ x, y, width, height }, naturalWidth, naturalHeight) {
  const side = Math.min(width, height);
  return {
    x: round4(Math.max(0, x) / naturalWidth),
    y: round4(Math.max(0, y) / naturalHeight),
    w: round4(side / naturalWidth),
    h: round4(side / naturalHeight)
  };
}

/** The inverse of toFractions: a crop `{ x, y, w, h }` as `{ x, y, width, height }` in pixels of a width x height image. */
export function fromFractions({ x, y, w, h }, naturalWidth, naturalHeight) {
  return { x: x * naturalWidth, y: y * naturalHeight, width: w * naturalWidth, height: h * naturalHeight };
}

/** The crop to start from with no saved one: a centred square of 80% of the shorter side, as fractions. */
export function defaultCrop(width, height) {
  const side = 0.8 * Math.min(width, height);
  return toFractions({ x: (width - side) / 2, y: (height - side) / 2, width: side, height: side }, width, height);
}

/**
 * How far the photo (`naturalWidth` x `naturalHeight`) may zoom under the crop box `{ width, height }`, as
 * Cropper's ratio (shown width / natural width): out until it just covers the box, as viewMode 1 allows, and in
 * until the box covers MIN_CROP_PX of its pixels. → `{ min, max }`, with max never below min.
 */
export function zoomLimits(box, naturalWidth, naturalHeight) {
  const min = Math.max(box.width / naturalWidth, box.height / naturalHeight);
  return { min, max: Math.max(min, box.width / MIN_CROP_PX) };
}

/** The slider's 0..100 for the zoom `ratio`, between `min` and `max` on a log scale, so each step zooms by the same factor. */
export function sliderValue(ratio, min, max) {
  if (!(max > min)) return 0;
  return clamp((100 * Math.log(ratio / min)) / Math.log(max / min), 0, 100);
}

/** The zoom ratio for the slider's `value`: sliderValue's inverse. */
export function sliderRatio(value, min, max) {
  if (!(max > min)) return min;
  return min * (max / min) ** (clamp(value, 0, 100) / 100);
}

/** Whether `crop` is a usable `{ x, y, w, h }` of fractions to reopen at. */
const isCrop = (crop) => Boolean(crop) &&
  ['x', 'y', 'w', 'h'].every((key) => Number.isFinite(crop[key])) && crop.w > 0 && crop.h > 0;

/**
 * Makes the cropper. Put `element` in the page straight away (before the photo loads): Cropper.js sizes itself
 * to it then. Its crop area is `.avatar-cropper-area`, sized by editingStyles.css.
 * @param imageUrl     the photo's display image (media.js displayUrl)
 * @param initialCrop  the saved crop `{ x, y, w, h }` to reopen at (person.avatarSource.crop), or null for the default
 * @param onReady      () once the photo has loaded and the crop can be read
 * @param onError      () when the photo can't be loaded
 * @returns `{ element, getCrop, destroy }`: `getCrop()` → the crop as fractions (toFractions), or null before
 *          it's ready; `destroy()` takes Cropper.js down and removes `element`.
 */
export function createAvatarCropper({ imageUrl, initialCrop = null, onReady, onError }) {
  const hintId = uniqueId('avatar-cropper-hint');
  const image = el('img', { class: 'avatar-cropper-image', src: imageUrl, alt: 'The photo to crop' });
  const status = el('p', { class: 'avatar-cropper-status', role: 'status', text: 'Loading the photo…' });
  // role=application: the arrow keys move the photo here, rather than the screen reader's cursor.
  const area = el('div', {
    class: 'avatar-cropper-area', tabindex: '0', role: 'application', 'aria-label': 'Avatar crop', 'aria-describedby': hintId
  }, image, status);
  const hint = el('p', {
    class: 'editor-hint avatar-cropper-hint', id: hintId,
    text: 'Drag the photo to fit the circle, and pinch, scroll or use the slider to zoom. ' +
      'With a keyboard, the arrow keys move it and + and − zoom.'
  });
  const zoomOut = el('button', { type: 'button', class: 'editor-btn avatar-zoom-out', 'aria-label': 'Zoom out', text: '−' });
  const zoomIn = el('button', { type: 'button', class: 'editor-btn avatar-zoom-in', 'aria-label': 'Zoom in', text: '+' });
  const slider = el('input', {
    type: 'range', class: 'avatar-zoom-slider', min: '0', max: '100', step: 'any', value: '0', 'aria-label': 'Zoom', disabled: true
  });
  const element = el('div', { class: 'avatar-cropper' }, area, hint, el('div', { class: 'avatar-zoom' }, zoomOut, slider, zoomIn));

  let ready = false;
  let destroyed = false;
  let sliding = false; // the slider is zooming, so it mustn't be moved under the pointer
  let pendingCrop = null; // the crop to put back after a resize, until the next frame does

  /** The zoom ratio's limits for the current crop box (see zoomLimits). */
  function limits() {
    const { naturalWidth, naturalHeight } = cropper.getCanvasData();
    return zoomLimits(cropper.getCropBoxData(), naturalWidth, naturalHeight);
  }

  const ratio = () => {
    const canvas = cropper.getCanvasData();
    return canvas.width / canvas.naturalWidth;
  };

  /** Zooms to `target` within the limits, about the circle (zoomAroundCenter: it sits in the middle). */
  function zoomTo(target) {
    const { min, max } = limits();
    cropper.zoomTo(clamp(target, min, max));
  }

  /** Zooms in (positive `step`) or out, as Cropper's zoom(step) does. */
  const zoomBy = (step) => zoomTo(ratio() * (step > 0 ? 1 + step : 1 / (1 - step)));

  /** Says the zoom as a percentage of the least, where the photo just covers the circle. */
  function describeZoom() {
    slider.setAttribute('aria-valuetext', `Zoom ${Math.round((100 * ratio()) / limits().min)}%`);
  }

  /** Shows the current zoom on the slider: after every change, whether from pinching, the wheel or a resize. */
  function syncSlider() {
    if (!ready) return;
    describeZoom();
    if (sliding) return;
    const { min, max } = limits();
    slider.value = String(sliderValue(ratio(), min, max));
  }

  /** Moves and scales the photo under the fixed circle so the circle shows `crop` (fractions). */
  function placeAt(crop) {
    const box = cropper.getCropBoxData();
    const nat = cropper.getImageData();
    const width = box.width / crop.w;
    const height = (width * nat.naturalHeight) / nat.naturalWidth;
    cropper.setCanvasData({ left: box.left - crop.x * width, top: box.top - crop.y * height, width });
  }

  const cropper = new Cropper(image, {
    viewMode: 1,
    dragMode: 'move',
    aspectRatio: 1,
    autoCropArea: 0.8,
    cropBoxMovable: false,
    cropBoxResizable: false,
    toggleDragModeOnDblclick: false,
    guides: false,
    center: false,
    highlight: false,
    background: false,
    restore: false,
    // The circle sits in the middle, so the wheel and pinching zoom about it, keeping what's in it in view.
    zoomAroundCenter: true,
    // Display images are already upright; checking would download the photo again through XHR.
    checkOrientation: false,
    // The canvas is never read, so the photo needn't be fetched again with CORS (and a cache-busting query).
    checkCrossOrigin: false,
    ready() {
      if (destroyed) return;
      const nat = cropper.getImageData();
      placeAt(isCrop(initialCrop) ? initialCrop : defaultCrop(nat.naturalWidth, nat.naturalHeight));
      ready = true;
      status.hidden = true;
      slider.disabled = false;
      // setCanvasData fires no zoom event, so the slider is set here.
      syncSlider();
      onReady?.();
    },
    zoom(event) {
      // A pinch or wheel step that would zoom in past the limit stops at it instead.
      if (!ready) return;
      const { ratio: next, oldRatio } = event.detail;
      const { max } = limits();
      if (!(next > oldRatio && next > max * (1 + 1e-9))) return;
      event.preventDefault();
      if (oldRatio < max) cropper.zoomTo(max); // fires this again, at the limit, which lets it through
    },
    crop: syncSlider
  });

  // With `restore: false`, Cropper.js resets the crop when its area changes size (a phone turned round). This
  // listener is added before Cropper's own (which it adds once the photo loads; Cropper.js is pinned to 1.7.0 for
  // that order), so it sees the crop first, and puts it back before the next frame is drawn. Until then, later
  // resizes keep the crop already taken: by then Cropper.js has reset it.
  function onResize() {
    if (!element.isConnected) {
      destroy(); // taken off the page without being destroyed: stop listening to the window
      return;
    }
    if (!ready || destroyed || pendingCrop) return;
    const { naturalWidth, naturalHeight } = cropper.getImageData();
    pendingCrop = toFractions(cropper.getData(), naturalWidth, naturalHeight);
    requestAnimationFrame(() => {
      const crop = pendingCrop;
      pendingCrop = null;
      if (destroyed || !crop) return;
      placeAt(crop);
      syncSlider();
    });
  }
  window.addEventListener('resize', onResize);

  image.addEventListener('error', () => {
    if (destroyed || ready) return;
    status.textContent = "Couldn't load the photo.";
    onError?.();
  }, { once: true });

  slider.addEventListener('input', () => {
    if (!ready) return;
    const { min, max } = limits();
    sliding = true;
    try {
      zoomTo(sliderRatio(Number(slider.value), min, max));
    } finally {
      sliding = false;
    }
  });
  zoomOut.addEventListener('click', () => ready && zoomBy(-ZOOM_STEP));
  zoomIn.addEventListener('click', () => ready && zoomBy(ZOOM_STEP));

  const MOVES = {
    ArrowLeft: [-MOVE_STEP, 0], ArrowRight: [MOVE_STEP, 0], ArrowUp: [0, -MOVE_STEP], ArrowDown: [0, MOVE_STEP]
  };
  const ZOOMS = { '+': ZOOM_STEP, '=': ZOOM_STEP, '-': -ZOOM_STEP, _: -ZOOM_STEP, '−': -ZOOM_STEP };
  area.addEventListener('keydown', (event) => {
    if (!ready || event.ctrlKey || event.metaKey || event.altKey) return; // leave the browser's own zoom alone
    if (MOVES[event.key]) cropper.move(...MOVES[event.key]);
    else if (ZOOMS[event.key]) zoomBy(ZOOMS[event.key]);
    else return;
    event.preventDefault();
  });

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    pendingCrop = null;
    window.removeEventListener('resize', onResize);
    cropper.destroy(); // and Cropper.js's own listeners
    element.remove();
  }

  return {
    element,
    getCrop() {
      if (!ready || destroyed) return null;
      const { naturalWidth, naturalHeight } = cropper.getImageData();
      // Unrounded: getData(true) can make a side a pixel shorter, which matters at the smallest crops.
      return toFractions(cropper.getData(), naturalWidth, naturalHeight);
    },
    destroy
  };
}
