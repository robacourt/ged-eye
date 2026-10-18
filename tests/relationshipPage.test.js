import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The chain's drawing (Cytoscape) is chainView.js's; here it is a stand-in that records what it was asked.
const chainViews = [];
vi.mock('../src/chainView.js', () => ({
  ChainView: vi.fn(function ChainView(container, options) {
    this.container = container;
    this.options = options;
    this.show = vi.fn();
    this.clear = vi.fn();
    this.fit = vi.fn();
    this.destroy = vi.fn();
    chainViews.push(this);
  })
}));

const { openRelationshipPage } = await import('../src/relationshipPage.js');

const ROBERT = { id: 'I128', name: 'Robert Michael A\'Court' };
const PATH = [
  { id: 'I128', name: 'Robert Michael A\'Court', sex: 'M', step: null },
  { id: 'I122', name: 'Ian John A\'Court', sex: 'M', step: 'parent' },
  { id: 'I119', name: 'Clement Bernard A\'Court', sex: 'M', step: 'parent' }
];

let api;
let page;
let handlers;
const flush = async (times = 5) => {
  for (let i = 0; i < times; i++) await new Promise(resolve => setTimeout(resolve, 0));
};
const $ = (selector) => document.querySelector(selector);
const chain = () => chainViews.at(-1);
const words = () => $('.relationship-words').textContent;
const status = () => $('.relationship-status').textContent;

function open(relative = ROBERT) {
  page = openRelationshipPage({ container: document.getElementById('app'), api, relative, ...handlers });
  return page;
}

async function search(text) {
  const input = $('.relationship-page input[type="search"]');
  input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await flush();
}

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  chainViews.length = 0;
  api = {
    search: vi.fn(async () => [
      { id: 'I119', name: 'Clement Bernard A\'Court', birthYear: 1914, deathYear: 2005 },
      { id: 'I200', name: 'Clement Jarvis', birthYear: null, deathYear: null }
    ]),
    relationship: vi.fn(async () => PATH)
  };
  handlers = { onChoose: vi.fn(), onOpenPerson: vi.fn(), onBack: vi.fn() };
});

afterEach(() => {
  page?.close();
  page = null;
});

describe('openRelationshipPage', () => {
  it('asks how someone is related to the relative, with Back, a search box and a chain', () => {
    open();
    expect($('.relationship-title').textContent).toBe("How is someone related to Robert Michael A'Court?");
    expect($('.relationship-page').getAttribute('aria-labelledby')).toBe($('.relationship-title').id);
    $('.relationship-back').click();
    expect(handlers.onBack).toHaveBeenCalledOnce();
    expect(chain().container).toBe($('.relationship-chain'));
  });

  it('lists the people found, with their years, and chooses one', async () => {
    open();
    await search('Clement');
    expect(api.search).toHaveBeenCalledWith('Clement', { limit: 20 });
    const results = [...document.querySelectorAll('.relationship-result')];
    expect(results.map(result => result.textContent)).toEqual(["Clement Bernard A'Court1914–2005", 'Clement Jarvis']);
    results[0].click();
    expect(handlers.onChoose).toHaveBeenCalledWith('I119');
    expect(document.querySelectorAll('.relationship-result')).toHaveLength(0);
    expect($('.relationship-page input[type="search"]').value).toBe("Clement Bernard A'Court");
    expect($('.person-search-status').textContent).toBe('');
  });

  it('shows the chain from the relative to the person, and says how they are related', async () => {
    open();
    await page.setPerson('I119');
    expect(api.relationship).toHaveBeenCalledWith('I128', 'I119');
    expect(chain().show).toHaveBeenCalledWith(PATH);
    expect(words()).toBe("Clement Bernard A'Court is Robert Michael A'Court's grandfather.");
    expect(status()).toBe('');
  });

  it('says so when they have no family connection', async () => {
    api.relationship.mockResolvedValueOnce(null);
    open();
    await page.setPerson('I999');
    expect(chain().clear).toHaveBeenCalled();
    expect(words()).toBe('No family connection found.');
  });

  it('says so when the relationship can\'t be found, and shows nothing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    api.relationship.mockRejectedValueOnce(Object.assign(new Error('Failed to fetch'), { code: 'network' }));
    open();
    await page.setPerson('I119');
    expect(status()).toBe('Couldn’t find how they’re related. Check your connection and try again.');
    expect(words()).toBe('');
    expect(chain().show).not.toHaveBeenCalled();
  });

  it('shows only the latest chain asked for', async () => {
    let finishFirst;
    api.relationship
      .mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve; }))
      .mockResolvedValueOnce(PATH);
    open();
    const first = page.setPerson('I500');
    await page.setPerson('I119');
    finishFirst([{ id: 'I128', name: 'Robert', sex: 'M', step: null }, { id: 'I500', name: 'Other', sex: 'F', step: 'sibling' }]);
    await first;
    expect(chain().show).toHaveBeenCalledTimes(1);
    expect(words()).toContain('grandfather');
  });

  it('clears the chain and the words for no one', async () => {
    open();
    await page.setPerson('I119');
    await page.setPerson(null);
    expect(chain().clear).toHaveBeenCalled();
    expect(words()).toBe('');
  });

  it('starts from a new relative', async () => {
    open();
    page.setRelative({ id: 'I7', name: 'Rose Smith' });
    expect($('.relationship-title').textContent).toBe('How is someone related to Rose Smith?');
    await page.setPerson('I119');
    expect(api.relationship).toHaveBeenLastCalledWith('I7', 'I119');
  });

  it('opens the tree for someone tapped in the chain', () => {
    open();
    chain().options.onPersonSelect('I122');
    expect(handlers.onOpenPerson).toHaveBeenCalledWith('I122');
  });

  it('goes away when closed, with its chain', async () => {
    open();
    page.close();
    expect($('.relationship-page')).toBeNull();
    expect(chain().destroy).toHaveBeenCalledOnce();
    page = null;
  });

  it('keeps focus on the page when a result is chosen, and focuses the search box when asked', async () => {
    open();
    page.focusSearch();
    expect(document.activeElement).toBe($('.relationship-page input[type="search"]'));
    await search('Clement');
    document.querySelector('.relationship-result').click();
    expect(document.activeElement).toBe($('.relationship-title'));
  });

  it('says one of them can\'t be found, rather than blaming the connection, for a 404 or 409', async () => {
    for (const status of [404, 409]) {
      api.relationship.mockRejectedValueOnce(Object.assign(new Error('gone'), { status }));
      open();
      await page.setPerson('I999');
      expect($('.relationship-status').textContent).toBe('Couldn\u2019t find one of them in the tree. They may have been removed.');
      page.close();
      page = null;
    }
  });

  it('shows names as text', () => {
    open({ id: 'I1', name: '<img src=x onerror="window.__xss = 1">' });
    expect($('.relationship-title').textContent).toContain('<img');
    expect(document.querySelector('img')).toBeNull();
  });
});
