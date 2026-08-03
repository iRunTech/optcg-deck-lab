/* Engine tests — run with: npm test
 *
 * A synthetic card set keeps these deterministic and independent of the live
 * punk-records feed. meta.test.mjs covers the real data separately.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createGame, apply, legalActions, view, other,
  leaderPower, charPower, findChar, canAttack, attackTargets, PHASES,
} from '../src/engine/engine.js';
import { decide, runAI, SKILL } from '../src/engine/ai.js';
import {
  parseEffects, keywords, counterValue, donDeckSize, lifeTotal, copyLimit,
} from '../src/engine/cardtext.js';
import { makeRng, shuffle } from '../src/engine/rng.js';

/* ---------------------------------------------------------------------- */
/* fixtures                                                                */
/* ---------------------------------------------------------------------- */

const CARDS = {
  'LD-001': { id: 'LD-001', name: 'Test Leader', category: 'Leader', colors: ['Red'], cost: 4, power: 5000, effect: '-', types: ['Crew'] },
  'LD-002': { id: 'LD-002', name: 'Ramp Leader', category: 'Leader', colors: ['Purple'], cost: 5, power: 5000, types: ['Crew'], effect: 'Your DON!! deck consists of 6 DON!! cards.<br>[Activate: Main] Add up to 4 DON!! cards from your DON!! deck and rest them.' },
  'CH-VAN': { id: 'CH-VAN', name: 'Vanilla', category: 'Character', colors: ['Red'], cost: 2, power: 3000, counter: 1000, effect: '-', types: ['Crew'] },
  'CH-BIG': { id: 'CH-BIG', name: 'Bruiser', category: 'Character', colors: ['Red'], cost: 5, power: 7000, counter: null, effect: '-', types: ['Crew'] },
  'CH-BLK': { id: 'CH-BLK', name: 'Wall', category: 'Character', colors: ['Red'], cost: 3, power: 4000, counter: 1000, effect: '[Blocker] (After your opponent declares an attack, you may rest this card to make it the new target of the attack.)', types: ['Crew'] },
  'CH-RSH': { id: 'CH-RSH', name: 'Runner', category: 'Character', colors: ['Red'], cost: 3, power: 4000, counter: 1000, effect: '[Rush] (This card can attack on the turn in which it is played.)', types: ['Crew'] },
  'CH-DRW': { id: 'CH-DRW', name: 'Scholar', category: 'Character', colors: ['Red'], cost: 2, power: 2000, counter: 2000, effect: '[On Play] Draw 1 card.', types: ['Crew'] },
  'CH-KO': { id: 'CH-KO', name: 'Assassin', category: 'Character', colors: ['Red'], cost: 4, power: 5000, counter: 1000, effect: "[On Play] K.O. up to 1 of your opponent's Characters with a cost of 3 or less.", types: ['Crew'] },
  'CH-TRG': { id: 'CH-TRG', name: 'Omen', category: 'Character', colors: ['Red'], cost: 2, power: 3000, counter: 1000, effect: '-', trigger: '[Trigger] Draw 1 card.', types: ['Crew'] },
  'EV-CTR': { id: 'EV-CTR', name: 'Parry', category: 'Event', colors: ['Red'], cost: 1, power: null, counter: null, effect: '[Counter] Your Leader or 1 of your Characters gains +3000 power during this battle.', types: ['Crew'] },
};

const deckOf = (id, n = 50) => ({ [id]: n });

function game(opts = {}) {
  return createGame({
    cards: CARDS,
    seed: opts.seed ?? 42,
    firstPlayer: opts.firstPlayer ?? 'p1',
    p1: { name: 'A', leaderId: opts.l1 ?? 'LD-001', deck: opts.d1 ?? deckOf('CH-VAN') },
    p2: { name: 'B', leaderId: opts.l2 ?? 'LD-001', deck: opts.d2 ?? deckOf('CH-VAN') },
  });
}

/** Advance until the active player is in their Main Phase. */
function toMain(G) {
  let guard = 0;
  while (G.phase !== 'main' && !G.over && guard++ < 10) apply(G, { type: 'advance' });
  return G;
}

/* ---------------------------------------------------------------------- */
/* rng                                                                     */
/* ---------------------------------------------------------------------- */

