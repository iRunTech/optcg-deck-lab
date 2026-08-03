#!/usr/bin/env node
/* Cross-check every scripted card against its printed text.
 *
 *   npm run audit
 *
 * No public source publishes machine-executable OPTCG effects, so the scripts
 * in src/engine/scripts.js are written by hand — which means the realistic
 * failure mode is a transcription slip: "draw 2" typed as draw 1, a cost
 * ceiling of 4 written as 6, a clause quietly forgotten.
 *
 * This reads the numbers and verbs out of Bandai's own text and compares them
 * to what the script actually does. It is deliberately conservative: it flags
 * things a human should look at rather than claiming to understand the card.
 * Clean output does not prove a script is right; a finding is usually a real
 * discrepancy worth two minutes.
 */
import { readFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setCacheDir } from './lib/http.mjs';
import { loadCards } from './lib/cards.mjs';
import { SCRIPTS } from '../src/engine/scripts.js';
import { normalize } from '../src/engine/cardtext.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
setCacheDir(join(ROOT, '.cache'));

const verbose = process.argv.includes('--verbose');
const cards = await loadCards();
const meta = JSON.parse(await readFile(join(ROOT, 'data', 'meta.json'), 'utf8')).archetypes;

/* Real-play weight, so findings are ranked by how much they matter. */
const weight = new Map();
for (const a of meta) for (const s of a.cards) weight.set(s.id, (weight.get(s.id) || 0) + s.avg * a.deckCount);

const allOps = entry => Object.entries(entry)
  .filter(([k]) => k !== 'note' && k !== 'unmetReason')
  .flatMap(([, clause]) => [
    ...(clause.ops || []),
    ...(clause.ops || []).flatMap(o => (o.modes || []).flatMap(m => m.ops || [])),
  ]);

const allCosts = entry => Object.entries(entry)
  .filter(([k]) => k !== 'note' && k !== 'unmetReason')
  .map(([, clause]) => clause.cost)
  .filter(Boolean);

/* Signals we can read reliably out of printed text, paired with the ops that
 * would satisfy them. Anything ambiguous is deliberately left out. */
