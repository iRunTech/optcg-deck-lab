/* Scripted-card tests.
 *
 * Coverage only says the engine *reaches* a card; these check it does the right
 * thing. Each case sets up the exact board state the printed text talks about
 * and asserts the consequence — including the conditions that should make an
 * effect do nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createGame, apply, findChar, charPower, charCost, hasFlag, newChar, leaderPower,
} from '../src/engine/engine.js';
import { SCRIPTS, scriptFor } from '../src/engine/scripts.js';

/* ---------------------------------------------------------------------- */
/* fixtures                                                                */
/* ---------------------------------------------------------------------- */

const C = (id, over = {}) => ({
  id, name: over.name || id, category: 'Character', colors: ['Purple'],
  cost: 2, power: 3000, counter: 1000, effect: '-', trigger: null, types: [], ...over,
});

const CARDS = {
  ENEL: { ...C('ENEL', { name: 'Enel', category: 'Leader', cost: 5, power: 5000, types: ['Sky Island'] }) },
  SHC: { ...C('SHC', { name: 'Straw Leader', category: 'Leader', cost: 5, power: 5000, types: ['Straw Hat Crew'] }) },
  PLAIN: { ...C('PLAIN', { name: 'Plain Leader', category: 'Leader', cost: 5, power: 5000, types: [] }) },
  ACTIVE: {
    ...C('ACTIVE', {
      name: 'Ability Leader', category: 'Leader', cost: 5, power: 5000, types: [],
      effect: '[Activate: Main] [Once Per Turn] Draw 1 card.',
    }),
  },
  BUFFER: {
    ...C('BUFFER', {
      name: 'Buff Leader', category: 'Leader', cost: 5, power: 5000, types: [],
      effect: '[DON!! x1] [Your Turn] All of your Characters gain +1000 power.',
    }),
  },
  ACTOR: C('ACTOR', { name: 'Actor', cost: 3, power: 4000, effect: '[Activate: Main] [Once Per Turn] Draw 1 card.' }),
  RESTER: C('RESTER', {
    name: 'Rester', cost: 3, power: 4000,
    effect: '[Activate: Main] You may rest this Character: Draw 1 card.',
  }),
  DOUBLE: C('DOUBLE', {
    name: 'Doubler', cost: 5, power: 7000, counter: null,
    effect: '[Double Attack] (This card deals 2 damage.)',
  }),
  FILLER: C('FILLER', { name: 'Filler' }),
  BIG: C('BIG', { name: 'Big Body', cost: 6, power: 8000 }),
  SMALL: C('SMALL', { name: 'Small Body', cost: 2, power: 2000 }),

  // scripted cards under test (text lives in scripts.js)
  'OP15-075': { ...C('OP15-075', { name: 'El Thor', category: 'Event', cost: null, power: null, counter: null }) },
  'OP15-076': { ...C('OP15-076', { name: 'Lightning Beast Kiten', category: 'Event', cost: null, power: null, counter: null }) },
  'OP15-074': { ...C('OP15-074', { name: 'Varie', category: 'Event', cost: null, power: null, counter: null }) },
  'OP14-111': { ...C('OP14-111', { name: 'Perona', cost: 4, power: 5000 }) },
  'OP14-104': { ...C('OP14-104', { name: 'Gecko Moria', cost: 8, power: 10000 }) },
  'TBP': C('TBP', { name: 'Bark Body', cost: 3, power: 4000, types: ['Thriller Bark Pirates'] }),
  'OP16-055': { ...C('OP16-055', { name: 'Mr.2.Bon.Kurei(Bentham)', cost: 2, power: 1000 }) },
  'OP16-032': { ...C('OP16-032', { name: 'Boa Hancock', cost: 7, power: 9000, effect: '[Unblockable]' }) },
  'LUFFY': C('LUFFY', { name: 'Monkey.D.Luffy', cost: 3, power: 4000 }),
  'OP08-036': { ...C('OP08-036', { name: 'Electrical Luna', category: 'Event', cost: 3, power: null, counter: null }) },
  'OP15-114': { ...C('OP15-114', { name: 'Wyper', cost: 5, power: 6000 }) },
  'EB03-055': { ...C('EB03-055', { name: 'Nico Robin', cost: 7, power: 8000, counter: null }) },
  'ST10-010': { ...C('ST10-010', { name: 'Trafalgar Law', cost: 4, power: 5000 }) },
  'OP06-058': { ...C('OP06-058', { name: 'Gravity Blade', category: 'Event', cost: 7, power: null, counter: null }) },
  'OP15-055': { ...C('OP15-055', { name: "Go Ahead and Use 'Em", category: 'Event', cost: 3, power: null, counter: null }) },
};

