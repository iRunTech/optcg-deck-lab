#!/usr/bin/env node
/* Compare a deck against the meta snapshot and say what to change.
 *
 *   node scripts/suggest.mjs my-deck.txt
 *   node scripts/suggest.mjs my-deck.txt --archetype "Purple Enel"
 *   cat my-deck.txt | node scripts/suggest.mjs
 *
 * Deck format is the one Limitless and most sims export — one card per line:
 *   1xOP15-058      (leader)
 *   4xOP15-061
 *   3 OP05-077
 *
 * This is the command-line version of the analysis the Advisor tab should be
 * doing in the browser. Same data, same maths.
 */
import { readFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setCacheDir } from './lib/http.mjs';
import { loadCards, label } from './lib/cards.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DECK_SIZE = 50;

/* ---------------------------------------------------------------------- */
/* deck parsing                                                            */
/* ---------------------------------------------------------------------- */

/** Parse `4xOP15-061` / `4 OP15-061` / `OP15-061` lines into counts. */
export function parseDeck(text) {
  const cards = {};
  const order = [];
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#') || s.startsWith('//')) continue;
    const m = /^(?:(\d+)\s*[x×]?\s+|(\d+)\s*[x×])?([A-Z]{2,4}\d{2}-\d{3})\b/i.exec(s);
    if (!m) continue;
    const id = m[3].toUpperCase();
    const n = +(m[1] || m[2] || 1);
    if (!cards[id]) order.push(id);
    cards[id] = (cards[id] || 0) + n;
  }
  return { cards, order };
}

