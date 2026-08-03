/* Deck Builder — the design's filter rail / card pool / deck panel layout.
 *
 * Extends the mockup in two places the design couldn't cover without data:
 * a Leader picker (nothing else is legal until one is chosen), and live meta
 * context on each pool card showing how much of the field runs it.
 */

import { h, fill, toast, fmt, announce } from './dom.js';
import { cardTile, cardSummary, costLabel, costTitle } from './card.js';
import { attachPreview } from './preview.js';
import {
  COLORS, CATEGORIES, searchCards, getCards, allSets, matchesLeader,
} from '../data/cards.js';
import {
  DECK_SIZE, addCard, removeCard, totalCards, validate, deckStats, groupedDeck, deckToText,
} from '../data/deck.js';
import { copyLimit } from '../engine/cardtext.js';
import { archetypeFor, fmtPct } from '../data/meta.js';

const POOL_LIMIT = 240;   // enough to browse; refine the search past this

export function createBuilder(app) {
  const filters = {
    query: '', colors: new Set(), cost: '', category: '', set: '', legalOnly: true,
  };

  const els = {};

  /* ------------------------------------------------------------------ */
  /* left rail — filters                                                 */
  /* ------------------------------------------------------------------ */
  function railLeft() {
    const searchInput = h('input.input', {
      type: 'search', placeholder: 'name, effect, id…', value: filters.query,
      'aria-label': 'Search cards',
      oninput: e => { filters.query = e.target.value; renderPool(); },
    });
    els.search = searchInput;

    const colorRow = h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '5px' } },
      COLORS.map(c => {
        const on = filters.colors.has(c);
        return h('button.chip', {
          'aria-pressed': String(on),
          style: on ? {
            background: `var(--c-${c.toLowerCase()})`,
            borderColor: `var(--c-${c.toLowerCase()})`,
            color: c === 'Yellow' ? '#241d00' : '#fff',
          } : {},
          onclick: () => {
            filters.colors.has(c) ? filters.colors.delete(c) : filters.colors.add(c);
            rerenderRail(); renderPool();
          },
        }, c);
      }));

    const costRow = h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '4px' } },
      ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10'].map(k => {
        const on = filters.cost === k;
        return h('button.chip.chip-cost', {
          'aria-pressed': String(on),
          style: on ? { background: 'rgba(91,157,255,.16)', borderColor: 'rgba(91,157,255,.5)', color: '#bcd6ff' } : {},
          onclick: () => { filters.cost = on ? '' : k; rerenderRail(); renderPool(); },
        }, k === '10' ? '10+' : k);
      }));

    const typeRow = h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '5px' } },
      CATEGORIES.map(t => {
        const on = filters.category === t;
        return h('button.chip', {
          'aria-pressed': String(on),
          style: on ? { background: 'rgba(91,157,255,.16)', borderColor: 'rgba(91,157,255,.5)', color: '#bcd6ff' } : {},
          onclick: () => { filters.category = on ? '' : t; rerenderRail(); renderPool(); },
        }, t);
      }));

    const setSelect = h('select.input', {
      'aria-label': 'Filter by set',
      onchange: e => { filters.set = e.target.value; renderPool(); },
    },
      h('option', { value: '' }, 'All sets'),
      allSets().map(s => h('option', { value: s, selected: filters.set === s }, s)),
    );

    return h('aside.rail', { style: { width: '212px' } },
      h('div', h('div.eyebrow', { style: { marginBottom: '8px' } }, 'Search'), searchInput),
      h('div', h('div.eyebrow', { style: { marginBottom: '8px' } }, 'Colour'), colorRow),
      h('div', h('div.eyebrow', { style: { marginBottom: '8px' } }, 'Cost'), costRow),
      h('div', h('div.eyebrow', { style: { marginBottom: '8px' } }, 'Type'), typeRow),
      h('div', h('div.eyebrow', { style: { marginBottom: '8px' } }, 'Set'), setSelect),
      h('label', {
        style: { display: 'flex', alignItems: 'center', gap: '7px', font: '500 11px/1 var(--font)', color: 'var(--tx-4)', cursor: 'pointer' },
      },
        h('input', {
          type: 'checkbox', checked: filters.legalOnly,
          onchange: e => { filters.legalOnly = e.target.checked; renderPool(); },
        }),
        'Only Leader-legal',
      ),
      h('div.spacer'),
      h('button.btn-ghost', {
        onclick: () => {
          filters.query = ''; filters.colors.clear(); filters.cost = '';
          filters.category = ''; filters.set = ''; filters.legalOnly = true;
          rerenderRail(); renderPool();
        },
      }, 'Clear filters'),
    );
  }

  function rerenderRail() {
    const next = railLeft();
    els.railLeft.replaceWith(next);
    els.railLeft = next;
  }

  /* ------------------------------------------------------------------ */
  /* centre — card pool                                                  */
  /* ------------------------------------------------------------------ */
  function renderPool() {
    const db = getCards();
    const leader = app.deck.leader ? db[app.deck.leader] : null;
    const list = searchCards({ ...filters, leader });
    const shown = list.slice(0, POOL_LIMIT);
    const arch = archetypeFor(app.deck.leader);
    const usage = arch ? Object.fromEntries(arch.cards.map(c => [c.id, c])) : null;

    fill(els.poolCount, `${list.length} result${list.length === 1 ? '' : 's'}`);

    if (!shown.length) {
      fill(els.poolGrid, h('div.empty-note', { style: { gridColumn: '1/-1' } },
        'Nothing matches those filters.'));
      return;
    }

    fill(els.poolGrid, shown.map(c => {
      const qty = app.deck.cards[c.id] || 0;
      const isLeaderCard = c.category === 'Leader';
      const illegal = !isLeaderCard && leader && !matchesLeader(c, leader);
      const u = usage?.[c.id];

      const tile = cardTile(c, {
        count: isLeaderCard ? null : qty,
        illegal,
        selected: isLeaderCard && app.deck.leader === c.id,
        badge: isLeaderCard ? 'LEADER' : undefined,
        onClick: () => {
          if (isLeaderCard) { setLeader(c.id); return; }
          const r = addCard(app.deck, c.id);
          if (!r.ok) return toast(r.reason, 'bad');
          app.deckChanged();
        },
        onContextMenu: e => { e.preventDefault(); if (removeCard(app.deck, c.id).ok) app.deckChanged(); },
      });

      return h('div',
        tile,
        isLeaderCard
          ? h('div.stepper',
            h('button.add', {
              style: { flex: '1', width: 'auto' },
              onclick: () => setLeader(c.id),
            }, app.deck.leader === c.id ? 'Leader ✓' : 'Set Leader'))
          : h('div.stepper',
            h('button', {
              disabled: !qty, 'aria-label': `Remove ${c.name}`,
              onclick: () => { if (removeCard(app.deck, c.id).ok) app.deckChanged(); },
            }, '−'),
            h('div.q', `${qty}/${copyLimit(c)}`),
            h('button.add', {
              disabled: qty >= copyLimit(c) || totalCards(app.deck) >= DECK_SIZE,
              'aria-label': `Add ${c.name}`,
              onclick: () => {
                const r = addCard(app.deck, c.id);
                if (!r.ok) return toast(r.reason, 'bad');
                app.deckChanged();
              },
            }, '+'),
          ),
        // Meta context: what the field actually does with this card.
        u ? h('div', {
          style: { font: '500 8.5px/1.4 var(--mono)', color: 'var(--tx-5)', marginTop: '4px', textAlign: 'center' },
          title: `${fmtPct(u.include)} of ${arch.name} lists run this, usually ${u.modal}`,
        }, `${fmtPct(u.include)} of field · ${u.modal}x`) : null,
      );
    }).concat(
      list.length > POOL_LIMIT
        ? [h('div.empty-note', { style: { gridColumn: '1/-1' } },
          `${fmt(list.length - POOL_LIMIT)} more match — refine the search to see them.`)]
        : []
    ));
  }

  function setLeader(id) {
    const db = getCards();
    app.deck.leader = id;
    // Dropping colour-illegal cards silently would lose work; warn instead.
    const bad = Object.keys(app.deck.cards).filter(cid => db[cid] && !matchesLeader(db[cid], db[id]));
    if (bad.length) toast(`${bad.length} card(s) no longer share a colour with this Leader.`, 'bad');
    app.deckChanged();
    announce(`Leader set to ${db[id]?.name || id}`);
  }

  /* ------------------------------------------------------------------ */
  /* right rail — the deck                                               */
  /* ------------------------------------------------------------------ */
  function renderDeck() {
    const db = getCards();
    const n = totalCards(app.deck);
    const stats = deckStats(app.deck);
    const problems = validate(app.deck);
    const leader = app.deck.leader ? db[app.deck.leader] : null;

    const pctFull = Math.min(100, (n / DECK_SIZE) * 100);
    const fillColor = n === DECK_SIZE ? 'var(--ok)' : n > DECK_SIZE ? 'var(--danger)' : 'var(--accent)';

    fill(els.deckHead,
      h('input.input', {
        value: app.deck.name, placeholder: 'Untitled deck', 'aria-label': 'Deck name',
        style: { marginBottom: '9px', font: '600 13px/1.2 var(--font)' },
        oninput: e => { app.deck.name = e.target.value; app.persist(); app.renderChrome(); },
      }),
      h('div.row',
        h('div.meter', h('i', { style: { width: `${pctFull}%`, background: fillColor } })),
        h('div', { style: { font: '700 11px/1 var(--mono)', color: fillColor } }, `${n}/${DECK_SIZE}`),
      ),
      h('div', { style: { font: '400 10px/1.4 var(--font)', color: 'var(--tx-4)', marginTop: '7px' } },
        problems.length
          ? problems[0].msg
          : `Legal · ${leader?.name ?? 'no leader'} · ${stats.life} life · ${stats.donDeck} DON!! deck`),
    );

    // curve
    const max = Math.max(1, ...stats.curve);
    fill(els.curve, stats.curve.map((v, i) =>
      h('div.bar', { title: `${v} card${v === 1 ? '' : 's'} at cost ${i}${i === 10 ? '+' : ''}` },
        h('div.n', v || ''),
        h('i', { style: { height: `${(v / max) * 100}%`, background: v ? 'var(--accent)' : 'rgba(255,255,255,.06)' } }),
        h('div.k', i === 10 ? '10+' : i),
      )));

    // grouped list
    const groups = groupedDeck(app.deck);
    const order = [['Character', stats.characters], ['Event', stats.events], ['Stage', stats.stages]];
    fill(els.deckList,
      leader ? h('div', { style: { marginBottom: '13px' } },
        h('div.group-head', h('div.eyebrow.eyebrow-14', 'Leader'), h('div.line')),
        deckRow(leader, 1, true),
      ) : null,
      order.map(([cat, count]) => {
        const rows = groups[cat] || [];
        if (!rows.length) return null;
        return h('div', { style: { marginBottom: '13px' } },
          h('div.group-head',
            h('div.eyebrow.eyebrow-14', cat),
            h('div.line'),
            h('div', { style: { font: '600 9.5px/1 var(--mono)', color: 'var(--tx-6)' } }, count),
          ),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: '3px' } },
            rows.map(r => deckRow(r.card, r.qty))),
        );
      }),
      n === 0 && !leader ? h('div.empty-note', 'Pick a Leader, then click cards to add them.') : null,
    );

    fill(els.deckFoot,
      h('button.btn-pri', {
        style: { flex: '1' },
        disabled: problems.length > 0,
        title: problems.length ? problems[0].msg : 'Play this deck against the field',
        onclick: () => app.go('board'),
      }, problems.length ? 'Deck not legal' : 'Playtest this deck'),
      h('button.btn', {
        onclick: () => {
          navigator.clipboard?.writeText(deckToText(app.deck))
            .then(() => toast('Deck list copied.', 'good'))
            .catch(() => toast('Could not access the clipboard.', 'bad'));
        },
      }, 'Export'),
    );
  }

  function deckRow(card, qty, isLeader = false) {
    const color = (card.colors || [])[0] || 'Black';
    return attachPreview(h('button.dl-row', {
      onclick: () => {
        if (isLeader) { app.deck.leader = null; app.deckChanged(); return; }
        if (removeCard(app.deck, card.id).ok) app.deckChanged();
      },
    },
      h('div.cost', { title: costTitle(card) }, costLabel(card)),
      h('div.swatch', { style: { background: `var(--c-${String(color).toLowerCase()})` } }),
      h('div.nm', card.name),
      h('div.qty', isLeader ? '' : `×${qty}`),
    ), card);
  }

  /* ------------------------------------------------------------------ */
  /* assembly                                                            */
  /* ------------------------------------------------------------------ */
  els.railLeft = railLeft();
  els.poolCount = h('div.count');
  els.poolGrid = h('div', {
    style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(126px,1fr))', gap: '11px' },
  });
  els.curve = h('div.curve');
  els.deckHead = h('div', { style: { padding: '13px 14px', borderBottom: '1px solid rgba(255,255,255,.06)', flex: 'none' } });
  els.deckList = h('div', { style: { flex: '1', overflow: 'auto', padding: '11px 13px', minHeight: '0' } });
  els.deckFoot = h('div', {
    style: { flex: 'none', padding: '12px 13px', borderTop: '1px solid rgba(255,255,255,.06)', display: 'flex', gap: '7px' },
  });

  const root = h('div.view', { id: 'view-builder' },
    els.railLeft,
    h('main.pane',
      h('div.pane-title', h('h2', 'Card pool'), els.poolCount),
      els.poolGrid,
    ),
    h('aside.rail.rail-r', { style: { width: '308px' } },
      els.deckHead,
      h('div', { style: { padding: '12px 14px', borderBottom: '1px solid rgba(255,255,255,.06)', flex: 'none' } },
        h('div.eyebrow', { style: { marginBottom: '9px' } }, 'Cost curve'),
        els.curve,
      ),
      els.deckList,
      els.deckFoot,
    ),
  );

  return {
    root,
    render() { renderPool(); renderDeck(); },
    onDeckChange() { renderPool(); renderDeck(); },
    focusSearch() { els.search?.focus(); },
  };
}
