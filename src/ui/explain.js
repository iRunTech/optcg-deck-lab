/* "Explain what just happened."
 *
 * The design's strongest idea: every log entry is clickable and produces a
 * plain-English account of the rule that just fired, with a beginner/advanced
 * register. Kept verbatim in spirit, extended to the events this engine emits.
 */

const R = {
  attack: 'Attacking rests the attacker. An attack succeeds when the attacker\'s power is equal to or greater than the defender\'s — ties go to the attacker.',
  damage: 'Damage to a Leader removes one Life card, which the defender takes into hand. If it has a [Trigger] they may activate it instead.',
  counter: 'During the counter step the defender may play cards from hand for their counter value, or [Counter] Events by paying their DON!! cost.',
  block: 'A [Blocker] may rest itself to become the new target of an attack, redirecting a hit away from the Leader.',
  don: 'Attached DON!! give +1000 power until the end of the turn and switch on [DON!! xN] abilities. They return during your next Refresh Phase.',
  play: 'Playing a card rests DON!! equal to its cost. Characters enter play and cannot attack the turn they arrive unless they have [Rush]. The character area holds at most 5.',
  draw: 'You draw one card in your Draw Phase. If you must draw from an empty deck, you lose.',
  phase: 'A turn runs Refresh → Draw → DON!! → Main → End. The player going first skips their first draw and gains only 1 DON!! on turn 1.',
  ko: 'A K.O.\'d character goes to the trash. Any DON!! attached to it returns to the cost area.',
  trigger: '[Trigger] only works from a Life card taken as damage. Activating it uses the card instead of adding it to your hand.',
  effect: 'Effects resolve in the order they are printed. "Up to" means you may choose zero.',
  end: 'A player loses when they take damage with no Life cards left, or must draw from an empty deck.',
};

export function explain(entry, { beginner = true } = {}) {
  if (!entry) {
    return {
      title: 'Nothing to explain yet',
      body: 'Take an action — play a card, attach DON!!, or attack — then press this button.',
      rule: 'The log records every board change so you can step back through the game.',
    };
  }

  const k = entry.kind;
  const text = entry.text;

  if (k === 'attack') {
    return {
      title: 'Attack declared',
      body: beginner
        ? `${text} The attacker is set to rested as part of declaring, whether or not the attack connects. The defender now gets a window to block with a [Blocker] and then to play counters.`
        : text,
      rule: R.attack,
    };
  }
  if (k === 'battle') {
    return {
      title: 'Battle resolved',
      body: beginner
        ? `${text} Power is compared once, after all counters are played. A character that loses is K.O.'d; a Leader that loses takes one damage.`
        : text,
      rule: R.attack,
    };
  }
  if (k === 'damage') {
    return {
      title: 'Damage dealt',
      body: beginner
        ? `${text} The Life card goes to the defender's hand — so taking damage is also a resource. That is why racing is a real strategy in this game.`
        : text,
      rule: R.damage,
    };
  }
  if (k === 'counter') {
    return {
      title: 'Counter played',
      body: beginner
        ? `${text} Counters are spent from hand during the defender's counter step and raise the defender's power for this battle only.`
        : text,
      rule: R.counter,
    };
  }
  if (k === 'block') return { title: 'Blocked', body: text, rule: R.block };
  if (k === 'don') {
    return {
      title: 'DON!! moved',
      body: beginner
        ? `${text} DON!! are both your currency and your damage: the same card can pay a cost or add +1000 power, never both in one turn.`
        : text,
      rule: R.don,
    };
  }
  if (k === 'play') {
    return {
      title: 'Card played',
      body: beginner
        ? `${text} Paying a cost rests that many active DON!!; they refresh at the start of your next turn.`
        : text,
      rule: R.play,
    };
  }
  if (k === 'ko') return { title: 'Character K.O.\'d', body: text, rule: R.ko };
  if (k === 'trigger') return { title: 'Trigger activated', body: text, rule: R.trigger };
  if (k === 'draw') return { title: 'Card drawn', body: text, rule: R.draw };
  if (k === 'end') return { title: 'Game over', body: text, rule: R.end };
  if (k === 'effect' || k === 'cost') return { title: 'Effect resolved', body: text, rule: R.effect };

  return {
    title: 'Phase changed',
    body: beginner
      ? `${text} Refresh returns attached DON!! and sets your cards active; Draw gives you a card; the DON!! Phase adds 2 to your cost area; Main is where you act.`
      : text,
    rule: R.phase,
  };
}

export const RULES = [
  { n: '1', title: 'Refresh Phase', body: 'Return all attached DON!! to the cost area and set your rested cards active.' },
  { n: '2', title: 'Draw Phase', body: 'Draw 1 card. The player going first skips this on turn 1.' },
  { n: '3', title: 'DON!! Phase', body: 'Add 2 DON!! from your DON!! deck to the cost area (1 on the very first turn).' },
  { n: '4', title: 'Main Phase', body: 'Play cards, use abilities, attach DON!! and declare attacks in any order.' },
  { n: '5', title: 'End Phase', body: 'Effects lasting "during this turn" expire, then the turn passes.' },
];