async function readInput(path) {
  if (path) return readFile(path, 'utf8');
  if (process.stdin.isTTY) {
    console.error('Pass a deck file, or pipe one in. See --help.');
    process.exit(1);
  }
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

/* ---------------------------------------------------------------------- */
/* formatting                                                              */
/* ---------------------------------------------------------------------- */
const pct = v => (v * 100).toFixed(1) + '%';
const heading = s => `\n${s}\n${'─'.repeat(s.length)}`;

/* ---------------------------------------------------------------------- */
/* main                                                                    */
/* ---------------------------------------------------------------------- */
async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(`Usage: node scripts/suggest.mjs [deck.txt] [--archetype <name>] [--meta <path>]

Compares a decklist against data/meta.json and reports the gaps.
Reads stdin when no file is given.`);
    return;
  }

  let deckPath = null, archetypeName = null, metaPath = join(ROOT, 'data', 'meta.json');
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--archetype') archetypeName = argv[++i];
    else if (argv[i] === '--meta') metaPath = resolve(argv[++i]);
    else deckPath = argv[i];
  }

  setCacheDir(join(ROOT, '.cache'));

  const meta = JSON.parse(await readFile(metaPath, 'utf8').catch(() => {
    throw new Error(`No meta snapshot at ${metaPath}. Run: npm run meta`);
  }));
  const { cards: deck } = parseDeck(await readInput(deckPath));

  if (!Object.keys(deck).length) {
    console.error('No cards recognised in that deck. Expected lines like "4xOP15-061".');
    process.exit(1);
  }

  const cardDb = await loadCards();
  const nm = id => label(cardDb, id);

  // The leader is whichever entry is a Leader card; fall back to any id that
  // matches an archetype leader, so a list without a tagged leader still works.
  let leader = Object.keys(deck).find(id => cardDb[id]?.category === 'Leader')
    || Object.keys(deck).find(id => meta.archetypes.some(a => a.leader === id));

  const arch = archetypeName
    ? meta.archetypes.find(a => a.name.toLowerCase().includes(archetypeName.toLowerCase()))
    : meta.archetypes.find(a => a.leader === leader);

  if (!arch) {
    console.error(
      `No archetype in the ${meta.format} snapshot for leader ${leader ? nm(leader) : '(none found)'}.\n` +
      `Available: ${meta.archetypes.map(a => a.name).join(', ')}\n` +
      `Pick one explicitly with --archetype.`
    );
    process.exit(1);
  }

  // Main deck excludes the leader.
  const main = { ...deck };
  if (leader) delete main[leader];
  const total = Object.values(main).reduce((a, b) => a + b, 0);

  const stat = Object.fromEntries(arch.cards.map(c => [c.id, c]));
  /* Share of lists running at least n copies. Absent from the table means the
   * field never goes that high, which is itself the finding. */
  const rateFor = (id, n) => (n <= 0 ? 1 : stat[id]?.atLeast?.[n] ?? 0);

  console.log(`${arch.name} — ${meta.format} snapshot of ${arch.deckCount} published lists`);
  console.log(`Generated ${meta.generated.slice(0, 10)} · meta share ${arch.share != null ? pct(arch.share) : 'n/a'}`);
  console.log(`Your list: ${total}/${DECK_SIZE} cards${leader ? `, leader ${nm(leader)}` : ''}`);
  if (total !== DECK_SIZE) console.log(`  ! not a legal deck — must be exactly ${DECK_SIZE}`);

  /* One diff against the consensus 50 drives everything below. Because the
   * consensus is exactly 50 cards, a legal deck's additions and cuts balance —
   * the output is a swap package, not two unrelated wish-lists. */
  const ids = new Set([...Object.keys(main), ...Object.keys(arch.consensus)]);
  const diff = [...ids].map(id => {
    const have = main[id] || 0;
    const want = arch.consensus[id] || 0;
    return {
      id, have, want,
      delta: want - have,
      // How unusual your own count is: the share of lists running at least
      // as many as you do. Near zero means you are an outlier.
      yourShare: rateFor(id, have),
      wantShare: rateFor(id, want),
      isCore: (arch.core[id] || 0) >= want && want > 0,
      include: stat[id]?.include ?? 0,
      avg: stat[id]?.avg ?? 0,
    };
  });

  const adds = diff.filter(x => x.delta > 0).sort((a, b) => b.wantShare - a.wantShare || b.delta - a.delta);
  const cuts = diff.filter(x => x.delta < 0).sort((a, b) => a.yourShare - b.yourShare || b.have - a.have);

  if (adds.length) {
    const core = adds.filter(x => x.isCore);
    const rest = adds.filter(x => !x.isCore);
    if (core.length) {
      console.log(heading('Add — staples you are short of'));
      console.log('At 90%+ of lists. Running fewer is a deliberate deviation.');
      for (const x of core) {
        console.log(`  +${x.delta}  ${nm(x.id).padEnd(34)} you ${x.have} → ${x.want}   ${pct(x.wantShare)} of lists run ${x.want}+`);
      }
    }
    if (rest.length) {
      console.log(heading('Add — contested slots leaning your way'));
      for (const x of rest) {
        console.log(`  +${x.delta}  ${nm(x.id).padEnd(34)} you ${x.have} → ${x.want}   ${pct(x.wantShare)} of lists run ${x.want}+`);
      }
    }
  }

  if (cuts.length) {
    console.log(heading('Cut — where you are over the field'));
    for (const x of cuts) {
      // A card a third of the field plays isn't "wrong" just because the
      // consensus 50 gave its slot to something else — say so plainly.
      const note = x.include === 0
        ? 'no list in this sample runs it'
        : x.want === 0 && x.include >= 0.3
          ? `split — ${pct(x.include)} of lists run it (typically ${stat[x.id]?.modal}), but the consensus 50 spends the slot elsewhere`
          : x.yourShare === 0
            ? `nobody runs ${x.have}; ${pct(x.include)} run it at all, typically ${stat[x.id]?.modal}`
            : `only ${pct(x.yourShare)} of lists run ${x.have}+ (field average ${x.avg})`;
      console.log(`  ${x.have} → ${x.want}  ${nm(x.id).padEnd(34)} ${note}`);
    }
  }

  /* --- flex ---------------------------------------------------------- */
  const seen = new Set();
  const flex = arch.contenders.filter(c => {
    if (seen.has(c.id) || (main[c.id] || 0) >= c.copy) return false;
    seen.add(c.id);
    return true;
  });
  if (flex.length) {
    console.log(heading(`Flex options — the field is split here (${arch.flexSlots} of ${DECK_SIZE} slots)`));
    for (const c of flex) {
      console.log(
        `  ${String(c.copy).padStart(2)}x ${nm(c.id).padEnd(34)} ${pct(c.weight)} of lists run at least this many` +
        (c.inConsensus ? '  (in consensus 50)' : '')
      );
    }
  }

  /* --- net ----------------------------------------------------------- */
  const addN = adds.reduce((a, x) => a + x.delta, 0);
  const cutN = cuts.reduce((a, x) => a - x.delta, 0);
  if (addN || cutN) {
    console.log(heading('Net'));
    console.log(`  ${cutN} out, ${addN} in — ${total - cutN + addN} cards.`);
    if (addN !== cutN) {
      console.log(`  ! adds and cuts should balance on a ${DECK_SIZE}-card deck; yours is ${total}.`);
    }
  }

  console.log(`\nReference list: ${arch.topList.placing} · ${arch.topList.player ?? 'unknown'} · ${arch.topList.tournament ?? ''} ${arch.topList.date ?? ''}`);
  console.log(arch.topList.url);
}

/* Only run when invoked directly — matchups.mjs imports parseDeck from here. */
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error(err.message);
    process.exit(1);
  });
}
