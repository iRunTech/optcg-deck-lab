/* Card database from punk-records, the same open dataset the browser app uses.
 *
 * One entry per card NUMBER: the raw dump lists every printing separately
 * (OP15-061, OP15-061_p1, …) and those are the same card for deckbuilding.
 * Base printings win; variants only fill numbers with no base entry.
 */
import { fetchJson, HOUR } from './http.mjs';

const CDN = 'https://cdn.jsdelivr.net/gh/buhbbl/punk-records@main/english';

let cache = null;

export async function loadCards() {
  if (cache) return cache;

  const packs = await fetchJson(`${CDN}/packs.json`, { ttl: 24 * HOUR });
  const sets = await Promise.all(
    Object.keys(packs).map(id =>
      fetchJson(`${CDN}/data/${id}.json`, { ttl: 24 * HOUR }).catch(() => []))
  );

  const byId = {};
  const raw = sets.flat();
  for (const c of raw) if (!c.id.includes('_') && !byId[c.id]) byId[c.id] = c;
  for (const c of raw) {
    const base = c.id.split('_')[0];
    if (!byId[base]) byId[base] = { ...c, id: base };
  }

  cache = byId;
  return byId;
}

/** Readable label for a card id, degrading gracefully when it isn't in the dump. */
export function label(cards, id) {
  const c = cards[id];
  return c ? `${c.name} (${id})` : id;
}
