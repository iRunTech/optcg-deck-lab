/* Hover preview — read the actual card.
 *
 * Card tiles in the grid are far too small to read printed text on, so hovering
 * one raises a large panel with the real card art plus the text transcribed
 * beside it. The transcription matters as much as the image: art can fail to
 * load, alt printings differ, and the text is selectable and screen-readable.
 *
 * One shared element for the whole app — attaching a node per tile would mean
 * thousands of them in the pool grid.
 */

import { h, fill } from './dom.js';
import { imageSources } from '../data/cards.js';
import { costLabel } from './card.js';
import { keywords, counterValue } from '../engine/cardtext.js';

const SHOW_DELAY = 90;     // brief, so sweeping across the grid doesn't strobe
const GAP = 18;            // clearance from the cursor

let tip = null;
let showTimer = null;
let current = null;

function ensureTip() {
  if (tip) return tip;
  tip = h('div#cardpreview', { role: 'tooltip', 'aria-hidden': 'true' });
  document.body.appendChild(tip);
  return tip;
}

function statChip(label, value, color) {
  return h('div.pv-stat',
    h('div.v', { style: { color } }, String(value)),
    h('div.k', label),
  );
}

function build(card) {
  const sources = imageSources(card);
  const kw = keywords(card);
  const ctr = counterValue(card);

  const img = h('img', { alt: '', src: sources[0] || '' });
  let i = 0;
  img.addEventListener('error', () => {
    i += 1;
    if (i < sources.length) img.src = sources[i];
    else img.replaceWith(h('div.pv-noart', 'art unavailable'));
  });

  const tags = [
    kw.blocker && 'Blocker',
    kw.rush && 'Rush',
    kw.rushChar && 'Rush: Character',
    kw.doubleAttack && 'Double Attack',
    kw.banish && 'Banish',
  ].filter(Boolean);

  const effect = String(card.effect || '').replace(/<br\s*\/?>/gi, '\n').trim();

  return [
    h('div.pv-art', sources.length ? img : h('div.pv-noart', 'art unavailable')),
    h('div.pv-body',
      h('div.pv-name', card.name),
      h('div.pv-meta',
        `${card.id} · ${card.category}`,
        (card.colors || []).length ? ` · ${card.colors.join('/')}` : '',
        (card.types || []).length ? ` · ${card.types.join(', ')}` : '',
      ),
      h('div.pv-stats',
        card.category !== 'Leader' ? statChip('COST', costLabel(card), 'var(--don)') : null,
        statChip(card.category === 'Leader' ? 'LIFE' : 'POWER',
          card.category === 'Leader' ? (card.cost ?? '—') : (card.power != null ? card.power.toLocaleString() : '—'),
          'var(--tx)'),
        ctr ? statChip('COUNTER', ctr.toLocaleString(), 'var(--accent-soft)') : null,
      ),
      tags.length ? h('div.pv-tags', tags.map(t => h('span.pv-tag', t))) : null,
      effect && effect !== '-'
        ? h('div.pv-text', effect)
        : h('div.pv-text.is-empty', 'No effect text.'),
      card.trigger
        ? h('div.pv-trigger', String(card.trigger).replace(/<br\s*\/?>/gi, '\n').trim())
        : null,
    ),
  ];
}

function place(x, y) {
  const el = ensureTip();
  const w = el.offsetWidth;
  const ht = el.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Prefer right of the cursor; flip left when it would overflow.
  let left = x + GAP;
  if (left + w > vw - 8) left = x - GAP - w;
  if (left < 8) left = Math.max(8, (vw - w) / 2);

  // Vertically centre on the cursor, then clamp into the viewport.
  let top = y - ht / 2;
  if (top + ht > vh - 8) top = vh - 8 - ht;
  if (top < 8) top = 8;

  /* Position with a transform rather than left/top: it skips layout on every
   * mousemove, and it can't be hijacked by a stray `transition-property: all`
   * turning each write into an animation that outranks the inline style. */
  el.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`;
}

export function showPreview(card, x, y) {
  if (!card) return;
  const el = ensureTip();
  if (current !== card.id) {
    current = card.id;
    fill(el, ...build(card));
  }
  el.classList.add('is-on');
  el.setAttribute('aria-hidden', 'false');
  place(x, y);
}

export function hidePreview() {
  clearTimeout(showTimer);
  current = null;
  if (!tip) return;
  tip.classList.remove('is-on');
  tip.setAttribute('aria-hidden', 'true');
}

/**
 * Wire hover/focus preview onto an element.
 * Safe to call on thousands of tiles: no per-element DOM is created.
 */
export function attachPreview(el, card) {
  if (!el || !card) return el;

  el.addEventListener('mouseenter', e => {
    clearTimeout(showTimer);
    const { clientX, clientY } = e;
    showTimer = setTimeout(() => showPreview(card, clientX, clientY), SHOW_DELAY);
  });
  el.addEventListener('mousemove', e => {
    if (tip?.classList.contains('is-on') && current === card.id) place(e.clientX, e.clientY);
  });
  el.addEventListener('mouseleave', hidePreview);

  // Keyboard parity — tiles are buttons, so focus should reveal the same detail.
  el.addEventListener('focus', () => {
    const r = el.getBoundingClientRect();
    showPreview(card, r.right, r.top + r.height / 2);
  });
  el.addEventListener('blur', hidePreview);

  return el;
}

// Any scroll invalidates the anchor point, so drop the panel rather than
// leaving it floating over unrelated content.
window.addEventListener('scroll', hidePreview, true);
window.addEventListener('keydown', e => { if (e.key === 'Escape') hidePreview(); });
