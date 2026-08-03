/* Scripted cards.
 *
 * The text parser in cardtext.js handles the common printed patterns and keeps
 * every card in the game playable, including brews. But competitive cards use
 * wording it can't reach — nested conditionals, "choose one", trash recursion,
 * base-power replacement — and in a batch simulation those silently degrade to
 * vanilla bodies. That biases matchup results toward decks with big stat lines.
 *
 * So the cards that actually get played are written out here by hand, keyed by
 * card id, and the engine prefers a script over the parser whenever one exists.
 * Card play is heavily skewed: ~20 cards cover the great majority of real deck
 * slots across published tournament lists, so this file is small by design and
 * grows only as the meta rotates. `npm run coverage` ranks what to add next.
 *
 * ---------------------------------------------------------------------------
 * Shape of an entry — everything is declarative so it reuses the engine's
 * existing targeting, prompting and AI-decision machinery:
 *
 *   'CARD-ID': {
 *     note: 'the printed text, for review',
 *     onPlay | onKO | whenAttacking | activate | counter | trigger: {
 *       cost:    { don, discard, restDon, lifeTrash, trashSelf, restSelf, optional },
 *       require: { leaderName, leaderType, oppHandAtLeast, donGiven, ... },
 *       ops:     [ … ],
 *     },
 *   }
 *
 * `scope` on an op controls expiry: 'turn' (during this turn) or 'oppNextEnd'
 * (until the end of your opponent's next End Phase).
 * Repeat an op to affect several targets — each one prompts separately.
 * --------------------------------------------------------------------------- */