function game({ l1 = 'ENEL', l2 = 'PLAIN', d1 = { FILLER: 50 }, d2 = { FILLER: 50 } } = {}) {
  const G = createGame({
    cards: CARDS, seed: 11, firstPlayer: 'p1',
    p1: { name: 'A', leaderId: l1, deck: d1 },
    p2: { name: 'B', leaderId: l2, deck: d2 },
  });
  // Jump to a Main phase with plenty of resources.
  let guard = 0;
  while (!(G.active === 'p1' && G.phase === 'main') && guard++ < 20) apply(G, { type: 'advance' });
  G.p1.donActive = 10;
  return G;
}

/** Put a scripted card in hand and play it, returning its hand index. */
function playFromHand(G, id) {
  G.p1.hand.unshift(id);
  apply(G, { type: 'play', index: 0 });
  return G;
}

/** Answer whatever the engine is asking, choosing `value`. */
const choose = (G, value) => apply(G, { type: 'choose', value });

const addEnemy = (G, id, opts = {}) => {
  const ch = newChar(id, 0);
  Object.assign(ch, opts);
  G.p2.chars.push(ch);
  return ch;
};
const addFriend = (G, id, opts = {}) => {
  const ch = newChar(id, 0);
  Object.assign(ch, opts);
  G.p1.chars.push(ch);
  return ch;
};

/* ---------------------------------------------------------------------- */
/* registry hygiene                                                        */
/* ---------------------------------------------------------------------- */

test('every script is well-formed', () => {
  const TIMINGS = ['onPlay', 'onKO', 'whenAttacking', 'activate', 'counter', 'trigger', 'onBlock'];
  for (const [id, entry] of Object.entries(SCRIPTS)) {
    assert.ok(entry.note, `${id} documents its printed text`);
    const META_KEYS = ['note', 'unmetReason'];
    const timings = Object.keys(entry).filter(k => !META_KEYS.includes(k));
    assert.ok(timings.length, `${id} defines at least one timing`);
    for (const t of timings) {
      assert.ok(TIMINGS.includes(t), `${id}: "${t}" is a real timing`);
      const clause = entry[t];
      assert.ok(Array.isArray(clause.ops), `${id}.${t} has an ops array`);
      for (const op of clause.ops) assert.ok(op.op, `${id}.${t} op has a name`);
    }
  }
});

test('scriptFor only answers for timings the card defines', () => {
  assert.ok(scriptFor('OP14-111', 'onPlay'));
  assert.ok(scriptFor('OP14-111', 'onKO'));
  assert.equal(scriptFor('OP14-111', 'counter'), null);
  assert.equal(scriptFor('NOT-A-CARD', 'onPlay'), null);
});

/* ---------------------------------------------------------------------- */
/* Enel event suite — conditional on the Leader                            */
/* ---------------------------------------------------------------------- */

test('El Thor K.O.s a small body and costs DON!! when the Leader is Enel', () => {
  const G = game({ l1: 'ENEL' });
  addEnemy(G, 'SMALL');                        // 2000 power - legal target
  const donBefore = G.p1.donActive;
  const donDeckBefore = G.p1.donDeck;

  playFromHand(G, 'OP15-075');
  // power buff targets first, then the K.O.
  while (G.pending && G.pending.kind === 'power') choose(G, G.pending.options[0].uid ?? null);
  assert.equal(G.pending?.kind, 'ko', 'reaches the K.O. clause');
  choose(G, G.pending.options[0].uid);

  assert.equal(G.p2.chars.length, 0, 'the 2000-power body was K.O.d');
  assert.equal(G.p1.donActive, donBefore - 1, 'DON!! -1 was paid');
  assert.equal(G.p1.donDeck, donDeckBefore + 1, 'the spent DON!! returned to the DON!! deck');
});

