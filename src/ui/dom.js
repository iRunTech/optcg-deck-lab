/* Minimal DOM helpers. No framework — the design is plain HTML/CSS and the app
 * is small enough that a hyperscript helper plus targeted re-renders is less
 * machinery than a runtime would be. */

/**
 * h('div.klass', { onclick }, child, child)
 * Tag supports `.class` and `#id` shorthand.
 */
export function h(tag, props, ...kids) {
  const [name, ...rest] = String(tag).split(/(?=[.#])/);
  const el = document.createElement(name || 'div');

  for (const token of rest) {
    if (token[0] === '.') el.classList.add(token.slice(1));
    else if (token[0] === '#') el.id = token.slice(1);
  }

  /* Distinguish a props object from a first child by SHAPE, not truthiness.
   * Testing `if (props && …)` silently swallowed falsy children — `h('div', 0)`
   * rendered nothing, which is how a cost of 0 vanished from card tiles. */
  const isProps = props != null
    && typeof props === 'object'
    && !(props instanceof Node)
    && !Array.isArray(props);
  if (!isProps) {
    kids.unshift(props);
    props = null;
  }

  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className += (el.className ? ' ' : '') + v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && k !== 'list' && typeof v !== 'boolean') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }

  add(el, kids);
  return el;
}

function add(el, kids) {
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.appendChild(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
}

export const frag = (...kids) => { const f = document.createDocumentFragment(); add(f, kids); return f; };

/** Replace an element's children in one shot. */
export function fill(el, ...kids) {
  if (!el) return el;
  el.textContent = '';
  add(el, kids);
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Batch DOM work into the next frame so a burst of state changes paints once. */
export function scheduler(fn) {
  let queued = false;
  return (...args) => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; fn(...args); });
  };
}

/* ---------------------------------------------------------------------- */
/* toasts                                                                  */
/* ---------------------------------------------------------------------- */

let toastHost = null;

export function toast(message, kind = '') {
  if (!toastHost) {
    toastHost = h('div#toasts');
    document.body.appendChild(toastHost);
  }
  const el = h('div.toast', { class: kind ? `is-${kind}` : '' }, message);
  toastHost.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .25s, transform .25s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(8px)';
    setTimeout(() => el.remove(), 260);
  }, 2200);
}

/* ---------------------------------------------------------------------- */
/* misc                                                                    */
/* ---------------------------------------------------------------------- */

export const fmt = n => Number(n || 0).toLocaleString();

/** Screen-reader announcements for state that is otherwise only visual. */
let liveRegion = null;
export function announce(msg) {
  if (!liveRegion) {
    liveRegion = h('div.sr-only', { role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(liveRegion);
  }
  liveRegion.textContent = msg;
}
