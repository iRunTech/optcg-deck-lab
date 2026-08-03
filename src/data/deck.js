/* The deck model: validation, stats, import/export, persistence.
 *
 * A deck is `{ name, leader, cards: { [cardId]: count } }`. The leader is kept
 * outside `cards` because it isn't part of the 50.
 */

import { getCards, matchesLeader } from './cards.js';
import { copyLimit, keywords, cardText, lifeTotal, donDeckSize } from '../engine/cardtext.js';

export const DECK_SIZE = 50;
const STORE_KEY = 'optcg-deck-lab:v2';

export const emptyDeck = () => ({ name: '', leader: null, cards: {} });

export const totalCards = d => Object.values(d.cards).reduce((a, b) => a + b, 0);

/* ---------------------------------------------------------------------- */
/* mutation                                                                */
/* ---------------------------------------------------------------------- */

/** Add one copy. Returns `{ ok, reason }` so the caller can explain a refusal. */
export function addCard(deck, id) {
  const db = getCards();
  const c = db[id];
  if (!c) return { ok: false, reason: 'Unknown card.' };

  if (c.category === 'Leader') {
    deck.leader = id;
    return { ok: true, leaderChanged: true };
  }
  const have = deck.cards[id] || 0;
  const limit = copyLimit(c);
  if (have >= limit) return { ok: false, reason: `Max ${limit} copies of ${c.name}.` };
  if (totalCards(deck) >= DECK_SIZE) return { ok: false, reason: `Deck is already at ${DECK_SIZE}.` };

  deck.cards[id] = have + 1;
  return { ok: true };
}

export function removeCard(deck, id) {
  if (deck.leader === id && !deck.cards[id]) { deck.leader = null; return { ok: true, leaderChanged: true }; }
  const have = deck.cards[id] || 0;
  if (!have) return { ok: false };
  if (have === 1) delete deck.cards[id];
  else deck.cards[id] = have - 1;
  return { ok: true };
}

/* ---------------------------------------------------------------------- */
/* validation                                                              */
/* ---------------------------------------------------------------------- */

/** Rule problems, most severe first. Empty means tournament-legal. */
export function validate(deck) {
  const db = getCards();
  const out = [];
  const n = totalCards(deck);
  const leader = deck.leader ? db[deck.leader] : null;

  if (!leader) out.push({ level: 'bad', msg: 'No Leader selected.' });
  if (n !== DECK_SIZE) {
    out.push({
      level: 'bad',
      msg: n < DECK_SIZE ? `${DECK_SIZE - n} card${DECK_SIZE - n === 1 ? '' : 's'} short of ${DECK_SIZE}.`
        : `${n - DECK_SIZE} card${n - DECK_SIZE === 1 ? '' : 's'} over ${DECK_SIZE}.`,
    });
  }

  for (const [id, k] of Object.entries(deck.cards)) {
    const c = db[id];
    if (!c) { out.push({ level: 'bad', msg: `Unknown card ${id}.` }); continue; }
    const lim = copyLimit(c);
    if (k > lim) out.push({ level: 'bad', msg: `${k} copies of ${c.name} — the limit is ${lim}.` });
    if (leader && !matchesLeader(c, leader)) {
      out.push({ level: 'bad', msg: `${c.name} shares no colour with ${leader.name}.` });
    }
  }
  return out;
}

export const isLegal = deck => validate(deck).length === 0;

/* ---------------------------------------------------------------------- */
/* stats                                                                   */
/* ---------------------------------------------------------------------- */

/** Everything the builder's right rail shows. */
export function deckStats(deck) {
  const db = getCards();
  const curve = Array.from({ length: 11 }, () => 0);
  let counterCards = 0, counterPower = 0, blockers = 0, triggers = 0, removal = 0;
  let characters = 0, events = 0, stages = 0, costSum = 0, n = 0;

  for (const [id, k] of Object.entries(deck.cards)) {
    const c = db[id];
    if (!c) continue;
    n += k;
    const cost = Math.min(c.cost ?? 0, 10);
    curve[cost] += k;
    costSum += (c.cost ?? 0) * k;

    if (c.counter) { counterCards += k; counterPower += c.counter * k; }
    if (keywords(c).blocker) blockers += k;
    if (c.trigger) triggers += k;
    if (/K\.?O\.?|power [-−]\d/i.test(cardText(c))) removal += k;

    if (c.category === 'Character') characters += k;
    else if (c.category === 'Event') events += k;
    else if (c.category === 'Stage') stages += k;
  }

  const leader = deck.leader ? db[deck.leader] : null;
  return {
    total: n, curve, characters, events, stages,
    counterCards, counterPower, blockers, triggers, removal,
    avgCost: n ? costSum / n : 0,
    life: leader ? lifeTotal(leader) : null,
    donDeck: leader ? donDeckSize(leader) : null,
    colors: leader ? (leader.colors || []) : [],
  };
}

