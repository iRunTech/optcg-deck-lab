/* Boot-path integration test.
 *
 * Exercises the real startup sequence — card load, meta load, view construction,
 * routing — against the actual data/meta.json, with fetch served from disk and
 * the card database seeded from a fixture. This is what catches a broken boot
 * that unit tests on individual modules would sail straight past.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* ---------------------------------------------------------------------- */
/* DOM shim (same shape as ui.test.mjs, kept local so tests stay isolated)  */
/* ---------------------------------------------------------------------- */

class El {
  constructor(tag = '') {
    this.tagName = String(tag).toUpperCase();
    this.childNodes = []; this.attributes = {}; this.style = {};
    this.dataset = {}; this.classList = new Set(); this.listeners = {};
    this.parentNode = null; this._text = '';
  }
  get className() { return [...this.classList].join(' '); }
  set className(v) { this.classList = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get textContent() { return this.childNodes.length ? this.childNodes.map(c => c.textContent).join('') : this._text; }
  set textContent(v) { this.childNodes = []; this._text = String(v); }
  set innerHTML(v) { this._text = String(v); }
  appendChild(c) { c.parentNode = this; this.childNodes.push(c); return c; }
  removeChild(c) { this.childNodes = this.childNodes.filter(x => x !== c); return c; }
  remove() { this.parentNode?.removeChild(this); }
  replaceWith(next) {
    const p = this.parentNode; if (!p) return;
    const i = p.childNodes.indexOf(this);
    if (i >= 0) { p.childNodes[i] = next; next.parentNode = p; }
  }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return this.attributes[k] ?? null; }
  addEventListener(k, fn) { (this.listeners[k] ||= []).push(fn); }
  removeEventListener() {}
  matches() { return false; }
  focus() {} blur() {}
  *walk() { yield this; for (const c of this.childNodes) if (c.walk) yield* c.walk(); }
  querySelector() { return null; }
  querySelectorAll() { return []; }
}
class TextEl extends El {
  constructor(t) { super('#text'); this._text = String(t); }
  get textContent() { return this._text; }
  *walk() { yield this; }
}

const CARD_FIXTURE = {
  'OP01-001': { id: 'OP01-001', name: 'Fixture Leader', category: 'Leader', colors: ['Red'], cost: 5, power: 5000, effect: '-', types: [] },
  'OP01-002': { id: 'OP01-002', name: 'Fixture Body', category: 'Character', colors: ['Red'], cost: 2, power: 3000, counter: 1000, effect: '-', types: [] },
};

let bodyEl;

before(async () => {
  bodyEl = new El('body');
  globalThis.document = {
    createElement: t => new El(t),
    createTextNode: t => new TextEl(t),
    createDocumentFragment: () => new El('#fragment'),
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => new El('div'),
    body: bodyEl,
    addEventListener() {},
  };
  globalThis.Node = El;
  globalThis.window = { addEventListener() {} };
  globalThis.requestAnimationFrame = fn => setTimeout(fn, 0);
  globalThis.localStorage = { _s: {}, getItem(k) { return this._s[k] ?? null; }, setItem(k, v) { this._s[k] = String(v); } };
  globalThis.confirm = () => true;
  if (!globalThis.navigator?.clipboard) {
    Object.defineProperty(globalThis, 'navigator', {
      value: { clipboard: { writeText: async () => {} } }, configurable: true, writable: true,
    });
  }
  Object.defineProperty(globalThis, 'location', {
    value: { origin: 'http://x', pathname: '/', hash: '' }, configurable: true, writable: true,
  });

  /* Serve the app's own fetches from disk. The card CDN is replaced by a small
   * fixture so the test never depends on the network. */
  globalThis.fetch = async url => {
    const u = String(url);
    if (u.includes('meta.json')) {
      const body = await readFile(join(ROOT, 'data', 'meta.json'), 'utf8');
      return { ok: true, status: 200, json: async () => JSON.parse(body) };
    }
    if (u.includes('packs.json')) return { ok: true, status: 200, json: async () => ({ '1': {} }) };
    if (u.includes('/data/')) return { ok: true, status: 200, json: async () => Object.values(CARD_FIXTURE) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
});

const textOf = el => [...el.walk()].map(n => (n instanceof TextEl ? n.textContent : '')).join('');

test('the app boots, mounts, and exposes all three views', async () => {
  await import('../src/main.js');
  // boot() is async; let its awaits settle.
  await new Promise(r => setTimeout(r, 60));

  assert.ok(bodyEl.childNodes.length, 'something mounted into body');
  const text = textOf(bodyEl);
  assert.ok(text.includes('DECK LAB'), 'brand rendered');
  for (const label of ['Playtest', 'Deck Builder', 'Meta']) {
    assert.ok(text.includes(label), `${label} tab rendered`);
  }
});

test('the generated meta snapshot loads and is well-formed', async () => {
  const { loadMeta, archetypes } = await import('../src/data/meta.js');
  const snap = await loadMeta();
  assert.ok(!snap.error, `meta.json loaded cleanly (${snap.error ?? ''})`);
  assert.ok(archetypes().length > 0, 'archetypes present');

  for (const a of archetypes()) {
    const sum = Object.values(a.consensus).reduce((x, y) => x + y, 0);
    assert.equal(sum, 50, `${a.name} consensus is exactly 50 cards`);
    assert.equal(a.coreSlots + a.flexSlots, 50, `${a.name} core + flex accounts for all slots`);
    assert.ok(a.leader, `${a.name} has a leader`);
    assert.ok(Array.isArray(a.cards) && a.cards.length, `${a.name} has per-card usage stats`);
    for (const c of a.cards) {
      assert.ok(c.include >= 0 && c.include <= 1, `${c.id} inclusion is a proportion`);
    }
  }
});

test('advise() produces a balanced swap against a consensus list', async () => {
  const { setCards } = await import('../src/data/cards.js');
  const { archetypes, advise } = await import('../src/data/meta.js');
  const { emptyDeck } = await import('../src/data/deck.js');

  const a = archetypes()[0];
  // Seed just enough card data for the advisor's name lookups.
  setCards(Object.fromEntries(a.cards.map(c => [c.id, {
    id: c.id, name: c.id, category: 'Character', colors: ['Red'], cost: 1, power: 1000, effect: '-', types: [],
  }])));

  // Feeding the consensus back in should produce no changes at all.
  const same = emptyDeck();
  same.leader = a.leader;
  same.cards = { ...a.consensus };
  const none = advise(same, a);
  assert.equal(none.adds.length, 0, 'consensus needs no additions');
  assert.equal(none.cuts.length, 0, 'consensus needs no cuts');

  // A deck one swap away should report exactly that swap, and balance.
  const tweaked = emptyDeck();
  tweaked.leader = a.leader;
  tweaked.cards = { ...a.consensus };
  const firstId = Object.keys(tweaked.cards)[0];
  const moved = tweaked.cards[firstId];
  delete tweaked.cards[firstId];
  tweaked.cards['ZZ99-999'] = moved;

  const r = advise(tweaked, a);
  assert.equal(r.addN, moved, 'wants the removed card back');
  assert.equal(r.cutN, moved, 'wants the filler gone');
  assert.ok(r.balanced, 'adds and cuts balance on a 50-card deck');
});
