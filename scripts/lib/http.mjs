/* Polite, cached HTTP for the Limitless crawl.
 *
 * Limitless is a free fan-run site. This module keeps the crawl light:
 * a small concurrency cap, a delay between requests, and an on-disk cache so
 * re-runs only fetch what's genuinely new. Decklists never change once
 * published, so they cache forever; index pages get a short TTL.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const UA = 'optcg-deck-lab/0.1 (+https://github.com/iRunTech/optcg-deck-lab) weekly meta snapshot';

export const HOUR = 3600_000;
export const FOREVER = Infinity;

let cacheDir = '.cache';
export function setCacheDir(d) { cacheDir = d; }

/* --refresh busts the short-lived index pages. Published decklists are
 * immutable, so their FOREVER cache entries stay valid regardless. */
let forceRefresh = false;
export function setRefresh(v) { forceRefresh = !!v; }

/* --- concurrency gate ------------------------------------------------- */
const MAX_CONCURRENT = 4;
const MIN_GAP_MS = 150;
let active = 0;
let lastStart = 0;
const waiting = [];

function acquire() {
  return new Promise(resolve => {
    waiting.push(resolve);
    drain();
  });
}
function release() {
  active--;
  drain();
}
function drain() {
  while (active < MAX_CONCURRENT && waiting.length) {
    const resolve = waiting.shift();
    active++;
    const wait = Math.max(0, lastStart + MIN_GAP_MS - Date.now());
    lastStart = Date.now() + wait;
    setTimeout(resolve, wait);
  }
}

/* --- cache ------------------------------------------------------------ */
function cachePath(url) {
  return join(cacheDir, createHash('sha256').update(url).digest('hex').slice(0, 32) + '.html');
}

async function readCache(url, ttl) {
  if (ttl <= 0) return null;
  if (forceRefresh && ttl !== FOREVER) return null;
  const p = cachePath(url);
  try {
    if (ttl !== FOREVER) {
      const age = Date.now() - (await stat(p)).mtimeMs;
      if (age > ttl) return null;
    }
    return await readFile(p, 'utf8');
  } catch {
    return null;
  }
}

export const stats = { fetched: 0, cached: 0 };

/* --- fetch ------------------------------------------------------------ */
export async function fetchText(url, { ttl = 6 * HOUR, attempts = 4 } = {}) {
  const hit = await readCache(url, ttl);
  if (hit != null) { stats.cached++; return hit; }

  await acquire();
  try {
    for (let attempt = 1; ; attempt++) {
      let res;
      try {
        res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html' } });
      } catch (err) {
        if (attempt >= attempts) throw new Error(`${url}: ${err.message}`);
        await sleep(backoff(attempt));
        continue;
      }

      // 429/5xx are worth waiting out; 4xx means we asked for the wrong thing.
      if (res.status === 429 || res.status >= 500) {
        if (attempt >= attempts) throw new Error(`${url}: HTTP ${res.status} after ${attempts} attempts`);
        const retryAfter = Number(res.headers.get('retry-after')) * 1000;
        await sleep(retryAfter > 0 ? retryAfter : backoff(attempt));
        continue;
      }
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);

      const body = await res.text();
      await mkdir(cacheDir, { recursive: true });
      await writeFile(cachePath(url), body);
      stats.fetched++;
      return body;
    }
  } finally {
    release();
  }
}

export async function fetchJson(url, opts) {
  return JSON.parse(await fetchText(url, opts));
}

const backoff = attempt => Math.min(30_000, 1000 * 2 ** (attempt - 1));
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* Run tasks through a mapper with a progress callback. Concurrency is already
 * bounded inside fetchText, so this just keeps the queue fed and reports. */
export async function mapProgress(items, fn, onProgress) {
  const out = new Array(items.length);
  let done = 0;
  await Promise.all(items.map(async (item, i) => {
    out[i] = await fn(item, i);
    onProgress?.(++done, items.length);
  }));
  return out;
}
