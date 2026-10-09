import { describe, it, expect } from 'vitest';
import { escapeHtml } from '../src/html.js';

describe('escapeHtml', () => {
  it('escapes the five HTML-special characters and stringifies', () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&</a>`)).toBe('&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
    expect(escapeHtml(1881)).toBe('1881');
  });
});
