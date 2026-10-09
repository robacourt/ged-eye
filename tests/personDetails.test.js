import { describe, it, expect } from 'vitest';
import { PersonDetails } from '../src/personDetails.js';

const XSS = '<img src=x onerror="window.__xss = 1">';

async function render(person, relationships = null) {
  document.body.innerHTML = '<div id="details"></div>';
  const details = new PersonDetails(document.getElementById('details'));
  await details.showPerson({ id: 'I1', name: 'Test Person', sex: 'M', photos: [], ...person }, relationships);
  return document.getElementById('details');
}
const sectionText = (el, title) =>
  [...el.querySelectorAll('.person-details-section')].find(s => s.querySelector('h3').textContent === title)?.textContent;

describe('PersonDetails', () => {
  it('renders every data value as text', async () => {
    const el = await render({
      name: XSS, birthDate: XSS, birthPlace: XSS, causeOfDeath: XSS, deathNotes: [XSS], notes: [XSS],
      occupations: [{ value: XSS, notes: [XSS] }], censusRecords: [{ place: XSS, notes: [XSS] }],
      residences: [{ date: XSS }], otherFacts: [{ tag: XSS, value: XSS }], email: XSS, phone: XSS,
      marriages: [{ spouseId: 'I2', marriagePlace: XSS }]
    }, { spouses: [{ id: 'I2', name: XSS }] });
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('[onerror]')).toBeNull();
    expect(el.querySelector('h2').textContent).toBe(XSS);
    expect(el.textContent.split(XSS).length - 1).toBeGreaterThanOrEqual(15);
  });

  it('never takes a label or summary word from the data', async () => {
    const el = await render({ residences: [{ place: 'p', notes: ['n'], label: XSS, summaryWord: XSS }] });
    expect(el.querySelector('img')).toBeNull();
    expect(sectionText(el, 'Residences')).not.toContain(XSS);
    expect(el.querySelector('details summary').textContent).toBe('Note');
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

  it('clamps only long person notes, with a working Show more', async () => {
    const el = await render({ notes: ['short', Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n')] });
    const buttons = el.querySelectorAll('.note-toggle');
    expect(buttons).toHaveLength(1);
    const text = buttons[0].previousElementSibling;
    expect(text.classList.contains('note-clamped')).toBe(true);
    buttons[0].click();
    expect(text.classList.contains('note-clamped')).toBe(false);
    expect(buttons[0].textContent).toBe('Show less');
    expect(buttons[0].getAttribute('aria-expanded')).toBe('true');
    buttons[0].click();
    expect(text.classList.contains('note-clamped')).toBe(true);
    expect(buttons[0].textContent).toBe('Show more');
  });

  it('shows a life event that has only notes or a cause', async () => {
    const el = await render({ deathNotes: ['Died as an infant'], causeOfDeath: 'Fever' });
    const lifeEvents = sectionText(el, 'Life Events');
    expect(lifeEvents).toContain('Death:');
    expect(lifeEvents).toContain('Cause: Fever');
    expect(lifeEvents).toContain('Died as an infant');
  });

  it('renders old and new occupation shapes', async () => {
    expect(sectionText(await render({ occupations: ['Miller'] }), 'Occupations')).toContain('Miller');
    const el = await render({ occupations: [{ value: 'Miller', date: '1881', place: 'Stalbridge', notes: ['Employs 2'] }] });
    expect(sectionText(el, 'Occupations')).toContain('Miller • 1881 • Stalbridge');
    expect(el.querySelector('details summary').textContent).toBe('Note');
  });

  it('labels other facts, and still shows legacy religion and education', async () => {
    const el = await render({
      otherFacts: [{ tag: '_MILT', value: 'Militia List', date: '1799' }, { tag: 'EVEN', type: 'Court case', place: 'Dorset' }, { tag: '_FOO' }],
      religion: 'Protestant', education: 'Grammar school'
    });
    const other = sectionText(el, 'Other details');
    for (const text of ['Military service:', 'Militia List • 1799', 'Court case:', 'Dorset', 'Foo:', 'Religion:', 'Protestant', 'Education:', 'Grammar school']) {
      expect(other).toContain(text);
    }
    expect(sectionText(el, 'Personal')).toBeUndefined();
  });

  it('omits empty sections', async () => {
    const el = await render({});
    expect(el.querySelectorAll('h3')).toHaveLength(0);
  });
});
