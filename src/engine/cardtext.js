/* Printed card text → structured effects.
 *
 * The POC's insight was right and is kept: parse the printed text so that every
 * card is playable, including brews, instead of only a curated scripted pool.
 * What's fixed here is the precision.
 *
 *  - [DON!! xN] reads N off the card instead of assuming 2.
 *  - A cost clause ("You may trash 1 card from your hand:") is separated from
 *    the effect it pays for, so the two no longer both fire unconditionally.
 *  - "your opponent draws" no longer hands YOU the card.
 *  - "up to" / "you may" mark an effect optional rather than mandatory.
 *
 * Anything unrecognised is returned as an `unparsed` clause. The engine turns
 * those into an explicit manual prompt rather than silently dropping them.
 */

/* Bandai prints curly apostrophes, en/em dashes and a real ×. */
const OPP = String.raw`opponent(?:['’]s)?`;
const DASH = String.raw`[-−–—]`;

export const normalize = s => String(s ?? '')
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/’/g, "'")
  .replace(/×/g, 'x')
  .replace(/\r/g, '')
  .trim();

export const cardText = c => normalize(c?.effect);
export const triggerText = c => normalize(c?.trigger);

const num = s => {
  const m = String(s).replace(/,/g, '').match(/-?\d+/);
  return m ? +m[0] : 0;
};

/* ---------------------------------------------------------------------- */
/* keywords                                                                */
/* ---------------------------------------------------------------------- */

/**
 * Keywords a card has. `rush` is only the unconditional printing — a card that
 * merely "gains [Rush]" under a condition reports `rushIf` with the DON!!
 * threshold that switches it on.
 */
export function keywords(c) {
  const t = cardText(c);
  const has = re => re.test(t);

  // "[DON!! x2] This Character gains [Rush]" — capture the actual N.
  let rushIf = null;
  const gainsRush = /gains \[Rush\]/i.test(t);
  if (gainsRush) {
    const line = t.split('\n').find(l => /gains \[Rush\]/i.test(l)) || t;
    const donx = line.match(/\[DON!!\s*x\s*(\d+)\]/i);
    rushIf = donx ? num(donx[1]) : 0;   // 0 = conditional but not DON-gated
  }

  return {
    blocker: has(/\[Blocker\]/i),
    rush: /(^|\n)\s*\[Rush\](?!:)/i.test(t) && !gainsRush,
    rushIf,
    rushChar: has(/\[Rush: Character\]/i),
    doubleAttack: has(/\[Double Attack\]/i),
    banish: has(/\[Banish\]/i),
  };
}

/** The DON!! threshold on a clause, e.g. `[DON!! x2] …` → 2. */
export const donRequirement = line => {
  const m = String(line).match(/\[DON!!\s*x\s*(\d+)\]/i);
  return m ? num(m[1]) : 0;
};

/* ---------------------------------------------------------------------- */
/* clause parsing                                                          */
/* ---------------------------------------------------------------------- */

/* Bandai's grammar puts an activation cost before a colon:
 *     "[On Play] You may trash 1 card from your hand: Draw 2 cards."
 * The part before the colon is a cost the player chooses to pay; the part after
 * is the payoff. The POC matched both halves against the same op table, so it
 * discarded AND drew with no choice offered. */
function splitCost(body) {
  const m = body.match(/^(.*?(?:You may |DON!!\s*[-−]\d+|Don!!\s*[-−]\d+).*?):\s*(.+)$/i);
  if (!m) return { cost: null, effect: body };
  return { cost: parseCost(m[1]), effect: m[2] };
}

/* Field names here must match what the engine's payCost/canPayCost consume —
 * a cost parsed under a name nothing reads is a cost never charged. */
function parseCost(text) {
  const cost = { text: text.trim(), optional: /you may/i.test(text) };
  let m;
  if ((m = text.match(new RegExp(String.raw`DON!!\s*${DASH}\s*(\d+)`, 'i')))) cost.don = num(m[1]);
  if ((m = text.match(/trash (\d+) cards? from your hand/i))) cost.discard = num(m[1]);
  if ((m = text.match(/trash (\d+) cards? from the top of your deck/i))) cost.mill = num(m[1]);
  if ((m = text.match(/rest (\d+) of your DON!! cards?/i))) cost.restDon = num(m[1]);
  if (/rest this/i.test(text)) cost.restSelf = true;
  if (/trash this/i.test(text)) cost.trashSelf = true;
  if ((m = text.match(/turn (\d+) cards? from the top .*?of your Life/i))) cost.lifeFlip = num(m[1]);
  return cost;
}

