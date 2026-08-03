/* Meta view — templates, the advisor, and the matchup gauntlet.
 *
 * Not in the original mockup (it covered Playtest and Builder only), so this is
 * built in the same visual language: the same rails, eyebrow labels, tiles and
 * meters, extended to the three things the deck data makes possible.
 */

import { h, fill, toast, fmt } from './dom.js';
import { cardTile, costLabel } from './card.js';
import { attachPreview } from './preview.js';
import { getCards } from '../data/cards.js';
import { deckStats, totalCards, isLegal, validate } from '../data/deck.js';
import {
  getMeta, archetypes, archetypeFor, archetypeDeck, advise, reasonFor, fmtPct, structuralNotes,
} from '../data/meta.js';
import { runMatchup } from '../engine/sim.js';
import { SKILL } from '../engine/ai.js';

const TABS = [
  ['templates', 'Templates'],
  ['advisor', 'Advisor'],
  ['matchups', 'Matchups'],
];

export function createMeta(app) {
  let tab = 'templates';
  let compareId = null;
  let sim = null;           // { running, rows, done, total, games }
  const els = {};

  /* ------------------------------------------------------------------ */
  /* templates                                                           */
  /* ------------------------------------------------------------------ */

  function renderTemplates() {
    const meta = getMeta();
    const db = getCards();
    const list = archetypes();

    if (!list.length) {
      return h('div.empty-note',
        meta?.error
          ? `Could not load data/meta.json (${meta.error}). Run \`npm run meta\` and serve the folder over HTTP.`
          : 'No meta snapshot found. Run `npm run meta` to generate data/meta.json.');
    }

    return h('div',
      h('div', { style: { font: '400 11.5px/1.6 var(--font)', color: 'var(--tx-4)', marginBottom: '16px' } },
        `${meta.format} · ${fmt(meta.totalLists)} published tournament lists · generated ${String(meta.generated).slice(0, 10)}. `,
        'Loading a template gives you the field\'s consensus 50 — the settled core plus the most-played answer for each contested slot.'),

      h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(310px,1fr))', gap: '12px' } },
        list.map(a => {
          const leader = db[a.leader];
          return h('div.panel', { style: { display: 'flex', gap: '12px', padding: '13px' } },
            h('div', { style: { width: '74px', flex: 'none' } },
              leader ? cardTile(leader, { badge: null }) : h('div.slot-empty', '?')),
            h('div', { style: { flex: '1', minWidth: '0', display: 'flex', flexDirection: 'column' } },
              h('div', { style: { font: '600 13.5px/1.25 var(--font)', marginBottom: '3px' } }, a.name),
              h('div', { style: { font: '500 9.5px/1.5 var(--mono)', color: 'var(--tx-4)', marginBottom: '8px' } },
                `${fmtPct(a.share)} of field · ${a.deckCount} lists`),

              h('div.row', { style: { gap: '6px', marginBottom: '4px' } },
                h('div.meter', { title: `${a.coreSlots} settled slots, ${a.flexSlots} contested` },
                  h('i', { style: { width: `${(a.coreSlots / 50) * 100}%`, background: 'var(--ok)' } })),
                h('div', { style: { font: '600 9.5px/1 var(--mono)', color: 'var(--tx-4)' } }, `${a.coreSlots} core`),
              ),
              h('div', { style: { font: '400 10px/1.5 var(--font)', color: 'var(--tx-5)', marginBottom: '9px' } },
                `${a.flexSlots} flex slot${a.flexSlots === 1 ? '' : 's'} the field disagrees about`),

              h('div.spacer'),
              h('div.row', { style: { gap: '6px' } },
                h('button.btn-pri', {
                  style: { flex: '1', padding: '8px' },
                  onclick: () => loadTemplate(a, 'consensus'),
                }, 'Load consensus'),
                h('button.btn', {
                  title: `${a.topList.placing} · ${a.topList.player ?? 'unknown'} · ${a.topList.tournament ?? ''}`,
                  onclick: () => loadTemplate(a, 'top'),
                }, 'Top list'),
              ),
            ),
          );
        })),
    );
  }

  function loadTemplate(a, which) {
    const d = archetypeDeck(a, which);
    app.deck.name = d.name;
    app.deck.leader = d.leader;
    app.deck.cards = { ...d.cards };
    app.deckChanged();
    toast(`Loaded ${d.name} — ${totalCards(app.deck)} cards.`, 'good');
    app.go('builder');
  }

  /* ------------------------------------------------------------------ */
  /* advisor                                                             */
  /* ------------------------------------------------------------------ */

  function renderAdvisor() {
    const db = getCards();
    const list = archetypes();
    const n = totalCards(app.deck);

    if (!app.deck.leader || !n) {
      return h('div.empty-note', 'Build a deck first — pick a Leader and add some cards, then come back.');
    }

    const auto = archetypeFor(app.deck.leader);
    const chosen = compareId ? list.find(a => String(a.id) === String(compareId)) : auto;
    const result = chosen ? advise(app.deck, chosen) : null;
    const stats = deckStats(app.deck);
    const problems = validate(app.deck);

    const picker = h('div.row', { style: { marginBottom: '14px', flexWrap: 'wrap' } },
      h('div.eyebrow', 'Compare against'),
      h('select.input', {
        style: { width: 'auto' },
        onchange: e => { compareId = e.target.value || null; refresh(); },
      },
        h('option', { value: '' }, auto ? `Auto — ${auto.name}` : 'Pick an archetype…'),
        list.map(a => h('option', { value: String(a.id), selected: String(compareId) === String(a.id) }, a.name)),
      ),
    );

    /* Structural checks apply to any deck, meta or brew. */
    const structural = h('div', { style: { marginBottom: '20px' } },
      h('div.eyebrow', { style: { marginBottom: '9px' } }, 'Structure'),
      h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(250px,1fr))', gap: '8px' } },
        problems.map(p => note('bad', 'Not legal', p.msg)),
        structuralNotes(stats).map(x => note(x.level, x.title, x.detail)),
      ),
    );

    if (!result) {
      return h('div', picker, structural,
        h('div.empty-note', 'No reference archetype for this Leader — pick one above to compare against.'));
    }

    return h('div', picker, structural,
      h('div', { style: { font: '400 11.5px/1.6 var(--font)', color: 'var(--tx-4)', marginBottom: '16px' } },
        `Against ${result.archetype.deckCount} published ${result.archetype.name} lists. `,
        result.balanced
          ? 'Adds and cuts balance, so this is a straight swap package.'
          : `Your deck is ${result.total}/50, so adds and cuts don't balance yet.`),

      section('Add — staples you are short of',
        'At 90%+ of lists. Running fewer is a deliberate deviation.',
        result.adds.filter(r => r.isCore), 'add'),

      section('Add — contested slots leaning your way', null,
        result.adds.filter(r => !r.isCore), 'add'),

      section('Cut — where you are over the field', null, result.cuts, 'cut'),

      result.flex.length ? h('div', { style: { marginBottom: '20px' } },
        h('div.eyebrow', { style: { marginBottom: '4px' } },
          `Flex options — ${result.archetype.flexSlots} of 50 slots`),
        h('div', { style: { font: '400 10.5px/1.5 var(--font)', color: 'var(--tx-5)', marginBottom: '9px' } },
          'The field is split on these; any of them is a defensible choice.'),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
          result.flex.slice(0, 10).map(c => attachPreview(h('div.dl-row',
            h('div.cost', costLabel(c.card)),
            h('div.nm', `${c.copy}× ${c.name}`),
            h('div', { style: { font: '500 10px/1 var(--mono)', color: 'var(--tx-4)' } },
              `${fmtPct(c.weight)} run this many`),
          ), c.card))),
      ) : null,

      h('div.panel', { style: { display: 'flex', gap: '10px', alignItems: 'center' } },
        h('div', { style: { font: '600 12px/1.4 var(--font)' } },
          `${result.cutN} out, ${result.addN} in`),
        h('div.spacer'),
        h('button.btn-pri', {
          disabled: !result.adds.length && !result.cuts.length,
          onclick: () => applySwap(result),
        }, 'Apply the whole swap'),
      ),
    );
  }

  function section(title, subtitle, rows, kind) {
    if (!rows.length) return null;
    return h('div', { style: { marginBottom: '20px' } },
      h('div.eyebrow', { style: { marginBottom: subtitle ? '4px' : '9px' } }, title),
      subtitle ? h('div', { style: { font: '400 10.5px/1.5 var(--font)', color: 'var(--tx-5)', marginBottom: '9px' } }, subtitle) : null,
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
        rows.map(r => attachPreview(h('div.dl-row',
          h('div.cost', costLabel(r.card)),
          h('div', {
            style: {
              width: '46px', flex: 'none', font: '700 10px/1 var(--mono)', textAlign: 'center',
              color: kind === 'add' ? 'var(--ok)' : 'var(--danger)',
            },
          }, kind === 'add' ? `+${r.delta}` : `${r.have}→${r.want}`),
          h('div.nm', r.name),
          h('div', { style: { font: '400 9.5px/1.35 var(--mono)', color: 'var(--tx-5)', maxWidth: '46%', textAlign: 'right' } },
            reasonFor(r)),
        ), r.card))),
    );
  }

  function applySwap(result) {
    for (const r of result.cuts) {
      if (r.want === 0) delete app.deck.cards[r.id];
      else app.deck.cards[r.id] = r.want;
    }
    for (const r of result.adds) app.deck.cards[r.id] = r.want;
    app.deckChanged();
    toast(`Applied — deck is now ${totalCards(app.deck)}/50.`, 'good');
    refresh();
  }

  function note(level, title, detail) {
    const color = level === 'bad' ? 'var(--danger)' : level === 'warn' ? 'var(--don)' : 'var(--ok)';
    return h('div', {
      style: {
        borderLeft: `3px solid ${color}`, padding: '8px 11px',
        background: 'var(--panel-2)', borderRadius: '0 var(--r-sm) var(--r-sm) 0',
      },
    },
      h('div', { style: { font: '600 11.5px/1.3 var(--font)', marginBottom: '2px' } }, title),
      h('div', { style: { font: '400 10.5px/1.5 var(--font)', color: 'var(--tx-4)' } }, detail),
    );
  }

  /* ------------------------------------------------------------------ */
  /* matchups                                                            */
  /* ------------------------------------------------------------------ */

  function renderMatchups() {
    const list = archetypes();
    const legal = isLegal(app.deck);

    const controls = h('div.panel', { style: { marginBottom: '16px' } },
      h('div.row', { style: { flexWrap: 'wrap', gap: '12px' } },
        h('div', { style: { flex: '1', minWidth: '220px' } },
          h('div', { style: { font: '600 12.5px/1.3 var(--font)', marginBottom: '3px' } },
            'Play your deck against the field'),
          h('div', { style: { font: '400 10.5px/1.5 var(--font)', color: 'var(--tx-4)' } },
            'Each matchup alternates who goes first, so neither side keeps the play advantage.'),
        ),
        h('select.input', { style: { width: 'auto' }, id: 'simGames' },
          h('option', { value: '40' }, '40 games each'),
          h('option', { value: '100', selected: true }, '100 games each'),
          h('option', { value: '300' }, '300 games each'),
        ),
        h('button.btn-pri', {
          style: { padding: '10px 18px' },
          disabled: !legal || !list.length || sim?.running,
          onclick: () => runSim(+document.getElementById('simGames').value),
        }, sim?.running ? 'Running…' : 'Run simulation'),
      ),
      !legal ? h('div', { style: { font: '400 10.5px/1.5 var(--font)', color: 'var(--danger-soft)', marginTop: '9px' } },
        'Your deck must be legal to simulate.') : null,
    );

    // The honest caveat: coverage gates how much these numbers mean.
    const caveat = h('div.panel', {
      style: { marginBottom: '16px', borderColor: 'rgba(232,184,75,.25)', background: 'rgba(232,184,75,.05)' },
    },
      h('div', { style: { font: '600 11.5px/1.4 var(--font)', color: 'var(--don)', marginBottom: '4px' } },
        'Best used to compare your own changes, not to rank archetypes'),
      h('div', { style: { font: '400 10.5px/1.6 var(--font)', color: 'var(--tx-3)' } },
        'Every card in the current meta is now modelled, so the rules are right. What is still approximate is the opponent: ',
        'both sides are driven by one general-purpose AI, and a deck whose plan needs precise sequencing will underperform a deck of straightforward big bodies. ',
        'That bias is roughly constant for a given opponent, which is what makes the A/B use sound — run your list, change two cards, run it again against the same field and seed, and the difference is real even though the absolute number is soft.'),
    );

    if (!sim) return h('div', controls, caveat, h('div.empty-note', 'No simulation run yet.'));

    const rows = sim.rows.slice().sort((a, b) => b.winRate - a.winRate);
    const totalShare = rows.reduce((s, r) => s + (r.share || 0), 0);
    const weighted = totalShare ? rows.reduce((s, r) => s + r.winRate * (r.share || 0), 0) / totalShare : 0;
    const overall = rows.length ? rows.reduce((s, r) => s + r.winRate, 0) / rows.length : 0;

    return h('div', controls, caveat,
      sim.running
        ? h('div.row', { style: { marginBottom: '14px' } },
          h('div.meter', h('i', { style: { width: `${(sim.done / sim.total) * 100}%` } })),
          h('div', { style: { font: '500 10px/1 var(--mono)', color: 'var(--tx-4)' } }, `${sim.done}/${sim.total}`),
        )
        : null,

      h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
        rows.map(r => {
          const color = r.winRate >= 0.55 ? 'var(--ok)' : r.winRate >= 0.45 ? 'var(--don)' : 'var(--danger)';
          return h('div.panel', { style: { padding: '10px 13px' } },
            h('div.row', { style: { gap: '12px' } },
              h('div', { style: { flex: '1', minWidth: '0' } },
                h('div', { style: { font: '600 12px/1.3 var(--font)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, r.name),
                h('div', { style: { font: '500 9.5px/1.5 var(--mono)', color: 'var(--tx-5)' } },
                  `${r.share != null ? fmtPct(r.share) + ' of field · ' : ''}play ${fmtPct(r.onPlay)} · draw ${fmtPct(r.onDraw)}`),
              ),
              h('div', { style: { width: '150px', flex: 'none' } },
                h('div.meter', h('i', { style: { width: `${r.winRate * 100}%`, background: color } })),
                h('div', { style: { font: '500 9px/1.6 var(--mono)', color: 'var(--tx-5)', textAlign: 'right' } },
                  `95% CI ${(r.ci95[0] * 100).toFixed(0)}–${(r.ci95[1] * 100).toFixed(0)}%`),
              ),
              h('div', { style: { width: '58px', flex: 'none', textAlign: 'right', font: '700 15px/1 var(--mono)', color } },
                fmtPct(r.winRate)),
            ),
          );
        })),

      rows.length && !sim.running ? h('div.panel', { style: { marginTop: '14px' } },
        h('div.row',
          h('div', { style: { flex: '1' } },
            h('div', { style: { font: '600 12px/1.4 var(--font)' } }, 'Weighted by meta share'),
            h('div', { style: { font: '400 10px/1.5 var(--font)', color: 'var(--tx-4)' } },
              `What you would actually face. Unweighted average ${fmtPct(overall)}.`),
          ),
          h('div', { style: { font: '700 22px/1 var(--mono)', color: 'var(--accent)' } }, fmtPct(weighted)),
        ),
      ) : null,
    );
  }

  /* Run the gauntlet one archetype at a time, yielding to the browser between
   * each so the progress bar actually paints instead of freezing the tab. */
  function runSim(games) {
    const field = archetypes().map(a => ({
      key: a.id, name: a.name, leader: a.leader, cards: a.consensus, share: a.share,
    }));
    const cards = getCards();
    for (const f of field) {
      for (const id of [f.leader, ...Object.keys(f.cards)]) {
        if (!cards[id]) {
          cards[id] = {
            id, name: `${id} (unknown)`, category: 'Character', colors: ['Black'],
            cost: 4, power: 5000, counter: 1000, effect: '-', trigger: null, types: [],
          };
        }
      }
    }

    sim = { running: true, rows: [], done: 0, total: field.length, games };
    refresh();

    const me = { leader: app.deck.leader, cards: { ...app.deck.cards } };
    let i = 0;
    const step = () => {
      if (i >= field.length) {
        sim.running = false;
        refresh();
        toast(`Simulated ${field.length * games} games.`, 'good');
        return;
      }
      const opp = field[i++];
      const r = runMatchup({ deck: me, opponent: opp, cards, games, seed: 1, skill: SKILL.solid });
      sim.rows.push({ name: opp.name, share: opp.share, ...r });
      sim.done = i;
      refresh();
      setTimeout(step, 0);
    };
    setTimeout(step, 0);
  }

  /* ------------------------------------------------------------------ */
  /* assembly                                                            */
  /* ------------------------------------------------------------------ */

  els.tabs = h('div.tabs', { style: { marginLeft: '0' } },
    TABS.map(([k, label]) => h('button', {
      'aria-selected': String(tab === k),
      onclick: () => { tab = k; refresh(); },
    }, label)));

  els.body = h('div');

  function refresh() {
    fill(els.tabs, TABS.map(([k, label]) => h('button', {
      'aria-selected': String(tab === k),
      onclick: () => { tab = k; refresh(); },
    }, label)));
    fill(els.body,
      tab === 'templates' ? renderTemplates()
        : tab === 'advisor' ? renderAdvisor()
          : renderMatchups());
  }

  const root = h('div.view', { id: 'view-meta' },
    h('main.pane', { style: { maxWidth: '1180px', margin: '0 auto' } },
      h('div.pane-title', { style: { justifyContent: 'space-between' } },
        h('h2', 'Meta'),
        els.tabs,
      ),
      els.body,
    ),
  );

  return {
    root,
    render() { refresh(); },
    onDeckChange() { if (tab !== 'templates') refresh(); },
  };
}