const SIGNALS = [
  { re: /\bdraw (\d+) cards?/ig, name: 'draw', ops: ['draw'], amount: m => +m[1], field: 'n' },
  { re: /K\.?O\.?\s+up to (\d+)/ig, name: 'K.O.', ops: ['ko', 'koPowerAtMost'] },
  { re: /\brest up to (\d+) of your opponent/ig, name: 'rest', ops: ['rest', 'restDonOpp'] },
  { re: /gains? \+(\d[\d,]*) power/ig, name: 'power buff', ops: ['power', 'powerAll'], amount: m => num(m[1]), field: 'amount' },
  { re: /[-−–]\s?(\d[\d,]*) power/ig, name: 'power debuff', ops: ['power', 'powerAll'], amount: m => -num(m[1]), field: 'amount' },
  { re: /add up to (\d+) DON!!/ig, name: 'DON!! add', ops: ['donAdd'] },
  { re: /set up to (\d+) of your DON!! cards? as active/ig, name: 'DON!! activate', ops: ['donActive'] },
  { re: /give up to (\d+) rested DON!!/ig, name: 'DON!! give', ops: ['donGive'] },
  { re: /play up to (\d+)/ig, name: 'play from hand/trash', ops: ['playFree', 'playFromTrash'] },
  { re: /cannot attack/ig, name: 'attack lock', ops: ['flag'] },
  { re: /cannot be rested/ig, name: 'rest lock', ops: ['flag'] },
  { re: /will not become active/ig, name: 'refresh lock', ops: ['flag'] },
  { re: /bottom of the owner['’]?s deck/ig, name: 'bottom-deck', ops: ['bottomDeck'] },
  { re: /return up to (\d+) .*?to the owner['’]?s hand/ig, name: 'bounce to hand', ops: ['returnToHand', 'returnStage'] },
  { re: /base power becomes/ig, name: 'base power set', ops: ['basePower'] },
  { re: /gains? \+(\d+) cost/ig, name: 'cost change', ops: ['costMod'] },
  { re: /to the top of your Life cards/ig, name: 'Life gain', ops: ['lifeAdd', 'lifeFromTrash', 'lifeFromHand'] },
  { re: /deal (\d+) damage/ig, name: 'direct damage', ops: ['damage'] },
  { re: /choose one/ig, name: 'modal choice', ops: ['chooseOne'] },
  { re: /trash (\d+) cards? from (?:your opponent|their)/ig, name: 'opponent discard', ops: ['oppDiscard', 'discard'] },
];

const num = s => +String(s).replace(/,/g, '');

/* Costs the text states, which the script must charge. */
const COST_SIGNALS = [
  { re: /DON!!\s*[-−–]\s*(\d+)/i, key: 'don', label: 'DON!! -N' },
  { re: /trash (\d+) cards? from your hand/i, key: 'discard', label: 'trash N from hand' },
  { re: /rest (\d+) of your DON!! cards/i, key: 'restDon', label: 'rest N DON!!' },
  { re: /trash (\d+) cards? from the top of your deck/i, key: 'mill', label: 'mill N' },
];

const findings = [];
const add = (id, level, msg) => findings.push({ id, level, msg, w: weight.get(id) || 0 });

for (const [id, entry] of Object.entries(SCRIPTS)) {
  const card = cards[id];
  if (!card) { add(id, 'warn', 'not in the card database — cannot verify'); continue; }

  const text = normalize(card.effect) + '\n' + normalize(card.trigger);
  const ops = allOps(entry);
  const opNames = new Set(ops.map(o => o.op));
  const costs = allCosts(entry);

  // --- the note should match the real card ---
  if (entry.note && !entry.note.toLowerCase().includes(card.name.toLowerCase().slice(0, 6))
      && !entry.note.includes('[')) {
    add(id, 'info', `note may describe a different card (script note vs "${card.name}")`);
  }

  // --- effects present in the text but absent from the script ---
  for (const sig of SIGNALS) {
    sig.re.lastIndex = 0;
    const hits = [...text.matchAll(sig.re)];
    if (!hits.length) continue;
    if (!sig.ops.some(o => opNames.has(o))) {
      add(id, 'warn', `text mentions ${sig.name} but no ${sig.ops.join('/')} op is scripted`);
      continue;
    }
    // --- numeric mismatch ---
    if (sig.amount && sig.field) {
      const wanted = hits.map(h => sig.amount(h));
      const got = ops.filter(o => sig.ops.includes(o.op)).map(o => o[sig.field]);
      const unmatched = wanted.filter(w => !got.includes(w));
      if (unmatched.length && got.length) {
        add(id, 'error', `${sig.name}: text says ${wanted.join('/')}, script has ${got.join('/')}`);
      }
    }
  }

  /* Costs stated in the text but never charged.
   *
   * Bandai's grammar puts an activation cost BEFORE a colon and the payoff
   * after it, so "Draw 2 cards and trash 1 card from your hand" is an effect
   * while "You may trash 1 card from your hand: Draw 2" is a cost. Only the
   * pre-colon portion of each line counts, otherwise every card that discards
   * as part of its effect gets flagged. */
  const costText = text.split('\n')
    .map(line => (line.includes(':') ? line.slice(0, line.indexOf(':')) : ''))
    .join('\n');

  for (const cs of COST_SIGNALS) {
    const m = costText.match(cs.re);
    if (!m) continue;
    const charged = costs.some(c => c[cs.key] != null);
    if (!charged) {
      add(id, 'warn', `text states a cost (${cs.label}) that no clause charges`);
    } else {
      const want = +m[1];
      const gotVals = costs.map(c => c[cs.key]).filter(v => v != null);
      if (want && !gotVals.includes(want)) {
        add(id, 'error', `cost ${cs.label}: text says ${want}, script charges ${gotVals.join('/')}`);
      }
    }
  }

  // --- conditions stated in the text but not required ---
  const reqs = Object.entries(entry)
    .filter(([k]) => k !== 'note' && k !== 'unmetReason')
    .map(([, c]) => c.require).filter(Boolean);
  const hasReq = Object.keys(Object.assign({}, ...reqs)).length > 0;
  if (/if your Leader (?:is|has)/i.test(text) && !hasReq) {
    add(id, 'warn', 'text has a "If your Leader is/has …" condition that the script does not require');
  }
}

/* ---------------------------------------------------------------------- */

const order = { error: 0, warn: 1, info: 2 };
findings.sort((a, b) => order[a.level] - order[b.level] || b.w - a.w);

const counts = findings.reduce((m, f) => ({ ...m, [f.level]: (m[f.level] || 0) + 1 }), {});
console.log(`Script audit · ${Object.keys(SCRIPTS).length} scripted cards checked against printed text\n`);

if (!findings.length) {
  console.log('  No discrepancies found.');
} else {
  let last = null;
  for (const f of findings) {
    if (!verbose && f.level === 'info') continue;
    if (f.id !== last) {
      console.log(`\n  ${f.id}  ${cards[f.id]?.name ?? ''}${f.w ? `  (~${Math.round(f.w)} deck slots)` : ''}`);
      last = f.id;
    }
    const tag = f.level === 'error' ? 'MISMATCH' : f.level === 'warn' ? 'check   ' : 'note    ';
    console.log(`      ${tag}  ${f.msg}`);
  }
}

console.log(`\n  ${counts.error || 0} likely mismatches · ${counts.warn || 0} worth checking · ${counts.info || 0} notes`);
console.log('  A finding is a prompt to re-read the card, not proof of a bug — and a clean run is not proof of correctness.');