test('El Thor does nothing under a non-Enel Leader', () => {
  const G = game({ l1: 'PLAIN' });
  addEnemy(G, 'SMALL');
  playFromHand(G, 'OP15-075');
  assert.equal(G.pending, null, 'no prompt — the Leader condition failed');
  assert.equal(G.p2.chars.length, 1, 'nothing was K.O.d');
});

test('El Thor will not K.O. a body above its power ceiling', () => {
  const G = game({ l1: 'ENEL' });
  addEnemy(G, 'BIG');                          // 8000 power - above the 3000 cap
  playFromHand(G, 'OP15-075');
  while (G.pending && G.pending.kind === 'power') choose(G, null);
  assert.notEqual(G.pending?.kind, 'ko', 'no legal K.O. target was offered');
  assert.equal(G.p2.chars.length, 1);
});

test('Lightning Beast Kiten draws and debuffs', () => {
  const G = game({ l1: 'ENEL' });
  const foe = addEnemy(G, 'BIG');
  const handBefore = G.p1.hand.length;
  playFromHand(G, 'OP15-076');
  // playFromHand puts the Event into hand first, so playing it nets zero.
  assert.equal(G.p1.hand.length, handBefore + 1, 'drew 1 card');
  assert.equal(G.pending?.kind, 'power');
  choose(G, foe.uid);
  assert.equal(charPower(G, 'p2', foe), 8000 - 1000, 'target lost 1000 power');
});

test('Varie raises a character cost until the end of the opponent\'s next turn', () => {
  const G = game({ l1: 'ENEL' });
  const mine = addFriend(G, 'SMALL');           // printed cost 2
  playFromHand(G, 'OP15-074');
  assert.equal(G.pending?.kind, 'costMod');
  choose(G, mine.uid);
  assert.equal(charCost(G, mine), 4, 'cost went 2 -> 4');

  // Survives the immediate turn boundary — this is the bug the old engine had.
  const turnOfEffect = G.turn;
  let guard = 0;
  while (G.turn === turnOfEffect && guard++ < 10) apply(G, { type: 'advance' });
  assert.equal(charCost(G, mine), 4, 'still raised during the opponent\'s turn');
});

/* ---------------------------------------------------------------------- */
/* board control                                                           */
/* ---------------------------------------------------------------------- */

test('Perona locks a body out of attacking, and the lock outlives the turn', () => {
  const G = game();
  const foe = addEnemy(G, 'SMALL');
  playFromHand(G, 'OP14-111');
  assert.equal(G.pending?.kind, 'flag');
  choose(G, foe.uid);
  assert.ok(hasFlag(foe, 'cannotAttack', G.turn), 'flagged immediately');

  const t = G.turn;
  let guard = 0;
  while (G.turn === t && guard++ < 10) apply(G, { type: 'advance' });
  assert.ok(hasFlag(foe, 'cannotAttack', G.turn), 'still locked on the opponent\'s turn');
});

test('Perona will not target a body above the cost ceiling', () => {
  const G = game();
  addEnemy(G, 'BIG', {});                       // cost 6 - exactly at the limit
  const G2 = game();
  const tooBig = { ...CARDS.BIG, cost: 9 };
  G2.cards.HUGE = { ...tooBig, id: 'HUGE', name: 'Huge' };
  addEnemy(G2, 'HUGE');
  playFromHand(G2, 'OP14-111');
  assert.equal(G2.pending, null, 'cost 9 is out of range, so nothing was offered');
});

test('Boa Hancock stops a character resting, which blocks it from blocking', () => {
  const G = game();
  const foe = addEnemy(G, 'BIG');
  playFromHand(G, 'OP16-032');
  assert.equal(G.pending?.kind, 'flag');
  choose(G, foe.uid);
  assert.ok(hasFlag(foe, 'cannotRest', G.turn));
});

