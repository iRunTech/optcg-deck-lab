/* AI policy.
 *
 * A pure function from game state to one action. It answers `G.pending`
 * requests through the same interface a human does, so it cannot silently skip
 * a decision the player has to make.
 *
 * Three faults in the prototype's AI are fixed here, all of which made
 * simulated win-rates misleading rather than merely weak:
 *   1. It never played Events, so removal-heavy decks played a card short.
 *   2. It attached every DON!! to one attacker, leaving nothing to pay for a
 *      [Counter] event on the opponent's turn — it could never defend.
 *   3. Its triggers never resolved, so it played a strictly worse game than
 *      the human on the other side of the table.
 */

import {
  legalActions, apply, other, charPower, leaderPower, findChar,
  attackTargets, canAttack, costOf, counterOptions, view,
} from './engine.js';
import { parseEffects, keywords, counterValue } from './cardtext.js';

export const SKILL = { casual: 1, solid: 2, sharp: 3 };

/* How much a card is worth deploying. Cheap heuristics, but tuned so the AI
 * doesn't dump its hand for no board impact. */
function cardValue(G, id) {
  const c = G.cards[id];
  if (!c) return 0;
  let v = (c.power || 0) / 1000;
  const kw = keywords(c);
  const fx = parseEffects(c);

  if (kw.blocker) v += 2.2;
  if (kw.rush) v += 1.6;
  if (kw.doubleAttack) v += 1.5;
  if (c.counter) v += c.counter / 2000;

  for (const e of fx) {
    if (e.when !== 'onPlay') continue;
    for (const op of e.ops) {
      if (op.op === 'ko') v += 3.2;
      if (op.op === 'draw') v += 1.4 * op.n;
      if (op.op === 'dig') v += 1.1;
      if (op.op === 'power') v += 1.0;
      if (op.op === 'donAdd') v += 1.8 * op.n;
      if (op.op === 'playFree') v += 2.0;
      if (op.op === 'bounce') v += 2.4;
    }
  }
  // Events trade themselves for their effect, so they need to earn the slot.
  if (c.category === 'Event') v = Math.max(0, v - 0.5);
  if (c.category === 'Stage') v -= 1;
  return v;
}

/* Keep enough active DON!! to counter with on the opponent's turn. */
function counterReserve(G, s, skill) {
  if (skill < 2) return 0;
  const S = G[s];
  const playableCounterEvents = S.hand.filter(id => {
    const c = G.cards[id];
    return c && !c.counter && counterValue(c) > 0;
  });
  if (!playableCounterEvents.length) return 0;
  const cheapest = Math.min(...playableCounterEvents.map(id => costOf(G.cards[id])));
  return skill >= 3 ? Math.min(2, cheapest) : Math.min(1, cheapest);
}

/* ---------------------------------------------------------------------- */
/* pending answers                                                         */
/* ---------------------------------------------------------------------- */

