import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  MIN_CROP_PX, createAvatarCropper, toFractions, fromFractions, defaultCrop, zoomLimits, sliderValue, sliderRatio
} from '../src/avatarCropper.js';
import { MIN_SIDE_PX, cropPixels } from '../media/crop.js';

const fake = vi.hoisted(() => ({ croppers: [] }));

vi.mock('cropperjs', () => ({
  /**
   * A stand-in for Cropper.js 1.7.0, since jsdom has no layout: a 400 x 300 area showing a 2000 x 1000 photo
   * fitted to it (400 x 200, centred), under a 160px circle (80% of its height), as Cropper.js starts. Its methods
   * move the canvas as Cropper's do and fire `crop` after each change; zoomTo fires `zoom` first, which may cancel it.
   */
  default: class FakeCropper {
    constructor(image, options) {
      this.image = image;
      this.options = options;
      this.natural = { naturalWidth: 2000, naturalHeight: 1000 };
      this.container = { width: 400, height: 300 };
      this.canvas = { left: 0, top: 50, width: 400, height: 200 };
      this.box = { left: 120, top: 70, width: 160, height: 160 };
      this.destroyed = false;
      fake.croppers.push(this);
    }

    /** The photo has loaded. */
    load() {
      this.options.ready.call(this.image, new CustomEvent('ready'));
    }

    changed() {
      this.options.crop?.call(this.image, new CustomEvent('crop'));
    }

    getImageData() {
      return { ...this.natural };
    }

    getCanvasData() {
      return { ...this.canvas, ...this.natural };
    }

    getCropBoxData() {
      return { ...this.box };
    }

    getData(rounded = false) {
      const scale = this.canvas.width / this.natural.naturalWidth;
      const data = {
        x: (this.box.left - this.canvas.left) / scale,
        y: (this.box.top - this.canvas.top) / scale,
        width: this.box.width / scale,
        height: this.box.height / scale
      };
      if (rounded) for (const key of Object.keys(data)) data[key] = Math.round(data[key]);
      return data;
    }

    setCanvasData({ left, top, width }) {
      this.canvas = { left, top, width, height: (width * this.natural.naturalHeight) / this.natural.naturalWidth };
      this.changed();
      return this;
    }

    /** Zooms about the middle of the area (zoomAroundCenter), as the wheel, pinching and zoomTo do. */
    zoomTo(ratio) {
      const event = new CustomEvent('zoom', {
        cancelable: true, detail: { ratio, oldRatio: this.canvas.width / this.natural.naturalWidth }
      });
      this.options.zoom?.call(this.image, event);
      if (event.defaultPrevented) return this;
      const width = this.natural.naturalWidth * ratio;
      const height = this.natural.naturalHeight * ratio;
      const middle = { x: this.container.width / 2, y: this.container.height / 2 };
      this.canvas = {
        left: middle.x - ((middle.x - this.canvas.left) * width) / this.canvas.width,
        top: middle.y - ((middle.y - this.canvas.top) * height) / this.canvas.height,
        width,
        height
      };
      this.changed();
      return this;
    }

    move(x, y) {
      this.canvas = { ...this.canvas, left: this.canvas.left + x, top: this.canvas.top + y };
      this.changed();
      return this;
    }

    destroy() {
      this.destroyed = true;
      return this;
    }
  }
}));

/** Whether every value of `actual` is within `tolerance` of the same key in `expected`. */
function expectClose(actual, expected, tolerance) {
  expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
  for (const key of Object.keys(expected)) expect(Math.abs(actual[key] - expected[key])).toBeLessThanOrEqual(tolerance);
}

const decimals = (n) => (String(n).split('.')[1] ?? '').length;

