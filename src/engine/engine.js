/* Headless OPTCG rules engine.
 *
 * No DOM, no timers, no prompts, no globals. A game is a plain object; you
 * advance it by handing it actions. That is what lets the same code run the
 * interactive board, the AI, and a thousand-game batch matchup simulation.
 *
 * The central design change from the prototype: every decision — targeting,
 * blocking, countering, triggers, unparsed card text — surfaces as `G.pending`,
 * a request the *caller* answers with a `choose` action. Human and AI drive the
 * identical code path, so the AI can never quietly skip a step the human gets.
 *
 *   const G = createGame({...});
 *   while (!G.over) {
 *     const action = G.pending ? decide(G, G.pending) : policy(G);
 *     apply(G, action);
 *   }
 */

import { makeRng, shuffle, randInt } from './rng.js';
import { scriptFor } from './scripts.js';
import {
  parseEffects, keywords, counterValue, donDeckSize, lifeTotal, cardText, triggerText, staticBuffs,
} from './cardtext.js';

export const PHASES = ['refresh', 'draw', 'don', 'main', 'end'];
export const PHASE_LABEL = {
  refresh: 'Refresh', draw: 'Draw', don: 'DON!!', main: 'Main', end: 'End',
};
const MAX_CHARS = 5;

/* ---------------------------------------------------------------------- */
/* construction                                                            */
/* ---------------------------------------------------------------------- */

let _uid = 0;
const nextUid = () => `u${++_uid}`;

/**
 * A character in play.
 *
 * `mods` are power adjustments, `baseMods` replace base power outright
 * ("this Character's base power becomes …"), `costMods` adjust cost, and
 * `flags` carry temporary states — cannotAttack, cannotRest, wontRefresh and
 * granted keywords. Every one of them expires by absolute turn number so that
 * "until the end of your opponent's next End Phase" survives correctly instead
 * of being cleared at the next turn boundary.
 */
export function newChar(id, turn) {
  return {
    uid: nextUid(), id, don: 0, rested: false, bornTurn: turn,
    mods: [], baseMods: [], costMods: [], flags: [],
  };
}

/* Expiry scopes, resolved against the current turn counter. */
export function expiryFor(G, scope) {
  switch (scope) {
    case 'turn': return G.turn;                 // "during this turn"
    case 'oppNextEnd': return G.turn + 1;       // "until the end of your opponent's next End Phase"
    case 'myNextRefresh': return G.turn + 1;
    case 'permanent': return Infinity;
    default: return G.turn;
  }
}

const liveFlags = (unit, turn) => (unit.flags || []).filter(f => f.expires >= turn);
export const hasFlag = (unit, kind, turn) => liveFlags(unit, turn).some(f => f.kind === kind);
export function addFlag(unit, kind, expires) {
  (unit.flags ||= []).push({ kind, expires });
}

function makeSide(id, name, leaderId, deckMap, cards, rng) {
  const leader = cards[leaderId];
  const deck = [];
  for (const [cardId, n] of Object.entries(deckMap)) {
    for (let i = 0; i < n; i++) deck.push(cardId);
  }
  shuffle(deck, rng);

  const side = {
    id, name, leaderId,
    deck, hand: [], life: [], trash: [], chars: [], stage: null,
    donDeck: donDeckSize(leader),
    donActive: 0, donRested: 0,
    leaderDon: 0, leaderRested: false, leaderMods: [],
    once: {},
    turnsTaken: 0,
    mulliganed: false,
  };

  for (let i = 0; i < 5; i++) side.hand.push(side.deck.pop());
  const life = lifeTotal(leader);
  for (let i = 0; i < life; i++) side.life.push(side.deck.pop());
  return side;
}

/**
 * @param {object} cfg
 * @param {{name,leaderId,deck}} cfg.p1  bottom player (the human in the UI)
 * @param {{name,leaderId,deck}} cfg.p2
 * @param {object} cfg.cards  card database keyed by card id
 * @param {number} cfg.seed
 * @param {'p1'|'p2'} cfg.firstPlayer
 */
export function createGame({ p1, p2, cards, seed = 1, firstPlayer = 'p1' }) {
  const rng = makeRng(seed);
  const G = {
    seed, rng, cards,
    turn: 0,
    phase: 'main',
    active: firstPlayer,
    firstPlayer,
    p1: makeSide('p1', p1.name || 'You', p1.leaderId, p1.deck, cards, rng),
    p2: makeSide('p2', p2.name || 'Opponent', p2.leaderId, p2.deck, cards, rng),
    log: [],
    queue: [],
    pending: null,
    over: null,
    combat: null,
  };
  beginTurn(G, firstPlayer);
  return G;
}

/* ---------------------------------------------------------------------- */
/* small accessors                                                         */
/* ---------------------------------------------------------------------- */

export const other = s => (s === 'p1' ? 'p2' : 'p1');
const side = (G, s) => G[s];
const card = (G, id) => G.cards[id] || null;

const log = (G, kind, text, meta) => {
  G.log.push({ i: G.log.length, turn: G.turn, phase: G.phase, kind, text, meta });
};

/** Sum of a mod list that hasn't expired. */
const modSum = (mods, turn) => mods.reduce((a, m) => (m.expires >= turn ? a + m.amount : a), 0);

/**
 * Continuous power granted by always-on text, from the unit itself and from
 * anything on its side that buffs the whole board (Leader, other Characters,
 * the Stage). `[DON!! xN]` is measured against the DON!! attached to whichever
 * card carries the text, not the unit receiving the buff.
 */
function staticBonus(G, s, unit, isLeader) {
  const S = side(G, s);
  const yourTurn = G.active === s;
  let bonus = 0;

  const applies = (b, sourceDon) => {
    if (b.when === 'yourTurn' && !yourTurn) return false;
    if (b.when === 'oppTurn' && yourTurn) return false;
    if (b.don && sourceDon < b.don) return false;
    return true;
  };

  // The unit's own text.
  const own = isLeader ? card(G, S.leaderId) : card(G, unit.id);
  const ownDon = isLeader ? S.leaderDon : unit.don;
  for (const b of staticBuffs(own)) {
    if (b.target === 'this' && applies(b, ownDon)) bonus += b.amount;
  }

  // Does the receiving unit match a board-wide buff's restrictions?
  const matches = b => {
    if (isLeader) return false;                                // "Characters" only
    const rc = card(G, unit.id);
    if (!rc) return false;
    if (b.names && !b.names.includes(rc.name)) return false;
    if (b.types && !b.types.some(t => (rc.types || []).includes(t))) return false;
    if (b.colour && !(rc.colors || []).some(x => x.toLowerCase() === b.colour)) return false;
    if (b.minBaseCost != null && costOf(rc) < b.minBaseCost) return false;
    return true;
  };

  // Board-wide text from the Leader, the Stage and every Character in play.
  const sources = [
    { c: card(G, S.leaderId), don: S.leaderDon },
    ...(S.stage ? [{ c: card(G, S.stage), don: 0 }] : []),
    ...S.chars.map(x => ({ c: card(G, x.id), don: x.don })),
  ];
  for (const src of sources) {
    for (const b of staticBuffs(src.c)) {
      if (b.target === 'this') continue;
      if (!applies(b, src.don)) continue;
      if (b.target === 'allChars' && !matches(b)) continue;
      bonus += b.amount;
    }
  }
  return bonus;
}

export function charPower(G, s, ch) {
  const c = card(G, ch.id);
  // A live base-power override replaces the printed value; the most recent wins.
  const override = (ch.baseMods || []).filter(m => m.expires >= G.turn).pop();
  const base = override ? override.power : (c?.power || 0);
  return base + ch.don * 1000 + modSum(ch.mods, G.turn) + staticBonus(G, s, ch, false);
}

/** Printed cost plus any live cost modifiers ("gains +2 cost"). */
export function charCost(G, ch) {
  const c = card(G, ch.id);
  return Math.max(0, costOf(c) + modSum(ch.costMods || [], G.turn));
}
export function leaderPower(G, s) {
  const S = side(G, s);
  const c = card(G, S.leaderId);
  return (c?.power || 0) + S.leaderDon * 1000 + modSum(S.leaderMods, G.turn)
    + staticBonus(G, s, null, true);
}
export const findChar = (G, s, uid) => side(G, s).chars.find(c => c.uid === uid) || null;

