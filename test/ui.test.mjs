/* UI smoke tests.
 *
 * There is no jsdom dependency, so this installs a small DOM shim — enough to
 * let the hyperscript helper and the view modules build their trees. It catches
 * the failures that actually happen when refactoring this kind of code:
 * a renamed export, a helper called with the wrong shape, a view that throws
 * while rendering an empty or half-built deck.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

/* ---------------------------------------------------------------------- */
/* minimal DOM                                                             */
/* ---------------------------------------------------------------------- */

/* DOMTokenList-alike. A bare Set is close but has `delete` where the DOM has
 * `remove`, which hides real failures in code that calls classList.remove(). */
class ClassList extends Set {
  add(...names) { for (const n of names) super.add(n); return this; }
  remove(...names) { for (const n of names) this.delete(n); return this; }
  contains(n) { return this.has(n); }
  toggle(n, force) {
    const on = force ?? !this.has(n);
    on ? super.add(n) : this.delete(n);
    return on;
  }
}

class Node_ {
  constructor(tag = '') {
    this.tagName = String(tag).toUpperCase();
    this.childNodes = [];
    this.attributes = {};
    this.style = {};
    this.dataset = {};
    this.classList = new ClassList();
    this.listeners = {};
    this.parentNode = null;
    this._text = '';
  }
  get className() { return [...this.classList].join(' '); }
  set className(v) { this.classList = new ClassList(String(v).split(/\s+/).filter(Boolean)); }
  get textContent() {
    return this.childNodes.length
      ? this.childNodes.map(c => c.textContent).join('')
      : this._text;
  }
  set textContent(v) { this.childNodes = []; this._text = String(v); }
  set innerHTML(v) { this._text = String(v); }
  appendChild(c) { c.parentNode = this; this.childNodes.push(c); return c; }
  removeChild(c) { this.childNodes = this.childNodes.filter(x => x !== c); return c; }
  remove() { this.parentNode?.removeChild(this); }
  replaceWith(next) {
    const p = this.parentNode;
    if (!p) return;
    const i = p.childNodes.indexOf(this);
    if (i >= 0) { p.childNodes[i] = next; next.parentNode = p; }
  }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return this.attributes[k] ?? null; }
  addEventListener(k, fn) { (this.listeners[k] ||= []).push(fn); }
  removeEventListener() {}
  matches() { return false; }
  focus() {}
  blur() {}
  /** Depth-first walk, used by the assertions below. */
  *walk() { yield this; for (const c of this.childNodes) if (c.walk) yield* c.walk(); }
  querySelector() { return null; }
  querySelectorAll() { return []; }
}

class TextNode extends Node_ {
  constructor(t) { super('#text'); this._text = String(t); }
  get textContent() { return this._text; }
  *walk() { yield this; }
}

function installDom() {
  const doc = {
    createElement: t => new Node_(t),
    createTextNode: t => new TextNode(t),
    createDocumentFragment: () => new Node_('#fragment'),
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => new Node_('div'),
    body: new Node_('body'),
    addEventListener() {},
  };
  globalThis.document = doc;
  globalThis.Node = Node_;
  globalThis.window = { addEventListener() {}, location: { hash: '' } };
  globalThis.requestAnimationFrame = fn => setTimeout(fn, 0);
  globalThis.localStorage = {
    _s: {},
    getItem(k) { return this._s[k] ?? null; },
    setItem(k, v) { this._s[k] = String(v); },
  };
  // Node defines navigator as a getter-only global, so patch rather than replace.
  if (!globalThis.navigator?.clipboard) {
    Object.defineProperty(globalThis, 'navigator', {
      value: { clipboard: { writeText: async () => {} } },
      configurable: true, writable: true,
    });
  }
  Object.defineProperty(globalThis, 'location', {
    value: { origin: 'http://x', pathname: '/', hash: '' },
    configurable: true, writable: true,
  });
  globalThis.confirm = () => true;
  globalThis.fetch = async () => { throw new Error('offline in tests'); };
}

installDom();

/* ---------------------------------------------------------------------- */
/* fixtures                                                                */
/* ---------------------------------------------------------------------- */

