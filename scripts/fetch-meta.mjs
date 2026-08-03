#!/usr/bin/env node
/* Build data/meta.json — the snapshot that drives templates, deck suggestions
 * and the simulator's opponent roster.
 *
 *   node scripts/fetch-meta.mjs                 # newest format
 *   node scripts/fetch-meta.mjs --format OP16
 *   node scripts/fetch-meta.mjs --refresh       # ignore cached index pages
 *
 * Published decklists are immutable and cached forever, so a weekly re-run only
 * downloads lists that appeared since the last one.
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setCacheDir, setRefresh, stats, mapProgress } from './lib/http.mjs';
import {
  fetchFormats, fetchArchetypes, fetchArchetypeResults, fetchDecklist, BASE,
} from './lib/limitless.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DECK_SIZE = 50;

/* Redraw in place on a terminal; fall back to occasional lines when the output
 * is piped to a file or a CI log. */
function progress(label) {
  return (done, total) => {
    if (process.stdout.isTTY) process.stdout.write(`\r  ${label} ${done}/${total}   `);
    else if (done === total || done % 50 === 0) console.log(`  ${label} ${done}/${total}`);
  };
}
const endProgress = () => { if (process.stdout.isTTY) process.stdout.write('\n'); };

/* ---------------------------------------------------------------------- */
/* args                                                                    */
/* ---------------------------------------------------------------------- */
function parseArgs(argv) {
  const o = { format: null, out: join(ROOT, 'data', 'meta.json'), minLists: 5, refresh: false, limit: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--format') o.format = argv[++i];
    else if (a === '--out') o.out = resolve(argv[++i]);
    else if (a === '--min-lists') o.minLists = +argv[++i];
    else if (a === '--limit') o.limit = +argv[++i];
    else if (a === '--refresh') o.refresh = true;
    else if (a === '--help' || a === '-h') { usage(); process.exit(0); }
    else { console.error(`Unknown argument: ${a}`); usage(); process.exit(1); }
  }
  return o;
}
function usage() {
  console.log(`Usage: node scripts/fetch-meta.mjs [options]

  --format <CODE>   format to snapshot (default: newest on Limitless, e.g. OP16)
  --out <path>      output file (default: data/meta.json)
  --min-lists <n>   skip archetypes with fewer published lists (default: 5)
  --limit <n>       only process the first n archetypes (for testing)
  --refresh         re-fetch index pages instead of using the cache
`);
}

/* ---------------------------------------------------------------------- */
/* aggregation                                                             */
/* ---------------------------------------------------------------------- */

/**
 * Per-card usage across every list of one archetype.
 *
 * `atLeast[k]` is the share of lists running k or more copies — that's the
 * statistic that actually answers "should I be running a 4th?", and it's what
 * Limitless shows in its own tooltips.
 */
function cardStats(lists) {
  const n = lists.length;
  const ids = new Set();
  lists.forEach(l => Object.keys(l.cards).forEach(id => ids.add(id)));

  return [...ids].map(id => {
    const counts = lists.map(l => l.cards[id] || 0);
    const present = counts.filter(c => c > 0);
    const maxCopies = Math.max(...counts);
    const atLeast = {};
    for (let k = 1; k <= maxCopies; k++) atLeast[k] = counts.filter(c => c >= k).length / n;

    // Modal count among lists that run it at all — "how many do people play".
    const freq = {};
    present.forEach(c => { freq[c] = (freq[c] || 0) + 1; });
    const modal = +Object.keys(freq).sort((a, b) => freq[b] - freq[a] || b - a)[0];

    return {
      id,
      lists: present.length,
      include: present.length / n,
      avg: round(counts.reduce((a, b) => a + b, 0) / n, 2),
      modal,
      atLeast: Object.fromEntries(Object.entries(atLeast).map(([k, v]) => [k, round(v, 4)])),
    };
  }).sort((a, b) => b.avg - a.avg || a.id.localeCompare(b.id));
}