/** Power of whatever is attacking or defending. */
export function unitPower(G, s, ref) {
  if (ref === 'leader') return leaderPower(G, s);
  const ch = findChar(G, s, ref);
  return ch ? charPower(G, s, ch) : 0;
}
export function unitName(G, s, ref) {
  const S = side(G, s);
  if (ref === 'leader') return card(G, S.leaderId)?.name || 'Leader';
  const ch = findChar(G, s, ref);
  return ch ? (card(G, ch.id)?.name || ch.id) : 'unknown';
}

/* ---------------------------------------------------------------------- */
/* turn structure                                                          */
/* ---------------------------------------------------------------------- */

function beginTurn(G, s) {
  G.active = s;
  G.turn++;
  G.phase = 'refresh';
  const S = side(G, s);
  S.turnsTaken++;
  S.once = {};
  log(G, 'phase', `Turn ${G.turn} — ${S.name}'s turn begins.`, { side: s });
  runRefresh(G);
}

function runRefresh(G) {
  const S = side(G, G.active);
  // Attached DON!! return to the cost area, and everything sets active.
  const returning = S.donRested + S.leaderDon + S.chars.reduce((a, c) => a + c.don, 0);
  S.donActive += returning;
  S.donRested = 0;
  S.leaderDon = 0;
  S.leaderRested = false;
  for (const ch of S.chars) {
    ch.don = 0;
    // "will not become active in your opponent's next Refresh Phase"
    if (hasFlag(ch, 'wontRefresh', G.turn)) {
      ch.flags = ch.flags.filter(f => f.kind !== 'wontRefresh');
      continue;
    }
    ch.rested = false;
  }
  if (returning) log(G, 'phase', `Refresh — ${returning} DON!! returned to the cost area, all cards set active.`);
  else log(G, 'phase', 'Refresh — all cards set active.');
}

/** Advance one phase. Returns false when the phase can't be left yet. */
function advancePhase(G) {
  if (G.pending || G.over) return false;
  const i = PHASES.indexOf(G.phase);

  if (G.phase === 'end') {
    expireMods(G);
    log(G, 'phase', 'End Phase — turn passed.');
    beginTurn(G, other(G.active));
    return true;
  }

  G.phase = PHASES[i + 1];
  const S = side(G, G.active);

  if (G.phase === 'draw') {
    // The player on the play skips their very first draw.
    const skip = G.turn === 1 && G.active === G.firstPlayer;
    if (skip) log(G, 'phase', 'Draw skipped — the player going first does not draw on turn 1.');
    else drawCards(G, G.active, 1);
  } else if (G.phase === 'don') {
    const want = (G.turn === 1 && G.active === G.firstPlayer) ? 1 : 2;
    const got = Math.min(want, S.donDeck);
    S.donDeck -= got;
    S.donActive += got;
    log(G, 'don', `DON!! Phase — ${got} DON!! added to the cost area.`, { n: got });
  } else if (G.phase === 'main') {
    log(G, 'phase', 'Main Phase.');
  } else if (G.phase === 'end') {
    log(G, 'phase', 'End Phase.');
  }
  return true;
}

function expireMods(G) {
  for (const s of ['p1', 'p2']) {
    const S = side(G, s);
    S.leaderMods = S.leaderMods.filter(m => m.expires > G.turn);
    S.leaderFlags = (S.leaderFlags || []).filter(f => f.expires > G.turn);
    for (const ch of S.chars) {
      ch.mods = ch.mods.filter(m => m.expires > G.turn);
      ch.baseMods = (ch.baseMods || []).filter(m => m.expires > G.turn);
      ch.costMods = (ch.costMods || []).filter(m => m.expires > G.turn);
      // wontRefresh is consumed by the Refresh Phase itself, not by the clock.
      ch.flags = (ch.flags || []).filter(f => f.kind === 'wontRefresh' || f.expires > G.turn);
    }
  }
}

function drawCards(G, s, n) {
  const S = side(G, s);
  for (let i = 0; i < n; i++) {
    if (!S.deck.length) {
      finish(G, other(s), `${S.name} could not draw from an empty deck.`);
      return;
    }
    S.hand.push(S.deck.pop());
  }
  log(G, 'draw', `${S.name} drew ${n} card${n > 1 ? 's' : ''}.`, { side: s, n });
}

function finish(G, winner, reason) {
  if (G.over) return;
  G.over = { winner, reason };
  G.pending = null;
  G.queue = [];
  log(G, 'end', reason, { winner });
}

/* ---------------------------------------------------------------------- */
/* playing cards                                                           */
/* ---------------------------------------------------------------------- */

export function costOf(c) { return c && c.cost != null ? c.cost : 0; }

export function canPlay(G, s, index) {
  const S = side(G, s);
  const c = card(G, S.hand[index]);
  if (!c || c.category === 'Leader') return false;
  if (G.phase !== 'main' || G.active !== s || G.pending || G.over) return false;
  if (costOf(c) > S.donActive) return false;
  if (c.category === 'Character' && S.chars.length >= MAX_CHARS) return false;
  return true;
}

function playCard(G, s, index, { free = false } = {}) {
  const S = side(G, s);
  const id = S.hand[index];
  const c = card(G, id);
  if (!c) return;

  if (!free) {
    const cost = costOf(c);
    S.donActive -= cost;
    S.donRested += cost;
  }
  S.hand.splice(index, 1);

  if (c.category === 'Character') {
    S.chars.push(newChar(id, G.turn));
  } else if (c.category === 'Stage') {
    if (S.stage) S.trash.push(S.stage);
    S.stage = id;
  } else {
    S.trash.push(id);
  }

  /* A card with no printed cost isn't free — it's paid for by an activation
   * cost in its text, which resolves separately. Saying "for 0 DON!!" would
   * claim otherwise. */
  const costNote = free ? ' (free)'
    : c.cost == null ? ''
      : ` for ${costOf(c)} DON!!`;
  log(G, 'play', `${S.name} played ${c.name}${costNote}.`, { side: s, cardId: id });
  enqueueEffects(G, s, c, 'onPlay');
}

/* ---------------------------------------------------------------------- */
/* effects                                                                 */
/* ---------------------------------------------------------------------- */

function enqueueEffects(G, s, c, when, extra = {}) {
  const S = side(G, s);

  /* A hand-written script always wins over the text parser — it exists
   * precisely because the parser misreads this card. */
  const script = c && scriptFor(c.id, when);
  if (script) {
    if (script.don && extra.unit) {
      const attached = extra.unit === 'leader' ? S.leaderDon : (findChar(G, s, extra.unit)?.don ?? 0);
      if (attached < script.don) return;
    }
    if (!meetsRequirements(G, s, script.require)) return;
    G.queue.push({
      side: s,
      clause: { when, ops: script.ops || [], cost: script.cost || null, text: c.name, scripted: true },
      source: c,
      ...extra,
    });
    return;
  }

  const clauses = parseEffects(c).filter(e => e.when === when);
  if (!clauses.length) return;
  for (const clause of clauses) {
    // [DON!! xN] gates the clause on attached DON!!, which only matters for a
    // specific unit; skip the gate when we have no unit context.
    if (clause.don && extra.unit) {
      const attached = extra.unit === 'leader' ? S.leaderDon : (findChar(G, s, extra.unit)?.don ?? 0);
      if (attached < clause.don) continue;
    }
    if (clause.oncePerTurn) {
      const key = `${c.id}:${when}`;
      if (S.once[key]) continue;
      S.once[key] = 1;
    }
    G.queue.push({ side: s, clause, source: c, ...extra });
  }
}

/** Work the effect queue until it empties or something needs a decision. */
function pump(G) {
  let guard = 0;
  while (!G.pending && !G.over && G.queue.length && guard++ < 200) {
    const item = G.queue.shift();
    resolveClause(G, item);
  }
}