test('rng is deterministic and shuffle is seed-stable', () => {
  const a = makeRng(7), b = makeRng(7);
  assert.equal(a(), b());
  const x = shuffle([1, 2, 3, 4, 5, 6, 7, 8], makeRng(99));
  const y = shuffle([1, 2, 3, 4, 5, 6, 7, 8], makeRng(99));
  assert.deepEqual(x, y);
  const z = shuffle([1, 2, 3, 4, 5, 6, 7, 8], makeRng(100));
  assert.notDeepEqual(x, z);
});

/* ---------------------------------------------------------------------- */
/* card text                                                               */
/* ---------------------------------------------------------------------- */

test('keywords distinguish printed Rush from conditional Rush', () => {
  assert.equal(keywords(CARDS['CH-RSH']).rush, true);
  assert.equal(keywords(CARDS['CH-BLK']).blocker, true);
  assert.equal(keywords(CARDS['CH-VAN']).rush, false);

  // "[DON!! x2] … gains [Rush]" must report the real threshold, not a guess.
  const conditional = { effect: '[DON!! x2] This Character gains [Rush].' };
  const kw = keywords(conditional);
  assert.equal(kw.rush, false, 'conditional rush is not unconditional');
  assert.equal(kw.rushIf, 2);

  const x1 = keywords({ effect: '[DON!! x1] This Character gains [Rush].' });
  assert.equal(x1.rushIf, 1, 'threshold is read off the card, not hardcoded to 2');
});

test('an opponent draw clause does not draw for the controller', () => {
  const mine = parseEffects({ effect: '[On Play] Draw 2 cards.' })[0];
  assert.equal(mine.ops[0].op, 'draw');
  assert.equal(mine.ops[0].side, 'self');
  assert.equal(mine.ops[0].n, 2);

  const theirs = parseEffects({ effect: '[On Play] Your opponent draws 1 card.' })[0];
  assert.equal(theirs.ops[0].side, 'opp');
});

test('an activation cost is separated from the effect it pays for', () => {
  // The prototype fired both halves; the discard must be a cost, not an effect.
  const e = parseEffects({ effect: '[On Play] You may trash 1 card from your hand: Draw 2 cards.' })[0];
  assert.ok(e.cost, 'cost clause detected');
  assert.equal(e.cost.discard, 1);
  assert.equal(e.cost.optional, true);
  assert.equal(e.ops.length, 1);
  assert.equal(e.ops[0].op, 'draw');
  assert.equal(e.ops[0].n, 2);
});

test('counter value reads printed counters and [Counter] events', () => {
  assert.equal(counterValue(CARDS['CH-VAN']), 1000);
  assert.equal(counterValue(CARDS['EV-CTR']), 3000);
  assert.equal(counterValue(CARDS['CH-BIG']), 0);
});

test('leader text sets DON!! deck size and life', () => {
  assert.equal(donDeckSize(CARDS['LD-001']), 10);
  assert.equal(donDeckSize(CARDS['LD-002']), 6, 'Enel-likes shrink the DON!! deck');
  assert.equal(lifeTotal(CARDS['LD-001']), 4);
  assert.equal(lifeTotal(CARDS['LD-002']), 5);
});

test('copy limit respects "any number" cards', () => {
  assert.equal(copyLimit(CARDS['CH-VAN']), 4);
  assert.equal(copyLimit({ effect: 'You may include any number of this card in your deck.' }), 99);
});

/* ---------------------------------------------------------------------- */
/* setup and turn structure                                                */
/* ---------------------------------------------------------------------- */

test('opening hands and life are dealt from the deck', () => {
  const G = game();
  assert.equal(G.p1.hand.length, 5);
  assert.equal(G.p1.life.length, 4, 'life comes from the Leader cost field');
  assert.equal(G.p1.deck.length, 50 - 5 - 4);
});

test('the player on the play skips their first draw and gains 1 DON!!', () => {
  const G = game({ firstPlayer: 'p1' });
  assert.equal(G.turn, 1);
  assert.equal(G.phase, 'refresh');

  apply(G, { type: 'advance' });             // -> draw
  assert.equal(G.phase, 'draw');
  assert.equal(G.p1.hand.length, 5, 'no draw on turn 1 for the player going first');

  apply(G, { type: 'advance' });             // -> don
  assert.equal(G.p1.donActive, 1, 'only 1 DON!! on the opening turn');
});