test('Electrical Luna keeps rested bodies rested through Refresh', () => {
  const G = game();
  const a = addEnemy(G, 'SMALL', { rested: true });
  const b = addEnemy(G, 'BIG', { rested: false });
  playFromHand(G, 'OP08-036');
  assert.equal(G.pending, null, 'the "all" form needs no prompt');
  assert.ok(hasFlag(a, 'wontRefresh', G.turn), 'rested body flagged');
  assert.ok(!hasFlag(b, 'wontRefresh', G.turn), 'active body untouched');

  // Advance to the opponent's Refresh.
  let guard = 0;
  while (!(G.active === 'p2' && G.phase !== 'refresh') && guard++ < 12) apply(G, { type: 'advance' });
  assert.equal(a.rested, true, 'stayed rested through Refresh');
  assert.equal(b.rested, false);
});

test('Wyper sweeps the board only where power actually drops to zero', () => {
  const G = game();
  addEnemy(G, 'SMALL');                         // 2000 -> 0 after -2000, dies
  addEnemy(G, 'BIG');                           // 8000 -> 6000, survives
  playFromHand(G, 'OP15-114');
  while (G.pending && G.pending.type === 'confirm') apply(G, { type: 'choose', value: true });
  assert.equal(G.p2.chars.length, 1, 'only the 2000-power body was swept');
  assert.equal(G.cards[G.p2.chars[0].id].name, 'Big Body');
});

/* ---------------------------------------------------------------------- */
/* recursion, base power, hand attack                                      */
/* ---------------------------------------------------------------------- */

test('Gecko Moria only revives the right type and cost from the trash', () => {
  const G = game();
  G.p1.trash.push('TBP', 'BIG', 'SMALL');       // only TBP matches type + cost
  playFromHand(G, 'OP14-104');

  // The card offers a choice: play it, or bank it on top of Life.
  assert.equal(G.pending?.type, 'mode', 'the play-or-Life choice is offered');
  assert.equal(G.pending.options.length, 2);
  choose(G, 0);                                  // "Play it"

  assert.equal(G.pending?.kind, 'playFromTrash');
  assert.deepEqual(G.pending.options.map(o => o.label), ['Bark Body'],
    'only the Thriller Bark body of cost 4 or less is offered');
  choose(G, G.pending.options[0].index);
  // Gecko Moria is on the field too, so the revived body makes two.
  assert.equal(G.p1.chars.length, 2);
  assert.ok(G.p1.chars.some(ch => G.cards[ch.id].name === 'Bark Body'), 'the Bark body came back');
  assert.ok(!G.p1.trash.includes('TBP'), 'left the trash');
});

test("Mr.2 Bon Kurei copies the opponent Leader's power, but only with DON!! attached", () => {
  const G = game();
  const me = addFriend(G, 'OP16-055');           // printed 1000 power
  // No DON!! attached: the [DON!! x1] gate should hold.
  apply(G, { type: 'attack', attacker: me.uid, target: { kind: 'leader' } });
  assert.equal(charPower(G, 'p1', me), 1000, 'gate held with 0 DON!! attached');

  const G2 = game();
  const me2 = addFriend(G2, 'OP16-055', { don: 1 });
  apply(G2, { type: 'attack', attacker: me2.uid, target: { kind: 'leader' } });
  // 5000 leader base + 1000 from its own attached DON!!
  assert.equal(charPower(G2, 'p1', me2), 5000 + 1000, 'base power became the Leader\'s 5000');
});

test('Trafalgar Law strips two cards only from a large hand', () => {
  const G = game();
  G.p2.hand = ['FILLER', 'FILLER', 'FILLER'];    // only 3 - below the threshold
  playFromHand(G, 'ST10-010');
  while (G.pending?.type === 'confirm') apply(G, { type: 'choose', value: true });
  assert.equal(G.p2.hand.length, 3, 'no discard below 7 cards');

  const G2 = game();
  G2.p2.hand = Array.from({ length: 8 }, () => 'FILLER');
  playFromHand(G2, 'ST10-010');
  while (G2.pending?.type === 'confirm') apply(G2, { type: 'choose', value: true });
  assert.equal(G2.p2.hand.length, 6, 'trashed 2 from a hand of 8');
});

