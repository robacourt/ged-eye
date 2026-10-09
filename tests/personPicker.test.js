import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createPersonPicker } from '../src/personPicker.js';
import { createPersonSearch, lifeYears } from '../src/personSearch.js';

const XSS = '<img src=x onerror="window.__xss = 1">';
const ROSE = { id: 'I7', name: 'Rose Smith' };
const TOM = { id: 'I1', name: 'Tom Smith' };
const RESULTS = [
  { id: 'I2', name: 'Ann Jones', birthYear: 1850, deathYear: 1910 },
  { id: 'I7', name: 'Rose Smith', birthYear: 1890, deathYear: null },
  { id: 'I20', name: 'Ann Smith', birthYear: null, deathYear: 1899 },
  { id: 'I22', name: '', birthYear: null, deathYear: null }
];

let api;
let onChange;
let picker;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const chips = () => $$('.person-picker-chip').map(chip => chip.querySelector('.person-picker-chip-name').textContent);
const removeButton = (name) => $(`.person-picker-remove[aria-label="Remove ${name}"]`);
const results = () => $$('.person-picker-result').map(result => result.querySelector('.person-picker-result-label').textContent);
const addButton = (id) => $(`.person-picker-result[data-id="${id}"] .person-picker-add`);
const status = () => $('.person-search-status').textContent;

function open(options = {}) {
  vi.useFakeTimers();
  picker = createPersonPicker({ api, chosen: [ROSE], onChange, ...options });
  document.body.append(picker.element);
  return picker;
}

async function search(text) {
  const input = $('.person-picker input[type="search"]');
  input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await vi.advanceTimersByTimeAsync(250);
}

beforeEach(() => {
  document.body.innerHTML = '';
  api = { search: vi.fn().mockResolvedValue(RESULTS) };
  onChange = vi.fn();
});

afterEach(() => {
  picker?.destroy();
  picker = null;
  vi.useRealTimers();
});

