/* Card database for the browser.
 *
 * Fetched at runtime from punk-records (generated from Bandai's official list)
 * so new sets appear without a release here. One entry per card NUMBER: the raw
 * dump lists every printing separately (OP15-061, OP15-061_p1, …) and those are
 * the same card for deckbuilding — the extra printings are also exactly where
 * the missing-art gaps came from, so base printings win.
 */

const CDN = 'https://cdn.jsdelivr.net/gh/buhbbl/punk-records@main/english';

export const COLORS = ['Red', 'Green', 'Blue', 'Purple', 'Black', 'Yellow'];
export const CATEGORIES = ['Leader', 'Character', 'Event', 'Stage'];

/** colour name -> CSS custom property suffix used by the design tokens */
export const colorVar = c => `--c-${String(c).toLowerCase()}`;
export const tintVar = c => `--t-${String(c).toLowerCase()}`;

/* One stable object for the lifetime of the page. Callers legitimately write
 * into it (the board stubs cards a decklist references but the dump lacks), so
 * handing back a fresh `{}` before load would silently discard those writes. */
const db = {};
let loaded = false;
let loading = null;

export function getCards() { return db; }
export function isLoaded() { return loaded; }

/** Seed the database directly — used by tests and by offline fixtures. */
export function setCards(entries) {
  Object.assign(db, entries);
  loaded = true;
  return db;
}

/**
 * @param {(done:number,total:number)=>void} [onProgress]
 * @returns {Promise<Record<string, object>>}
 */
export function loadCards(onProgress) {
  if (loaded) return Promise.resolve(db);
  if (loading) return loading;

  loading = (async () => {
    const packs = await fetch(`${CDN}/packs.json`).then(r => {
      if (!r.ok) throw new Error(`card index unavailable (HTTP ${r.status})`);
      return r.json();
    });
    const ids = Object.keys(packs);
    let done = 0;

    const sets = await Promise.all(ids.map(async id => {
      try {
        const r = await fetch(`${CDN}/data/${id}.json`);
        const j = r.ok ? await r.json() : [];
        onProgress?.(++done, ids.length);
        return j;
      } catch {
        onProgress?.(++done, ids.length);
        return [];
      }
    }));

    const raw = sets.flat();
    for (const c of raw) if (!c.id.includes('_') && !db[c.id]) db[c.id] = c;
    for (const c of raw) {
      const base = c.id.split('_')[0];
      if (!db[base]) db[base] = { ...c, id: base, _variant: c.id };
    }
    loaded = true;
    return db;
  })();

  return loading;
}

/* ---------------------------------------------------------------------- */
/* images                                                                  */
/* ---------------------------------------------------------------------- */

/**
 * Candidate art URLs, best first. Any single host 404s on some printing —
 * alt arts, promos, brand-new sets — so the tile walks this list on error and
 * falls back to the designed text face rather than showing a blank.
 */
export function imageSources(c) {
  if (!c) return [];
  const out = [];
  const set = String(c.id).split('-')[0];
  const push = u => { if (u && !out.includes(u)) out.push(u); };

  push(`https://limitlesstcg.nyc3.cdn.digitaloceanspaces.com/one-piece/${set}/${c.id}_EN.webp`);
  push(`https://limitlesstcg.nyc3.cdn.digitaloceanspaces.com/one-piece/${set}/${c.id}_JP.webp`);
  if (c._variant) {
    const vset = String(c._variant).split('-')[0];
    push(`https://limitlesstcg.nyc3.cdn.digitaloceanspaces.com/one-piece/${vset}/${c._variant}_EN.webp`);
  }
  push(c.img_full_url);
  return out;
}

/* ---------------------------------------------------------------------- */
/* queries                                                                 */
/* ---------------------------------------------------------------------- */

export const setCodeOf = id => String(id).split('-')[0];

/** Every set code present in the database, newest-looking first. */
export function allSets() {
  const s = new Set(Object.keys(getCards()).map(setCodeOf));
  return [...s].sort();
}

/** Does this card share a colour with the leader? */
export function matchesLeader(card, leader) {
  if (!leader) return true;
  const lc = leader.colors || [];
  return (card.colors || []).some(c => lc.includes(c));
}

/**
 * Filter the pool.
 * @param {{query,colors,cost,category,set,leader,legalOnly}} f
 */
export function searchCards(f = {}) {
  const q = (f.query || '').trim().toLowerCase();
  const colors = f.colors instanceof Set ? f.colors : new Set(f.colors || []);
  let list = Object.values(getCards());

  if (f.category) list = list.filter(c => c.category === f.category);
  if (f.set) list = list.filter(c => setCodeOf(c.id) === f.set);
  if (f.cost != null && f.cost !== '') {
    const n = +f.cost;
    list = list.filter(c => (n >= 10 ? (c.cost ?? 0) >= 10 : c.cost === n));
  }
  if (colors.size) list = list.filter(c => (c.colors || []).some(x => colors.has(x)));
  if (f.legalOnly && f.leader) {
    /* Once a Leader is chosen the job is filling 50 slots, so other Leaders are
     * noise — there are 136 of them and they were burying the whole pool.
     * They stay reachable through the Leader type filter or a direct search. */
    const browsingLeaders = f.category === 'Leader' || /leader/i.test(q);
    list = list.filter(c => (c.category === 'Leader'
      ? browsingLeaders || c.id === f.leader.id
      : matchesLeader(c, f.leader)));
  }
  if (q) {
    list = list.filter(c =>
      `${c.name} ${c.id} ${c.effect || ''} ${(c.types || []).join(' ')} ${c.trigger || ''}`
        .toLowerCase().includes(q));
  }

  // Leaders first only while you still need one; after that, cards come first.
  const leadersFirst = !f.leader;
  return list.sort((a, b) => {
    const al = a.category === 'Leader', bl = b.category === 'Leader';
    if (al !== bl) return (leadersFirst ? al : bl) ? -1 : 1;
    return a.id.localeCompare(b.id);
  });
}