describe('toFractions', () => {
  it("turns Cropper's crop in pixels of the loaded image into fractions of its size", () => {
    expect(toFractions({ x: 400, y: 150, width: 1000, height: 1000 }, 2000, 1500))
      .toEqual({ x: 0.2, y: 0.1, w: 0.5, h: 0.6667 });
  });

  it('rounds every fraction to 4 decimal places', () => {
    const crop = toFractions({ x: 333, y: 77, width: 777, height: 777 }, 1999, 1333);
    for (const value of Object.values(crop)) expect(decimals(value)).toBeLessThanOrEqual(4);
    expect(crop).toEqual({ x: 0.1666, y: 0.0578, w: 0.3887, h: 0.5829 });
  });

  it("keeps the crop square: a side made a pixel longer by Cropper's rounding takes the shorter", () => {
    expect(toFractions({ x: 10, y: 20, width: 101, height: 100 }, 1000, 500)).toEqual({ x: 0.01, y: 0.04, w: 0.1, h: 0.2 });
    expect(toFractions({ x: 10, y: 20, width: 100, height: 101 }, 1000, 500)).toEqual({ x: 0.01, y: 0.04, w: 0.1, h: 0.2 });
  });

  it('gives crops the server accepts, down to the smallest the cropper allows, from any size of original', () => {
    let seed = 7;
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 5000; i++) {
      // A display image up to 2000px, and Cropper's getData(): unrounded and square.
      const width = 200 + Math.floor(random() * 1801);
      const height = 200 + Math.floor(random() * 1801);
      const side = i % 5 === 0 ? MIN_CROP_PX : MIN_CROP_PX + random() * (Math.min(width, height) - MIN_CROP_PX);
      const crop = toFractions({ x: random() * (width - side), y: random() * (height - side), width: side, height: side }, width, height);
      // The original is the display image's size or larger, with the same shape give or take its rounding.
      for (const scale of [1, 1.5, 3.0237]) {
        const { size } = cropPixels(crop, Math.round(width * scale), Math.round(height * scale)); // throws if refused
        expect(size).toBeGreaterThanOrEqual(MIN_SIDE_PX);
      }
    }
  });

  it('never goes past the right or bottom edge by more than rounding', () => {
    const crop = toFractions({ x: 1001, y: 0, width: 999, height: 999 }, 2000, 999);
    expect(crop.x + crop.w).toBeLessThanOrEqual(1.0001);
    expect(crop.y + crop.h).toBeLessThanOrEqual(1.0001);
  });

  it('turns -0 into 0, and clamps a crop starting a hair outside the image to the edge', () => {
    expect(toFractions({ x: -0, y: -0.4, width: 50, height: 50 }, 100, 100)).toEqual({ x: 0, y: 0, w: 0.5, h: 0.5 });
    expect(Object.is(toFractions({ x: -0, y: 0, width: 50, height: 50 }, 100, 100).x, 0)).toBe(true);
  });
});

describe('fromFractions', () => {
  it('turns fractions back into pixels of an image', () => {
    expect(fromFractions({ x: 0.2, y: 0.1, w: 0.5, h: 0.6 }, 2000, 1500)).toEqual({ x: 400, y: 150, width: 1000, height: 900 });
  });

  it('round-trips toFractions to within a pixel, at any size of the same photo', () => {
    const pixels = { x: 333, y: 77, width: 777, height: 777 };
    const crop = toFractions(pixels, 1999, 1333);
    expectClose(fromFractions(crop, 1999, 1333), pixels, 0.2);
    // The same crop of the original, three times the size of the display image.
    expectClose(fromFractions(crop, 5997, 3999), { x: 999, y: 231, width: 2331, height: 2331 }, 0.6);
  });
});

describe('defaultCrop', () => {
  it('is a centred square of 80% of the shorter side, as fractions: landscape', () => {
    expect(defaultCrop(2000, 1000)).toEqual({ x: 0.3, y: 0.1, w: 0.4, h: 0.8 });
  });

  it('is a centred square of 80% of the shorter side, as fractions: portrait and square', () => {
    expect(defaultCrop(1000, 2000)).toEqual({ x: 0.1, y: 0.3, w: 0.8, h: 0.4 });
    expect(defaultCrop(500, 500)).toEqual({ x: 0.1, y: 0.1, w: 0.8, h: 0.8 });
  });

  it('is square in pixels', () => {
    const crop = defaultCrop(1999, 1333);
    const { width, height } = fromFractions(crop, 1999, 1333);
    expect(Math.abs(width - height)).toBeLessThan(0.2);
  });
});

