import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { showToast } from '../src/toast.js';

const XSS = '<img src=x onerror="window.__xss = 1">';
const toasts = () => [...document.querySelectorAll('.toast')];
const messages = () => toasts().map(t => t.querySelector('.toast-message').textContent);

describe('showToast', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fills in the message as text just after adding the toast to a polite live region', () => {
    showToast(XSS);
    const [toast] = toasts();
    const region = document.querySelector('.toast-container');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.contains(toast)).toBe(true);
    expect(toast.getAttribute('role')).toBeNull(); // no live region inside a live region
    expect(toast.querySelector('.toast-message').textContent).toBe('');
    vi.advanceTimersByTime(0);
    expect(toast.querySelector('.toast-message').textContent).toBe(XSS);
    expect(document.querySelector('img')).toBeNull();
  });

  it('puts errors in an alert region', () => {
    showToast('Couldn\'t reach the server.', { kind: 'error' });
    const [toast] = toasts();
    const region = document.querySelector('.toast-alerts');
    expect(region.getAttribute('role')).toBe('alert');
    expect(region.getAttribute('aria-live')).toBe('assertive');
    expect(region.contains(toast)).toBe(true);
    expect(toast.classList.contains('toast-error')).toBe(true);
  });

  it('creates the live regions once, on the body, and keeps them when empty', () => {
    const { dismiss } = showToast('One');
    showToast('Two', { kind: 'error' });
    showToast('Three');
    vi.advanceTimersByTime(0);
    expect(document.querySelectorAll('.toast-stack')).toHaveLength(1);
    expect(document.querySelector('.toast-stack').parentElement).toBe(document.body);
    expect(messages()).toEqual(['One', 'Three', 'Two']);
    dismiss();
    const region = document.querySelector('.toast-container');
    vi.advanceTimersByTime(10_000);
    expect(toasts()).toHaveLength(0);
    expect(region.isConnected).toBe(true);
    showToast('Four');
    expect(document.querySelector('.toast-container')).toBe(region);
  });

  it('recreates the regions if the page replaced the body', () => {
    showToast('One');
    document.body.innerHTML = '';
    showToast('Two');
    vi.advanceTimersByTime(0);
    expect(messages()).toEqual(['Two']);
  });

  it('disappears after the timeout, 6 seconds by default', () => {
    showToast('Default');
    showToast('Short', { timeout: 1000 });
    vi.advanceTimersByTime(1000);
    expect(messages()).toEqual(['Default']);
    vi.advanceTimersByTime(5000);
    expect(toasts()).toHaveLength(0);
  });

  it('stays until dismissed with a timeout of 0', () => {
    const { dismiss } = showToast('Sticky', { timeout: 0 });
    vi.advanceTimersByTime(60_000);
    expect(toasts()).toHaveLength(1);
    dismiss();
    expect(toasts()).toHaveLength(0);
  });

  it('runs the action, then dismisses', () => {
    const onClick = vi.fn(() => {
      expect(toasts()).toHaveLength(1);
    });
    showToast('Edited Rose', { action: { label: 'Undo', onClick } });
    const button = document.querySelector('.toast-action');
    expect(button.textContent).toBe('Undo');
    button.click();
    expect(onClick).toHaveBeenCalledOnce();
    expect(toasts()).toHaveLength(0);
  });

  it('shows the action label as text', () => {
    showToast('Hi', { action: { label: XSS, onClick: () => {} } });
    expect(document.querySelector('.toast-action').textContent).toBe(XSS);
    expect(document.querySelector('img')).toBeNull();
  });

  it('dismisses even when the action throws', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    showToast('Edited Rose', { action: { label: 'Undo', onClick: () => { throw new Error('boom'); } } });
    document.querySelector('.toast-action').click();
    expect(toasts()).toHaveLength(0);
    expect(console.error).toHaveBeenCalled();
  });

  it('has a close button', () => {
    showToast('Hi');
    const close = document.querySelector('.toast-close');
    expect(close.getAttribute('aria-label')).toBe('Dismiss');
    close.click();
    expect(toasts()).toHaveLength(0);
  });

  it('can be dismissed more than once, and the timer then does nothing', () => {
    const { dismiss } = showToast('Hi', { timeout: 1000 });
    dismiss();
    dismiss();
    showToast('Other', { timeout: 0 });
    vi.advanceTimersByTime(2000);
    expect(toasts()).toHaveLength(1);
  });

  it('waits while the pointer or focus is on the toast', () => {
    showToast('Edited Rose', { timeout: 1000, action: { label: 'Undo', onClick: () => {} } });
    const [toast] = toasts();
    toast.dispatchEvent(new Event('mouseenter'));
    vi.advanceTimersByTime(5000);
    expect(toasts()).toHaveLength(1);
    toast.dispatchEvent(new Event('mouseleave'));
    vi.advanceTimersByTime(999);
    expect(toasts()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(toasts()).toHaveLength(0);

    showToast('Edited Ann', { timeout: 1000, action: { label: 'Undo', onClick: () => {} } });
    const action = document.querySelector('.toast-action');
    action.focus();
    vi.advanceTimersByTime(5000);
    expect(toasts()).toHaveLength(1);
    action.blur();
    vi.advanceTimersByTime(1000);
    expect(toasts()).toHaveLength(0);
  });

  it('keeps at most three on screen, dropping the oldest of either kind', () => {
    showToast('1', { kind: 'error' });
    for (const message of ['2', '3', '4']) showToast(message);
    vi.advanceTimersByTime(0);
    expect(messages()).toEqual(['2', '3', '4']);
    showToast('5', { kind: 'error' });
    vi.advanceTimersByTime(0);
    expect(messages()).toEqual(['3', '4', '5']);
  });

  it('does not fill in a toast dismissed before its text arrived', () => {
    const { dismiss, element } = showToast('Gone');
    dismiss();
    vi.advanceTimersByTime(0);
    expect(element.querySelector('.toast-message').textContent).toBe('');
  });
});
