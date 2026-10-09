import { describe, it, expect, beforeEach } from 'vitest';
import { openDialogBackdrops, isTopmostDialog } from '../src/dialogStack.js';

function backdrop(zIndex) {
  const element = document.createElement('div');
  element.className = 'editor-dialog-backdrop';
  if (zIndex !== undefined) element.style.zIndex = String(zIndex);
  document.body.appendChild(element);
  return element;
}

describe('dialogStack', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('orders visible backdrops by z-index, then document order', () => {
    const signIn = backdrop(10550);
    const editor = backdrop(10500);
    const later = backdrop(10500);
    expect(openDialogBackdrops()).toEqual([editor, later, signIn]);
    expect(isTopmostDialog(signIn)).toBe(true);
    expect(isTopmostDialog(later)).toBe(false);
  });

  it('skips hidden backdrops', () => {
    const editor = backdrop();
    const signIn = backdrop(10550);
    signIn.hidden = true;
    expect(openDialogBackdrops()).toEqual([editor]);
    expect(isTopmostDialog(editor)).toBe(true);
    editor.hidden = true;
    expect(isTopmostDialog(editor)).toBe(false);
  });
});
