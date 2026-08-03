# OPTCG Deck Lab

Deck builder, meta analysis and playtesting for the **One Piece Card Game**.

Build a deck, see how it compares to what the field actually plays, and play it out against a meta opponent — or simulate a thousand games against the whole field in a couple of seconds.

---

## Quick start

```bash
npm start          # http://localhost:5173
```

No dependencies and no build step — ES modules straight to the browser. It does need to be *served* (ES modules and the `meta.json` fetch don't work from a `file://` URL), which is what `npm start` is for.

```bash
npm test           # engine, UI and boot-path tests
npm run meta       # refresh the meta snapshot from Limitless
npm run suggest -- my-deck.txt
npm run matchups -- --archetype "Purple Enel"
npm run coverage   # how much card text the engine understands
```

---

## The three screens

**Deck Builder** — the full English card pool, filterable by name, effect text, colour, cost, type and set. Enforces the real rules: exactly 50 cards, at most 4 copies of a card number (with the automatic exemption for cards that say "any number"), and colour legality against your Leader. Each pool card also shows what share of the field runs it.

**Meta** — three tabs:
- *Templates* — every archetype's consensus 50, loadable in one click, with its settled core and contested flex slots called out.
- *Advisor* — diffs your list against the field and produces a swap package with the evidence for each line ("87.6% of lists run 4+").
- *Matchups* — plays your deck against every archetype and reports win rates with confidence intervals, split by on-the-play and on-the-draw.

**Playtest** — a real two-sided game against a meta deck, running the same engine as the simulator. Explicit phase structure, DON!! economy, blockers, the counter step, life cards and triggers. Every log entry is clickable and explains the rule that just fired, with a beginner register you can switch off.

---

## Architecture

```
src/
  engine/        headless rules engine — no DOM, no timers, no globals
    rng.js         seeded RNG; every shuffle replays from the seed
    cardtext.js    printed card text -> structured effects (fallback layer)
    scripts.js     hand-written cards, keyed by id; wins over the parser
    engine.js      game state, turn structure, combat, effects
    ai.js          opponent policy (pure state -> action)
    sim.js         batch matchups, Wilson confidence intervals
  data/          card database, deck model, meta snapshot + advice
  ui/            views built on the design system
  styles/        design tokens, base, components
scripts/         meta pipeline and CLI tools
data/meta.json   generated meta snapshot (committed)
test/            engine, UI and boot-path tests
```

The engine is the load-bearing decision. It has no DOM, no `setTimeout` and no module-level mutable state, so the same code runs the interactive board *and* several thousand headless games per second. Every decision — targeting, blocking, countering, triggers, unrecognised card text — surfaces as a `pending` request that the caller answers with an action, so the human and the AI drive identical code paths and neither can skip a step the other has to take.

```js
const G = createGame({ p1, p2, cards, seed, firstPlayer });
while (!G.over) apply(G, G.pending ? answer(G.pending) : policy(G));
```

### How card effects work

Two layers.

**The text parser** (`cardtext.js`) reads printed card text and matches it to structured operations. This is what keeps *every* card in the game playable, including your own brews, rather than only a curated pool. It handles about 68% of the whole database on its own.

**Scripted cards** (`scripts.js`) are hand-written implementations keyed by card id, and they take precedence wherever they exist. Competitive cards use wording the parser can't reach — nested conditionals, "choose one", trash recursion, base-power replacement — and in a batch simulation those would silently degrade to vanilla bodies, biasing results toward decks with big stat lines.

Card play is heavily skewed, so this file stays small: **39 scripted cards give 100% coverage of every archetype in the current meta.** A new set typically adds 10–20 cards worth scripting.

```bash
npm run coverage            # per-archetype coverage, and what to script next
npm run coverage -- --misses
```

A script is declarative, so it reuses the engine's existing targeting, prompting and AI machinery:

```js
'OP14-111': {
  note: 'Perona — [On Play]/[On K.O.] up to 1 opposing Character cost 6 or less cannot attack…',
  onPlay: { ops: [{ op: 'flag', kind: 'cannotAttack', side: 'opp', maxCost: 6, scope: 'oppNextEnd' }] },
  onKO:   { ops: [{ op: 'flag', kind: 'cannotAttack', side: 'opp', maxCost: 6, scope: 'oppNextEnd' }] },
},
```

### Rules the engine models

Turn structure and DON!! economy, combat with the block and counter steps, Life and `[Trigger]`, summoning sickness with conditional `[Rush]` (read at the card's real `[DON!! xN]` threshold), `[Blocker]`, `[Unblockable]`, `[Double Attack]`, activated abilities on **both** Leaders and Characters, and continuous "static" buffs.

Static buffs are the subtle one. Text like `[DON!! x1] [Your Turn] All of your Characters gain +1000 power` is not an event — it applies whenever its condition holds, so power is computed on read rather than by pushing a modifier. The scope is parsed too: a buff restricted by card name, type, colour or base cost only reaches the bodies it names. Anything whose magnitude can't be evaluated (`if you have 5 or more…`, `for every 5 Events in your trash`) is **skipped rather than guessed**, because an understated board is safe and an overstated one is not.

Temporary states — `cannotAttack`, `cannotRest`, `wontRefresh`, granted keywords, base-power replacement, cost changes — expire by absolute turn number, so "until the end of your opponent's next End Phase" survives the turn boundary correctly.

**Still not modelled**, measured against real deck slots so the size is honest:

| Gap | Share of field |
|---|---|
| static "base power becomes N" (Holly) | 1.2% |
| `[On Your Opponent's Attack]` | 0.9% |
| effect negation | 0.7% |
| `[Banish]`, `[End of Turn]`, `[On Block]` | 0% — nothing in the current meta uses them |

Where a card's main consequence is a board-state change, the script applies that and says so in its note.

### Verifying the scripts

```bash
npm run audit        # cross-check every script against Bandai's printed text
```

Nobody publishes machine-executable OPTCG effects — every public API and open-source sim returns the effect as the same plain string we already have — so the scripts are hand-written, and the realistic failure is a transcription slip. The audit reads the numbers and verbs out of the card and compares them to what the script does. It found a real one on its first run: Mamaragan's counter is +1000, not the +2000 shared by the other three Enel events.

A finding is a prompt to re-read the card, not proof of a bug; a clean run is not proof of correctness.

### What the simulation numbers mean

The rules are now right for every meta card. What remains approximate is the *opponent*: both sides run one general-purpose AI, so a deck whose plan needs precise sequencing underperforms a deck of straightforward big bodies.

That bias is roughly constant for a given opponent, which makes the sound use an A/B one — run your list, change two cards, run it again against the same field and the same seed. The difference is real even when the absolute number is soft. Mirror matches land on 50% within confidence intervals, which is the check that the engine itself is symmetric.

---

## Meta data

`data/meta.json` is built from published tournament lists on [Limitless](https://onepiece.limitlesstcg.com).

```bash
npm run meta                            # newest format
node scripts/fetch-meta.mjs --format OP16
node scripts/fetch-meta.mjs --refresh   # ignore cached index pages
```

Published decklists never change, so they're cached on disk forever and a weekly re-run only downloads what's new. The crawl is deliberately gentle: 4 concurrent requests, spaced, with backoff on 429/5xx.

Per archetype the snapshot records:

| Field | Meaning |
|---|---|
| `cards[]` | per-card `include`, `avg`, `modal`, and `atLeast[n]` — the share of lists running *n or more* copies |
| `consensus` | a legal 50 built from the field's most-agreed-on slots |
| `core` / `coreSlots` | the subset at 90%+ of lists — the settled staples |
| `flexSlots` | how many of the 50 the field genuinely disagrees about |
| `contenders[]` | ranked candidates for those flex slots |
| `topList` | the best recent finish, in full |
| `lists[]` | every list in the sample, with placement and event |

`atLeast[n]` is the statistic that answers real deckbuilding questions. "87.6% of Enel lists run 4 Pudding" is actionable; "Pudding is popular" is not.

The consensus 50 is built by ranking every *(card, nth copy)* slot by the share of lists running at least that many, then taking the heaviest 50. Staples get their full playset, contested copies sort to the bottom, and the list comes out legal without special-casing — including cards that legally exceed 4 copies.

### A note on the source

Limitless is a free, fan-run site and this pipeline leans on it. Keep the crawl infrequent, keep the cache, and don't remove the rate limiting.

---

## CLI tools

```bash
node scripts/suggest.mjs my-deck.txt              # swap package vs the field
node scripts/matchups.mjs --archetype "Purple Enel" --games 400
node scripts/matchups.mjs --field                 # full round-robin
node scripts/coverage.mjs --misses                # cards needing scripting
```

Deck files use the usual export format — `4xOP15-061`, one card per line. Works with Limitless "Copy as Text" and most sim exports.

---

## Design

The interface comes from a [Claude Design](https://claude.ai/design) project, implemented here rather than approximated: Archivo + JetBrains Mono, a dark palette with per-colour card tints, and the card tile as the core visual object. `src/styles/tokens.css` names the values the design encoded literally.

Two of its ideas shaped the app beyond its looks: the explicit **phase stepper**, which makes the turn structure teachable instead of implicit, and **"Explain what just happened"**, which turns the game log into a rules tutor.

The design drew cards as tinted, striped placeholders because it had no card data. That placeholder is exactly the fallback needed when a printing's art isn't hosted anywhere, so it stays — real art layers on top and the designed face shows through if every candidate URL fails.

---

## Repo contents

| Path | Purpose |
|---|---|
| `index.html` | App shell |
| `src/` | Engine, data layer, UI, styles |
| `scripts/` | Meta pipeline, advisor, matchup and coverage CLIs |
| `data/meta.json` | Generated meta snapshot |
| `test/` | Engine, UI and boot-path tests |
| `legacy-poc.html` | The original single-file prototype, kept for reference |
| `enel-upgrades-and-op16-meta.md` | The hand-written analysis the advisor now automates |

---

## Licence and disclaimer

Code is MIT — see `LICENSE`.

Unofficial fan project. The One Piece Card Game is © Bandai / Eiichiro Oda / Shueisha / Toei Animation. Not produced by, endorsed by or affiliated with any of them. No card images or card database are redistributed; card data is fetched at runtime from a third-party open-source dataset. Please support the official release.