function resolveClause(G, item) {
  const { side: s, clause, source } = item;

  // Text we couldn't parse becomes an explicit prompt rather than a silent drop.
  if (clause.unparsed) {
    G.pending = {
      type: 'manual', side: s, source: source.id,
      prompt: `${source.name}: apply this effect yourself`,
      text: clause.text,
      options: manualOptions(),
    };
    return;
  }

  // A cost the player chooses to pay.
  if (clause.cost && clause.cost.optional && !item.costPaid) {
    if (!canPayCost(G, s, clause.cost)) return;      // can't pay: clause fizzles
    G.pending = {
      type: 'confirm', side: s, source: source.id,
      prompt: `${source.name}: ${clause.cost.text}?`,
      text: clause.text,
      onYes: { ...item, costPaid: true },
    };
    return;
  }
  if (clause.cost && !item.costPaid) {
    if (!canPayCost(G, s, clause.cost)) return;
    payCost(G, s, clause.cost, item.unit);
  }

  for (const op of clause.ops) {
    if (G.pending || G.over) {
      // Something needs input — requeue the rest of this clause behind it.
      G.queue.unshift({ ...item, clause: { ...clause, ops: clause.ops.slice(clause.ops.indexOf(op)) }, costPaid: true });
      return;
    }
    applyOp(G, s, op, source, item);
  }
}

/** Conditions a scripted clause needs before it does anything. */
function meetsRequirements(G, s, req) {
  if (!req) return true;
  const S = side(G, s);
  const O = side(G, other(s));
  const leader = card(G, S.leaderId);

  if (req.leaderName && leader?.name !== req.leaderName) return false;
  if (req.leaderType && !(leader?.types || []).includes(req.leaderType)) return false;
  if (req.oppHandAtLeast != null && O.hand.length < req.oppHandAtLeast) return false;
  if (req.lifeAtMost != null && S.life.length > req.lifeAtMost) return false;
  if (req.minDonTotal != null && S.donActive + S.donRested < req.minDonTotal) return false;
  if (req.trashAtLeast != null && S.trash.length < req.trashAtLeast) return false;
  // "If the only Characters on your field are {X} type" — vacuously true on an
  // empty board, which is how the ruling works.
  if (req.allCharsOfType && S.chars.some(ch => !(card(G, ch.id)?.types || []).includes(req.allCharsOfType))) return false;
  if (req.minRestedDon != null && S.donRested < req.minRestedDon) return false;
  if (req.donDeckAtLeast != null && S.donDeck < req.donDeckAtLeast) return false;
  if (req.maxDonTotal != null && S.donActive + S.donRested > req.maxDonTotal) return false;
  if (req.donGiven && S.leaderDon + S.chars.reduce((a, c) => a + c.don, 0) === 0) return false;
  return true;
}

function canPayCost(G, s, cost) {
  const S = side(G, s);
  if (cost.don && S.donRested + S.donActive < cost.don) return false;
  if (cost.discard && S.hand.length < cost.discard) return false;
  if (cost.mill && S.deck.length < cost.mill) return false;
  if (cost.restDon && S.donActive < cost.restDon) return false;
  if (cost.lifeTrash && S.life.length < cost.lifeTrash) return false;
  return true;
}

function payCost(G, s, cost, unit) {
  const S = side(G, s);
  if (cost.don) {
    // DON!! -N returns DON!! cards to the deck; prefer resting ones.
    let n = cost.don;
    const fromRested = Math.min(n, S.donRested);
    S.donRested -= fromRested; n -= fromRested;
    S.donActive -= Math.min(n, S.donActive);
    S.donDeck += cost.don;
  }
  if (cost.discard) {
    for (let i = 0; i < cost.discard && S.hand.length; i++) S.trash.push(S.hand.pop());
    log(G, 'cost', `${S.name} trashed ${cost.discard} card(s) from hand.`);
  }
  if (cost.mill) {
    for (let i = 0; i < cost.mill && S.deck.length; i++) S.trash.push(S.deck.pop());
  }
  if (cost.restDon) {
    const n = Math.min(cost.restDon, S.donActive);
    S.donActive -= n; S.donRested += n;
    log(G, 'cost', `${S.name} rested ${n} DON!!.`, { side: s });
  }
  if (cost.lifeTrash) {
    for (let i = 0; i < cost.lifeTrash && S.life.length; i++) S.trash.push(S.life.pop());
    log(G, 'cost', `${S.name} trashed ${cost.lifeTrash} Life card(s).`, { side: s });
  }
  // "trash this Character" / "rest this Character" need to know which one.
  if (cost.trashSelf && unit) {
    const i = S.chars.findIndex(ch => ch.uid === unit);
    if (i >= 0) { const ch = S.chars.splice(i, 1)[0]; S.donActive += ch.don; S.trash.push(ch.id); }
  }
  if (cost.restSelf && unit) {
    const ch = findChar(G, s, unit);
    if (ch) ch.rested = true;
  }
}