describe('zoomLimits', () => {
  it("stops zooming in short of the server's smallest crop, leaving room for rounding", () => {
    expect(MIN_CROP_PX).toBeGreaterThanOrEqual(MIN_SIDE_PX + 2);
  });

  it('zooms out until the photo just covers the circle, and in until the circle covers MIN_CROP_PX pixels of it', () => {
    // A 300px circle over a 2000 x 1500 photo: its 1500px height must cover the circle.
    expect(zoomLimits({ width: 300, height: 300 }, 2000, 1500)).toEqual({ min: 0.2, max: 300 / MIN_CROP_PX });
    expect(zoomLimits({ width: 300, height: 300 }, 1500, 2000)).toEqual({ min: 0.2, max: 300 / MIN_CROP_PX });
  });

  it('never lets the most zoomed in be less than the least, for a photo too small to zoom into', () => {
    const { min, max } = zoomLimits({ width: 300, height: 300 }, 30, 20);
    expect(min).toBe(15);
    expect(max).toBe(15);
  });
});

describe('sliderValue and sliderRatio', () => {
  it('map the zoom ratio onto 0..100, evenly in steps of the same factor', () => {
    expect(sliderValue(0.2, 0.2, 20)).toBe(0);
    expect(sliderValue(20, 0.2, 20)).toBe(100);
    expect(sliderValue(2, 0.2, 20)).toBeCloseTo(50, 10);
    expect(sliderRatio(50, 0.2, 20)).toBeCloseTo(2, 10);
    expect(sliderRatio(0, 0.2, 20)).toBeCloseTo(0.2, 10);
    expect(sliderRatio(100, 0.2, 20)).toBeCloseTo(20, 10);
  });

  it('are inverses', () => {
    for (const value of [0, 12.5, 33, 99.9]) expect(sliderValue(sliderRatio(value, 0.15, 7), 0.15, 7)).toBeCloseTo(value, 10);
  });

  it('clamp to the ends, and sit at 0 when there is no room to zoom', () => {
    expect(sliderValue(0.1, 0.2, 20)).toBe(0);
    expect(sliderValue(30, 0.2, 20)).toBe(100);
    expect(sliderValue(5, 5, 5)).toBe(0);
    expect(sliderRatio(70, 5, 5)).toBe(5);
    expect(sliderRatio(-5, 0.2, 20)).toBeCloseTo(0.2, 10);
    expect(sliderRatio(150, 0.2, 20)).toBeCloseTo(20, 10);
  });
});