const CARDS = {
  'ST01-001': { id: 'ST01-001', name: 'Test Leader', category: 'Leader', colors: ['Red'], cost: 4, power: 5000, effect: '-', types: [] },
  'ST01-002': { id: 'ST01-002', name: 'Alpha', category: 'Character', colors: ['Red'], cost: 2, power: 3000, counter: 1000, effect: '-', types: [] },
  'ST01-003': { id: 'ST01-003', name: 'Beta', category: 'Character', colors: ['Red'], cost: 5, power: 7000, counter: null, effect: '[Blocker]', types: [] },
  'ST01-004': { id: 'ST01-004', name: 'Gamma', category: 'Character', colors: ['Blue'], cost: 3, power: 4000, counter: 2000, effect: '-', types: [] },
  'ST01-005': { id: 'ST01-005', name: 'Delta', category: 'Event', colors: ['Red'], cost: 1, power: null, counter: null, effect: '[Counter] +3000 power during this battle.', types: [] },
};

let dom, cards, deckMod, cardUi;

before(async () => {
  dom = await import('../src/ui/dom.js');
  cards = await import('../src/data/cards.js');
  deckMod = await import('../src/data/deck.js');
  cardUi = await import('../src/ui/card.js');
  // Prime the card database without hitting the network.
  cards.setCards(CARDS);
});

const textOf = el => [...el.walk()].map(n => (n instanceof TextNode ? n.textContent : '')).join('');

/* ---------------------------------------------------------------------- */
/* dom helper                                                              */
/* ---------------------------------------------------------------------- */

test('h() builds elements with class, id and event shorthand', () => {
  const { h } = dom;
  let clicked = 0;
  const el = h('button.btn.is-on#go', { onclick: () => clicked++ }, 'Hello');
  assert.equal(el.tagName, 'BUTTON');
  assert.ok(el.classList.has('btn') && el.classList.has('is-on'));
  assert.equal(el.id, 'go');
  assert.equal(textOf(el), 'Hello');
  el.listeners.click[0]();
  assert.equal(clicked, 1);
});

test('h() accepts children without a props object', () => {
  const { h } = dom;
  const el = h('div', h('span', 'a'), h('span', 'b'));
  assert.equal(el.childNodes.length, 2);
  assert.equal(textOf(el), 'ab');
});

test('h() skips null and false children', () => {
  const { h } = dom;
  const el = h('div', null, false, 'kept', undefined);
  assert.equal(textOf(el), 'kept');
});

test('h() renders a falsy first child instead of mistaking it for props', () => {
  const { h } = dom;
  // Regression: testing truthiness swallowed `0`, which is how a cost of 0
  // silently disappeared from card tiles.
  assert.equal(textOf(h('div', 0)), '0');
  assert.equal(textOf(h('div', 0, ' left')), '0 left');
  assert.equal(textOf(h('div', { title: 't' }, 0)), '0');
  // An array first argument is children, not props.
  assert.equal(textOf(h('div', ['a', 'b'])), 'ab');
});

test('fill() replaces children', () => {
  const { h, fill } = dom;
  const el = h('div', 'old');
  fill(el, h('span', 'new'));
  assert.equal(textOf(el), 'new');
});

/* ---------------------------------------------------------------------- */
/* card tile                                                               */
/* ---------------------------------------------------------------------- */

test('cardTile renders name, id and cost, and carries colour vars', () => {
  const el = cardUi.cardTile(CARDS['ST01-002'], {});
  const t = textOf(el);
  assert.ok(t.includes('Alpha'), 'name present');
  assert.ok(t.includes('ST01-002'), 'id present');
  assert.ok(t.includes('3,000'), 'power formatted');
  assert.ok(el.style['--cbd'], 'colour custom property set');
});

test('cardTile marks state classes', () => {
  const rested = cardUi.cardTile(CARDS['ST01-002'], { rested: true });
  assert.ok(rested.classList.has('is-rested'));
  const sel = cardUi.cardTile(CARDS['ST01-002'], { selected: true });
  assert.ok(sel.classList.has('is-selected'));
  const tgt = cardUi.cardTile(CARDS['ST01-002'], { target: true });
  assert.ok(tgt.classList.has('is-target'));
});