function applyOp(G, s, op, source, item) {
  const S = side(G, s);
  const O = side(G, other(s));
  const target = op.side === 'opp' ? O : S;

  // Some clauses gate a single sentence rather than the whole effect
  // ("Then, if you have 6 or less DON!! cards, draw 1 card").
  if (op.require && !meetsRequirements(G, s, op.require)) return;

  switch (op.op) {
    case 'draw':
      drawCards(G, op.side === 'opp' ? other(s) : s, op.n);
      break;

    case 'discard': {
      for (let i = 0; i < op.n && target.hand.length; i++) {
        target.trash.push(target.hand.splice(randInt(G.rng, target.hand.length), 1)[0]);
      }
      log(G, 'effect', `${target.name} trashed ${op.n} card(s) from hand.`);
      break;
    }

    case 'dig': {
      // Look at N; take the best match for the named type, else the top card.
      const seen = S.deck.slice(-op.n).reverse();
      if (!seen.length) break;
      let pickIdx = 0;
      if (op.type) {
        const i = seen.findIndex(id => (card(G, id)?.types || []).some(t => t.toLowerCase() === op.type.toLowerCase()));
        if (i >= 0) pickIdx = i;
      }
      const chosen = seen[pickIdx];
      S.deck.splice(S.deck.length - 1 - pickIdx, 1);
      S.hand.push(chosen);
      log(G, 'effect', `${S.name} searched ${op.n} and took ${card(G, chosen)?.name || chosen}.`, { side: s });
      break;
    }

    case 'ko': {
      const legal = O.chars.filter(ch =>
        (op.maxCost == null || costOf(card(G, ch.id)) <= op.maxCost) &&
        (op.maxPower == null || (card(G, ch.id)?.power || 0) <= op.maxPower));
      if (!legal.length) { log(G, 'effect', 'No legal K.O. target.'); break; }
      G.pending = {
        type: 'target', side: s, kind: 'ko', source: source.id,
        prompt: `K.O. an opposing character${op.maxCost != null ? ` (cost ${op.maxCost} or less)` : ''}`,
        optional: op.optional,
        options: legal.map(ch => ({ uid: ch.uid, side: other(s), label: card(G, ch.id)?.name || ch.id })),
      };
      break;
    }

    case 'rest': {
      const legal = target.chars.filter(ch => !ch.rested && !hasFlag(ch, 'cannotRest', G.turn));
      if (!legal.length) break;
      G.pending = {
        type: 'target', side: s, kind: 'rest', source: source.id,
        prompt: `Rest up to ${op.n} opposing character(s)`,
        optional: true, count: op.n,
        options: legal.map(ch => ({ uid: ch.uid, side: op.side === 'opp' ? other(s) : s, label: card(G, ch.id)?.name || ch.id })),
      };
      break;
    }

    case 'bounce': {
      const legal = O.chars;
      if (!legal.length) break;
      G.pending = {
        type: 'target', side: s, kind: 'bounce', source: source.id,
        prompt: 'Return an opposing character to the bottom of its deck',
        optional: op.optional,
        options: legal.map(ch => ({ uid: ch.uid, side: other(s), label: card(G, ch.id)?.name || ch.id })),
      };
      break;
    }

    case 'power': {
      if (op.target === 'leader') { addMod(G, s, 'leader', op.amount); break; }
      if (op.target === 'this' && item.unit) { addMod(G, s, item.unit, op.amount); break; }
      const pool = op.side === 'opp' ? O.chars : S.chars;
      if (!pool.length) break;
      G.pending = {
        type: 'target', side: s, kind: 'power', source: source.id,
        prompt: `Give ${op.amount > 0 ? '+' : ''}${op.amount.toLocaleString()} power`,
        optional: true, count: op.n, amount: op.amount,
        targetSide: op.side === 'opp' ? other(s) : s,
        options: pool.map(ch => ({ uid: ch.uid, side: op.side === 'opp' ? other(s) : s, label: card(G, ch.id)?.name || ch.id })),
      };
      break;
    }

    case 'donAdd': {
      const got = Math.min(op.n, S.donDeck);
      S.donDeck -= got;
      if (op.rested) S.donRested += got; else S.donActive += got;
      log(G, 'don', `${S.name} added ${got} DON!!${op.rested ? ' (rested)' : ''} from the DON!! deck.`, { side: s, n: got });
      break;
    }

    case 'donActive': {
      const n = Math.min(op.n, S.donRested);
      S.donRested -= n; S.donActive += n;
      if (n) log(G, 'don', `${S.name} set ${n} DON!! active.`, { side: s });
      break;
    }

    case 'donGive': {
      /* Attaching rested DON!! is how the ramp leaders convert a big DON!!
       * dump into power, so this has to move all N, not one.
       *
       * Strictly RESTED DON!! only — the printed text says so, and taking
       * active DON!! instead would silently spend the resource the player
       * still needs to cast with. On a 6-card DON!! deck that is the whole
       * difference between the archetype functioning and not. */
      const n = Math.min(op.n, S.donRested);
      if (n <= 0) break;

      const give = (ref, k) => {
        S.donRested -= k;
        if (ref === 'leader') S.leaderDon += k;
        else { const ch = findChar(G, s, ref); if (ch) ch.don += k; }
        log(G, 'don', `${S.name} gave ${k} rested DON!! to ${unitName(G, s, ref)} (+${(k * 1000).toLocaleString()} power).`, { side: s });
      };

      if (op.to === 'leader' || !S.chars.length) { give('leader', n); break; }
      G.pending = {
        type: 'target', side: s, kind: 'donGive', source: source.id, amount: n,
        prompt: `Give ${n} rested DON!! to one of your Characters`,
        optional: false,
        options: S.chars.map(ch => ({ uid: ch.uid, side: s, label: card(G, ch.id)?.name || ch.id })),
        give,
      };
      break;
    }

    case 'lifeAdd': {
      if (!S.deck.length) break;
      S.life.push(S.deck.pop());
      log(G, 'effect', `${S.name} added 1 card to their Life.`, { side: s });
      break;
    }

    /* ---- operations used by the scripted-card layer ---------------- */

    case 'damage':                                    // "deal 1 damage"
      for (let i = 0; i < (op.n || 1) && !G.over && !G.pending; i++) dealDamage(G, other(s));
      break;

    case 'lifeTrash': {                               // own Life -> trash (a cost)
      for (let i = 0; i < (op.n || 1) && S.life.length; i++) S.trash.push(S.life.pop());
      log(G, 'effect', `${S.name} trashed ${op.n || 1} Life card(s).`, { side: s });
      break;
    }

    case 'lifeFromHand': {
      if (!S.hand.length) break;
      G.pending = {
        type: 'target', side: s, kind: 'lifeFromHand', source: source.id,
        prompt: 'Put a card from your hand on top of your Life',
        optional: !!op.optional,
        options: S.hand.map((id, i) => ({ index: i, label: card(G, id)?.name || id })),
      };
      break;
    }

    case 'lifeFromTrash': {
      const legal = trashMatches(G, s, op);
      if (!legal.length) break;
      G.pending = {
        type: 'target', side: s, kind: 'lifeFromTrash', source: source.id,
        prompt: 'Add a card from your trash to the top of your Life',
        optional: !!op.optional,
        options: legal.map(x => ({ index: x.i, label: x.c.name })),
      };
      break;
    }

    case 'lifeToHandOpp': {                           // opponent's top Life -> their hand
      const O2 = side(G, other(s));
      for (let i = 0; i < (op.n || 1) && O2.life.length; i++) O2.hand.push(O2.life.pop());
      log(G, 'effect', `${O2.name} added ${op.n || 1} Life card(s) to hand.`, { side: other(s) });
      break;
    }

    case 'playFromTrash': {
      if (S.chars.length >= MAX_CHARS && !op.toLife) break;
      const legal = trashMatches(G, s, { ...op, category: 'Character' });
      if (!legal.length) break;
      G.pending = {
        type: 'target', side: s, kind: 'playFromTrash', source: source.id,
        prompt: `Play a character from your trash${op.maxCost != null ? ` (cost ${op.maxCost} or less)` : ''}`,
        optional: op.optional !== false,
        rested: !!op.rested,
        options: legal.map(x => ({ index: x.i, label: x.c.name })),
      };
      break;
    }

    case 'searchTrashToHand': {
      if (op.requireLifeAtMost != null && S.life.length > op.requireLifeAtMost) break;
      const legal = trashMatches(G, s, op);
      if (!legal.length) break;
      G.pending = {
        type: 'target', side: s, kind: 'searchTrashToHand', source: source.id,
        prompt: 'Add a card from your trash to your hand',
        optional: op.optional !== false,
        options: legal.map(x => ({ index: x.i, label: x.c.name })),
      };
      break;
    }

    case 'flag': {                                    // cannotAttack / cannotRest / wontRefresh
      const pool = (op.side === 'self' ? S : O).chars.filter(ch =>
        (op.maxCost == null || charCost(G, ch) <= op.maxCost) &&
        (op.restedOnly ? ch.rested : true) &&
        (op.notNamed ? card(G, ch.id)?.name !== op.notNamed : true));
      if (!pool.length) break;
      if (op.all) {
        for (const ch of pool) addFlag(ch, op.kind, expiryFor(G, op.scope));
        log(G, 'effect', `${pool.length} character(s) — ${op.kind}.`);
        break;
      }
      G.pending = {
        type: 'target', side: s, kind: 'flag', source: source.id,
        prompt: op.prompt || `Choose a character (${op.kind})`,
        optional: op.optional !== false,
        flagKind: op.kind, expires: expiryFor(G, op.scope),
        targetSide: op.side === 'self' ? s : other(s),
        count: op.n || 1,
        options: pool.map(ch => ({ uid: ch.uid, label: card(G, ch.id)?.name || ch.id })),
      };
      break;
    }

    case 'gainKeyword': {
      const pool = S.chars.filter(ch => !op.type || (card(G, ch.id)?.types || []).includes(op.type));
      if (!pool.length) break;
      G.pending = {
        type: 'target', side: s, kind: 'flag', source: source.id,
        prompt: `Give a character [${op.kind}]`,
        optional: true, flagKind: op.kind, expires: expiryFor(G, op.scope), targetSide: s,
        options: pool.map(ch => ({ uid: ch.uid, label: card(G, ch.id)?.name || ch.id })),
      };
      break;
    }

    case 'basePower': {                               // "base power becomes …"
      const unit = item.unit;
      if (!unit || unit === 'leader') break;
      const me = findChar(G, s, unit);
      if (!me) break;
      if (op.mode === 'oppLeader') {
        me.baseMods.push({ power: leaderPower(G, other(s)), expires: expiryFor(G, op.scope) });
        log(G, 'effect', `${card(G, me.id)?.name} base power became ${leaderPower(G, other(s)).toLocaleString()}.`);
        break;
      }
      if (op.mode === 'selectedChar') {
        if (!O.chars.length) break;
        G.pending = {
          type: 'target', side: s, kind: 'basePowerFrom', source: source.id,
          prompt: 'Copy an opposing character\'s power', optional: true,
          selfUid: unit, expires: expiryFor(G, op.scope),
          options: O.chars.map(ch => ({ uid: ch.uid, label: `${card(G, ch.id)?.name} (${charPower(G, other(s), ch).toLocaleString()})` })),
        };
      }
      break;
    }

    case 'costMod': {
      const pool = (op.side === 'self' ? S : O).chars;
      if (!pool.length) break;
      G.pending = {
        type: 'target', side: s, kind: 'costMod', source: source.id,
        prompt: `Give a character ${op.amount > 0 ? '+' : ''}${op.amount} cost`,
        optional: true, amount: op.amount, expires: expiryFor(G, op.scope),
        targetSide: op.side === 'self' ? s : other(s),
        options: pool.map(ch => ({ uid: ch.uid, label: card(G, ch.id)?.name || ch.id })),
      };
      break;
    }

    case 'powerAll': {                                // every character on a side
      const pool = (op.side === 'self' ? S : O).chars;
      for (const ch of pool) ch.mods.push({ amount: op.amount, expires: expiryFor(G, op.scope) });
      if (pool.length) log(G, 'effect', `All of ${op.side === 'self' ? S.name : O.name}'s characters ${op.amount > 0 ? '+' : ''}${op.amount.toLocaleString()} power.`);
      break;
    }

    case 'koPowerAtMost': {                           // sweep after a mass debuff
      const doomed = O.chars.filter(ch => charPower(G, other(s), ch) <= (op.n || 0));
      for (const ch of doomed) koChar(G, other(s), ch.uid);
      break;
    }

    case 'setActive': {
      const legal = S.chars.filter(ch => ch.rested && (op.maxBaseCost == null || costOf(card(G, ch.id)) <= op.maxBaseCost));
      if (!legal.length) break;
      G.pending = {
        type: 'target', side: s, kind: 'setActive', source: source.id,
        prompt: 'Set one of your characters active', optional: true,
        options: legal.map(ch => ({ uid: ch.uid, label: card(G, ch.id)?.name || ch.id })),
      };
      break;
    }

    case 'setAllActive': {
      S.leaderRested = false;
      for (const ch of S.chars) ch.rested = false;
      log(G, 'effect', `${S.name} set their Leader and all Characters active.`, { side: s });
      break;
    }

    case 'restDonOpp': {
      const O3 = side(G, other(s));
      const n = Math.min(op.n || 1, O3.donActive);
      O3.donActive -= n; O3.donRested += n;
      if (n) log(G, 'effect', `${O3.name} had ${n} DON!! rested.`);
      break;
    }

    case 'oppDiscard': {
      const O4 = side(G, other(s));
      if (op.ifHandAtLeast != null && O4.hand.length < op.ifHandAtLeast) break;
      for (let i = 0; i < (op.n || 1) && O4.hand.length; i++) {
        O4.trash.push(O4.hand.splice(randInt(G.rng, O4.hand.length), 1)[0]);
      }
      log(G, 'effect', `${O4.name} trashed ${op.n || 1} card(s) from hand.`);
      break;
    }

    case 'returnToHand': {
      const pool = [
        ...(op.side !== 'self' ? O.chars.map(ch => ({ ch, owner: other(s) })) : []),
        ...(op.side !== 'opp' ? S.chars.map(ch => ({ ch, owner: s })) : []),
      ].filter(x => op.maxCost == null || charCost(G, x.ch) <= op.maxCost);
      if (!pool.length) break;
      G.pending = {
        type: 'target', side: s, kind: 'returnToHand', source: source.id,
        prompt: `Return a character to its owner's hand${op.maxCost != null ? ` (cost ${op.maxCost} or less)` : ''}`,
        optional: op.optional !== false,
        owners: Object.fromEntries(pool.map(x => [x.ch.uid, x.owner])),
        options: pool.map(x => ({ uid: x.ch.uid, label: `${card(G, x.ch.id)?.name} (${x.owner === s ? 'yours' : 'theirs'})` })),
      };
      break;
    }

    case 'bottomDeck': {
      const pool = [
        ...O.chars.map(ch => ({ ch, owner: other(s) })),
        ...S.chars.map(ch => ({ ch, owner: s })),
      ].filter(x => op.maxCost == null || charCost(G, x.ch) <= op.maxCost);
      if (!pool.length) break;
      G.pending = {
        type: 'target', side: s, kind: 'bottomDeck', source: source.id,
        prompt: `Place a character on the bottom of its owner's deck${op.maxCost != null ? ` (cost ${op.maxCost} or less)` : ''}`,
        optional: op.optional !== false,
        count: op.n || 1,
        owners: Object.fromEntries(pool.map(x => [x.ch.uid, x.owner])),
        options: pool.map(x => ({ uid: x.ch.uid, label: `${card(G, x.ch.id)?.name} (${x.owner === s ? 'yours' : 'theirs'})` })),
      };
      break;
    }

    case 'chooseOne': {
      G.pending = {
        type: 'mode', side: s, source: source.id,
        prompt: source.name,
        options: op.modes.map((m, i) => ({ index: i, label: m.label })),
        modes: op.modes,
      };
      break;
    }

    case 'returnStage': {
      const O6 = side(G, other(s));
      if (O6.stage) { O6.hand.push(O6.stage); O6.stage = null; log(G, 'effect', `${O6.name}'s Stage was returned to hand.`); }
      else if (S.stage) { S.hand.push(S.stage); S.stage = null; log(G, 'effect', `${S.name}'s Stage was returned to hand.`); }
      break;
    }

    case 'playFree': {
      const wantCategory = op.category || 'Character';
      const legal = S.hand
        .map((id, i) => ({ id, i, c: card(G, id) }))
        .filter(x => x.c && x.c.category === wantCategory
          && (op.fromHandName == null || x.c.name === op.fromHandName)
          && (op.type == null || (x.c.types || []).includes(op.type))
          && (op.maxCost == null || costOf(x.c) <= op.maxCost)
          && (op.maxPower == null || (x.c.power || 0) <= op.maxPower));
      if (!legal.length) break;
      if (wantCategory === 'Character' && S.chars.length >= MAX_CHARS) break;
      G.pending = {
        type: 'target', side: s, kind: 'playFree', source: source.id,
        prompt: 'Play a character from your hand for free',
        optional: true,
        options: legal.map(x => ({ index: x.i, label: x.c.name })),
      };
      break;
    }
  }
}