test('the second player draws and gains 2 DON!! on their first turn', () => {
  const G = game({ firstPlayer: 'p1' });
  let guard = 0;
  while (G.active === 'p1' && guard++ < 12) apply(G, { type: 'advance' });
  assert.equal(G.active, 'p2');
  while (G.phase !== 'main' && guard++ < 20) apply(G, { type: 'advance' });
  assert.equal(G.p2.hand.length, 6, 'the player going second draws on turn 1');
  assert.equal(G.p2.donActive, 2);
});

test('refresh returns attached DON!! and sets cards active', () => {
  const G = toMain(game());
  apply(G, { type: 'play', index: 0 });                 // CH-VAN, cost 2 -> needs DON
  // Turn 1 only has 1 DON!!, so the play should have been rejected.
  assert.equal(G.p1.chars.length, 0);
  assert.equal(G.p1.donActive, 1);

  // Cycle to p1's next turn, where they have 3 DON!!.
  let guard = 0;
  while (!(G.active === 'p1' && G.turn === 3) && guard++ < 40) apply(G, { type: 'advance' });
  while (G.phase !== 'main' && guard++ < 50) apply(G, { type: 'advance' });
  assert.equal(G.p1.donActive, 3, '1 + 2 across two of our turns');

  apply(G, { type: 'play', index: 0 });
  assert.equal(G.p1.chars.length, 1);
  assert.equal(G.p1.donActive, 1);
  assert.equal(G.p1.donRested, 2, 'paying a cost rests the DON!!');

  apply(G, { type: 'attach', target: G.p1.chars[0].uid });
  assert.equal(G.p1.chars[0].don, 1);
  assert.equal(G.p1.donActive, 0);

  // Next own turn: everything comes back during Refresh, before any new DON!!.
  guard = 0;
  while (!(G.active === 'p1' && G.turn === 5) && guard++ < 40) apply(G, { type: 'advance' });
  assert.equal(G.phase, 'refresh');
  assert.equal(G.p1.donRested, 0);
  assert.equal(G.p1.chars[0].don, 0, 'attached DON!! returned');
  assert.equal(G.p1.chars[0].rested, false);
  assert.equal(G.p1.donActive, 3, 'all 3 owned DON!! are active again');

  while (G.phase !== 'main' && guard++ < 50) apply(G, { type: 'advance' });
  assert.equal(G.p1.donActive, 5, 'plus 2 from the DON!! phase');
});

/* ---------------------------------------------------------------------- */
/* combat                                                                  */
/* ---------------------------------------------------------------------- */

test('summoning sickness blocks attacking unless the card has Rush', () => {
  const G = toMain(game({ d1: { 'CH-RSH': 25, 'CH-VAN': 25 } }));
  let guard = 0;
  while (!(G.active === 'p1' && G.turn === 3) && guard++ < 40) apply(G, { type: 'advance' });
  while (G.phase !== 'main' && guard++ < 50) apply(G, { type: 'advance' });

  const rushIdx = G.p1.hand.findIndex(id => id === 'CH-RSH');
  const vanIdx = G.p1.hand.findIndex(id => id === 'CH-VAN');
  if (rushIdx >= 0) {
    apply(G, { type: 'play', index: rushIdx });
    const ch = G.p1.chars[G.p1.chars.length - 1];
    assert.equal(canAttack(G, 'p1', ch.uid), true, 'Rush can attack the turn it lands');
  }
  if (vanIdx >= 0 && G.p1.donActive >= 2) {
    const before = G.p1.chars.length;
    apply(G, { type: 'play', index: G.p1.hand.findIndex(id => id === 'CH-VAN') });
    if (G.p1.chars.length > before) {
      const ch = G.p1.chars[G.p1.chars.length - 1];
      assert.equal(canAttack(G, 'p1', ch.uid), false, 'a vanilla body is summoning sick');
    }
  }
});

