#!/usr/bin/env node
/* How much of the meta's printed card text does the engine actually understand?
 *
 *   node scripts/coverage.mjs
 *   node scripts/coverage.mjs --misses      # list the specific cards to script
 *
 * This is the number that gates whether simulated win-rates mean anything. A
 * deck whose key cards fall through to the manual prompt plays as a pile of
 * vanilla bodies, so a matchup table built on low coverage measures stat lines
 * rather than strategy. Track it upward before trusting the simulator.
 */
import { readFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setCacheDir } from './lib/http.mjs';
import { loadCards } from './lib/cards.mjs';
import { parseEffects } from '../src/engine/cardtext.js';
import { SCRIPTS } from '../src/engine/scripts.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pct = (a, b) => b ? (a / b * 100).toFixed(0).padStart(3) + '%' : '  0%';

const showMisses = process.argv.includes('--misses');

setCacheDir(join(ROOT, '.cache'));
const cards = await loadCards();
const meta = JSON.parse(await readFile(join(ROOT, 'data', 'meta.json'), 'utf8'));

let gSlots = 0, gOk = 0, gVanilla = 0, gScripted = 0;
const gaps = new Map();     // cardId -> { name, slots, text }

console.log(`Effect coverage · ${meta.format} · ${meta.archetypes.length} archetypes\n`);
console.log('  archetype                  scripted  parsed  vanilla  unparsed   understood');
console.log('  ' + '─'.repeat(78));

for (const a of meta.archetypes) {
  let slots = 0, ok = 0, vanilla = 0, bad = 0, scripted = 0;
  for (const [id, n] of Object.entries(a.consensus)) {
    const c = cards[id];
    slots += n;
    if (!c) { bad += n; continue; }
    // A hand-written script overrides the parser, so the card is fully handled.
    if (SCRIPTS[id]) { scripted += n; continue; }
    const active = parseEffects(c).filter(e => e.when !== 'passive');
    if (!active.length) { vanilla += n; continue; }
    if (active.every(e => !e.unparsed)) { ok += n; continue; }
    bad += n;
    const prev = gaps.get(id) || { name: c.name, slots: 0, text: active.filter(e => e.unparsed).map(e => e.text)[0] };
    prev.slots += n;
    gaps.set(id, prev);
  }
  gSlots += slots; gOk += ok; gVanilla += vanilla; gScripted += scripted;
  // "Understood" counts vanilla bodies too — a card with no effect text needs none.
  console.log(
    '  ' + a.name.padEnd(26) +
    String(scripted).padStart(6) + String(ok).padStart(8) + String(vanilla).padStart(8) +
    String(bad).padStart(9) + '      ' + pct(scripted + ok + vanilla, slots)
  );
}

console.log('  ' + '─'.repeat(78));
console.log('  ' + 'all archetypes'.padEnd(26) +
  String(gScripted).padStart(6) + String(gOk).padStart(8) + String(gVanilla).padStart(8) +
  String(gSlots - gOk - gVanilla - gScripted).padStart(9) +
  '      ' + pct(gScripted + gOk + gVanilla, gSlots));
console.log(`\n  ${Object.keys(SCRIPTS).length} cards scripted by hand, covering ${gScripted} deck slots.`);

const ranked = [...gaps.entries()].sort((a, b) => b[1].slots - a[1].slots);
const top = ranked.slice(0, showMisses ? ranked.length : 12);

console.log(`\n${ranked.length} distinct cards fall through to the manual prompt.`);
console.log(`Scripting the top ${top.length} would cover ${top.reduce((s, [, v]) => s + v.slots, 0)} of ${gSlots - gOk - gVanilla} unparsed slots.\n`);
for (const [id, v] of top) {
  console.log(`  ${String(v.slots).padStart(2)} slots  ${id.padEnd(11)} ${v.name}`);
  if (showMisses) console.log(`            ${String(v.text || '').slice(0, 150)}`);
}