test('Gravity Blade bottoms two characters, prompting separately for each', () => {
  const G = game();
  const a = addEnemy(G, 'SMALL');
  const b = addEnemy(G, 'BIG');
  const deckBefore = G.p2.deck.length;
  playFromHand(G, 'OP06-058');

  assert.equal(G.pending?.kind, 'bottomDeck');
  choose(G, a.uid);
  assert.equal(G.pending?.kind, 'bottomDeck', 'prompts a second time');
  choose(G, b.uid);

  assert.equal(G.p2.chars.length, 0, 'both bodies left the field');
  assert.equal(G.p2.deck.length, deckBefore + 2, 'both went to the bottom of the deck');
});

test('Nico Robin trades a Life card for two, and only under a Straw Hat Leader', () => {
  const G = game({ l1: 'SHC' });
  const lifeBefore = G.p1.life.length;
  playFromHand(G, 'EB03-055');
  assert.equal(G.pending?.type, 'confirm', 'optional cost is offered, not forced');
  apply(G, { type: 'choose', value: true });
  assert.equal(G.p1.life.length, lifeBefore - 1 + 2, 'paid 1 Life, gained 2');

  const G2 = game({ l1: 'PLAIN' });
  const before2 = G2.p1.life.length;
  playFromHand(G2, 'EB03-055');
  assert.equal(G2.pending, null, 'wrong Leader type — clause never runs');
  assert.equal(G2.p1.life.length, before2, 'no Life was spent');
});

test('a "choose one" event runs exactly one branch', () => {
  const G = game();
  const handBefore = G.p1.hand.length;
  playFromHand(G, 'OP15-055');
  assert.equal(G.pending?.type, 'mode');
  assert.equal(G.pending.options.length, 2);
  choose(G, 0);                                  // draw 2
  assert.equal(G.p1.hand.length, handBefore + 2, 'drew 2 cards');
});

/* ---------------------------------------------------------------------- */
/* regressions reported from play                                          */
/* ---------------------------------------------------------------------- */

test('"play up to 1 [Name] card from your hand" is recognised', async () => {
  const { parseEffects } = await import('../src/engine/cardtext.js');
  // Buggy (OP16-048). The old pattern demanded the literal words "Character
  // card", so this whole clause was dropped and the card just drew.
  const e = parseEffects({
    effect: '[On Play] If your Leader has the {Impel Down} type, draw 1 card and play up to 1 [Prisoner of Impel Down] card from your hand.',
  })[0];
  const play = e.ops.find(o => o.op === 'playFree');
  assert.ok(play, 'the play-from-hand clause is parsed');
  assert.equal(play.fromHandName, 'Prisoner of Impel Down');
  assert.ok(e.ops.some(o => o.op === 'draw'), 'the draw still parses too');

  // The other printed shapes must keep working.
  const typed = parseEffects({ effect: '[On Play] play up to 1 {Straw Hat Crew} type Character card with a cost of 5 or less from your hand.' })[0];
  const t = typed.ops.find(o => o.op === 'playFree');
  assert.equal(t.type, 'Straw Hat Crew');
  assert.equal(t.maxCost, 5);

  const powered = parseEffects({ effect: '[On Play] play up to 1 Character card with 8000 power or less from your hand.' })[0];
  assert.equal(powered.ops.find(o => o.op === 'playFree').maxPower, 8000);
});

test('playFree honours a name filter when offering hand cards', () => {
  const G = game();
  G.cards.TARGET = { ...CARDS.SMALL, id: 'TARGET', name: 'Wanted One' };
  G.p1.hand = ['FILLER', 'TARGET', 'BIG'];
  // Drive the op directly through a one-off scripted source.
  G.queue.push({
    side: 'p1',
    clause: { when: 'onPlay', ops: [{ op: 'playFree', n: 1, fromHandName: 'Wanted One', optional: true }] },
    source: CARDS.FILLER,
    costPaid: true,
  });
  apply(G, { type: 'advance' });   // pumps the queue
  assert.equal(G.pending?.kind, 'playFree');
  assert.deepEqual(G.pending.options.map(o => o.label), ['Wanted One'],
    'only the named card is offered');
});

