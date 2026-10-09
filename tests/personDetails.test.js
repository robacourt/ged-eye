import { describe, it, expect, vi } from 'vitest';
import { PersonDetails } from '../src/personDetails.js';

const XSS = '<img src=x onerror="window.__xss = 1">';

async function render(person, relationships = null) {
  document.body.innerHTML = '<div id="details"></div>';
  const details = new PersonDetails(document.getElementById('details'));
  await details.showPerson({ id: 'I1', name: 'Test Person', sex: 'M', photos: [], ...person }, relationships);
  return document.getElementById('details');
}

// jsdom does no layout, so every height is 0. Give each element a height for the length of one render.
// Each of clientHeight/scrollHeight is a number or a function of the element.
async function renderWithHeights({ clientHeight, scrollHeight }, person) {
  const stub = (value) => ({ configurable: true, get() { return typeof value === 'function' ? value(this) : value; } });
  const originals = ['clientHeight', 'scrollHeight'].map(name => [name, Object.getOwnPropertyDescriptor(Element.prototype, name)]);
  Object.defineProperty(Element.prototype, 'clientHeight', stub(clientHeight));
  Object.defineProperty(Element.prototype, 'scrollHeight', stub(scrollHeight));
  try {
    return await render(person);
  } finally {
    for (const [name, descriptor] of originals) Object.defineProperty(Element.prototype, name, descriptor);
  }
}

const section = (el, title) =>
  [...el.querySelectorAll('.person-details-section')].find(s => s.querySelector('h3').textContent === title);
const sectionText = (el, title) => section(el, title)?.textContent;
const sectionRows = (el, title) => [...(section(el, title)?.querySelectorAll('.detail-item') ?? [])];
const rowText = (el, title, label) =>
  sectionRows(el, title).find(row => row.querySelector('.detail-label')?.textContent.startsWith(label))?.textContent;
const occurrences = (text, needle) => (text === undefined ? 0 : text.split(needle).length - 1);
const lines = (count) => Array.from({ length: count }, (_, i) => `line ${i}`).join('\n');