/**
 * Cards in a side's trash matching a script filter.
 * Returns `[{ i, id, c }]` with `i` the trash index, so the caller can splice.
 */
function trashMatches(G, s, filter = {}) {
  const S = side(G, s);
  return S.trash.map((id, i) => ({ i, id, c: card(G, id) }))
    .filter(x => x.c
      && (filter.category == null || x.c.category === filter.category)
      && (filter.maxCost == null || costOf(x.c) <= filter.maxCost)
      && (filter.cost == null || costOf(x.c) === filter.cost)
      && (filter.type == null || (x.c.types || []).includes(filter.type))
      && (filter.name == null || x.c.name === filter.name));
}

function addMod(G, s, ref, amount, turns = 0) {
  const S = side(G, s);
  const mod = { amount, expires: G.turn + turns };
  if (ref === 'leader') S.leaderMods.push(mod);
  else {
    const ch = findChar(G, s, ref);
    if (ch) ch.mods.push(mod);
  }
}

function manualOptions() {
  return [
    { key: 'draw1', label: 'Draw 1' },
    { key: 'plus1000', label: '+1000 power' },
    { key: 'minus1000', label: '−1000 to a foe' },
    { key: 'donActive', label: 'Set 1 DON!! active' },
    { key: 'life', label: 'Add 1 life' },
    { key: 'mill', label: 'Trash top card' },
    { key: 'skip', label: 'Skip' },
  ];
}

function applyManual(G, s, key) {
  const S = side(G, s);
  const O = side(G, other(s));
  switch (key) {
    case 'draw1': drawCards(G, s, 1); break;
    case 'plus1000': if (S.chars[0]) addMod(G, s, S.chars[0].uid, 1000); else addMod(G, s, 'leader', 1000); break;
    case 'minus1000': if (O.chars[0]) O.chars[0].mods.push({ amount: -1000, expires: G.turn }); break;
    case 'donActive': if (S.donRested) { S.donRested--; S.donActive++; } break;
    case 'life': if (S.deck.length) S.life.push(S.deck.pop()); break;
    case 'mill': if (S.deck.length) S.trash.push(S.deck.pop()); break;
    default: break;
  }
  if (key !== 'skip') log(G, 'effect', `${S.name} applied an effect manually (${key}).`);
}