test('the Leader ability reports why it is unavailable instead of vanishing', async () => {
  const { leaderAbilityStatus } = await import('../src/engine/engine.js');

  // A Leader with no [Activate: Main] text: nothing to show at all.
  const plain = game({ l1: 'PLAIN' });
  assert.equal(leaderAbilityStatus(plain, 'p1').has, false);

  // A Leader that has one: once used, the control must stay present with a reason.
  const G = game({ l1: 'ACTIVE' });
  const before = leaderAbilityStatus(G, 'p1');
  assert.equal(before.has, true, 'the ability is advertised');

  G.p1.once.leader = 1;
  const after = leaderAbilityStatus(G, 'p1');
  assert.equal(after.has, true, 'still advertised after use');
  assert.equal(after.usable, false);
  assert.match(after.reason, /Already used/, 'and says why');

  // Outside the Main Phase it is unusable but still advertised.
  const G2 = game({ l1: 'ACTIVE' });
  G2.phase = 'end';
  const outside = leaderAbilityStatus(G2, 'p1');
  assert.equal(outside.has, true);
  assert.equal(outside.usable, false);
  assert.match(outside.reason, /Main Phase/);
});

/* ---------------------------------------------------------------------- */
/* continuous ("static") buffs                                             */
/* ---------------------------------------------------------------------- */

test('static buffs read their scope, and refuse what they cannot evaluate', async () => {
  const { staticBuffs } = await import('../src/engine/cardtext.js');

  const board = staticBuffs({ id: 'a', effect: '[DON!! x1] [Your Turn] All of your Characters gain +1000 power.' });
  assert.equal(board.length, 1);
  assert.deepEqual(
    { amount: board[0].amount, target: board[0].target, when: board[0].when, don: board[0].don },
    { amount: 1000, target: 'allChars', when: 'yourTurn', don: 1 });

  // Restricted board buffs must carry their restriction, not collapse to "this".
  const typed = staticBuffs({ id: 'b', effect: "[Opponent's Turn] All of your {Navy} or {Punk Hazard} type Characters gain +1000 power." })[0];
  assert.equal(typed.target, 'allChars');
  assert.deepEqual(typed.types, ['Navy', 'Punk Hazard']);

  const named = staticBuffs({ id: 'c', effect: "[Opponent's Turn] All of your [Ace] and [Luffy] cards gain +3000 power." })[0];
  assert.deepEqual(named.names, ['Ace', 'Luffy']);

  const qualified = staticBuffs({ id: 'd', effect: '[Your Turn] All of your green {Straw Hat Crew} type Characters with a base cost of 4 or more gain +1000 power.' })[0];
  assert.equal(qualified.colour, 'green');
  assert.equal(qualified.minBaseCost, 4);

  // Things we cannot evaluate must be skipped rather than guessed at.
  assert.deepEqual(staticBuffs({ id: 'e', effect: '[Your Turn] If you have 5 or more cards in your hand, this Character gains +3000 power.' }), [],
    'conditional buffs are not applied');
  assert.deepEqual(staticBuffs({ id: 'f', effect: 'This Character gains +1000 power for every 5 Events in your trash.' }), [],
    'scaling buffs are not applied as a flat value');

  // Event text must not be mistaken for an always-on buff.
  assert.deepEqual(staticBuffs({ id: 'g', effect: '[On Play] Up to 1 of your Characters gains +2000 power during this turn.' }), [],
    'an [On Play] clause is not a static buff');
});

test('a Leader board buff raises its Characters, gated on turn and DON!!', () => {
  const G = game({ l1: 'BUFFER' });
  const mine = addFriend(G, 'SMALL');            // printed 2000
  assert.equal(charPower(G, 'p1', mine), 2000, 'no DON!! attached, so the gate holds');

  G.p1.leaderDon = 1;
  assert.equal(charPower(G, 'p1', mine), 3000, '[DON!! x1] satisfied -> +1000');

  // The buff is [Your Turn] only.
  const turnOf = G.turn;
  let guard = 0;
  while (G.turn === turnOf && guard++ < 10) apply(G, { type: 'advance' });
  assert.equal(G.active, 'p2');
  assert.equal(charPower(G, 'p1', mine), 2000, 'the buff switches off on the opponent\'s turn');
});