export const SCRIPTS = {

  /* ---------------------------------------------------------------- Enel */

  'OP15-075': {
    note: '[Main] DON!! -1: If your Leader is [Enel], up to 1 of your Leader or Character cards gains +1000 power. Then, K.O. up to 1 of your opponent\'s Characters with 3000 power or less.',
    onPlay: {
      cost: { don: 1 },
      require: { leaderName: 'Enel' },
      ops: [
        { op: 'power', n: 1, amount: 1000, side: 'self', scope: 'turn' },
        { op: 'ko', n: 1, maxPower: 3000, optional: true },
      ],
    },
    counter: { ops: [{ op: 'power', n: 1, amount: 2000, side: 'self', scope: 'turn' }] },
  },

  'OP15-076': {
    note: '[Main] DON!! -1: If your Leader is [Enel], draw 1 card. Then, give up to 1 of your opponent\'s Characters -1000 power.',
    onPlay: {
      cost: { don: 1 },
      require: { leaderName: 'Enel' },
      ops: [
        { op: 'draw', n: 1, side: 'self' },
        { op: 'power', n: 1, amount: -1000, side: 'opp', scope: 'turn' },
      ],
    },
    counter: { ops: [{ op: 'power', n: 1, amount: 2000, side: 'self', scope: 'turn' }] },
  },

  'OP15-074': {
    note: '[Main] DON!! -1: If your Leader is [Enel], draw 1 card. Then, up to 1 of your Characters gains +2 cost until the end of your opponent\'s next End Phase.',
    onPlay: {
      cost: { don: 1 },
      require: { leaderName: 'Enel' },
      ops: [
        { op: 'draw', n: 1, side: 'self' },
        { op: 'costMod', amount: 2, side: 'self', scope: 'oppNextEnd' },
      ],
    },
    counter: { ops: [{ op: 'power', n: 1, amount: 2000, side: 'self', scope: 'turn' }] },
  },

  'OP15-077': {
    note: '[Main] DON!! -1: Draw 1 card. Then, up to 1 of your opponent\'s rested Characters with 6000 power or less cannot become active.',
    onPlay: {
      cost: { don: 1 },
      ops: [
        { op: 'draw', n: 1, side: 'self' },
        { op: 'flag', kind: 'wontRefresh', side: 'opp', restedOnly: true, scope: 'oppNextEnd', optional: true },
      ],
    },
    counter: { ops: [{ op: 'power', n: 1, amount: 2000, side: 'self', scope: 'turn' }] },
  },

  'OP15-078': {
    note: "[Main] DON!! -2: Draw 1 card. Then, rest up to 1 of your opponent's Characters with 5000 power or less.<br>[Counter] Up to 1 of your Leader or Character cards gains +1000 power during this battle. Then, if you have 6 or less DON!! cards on your field, draw 1 card.",
    onPlay: {
      cost: { don: 2 },
      ops: [
        { op: 'draw', n: 1, side: 'self' },
        { op: 'rest', n: 1, side: 'opp', optional: true },
      ],
    },
    // Note the +1000 — unlike the other three Enel events, which are +2000.
    counter: {
      ops: [
        { op: 'power', n: 1, amount: 1000, side: 'self', scope: 'turn' },
        { op: 'draw', n: 1, side: 'self', require: { maxDonTotal: 6 } },
      ],
    },
  },

  'OP13-076': {
    note: '[Main] You may rest 5 DON!!: give up to 1 of your opponent\'s Characters -8000 power.',
    onPlay: {
      cost: { restDon: 5, optional: true },
      ops: [{ op: 'power', n: 1, amount: -8000, side: 'opp', scope: 'turn' }],
    },
    counter: {
      cost: { discard: 1, optional: true },
      ops: [{ op: 'power', n: 1, amount: 3000, side: 'self', scope: 'turn' }],
    },
  },

  'OP15-114': {
    note: 'Wyper — [On Play] turn a Life card face-up: all opponent Characters -2000, then K.O. all at 0 or less.',
    onPlay: {
      cost: { optional: true },
      ops: [
        { op: 'powerAll', amount: -2000, side: 'opp', scope: 'turn' },
        { op: 'koPowerAtMost', n: 0 },
      ],
    },
    activate: { ops: [{ op: 'donGive', n: 1, to: 'character' }] },
  },

  /* ------------------------------------------------------- Thriller Bark */

  'OP14-104': {
    note: 'Gecko Moria — [On Play] select up to 1 {Thriller Bark Pirates} Character cost 4 or less from your trash and play it OR add it to the top of your Life cards face-up.',
    onPlay: {
      ops: [{
        op: 'chooseOne',
        modes: [
          { label: 'Play it', ops: [{ op: 'playFromTrash', maxCost: 4, type: 'Thriller Bark Pirates', optional: true }] },
          { label: 'Add it to the top of your Life', ops: [{ op: 'lifeFromTrash', maxCost: 4, type: 'Thriller Bark Pirates', optional: true }] },
        ],
      }],
    },
    trigger: { ops: [{ op: 'playFromTrash', maxCost: 4, optional: true }] },
  },

  'OP14-111': {
    note: 'Perona — [On Play]/[On K.O.] up to 1 opposing Character cost 6 or less cannot attack until the end of your opponent\'s next End Phase.',
    onPlay: { ops: [{ op: 'flag', kind: 'cannotAttack', side: 'opp', maxCost: 6, scope: 'oppNextEnd', optional: true }] },
    onKO: { ops: [{ op: 'flag', kind: 'cannotAttack', side: 'opp', maxCost: 6, scope: 'oppNextEnd', optional: true }] },
    trigger: { ops: [{ op: 'playFromTrash', maxCost: 4, type: 'Thriller Bark Pirates', rested: true, optional: true }] },
  },

  /* --------------------------------------------------------- Straw Hat */

  'EB03-055': {
    note: 'Nico Robin — [On Play] trash 1 Life card: if Leader is {Straw Hat Crew}, add 2 from deck to Life. [On K.O.] deal 1 damage.',
    onPlay: {
      cost: { lifeTrash: 1, optional: true },
      require: { leaderType: 'Straw Hat Crew' },
      ops: [{ op: 'lifeAdd', n: 1 }, { op: 'lifeAdd', n: 1 }],
    },
    onKO: { cost: { optional: true }, ops: [{ op: 'damage', n: 1 }] },
  },

  'OP15-032': {
    note: 'Brook — [On Play] rest up to 1 opposing card. [Activate: Main] trash this: set a Character with base cost 8 or less active.',
    onPlay: { ops: [{ op: 'rest', n: 1, side: 'opp', optional: true }] },
    activate: {
      cost: { trashSelf: true, optional: true },
      require: { leaderType: 'Straw Hat Crew' },
      ops: [{ op: 'setActive', maxBaseCost: 8 }],
    },
  },

  'OP02-068': {
    note: 'Gum-Gum Rain — [Counter] trash 1 card: +3000 power. [Trigger] return a Character cost 2 or less to hand.',
    counter: {
      cost: { discard: 1, optional: true },
      ops: [{ op: 'power', n: 1, amount: 3000, side: 'self', scope: 'turn' }],
    },
    trigger: { ops: [{ op: 'returnToHand', maxCost: 2, optional: true }] },
  },

  'OP06-106': {
    note: 'Kouzuki Hiyori — [On Play] add 1 Life card to hand: put 1 card from hand on top of Life.',
    onPlay: {
      cost: { optional: true },
      ops: [{ op: 'lifeFromHand', optional: true }],
    },
  },

  /* ------------------------------------------------------- Impel Down */

  'OP16-022': {
    note: 'Monkey.D.Luffy (Leader) — [Activate: Main] [Once Per Turn] if the only Characters on your field are {Impel Down} type, set up to 2 of your DON!! cards as active.',
    unmetReason: 'Needs at least 1 rested DON!! and only {Impel Down} Characters on your field.',
    activate: {
      require: { allCharsOfType: 'Impel Down', minRestedDon: 1 },
      ops: [{ op: 'donActive', n: 2 }],
    },
  },

  'OP15-058': {
    note: 'Enel (Leader) — [Activate: Main] [Once Per Turn] from your second turn: add 1 DON!! active and 4 rested from your DON!! deck, then give up to 4 rested DON!! to 1 of your Characters.',
    unmetReason: 'Your DON!! deck is empty.',
    activate: {
      require: { donDeckAtLeast: 1 },
      ops: [
        { op: 'donAdd', n: 1, rested: false },
        { op: 'donAdd', n: 4, rested: true },
        { op: 'donGive', n: 4, to: 'character' },
      ],
    },
  },

  'OP16-055': {
    note: 'Mr.2 Bon Kurei — [On Play] draw 1. [DON!! x1][When Attacking] base power becomes the opponent Leader\'s power.',
    onPlay: { ops: [{ op: 'draw', n: 1, side: 'self' }] },
    whenAttacking: { don: 1, ops: [{ op: 'basePower', mode: 'oppLeader', scope: 'turn' }] },
  },

  'OP16-032': {
    note: 'Boa Hancock — [Unblockable]. [On Play] up to 1 opposing Character other than [Monkey.D.Luffy] cannot be rested.',
    onPlay: { ops: [{ op: 'flag', kind: 'cannotRest', side: 'opp', notNamed: 'Monkey.D.Luffy', scope: 'oppNextEnd', optional: true }] },
  },

  'OP16-038': {
    note: "Let's Go!! To the Navy Headquarters!! — [Main] rest 6 DON!!: set your Leader and all Characters active. [Counter] Leader +3000.",
    onPlay: {
      cost: { restDon: 6, optional: true },
      ops: [{ op: 'setAllActive' }],
    },
    counter: { ops: [{ op: 'power', n: 1, amount: 3000, side: 'self', target: 'leader', scope: 'turn' }] },
  },

  /* ------------------------------------------------------- Blackbeard */

  'OP16-104': {
    note: 'Catarina Devon — [When Attacking] base power becomes a selected opposing Character\'s power.',
    whenAttacking: { ops: [{ op: 'basePower', mode: 'selectedChar', scope: 'turn' }] },
    trigger: {
      ops: [
        { op: 'draw', n: 1, side: 'self' },
        { op: 'playFromTrash', cost: 1, type: 'Blackbeard Pirates', optional: true },
      ],
    },
  },

  'OP16-108': {
    note: 'Shiryu — [On Play] trash 1 card: add a {Blackbeard Pirates} card cost 6 or less from trash to top of Life.',
    onPlay: {
      cost: { discard: 1, optional: true },
      ops: [{ op: 'lifeFromTrash', maxCost: 6, type: 'Blackbeard Pirates', optional: true }],
    },
    trigger: { ops: [{ op: 'draw', n: 2, side: 'self' }] },
  },

  'OP16-116': {
    note: 'Zehahahahaha! — [Main] with 10 DON!!, play [Marshall.D.Teach] from hand, then opponent\'s top Life to their hand.',
    onPlay: {
      require: { minDonTotal: 10 },
      ops: [
        { op: 'playFree', n: 1, fromHandName: 'Marshall.D.Teach', optional: true },
        { op: 'lifeToHandOpp', n: 1 },
      ],
    },
    trigger: { ops: [{ op: 'draw', n: 2, side: 'self' }, { op: 'discard', n: 1, side: 'self' }] },
  },

  'ST10-010': {
    note: 'Trafalgar Law — [Blocker]. [On Play] DON!! -1: if opponent has 7+ cards in hand, they trash 2.',
    onPlay: {
      cost: { don: 1, optional: true },
      ops: [{ op: 'oppDiscard', n: 2, ifHandAtLeast: 7 }],
    },
  },

  /* ----------------------------------------------------------- removal */

  'OP06-058': {
    note: 'Gravity Blade Raging Tiger — [Main] place up to 2 Characters cost 6 or less on the bottom of their owner\'s deck.',
    onPlay: {
      ops: [
        { op: 'bottomDeck', maxCost: 6, optional: true },
        { op: 'bottomDeck', maxCost: 6, optional: true },
      ],
    },
    trigger: { ops: [{ op: 'bottomDeck', maxCost: 5, optional: true }] },
  },

  'OP08-036': {
    note: 'Electrical Luna — [Main] all opposing rested Characters cost 7 or less will not become active.',
    onPlay: { ops: [{ op: 'flag', kind: 'wontRefresh', side: 'opp', maxCost: 7, restedOnly: true, all: true, scope: 'oppNextEnd' }] },
    trigger: { ops: [{ op: 'rest', n: 1, side: 'opp', optional: true }] },
  },

  'OP13-040': {
    note: "I Know You're Strong… — [Main] rest 2 DON!!: up to 2 opposing rested Characters cost 7 or less will not become active.",
    onPlay: {
      cost: { restDon: 2, optional: true },
      ops: [
        { op: 'flag', kind: 'wontRefresh', side: 'opp', maxCost: 7, restedOnly: true, scope: 'oppNextEnd', optional: true },
        { op: 'flag', kind: 'wontRefresh', side: 'opp', maxCost: 7, restedOnly: true, scope: 'oppNextEnd', optional: true },
      ],
    },
    counter: { ops: [{ op: 'power', n: 1, amount: 3000, side: 'self', target: 'leader', scope: 'turn' }] },
  },

  'OP12-037': {
    note: 'Asura — [Main] rest 3 DON!!: rest up to 2 of your opponent\'s Characters or DON!! cards.',
    onPlay: {
      cost: { restDon: 3, optional: true },
      ops: [
        { op: 'rest', n: 1, side: 'opp', optional: true },
        { op: 'restDonOpp', n: 1 },
      ],
    },
    counter: { ops: [{ op: 'power', n: 1, amount: 3000, side: 'self', target: 'leader', scope: 'turn' }] },
  },

  /* -------------------------------------------------------------- Law */

  'OP12-115': {
    note: 'I Love You!! — [Counter] +2000 power. Then, with 2 or less Life, add a [Trafalgar Law] from trash to hand.',
    counter: {
      ops: [
        { op: 'power', n: 1, amount: 2000, side: 'self', scope: 'turn' },
        { op: 'searchTrashToHand', name: 'Trafalgar Law', requireLifeAtMost: 2, optional: true },
      ],
    },
  },

  /* ------------------------------------------------------------ Lucy */

  'OP15-054': {
    note: "And No One Else Can Have It! — [Main] if Leader is [Lucy], choose one.",
    onPlay: {
      require: { leaderName: 'Lucy' },
      ops: [{
        op: 'chooseOne',
        modes: [
          {
            label: 'Draw 2, trash 1, then play a {Dressrosa} Character cost 4 or less from hand',
            ops: [
              { op: 'draw', n: 2, side: 'self' },
              { op: 'discard', n: 1, side: 'self' },
              { op: 'playFree', n: 1, maxCost: 4, optional: true },
            ],
          },
          { label: "Return up to 1 Stage to the owner's hand", ops: [{ op: 'returnStage' }] },
        ],
      }],
    },
  },

  'OP15-055': {
    note: "Go Ahead and Use 'Em, Mr. Luffy!!! — [Main] choose one.",
    onPlay: {
      ops: [{
        op: 'chooseOne',
        modes: [
          { label: 'Draw 2 cards', ops: [{ op: 'draw', n: 2, side: 'self' }] },
          {
            label: 'A {Dressrosa} Character gains [Blocker]',
            ops: [{ op: 'gainKeyword', kind: 'blocker', type: 'Dressrosa', scope: 'oppNextEnd' }],
          },
        ],
      }],
    },
  },

  /* --------------------------------------------------------- support */

  'ST30-014': {
    note: 'Mr.3(Galdino) — [Activate: Main] rest this: give up to 2 of your Characters with 6000 base power up to 2 rested DON!! each.',
    activate: {
      cost: { restSelf: true },
      ops: [{ op: 'donGive', n: 2, to: 'character' }],
    },
  },

  'OP09-093': {
    note: 'Marshall.D.Teach — [Blocker]. [Activate: Main] negate an opposing Leader and Character effect; that Character cannot attack.',
    // Effect negation is not modelled; the attack lock is the part that changes
    // the board state, so that is what is applied.
    activate: {
      require: { leaderType: 'Blackbeard Pirates' },
      ops: [{ op: 'flag', kind: 'cannotAttack', side: 'opp', scope: 'oppNextEnd', optional: true }],
    },
  },

  /* ------------------------------------------------------ Black Yamato */

  'OP16-096': {
    note: 'Yamato (8) — [Unblockable]. [On K.O.] play up to 1 [Yamato] with a cost of 6 or less from your trash.',
    onKO: { ops: [{ op: 'playFromTrash', maxCost: 6, name: 'Yamato', optional: true }] },
  },

  'OP16-098': {
    note: 'Yamato (6) — [On Play] draw 1, trash 1. [Activate: Main] trash this: play a black [Yamato] cost 8 from your trash.',
    onPlay: {
      ops: [
        { op: 'draw', n: 1, side: 'self' },
        { op: 'discard', n: 1, side: 'self' },
      ],
    },
    activate: {
      cost: { trashSelf: true, optional: true },
      ops: [{ op: 'playFromTrash', cost: 8, name: 'Yamato', optional: true }],
    },
  },

  'OP16-095': {
    note: 'Monkey.D.Luffy (2) — [On Play] a black {Land of Wano} Character gains [Unblockable] this turn.',
    onPlay: { ops: [{ op: 'gainKeyword', kind: 'unblockable', type: 'Land of Wano', scope: 'turn' }] },
  },

  'OP16-084': {
    note: 'Kouzuki Momonosuke — [Activate: Main] trash this: with 9+ DON!!, play [Kouzuki Momonosuke] cost 9 from your trash.',
    activate: {
      cost: { trashSelf: true, optional: true },
      require: { minDonTotal: 9 },
      ops: [{ op: 'playFromTrash', cost: 9, name: 'Kouzuki Momonosuke', optional: true }],
    },
  },

  'OP16-099': {
    note: "I've Come Here… To Cut Those Chains!!! — [Main] rest 6 DON!!: mill 5, then play a {Land of Wano} Character cost 6 or less from your trash.",
    onPlay: {
      cost: { restDon: 6, mill: 5, optional: true },
      ops: [{ op: 'playFromTrash', maxCost: 6, type: 'Land of Wano', optional: true }],
    },
    counter: { ops: [{ op: 'power', n: 1, amount: 3000, side: 'self', target: 'leader', scope: 'turn' }] },
  },

  /* ------------------------------------------------------------- misc */

  'OP15-014': {
    note: 'Bartolomeo — [On Play] activate a {Dressrosa} Event with base cost 3 or less from your hand.',
    onPlay: { ops: [{ op: 'playFree', n: 1, category: 'Event', maxCost: 3, optional: true }] },
  },

  'OP08-047': {
    note: "Jozu — [On Play] return 1 of your own Characters to hand: return up to 1 Character cost 6 or less to the owner's hand.",
    onPlay: {
      cost: { optional: true },
      ops: [{ op: 'returnToHand', maxCost: 6, optional: true }],
    },
  },

  'OP14-096': {
    note: 'Ground Death — [Main] rest 2 DON!!: negate an opposing Character cost 5 or less this turn.',
    // Effect negation isn't modelled; locking the body down is the closest
    // faithful board-state consequence.
    onPlay: {
      cost: { restDon: 2, optional: true },
      ops: [{ op: 'flag', kind: 'cannotAttack', side: 'opp', maxCost: 5, scope: 'turn', optional: true }],
    },
    counter: {
      require: { trashAtLeast: 10 },
      ops: [{ op: 'power', n: 1, amount: 4000, side: 'self', scope: 'turn' }],
    },
  },

  'OP15-057': {
    note: 'Dressrosa Kingdom — [On Play] if your Leader has {Dressrosa}, draw 1.',
    onPlay: {
      require: { leaderType: 'Dressrosa' },
      ops: [{ op: 'draw', n: 1, side: 'self' }],
    },
  },

  'OP15-046': {
    note: 'Sabo — [Blocker]. [On Play] if Leader has {Dressrosa}, activate a {Dressrosa} Event from hand.',
    // Playing an Event out of hand for free is the closest faithful model.
    onPlay: {
      require: { leaderType: 'Dressrosa' },
      ops: [{ op: 'playFree', n: 1, category: 'Event', optional: true }],
    },
  },
};

/** Is there a script for this card at this timing? */
export function scriptFor(cardId, when) {
  const entry = SCRIPTS[cardId];
  if (!entry || !entry[when]) return null;
  // Entry-level metadata (the human-readable "why not" text) is inherited by
  // each timing so callers only ever deal with one object.
  return entry.unmetReason && !entry[when].unmetReason
    ? { ...entry[when], unmetReason: entry.unmetReason }
    : entry[when];
}

export const scriptedIds = () => Object.keys(SCRIPTS);

/** Timings a scripted card defines, used by the coverage report. */
export function scriptedTimings(cardId) {
  const entry = SCRIPTS[cardId];
  if (!entry) return [];
  return Object.keys(entry).filter(k => k !== 'note' && k !== 'unmetReason');
}
