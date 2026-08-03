/* Playtest board — the design's mat, driven by the headless engine.
 *
 * The mockup's board was a goldfish dummy with hardcoded state. This is a real
 * two-sided game: the same engine the batch simulator runs. Where the design
 * showed a static value, it now reads from the engine; where it showed a
 * placeholder interaction, it now submits an engine action.
 */

import { h, fill, toast, fmt, announce } from './dom.js';
import { cardTile, cardSummary, cardVars } from './card.js';
import { getCards } from '../data/cards.js';
import { isLegal, totalCards } from '../data/deck.js';
import { archetypes, archetypeDeck } from '../data/meta.js';
import {
  createGame, apply, legalActions, view, canAttack, attackTargets,
  canUseLeaderAbility, leaderAbilityStatus, charAbilityStatus, costOf, PHASES, PHASE_LABEL, unitName,
} from '../engine/engine.js';
import { decide, SKILL } from '../engine/ai.js';
import { keywords } from '../engine/cardtext.js';
import { explain, RULES } from './explain.js';

const HUMAN = 'p1';
const AI = 'p2';

export function createBoard(app) {
  let G = null;
  let selected = null;          // { kind:'hand'|'char'|'leader', index?, uid? }
  let attacker = null;          // ref of the unit we're attacking with
  let beginner = true;
  let helpOpen = false;
  let explainIdx = -1;
  let explainOpen = false;
  let skill = SKILL.solid;
  let pendingAiTimer = null;

  const els = {};

  /* ------------------------------------------------------------------ */
  /* game control                                                        */
  /* ------------------------------------------------------------------ */

  function startGame({ opponentKey, first, seed } = {}) {
    if (!isLegal(app.deck)) {
      toast('Your deck must be legal (a Leader and exactly 50 cards) to playtest.', 'bad');
      app.go('builder');
      return;
    }
    const field = archetypes();
    const opp = field.find(a => String(a.id) === String(opponentKey)) || field[0];
    if (!opp) {
      toast('No meta decks available — generate data/meta.json first.', 'bad');
      return;
    }
    const oppDeck = archetypeDeck(opp, 'consensus');

    // Stub any id the card dump lacks so a missing printing can't abort a game.
    const cards = getCards();
    const missing = [];
    for (const id of [oppDeck.leader, ...Object.keys(oppDeck.cards), app.deck.leader, ...Object.keys(app.deck.cards)]) {
      if (cards[id]) continue;
      missing.push(id);
      cards[id] = {
        id, name: `${id} (unknown)`, category: 'Character', colors: ['Black'],
        cost: 4, power: 5000, counter: 1000, effect: '-', trigger: null, types: [],
      };
    }
    if (missing.length) toast(`${missing.length} card(s) missing from the card data — standing in as vanilla bodies.`, 'bad');

    G = createGame({
      cards,
      seed: seed ?? (Date.now() % 100000),
      firstPlayer: first || 'p1',
      p1: { name: app.deck.name || 'Your deck', leaderId: app.deck.leader, deck: { ...app.deck.cards } },
      p2: { name: opp.name, leaderId: oppDeck.leader, deck: oppDeck.cards },
    });
    selected = null; attacker = null; explainIdx = -1; explainOpen = false;
    render();
    pumpAI();
  }

  /** Submit a human action, then let the AI take its turn. */
  function act(action) {
    if (!G || G.over) return;
    apply(G, action);
    selected = null;
    render();
    pumpAI();
  }

  /* The AI runs on a short timer so its moves are legible rather than
   * appearing all at once — the state is already computed, this is pacing. */
  function pumpAI() {
    clearTimeout(pendingAiTimer);
    if (!G || G.over) { render(); return; }
    const needsAI = G.pending ? G.pending.side === AI : G.active === AI;
    if (!needsAI) { render(); return; }

    pendingAiTimer = setTimeout(() => {
      const a = decide(G, skill);
      if (!a) { render(); return; }
      apply(G, a);
      render();
      pumpAI();
    }, 420);
  }

  /* ------------------------------------------------------------------ */
  /* setup screen                                                        */
  /* ------------------------------------------------------------------ */

  function renderSetup() {
    const field = archetypes();
    const legal = isLegal(app.deck);

    return h('div.pane', { style: { display: 'flex', justifyContent: 'center' } },
      h('div', { style: { width: '100%', maxWidth: '740px' } },
        h('div.panel', { style: { padding: '20px' } },
          h('h2', { style: { margin: '0 0 4px', font: '600 17px/1 var(--font)' } }, 'New playtest'),
          h('div', { style: { font: '400 12px/1.6 var(--font)', color: 'var(--tx-4)', marginBottom: '18px' } },
            'A real two-sided game against a meta deck, using the same engine as the matchup simulator.'),

          !legal ? h('div.banner', { style: { marginBottom: '16px' } },
            h('div.live'),
            h('div', `Your deck isn't legal yet — ${totalCards(app.deck)}/50 with ${app.deck.leader ? 'a Leader' : 'no Leader'}.`),
            h('button.btn', { style: { marginLeft: 'auto' }, onclick: () => app.go('builder') }, 'Open builder'),
          ) : null,

          h('div.eyebrow', { style: { marginBottom: '9px' } }, 'Opponent'),
          !field.length
            ? h('div.empty-note', 'No meta snapshot loaded. Run `npm run meta` to generate data/meta.json.')
            : h('div', {
              style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(220px,1fr))', gap: '9px', marginBottom: '18px' },
            },
              field.map(a => {
                const on = els.oppKey === String(a.id);
                return h('button.btn', {
                  style: {
                    textAlign: 'left', padding: '11px 13px', lineHeight: '1.4',
                    borderColor: on ? 'var(--accent)' : undefined,
                    background: on ? 'rgba(91,157,255,.12)' : undefined,
                  },
                  onclick: () => { els.oppKey = String(a.id); refreshSetup(); },
                },
                  h('div', { style: { font: '600 13px/1.3 var(--font)', color: 'var(--tx)' } }, a.name),
                  h('div', { style: { font: '500 10px/1.4 var(--mono)', color: 'var(--tx-4)' } },
                    `${(a.share * 100).toFixed(1)}% of field · ${a.deckCount} lists`),
                );
              })),

          h('div.row', { style: { gap: '14px', flexWrap: 'wrap' } },
            labelled('Difficulty', h('select.input', {
              style: { width: 'auto' },
              onchange: e => { skill = +e.target.value; },
            },
              h('option', { value: SKILL.casual }, 'Casual'),
              h('option', { value: SKILL.solid, selected: true }, 'Solid'),
              h('option', { value: SKILL.sharp }, 'Sharp'),
            )),
            labelled('You go', h('select.input', {
              style: { width: 'auto' },
              onchange: e => { els.first = e.target.value; },
            },
              h('option', { value: 'p1', selected: true }, 'first'),
              h('option', { value: 'p2' }, 'second'),
            )),
            h('div.spacer'),
            h('button.btn-pri', {
              style: { padding: '11px 20px' },
              disabled: !legal || !field.length,
              onclick: () => startGame({ opponentKey: els.oppKey ?? String(field[0]?.id), first: els.first || 'p1' }),
            }, 'Start game'),
          ),
        ),
      ),
    );
  }

  function labelled(label, control) {
    return h('label', { style: { display: 'flex', alignItems: 'center', gap: '7px', font: '500 11px/1 var(--font)', color: 'var(--tx-4)' } }, label, control);
  }

  function refreshSetup() {
    if (G) return;
    const next = renderSetup();
    els.body.replaceWith(next);
    els.body = next;
  }

  /* ------------------------------------------------------------------ */
  /* left rail                                                           */
  /* ------------------------------------------------------------------ */

  function renderRailLeft() {
    const me = view(G, HUMAN);
    const phaseIdx = PHASES.indexOf(G.phase);
    const yourTurn = G.active === HUMAN;

    const phases = PHASES.map((p, i) => h('div.phase', {
      class: i === phaseIdx && yourTurn ? 'is-on' : (i < phaseIdx ? 'is-done' : ''),
    },
      h('div.dot'), h('div.nm', PHASE_LABEL[p]), h('div.n', String(i + 1)),
    ));

    const counters = [
      ['DON!! active', `${me.donActive}/${me.donActive + me.donRested}`, 'var(--don)'],
      ['DON!! deck', String(me.donDeck), 'var(--don)'],
      ['Hand', String(me.handCount), 'var(--accent)'],
      ['Deck', String(me.deck), 'var(--ok)'],
      ['Trash', String(me.trash), 'var(--tx-3)'],
      ['Your Life', String(me.life), 'var(--danger)'],
    ].map(([k, v, c]) => h('div.counter',
      h('div.k', h('div.swatch', { style: { background: c } }), h('div.lbl', k)),
      h('div.v', v),
    ));

    const canAdvance = yourTurn && !G.pending && !G.over;
    const nextLabel = G.phase === 'end' ? 'Pass turn →'
      : `Advance to ${PHASE_LABEL[PHASES[phaseIdx + 1]]}`;

    return h('aside.rail',
      h('div',
        h('div.eyebrow', { style: { marginBottom: '9px' } }, 'Turn'),
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '7px', marginBottom: '12px' } },
          h('div', { style: { font: '700 30px/1 var(--mono)' } }, String(G.turn)),
          h('div', { style: { font: '500 11px/1 var(--font)', color: 'var(--tx-3)' } },
            G.over ? 'game over' : (yourTurn ? 'your turn' : 'opponent')),
        ),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } }, phases),
        h('button.btn-pri', {
          style: { width: '100%', marginTop: '10px' },
          disabled: !canAdvance,
          onclick: () => act({ type: 'advance' }),
        }, G.over ? 'Game over' : nextLabel),
        beginner && !G.over
          ? h('div.hint-box', { style: { marginTop: '9px' } }, RULES[phaseIdx]?.body || '')
          : null,
      ),

      h('div.hr'),

      h('div',
        h('div.eyebrow', { style: { marginBottom: '9px' } }, 'Resources'),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } }, counters),
      ),

      h('div.hr'),

      h('div',
        h('div.eyebrow', { style: { marginBottom: '9px' } }, 'Selected'),
        renderInspector(),
      ),
      h('div.spacer'),
    );
  }

  function renderInspector() {
    const db = getCards();
    if (!selected) {
      return h('div.empty-note', 'Click a card in hand to inspect and play it, or a character to attack with it.');
    }
    const me = view(G, HUMAN);
    let card = null, footer = null;

    if (selected.kind === 'hand') {
      const id = me.hand[selected.index];
      card = db[id];
      if (!card) return h('div.empty-note', 'That card is no longer in hand.');
      const playable = legalActions(G).some(a => a.type === 'play' && a.index === selected.index);
      const why = G.active !== HUMAN ? 'Not your turn'
        : G.phase !== 'main' ? 'Only during your Main Phase'
          : costOf(card) > me.donActive ? `Needs ${costOf(card)} active DON!!`
            : (card.category === 'Character' && me.chars.length >= 5) ? 'Character area is full'
              : 'Play';
      footer = h('button', {
        class: playable ? 'btn-pri' : 'btn',
        style: { width: '100%' },
        disabled: !playable,
        onclick: () => act({ type: 'play', index: selected.index }),
      }, playable ? `Play for ${costOf(card)} DON!!` : why);
    } else if (selected.kind === 'char' || selected.kind === 'leader') {
      const ref = selected.kind === 'leader' ? 'leader' : selected.uid;
      const id = selected.kind === 'leader' ? me.leaderId : me.chars.find(c => c.uid === ref)?.id;
      card = db[id];
      const able = canAttack(G, HUMAN, ref);
      footer = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '5px' } },
        h('button', {
          class: able ? 'btn-pri' : 'btn',
          style: { width: '100%' },
          disabled: !able,
          onclick: () => { attacker = ref; selected = null; render(); },
        }, able ? 'Declare attack' : 'Cannot attack'),
        h('button.btn', {
          style: { width: '100%' },
          disabled: me.donActive < 1 || G.active !== HUMAN || G.phase !== 'main',
          onclick: () => act({ type: 'attach', target: ref }),
        }, 'Attach 1 DON!! (+1000)'),
      );
    }

    if (!card) return h('div.empty-note', 'Nothing selected.');
    return h('div.anim-pop',
      cardSummary(card),
      h('div', { style: { marginTop: '10px' } }, footer),
      h('button.btn-ghost', {
        style: { width: '100%', marginTop: '5px' },
        onclick: () => { selected = null; render(); },
      }, 'Deselect'),
    );
  }

  /* ------------------------------------------------------------------ */
  /* mat                                                                 */
  /* ------------------------------------------------------------------ */

  function renderMat() {
    const db = getCards();
    const me = view(G, HUMAN);
    const opp = view(G, AI);
    const targets = attacker ? attackTargets(G, HUMAN, attacker) : [];
    const targetLeader = targets.some(t => t.kind === 'leader');
    const targetChars = new Set(targets.filter(t => t.kind === 'char').map(t => t.uid));

    const prompt = G.pending && G.pending.side === HUMAN ? renderPrompt(G.pending) : null;

    return h('main', {
      style: {
        flex: '1', minWidth: '0', display: 'flex', flexDirection: 'column',
        alignItems: 'center', padding: '16px 20px 24px', overflow: 'auto',
        background: 'radial-gradient(90% 70% at 50% 0%,rgba(91,157,255,.05),transparent 70%)',
      },
    },
      G.over ? renderOver() : null,
      attacker && !G.over ? h('div.banner', { style: { marginBottom: '12px' } },
        h('div.live'),
        h('div', `${unitName(G, HUMAN, attacker)} is attacking — pick a target`),
        h('button.btn', {
          style: { padding: '4px 10px', marginLeft: '6px' },
          onclick: () => { attacker = null; render(); },
        }, 'Cancel'),
      ) : null,
      prompt,

      h('div', { style: { width: '100%', maxWidth: '1020px', display: 'flex', flexDirection: 'column', gap: '14px' } },

        /* --- opponent strip --- */
        h('section', {
          style: {
            display: 'flex', alignItems: 'center', gap: '16px', padding: '11px 14px',
            borderRadius: 'var(--r-xl)', border: '1px solid rgba(255,255,255,.06)', background: 'rgba(255,255,255,.018)',
          },
        },
          h('div.eyebrow', { style: { writingMode: 'vertical-rl', transform: 'rotate(180deg)' } }, 'Opponent'),
          h('div', { style: { width: '78px', flex: 'none' } },
            cardTile(db[opp.leaderId], {
              power: fmt(opp.leaderPower),
              pips: opp.leaderDon,
              badge: null,
              rested: opp.leaderRested,
              target: !!attacker && targetLeader,
              onClick: attacker && targetLeader
                ? () => { const a = attacker; attacker = null; act({ type: 'attack', attacker: a, target: { kind: 'leader' } }); }
                : undefined,
            })),
          h('div',
            h('div.eyebrow.eyebrow-14', { style: { marginBottom: '6px' } }, 'Life'),
            h('div.life-row', Array.from({ length: opp.lifeMax }, (_, i) =>
              h('div.life', { class: i < opp.life ? 'is-alive' : '', style: { '--lc': 'var(--danger)' } }))),
          ),
          h('div', { style: { display: 'flex', gap: '18px', marginLeft: '8px' } },
            miniStat('Hand', opp.handCount),
            miniStat('DON!!', `${opp.donActive}/${opp.donActive + opp.donRested}`),
            miniStat('Deck', opp.deck),
          ),
          h('div.spacer'),
          h('div', { style: { font: '400 10px/1.45 var(--font)', color: 'var(--tx-5)', maxWidth: '160px', textAlign: 'right' } },
            G.p2.name),
        ),

        /* --- opponent characters --- */
        opp.chars.length ? h('section',
          h('div.eyebrow.eyebrow-14', { style: { marginBottom: '7px' } }, 'Opponent characters'),
          h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(5,minmax(0,1fr))', gap: '10px' } },
            opp.chars.map(ch => {
              const isTarget = !!attacker && targetChars.has(ch.uid);
              return h('div', cardTile(db[ch.id], {
                power: fmt(ch.power), pips: ch.don, rested: ch.rested, target: isTarget,
                badge: ch.rested ? 'REST' : null,
                onClick: isTarget
                  ? () => { const a = attacker; attacker = null; act({ type: 'attack', attacker: a, target: { kind: 'char', uid: ch.uid } }); }
                  : undefined,
                title: ch.rested ? `${db[ch.id]?.name} (rested — attackable)` : `${db[ch.id]?.name} (active — cannot be attacked)`,
              }));
            })),
        ) : null,

        h('div.divider-label', h('span', 'Your side')),

        /* --- leader row --- */
        h('section', { style: { display: 'flex', alignItems: 'flex-end', gap: '14px', flexWrap: 'wrap' } },
          h('div',
            h('div.eyebrow.eyebrow-14', { style: { marginBottom: '7px' } }, 'Life'),
            h('div.life-col', Array.from({ length: me.lifeMax }, (_, i) =>
              h('div.life', { class: i < me.life ? 'is-alive' : '', style: { '--lc': 'var(--danger)' } }))),
          ),
          h('div',
            h('div.eyebrow.eyebrow-14', { style: { marginBottom: '7px' } }, 'Leader'),
            h('div', { style: { width: '104px' } },
              cardTile(db[me.leaderId], {
                power: fmt(me.leaderPower), pips: me.leaderDon, badge: null,
                rested: me.leaderRested,
                selected: selected?.kind === 'leader' || attacker === 'leader',
                onClick: () => { selected = { kind: 'leader' }; attacker = null; render(); },
              })),
            h('div', { style: { display: 'flex', gap: '4px', marginTop: '6px', width: '104px' } },
              h('button.btn-mini.btn-don', {
                disabled: me.donActive < 1 || G.active !== HUMAN || G.phase !== 'main' || !!G.pending,
                onclick: () => act({ type: 'attach', target: 'leader' }),
              }, '+DON'),
              h('button.btn-mini.btn-atk', {
                disabled: !canAttack(G, HUMAN, 'leader'),
                onclick: () => { attacker = 'leader'; selected = null; render(); },
              }, 'ATK'),
            ),
            /* Stays put and explains itself when unusable — a control that
             * disappears reads as "this Leader has no ability at all". */
            (() => {
              const st = leaderAbilityStatus(G, HUMAN);
              if (!st.has) return null;
              return h('button.btn-mini.btn-don', {
                style: { width: '104px', marginTop: '4px', flex: 'none' },
                disabled: !st.usable,
                title: st.usable
                  ? String(db[me.leaderId]?.effect || '').replace(/<br>/g, '\n')
                  : st.reason,
                onclick: () => act({ type: 'leaderAbility' }),
              }, 'ABILITY');
            })(),
          ),
          h('div',
            h('div.eyebrow.eyebrow-14', { style: { marginBottom: '7px' } }, 'Stage'),
            me.stage
              ? h('div', { style: { width: '82px' } }, cardTile(db[me.stage], { badge: 'STAGE' }))
              : h('div.slot-empty', { style: { width: '82px', height: '114px' } }, 'EMPTY'),
          ),
          h('div.spacer'),
          h('div', { style: { display: 'flex', gap: '12px' } },
            pileTile('Trash', me.trash, 'var(--tx-3)'),
            pileTile('Deck', me.deck, 'var(--accent)'),
          ),
        ),

        /* --- character area --- */
        h('section',
          h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '9px', marginBottom: '7px' } },
            h('div.eyebrow.eyebrow-14', 'Character area'),
            h('div', { style: { font: '500 9.5px/1 var(--mono)', color: 'var(--tx-6)' } }, `${me.chars.length}/5`),
          ),
          h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(5,minmax(0,1fr))', gap: '10px' } },
            Array.from({ length: 5 }, (_, i) => {
              const ch = me.chars[i];
              if (!ch) return h('div', h('div.slot-empty', String(i + 1)));
              const able = canAttack(G, HUMAN, ch.uid);
              return h('div',
                cardTile(db[ch.id], {
                  power: fmt(ch.power), pips: ch.don, rested: ch.rested,
                  badge: ch.rested ? 'REST' : (ch.summoningSick ? 'SICK' : null),
                  selected: selected?.uid === ch.uid || attacker === ch.uid,
                  onClick: () => { selected = { kind: 'char', uid: ch.uid }; attacker = null; render(); },
                }),
                h('div', { style: { display: 'flex', gap: '4px', marginTop: '5px' } },
                  h('button.btn-mini.btn-don', {
                    disabled: me.donActive < 1 || G.active !== HUMAN || G.phase !== 'main' || !!G.pending,
                    onclick: () => act({ type: 'attach', target: ch.uid }),
                  }, '+DON'),
                  h('button.btn-mini.btn-atk', {
                    disabled: !able,
                    onclick: () => { attacker = ch.uid; selected = null; render(); },
                  }, 'ATK'),
                ),
                // Characters carry activated abilities as often as Leaders do.
                (() => {
                  const st = charAbilityStatus(G, HUMAN, ch.uid);
                  if (!st.has) return null;
                  return h('button.btn-mini.btn-don', {
                    style: { width: '100%', marginTop: '4px', flex: 'none' },
                    disabled: !st.usable,
                    title: st.usable
                      ? String(db[ch.id]?.effect || '').replace(/<br>/g, '\n')
                      : st.reason,
                    onclick: () => act({ type: 'activateChar', uid: ch.uid }),
                  }, 'ABILITY');
                })(),
              );
            })),
        ),

        /* --- DON!! area --- */
        h('section.don-area',
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '11px', marginBottom: '9px' } },
            h('div.eyebrow.eyebrow-14', { style: { color: '#a3894a' } }, 'DON!! area'),
            h('div', { style: { font: '500 10px/1 var(--mono)', color: 'var(--tx-4)' } },
              `${me.donActive} active · ${me.donRested} rested · ${me.donDeck} left in deck`),
            h('div.spacer'),
            h('div', { style: { font: '400 10px/1 var(--font)', color: 'var(--tx-5)' } },
              'Rested DON!! refresh at the start of your turn.'),
          ),
          h('div.don-grid',
            Array.from({ length: me.donActive }, () => h('div.don', { title: 'Active DON!!' }, '1')),
            Array.from({ length: me.donRested }, () => h('div.don.is-rested', { title: 'Rested DON!!' }, '1')),
            me.donActive + me.donRested === 0
              ? h('div', { style: { font: '400 11px/1 var(--font)', color: 'var(--tx-5)', padding: '10px 0' } }, 'No DON!! in the cost area.')
              : null,
          ),
        ),

        /* --- hand --- */
        h('section',
          h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '9px', marginBottom: '8px' } },
            h('div.eyebrow.eyebrow-14', 'Hand'),
            h('div', { style: { font: '500 9.5px/1 var(--mono)', color: 'var(--tx-6)' } }, `${me.handCount} cards`),
          ),
          h('div', { style: { display: 'flex', alignItems: 'flex-end', gap: '8px', minHeight: '150px', flexWrap: 'wrap' } },
            me.hand.map((id, i) => {
              const c = db[id];
              const playable = legalActions(G).some(a => a.type === 'play' && a.index === i);
              return h('div', { class: 'anim-deal', style: { width: '104px', flex: 'none' } },
                cardTile(c, {
                  selected: selected?.kind === 'hand' && selected.index === i,
                  illegal: !playable && G.active === HUMAN && G.phase === 'main',
                  onClick: () => { selected = { kind: 'hand', index: i }; attacker = null; render(); },
                }));
            }),
            !me.hand.length ? h('div.empty-note', 'Your hand is empty.') : null,
          ),
        ),
      ),
    );
  }

  function miniStat(label, value) {
    return h('div',
      h('div', { style: { font: '500 8.5px/1 var(--mono)', color: 'var(--tx-5)', letterSpacing: '.12em' } }, label),
      h('div', { style: { font: '700 15px/1.3 var(--mono)' } }, String(value)),
    );
  }

  function pileTile(label, count, color) {
    return h('div',
      h('div.eyebrow.eyebrow-14', { style: { marginBottom: '7px' } }, label),
      h('div', {
        style: {
          width: '82px', height: '114px', borderRadius: '9px',
          border: '1px solid rgba(255,255,255,.08)',
          background: 'linear-gradient(165deg,#1a1d25,#101319)',
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '4px',
        },
      },
        h('div', { style: { font: '700 20px/1 var(--mono)', color } }, String(count)),
        h('div', { style: { font: '500 8.5px/1 var(--mono)', color: 'var(--tx-6)', letterSpacing: '.1em' } }, 'CARDS'),
      ),
    );
  }

  function renderOver() {
    const won = G.over.winner === HUMAN;
    return h('div.banner', {
      class: won ? 'banner-ok' : '',
      style: { marginBottom: '14px', padding: '14px 22px', font: '700 15px/1.3 var(--font)' },
    },
      h('div.live'),
      h('div', won ? 'You win' : 'You lose'),
      h('div', { style: { font: '400 11.5px/1.4 var(--font)', opacity: '.85' } }, G.over.reason),
      h('button.btn', { style: { marginLeft: 'auto' }, onclick: () => { G = null; render(); } }, 'New game'),
    );
  }

  /* ------------------------------------------------------------------ */
  /* pending prompts                                                     */
  /* ------------------------------------------------------------------ */

  function renderPrompt(p) {
    const db = getCards();
    const opts = [];

    if (p.type === 'block') {
      opts.push(h('button.btn-pri', { onclick: () => act({ type: 'block', uid: null }) }, 'No block'));
      for (const o of p.options) {
        opts.push(h('button.btn', { onclick: () => act({ type: 'block', uid: o.uid }) },
          `Block with ${o.label} (${fmt(o.power)})`));
      }
    } else if (p.type === 'counter') {
      const gap = p.attackPower - p.defendPower;
      opts.push(h('button.btn-pri', { onclick: () => act({ type: 'counter', index: null }) },
        gap >= 0 ? 'Take the hit' : 'Done'));
      for (const o of p.options) {
        opts.push(h('button.btn', { onclick: () => act({ type: 'counter', index: o.index }) },
          `${o.label} +${fmt(o.value)}${o.cost ? ` (${o.cost} DON!!)` : ''}`));
      }
    } else if (p.type === 'trigger') {
      opts.push(h('button.btn-pri', { onclick: () => act({ type: 'trigger', activate: true }) }, 'Activate'));
      opts.push(h('button.btn', { onclick: () => act({ type: 'trigger', activate: false }) }, 'Keep in hand'));
    } else if (p.type === 'confirm') {
      opts.push(h('button.btn-pri', { onclick: () => act({ type: 'choose', value: true }) }, 'Pay it'));
      opts.push(h('button.btn', { onclick: () => act({ type: 'choose', value: false }) }, 'Decline'));
    } else if (p.type === 'manual') {
      for (const o of p.options) {
        opts.push(h('button.btn', { onclick: () => act({ type: 'choose', value: o.key }) }, o.label));
      }
    } else if (p.type === 'target') {
      if (p.optional) opts.push(h('button.btn', { onclick: () => act({ type: 'choose', value: null }) }, 'Skip'));
      for (const o of p.options) {
        opts.push(h('button.btn-pri', {
          onclick: () => act({ type: 'choose', value: o.uid ?? o.index }),
        }, o.label));
      }
    }

    const detail = p.type === 'counter'
      ? `Attack ${fmt(p.attackPower)} vs your ${fmt(p.defendPower)} — you need ${fmt(Math.max(0, p.attackPower - p.defendPower + 1))} more to survive.`
      : (p.text || '');

    return h('div.panel.anim-pop', {
      style: {
        marginBottom: '12px', width: '100%', maxWidth: '1020px',
        borderColor: 'rgba(91,157,255,.35)', background: 'rgba(91,157,255,.07)',
      },
    },
      h('div', { style: { font: '600 13px/1.3 var(--font)', marginBottom: detail ? '5px' : '9px' } }, p.prompt),
      detail ? h('div', { style: { font: '400 11px/1.5 var(--font)', color: 'var(--tx-3)', marginBottom: '9px', whiteSpace: 'pre-wrap' } }, detail) : null,
      h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } }, opts),
    );
  }

  /* ------------------------------------------------------------------ */
  /* right rail — log + explain                                          */
  /* ------------------------------------------------------------------ */

  const LOG_COLOR = {
    attack: 'var(--danger)', battle: 'var(--danger)', damage: 'var(--danger)',
    ko: 'var(--danger)', don: 'var(--don)', play: 'var(--accent)',
    draw: 'var(--ok)', counter: 'var(--accent-soft)', block: 'var(--accent-soft)',
    trigger: 'var(--don)', end: 'var(--danger)',
  };

  function renderRailRight() {
    const entries = G.log.slice(-80).reverse();
    const info = explain(G.log[explainIdx >= 0 ? explainIdx : G.log.length - 1], { beginner });

    return h('aside.rail.rail-r',
      h('div.log-head',
        h('div.eyebrow', 'Game log'),
        h('div', { style: { font: '500 9.5px/1 var(--mono)', color: 'var(--tx-6)' } }, `${G.log.length} events`),
        h('div.spacer'),
        h('label', {
          style: { display: 'flex', alignItems: 'center', gap: '5px', font: '500 10px/1 var(--font)', color: 'var(--tx-4)', cursor: 'pointer' },
          title: 'Longer explanations aimed at new players',
        },
          h('input', { type: 'checkbox', checked: beginner, onchange: e => { beginner = e.target.checked; render(); } }),
          'teach',
        ),
      ),
      h('div.log-body',
        entries.map(e => h('button.log-entry', {
          onclick: () => { explainIdx = e.i; explainOpen = true; render(); },
        },
          h('div.tag', `T${e.turn}`),
          h('div.bar', { style: { background: LOG_COLOR[e.kind] || 'var(--tx-6)' } }),
          h('div.txt', e.text,
            explainIdx === e.i ? null : h('div.hint', 'click to explain →')),
        )),
        !entries.length ? h('div.empty-note', 'No events yet.') : null,
      ),
      h('div.log-foot',
        h('button.btn-info', {
          onclick: () => { explainIdx = G.log.length - 1; explainOpen = true; render(); },
        }, h('span', { style: { font: '700 11px/1 var(--mono)' } }, '?'), h('span', 'Explain what just happened')),
        explainOpen ? h('div.explain',
          h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: '9px', marginBottom: '8px' } },
            h('h4', { style: { flex: '1' } }, info.title),
            h('button', {
              style: { border: '0', background: 'none', color: 'var(--tx-4)', font: '400 15px/1 var(--font)', padding: '0' },
              'aria-label': 'Close explanation',
              onclick: () => { explainOpen = false; render(); },
            }, '×'),
          ),
          h('div.body', info.body),
          h('div.rule', h('div.k', 'RULE'), h('div.v', info.rule)),
        ) : null,
      ),
    );
  }

  /* ------------------------------------------------------------------ */
  /* rules drawer                                                        */
  /* ------------------------------------------------------------------ */

  function renderDrawer() {
    if (!helpOpen) return null;
    return h('div.drawer',
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '9px', marginBottom: '11px' } },
        h('h3', { style: { flex: '1' } }, 'Turn structure'),
        h('button', {
          style: { border: '0', background: 'none', color: 'var(--tx-4)', font: '400 16px/1 var(--font)' },
          'aria-label': 'Close', onclick: () => { helpOpen = false; render(); },
        }, '×'),
      ),
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
        RULES.map(r => h('div', { style: { display: 'flex', gap: '10px' } },
          h('div', { style: { width: '16px', flex: 'none', font: '700 10px/1.6 var(--mono)', color: 'var(--accent)' } }, r.n),
          h('div', { style: { flex: '1' } },
            h('div', { style: { font: '600 11.5px/1.4 var(--font)', color: '#dbe0ea' } }, r.title),
            h('div', { style: { font: '400 10.5px/1.5 var(--font)', color: 'var(--tx-3)', marginTop: '2px' } }, r.body),
          ),
        ))),
    );
  }

  /* ------------------------------------------------------------------ */
  /* assembly                                                            */
  /* ------------------------------------------------------------------ */

  els.body = renderSetup();
  els.drawer = h('div');
  const root = h('div.view', { id: 'view-board' }, els.body, els.drawer);

  function render() {
    const next = G
      ? h('div', { style: { flex: '1', display: 'flex', minHeight: '0', width: '100%' } },
        renderRailLeft(), renderMat(), renderRailRight())
      : renderSetup();
    els.body.replaceWith(next);
    els.body = next;
    fill(els.drawer, renderDrawer());
    if (G?.pending?.side === HUMAN) announce(G.pending.prompt);
  }

  return {
    root,
    render() { render(); },
    toggleHelp() { helpOpen = !helpOpen; render(); },
    reset() { clearTimeout(pendingAiTimer); G = null; render(); },
    isPlaying: () => !!G,
    start: startGame,
  };
}
