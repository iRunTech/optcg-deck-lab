/* Parsers for onepiece.limitlesstcg.com.
 *
 * The pages we need are attribute-driven (data-id / data-count / href), which is
 * far more stable than scraping presentational classes. Every parser throws when
 * it finds nothing, so a markup change surfaces as a loud failure on the next
 * run instead of silently producing an empty meta snapshot.
 */
import { fetchText, HOUR, FOREVER } from './http.mjs';

export const BASE = 'https://onepiece.limitlesstcg.com';

const decode = s => String(s)
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ')
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .trim();

const strip = s => decode(String(s).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' '));

function need(list, what, url) {
  if (!list.length) {
    throw new Error(
      `Parsed 0 ${what} from ${url}.\n` +
      `Limitless probably changed its markup — update scripts/lib/limitless.mjs before trusting this snapshot.`
    );
  }
  return list;
}

/* ---------------------------------------------------------------------- */
/* Formats                                                                 */
/* ---------------------------------------------------------------------- */

/** Format codes currently offered on the deck index, newest first. */
export async function fetchFormats() {
  const url = `${BASE}/decks`;
  const html = await fetchText(url, { ttl: 6 * HOUR });
  const codes = [...html.matchAll(/data-value="([A-Z]{2,3}\d{2})"/g)].map(m => m[1]);
  return need([...new Set(codes)], 'format codes', url);
}

/* ---------------------------------------------------------------------- */
/* Archetype index:  /decks?format=OP16                                    */
/* ---------------------------------------------------------------------- */

/**
 * Rows of the archetype table: deck id, display name, leader card id, points
 * and meta share. `points` is Limitless's own weighting of tournament finishes,
 * not a decklist count — we count lists ourselves in fetchArchetypeResults.
 */
export async function fetchArchetypes(format) {
  const url = `${BASE}/decks?format=${encodeURIComponent(format)}`;
  const html = await fetchText(url, { ttl: 6 * HOUR });

  const out = [];
  // Each row: leader art (carries the leader's card id) … deck link … points … share
  const rowRe = /<tr>([\s\S]*?)<\/tr>/g;
  for (const [, row] of html.matchAll(rowRe)) {
    const link = row.match(/<a class="deck-link" href="\/decks\/(\d+)">([\s\S]*?)<\/a>/);
    if (!link) continue;

    const leader = row.match(/one-piece\/[A-Z0-9]+\/([A-Z0-9]+-\d+)_/);
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m => strip(m[1]));
    const share = cells.find(c => /^\d+(\.\d+)?%$/.test(c));
    const points = cells.filter(c => /^\d+$/.test(c)).pop();

    // "Green/Blue" + "Luffy" arrive as two spans; join them into one name.
    const name = strip(link[2]);

    out.push({
      id: +link[1],
      name,
      leader: leader ? leader[1] : null,
      points: points ? +points : null,
      share: share ? +share.slice(0, -1) / 100 : null,
    });
  }
  return need(out, 'archetypes', url);
}

/* ---------------------------------------------------------------------- */
/* Archetype results:  /decks/{id}/results?format=OP16                     */
/* ---------------------------------------------------------------------- */

/** Every published decklist for one archetype in one format, with placement. */
export async function fetchArchetypeResults(deckId, format) {
  const url = `${BASE}/decks/${deckId}/results?format=${encodeURIComponent(format)}`;
  const html = await fetchText(url, { ttl: 6 * HOUR });

  const out = [];
  let event = null;

  for (const [, row] of html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
    // Sub-heading rows switch the tournament context for the rows beneath them.
    const heading = row.match(/class="sub-heading"[\s\S]*?<a href="\/tournaments\/(\d+)">([\s\S]*?)<\/a>/);
    if (heading) {
      const label = strip(heading[2]);
      const split = label.match(/^(.*?\d{4})\s*-\s*(.*)$/);
      event = {
        tournamentId: +heading[1],
        date: split ? isoDate(split[1]) : null,
        tournament: split ? split[2] : label,
      };
      continue;
    }

    const list = row.match(/href="\/decks\/list\/(\d+)"/);
    if (!list) continue;
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m => m[1]);
    if (cells.length < 3) continue;

    out.push({
      listId: +list[1],
      format: strip(cells[0]) || format,
      placing: strip(cells[1]) || null,
      place: placeNumber(strip(cells[1])),
      player: strip(cells[2]) || null,
      ...event,
    });
  }
  return out; // legitimately empty for an archetype with no lists in this format
}

const placeNumber = s => {
  const m = /^(\d+)/.exec(s || '');
  return m ? +m[1] : null;
};

/** "26th July 2026" -> "2026-07-26" */
function isoDate(s) {
  const m = /(\d{1,2})\w*\s+([A-Za-z]+)\s+(\d{4})/.exec(s);
  if (!m) return null;
  const month = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
    .indexOf(m[2].slice(0, 3).toLowerCase());
  if (month < 0) return null;
  return `${m[3]}-${String(month + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

/* ---------------------------------------------------------------------- */
/* Decklist:  /decks/list/{id}                                             */
/* ---------------------------------------------------------------------- */

/**
 * One published list: `{ leader, cards: { cardId: count } }`.
 * Published lists never change, so these cache indefinitely.
 */
export async function fetchDecklist(listId) {
  const url = `${BASE}/decks/list/${listId}`;
  const html = await fetchText(url, { ttl: FOREVER });

  // Only the first `.decklist` block is the list itself; later blocks on some
  // pages are unrelated (price widgets, related lists).
  const main = html.slice(html.indexOf('<div class="decklist"'));

  let leader = null;
  const cards = {};

  // Column headings tell us which section each card belongs to.
  const sections = [...main.matchAll(
    /<div class="decklist-column-heading">([^<]*)<\/div>([\s\S]*?)(?=<div class="decklist-column-heading">|<\/div>\s*<\/div>\s*<\/div>|$)/g
  )];

  for (const [, headingRaw, body] of sections) {
    const heading = strip(headingRaw);
    const isLeader = /^leader/i.test(heading);
    for (const [, count, id] of body.matchAll(/data-count="(\d+)"\s+data-id="([A-Za-z0-9-]+)"/g)) {
      if (isLeader) leader = id;
      else cards[id] = (cards[id] || 0) + +count;
    }
  }

  if (!leader) throw new Error(`No leader parsed from ${url} — markup may have changed.`);
  const total = Object.values(cards).reduce((a, b) => a + b, 0);
  if (total === 0) throw new Error(`No main-deck cards parsed from ${url} — markup may have changed.`);

  const title = strip((main.match(/<div class="decklist-title">([\s\S]*?)<a/) || [, ''])[1]);

  return { listId, leader, cards, total, title: title || null, url };
}