/* ---------------------------------------------------------------------- */
/* K.O. and damage                                                         */
/* ---------------------------------------------------------------------- */

function koChar(G, s, uid) {
  const S = side(G, s);
  const i = S.chars.findIndex(c => c.uid === uid);
  if (i < 0) return;
  const ch = S.chars[i];
  S.donActive += ch.don;                    // attached DON!! returns to the cost area
  S.chars.splice(i, 1);
  S.trash.push(ch.id);
  const c = card(G, ch.id);
  log(G, 'ko', `${c?.name || ch.id} was K.O.'d.`, { side: s, cardId: ch.id });
  if (c) enqueueEffects(G, s, c, 'onKO');
}

function dealDamage(G, s) {
  const S = side(G, s);
  if (!S.life.length) {
    finish(G, other(s), `${S.name} has no Life left.`);
    return;
  }
  const id = S.life.pop();
  const c = card(G, id);
  S.hand.push(id);
  log(G, 'damage', `${S.name} took 1 damage — ${S.life.length} Life remaining.`, { side: s, cardId: id });

  if (c && triggerText(c)) {
    G.pending = {
      type: 'trigger', side: s, cardId: id,
      prompt: `${c.name} has a [Trigger] — activate it?`,
      text: triggerText(c),
    };
  }
}

/* ---------------------------------------------------------------------- */
/* combat                                                                  */
/* ---------------------------------------------------------------------- */

export function canAttack(G, s, ref) {
  if (G.phase !== 'main' || G.active !== s || G.pending || G.over) return false;
  const S = side(G, s);
  if (ref === 'leader') return !S.leaderRested;
  const ch = findChar(G, s, ref);
  if (!ch || ch.rested) return false;
  if (hasFlag(ch, 'cannotAttack', G.turn)) return false;
  if (ch.bornTurn === G.turn) {
    const kw = keywords(card(G, ch.id));
    const rushOn = kw.rush || kw.rushChar || (kw.rushIf != null && ch.don >= kw.rushIf);
    if (!rushOn) return false;
  }
  return true;
}

/** Legal targets for an attack: the enemy Leader, or a *rested* enemy character. */
export function attackTargets(G, s, ref) {
  const O = side(G, other(s));
  const out = O.chars.filter(c => c.rested).map(c => ({ kind: 'char', uid: c.uid }));

  // [Rush: Character] can swing the turn it lands, but only at characters.
  if (ref !== 'leader') {
    const ch = findChar(G, s, ref);
    const kw = keywords(card(G, ch?.id));
    const onlyChars = ch?.bornTurn === G.turn && kw.rushChar && !kw.rush;
    if (onlyChars) return out;
  }
  out.push({ kind: 'leader' });
  return out;
}

function declareAttack(G, s, attacker, target) {
  const S = side(G, s);
  const power = unitPower(G, s, attacker);
  const name = unitName(G, s, attacker);

  if (attacker === 'leader') S.leaderRested = true;
  else {
    const ch = findChar(G, s, attacker);
    ch.rested = true;
  }

  G.combat = { attacker, attackerSide: s, target, power, bonus: 0, blocked: false };
  log(G, 'attack', `${name} attacks with ${power.toLocaleString()} power.`, { side: s, attacker, target });

  if (attacker !== 'leader') {
    enqueueEffects(G, s, card(G, findChar(G, s, attacker).id), 'whenAttacking', { unit: attacker });
    pump(G);
    if (G.pending) return;    // finish the trigger first; combat resumes after
  }
  openBlockStep(G);
}

function openBlockStep(G) {
  const d = other(G.combat.attackerSide);
  const D = side(G, d);

  // [Unblockable] skips the block step entirely — printed or granted.
  const atk = G.combat.attacker;
  if (atk !== 'leader') {
    const a = findChar(G, G.combat.attackerSide, atk);
    if (a && (/\[Unblockable\]/i.test(cardText(card(G, a.id))) || hasFlag(a, 'unblockable', G.turn))) {
      return openCounterStep(G);
    }
  }

  const blockers = D.chars.filter(c => !c.rested
    && !hasFlag(c, 'cannotRest', G.turn)          // blocking requires resting
    && (keywords(card(G, c.id)).blocker || hasFlag(c, 'blocker', G.turn))
    && !(G.combat.target.kind === 'char' && G.combat.target.uid === c.uid));
  if (!blockers.length) return openCounterStep(G);

  G.pending = {
    type: 'block', side: d,
    prompt: 'Block this attack?',
    options: blockers.map(b => ({ uid: b.uid, label: card(G, b.id)?.name || b.id, power: charPower(G, d, b) })),
  };
}

function openCounterStep(G) {
  const d = other(G.combat.attackerSide);
  const D = side(G, d);
  const options = counterOptions(G, d);
  if (!options.length) return resolveCombat(G);

  G.pending = {
    type: 'counter', side: d,
    prompt: 'Play counters?',
    attackPower: G.combat.power,
    defendPower: defenderPower(G) + G.combat.bonus,
    options,
  };
}

export function counterOptions(G, d) {
  const D = side(G, d);
  return D.hand.map((id, i) => {
    const c = card(G, id);
    if (!c) return null;
    if (c.counter) return { index: i, cardId: id, label: c.name, value: c.counter, cost: 0 };
    const ev = counterValue(c);
    if (ev && costOf(c) <= D.donActive) return { index: i, cardId: id, label: c.name, value: ev, cost: costOf(c) };
    return null;
  }).filter(Boolean);
}

function defenderPower(G) {
  const d = other(G.combat.attackerSide);
  return G.combat.target.kind === 'leader'
    ? leaderPower(G, d)
    : (findChar(G, d, G.combat.target.uid) ? charPower(G, d, findChar(G, d, G.combat.target.uid)) : 0);
}

function resolveCombat(G) {
  const C = G.combat;
  if (!C) return;
  const a = C.attackerSide;
  const d = other(a);
  G.combat = null;

  if (C.target.kind === 'char') {
    const ch = findChar(G, d, C.target.uid);
    if (!ch) return;
    const dp = charPower(G, d, ch) + C.bonus;
    if (C.power >= dp) {
      log(G, 'battle', `${unitName(G, a, C.attacker)} beat ${card(G, ch.id)?.name} (${C.power.toLocaleString()} vs ${dp.toLocaleString()}).`);
      koChar(G, d, ch.uid);
    } else {
      log(G, 'battle', `${card(G, ch.id)?.name} survived (${dp.toLocaleString()} vs ${C.power.toLocaleString()}).`);
    }
  } else {
    const lp = leaderPower(G, d) + C.bonus;
    if (C.power >= lp) {
      // [Double Attack] takes two Life cards instead of one.
      const attackerCard = C.attacker === 'leader'
        ? card(G, side(G, a).leaderId)
        : card(G, findChar(G, a, C.attacker)?.id);
      const hits = keywords(attackerCard).doubleAttack ? 2 : 1;
      log(G, 'battle', `The attack connected (${C.power.toLocaleString()} vs ${lp.toLocaleString()})${hits > 1 ? ' — [Double Attack]' : ''}.`);
      for (let i = 0; i < hits && !G.over && !G.pending; i++) dealDamage(G, d);
    } else {
      log(G, 'battle', `The attack bounced off the Leader (${lp.toLocaleString()} vs ${C.power.toLocaleString()}).`);
    }
  }
  pump(G);
}

/* ---------------------------------------------------------------------- */
/* actions                                                                 */
/* ---------------------------------------------------------------------- */