test('a board buff does not leak onto the opponent or the Leader', () => {
  const G = game({ l1: 'BUFFER' });
  G.p1.leaderDon = 1;
  const mine = addFriend(G, 'SMALL');
  const theirs = addEnemy(G, 'SMALL');
  assert.equal(charPower(G, 'p1', mine), 3000, 'my body is buffed');
  assert.equal(charPower(G, 'p2', theirs), 2000, 'theirs is not');
  assert.equal(leaderPower(G, 'p1'), 5000 + 1000, 'the Leader gets its own DON!! but not a Characters-only buff');
});

/* ---------------------------------------------------------------------- */
/* character activated abilities                                           */
/* ---------------------------------------------------------------------- */

test('a Character [Activate: Main] ability can be used, once per turn', async () => {
  const { charAbilityStatus } = await import('../src/engine/engine.js');
  const G = game();
  const ch = addFriend(G, 'ACTOR');

  const before = charAbilityStatus(G, 'p1', ch.uid);
  assert.equal(before.has, true, 'the ability is advertised');
  assert.equal(before.usable, true);

  const handBefore = G.p1.hand.length;
  apply(G, { type: 'activateChar', uid: ch.uid });
  assert.equal(G.p1.hand.length, handBefore + 1, 'the ability resolved');

  const after = charAbilityStatus(G, 'p1', ch.uid);
  assert.equal(after.usable, false);
  assert.match(after.reason, /Already used/);

  // A body with no activated ability advertises nothing.
  const plain = addFriend(G, 'SMALL');
  assert.equal(charAbilityStatus(G, 'p1', plain.uid).has, false);
});

test('an ability costing "rest this Character" needs it active', async () => {
  const { charAbilityStatus } = await import('../src/engine/engine.js');
  const G = game();
  const ch = addFriend(G, 'RESTER', { rested: true });
  const st = charAbilityStatus(G, 'p1', ch.uid);
  assert.equal(st.has, true);
  assert.equal(st.usable, false);
  assert.match(st.reason, /already rested/i);

  ch.rested = false;
  assert.equal(charAbilityStatus(G, 'p1', ch.uid).usable, true);
});

test('[Double Attack] takes two Life cards', () => {
  const G = game();
  const ch = addFriend(G, 'DOUBLE', { bornTurn: 0 });
  const lifeBefore = G.p2.life.length;

  apply(G, { type: 'attack', attacker: ch.uid, target: { kind: 'leader' } });
  let guard = 0;
  while (G.pending && guard++ < 12) {
    if (G.pending.type === 'counter') apply(G, { type: 'counter', index: null });
    else if (G.pending.type === 'block') apply(G, { type: 'block', uid: null });
    else if (G.pending.type === 'trigger') apply(G, { type: 'trigger', activate: false });
    else apply(G, { type: 'choose', value: null });
  }
  assert.equal(G.p2.life.length, lifeBefore - 2, 'two Life cards were taken');
});

/* ---------------------------------------------------------------------- */
/* the scripts must not break the game                                     */
/* ---------------------------------------------------------------------- */

test('scripted cards do not deadlock an AI-vs-AI game', async () => {
  const { decide, SKILL } = await import('../src/engine/ai.js');
  const deck = {
    'OP15-075': 4, 'OP15-076': 4, 'OP14-111': 4, 'OP14-104': 2, 'TBP': 4,
    'OP16-055': 4, 'OP16-032': 2, 'OP08-036': 4, 'OP15-114': 2, 'EB03-055': 2,
    'ST10-010': 4, 'OP06-058': 2, 'OP15-055': 4, 'BIG': 4, 'SMALL': 4,
  };
  for (const seed of [1, 2, 3, 7, 11]) {
    const G = createGame({
      cards: CARDS, seed, firstPlayer: seed % 2 ? 'p1' : 'p2',
      p1: { name: 'A', leaderId: 'ENEL', deck },
      p2: { name: 'B', leaderId: 'SHC', deck },
    });
    let n = 0;
    while (!G.over && n++ < 4000) apply(G, decide(G, SKILL.solid));
    assert.ok(G.over, `seed ${seed} finished`);
    assert.ok(n < 4000, `seed ${seed} did not spin`);
  }
});
