# OPTCG Deck Lab

A single-file deck builder, playtester and AI opponent for the **One Piece Card Game**.

No install, no build step, no server. One HTML file that runs in any browser.

**▶ Live version:** https://iruntech.github.io/optcg-deck-lab/

---

## What it does

**Builder** — the full English card pool, searchable by name, effect text, type, colour, cost and set. Enforces the real deckbuilding rules: exactly 50 cards, max 4 copies of a card number (with an automatic exemption for cards that say "you may include any number"), and colour legality against your Leader. DON!! deck size is read from the Leader's card text, so Enel correctly gets 6 instead of 10.

**Play vs AI** — a genuine two-sided game. The engine runs turn structure, DON!! economy, attacking, blocking, the counter step, life cards and triggers. Six real top-placing tournament decks are built in as opponents, at three skill levels.

**Advisor** — checks your deck two ways: structural heuristics (counter density, curve shape, blockers, triggers, removal count) that apply to any list, then a card-by-card diff against a real top-placing list for your Leader.

**Goldfish** — solitaire draw/DON!! testing for opening hands and curve.

**Odds** — exact hypergeometric probabilities, not a simulation. Per-card and for custom combos.

**Share** — decks encode into the URL fragment, so you can send a friend a link and they open your exact list. Nothing is uploaded anywhere.

---

## How card effects work

Rather than hand-scripting individual cards, the engine **reads the printed card text** and matches common patterns — draw, K.O., power modification, resting, DON!! ramp. Those resolve automatically.

Anything the parser doesn't recognise pauses the game, shows you the text, and gives you shortcut buttons to apply it yourself.

That trade-off is deliberate. It means *every* deck is playable, including your own brews, instead of only a curated pool of scripted cards. Treat it as a practice tool for lines and race maths — not a rules authority.

**Not implemented:** Double Attack, Banish, Stage abilities, and "when this card is trashed" effects. They fall through to the manual prompt.

---

## Card data

Card data is fetched at runtime from the open-source [punk-records](https://github.com/buhbbl/punk-records) dataset (generated from Bandai's official card list) via the jsDelivr CDN. New sets appear automatically as that dataset updates — this file needs no maintenance to stay current.

Card images are loaded from public CDNs with a fallback chain, so a printing whose art isn't hosted anywhere shows a readable text tile rather than a blank.

**ST-31 to ST-36** (English release 31 July 2026) are hard-coded from the official English card text, because the upstream dataset hadn't picked them up yet. As soon as it does, the live data takes over automatically and the hard-coded copies are ignored.

---

## Setup

### Option A — just use the file

Download `index.html` and open it. That's it. It works from `file://`.

### Option B — GitHub Pages (recommended)

Hosting it gives you a URL you can open on any device, and makes share links work properly between you and your friends.

1. Create a new repository on GitHub (e.g. `optcg-deck-lab`). Make it **Public** — Pages requires that on free accounts.
2. Upload the files. On the empty repo page click **uploading an existing file**, then drag them in. No git install needed.
   **Important:** the main file must be named `index.html` for Pages to serve it at the root URL. Rename it during or after upload if needed.
3. Go to **Settings → Pages**. Under *Build and deployment*, set **Source: Deploy from a branch**, **Branch: `main`**, folder **`/ (root)`**. Save.
4. Wait a minute or two, then open `https://YOUR-USERNAME.github.io/YOUR-REPO/`.

### Moving decks between devices

Saved decks live in your browser's local storage, which is per-device. To move a deck, use **Share → Copy share link** and open that link on the other device — the whole deck travels in the URL.

---

## Repo contents

| File | Purpose |
|---|---|
| `index.html` | The entire app. Everything is in here. |
| `enel-upgrades-and-op16-meta.md` | Meta write-up and a Purple Enel upgrade analysis |
| `README.md` | This file |
| `LICENSE` | MIT |

---

## Licence and disclaimer

Code is MIT licensed — see `LICENSE`. Swap it for something else if you'd rather.

This is an unofficial fan project. The One Piece Card Game is © Bandai / Eiichiro Oda / Shueisha / Toei Animation. This project is not produced by, endorsed by, supported by or affiliated with any of them. It redistributes no card images and no card database; card data is fetched at runtime from a third-party open-source dataset. Please support the official release.