test('characters may only be attacked while rested', () => {
  const G = toMain(game());
  // Give p2 an active character by hand, then check it is not targetable.
  G.p2.chars.push({ uid: 'x1', id: 'CH-VAN', don: 0, rested: false, mods: [], bornTurn: 0 });
  const targets = attackTargets(G, 'p1', 'leader');
  assert.ok(targets.every(t => t.kind !== 'char'), 'an active character is not a legal target');

  G.p2.chars[0].rested = true;
  const targets2 = attackTargets(G, 'p1', 'leader');
  assert.ok(targets2.some(t => t.kind === 'char' && t.uid === 'x1'), 'a rested character is targetable');
});

test('a connecting attack moves a life card to hand', () => {
  const G = toMain(game());
  const lifeBefore = G.p2.life.length;
  const handBefore = G.p2.hand.length;

  apply(G, { type: 'attack', attacker: 'leader', target: { kind: 'leader' } });
  // p2 holds counters, so decline through the counter step.
  let guard = 0;
  while (G.pending && guard++ < 10) {
    if (G.pending.type === 'counter') apply(G, { type: 'counter', index: null });
    else if (G.pending.type === 'block') apply(G, { type: 'block', uid: null });
    else if (G.pending.type === 'trigger') apply(G, { type: 'trigger', activate: false });
    else apply(G, legalActions(G)[0]);
  }

  assert.equal(G.p2.life.length, lifeBefore - 1, 'defender lost a life card');
  assert.equal(G.p2.hand.length, handBefore + 1, 'the life card went to hand');
  assert.equal(G.p1.leaderRested, true, 'attacking rests the attacker');
});

test('counters raise defending power and can save a life', () => {
  const G = toMain(game({ d2: { 'CH-VAN': 50 } }));
  const lifeBefore = G.p2.life.length;

  // 5000 leader vs 5000 leader: the attack would connect without a counter.
  apply(G, { type: 'attack', attacker: 'leader', target: { kind: 'leader' } });
  assert.equal(G.pending?.type, 'counter');
  const opt = G.pending.options[0];
  assert.ok(opt, 'defender has a counter available');

  apply(G, { type: 'counter', index: opt.index });
  // Decline further counters.
  let guard = 0;
  while (G.pending && guard++ < 10) {
    if (G.pending.type === 'counter') apply(G, { type: 'counter', index: null });
    else apply(G, legalActions(G)[0]);
  }
  assert.equal(G.p2.life.length, lifeBefore, 'the counter kept the attack out');
});

test('a blocker redirects the attack and rests itself', () => {
  const G = toMain(game());
  G.p2.chars.push({ uid: 'b1', id: 'CH-BLK', don: 0, rested: false, mods: [], bornTurn: 0 });

  apply(G, { type: 'attack', attacker: 'leader', target: { kind: 'leader' } });
  assert.equal(G.pending?.type, 'block');
  apply(G, { type: 'block', uid: 'b1' });

  const blocker = findChar(G, 'p2', 'b1');
  // 5000 leader vs a 4000 blocker: it blocks, then dies.
  assert.ok(!blocker || blocker.rested, 'the blocker rested to block');
  let guard = 0;
  while (G.pending && guard++ < 10) {
    if (G.pending.type === 'counter') apply(G, { type: 'counter', index: null });
    else apply(G, legalActions(G)[0]);
  }
  assert.equal(G.p2.life.length, 4, 'the Leader took no damage because the blocker ate it');
});

test('an On Play K.O. removes a legal target only', () => {
  const G = toMain(game({ d1: { 'CH-KO': 50 } }));
  let guard = 0;
  while (!(G.active === 'p1' && G.turn === 5) && guard++ < 60) apply(G, { type: 'advance' });
  while (G.phase !== 'main' && guard++ < 70) apply(G, { type: 'advance' });

  G.p2.chars.push({ uid: 'v1', id: 'CH-VAN', don: 0, rested: false, mods: [], bornTurn: 0 });  // cost 2 - legal
  G.p2.chars.push({ uid: 'v2', id: 'CH-BIG', don: 0, rested: false, mods: [], bornTurn: 0 });  // cost 5 - illegal

  apply(G, { type: 'play', index: 0 });
  assert.equal(G.pending?.type, 'target');
  assert.equal(G.pending.kind, 'ko');
  assert.deepEqual(G.pending.options.map(o => o.uid), ['v1'], 'only the cost-3-or-less body is targetable');

  apply(G, { type: 'choose', value: 'v1' });
  assert.equal(findChar(G, 'p2', 'v1'), null, 'target was K.O.d');
  assert.ok(findChar(G, 'p2', 'v2'), 'the illegal target survived');
});