test('cardTile shows a dash, not 0, for a card with no printed cost', () => {
  // Several Events genuinely have no cost — they are paid for by an activation
  // cost in their text. Rendering 0 would claim they are free.
  const noCost = { id: 'OP15-075', name: 'El Thor', category: 'Event', colors: ['Purple'], cost: null, power: null, effect: '[Main] DON!! -1: draw 1 card.' };
  assert.ok(textOf(cardUi.cardTile(noCost, {})).includes('—'), 'dash shown for null cost');
  assert.equal(cardUi.costLabel(noCost), '—');
  assert.equal(cardUi.costLabel({ cost: 0 }), '0', 'a real zero cost still shows 0');
  assert.equal(cardUi.costLabel({ cost: 3 }), '3');
});

test('the pool hides other Leaders once one is chosen', async () => {
  const { searchCards, setCards } = cards;
  setCards({
    ...CARDS,
    'OP02-001': { id: 'OP02-001', name: 'Other Leader', category: 'Leader', colors: ['Red'], cost: 5, power: 5000, effect: '-', types: [] },
    'OP03-001': { id: 'OP03-001', name: 'Blue Leader', category: 'Leader', colors: ['Blue'], cost: 5, power: 5000, effect: '-', types: [] },
  });
  const leader = cards.getCards()['ST01-001'];

  const withLeader = searchCards({ leader, legalOnly: true });
  const otherLeaders = withLeader.filter(c => c.category === 'Leader' && c.id !== leader.id);
  assert.equal(otherLeaders.length, 0, 'other Leaders are filtered out of the pool');
  assert.ok(withLeader.some(c => c.id === 'ST01-002'), 'colour-legal cards remain');

  // Still reachable deliberately, via the Leader type filter.
  const browsing = searchCards({ leader, legalOnly: true, category: 'Leader' });
  assert.ok(browsing.length > 1, 'the Leader filter still shows them all');

  // With no Leader chosen, Leaders sort to the front.
  const none = searchCards({ legalOnly: true });
  assert.equal(none[0].category, 'Leader', 'Leaders lead while you still need one');
});

test('the hover preview transcribes the card text, not just the art', async () => {
  const preview = await import('../src/ui/preview.js');
  const card = {
    id: 'ST01-006', name: 'Reader', category: 'Character', colors: ['Red'],
    cost: 3, power: 5000, counter: 1000, types: ['Crew'],
    effect: '[Blocker]<br>[On Play] Draw 1 card.',
    trigger: '[Trigger] Play this card.',
  };
  preview.showPreview(card, 100, 100);
  const el = document.body.childNodes.find(n => n.id === 'cardpreview');
  assert.ok(el, 'preview element mounted');
  const t = textOf(el);
  // Art can fail to load, so the text has to be there independently.
  assert.ok(t.includes('Reader'), 'name');
  assert.ok(t.includes('ST01-006'), 'id');
  assert.ok(t.includes('Draw 1 card'), 'effect text transcribed');
  assert.ok(t.includes('Play this card'), 'trigger text transcribed');
  assert.ok(t.includes('Blocker'), 'keyword surfaced');
  assert.ok(t.includes('1,000'), 'counter value shown');

  preview.hidePreview();
  assert.ok(!el.classList.has('is-on'), 'hides again');
});

test('attachPreview wires handlers without creating per-tile DOM', async () => {
  const preview = await import('../src/ui/preview.js');
  const before = document.body.childNodes.length;
  const card = { id: 'ST01-002', name: 'Alpha', category: 'Character', colors: ['Red'], cost: 2, power: 3000, effect: '-' };
  for (let i = 0; i < 50; i++) preview.attachPreview(dom.h('div'), card);
  assert.equal(document.body.childNodes.length, before,
    'attaching to 50 tiles adds no nodes — one shared panel serves the whole grid');
});

test('cardTile renders an empty slot when given no card', () => {
  const el = cardUi.cardTile(null, { emptyLabel: '3' });
  assert.ok(el.classList.has('slot-empty'));
  assert.equal(textOf(el), '3');
});

/* ---------------------------------------------------------------------- */
/* deck model                                                              */
/* ---------------------------------------------------------------------- */

test('deck enforces the copy limit and the 50-card cap', () => {
  const d = deckMod.emptyDeck();
  for (let i = 0; i < 4; i++) assert.equal(deckMod.addCard(d, 'ST01-002').ok, true);
  const fifth = deckMod.addCard(d, 'ST01-002');
  assert.equal(fifth.ok, false);
  assert.match(fifth.reason, /Max 4/);
  assert.equal(d.cards['ST01-002'], 4);
});