describe('createAvatarCropper', () => {
  // The fake's 160px circle over its 2000 x 1000 photo.
  const LIMITS = zoomLimits({ width: 160, height: 160 }, 2000, 1000);
  let made;
  let frames;

  beforeEach(() => {
    document.body.innerHTML = '';
    fake.croppers.length = 0;
    made = null;
    frames = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => frames.push(callback));
  });

  afterEach(() => {
    made?.destroy();
    vi.restoreAllMocks();
  });

  /** Makes the cropper and puts it in the page, as the dialog does. → the fake Cropper.js, and the cropper's parts. */
  function create(options = {}) {
    made = createAvatarCropper({ imageUrl: 'https://media.test/bucket/display/a.webp', ...options });
    document.body.append(made.element);
    return {
      cropper: fake.croppers[fake.croppers.length - 1],
      area: made.element.querySelector('.avatar-cropper-area'),
      slider: made.element.querySelector('.avatar-zoom-slider'),
      status: made.element.querySelector('.avatar-cropper-status')
    };
  }

  const ratioOf = (cropper) => cropper.getCanvasData().width / 2000;
  const press = (target, key, init = {}) => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    return event;
  };
  const resize = () => window.dispatchEvent(new Event('resize'));

  it('sets Cropper.js up as a fixed circle over the display image', () => {
    const { cropper, area } = create();
    expect(cropper.image.getAttribute('src')).toBe('https://media.test/bucket/display/a.webp');
    expect(area.contains(cropper.image)).toBe(true);
    expect(cropper.options).toMatchObject({
      viewMode: 1, dragMode: 'move', aspectRatio: 1, autoCropArea: 0.8, cropBoxMovable: false, cropBoxResizable: false,
      toggleDragModeOnDblclick: false, restore: false, zoomAroundCenter: true, checkOrientation: false, checkCrossOrigin: false
    });
    expect(made.getCrop()).toBeNull(); // until the photo has loaded
  });

  it('reopens at a saved crop by moving and scaling the photo under the circle, and reads it back unrounded', () => {
    const onReady = vi.fn();
    const saved = { x: 0.3, y: 0.1, w: 0.2, h: 0.4 }; // 400 x 400 pixels of the photo
    const { cropper, slider, status } = create({ initialCrop: saved, onReady });
    const setCanvasData = vi.spyOn(cropper, 'setCanvasData');
    expect(slider.disabled).toBe(true);
    cropper.load();

    // The 160px circle shows 400px of the photo, so the photo is shown 800px wide.
    expect(setCanvasData).toHaveBeenCalledTimes(1);
    const [{ left, top, width }] = setCanvasData.mock.calls[0];
    expect(left).toBeCloseTo(120 - 0.3 * 800, 9);
    expect(top).toBeCloseTo(70 - 0.1 * 400, 9);
    expect(width).toBeCloseTo(800, 9);
    const getData = vi.spyOn(cropper, 'getData');
    expect(made.getCrop()).toEqual(saved);
    expect(getData).toHaveBeenCalledWith();
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(status.hidden).toBe(true);
    expect(slider.disabled).toBe(false);
    expect(Number(slider.value)).toBeCloseTo(sliderValue(0.4, LIMITS.min, LIMITS.max), 9);
    expect(slider.getAttribute('aria-valuetext')).toBe('Zoom 250%');
  });

  it('starts from a centred square of 80% of the shorter side without a usable saved crop', () => {
    for (const initialCrop of [null, { x: 0.1, y: 0.1, w: 0, h: 0.2 }]) {
      const { cropper, slider } = create({ initialCrop });
      const setCanvasData = vi.spyOn(cropper, 'setCanvasData');
      cropper.load();
      const [{ left, top, width }] = setCanvasData.mock.calls[0];
      expect([left, top, width].map((n) => Math.round(n * 1e6) / 1e6)).toEqual([0, 50, 400]);
      expect(made.getCrop()).toEqual(defaultCrop(2000, 1000));
      expect(slider.getAttribute('aria-valuetext')).toBe('Zoom 125%');
      made.destroy();
    }
  });

  it('moves the photo with the arrow keys, and zooms with + and − about the circle', () => {
    const { cropper, area } = create();
    cropper.load();
    const move = vi.spyOn(cropper, 'move');
    const zoomTo = vi.spyOn(cropper, 'zoomTo');
    expect(press(area, 'ArrowLeft').defaultPrevented).toBe(true);
    press(area, 'ArrowRight');
    press(area, 'ArrowUp');
    press(area, 'ArrowDown');
    expect(move.mock.calls).toEqual([[-10, 0], [10, 0], [0, -10], [0, 10]]);

    expect(press(area, '+').defaultPrevented).toBe(true);
    expect(zoomTo.mock.calls[0]).toEqual([expect.closeTo(0.2 * 1.1, 9)]); // no pivot: zoomAroundCenter
    press(area, '-');
    expect(ratioOf(cropper)).toBeCloseTo(0.2, 9);
    press(area, '=');
    expect(ratioOf(cropper)).toBeCloseTo(0.22, 9);
  });

  it("leaves keys alone before the photo has loaded, with a modifier (the browser's zoom), or that it doesn't use", () => {
    const { cropper, area } = create();
    const move = vi.spyOn(cropper, 'move');
    const zoomTo = vi.spyOn(cropper, 'zoomTo');
    expect(press(area, 'ArrowLeft').defaultPrevented).toBe(false);
    cropper.load();
    expect(press(area, '+', { metaKey: true }).defaultPrevented).toBe(false);
    expect(press(area, '-', { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(press(area, 'a').defaultPrevented).toBe(false);
    expect(move).not.toHaveBeenCalled();
    expect(zoomTo).not.toHaveBeenCalled();
  });

  it("zooms to the slider's value, within the limits, without moving the slider under the pointer", () => {
    const { cropper, slider } = create();
    cropper.load();
    const zoomTo = vi.spyOn(cropper, 'zoomTo');
    slider.value = '50';
    slider.dispatchEvent(new Event('input'));
    const ratio = sliderRatio(50, LIMITS.min, LIMITS.max);
    expect(zoomTo).toHaveBeenCalledWith(expect.closeTo(ratio, 9));
    expect(slider.value).toBe('50');
    expect(slider.getAttribute('aria-valuetext')).toBe(`Zoom ${Math.round((100 * ratio) / LIMITS.min)}%`);

    // All the way in, the crop is still one the server takes.
    slider.value = '100';
    slider.dispatchEvent(new Event('input'));
    expect(ratioOf(cropper)).toBeCloseTo(LIMITS.max, 9);
    expect(cropPixels(made.getCrop(), 2000, 1000).size).toBeGreaterThanOrEqual(MIN_SIDE_PX);
  });

  it('zooms with the − and + buttons', () => {
    const { cropper } = create();
    cropper.load();
    made.element.querySelector('.avatar-zoom-in').click();
    expect(ratioOf(cropper)).toBeCloseTo(0.22, 9);
    made.element.querySelector('.avatar-zoom-out').click();
    expect(ratioOf(cropper)).toBeCloseTo(0.2, 9);
  });

  it('stops a pinch or wheel step that would pass the limit at the limit, and keeps the slider in step', () => {
    const { cropper, slider } = create();
    cropper.load();
    cropper.zoomTo(LIMITS.max * 0.95); // as the wheel and pinching do
    expect(ratioOf(cropper)).toBeCloseTo(LIMITS.max * 0.95, 9);
    cropper.zoomTo(LIMITS.max * 1.2);
    expect(ratioOf(cropper)).toBeCloseTo(LIMITS.max, 9);
    expect(slider.value).toBe('100');
    cropper.zoomTo(LIMITS.max * 1.5);
    expect(ratioOf(cropper)).toBeCloseTo(LIMITS.max, 9);
    cropper.zoomTo(LIMITS.min); // zooming out is Cropper's to limit
    expect(ratioOf(cropper)).toBeCloseTo(LIMITS.min, 9);
    expect(slider.value).toBe('0');
  });

  it('puts the crop back after the area changes size, however many resizes come before the next frame', () => {
    const { cropper } = create();
    cropper.load();
    cropper.move(-30, 10);
    const before = made.getCrop();
    resize();
    // Cropper.js (restore: false) resets to its start, and the window can say it resized again before a frame.
    cropper.canvas = { left: 0, top: 50, width: 400, height: 200 };
    resize();
    expect(frames).toHaveLength(1);
    frames[0]();
    expect(made.getCrop()).toEqual(before);
    resize(); // the next resize takes the crop again
    expect(frames).toHaveLength(2);
  });

  it('stops listening to the window once taken off the page without being destroyed', () => {
    const { cropper } = create();
    cropper.load();
    const removeListener = vi.spyOn(window, 'removeEventListener');
    made.element.remove();
    resize();
    expect(cropper.destroyed).toBe(true);
    expect(removeListener).toHaveBeenCalledWith('resize', expect.any(Function));
    resize();
    expect(frames).toHaveLength(0);
  });

  it('destroy takes Cropper.js down, stops listening to the window and removes the element', () => {
    const addListener = vi.spyOn(window, 'addEventListener');
    const removeListener = vi.spyOn(window, 'removeEventListener');
    const { cropper } = create();
    cropper.load();
    const [, onResize] = addListener.mock.calls.find(([type]) => type === 'resize');
    made.destroy();
    expect(cropper.destroyed).toBe(true);
    expect(removeListener).toHaveBeenCalledWith('resize', onResize);
    expect(made.element.isConnected).toBe(false);
    expect(made.getCrop()).toBeNull();
    made.destroy(); // again is harmless
  });

  it("says so when the photo won't load", () => {
    const onError = vi.fn();
    const { cropper, status } = create({ onError });
    cropper.image.dispatchEvent(new Event('error'));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(status.hidden).toBe(false);
    expect(status.textContent).toBe("Couldn't load the photo.");
  });
});