/* ---------------------------------------------------------------------- */
/* determinism and completion                                              */
/* ---------------------------------------------------------------------- */

test('the same seed replays identically', () => {
  const run = seed => {
    const G = createGame({
      cards: CARDS, seed, firstPlayer: 'p1',
      p1: { name: 'A', leaderId: 'LD-001', deck: { 'CH-VAN': 20, 'CH-BLK': 10, 'CH-DRW': 10, 'EV-CTR': 10 } },
      p2: { name: 'B', leaderId: 'LD-001', deck: { 'CH-VAN': 20, 'CH-BIG': 10, 'CH-TRG': 10, 'EV-CTR': 10 } },
    });
    let n = 0;
    while (!G.over && n++ < 3000) {
      const a = decide(G, SKILL.solid);
      if (!a) break;
      apply(G, a);
    }
    return { over: G.over, turns: G.turn, logs: G.log.length };
  };
  assert.deepEqual(run(123), run(123), 'identical seeds produce identical games');
  assert.notDeepEqual(run(123).logs, run(9999).logs);
});

test('an AI-vs-AI game reaches a winner without deadlocking', () => {
  for (const seed of [1, 2, 3, 5, 8, 13]) {
    const G = createGame({
      cards: CARDS, seed, firstPlayer: seed % 2 ? 'p1' : 'p2',
      p1: { name: 'A', leaderId: 'LD-001', deck: { 'CH-VAN': 16, 'CH-BLK': 8, 'CH-RSH': 8, 'CH-DRW': 8, 'EV-CTR': 10 } },
      p2: { name: 'B', leaderId: 'LD-001', deck: { 'CH-BIG': 12, 'CH-KO': 8, 'CH-TRG': 10, 'CH-VAN': 10, 'EV-CTR': 10 } },
    });
    let n = 0;
    while (!G.over && n++ < 4000) apply(G, decide(G, SKILL.solid));
    assert.ok(G.over, `seed ${seed} finished`);
    assert.ok(['p1', 'p2'].includes(G.over.winner));
    assert.ok(n < 4000, `seed ${seed} did not spin`);
  }
});

test('running out of deck loses the game', () => {
  const G = game();
  G.p1.deck = [];                              // next draw is fatal
  let guard = 0;
  while (G.active !== 'p1' && guard++ < 20) apply(G, { type: 'advance' });
  while (!G.over && guard++ < 40) apply(G, { type: 'advance' });
  assert.ok(G.over);
  assert.equal(G.over.winner, 'p2');
});

test('the AI keeps DON!! back to pay for a counter event', () => {
  // A hand with a 1-cost [Counter] event should not be left unable to use it.
  const G = createGame({
    cards: CARDS, seed: 5, firstPlayer: 'p1',
    p1: { name: 'A', leaderId: 'LD-001', deck: { 'CH-VAN': 25, 'EV-CTR': 25 } },
    p2: { name: 'B', leaderId: 'LD-001', deck: { 'CH-VAN': 50 } },
  });
  let guard = 0;
  while (!(G.active === 'p1' && G.phase === 'main' && G.turn >= 5) && guard++ < 80) {
    apply(G, decide(G, SKILL.sharp));
  }
  // Let the AI take its main phase.
  guard = 0;
  while (G.active === 'p1' && !G.over && guard++ < 40) apply(G, decide(G, SKILL.sharp));

  const hasCounterEvent = G.p1.hand.some(id => id === 'EV-CTR');
  if (hasCounterEvent) {
    assert.ok(G.p1.donActive >= 1, 'AI left DON!! available to counter with');
  }
});

test('view() exposes a render-safe snapshot', () => {
  const G = toMain(game());
  const v = view(G, 'p1');
  assert.equal(v.id, 'p1');
  assert.equal(typeof v.leaderPower, 'number');
  assert.ok(Array.isArray(v.chars));
  assert.ok(Array.isArray(v.hand));
  assert.equal(v.life, 4);
});