describe('PersonDetails', () => {
  it('renders every data value as text, in every section', async () => {
    const el = await render({
      name: XSS, birthDate: XSS, birthPlace: XSS, baptismPlace: XSS, causeOfDeath: XSS, deathNotes: [XSS], burialNotes: [XSS],
      notes: [XSS], occupations: [{ value: XSS, notes: [XSS] }], censusRecords: [{ place: XSS, notes: [XSS] }],
      residences: [{ date: XSS }], otherFacts: [{ tag: XSS, value: XSS }], email: XSS, phone: XSS,
      marriages: [{ spouseId: 'I2', marriagePlace: XSS }]
    }, { spouses: [{ id: 'I2', name: XSS }] });
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('[onerror]')).toBeNull();
    expect(el.querySelector('h2').textContent).toBe(XSS);
    const titles = ['Life Events', 'Marriages', 'Occupations', 'Other details', 'Census Records', 'Residences', 'Notes', 'Contact'];
    expect(Object.fromEntries(titles.map(title => [title, occurrences(sectionText(el, title), XSS)]))).toEqual({
      'Life Events': 6, Marriages: 2, Occupations: 2, 'Other details': 2, 'Census Records': 2, Residences: 1, Notes: 1, Contact: 2
    });
    // The payload stays inside the link's href attribute rather than adding attributes of its own.
    for (const [scheme, label] of [['mailto:', 'Email'], ['tel:', 'Phone']]) {
      const link = section(el, 'Contact').querySelector(`a[href^="${scheme}"]`);
      expect(link.getAttribute('href')).toBe(scheme + XSS);
      expect(link.attributes).toHaveLength(1);
      expect(link.textContent).toBe(XSS);
      expect(rowText(el, 'Contact', label)).toContain(XSS);
    }
  });

  it('never takes a label or summary word from the data', async () => {
    const el = await render({ residences: [{ place: 'p', notes: ['n'], label: XSS, summaryWord: XSS }] });
    expect(el.querySelector('img')).toBeNull();
    expect(sectionText(el, 'Residences')).not.toContain(XSS);
    expect(el.querySelector('details summary').textContent).toBe('Note');
  });

  it('labels sex M and F, and shows no badge for anything else', async () => {
    const badge = async (sex) => (await render({ sex })).querySelector('.person-sex')?.textContent;
    expect(await badge('M')).toBe('Male');
    expect(await badge('F')).toBe('Female');
    for (const sex of ['U', '', undefined, 'constructor']) expect(await badge(sex)).toBeUndefined();
  });

  it('keeps note line breaks and indentation', async () => {
    const el = await render({ notes: ['Line one\n  indented'] });
    expect(el.querySelector('.note-text').textContent).toBe('Line one\n  indented');
  });

  it('puts census transcriptions and fact notes behind a disclosure', async () => {
    const el = await render({
      censusRecords: [{ date: '1851', place: 'Marnhull', notes: ['Age 59'] }, { date: '1861', notes: ['a', 'b'] }],
      residences: [{ place: 'Prison', notes: ['3 months'] }]
    });
    expect([...el.querySelectorAll('details > summary')].map(s => s.textContent)).toEqual(['Transcription', 'Transcriptions (2)', 'Note']);
    expect(el.querySelector('details').open).toBe(false);
    expect(el.querySelector('details .note-text').textContent).toBe('Age 59');
  });

  describe('person notes', () => {
    it('clamps only long person notes, with a working Show more', async () => {
      const scrollIntoView = vi.fn();
      Element.prototype.scrollIntoView = scrollIntoView; // jsdom has none
      try {
        const el = await render({ notes: ['short', lines(10)] });
        expect(el.querySelectorAll('.person-note')).toHaveLength(2);
        expect(el.querySelectorAll('.detail-note')).toHaveLength(0);
        const buttons = el.querySelectorAll('.note-toggle');
        expect(buttons).toHaveLength(1);
        const text = buttons[0].closest('.person-note').querySelector('.note-text');
        expect(text.classList.contains('note-clamped')).toBe(true);
        buttons[0].click();
        expect(text.classList.contains('note-clamped')).toBe(false);
        expect(buttons[0].textContent).toBe('Show less');
        expect(buttons[0].getAttribute('aria-expanded')).toBe('true');
        expect(scrollIntoView).not.toHaveBeenCalled();
        buttons[0].click();
        expect(text.classList.contains('note-clamped')).toBe(true);
        expect(buttons[0].textContent).toBe('Show more');
        expect(buttons[0].getAttribute('aria-expanded')).toBe('false');
        expect(scrollIntoView).toHaveBeenCalledTimes(1);
        expect(scrollIntoView.mock.contexts[0]).toBe(text);
        expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
      } finally {
        delete Element.prototype.scrollIntoView;
      }
    });

    it('collapses without scrollIntoView where the browser has none', async () => {
      const el = await render({ notes: [lines(10)] });
      const button = el.querySelector('.note-toggle');
      button.click();
      button.click();
      expect(button.textContent).toBe('Show more');
    });

    it('clamps above 6 lines or 500 characters, not at them', async () => {
      const toggles = async (note) => (await render({ notes: [note] })).querySelectorAll('.note-toggle').length;
      expect(await toggles('a'.repeat(500))).toBe(0);
      expect(await toggles('a'.repeat(501))).toBe(1);
      expect(await toggles(lines(6))).toBe(0);
      expect(await toggles(lines(7))).toBe(1);
    });

    it('does not clamp a long-by-rule note that fits in the clamped box', async () => {
      const note = 'a'.repeat(501);
      for (const scrollHeight of [117, 118]) { // 118 is within one pixel of the box
        const el = await renderWithHeights({ clientHeight: 117, scrollHeight }, { notes: [note] });
        expect(el.querySelector('.note-toggle')).toBeNull();
        expect(el.querySelector('.note-clamped')).toBeNull();
        expect(el.querySelector('.note-text').textContent).toBe(note);
      }
    });

    it('keeps the clamp and button on a note that overflows', async () => {
      const el = await renderWithHeights({ clientHeight: 117, scrollHeight: 119 }, { notes: [lines(10)] });
      expect(el.querySelectorAll('.note-toggle')).toHaveLength(1);
      expect(el.querySelectorAll('.note-clamped')).toHaveLength(1);
    });

    it('un-clamps each note on its own measurements, and the remaining button still works', async () => {
      const fits = `fits ${'a'.repeat(501)}`;
      const overflows = `overflows\n${lines(10)}`;
      const el = await renderWithHeights({
        clientHeight: 117, scrollHeight: (text) => (text.textContent.startsWith('fits') ? 117 : 300)
      }, { notes: [fits, overflows] });
      const [fitting, overflowing] = el.querySelectorAll('.person-note');
      expect(fitting.querySelector('.note-toggle')).toBeNull();
      expect(fitting.querySelector('.note-clamped')).toBeNull();
      const button = overflowing.querySelector('.note-toggle');
      expect(button).not.toBeNull();
      button.click();
      expect(overflowing.querySelector('.note-text').classList.contains('note-clamped')).toBe(false);
      expect(button.textContent).toBe('Show less');
    });

    it('leaves the clamp alone when nothing has been laid out', async () => {
      // jsdom's heights are all 0, which also stands for a panel that is not displayed yet.
      const el = await render({ notes: [lines(10)] });
      expect(el.querySelectorAll('.note-toggle')).toHaveLength(1);
      expect(el.querySelectorAll('.note-clamped')).toHaveLength(1);
    });
  });

  describe('life events', () => {
    it('shows a death that has only notes', async () => {
      const el = await render({ deathNotes: ['Died as an infant'] });
      expect(sectionRows(el, 'Life Events')).toHaveLength(1);
      expect(rowText(el, 'Life Events', 'Death:')).toContain('Died as an infant');
      expect(rowText(el, 'Life Events', 'Death:')).not.toContain('Cause');
    });

    it('shows a death that has only a cause', async () => {
      const el = await render({ causeOfDeath: 'Fever' });
      expect(sectionRows(el, 'Life Events')).toHaveLength(1);
      expect(rowText(el, 'Life Events', 'Death:')).toContain('Cause: Fever');
    });

    it('shows birth, baptism and burial notes in their own rows', async () => {
      const el = await render({ birthNotes: ['Born at home'], baptismNotes: ['Godparents: A, B'], burialNotes: ['Churchyard'] });
      expect(sectionRows(el, 'Life Events')).toHaveLength(3);
      expect(rowText(el, 'Life Events', 'Birth:')).toContain('Born at home');
      expect(rowText(el, 'Life Events', 'Baptism:')).toContain('Godparents: A, B');
      expect(rowText(el, 'Life Events', 'Burial:')).toContain('Churchyard');
      expect(rowText(el, 'Life Events', 'Birth:')).not.toContain('Churchyard');
    });
  });

  describe('marriages', () => {
    it('shows the spouse, the marriage and the divorce', async () => {
      const el = await render({
        marriages: [{ spouseId: 'I2', marriageDate: '1850', marriagePlace: 'Marnhull', divorceDate: '1860', divorcePlace: 'Bath' }]
      }, { spouses: [{ id: 'I2', name: 'Jane Doe' }] });
      expect(rowText(el, 'Marriages', 'Spouse:')).toContain('Jane Doe');
      expect(rowText(el, 'Marriages', 'Married:')).toContain('1850 • Marnhull');
      expect(rowText(el, 'Marriages', 'Divorced:')).toContain('1860 • Bath');
    });

    it('omits the married and divorced rows when they have no date or place, and names an unknown spouse', async () => {
      const el = await render({ marriages: [{ spouseId: 'I9' }] }, { spouses: [] });
      expect(sectionRows(el, 'Marriages')).toHaveLength(1);
      expect(rowText(el, 'Marriages', 'Spouse:')).toContain('Unknown');
    });
  });

  describe('contact', () => {
    it('links the email and phone', async () => {
      const el = await render({ email: 'jane@example.com', phone: '+44 1305 123456' });
      const email = section(el, 'Contact').querySelector('a[href^="mailto:"]');
      expect(email.getAttribute('href')).toBe('mailto:jane@example.com');
      expect(email.textContent).toBe('jane@example.com');
      const phone = section(el, 'Contact').querySelector('a[href^="tel:"]');
      expect(phone.getAttribute('href')).toBe('tel:+44 1305 123456');
      expect(phone.textContent).toBe('+44 1305 123456');
      expect(rowText(el, 'Contact', 'Email:')).toContain('jane@example.com');
      expect(rowText(el, 'Contact', 'Phone:')).toContain('+44 1305 123456');
    });

    it('omits the section without an email or phone', async () => {
      expect(sectionText(await render({}), 'Contact')).toBeUndefined();
    });
  });

  it('renders old and new occupation shapes', async () => {
    expect(sectionText(await render({ occupations: ['Miller'] }), 'Occupations')).toContain('Miller');
    const el = await render({ occupations: [{ value: 'Miller', date: '1881', place: 'Stalbridge', notes: ['Employs 2'] }] });
    expect(sectionText(el, 'Occupations')).toContain('Miller • 1881 • Stalbridge');
    expect(el.querySelector('details summary').textContent).toBe('Note');
  });

  it('labels other facts, and still shows legacy religion and education', async () => {
    const el = await render({
      otherFacts: [{ tag: '_MILT', value: 'Militia List', date: '1799' }, { tag: 'EVEN', type: 'Court case', place: 'Dorset' }, { tag: '_FOO', value: 'x' }],
      religion: 'Protestant', education: 'Grammar school'
    });
    const other = sectionText(el, 'Other details');
    for (const text of ['Military service:', 'Militia List • 1799', 'Court case:', 'Dorset', 'Foo:', 'Religion:', 'Protestant', 'Education:', 'Grammar school']) {
      expect(other).toContain(text);
    }
    expect(sectionText(el, 'Personal')).toBeUndefined();
  });

  it('shows a fact with only a tag as a bare label', async () => {
    const el = await render({ otherFacts: [{ tag: '_NMAR' }] });
    expect(sectionRows(el, 'Other details')).toHaveLength(1);
    expect(rowText(el, 'Other details', 'Never married')).toBe('Never married');
    expect(section(el, 'Other details').querySelectorAll('.detail-value')).toHaveLength(0);
  });

  it('gives every labelled row the same structure', async () => {
    const el = await render({
      email: 'a@b.example', phone: '1', deathNotes: ['n'], otherFacts: [{ tag: '_FOO', value: 'x' }],
      marriages: [{ spouseId: 'I2', marriageDate: '1850' }]
    }, { spouses: [{ id: 'I2', name: 'Jane' }] });
    const rows = [...el.querySelectorAll('.detail-item')];
    expect(rows.length).toBeGreaterThanOrEqual(6);
    for (const row of rows) {
      expect([...row.children].map(child => `${child.tagName}.${child.className}`)).toEqual(['SPAN.detail-label', 'DIV.detail-value']);
    }
  });

  it('omits empty sections', async () => {
    const el = await render({});
    expect(el.querySelectorAll('h3')).toHaveLength(0);
  });
});
