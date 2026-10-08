/**
 * extractor.js — walks the live DOM and produces a privacy-safe,
 * structure-only descriptor list for the vision engine.
 *
 * What is collected per element (NO personal data beyond what is needed
 * for local redaction — and even that never leaves the device unless
 * redacted):
 *   { uid, role, rect, text/label (short), inputType, name, id,
 *     autocomplete, placeholder, ariaLabel, className, src?, alt?,
 *     interactive, value? }
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PVA = Object.assign(root.PVA || {}, { Extractor: api });
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'BR', 'HR', 'SVG', 'PATH', 'META', 'LINK', 'HEAD', 'TITLE', 'CANVAS']);

  let uidCounter = 1;

  function isVisible(el) {
    if (!el.getClientRects || !el.getClientRects().length) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
    return true;
  }

  function rectInViewport(el, vw, vh) {
    const r = el.getBoundingClientRect();
    const x = Math.max(0, Math.round(r.left));
    const y = Math.max(0, Math.round(r.top));
    const x2 = Math.min(vw, Math.round(r.right));
    const y2 = Math.min(vh, Math.round(r.bottom));
    if (x2 <= x || y2 <= y) return null;
    return { x, y, w: x2 - x, h: y2 - y };
  }

  function nearestLabel(el) {
    let l = el.labels && el.labels[0];
    if (!l && el.closest) l = el.closest('label');
    return l ? l.innerText.trim().slice(0, 80) : null;
  }

  function shortText(el, max) {
    const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
    return t ? t.slice(0, max || 120) : null;
  }

  function visibleTextNodes(el) {
    const out = [];
    el.childNodes.forEach(n => {
      if (n.nodeType === 3 && n.textContent.trim()) out.push(n.textContent);
    });
    return out;
  }

  /**
   * Extract the element descriptor list for the current viewport.
   * @param {object} opts { viewportW, viewportH, maxElements, attachNodes }
   */
  function extract(opts) {
    opts = opts || {};
    const doc = opts.doc || document;
    const win = opts.win || window;
    const vw = opts.viewportW || win.innerWidth;
    const vh = opts.viewportH || win.innerHeight;
    const maxElements = opts.maxElements || 500;
    const attachNodes = !!opts.attachNodes;
    const out = [];
    const nodes = doc.querySelectorAll('body *');
    const cap = Math.min(nodes.length, 2000);

    for (let i = 0; i < cap; i++) {
      const el = nodes[i];
      if (SKIP_TAGS.has(el.tagName)) continue;
      if (!isVisible(el)) continue;
      const rect = rectInViewport(el, vw, vh);
      if (!rect) continue;

      const tag = el.tagName.toLowerCase();
      const cs = (el.ownerDocument.defaultView || win).getComputedStyle(el);
      const interactive = !!el.closest && (el.closest('button, a, [role=button], input, select, textarea, label') || tag === 'button' || tag === 'a');

      let rec = null;
      const uid = uidCounter++;

      if (tag === 'input' || tag === 'textarea' || tag === 'select') {
        rec = {
          uid, role: tag === 'select' ? 'select' : 'textarea' === tag ? 'textarea' : 'input',
          rect,
          inputType: el.type || (tag === 'textarea' ? 'textarea' : 'text'),
          name: el.name || null, id: el.id || null,
          autocomplete: el.autocomplete || null,
          label: nearestLabel(el) || el.getAttribute('aria-label') || el.title || null,
          placeholder: el.placeholder || null,
          ariaLabel: el.getAttribute('aria-label') || null,
          className: String(el.className || '').slice(0, 60) || null,
          value: (el.value != null ? String(el.value) : null),
          text: tag === 'select' ? shortText(el, 60) : null,
          interactive: true,
        };
      } else if (tag === 'button' || (tag === 'a' && el.getAttribute('href'))) {
        const t = shortText(el, 60);
        if (!t && tag === 'a') continue;
        rec = { uid, role: tag === 'a' ? 'link' : 'button', rect, text: t, className: String(el.className || '').slice(0, 60) || null, interactive: true };
      } else if (tag === 'img') {
        rec = {
          uid, role: 'img', rect,
          src: (el.currentSrc || el.src || '').slice(0, 120) || null,
          alt: el.alt || null, id: el.id || null,
          className: String(el.className || '').slice(0, 60) || null,
          interactive: !!interactive,
        };
      } else {
        // generic element: only keep if it carries short visible text or
        // is a plain container used for structural context
        const t = shortText(el, 120);
        const hasText = t && visibleTextNodes(el).length > 0;
        if (!hasText && tag !== 'div' && tag !== 'section' && tag !== 'article' && tag !== 'main' && tag !== 'form' && tag !== 'td' && tag !== 'li') continue;
        if (!hasText && out.length > 200) continue; // don't flood with empty divs
        rec = { uid, role: 'element', rect, text: t, className: String(el.className || '').slice(0, 40) || null };
      }
      if (attachNodes) rec.node = el;
      out.push(rec);
      if (out.length >= maxElements) break;
    }

    // body text snapshot for content-level PII scanning (local only)
    let bodyText = null;
    try {
      const t = doc.body.innerText || '';
      bodyText = t.length <= 30000 ? t : t.slice(0, 30000);
    } catch (e) { /* cross-origin iframe noise — ignore */ }

    return { elements: out, bodyText, viewport: { w: vw, h: vh } };
  }

  return { extract, isVisible, rectInViewport, shortText, nearestLabel };
});