/** Cards grouped for the deck list panel, sorted by cost then name. */
export function groupedDeck(deck) {
  const db = getCards();
  const groups = { Character: [], Event: [], Stage: [] };
  for (const [id, qty] of Object.entries(deck.cards)) {
    const c = db[id];
    if (!c) continue;
    (groups[c.category] || (groups[c.category] = [])).push({ id, qty, card: c });
  }
  for (const k of Object.keys(groups)) {
    groups[k].sort((a, b) => (a.card.cost ?? 0) - (b.card.cost ?? 0) || a.card.name.localeCompare(b.card.name));
  }
  return groups;
}

/* ---------------------------------------------------------------------- */
/* import / export                                                         */
/* ---------------------------------------------------------------------- */

/** Parse `4xOP15-061`, `4 OP15-061` or a bare id — the usual sim/Limitless export. */
export function parseDeckText(text) {
  const db = getCards();
  const deck = emptyDeck();
  const unknown = [];

  for (const line of String(text).split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#') || s.startsWith('//')) continue;
    const m = /^(?:(\d+)\s*[x×]?\s+|(\d+)\s*[x×])?([A-Z]{2,4}\d{2}-\d{3})\b/i.exec(s);
    if (!m) continue;
    const id = m[3].toUpperCase();
    const qty = +(m[1] || m[2] || 1);
    const c = db[id];
    if (!c) { unknown.push(id); continue; }
    if (c.category === 'Leader') deck.leader = id;
    else deck.cards[id] = (deck.cards[id] || 0) + qty;
  }
  return { deck, unknown };
}

export function deckToText(deck) {
  const lines = [];
  if (deck.leader) lines.push(`1x${deck.leader}`);
  for (const [id, n] of Object.entries(deck.cards).sort()) lines.push(`${n}x${id}`);
  return lines.join('\n');
}

/* Share links keep the whole deck in the URL fragment — nothing is uploaded. */
export function encodeDeck(deck) {
  const body = `${deck.leader || ''}|${Object.entries(deck.cards).map(([i, n]) => `${i}:${n}`).join(',')}`;
  return `d=${encodeURIComponent(body)}&n=${encodeURIComponent(deck.name || '')}`;
}

export function decodeDeck(hash) {
  const params = new URLSearchParams(String(hash).replace(/^#/, ''));
  const d = params.get('d');
  if (!d) return null;
  const [leader, rest] = d.split('|');
  const deck = emptyDeck();
  deck.leader = leader || null;
  deck.name = params.get('n') || '';
  for (const part of (rest || '').split(',')) {
    if (!part) continue;
    const [id, n] = part.split(':');
    if (id) deck.cards[id] = +n || 1;
  }
  return deck;
}

/* ---------------------------------------------------------------------- */
/* persistence                                                             */
/* ---------------------------------------------------------------------- */

export function saveDecks(decks, activeId) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ decks, activeId }));
  } catch { /* private mode / quota — the app still works, it just won't persist */ }
}

export function loadDecks() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (raw && Array.isArray(raw.decks)) return raw;
  } catch { /* corrupt payload — start clean rather than crash the app */ }
  return { decks: [], activeId: null };
}

/** Drop ids that are not in the card database, folding alt printings onto base. */
export function reconcile(deck) {
  const db = getCards();
  const dropped = [];
  for (const id of Object.keys(deck.cards)) {
    if (db[id]) continue;
    const base = id.split('_')[0];
    if (db[base]) {
      deck.cards[base] = Math.min(copyLimit(db[base]), (deck.cards[base] || 0) + deck.cards[id]);
    } else {
      dropped.push(id);
    }
    delete deck.cards[id];
  }
  if (deck.leader && !db[deck.leader]) {
    const base = deck.leader.split('_')[0];
    deck.leader = db[base] ? base : null;
  }
  return dropped;
}