function answerPending(G, p, skill) {
  const s = p.side;
  const S = G[s];

  if (p.type === 'block') {
    // Block when the hit actually matters: low life, or the blocker survives.
    const atk = G.combat?.power ?? 0;
    const goingToFace = G.combat?.target.kind === 'leader';
    if (skill < 2 || !goingToFace) return { type: 'block', uid: null };
    const worth = S.life.length <= 2;
    if (!worth) return { type: 'block', uid: null };
    const survivors = p.options.filter(o => o.power > atk);
    const pick = survivors[0] || p.options[0];
    return { type: 'block', uid: pick ? pick.uid : null };
  }

  if (p.type === 'counter') {
    const need = p.attackPower - p.defendPower + 1;
    if (need <= 0) return { type: 'counter', index: null };
    const toFace = G.combat?.target.kind === 'leader';

    // Don't burn cards defending a body that isn't worth them.
    if (!toFace && skill < 3) return { type: 'counter', index: null };
    if (toFace && S.life.length > 3 && skill < 3) return { type: 'counter', index: null };

    // Only commit if the total available actually gets there.
    const affordable = p.options.filter(o => o.cost <= S.donActive);
    const reachable = affordable.reduce((a, o) => a + o.value, 0);
    if (reachable < need) return { type: 'counter', index: null };

    // Spend the smallest counter that still contributes.
    const sorted = affordable.slice().sort((a, b) => a.value - b.value);
    const exact = sorted.find(o => o.value >= need);
    return { type: 'counter', index: (exact || sorted[0]).index };
  }

  if (p.type === 'trigger') {
    return { type: 'trigger', activate: skill >= 2 };
  }

  if (p.type === 'confirm') {
    // Pay optional costs when the payoff is a real effect and the hand can spare it.
    return { type: 'choose', value: skill >= 2 && S.hand.length > 2 };
  }

  if (p.type === 'mode') {
    // "Choose one" — prefer the mode that draws cards or develops the board.
    const score = m => {
      let v = 0;
      for (const op of m.ops || []) {
        if (op.op === 'draw') v += 2 * (op.n || 1);
        if (op.op === 'playFree' || op.op === 'playFromTrash') v += 3;
        if (op.op === 'gainKeyword') v += 1.5;
        if (op.op === 'returnStage') v += S.chars.length ? 0.5 : 0;
      }
      return v;
    };
    const best = p.options.slice().sort((a, b) => score(p.modes[b.index]) - score(p.modes[a.index]))[0];
    return { type: 'choose', value: best.index };
  }

  if (p.type === 'manual') {
    const prefer = ['draw1', 'donActive', 'plus1000', 'minus1000', 'life', 'mill', 'skip'];
    const opts = p.options.map(o => o.key);
    const pick = prefer.find(k => opts.includes(k)) || 'skip';
    return { type: 'choose', value: pick };
  }

  if (p.type === 'target') {
    const opts = p.options;
    if (!opts.length) return { type: 'choose', value: null };

    if (p.kind === 'ko' || p.kind === 'bounce') {
      // Remove the biggest threat we're allowed to touch.
      const d = other(s);
      const best = opts.slice().sort((a, b) => {
        const ca = findChar(G, d, a.uid), cb = findChar(G, d, b.uid);
        return (cb ? charPower(G, d, cb) : 0) - (ca ? charPower(G, d, ca) : 0);
      })[0];
      return { type: 'choose', value: best.uid };
    }
    if (p.kind === 'power') {
      const t = p.targetSide;
      const sorted = opts.slice().sort((a, b) => {
        const ca = findChar(G, t, a.uid), cb = findChar(G, t, b.uid);
        const pa = ca ? charPower(G, t, ca) : 0, pb = cb ? charPower(G, t, cb) : 0;
        return p.amount < 0 ? pb - pa : pb - pa;
      });
      return { type: 'choose', value: sorted[0].uid };
    }
    if (p.kind === 'playFree') {
      const best = opts.slice().sort((a, b) => cardValue(G, G[s].hand[b.index]) - cardValue(G, G[s].hand[a.index]))[0];
      return { type: 'choose', value: best.index };
    }
    if (p.kind === 'donGive') {
      // Load the body that can actually swing this turn, else the biggest.
      const live = opts.filter(o => canAttack(G, s, o.uid));
      const pool = live.length ? live : opts;
      const best = pool.slice().sort((a, b) => {
        const ca = findChar(G, s, a.uid), cb = findChar(G, s, b.uid);
        return (cb ? charPower(G, s, cb) : 0) - (ca ? charPower(G, s, ca) : 0);
      })[0];
      return { type: 'choose', value: best.uid };
    }
    if (p.kind === 'rest') return { type: 'choose', value: opts[0].uid };

    // Disable / remove / copy: always aim at the opponent's biggest body.
    if (['flag', 'costMod', 'basePowerFrom', 'returnToHand', 'bottomDeck'].includes(p.kind)) {
      const t = p.targetSide || other(s);
      const owners = p.owners;
      const ranked = opts.slice().sort((a, b) => {
        const sideOf = u => (owners ? owners[u] : t);
        const ca = findChar(G, sideOf(a.uid), a.uid);
        const cb = findChar(G, sideOf(b.uid), b.uid);
        const pa = ca ? charPower(G, sideOf(a.uid), ca) : 0;
        const pb = cb ? charPower(G, sideOf(b.uid), cb) : 0;
        // Never bounce or debuff our own board when a foe is available.
        const mineA = owners && owners[a.uid] === s ? -1e6 : 0;
        const mineB = owners && owners[b.uid] === s ? -1e6 : 0;
        return (pb + mineB) - (pa + mineA);
      });
      const pick = ranked[0];
      if (owners && owners[pick.uid] === s && p.optional) return { type: 'choose', value: null };
      return { type: 'choose', value: pick.uid };
    }

    // Recursion and Life manipulation: take the most expensive card available.
    if (['playFromTrash', 'searchTrashToHand', 'lifeFromTrash'].includes(p.kind)) {
      const best = opts.slice().sort((a, b) => cardValue(G, S.trash[b.index]) - cardValue(G, S.trash[a.index]))[0];
      return { type: 'choose', value: best.index };
    }
    if (p.kind === 'lifeFromHand') {
      // Bury the least useful card in hand.
      const worst = opts.slice().sort((a, b) => cardValue(G, S.hand[a.index]) - cardValue(G, S.hand[b.index]))[0];
      return { type: 'choose', value: worst.index };
    }
    if (p.kind === 'setActive') {
      const best = opts.slice().sort((a, b) => {
        const ca = findChar(G, s, a.uid), cb = findChar(G, s, b.uid);
        return (cb ? charPower(G, s, cb) : 0) - (ca ? charPower(G, s, ca) : 0);
      })[0];
      return { type: 'choose', value: best.uid };
    }

    return { type: 'choose', value: opts[0].uid ?? opts[0].index };
  }

  // Unknown request — take the first legal answer rather than deadlocking.
  const legal = legalActions(G);
  return legal[0] || { type: 'advance' };
}

