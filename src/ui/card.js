/* The card tile — the design's core visual object.
 *
 * The mockup drew cards as tinted, striped placeholders because it had no card
 * data. That placeholder is exactly the fallback the app needs when a printing's
 * art isn't hosted anywhere, so it stays: real art layers on top and the
 * designed face shows through if every candidate URL fails.
 */

import { h } from './dom.js';
import { imageSources } from '../data/cards.js';
import { keywords } from '../engine/cardtext.js';
import { attachPreview } from './preview.js';

const TYPE_SHORT = { Character: 'CHAR', Event: 'EVENT', Stage: 'STAGE', Leader: 'LEADER' };

/* Some Events genuinely have no printed cost — they're paid for by an
 * alternative cost in their text ("DON!! −1:", "You may trash 1 card:").
 * Showing 0 would claim they are free, which is the opposite of true. */
export const costLabel = c => (c?.cost == null ? '—' : String(c.cost));
export const costTitle = c => (c?.cost == null
  ? 'No printed cost — paid by the activation cost in the card text'
  : `Cost ${c.cost}`);

/** Primary colour of a card, used for the tint, stripe and border. */
export function cardColor(c) {
  const first = (c?.colors || [])[0] || 'Black';
  return String(first).toLowerCase();
}

/** CSS custom properties that skin a tile in the card's colour. */
export function cardVars(c, { stripeAlpha = 0.16, borderAlpha = 0.3 } = {}) {
  const k = cardColor(c);
  const hue = `var(--c-${k})`;
  return {
    '--cbg': `linear-gradient(165deg, var(--t-${k}), #111420)`,
    '--cstripe': `repeating-linear-gradient(45deg, color-mix(in srgb, ${hue} ${stripeAlpha * 100}%, transparent) 0 7px, transparent 7px 14px)`,
    '--cbd': `color-mix(in srgb, ${hue} ${borderAlpha * 100}%, transparent)`,
    '--chover': hue,
  };
}

/** Attach art with a fallback chain; on total failure the designed face shows. */
function artwork(c) {
  const sources = imageSources(c);
  if (!sources.length) return null;
  const img = h('img', { alt: '', loading: 'lazy', src: sources[0] });
  let i = 0;
  img.addEventListener('error', () => {
    i += 1;
    if (i < sources.length) img.src = sources[i];
    else img.remove();          // designed face underneath becomes visible
  });
  return img;
}

/**
 * @param {object} card  card record
 * @param {object} opts
 *   art        show real artwork (default true)
 *   count      badge in the footer, e.g. copies in deck
 *   power      override the footer power text
 *   pips       number of attached DON!! dots
 *   badge      small top-right label; defaults to the card type
 *   rested/selected/attacking/target/illegal  state classes
 *   onClick / onContextMenu
 *   as         'button' (default) or 'div'
 */
export function cardTile(card, opts = {}) {
  const {
    art = true, count = null, power, pips = 0, badge,
    rested = false, selected = false, attacking = false, target = false,
    illegal = false, hoverable = true, onClick, onContextMenu, title,
    as = onClick ? 'button' : 'div',
  } = opts;

  if (!card) {
    return h('div.slot-empty', opts.emptyLabel ?? '');
  }

  const kw = keywords(card);
  const classes = [
    'card',
    hoverable && onClick ? 'is-hoverable' : '',
    rested ? 'is-rested' : '',
    selected ? 'is-selected' : '',
    attacking ? 'is-attacking' : '',
    target ? 'is-target' : '',
    illegal ? 'is-illegal' : '',
    as === 'button' ? 'card-btn' : '',
  ].filter(Boolean).join(' ');

  const powerText = power != null ? power : (card.power != null ? card.power.toLocaleString() : '—');

  const el = h(as, {
    class: classes,
    style: cardVars(card),
    /* Skip the native tooltip when the hover panel is doing the job — two
     * tooltips fighting over the same element reads as a bug. */
    title: title ?? (opts.preview === false ? `${card.name} (${card.id})` : null),
    type: as === 'button' ? 'button' : null,
    onclick: onClick,
    oncontextmenu: onContextMenu,
    'aria-label': `${card.name}, ${card.category}, cost ${costLabel(card)}, power ${powerText}`,
  },
    // designed fallback face, always present, sits behind the art
    h('div.face',
      h('div.cid', card.id),
      h('div.cname', card.name),
      kw.blocker ? h('div.csub', { style: { color: 'var(--tx-3)' } }, 'BLOCKER') : null,
    ),
    art ? artwork(card) : null,
    card.category !== 'Leader' ? h('div.cost', { title: costTitle(card) }, costLabel(card)) : null,
    badge !== null ? h('div.badge', badge ?? TYPE_SHORT[card.category] ?? '') : null,
    h('div.foot',
      h('span', powerText),
      pips > 0
        ? h('div.pips', Array.from({ length: Math.min(pips, 8) }, () => h('i')))
        : (count != null ? h('span', { style: { font: '600 9px/1 var(--mono)', color: count ? 'var(--accent-soft)' : 'var(--tx-6)' } }, count ? `${count} in deck` : '') : null),
    ),
  );

  if (rested) el.setAttribute('aria-disabled', 'true');
  // Tiles are too small to read; hovering raises the full card.
  if (opts.preview !== false) attachPreview(el, card);
  return el;
}

/** Compact hover/inspect summary used by the rails. */
export function cardSummary(card) {
  if (!card) return null;
  return h('div',
    h('div', { style: { font: '600 13px/1.25 var(--font)', marginBottom: '3px' } }, card.name),
    h('div', { style: { font: '500 9.5px/1 var(--mono)', color: 'var(--tx-4)', marginBottom: '9px' } },
      `${card.id} · ${card.category}`),
    h('div', { style: { display: 'flex', gap: '6px', marginBottom: '10px' } },
      statTile('COST', costLabel(card), 'var(--don)'),
      statTile('POWER', card.power != null ? card.power.toLocaleString() : '—', 'var(--tx)'),
      card.counter ? statTile('COUNTER', card.counter.toLocaleString(), 'var(--accent-soft)') : null,
    ),
    card.effect && card.effect !== '-'
      ? h('div', { style: { font: '400 10.5px/1.5 var(--font)', color: 'var(--tx-3)', whiteSpace: 'pre-wrap' } },
        String(card.effect).replace(/<br>/g, '\n'))
      : null,
    card.trigger
      ? h('div', { style: { font: '400 10px/1.5 var(--font)', color: 'var(--don)', marginTop: '7px', whiteSpace: 'pre-wrap' } },
        String(card.trigger).replace(/<br>/g, '\n'))
      : null,
  );
}

function statTile(label, value, color) {
  return h('div', {
    style: {
      flex: '1', textAlign: 'center', padding: '7px 0',
      borderRadius: '6px', background: 'rgba(255,255,255,.035)',
    },
  },
    h('div', { style: { font: '700 15px/1 var(--mono)', color } }, String(value)),
    h('div', { style: { font: '500 8.5px/1 var(--mono)', color: 'var(--tx-4)', letterSpacing: '.1em', marginTop: '4px' } }, label),
  );
}