/** Recognised operations in one clause. Empty means "we didn't understand it". */
function parseOps(line) {
  const ops = [];
  const R = (body, flags = 'i') => new RegExp(body.replace(/OPP/g, OPP).replace(/DASH/g, DASH), flags);
  const optional = /up to|you may/i.test(line);
  let m;

  // --- card flow ---
  // Guard against giving the opponent's draw to the active player.
  if ((m = line.match(R(String.raw`your OPP draws? (\d+) cards?`)))) {
    ops.push({ op: 'draw', n: num(m[1]), side: 'opp' });
  } else if ((m = line.match(/draw (\d+) cards?/i))) {
    ops.push({ op: 'draw', n: num(m[1]), side: 'self' });
  }

  if ((m = line.match(R(String.raw`your OPP trash(?:es)? (\d+) cards? from their hand`)))) {
    ops.push({ op: 'discard', n: num(m[1]), side: 'opp' });
  }

  if ((m = line.match(/look at (\d+) cards? from the top of your deck/i))) {
    const type = line.match(/reveal up to \d+ \{([^}]+)\}/i) || line.match(/reveal up to \d+ ([A-Za-z ]+?) type/i);
    ops.push({ op: 'dig', n: num(m[1]), type: type ? type[1].trim() : null });
  }

  // --- removal ---
  if ((m = line.match(R(String.raw`K\.?O\.? up to (\d+) of your OPP Characters? with (?:a )?cost of (\d+) or less`)))) {
    ops.push({ op: 'ko', n: num(m[1]), maxCost: num(m[2]), optional });
  } else if ((m = line.match(R(String.raw`K\.?O\.? up to (\d+) of your OPP Characters? with (\d[\d,]*) (?:base )?power or less`)))) {
    ops.push({ op: 'ko', n: num(m[1]), maxPower: num(m[2]), optional });
  } else if ((m = line.match(R(String.raw`K\.?O\.? up to (\d+) of your OPP Characters?`)))) {
    ops.push({ op: 'ko', n: num(m[1]), optional });
  }

  if ((m = line.match(R(String.raw`rest up to (\d+) of your OPP Characters?`)))) {
    ops.push({ op: 'rest', n: num(m[1]), side: 'opp', optional });
  }

  if ((m = line.match(R(String.raw`place up to (\d+) of your OPP Characters?.*?(?:bottom|top) of the owner['’]?s deck`)))) {
    ops.push({ op: 'bounce', n: num(m[1]), optional });
  }

  // --- power modification ---
  if ((m = line.match(R(String.raw`give up to (\d+) of your OPP Characters? DASH(\d[\d,]*) power`)))) {
    ops.push({ op: 'power', n: num(m[1]), amount: -num(m[2]), side: 'opp', optional });
  }
  if ((m = line.match(/give up to (\d+) of your Characters? \+(\d[\d,]*) power/i))) {
    ops.push({ op: 'power', n: num(m[1]), amount: num(m[2]), side: 'self', optional });
  }
  if ((m = line.match(/your Leader (?:or|and) (?:all of your )?Characters? gains? \+(\d[\d,]*) power/i))) {
    ops.push({ op: 'power', n: 1, amount: num(m[1]), side: 'self', target: 'leader' });
  }
  if ((m = line.match(/this Character gains \+(\d[\d,]*) power/i))) {
    ops.push({ op: 'power', n: 1, amount: num(m[1]), side: 'self', target: 'this' });
  }

  // --- DON!! economy ---
  /* One clause can add DON!! twice with different states, e.g. Enel:
   *   "add up to 1 DON!! card from your DON!! deck and set it as active,
   *    and add up to 4 additional DON!! cards and rest them"
   * Matching only the first half turned a 5-DON!! ramp into 1, which on a
   * 6-card DON!! deck is the difference between the archetype working and not.
   * So walk every "add up to N …" and read each one's own tail for its state. */
  const donAdds = [...line.matchAll(
    /add up to (\d+) (?:additional )?DON!! cards?(?: from your DON!! deck)?((?:(?!add up to)[^.;])*)/gi
  )];
  for (const a of donAdds) {
    ops.push({ op: 'donAdd', n: num(a[1]), rested: /rest (?:it|them)/i.test(a[2] || '') });
  }

  // Only an explicit "set N of your DON!! cards as active" flips existing DON!!;
  // "set it as active" refers to a card just added and is handled above.
  if ((m = line.match(/set (?:up to )?(\d+) of your DON!! cards? as active/i))) {
    ops.push({ op: 'donActive', n: num(m[1]) });
  }

  if ((m = line.match(/give up to (\d+) rested DON!! cards? to (your Leader|1 of your [^.,;]*)/i))) {
    ops.push({ op: 'donGive', n: num(m[1]), to: /leader/i.test(m[2]) ? 'leader' : 'character' });
  }

  // --- deployment ---
  /* Bandai writes this several ways, and requiring the literal words
   * "Character card" missed a whole class of cards:
   *   "play up to 1 {Straw Hat Crew} type Character card with a cost of 5 or less"
   *   "play up to 1 [Prisoner of Impel Down] card from your hand"
   *   "play up to 1 Character card with 8000 power or less"
   * Match the shape instead, then read the qualifiers out of the clause. */
  if ((m = line.match(/play up to (\d+) (.*?)\bcards?\b/i))) {
    const qualifier = m[2] || '';
    const cost = line.match(/cost of (\d+) or less/i);
    const power = line.match(/(\d[\d,]*) power or less/i);
    const named = qualifier.match(/\[([^\]]+)\]/);       // [Prisoner of Impel Down]
    const typed = qualifier.match(/\{([^}]+)\}/);        // {Straw Hat Crew}
    ops.push({
      op: 'playFree', n: num(m[1]), optional: true,
      maxCost: cost ? num(cost[1]) : null,
      maxPower: power ? num(power[1]) : null,
      fromHandName: named ? named[1] : null,
      type: typed ? typed[1] : null,
      from: /from your (?:hand or trash|trash)/i.test(line) ? 'handOrTrash' : 'hand',
    });
  }

  // --- life ---
  if (/add up to 1 card from the top of your deck to the top of your Life cards/i.test(line)) {
    ops.push({ op: 'lifeAdd', n: 1, optional });
  }

  return ops;
}