describe('createPersonPicker', () => {
  it('shows the chosen people as chips, each with a × labelled with their name', () => {
    open({ chosen: [ROSE, TOM, { id: 'I22', name: '' }] });
    expect(chips()).toEqual(['Rose Smith', 'Tom Smith', 'Unnamed person']);
    expect(removeButton('Rose Smith')).not.toBeNull();
    expect(removeButton('Tom Smith').textContent).toBe('×');
    expect(removeButton('Unnamed person')).not.toBeNull();
    expect(picker.chosen()).toEqual([ROSE, TOM, { id: 'I22', name: '' }]);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('searches the tree 250 ms after typing, showing names and years with an Add button each', async () => {
    open();
    expect(status()).toBe('Type at least 2 letters of their name.');
    await search('Ann');
    expect(api.search).toHaveBeenCalledWith('Ann', { limit: 20 });
    expect(results()).toEqual(['Ann Jones (1850–1910)', 'Rose Smith (b. 1890)', 'Ann Smith (d. 1899)', 'Unnamed person']);
    expect(status()).toBe('4 people found.');
    expect(addButton('I2').textContent).toBe('Add');
    expect(addButton('I2').getAttribute('aria-label')).toBe('Add Ann Jones');
  });

  it('adds someone from the results as a chip, firing onChange', async () => {
    open();
    await search('Ann');
    addButton('I2').focus();
    addButton('I2').click();
    expect(chips()).toEqual(['Rose Smith', 'Ann Jones']);
    expect(picker.chosen()).toEqual([ROSE, { id: 'I2', name: 'Ann Jones' }]);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith([ROSE, { id: 'I2', name: 'Ann Jones' }]);
    expect(addButton('I2').textContent).toBe('Added');
    expect(addButton('I2').getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(addButton('I2')); // focus stays put for the next one
  });

  it("doesn't add anyone twice", async () => {
    open({ chosen: [ROSE, TOM, ROSE] });
    expect(chips()).toEqual(['Rose Smith', 'Tom Smith']);
    await search('Ann');
    expect(addButton('I7').textContent).toBe('Added');
    addButton('I7').click();
    addButton('I2').click();
    addButton('I2').click();
    expect(chips()).toEqual(['Rose Smith', 'Tom Smith', 'Ann Jones']);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('removes a chip with its ×, firing onChange, and offers them in the results again', async () => {
    open({ chosen: [ROSE, TOM] });
    await search('Ann');
    expect(addButton('I7').textContent).toBe('Added');
    removeButton('Rose Smith').click();
    expect(chips()).toEqual(['Tom Smith']);
    expect(onChange).toHaveBeenCalledWith([TOM]);
    expect(picker.chosen()).toEqual([TOM]);
    expect(addButton('I7').textContent).toBe('Add');
    expect(addButton('I7').hasAttribute('aria-disabled')).toBe(false);
  });

  it('moves focus to the next ×, else the previous, else the search box, when a chip is removed', () => {
    open({ chosen: [ROSE, TOM, { id: 'I2', name: 'Ann Jones' }] });
    removeButton('Tom Smith').click();
    expect(document.activeElement).toBe(removeButton('Ann Jones'));
    removeButton('Ann Jones').click();
    expect(document.activeElement).toBe(removeButton('Rose Smith'));
    removeButton('Rose Smith').click();
    expect(document.activeElement).toBe($('.person-picker input[type="search"]'));
    expect(chips()).toEqual([]);
  });

  it("has no × on fixed people, who can't be removed", async () => {
    open({ chosen: [ROSE, TOM], fixedIds: ['I7'] });
    expect(chips()).toEqual(['Rose Smith', 'Tom Smith']);
    expect(removeButton('Rose Smith')).toBeNull();
    expect($('.person-picker-chip[data-id="I7"]').classList.contains('person-picker-chip-fixed')).toBe(true);
    expect(removeButton('Tom Smith')).not.toBeNull();
    await search('Rose');
    expect(addButton('I7').textContent).toBe('Added');
  });

  it('keeps its own copy of the chosen people', async () => {
    const chosen = [ROSE];
    open({ chosen });
    chosen.push(TOM);
    picker.chosen().push(TOM);
    expect(picker.chosen()).toEqual([ROSE]);
    await search('Ann');
    addButton('I2').click();
    onChange.mock.calls[0][0].push(TOM);
    expect(picker.chosen()).toEqual([ROSE, { id: 'I2', name: 'Ann Jones' }]);
  });

  it('sets names as text', async () => {
    api.search.mockResolvedValue([{ id: 'I40', name: XSS, birthYear: XSS, deathYear: null }]);
    open({ chosen: [{ id: 'I41', name: XSS }] });
    expect(chips()).toEqual([XSS]);
    expect($('.person-picker-remove').getAttribute('aria-label')).toBe(`Remove ${XSS}`);
    await search('img');
    expect(results()).toEqual([`${XSS} (b. ${XSS})`]);
    addButton('I40').click();
    expect(chips()).toEqual([XSS, XSS]);
    expect(document.querySelector('img')).toBeNull();
  });

  it('ignores a search that answers after destroy()', async () => {
    let answer;
    api.search.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
    open();
    await search('Ann');
    picker.destroy();
    answer(RESULTS);
    await vi.advanceTimersByTimeAsync(0);
    expect(results()).toEqual([]);
    expect(status()).toBe('Searching…');
  });

  it('ignores a search that answers once the picker has left the page', async () => {
    let answer;
    api.search.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
    open();
    await search('Ann');
    picker.element.remove();
    answer(RESULTS);
    await vi.advanceTimersByTimeAsync(0);
    expect(picker.element.querySelectorAll('.person-picker-result')).toHaveLength(0);
  });
});

describe('createPersonSearch', () => {
  beforeEach(() => vi.useFakeTimers());

  it('labels its box and starts with a hint in a polite live region', () => {
    const search = createPersonSearch({ api, onResults: vi.fn(), label: 'Shown for' });
    expect(search.element.querySelector('label').textContent).toBe('Shown for');
    expect(search.element.querySelector('label').contains(search.input)).toBe(true);
    expect(search.element.contains(search.status)).toBe(true);
    expect(search.status.getAttribute('aria-live')).toBe('polite');
    expect(search.status.textContent).toBe('Type at least 2 letters of their name.');
    search.destroy();
  });

  it('searches at once on Enter, without submitting a form', async () => {
    const onResults = vi.fn();
    const search = createPersonSearch({ api, onResults });
    search.input.value = 'Ann';
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    search.input.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(api.search).toHaveBeenCalledTimes(1);
    expect(onResults).toHaveBeenCalledWith(RESULTS);
    search.destroy();
  });

  it('leaves out anyone `filter` rejects, from the results and the count', async () => {
    const onResults = vi.fn();
    const search = createPersonSearch({ api, onResults, filter: someone => someone.id !== 'I7' });
    search.input.value = 'Ann';
    await search.runNow();
    expect(onResults).toHaveBeenCalledWith([RESULTS[0], RESULTS[2], RESULTS[3]]);
    expect(search.status.textContent).toBe('3 people found.');
  });

  it('stops searching once isActive() is false', async () => {
    let active = true;
    const search = createPersonSearch({ api, onResults: vi.fn(), isActive: () => active });
    search.input.value = 'Ann';
    search.input.dispatchEvent(new Event('input'));
    active = false;
    await vi.advanceTimersByTimeAsync(250);
    expect(api.search).not.toHaveBeenCalled();
  });

  it('clear() empties the box and the results, and forgets a search under way', async () => {
    let answer;
    api.search.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
    const onResults = vi.fn();
    const search = createPersonSearch({ api, onResults });
    search.input.value = 'Ann';
    search.runNow();
    search.clear();
    expect(search.input.value).toBe('');
    expect(onResults).toHaveBeenLastCalledWith([]);
    expect(search.status.textContent).toBe('Type at least 2 letters of their name.');
    answer(RESULTS);
    await vi.advanceTimersByTimeAsync(0);
    expect(onResults).toHaveBeenCalledTimes(1);
  });

  it('formats life years', () => {
    expect(lifeYears({ birthYear: 1850, deathYear: 1910 })).toBe('1850–1910');
    expect(lifeYears({ birthYear: 1850, deathYear: null })).toBe('b. 1850');
    expect(lifeYears({ birthYear: undefined, deathYear: 1910 })).toBe('d. 1910');
    expect(lifeYears({})).toBe('');
  });
});