/** Everything the side to act may legally do right now. */
export function legalActions(G) {
  if (G.over) return [];
  const out = [];

  if (G.pending) {
    const p = G.pending;
    if (p.type === 'block') {
      out.push({ type: 'block', uid: null });
      for (const o of p.options) out.push({ type: 'block', uid: o.uid });
    } else if (p.type === 'counter') {
      out.push({ type: 'counter', index: null });
      for (const o of p.options) out.push({ type: 'counter', index: o.index });
    } else if (p.type === 'trigger') {
      out.push({ type: 'trigger', activate: true });
      out.push({ type: 'trigger', activate: false });
    } else if (p.type === 'confirm') {
      out.push({ type: 'choose', value: true });
      out.push({ type: 'choose', value: false });
    } else if (p.type === 'manual') {
      for (const o of p.options) out.push({ type: 'choose', value: o.key });
    } else if (p.type === 'mode') {
      for (const o of p.options) out.push({ type: 'choose', value: o.index });
    } else if (p.type === 'target') {
      if (p.optional) out.push({ type: 'choose', value: null });
      for (const o of p.options) out.push({ type: 'choose', value: o.uid ?? o.index });
    }
    return out;
  }

  const s = G.active;
  const S = side(G, s);

  if (G.phase !== 'main') { out.push({ type: 'advance' }); return out; }

  for (let i = 0; i < S.hand.length; i++) if (canPlay(G, s, i)) out.push({ type: 'play', index: i });
  if (S.donActive > 0) {
    out.push({ type: 'attach', target: 'leader' });
    for (const ch of S.chars) out.push({ type: 'attach', target: ch.uid });
  }
  for (const ref of ['leader', ...S.chars.map(c => c.uid)]) {
    if (!canAttack(G, s, ref)) continue;
    for (const t of attackTargets(G, s, ref)) out.push({ type: 'attack', attacker: ref, target: t });
  }
  if (canUseLeaderAbility(G, s)) out.push({ type: 'leaderAbility' });
  for (const ch of S.chars) {
    if (canActivateChar(G, s, ch.uid)) out.push({ type: 'activateChar', uid: ch.uid });
  }
  out.push({ type: 'advance' });
  return out;
}

/**
 * Whether the Leader's [Activate: Main] ability can be used, and if not, why.
 *
 * The reason matters: a control that silently disappears reads as "this Leader
 * has no ability", which is a very different message from "already used".
 */
export function leaderAbilityStatus(G, s) {
  const S = side(G, s);
  const leader = card(G, S.leaderId);
  const script = scriptFor(S.leaderId, 'activate');
  const hasAbility = !!script || parseEffects(leader).some(e => e.when === 'activate');

  if (!hasAbility) return { has: false, usable: false, reason: 'This Leader has no [Activate: Main] ability.' };
  if (G.over) return { has: true, usable: false, reason: 'The game is over.' };
  if (G.active !== s) return { has: true, usable: false, reason: 'Only on your turn.' };
  if (G.phase !== 'main') return { has: true, usable: false, reason: 'Only during your Main Phase.' };
  if (G.pending) return { has: true, usable: false, reason: 'Resolve the current prompt first.' };
  if (S.once.leader) return { has: true, usable: false, reason: 'Already used this turn.' };
  if (S.turnsTaken < 2 && /second turn or later/i.test(cardText(leader))) {
    return { has: true, usable: false, reason: 'Available from your second turn onward.' };
  }
  if (script && !meetsRequirements(G, s, script.require)) {
    return { has: true, usable: false, reason: script.unmetReason || 'The card\'s condition is not met right now.' };
  }
  return { has: true, usable: true, reason: '' };
}

export const canUseLeaderAbility = (G, s) => leaderAbilityStatus(G, s).usable;

/**
 * Whether a Character's [Activate: Main] ability can be used, and if not, why.
 *
 * Characters carry roughly as many activated abilities as Leaders do across a
 * real field, so leaving this unwired silently disabled a large slice of every
 * deck — including scripted cards whose `activate` clause could never fire.
 */
export function charAbilityStatus(G, s, uid) {
  const S = side(G, s);
  const ch = findChar(G, s, uid);
  if (!ch) return { has: false, usable: false, reason: 'No such character.' };

  const c = card(G, ch.id);
  const script = scriptFor(ch.id, 'activate');
  const hasAbility = !!script || parseEffects(c).some(e => e.when === 'activate');
  if (!hasAbility) return { has: false, usable: false, reason: '' };

  if (G.over) return { has: true, usable: false, reason: 'The game is over.' };
  if (G.active !== s) return { has: true, usable: false, reason: 'Only on your turn.' };
  if (G.phase !== 'main') return { has: true, usable: false, reason: 'Only during your Main Phase.' };
  if (G.pending) return { has: true, usable: false, reason: 'Resolve the current prompt first.' };
  // [Once Per Turn] is tracked per body in play, not per card name.
  if (S.once[`char:${uid}`]) return { has: true, usable: false, reason: 'Already used this turn.' };

  // An ability whose cost is "rest this Character" needs it active.
  const cost = script?.cost || parseEffects(c).find(e => e.when === 'activate')?.cost;
  if (cost?.restSelf && ch.rested) return { has: true, usable: false, reason: 'This Character is already rested.' };
  if (cost && !canPayCost(G, s, cost)) return { has: true, usable: false, reason: 'You cannot pay its cost right now.' };
  if (script && !meetsRequirements(G, s, script.require)) {
    return { has: true, usable: false, reason: script.unmetReason || "The card's condition is not met right now." };
  }
  return { has: true, usable: true, reason: '' };
}

export const canActivateChar = (G, s, uid) => charAbilityStatus(G, s, uid).usable;

/** Apply one action. Mutates G and returns it. */
export function apply(G, action) {
  if (!action || G.over) return G;
  const before = G.log.length;

  if (G.pending) applyPending(G, action);
  else applyMain(G, action);

  pump(G);
  checkDeckOut(G);
  G.lastEvents = G.log.slice(before);
  return G;
}