/* ---------------------------------------------------------------------- */
/* main-phase policy                                                       */
/* ---------------------------------------------------------------------- */

function mainAction(G, s, skill) {
  const S = G[s];
  const d = other(s);
  const D = G[d];

  // 1. Leader ability first — ramp compounds.
  const legal = legalActions(G);
  if (legal.some(a => a.type === 'leaderAbility')) return { type: 'leaderAbility' };

  /* 1b. Character activated abilities. Skip the ones whose cost removes the
   * body from the board while it could still attack — trashing a live attacker
   * for value is usually worse than swinging with it. */
  const activations = legal.filter(a => a.type === 'activateChar');
  for (const a of activations) {
    const ch = findChar(G, s, a.uid);
    const c = ch && G.cards[ch.id];
    const clause = c && (parseEffects(c).find(e => e.when === 'activate'));
    const sacrifices = clause?.cost?.trashSelf;
    if (sacrifices && canAttack(G, s, a.uid) && charPower(G, s, ch) >= 5000) continue;
    return a;
  }

  // 2. Deploy the best card we can still afford, keeping a counter reserve.
  const reserve = counterReserve(G, s, skill);
  const plays = legal.filter(a => a.type === 'play');
  if (plays.length) {
    const scored = plays.map(a => {
      const id = S.hand[a.index];
      const c = G.cards[id];
      const leftAfter = S.donActive - costOf(c);
      return { a, id, v: cardValue(G, id), leftAfter };
    })
      // Respect the reserve unless the play is clearly strong.
      .filter(x => x.leftAfter >= reserve || x.v >= 6)
      .sort((x, y) => y.v - x.v);
    if (scored.length && scored[0].v > 0.5) return scored[0].a;
  }

  // 3. Attack. Prefer trades we win; otherwise go to the Leader's face.
  const attacks = legal.filter(a => a.type === 'attack');
  if (attacks.length) {
    const scored = attacks.map(a => {
      const power = a.attacker === 'leader' ? leaderPower(G, s) : charPower(G, s, findChar(G, s, a.attacker));
      if (a.target.kind === 'leader') {
        const lp = leaderPower(G, d);
        return { a, score: power >= lp ? 10 : -1 };
      }
      const ch = findChar(G, d, a.target.uid);
      if (!ch) return { a, score: -5 };
      const cp = charPower(G, d, ch);
      // Killing a rested body is worth roughly its power, if we can beat it.
      return { a, score: power >= cp ? 4 + cp / 2000 : -2 };
    }).sort((x, y) => y.score - x.score);

    if (scored[0].score > 0) {
      // Casual play doesn't hunt for trades.
      if (skill < 2 && scored[0].a.target.kind === 'char') {
        const face = scored.find(x => x.a.target.kind === 'leader' && x.score > 0);
        if (face) return face.a;
      }
      return scored[0].a;
    }
  }

  // 4. Spend leftover DON!! on power, keeping the counter reserve back.
  const attach = legal.filter(a => a.type === 'attach');
  if (attach.length && S.donActive > reserve) {
    // Feed the biggest attacker that can still swing this turn, else the Leader.
    const live = S.chars.filter(c => canAttack(G, s, c.uid));
    if (live.length) {
      const best = live.slice().sort((a, b) => charPower(G, s, b) - charPower(G, s, a))[0];
      return { type: 'attach', target: best.uid };
    }
    if (skill > 1 && !S.leaderRested) return { type: 'attach', target: 'leader' };
  }

  return { type: 'advance' };
}

/** One action for whichever side the AI controls right now. */
export function decide(G, skill = SKILL.solid) {
  if (G.over) return null;
  if (G.pending) return answerPending(G, G.pending, skill);
  if (G.phase !== 'main') return { type: 'advance' };
  return mainAction(G, G.active, skill);
}

/**
 * Drive the AI until control returns to `human` (or the game ends).
 * `guard` stops a malformed state from spinning forever.
 */
export function runAI(G, aiSide, skill = SKILL.solid, guard = 400) {
  let n = 0;
  while (!G.over && n++ < guard) {
    const needsAI = G.pending ? G.pending.side === aiSide : G.active === aiSide;
    if (!needsAI) break;
    const action = decide(G, skill);
    if (!action) break;
    apply(G, action);
  }
  return G;
}
