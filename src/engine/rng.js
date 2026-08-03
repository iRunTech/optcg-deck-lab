/* Seeded RNG.
 *
 * Every shuffle and every AI coin-flip draws from here, so a (deck, deck, seed)
 * triple always replays identically. That's what makes a bug reproducible and a
 * matchup win-rate meaningful rather than noise. Math.random() is never used in
 * the engine.
 */

/** mulberry32 — small, fast, good enough distribution for card shuffling. */
export function makeRng(seed = 1) {
  let a = seed >>> 0;
  const rng = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rng.seed = seed;
  return rng;
}

/** Integer in [0, n). */
export const randInt = (rng, n) => Math.floor(rng() * n);

/** Fisher-Yates, in place. */
export function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randInt(rng, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Turn any string into a usable 32-bit seed. */
export function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