/* A slot this common is a settled staple — cutting it is a real deviation.
 * Below it the field genuinely disagrees, which is what "flex" means. */
const CORE_THRESHOLD = 0.9;
/* Below this a card is fringe tech, not a flex option worth suggesting. */
const CONTENDER_THRESHOLD = 0.15;

/**
 * Build the archetype's consensus 50.
 *
 * Every (card, nth copy) pair is a slot weighted by the share of lists running
 * at least that many copies. Taking the 50 heaviest slots gives a legal list
 * that mirrors what the field actually plays: staples get their full playset,
 * and the disputed copies sort themselves to the bottom.
 *
 * The interesting output is the split. In practice ~30-40 slots sit above 90%
 * (nobody argues about those) and the rest are the deck's real decisions, which
 * is exactly what a builder wants pointed out.
 */
function consensusDeck(cards) {
  const slots = [];
  for (const c of cards) {
    for (const [k, weight] of Object.entries(c.atLeast)) {
      slots.push({ id: c.id, copy: +k, weight });
    }
  }
  slots.sort((a, b) => b.weight - a.weight || a.copy - b.copy || a.id.localeCompare(b.id));

  const chosen = slots.slice(0, DECK_SIZE);
  const deck = {};
  for (const s of chosen) deck[s.id] = (deck[s.id] || 0) + 1;

  const core = chosen.filter(s => s.weight >= CORE_THRESHOLD);
  const coreDeck = {};
  for (const s of core) coreDeck[s.id] = (coreDeck[s.id] || 0) + 1;

  // Everything still in play for the remaining slots: the disputed copies that
  // made the cut, plus the ones that just missed. Ranked, so the advisor can
  // say "the field is split between these".
  const contenders = [
    ...chosen.filter(s => s.weight < CORE_THRESHOLD).map(s => ({ ...s, inConsensus: true })),
    ...slots.slice(DECK_SIZE).filter(s => s.weight >= CONTENDER_THRESHOLD).map(s => ({ ...s, inConsensus: false })),
  ]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 24)
    .map(s => ({ id: s.id, copy: s.copy, weight: round(s.weight, 4), inConsensus: s.inConsensus }));

  return {
    deck,
    core: coreDeck,
    coreSlots: core.length,
    flexSlots: DECK_SIZE - core.length,
    contenders,
  };
}

const round = (v, p) => Number.isFinite(v) ? +v.toFixed(p) : v;