test('deck validation catches colour, size and leader problems', () => {
  const d = deckMod.emptyDeck();
  assert.ok(deckMod.validate(d).some(p => /No Leader/.test(p.msg)));

  d.leader = 'ST01-001';
  d.cards = { 'ST01-002': 4, 'ST01-004': 4 };   // ST01-004 is Blue, leader is Red
  const problems = deckMod.validate(d);
  assert.ok(problems.some(p => /shares no colour/.test(p.msg)), 'colour legality enforced');
  assert.ok(problems.some(p => /short of 50/.test(p.msg)), 'size enforced');
});

test('deck stats compute curve, counters and blockers', () => {
  const d = deckMod.emptyDeck();
  d.leader = 'ST01-001';
  d.cards = { 'ST01-002': 4, 'ST01-003': 2, 'ST01-005': 1 };
  const s = deckMod.deckStats(d);
  assert.equal(s.total, 7);
  assert.equal(s.curve[2], 4, 'four cards at cost 2');
  assert.equal(s.curve[5], 2, 'two cards at cost 5');
  assert.equal(s.counterCards, 4, 'only ST01-002 has a printed counter');
  assert.equal(s.blockers, 2, 'ST01-003 is a blocker');
  assert.equal(s.characters, 6);
  assert.equal(s.events, 1);
});

test('deck text round-trips through import and export', () => {
  const d = deckMod.emptyDeck();
  d.leader = 'ST01-001';
  d.cards = { 'ST01-002': 4, 'ST01-003': 2 };
  const text = deckMod.deckToText(d);
  const { deck: back } = deckMod.parseDeckText(text);
  assert.equal(back.leader, 'ST01-001');
  assert.deepEqual(back.cards, d.cards);
});

test('share links round-trip through the URL fragment', () => {
  const d = deckMod.emptyDeck();
  d.name = 'My Deck';
  d.leader = 'ST01-001';
  d.cards = { 'ST01-002': 3 };
  const back = deckMod.decodeDeck('#' + deckMod.encodeDeck(d));
  assert.equal(back.leader, 'ST01-001');
  assert.equal(back.name, 'My Deck');
  assert.deepEqual(back.cards, { 'ST01-002': 3 });
});

test('reconcile drops unknown ids without throwing', () => {
  const d = deckMod.emptyDeck();
  d.leader = 'ST01-001';
  d.cards = { 'ST01-002': 2, 'NOPE-999': 3 };
  const dropped = deckMod.reconcile(d);
  assert.deepEqual(dropped, ['NOPE-999']);
  assert.deepEqual(d.cards, { 'ST01-002': 2 });
});

/* ---------------------------------------------------------------------- */
/* views build without throwing                                            */
/* ---------------------------------------------------------------------- */

test('builder, board and meta views construct and render', async () => {
  const { createBuilder } = await import('../src/ui/builder.js');
  const { createBoard } = await import('../src/ui/board.js');
  const { createMeta } = await import('../src/ui/meta.js');

  const deck = deckMod.emptyDeck();
  const app = {
    deck, view: 'builder',
    go() {}, deckChanged() {}, persist() {}, renderChrome() {},
  };

  // Empty deck — the state a first-time user actually starts in.
  for (const make of [createBuilder, createBoard, createMeta]) {
    const v = make(app);
    assert.ok(v.root, 'view produced a root node');
    v.render();
  }

  // Half-built deck with a leader.
  deck.leader = 'ST01-001';
  deck.cards = { 'ST01-002': 4, 'ST01-003': 2 };
  for (const make of [createBuilder, createBoard, createMeta]) {
    const v = make(app);
    v.render();
    v.onDeckChange?.();
  }
});

test('the explain writer covers every log kind the engine emits', async () => {
  const { explain } = await import('../src/ui/explain.js');
  const kinds = ['attack', 'battle', 'damage', 'counter', 'block', 'don', 'play', 'ko', 'trigger', 'draw', 'end', 'effect', 'cost', 'phase'];
  for (const kind of kinds) {
    const r = explain({ kind, text: 'something happened', turn: 3 }, { beginner: true });
    assert.ok(r.title && r.body && r.rule, `${kind} produced a full explanation`);
    assert.ok(r.rule.length > 20, `${kind} has a real rule note`);
  }
  const none = explain(null);
  assert.match(none.title, /Nothing to explain/);
});