/* When a clause fires. */
const TIMINGS = [
  [/^\[On Play\]/i, 'onPlay'],
  [/^\[Main\]/i, 'onPlay'],                 // Events print [Main]
  [/^\[When Attacking\]/i, 'whenAttacking'],
  [/^\[On K\.?O\.?\]/i, 'onKO'],
  [/^\[On Block\]/i, 'onBlock'],
  [/^\[Activate: Main\]/i, 'activate'],
  [/^\[Counter\]/i, 'counter'],
  [/^\[Trigger\]/i, 'trigger'],
  [/^\[End of (?:Your )?Turn\]/i, 'endOfTurn'],
  [/^\[On Your Opponent['’]s Attack\]/i, 'onOppAttack'],
  [/^\[Your Turn\]/i, 'passive'],
  [/^\[Opponent['’]s Turn\]/i, 'passive'],
  [/^\[DON!!\s*x\s*\d+\]/i, 'passive'],
];

/**
 * Split a card into timed clauses.
 * Each clause: { when, text, don, cost, ops, optional, oncePerTurn, unparsed }
 */
export function parseEffects(c) {
  const out = [];
  const raw = cardText(c);
  if (!raw || raw === '-') return out;

  for (const line of raw.split('\n')) {
    const L = line.trim();
    if (!L || L === '-') continue;

    // A clause can carry several leading tags: "[Your Turn] [Once Per Turn] [On Play] …"
    let when = null;
    for (const [re, name] of TIMINGS) {
      if (re.test(L)) { when = name; break; }
    }
    // A tag can also appear mid-line after a condition tag.
    if (!when || when === 'passive') {
      for (const [re, name] of TIMINGS) {
        if (name === 'passive') continue;
        if (new RegExp(re.source.replace(/^\^/, ''), 'i').test(L)) { when = name; break; }
      }
    }
    if (!when) when = 'passive';

    // Strip every leading [Tag] to get at the sentence.
    const body = L.replace(/^(?:\s*\[[^\]]+\]\s*)+/, '').trim() || L;
    const { cost, effect } = splitCost(body);
    const ops = parseOps(effect);

    out.push({
      when,
      text: L,
      body,
      don: donRequirement(L),
      oncePerTurn: /\[Once Per Turn\]/i.test(L),
      cost,
      ops,
      optional: /up to|you may/i.test(effect),
      // A passive line with no ops is flavour//static text, not a missing feature.
      unparsed: ops.length === 0 && when !== 'passive',
    });
  }
  return out;
}

/* ---------------------------------------------------------------------- */
/* card-level helpers                                                      */
/* ---------------------------------------------------------------------- */

/** Counter value usable in the counter step: printed value, or an Event's text. */
export function counterValue(c) {
  if (!c) return 0;
  if (c.counter) return c.counter;
  const t = cardText(c);
  if (!/\[Counter\]/i.test(t)) return 0;
  const m = t.match(/\+(\d[\d,]*) power during this battle/i);
  return m ? num(m[1]) : 0;
}

/** Leaders may shrink the DON!! deck (Enel runs 6 instead of 10). */
export function donDeckSize(leader) {
  const m = cardText(leader).match(/DON!!\s*deck consists of (\d+)/i);
  return m ? num(m[1]) : 10;
}

/** Life total is printed in the Leader's `cost` field in the punk-records dump. */
export const lifeTotal = leader => (leader && leader.cost) || 5;

/** Cards that explicitly opt out of the 4-copy rule. */
export const copyLimit = c => /any number of .*in your deck/i.test(cardText(c)) ? 99 : 4;

/* ---------------------------------------------------------------------- */
/* continuous ("static") power buffs                                       */
/* ---------------------------------------------------------------------- */

/**
 * Always-on power modifiers printed on a card, e.g.
 *   "[DON!! x1] [Your Turn] All of your Characters gain +1000 power."
 *   "[Opponent's Turn] This Character gains +2000 power."
 *
 * These are not events — they apply whenever their condition holds, so the
 * engine reads them on every power calculation rather than pushing a mod.
 * Ignoring them meant a Leader's whole board was quietly under-powered.
 *
 * @returns {{amount:number, target:'this'|'allChars'|'leaderAndChars', when:'always'|'yourTurn'|'oppTurn', don:number}[]}
 */
const staticCache = new Map();

export function staticBuffs(c) {
  if (!c) return [];
  const key = c.id || c.name;
  if (key && staticCache.has(key)) return staticCache.get(key);

  const out = [];
  for (const raw of cardText(c).split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    // Only lines that are purely conditional tags + a "gains +N power" clause.
    // Anything with an event tag is handled by parseEffects instead.
    if (/\[(On Play|On K\.?O\.?|When Attacking|Activate|Counter|Trigger|On Block|On Your Opponent)/i.test(line)) continue;

    const m = line.match(/gains? \+(\d[\d,]*) power/i);
    if (!m) continue;
    const amount = num(m[1]);
    if (!amount) continue;

    const bare = line.replace(/\[[^\]]*\]/g, ' ');

    /* Skip anything whose magnitude or condition we cannot evaluate. Applying
     * a buff we half-understand overstates power, which is worse than missing
     * it — an understated board is at least conservative. */
    if (/\bif\b/i.test(bare)) continue;              // "if you have 5 or more…"
    if (/for every|for each/i.test(bare)) continue;  // scales with a count

    const when = /\[Your Turn\]/i.test(line) ? 'yourTurn'
      : /\[Opponent['’]s Turn\]/i.test(line) ? 'oppTurn'
        : 'always';

    /* Who receives it. A board-wide clause ("All of your …") is frequently
     * restricted by card name, type, colour or cost — reading those out is the
     * difference between buffing the right bodies and buffing the source. */
    /* Capture everything between "All of your" and "gain +N", which is the
     * full scope description — the noun can be followed by qualifiers
     * ("…Characters with a base cost of 4 or more gain +1000 power"). */
    const board = line.match(/all of your\s+(.*?)\s+gains?\s+\+\d/i);
    let entry;
    if (board && /\b(cards?|characters?)\b/i.test(board[1])) {
      const scopeText = board[1];
      const names = [...scopeText.matchAll(/\[([^\]]+)\]/g)].map(x => x[1]);
      const types = [...scopeText.matchAll(/\{([^}]+)\}/g)].map(x => x[1]);
      const minCost = scopeText.match(/base cost of (\d+) or more/i);
      const colour = scopeText.match(/\b(red|green|blue|purple|black|yellow)\b/i);
      entry = {
        amount, when, don: donRequirement(line), target: 'allChars',
        names: names.length ? names : null,
        types: types.length ? types : null,
        colour: colour ? colour[1].toLowerCase() : null,
        minBaseCost: minCost ? num(minCost[1]) : null,
      };
    } else if (/your Leader (?:or|and) (?:all of your )?Characters?/i.test(line)) {
      entry = { amount, when, don: donRequirement(line), target: 'leaderAndChars' };
    } else if (/this (?:Character|Leader)/i.test(line)) {
      entry = { amount, when, don: donRequirement(line), target: 'this' };
    } else {
      continue;    // an addressing form we do not recognise — leave it alone
    }

    out.push(entry);
  }

  if (key) staticCache.set(key, out);
  return out;
}