/* ---------------------------------------------------------------------- */
/* main                                                                    */
/* ---------------------------------------------------------------------- */
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  setCacheDir(join(ROOT, '.cache'));
  setRefresh(opts.refresh);

  const formats = await fetchFormats();
  const format = opts.format || formats[0];
  if (!formats.includes(format)) {
    console.warn(`! ${format} is not in Limitless's format list (${formats.join(', ')}) — continuing anyway.`);
  }
  console.log(`Format: ${format}`);

  let archetypes = await fetchArchetypes(format);
  if (opts.limit) archetypes = archetypes.slice(0, opts.limit);
  console.log(`Archetypes: ${archetypes.length}`);

  // 1. every published list id per archetype
  const results = await mapProgress(
    archetypes,
    a => fetchArchetypeResults(a.id, format),
    progress('results')
  );
  endProgress();

  // 2. the lists themselves — flat, so the concurrency gate keeps them moving
  const jobs = [];
  archetypes.forEach((a, i) => results[i].forEach(r => jobs.push({ archIndex: i, r })));
  console.log(`Decklists: ${jobs.length}`);

  const failures = [];
  const fetched = await mapProgress(
    jobs,
    async ({ archIndex, r }) => {
      try {
        return { archIndex, meta: r, list: await fetchDecklist(r.listId) };
      } catch (err) {
        failures.push(`${r.listId}: ${err.message}`);
        return null;
      }
    },
    progress('lists  ')
  );
  endProgress();

  // 3. aggregate
  const byArch = archetypes.map(() => []);
  for (const f of fetched) if (f) byArch[f.archIndex].push(f);

  const out = [];
  for (let i = 0; i < archetypes.length; i++) {
    const a = archetypes[i];
    const entries = byArch[i];
    if (entries.length < opts.minLists) continue;

    // Trust the lists over the index for the leader id: some archetypes cover
    // more than one printing of a leader, and the modal one is the real answer.
    const leaderFreq = {};
    entries.forEach(e => { leaderFreq[e.list.leader] = (leaderFreq[e.list.leader] || 0) + 1; });
    const leader = Object.keys(leaderFreq).sort((x, y) => leaderFreq[y] - leaderFreq[x])[0];

    // Ignore malformed lists so they can't skew the rates.
    const clean = entries.filter(e => e.list.total === DECK_SIZE);
    const skipped = entries.length - clean.length;
    if (clean.length < opts.minLists) continue;

    const cards = cardStats(clean.map(e => e.list));
    const { deck, core, coreSlots, flexSlots, contenders } = consensusDeck(cards);

    const ranked = [...clean].sort((x, y) =>
      (x.meta.place ?? 999) - (y.meta.place ?? 999) ||
      String(y.meta.date).localeCompare(String(x.meta.date))
    );
    const best = ranked[0];

    out.push({
      id: a.id,
      name: a.name,
      leader,
      leaderVariants: Object.keys(leaderFreq).filter(l => l !== leader),
      share: a.share,
      points: a.points,
      deckCount: clean.length,
      skippedLists: skipped,
      consensus: deck,
      core,
      coreSlots,
      flexSlots,
      contenders,
      cards,
      topList: {
        listId: best.list.listId,
        player: best.meta.player,
        placing: best.meta.placing,
        tournament: best.meta.tournament,
        date: best.meta.date,
        url: best.list.url,
        leader: best.list.leader,
        cards: best.list.cards,
      },
      lists: ranked.map(e => ({
        listId: e.list.listId,
        place: e.meta.place,
        placing: e.meta.placing,
        player: e.meta.player,
        tournament: e.meta.tournament,
        date: e.meta.date,
      })),
    });
  }

  out.sort((x, y) => (y.share ?? 0) - (x.share ?? 0) || y.deckCount - x.deckCount);

  const snapshot = {
    generated: new Date().toISOString(),
    format,
    source: BASE,
    sourceNote: 'Tournament data scraped from Limitless TCG, a free fan-run site. Card data comes separately from punk-records.',
    deckSize: DECK_SIZE,
    totalLists: out.reduce((a, b) => a + b.deckCount, 0),
    archetypes: out,
  };

  await mkdir(dirname(opts.out), { recursive: true });
  await writeFile(opts.out, JSON.stringify(snapshot, null, 2) + '\n');

  const kb = Math.round(JSON.stringify(snapshot).length / 1024);
  console.log(`\nWrote ${opts.out} — ${out.length} archetypes, ${snapshot.totalLists} lists, ${kb} KB`);
  console.log(`HTTP: ${stats.fetched} fetched, ${stats.cached} from cache`);
  if (failures.length) {
    console.warn(`\n! ${failures.length} decklist(s) failed and were excluded:`);
    failures.slice(0, 10).forEach(f => console.warn(`    ${f}`));
    if (failures.length > 10) console.warn(`    …and ${failures.length - 10} more`);
  }

  console.log('\nTop archetypes:');
  for (const a of out.slice(0, 10)) {
    console.log(
      `  ${String(Math.round((a.share ?? 0) * 1000) / 10).padStart(5)}%  ` +
      `${a.name.padEnd(26)} ${String(a.leader).padEnd(10)} ` +
      `${String(a.deckCount).padStart(4)} lists  ${a.flexSlots} flex`
    );
  }
}

main().catch(err => {
  console.error(`\n${err.stack || err.message}`);
  process.exit(1);
});