function applyPending(G, action) {
  const p = G.pending;
  const s = p.side;

  if (p.type === 'block' && action.type === 'block') {
    G.pending = null;
    if (action.uid) {
      const b = findChar(G, s, action.uid);
      if (b) {
        b.rested = true;
        G.combat.target = { kind: 'char', uid: action.uid };
        G.combat.blocked = true;
        log(G, 'block', `${card(G, b.id)?.name} blocked.`, { side: s });
        enqueueEffects(G, s, card(G, b.id), 'onBlock', { unit: b.uid });
        pump(G);
        if (G.pending) return;
      }
    }
    return openCounterStep(G);
  }

  if (p.type === 'counter' && action.type === 'counter') {
    if (action.index == null) { G.pending = null; return resolveCombat(G); }
    const S = side(G, s);
    const opt = p.options.find(o => o.index === action.index);
    if (!opt) { G.pending = null; return resolveCombat(G); }
    if (opt.cost > S.donActive) return;
    S.donActive -= opt.cost;
    S.donRested += opt.cost;
    S.hand.splice(opt.index, 1);
    S.trash.push(opt.cardId);
    G.combat.bonus += opt.value;
    log(G, 'counter', `${S.name} countered with ${opt.label} (+${opt.value.toLocaleString()}).`, { side: s });
    G.pending = null;
    return openCounterStep(G);        // may counter again
  }

  if (p.type === 'trigger' && action.type === 'trigger') {
    const S = side(G, s);
    G.pending = null;
    if (action.activate) {
      const i = S.hand.lastIndexOf(p.cardId);
      if (i >= 0) S.hand.splice(i, 1);
      S.trash.push(p.cardId);
      const c = card(G, p.cardId);
      log(G, 'trigger', `${S.name} activated the [Trigger] on ${c?.name}.`, { side: s });
      G.pending = {
        type: 'manual', side: s, source: p.cardId,
        prompt: `${c?.name}: apply the trigger`,
        text: triggerText(c),
        options: manualOptions(),
      };
    }
    return;
  }

  if (p.type === 'confirm' && action.type === 'choose') {
    const item = p.onYes;
    G.pending = null;
    if (action.value) {
      payCost(G, s, item.clause.cost, item.unit);
      G.queue.unshift(item);
    }
    return;
  }

  if (p.type === 'manual' && action.type === 'choose') {
    G.pending = null;
    applyManual(G, s, action.value);
    return;
  }

  // "Choose one:" — run the ops of whichever mode was picked.
  if (p.type === 'mode' && action.type === 'choose') {
    const mode = p.modes[action.value];
    G.pending = null;
    if (mode) {
      log(G, 'effect', `${card(G, p.source)?.name ?? 'Effect'}: ${mode.label}`, { side: s });
      G.queue.unshift({ side: s, clause: { ops: mode.ops, when: 'onPlay' }, source: card(G, p.source), costPaid: true });
    }
    return;
  }

  if (p.type === 'target' && action.type === 'choose') {
    G.pending = null;
    if (action.value == null) return;
    const d = other(s);
    if (p.kind === 'ko') koChar(G, d, action.value);
    else if (p.kind === 'rest') { const ch = findChar(G, d, action.value) || findChar(G, s, action.value); if (ch) ch.rested = true; }
    else if (p.kind === 'bounce') {
      const O = side(G, d);
      const i = O.chars.findIndex(c => c.uid === action.value);
      if (i >= 0) { const ch = O.chars.splice(i, 1)[0]; O.donActive += ch.don; O.deck.unshift(ch.id); log(G, 'effect', `${card(G, ch.id)?.name} was returned to the bottom of the deck.`); }
    } else if (p.kind === 'power') {
      const t = p.targetSide;
      const ch = findChar(G, t, action.value);
      if (ch) ch.mods.push({ amount: p.amount, expires: G.turn });
      log(G, 'effect', `${p.amount > 0 ? '+' : ''}${p.amount.toLocaleString()} power applied.`);
    } else if (p.kind === 'playFree') {
      playCard(G, s, action.value, { free: true });
    } else if (p.kind === 'donGive') {
      p.give(action.value, p.amount);
    } else if (p.kind === 'flag') {
      const ch = findChar(G, p.targetSide, action.value);
      if (ch) {
        addFlag(ch, p.flagKind, p.expires);
        log(G, 'effect', `${card(G, ch.id)?.name} — ${p.flagKind}.`);
      }
    } else if (p.kind === 'costMod') {
      const ch = findChar(G, p.targetSide, action.value);
      if (ch) (ch.costMods ||= []).push({ amount: p.amount, expires: p.expires });
    } else if (p.kind === 'basePowerFrom') {
      const me = findChar(G, s, p.selfUid);
      const them = findChar(G, other(s), action.value);
      if (me && them) {
        me.baseMods.push({ power: charPower(G, other(s), them), expires: p.expires });
        log(G, 'effect', `${card(G, me.id)?.name} base power became ${charPower(G, other(s), them).toLocaleString()}.`);
      }
    } else if (p.kind === 'setActive') {
      const ch = findChar(G, s, action.value);
      if (ch) { ch.rested = false; log(G, 'effect', `${card(G, ch.id)?.name} set active.`); }
    } else if (p.kind === 'playFromTrash') {
      const S2 = side(G, s);
      const id = S2.trash[action.value];
      if (id) {
        S2.trash.splice(action.value, 1);
        const ch = newChar(id, G.turn);
        if (p.rested) ch.rested = true;
        S2.chars.push(ch);
        log(G, 'play', `${S2.name} played ${card(G, id)?.name} from the trash${p.rested ? ' rested' : ''}.`, { side: s, cardId: id });
        enqueueEffects(G, s, card(G, id), 'onPlay');
      }
    } else if (p.kind === 'searchTrashToHand') {
      const S3 = side(G, s);
      const id = S3.trash[action.value];
      if (id) { S3.trash.splice(action.value, 1); S3.hand.push(id); log(G, 'effect', `${S3.name} took ${card(G, id)?.name} from the trash.`, { side: s }); }
    } else if (p.kind === 'lifeFromTrash') {
      const S4 = side(G, s);
      const id = S4.trash[action.value];
      if (id) { S4.trash.splice(action.value, 1); S4.life.push(id); log(G, 'effect', `${S4.name} added ${card(G, id)?.name} to their Life.`, { side: s }); }
    } else if (p.kind === 'lifeFromHand') {
      const S5 = side(G, s);
      const id = S5.hand[action.value];
      if (id != null) { S5.hand.splice(action.value, 1); S5.life.push(id); log(G, 'effect', `${S5.name} put a card on top of their Life.`, { side: s }); }
    } else if (p.kind === 'returnToHand' || p.kind === 'bottomDeck') {
      const owner = p.owners[action.value];
      const O5 = side(G, owner);
      const i = O5.chars.findIndex(ch => ch.uid === action.value);
      if (i >= 0) {
        const ch = O5.chars.splice(i, 1)[0];
        O5.donActive += ch.don;
        if (p.kind === 'returnToHand') O5.hand.push(ch.id);
        else O5.deck.unshift(ch.id);
        log(G, 'effect', `${card(G, ch.id)?.name} was ${p.kind === 'returnToHand' ? "returned to its owner's hand" : "placed on the bottom of its owner's deck"}.`);
      }
    }
    // Combat waits on effect resolution; restart the block step once clear.
    if (G.combat && !G.pending && !G.queue.length && !G.combat.resolved) openBlockStep(G);
    return;
  }
}

function applyMain(G, action) {
  const s = G.active;
  const S = side(G, s);

  switch (action.type) {
    case 'advance':
      advancePhase(G);
      break;

    case 'play':
      if (canPlay(G, s, action.index)) playCard(G, s, action.index);
      break;

    case 'attach': {
      if (G.phase !== 'main' || S.donActive < 1) break;
      S.donActive--;
      if (action.target === 'leader') S.leaderDon++;
      else {
        const ch = findChar(G, s, action.target);
        if (!ch) { S.donActive++; break; }
        ch.don++;
      }
      log(G, 'don', `${S.name} attached 1 DON!! to ${unitName(G, s, action.target)} (+1000 power).`, { side: s });
      break;
    }

    case 'attack':
      if (canAttack(G, s, action.attacker)) declareAttack(G, s, action.attacker, action.target);
      break;

    case 'leaderAbility': {
      if (!canUseLeaderAbility(G, s)) break;
      S.once.leader = 1;
      const leader = card(G, S.leaderId);
      log(G, 'effect', `${S.name} used their Leader's ability.`, { side: s });
      enqueueEffects(G, s, leader, 'activate', { unit: 'leader' });
      break;
    }

    case 'activateChar': {
      if (!canActivateChar(G, s, action.uid)) break;
      const ch = findChar(G, s, action.uid);
      const c = card(G, ch.id);
      S.once[`char:${action.uid}`] = 1;
      log(G, 'effect', `${S.name} activated ${c?.name}'s ability.`, { side: s, cardId: ch.id });
      enqueueEffects(G, s, c, 'activate', { unit: action.uid });
      break;
    }

    case 'mulligan': {
      if (G.turn > 1 || S.mulliganed) break;
      S.mulliganed = true;
      if (action.keep) break;
      S.deck.push(...S.hand);
      shuffle(S.deck, G.rng);
      S.hand = [];
      for (let i = 0; i < 5; i++) S.hand.push(S.deck.pop());
      log(G, 'phase', `${S.name} mulliganed.`, { side: s });
      break;
    }

    case 'concede':
      finish(G, other(s), `${S.name} conceded.`);
      break;
  }
}

function checkDeckOut(G) {
  if (G.over) return;
  // Running out of cards only loses the game when you must draw, which
  // drawCards already handles. Nothing to do here beyond a safety net.
}

/* ---------------------------------------------------------------------- */
/* snapshot helpers for the UI                                             */
/* ---------------------------------------------------------------------- */

/** A compact, render-friendly view of one side. */
export function view(G, s) {
  const S = side(G, s);
  return {
    id: s, name: S.name, leaderId: S.leaderId,
    leaderPower: leaderPower(G, s),
    leaderDon: S.leaderDon,
    leaderRested: S.leaderRested,
    hand: S.hand.slice(),
    handCount: S.hand.length,
    life: S.life.length,
    lifeMax: lifeTotal(card(G, S.leaderId)),
    deck: S.deck.length,
    trash: S.trash.length,
    donActive: S.donActive,
    donRested: S.donRested,
    donDeck: S.donDeck,
    stage: S.stage,
    chars: S.chars.map(ch => ({
      uid: ch.uid, id: ch.id, don: ch.don, rested: ch.rested,
      power: charPower(G, s, ch),
      summoningSick: ch.bornTurn === G.turn && !canAttack(G, s, ch.uid),
    })),
  };
}
