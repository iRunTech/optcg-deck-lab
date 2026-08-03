#!/usr/bin/env node
/* Play a deck against the whole meta field and print the matchup table.
 *
 *   node scripts/matchups.mjs my-deck.txt
 *   node scripts/matchups.mjs --archetype "Purple Enel" --games 400
 *   node scripts/matchups.mjs --field            # every archetype vs every other
 *
 * Numbers come from the same engine the browser board runs, so a line here and
 * a game you play by hand follow identical rules.
 */
import { readFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setCacheDir } from './lib/http.mjs';
import { loadCards } from './lib/cards.mjs';
import { parseDeck } from './suggest.mjs';
import { runGauntlet, runMatchup } from '../src/engine/sim.js';
import { SKILL } from '../src/engine/ai.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pct = v => (v * 100).toFixed(1).padStart(5) + '%';

function parseArgs(argv) {
  const o = { deckPath: null, archetype: null, games: 200, seed: 1, skill: 'solid', field: false, meta: join(ROOT, 'data', 'meta.json') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--archetype') o.archetype = argv[++i];
    else if (a === '--games') o.games = +argv[++i];
    else if (a === '--seed') o.seed = +argv[++i];
    else if (a === '--skill') o.skill = argv[++i];
    else if (a === '--meta') o.meta = resolve(argv[++i]);
    else if (a === '--field') o.field = true;
    else if (a === '--help' || a === '-h') { o.help = true; }
    else o.deckPath = a;
  }
  return o;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(`Usage: node scripts/matchups.mjs [deck.txt] [options]

  --archetype <name>  play a meta archetype's consensus list instead of a file
  --field             full round-robin across every archetype
  --games <n>         games per matchup (default 200, split play/draw)
  --seed <n>          base seed (default 1) — same seed replays exactly
  --skill <casual|solid|sharp>
`);
    return;
  }

  setCacheDir(join(ROOT, '.cache'));
  const meta = JSON.parse(await readFile(opts.meta, 'utf8'));
  const cards = await loadCards();
  const skill = SKILL[opts.skill] ?? SKILL.solid;

  // Stub anything the card dump doesn't have so a missing printing can't abort
  // a run; it stands in as a vanilla body and is reported at the end.
  const missing = new Set();
  const ensure = deck => {
    for (const id of [deck.leader, ...Object.keys(deck.cards)]) {
      if (!cards[id]) {
        missing.add(id);
        cards[id] = {
          id, name: `${id} (unknown)`, category: id === deck.leader ? 'Leader' : 'Character',
          colors: ['Red'], cost: 4, power: 5000, counter: 1000, effect: '-', trigger: null, types: [],
        };
      }
    }
  };

  const field = meta.archetypes.map(a => ({
    key: a.id, name: a.name, leader: a.leader, cards: a.consensus, share: a.share,
  }));
  field.forEach(ensure);

  if (opts.field) {
    console.log(`Round-robin · ${meta.format} · ${opts.games} games per pair · seed ${opts.seed}\n`);
    const w = Math.max(...field.map(f => f.name.length));
    process.stdout.write(''.padEnd(w + 2));
    for (const f of field) process.stdout.write(f.name.slice(0, 6).padStart(8));
    process.stdout.write('    avg\n');
    for (const a of field) {
      process.stdout.write(a.name.padEnd(w + 2));
      let sum = 0, n = 0;
      for (const b of field) {
        if (a.key === b.key) { process.stdout.write('       —'); continue; }
        const r = runMatchup({ deck: a, opponent: b, cards, games: opts.games, seed: opts.seed, skill });
        sum += r.winRate; n++;
        process.stdout.write(pct(r.winRate).padStart(8));
      }
      process.stdout.write('   ' + pct(n ? sum / n : 0) + '\n');
    }
    if (missing.size) console.log(`\n! ${missing.size} card id(s) not in the card data, stubbed as vanilla bodies.`);
    return;
  }

  // Single deck vs the field.
  let deck;
  if (opts.archetype) {
    const a = meta.archetypes.find(x => x.name.toLowerCase().includes(opts.archetype.toLowerCase()));
    if (!a) { console.error(`No archetype matching "${opts.archetype}". Available: ${meta.archetypes.map(x => x.name).join(', ')}`); process.exit(1); }
    deck = { name: a.name, leader: a.leader, cards: a.consensus };
  } else if (opts.deckPath) {
    const { cards: parsed } = parseDeck(await readFile(opts.deckPath, 'utf8'));
    const leader = Object.keys(parsed).find(id => cards[id]?.category === 'Leader')
      || Object.keys(parsed).find(id => meta.archetypes.some(a => a.leader === id));
    if (!leader) { console.error('Could not identify a Leader in that deck file.'); process.exit(1); }
    const main = { ...parsed };
    delete main[leader];
    deck = { name: opts.deckPath, leader, cards: main };
  } else {
    console.error('Pass a deck file or --archetype. See --help.');
    process.exit(1);
  }
  ensure(deck);

  const total = Object.values(deck.cards).reduce((a, b) => a + b, 0);
  console.log(`${deck.name} — ${cards[deck.leader]?.name ?? deck.leader} · ${total} cards`);
  console.log(`${opts.games} games per matchup, alternating play/draw · skill ${opts.skill} · seed ${opts.seed}\n`);

  const t0 = Date.now();
  const g = runGauntlet({ deck, field, cards, games: opts.games, seed: opts.seed, skill });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  console.log('  matchup                       win%     95% CI        play    draw   share');
  console.log('  ' + '─'.repeat(74));
  for (const r of g.rows) {
    const ci = `${(r.ci95[0] * 100).toFixed(0)}–${(r.ci95[1] * 100).toFixed(0)}%`;
    console.log(
      '  ' + r.name.padEnd(26) +
      pct(r.winRate) + '   ' + ci.padStart(9) + '   ' +
      pct(r.onPlay) + '  ' + pct(r.onDraw) + '  ' +
      (r.share != null ? (r.share * 100).toFixed(1) + '%' : '   —').padStart(6)
    );
  }
  console.log('  ' + '─'.repeat(74));
  console.log(`  unweighted average        ${pct(g.overall)}`);
  console.log(`  weighted by meta share    ${pct(g.fieldWeighted)}   <- what you'd actually face`);
  console.log(`\n  ${g.rows.length * opts.games} games in ${secs}s`);
  if (missing.size) {
    console.log(`\n! ${missing.size} card id(s) missing from the card data, stubbed as vanilla 4-cost/5000 bodies:`);
    console.log('  ' + [...missing].join(', '));
  }
}

main().catch(err => { console.error(err.stack || err.message); process.exit(1); });
