/* App shell: header, routing, deck state, persistence.
 *
 * No build step and no framework — ES modules straight to the browser. Serve
 * the folder over HTTP (`npm start`); ES modules and the meta.json fetch don't
 * work from a file:// URL.
 */

import { h, fill, toast, $ } from './ui/dom.js';
import { loadCards, isLoaded } from './data/cards.js';
import { loadMeta } from './data/meta.js';
import {
  emptyDeck, totalCards, validate, encodeDeck, decodeDeck,
  saveDecks, loadDecks, reconcile, DECK_SIZE,
} from './data/deck.js';
import { createBuilder } from './ui/builder.js';
import { createBoard } from './ui/board.js';
import { createMeta } from './ui/meta.js';

const VIEWS = [
  ['board', 'Playtest'],
  ['builder', 'Deck Builder'],
  ['meta', 'Meta'],
];

const app = {
  deck: emptyDeck(),
  view: 'builder',
  go, deckChanged, persist, renderChrome,
};

let views = {};
const els = {};

/* ---------------------------------------------------------------------- */
/* chrome                                                                  */
/* ---------------------------------------------------------------------- */

function buildChrome() {
  els.tabs = h('nav.tabs', { role: 'tablist' },
    VIEWS.map(([k, label]) => h('button', {
      role: 'tab', 'aria-selected': String(app.view === k),
      onclick: () => go(k),
    }, label)));

  els.deckChip = h('div.deckchip');
  els.status = h('div', { style: { font: '500 10px/1 var(--mono)', color: 'var(--tx-5)' } });

  els.header = h('header.appbar',
    h('div.brand',
      h('div.brand-mark', 'DL'),
      h('div.brand-name', 'DECK LAB'),
      h('div.brand-tag', 'OPTCG'),
    ),
    els.tabs,
    els.deckChip,
    h('div.spacer'),
    els.status,
    h('button.btn', { onclick: () => views.board?.toggleHelp() }, 'Rules ref'),
    h('button.btn', {
      onclick: () => {
        const url = `${location.origin}${location.pathname}#${encodeDeck(app.deck)}`;
        navigator.clipboard?.writeText(url)
          .then(() => toast('Share link copied — the whole deck is in the URL.', 'good'))
          .catch(() => toast('Could not access the clipboard.', 'bad'));
      },
    }, 'Share'),
    h('button.btn', {
      onclick: () => {
        if (!confirm('Clear the current deck?')) return;
        app.deck = emptyDeck();
        deckChanged();
      },
    }, 'New deck'),
  );

  els.main = h('div', { style: { flex: '1', display: 'flex', minHeight: '0' } });
  return h('div#app', els.header, els.main);
}

function renderChrome() {
  fill(els.tabs, VIEWS.map(([k, label]) => h('button', {
    role: 'tab', 'aria-selected': String(app.view === k),
    onclick: () => go(k),
  }, label)));

  const n = totalCards(app.deck);
  const problems = validate(app.deck);
  const ok = problems.length === 0;

  fill(els.deckChip,
    h('div.dot', {
      style: { background: ok ? 'var(--ok)' : 'var(--danger)', boxShadow: `0 0 0 3px ${ok ? 'rgba(79,211,154,.16)' : 'rgba(224,87,79,.16)'}` },
    }),
    h('div.nm', app.deck.name || 'Untitled deck'),
    h('div.meta', `${n}/${DECK_SIZE} · ${ok ? 'legal' : (problems[0]?.msg ?? 'not legal')}`),
  );
}

/* ---------------------------------------------------------------------- */
/* routing                                                                 */
/* ---------------------------------------------------------------------- */

function go(name) {
  if (!views[name]) return;
  app.view = name;
  fill(els.main, views[name].root);
  views[name].render();
  renderChrome();
}

function deckChanged() {
  persist();
  renderChrome();
  for (const v of Object.values(views)) v.onDeckChange?.();
  if (app.view && views[app.view]) views[app.view].render();
}

function persist() {
  saveDecks([app.deck], 0);
}

/* ---------------------------------------------------------------------- */
/* boot                                                                    */
/* ---------------------------------------------------------------------- */

async function boot() {
  document.body.appendChild(buildChrome());
  fill(els.main, h('div.pane', h('div', {
    style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(126px,1fr))', gap: '11px' },
  }, Array.from({ length: 18 }, () => h('div.skeleton')))));
  els.status.textContent = 'loading card data…';

  try {
    await loadCards((done, total) => {
      els.status.textContent = `loading cards ${done}/${total}…`;
    });
  } catch (err) {
    els.status.textContent = 'card data failed to load';
    fill(els.main, h('div.pane', h('div.empty-note',
      `Could not load the card database: ${err.message}. Check your connection and reload.`)));
    return;
  }

  await loadMeta();

  // Restore: a share link in the URL wins over local storage.
  const fromUrl = location.hash.length > 3 ? decodeDeck(location.hash) : null;
  if (fromUrl) {
    app.deck = fromUrl;
  } else {
    const saved = loadDecks();
    if (saved.decks[0]) app.deck = { ...emptyDeck(), ...saved.decks[0] };
  }
  const dropped = reconcile(app.deck);
  if (dropped.length) toast(`Removed ${dropped.length} unknown card id(s).`, 'bad');

  views = {
    builder: createBuilder(app),
    board: createBoard(app),
    meta: createMeta(app),
  };

  const cardCount = Object.keys(await loadCards()).length;
  els.status.textContent = `${cardCount.toLocaleString()} cards`;

  go(totalCards(app.deck) ? 'builder' : 'meta');

  // Keyboard: quick view switching and search focus.
  window.addEventListener('keydown', e => {
    if (e.target.matches('input, textarea, select')) {
      if (e.key === 'Escape') e.target.blur();
      return;
    }
    if (e.key === '1') go('board');
    else if (e.key === '2') go('builder');
    else if (e.key === '3') go('meta');
    else if (e.key === '/') { e.preventDefault(); go('builder'); views.builder.focusSearch(); }
  });

  window.addEventListener('hashchange', () => {
    const d = decodeDeck(location.hash);
    if (!d) return;
    app.deck = d;
    reconcile(app.deck);
    deckChanged();
    toast('Loaded deck from the link.', 'good');
  });
}

boot().catch(err => {
  console.error(err);
  document.body.appendChild(h('div.pane', h('div.empty-note', `Startup failed: ${err.message}`)));
});
