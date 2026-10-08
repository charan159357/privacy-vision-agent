/**
 * renderer.js — a lightweight, dependency-free "html2canvas" style renderer
 * that draws the live page into a canvas. Runs 100% on-device; the canvas is
 * the only visual data that may (redacted) travel to the server.
 *
 * This is intentionally simple (flat backgrounds, text, images, form fields,
 * borders) — enough for accurate agent tasks on the bundled demo pages and
 * most real sites, at a fraction of html2canvas's weight. Swap in
 * html2canvas-pro for pixel-perfect captures if needed.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PVA = Object.assign(root.PVA || {}, { Renderer: api });
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'PATH', 'META', 'HEAD', 'TITLE', 'BR', 'HR', 'CANVAS']);

  function visible(el) {
    if (!el.getClientRects || !el.getClientRects().length) return false;
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';
  }

  /**
   * Render the current page into a canvas.
   * @param {HTMLCanvasElement} canvas target (pre-sized)
   * @param {object} opts { scale }
   */
  function render(canvas, opts) {
    opts = opts || {};
    const doc = opts.doc || document;
    const win = opts.win || window;
    const scale = opts.scale || 1;
    const vw = win.innerWidth, vh = win.innerHeight;
    const W = Math.max(2, Math.round(vw * scale)), H = Math.max(2, Math.round(vh * scale));
    if (canvas.width !== W) canvas.width = W;
    if (canvas.height !== H) canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.textBaseline = 'alphabetic';

    // background from body/html
    const bg = (doc.body.ownerDocument.defaultView || win).getComputedStyle(doc.body).backgroundColor;
    ctx.fillStyle = bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent' ? bg : '#ffffff';
    ctx.fillRect(0, 0, vw, vh);

    const nodes = doc.querySelectorAll('body *');
    const cap = Math.min(nodes.length, 3000);
    for (let i = 0; i < cap; i++) {
      const el = nodes[i];
      if (SKIP.has(el.tagName)) continue;
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.bottom < 0 || r.right < 0 || r.top > vh || r.left > vw) continue;
      if (r.width < 1 || r.height < 1) continue;

      const tag = el.tagName.toLowerCase();
      const cs = (el.ownerDocument.defaultView || win).getComputedStyle(el);

      if (tag === 'input' || tag === 'textarea' || tag === 'select') { drawField(ctx, el, r, cs, tag); continue; }
      if (tag === 'img') { drawImage(ctx, el, r); continue; }
      if (tag === 'button') { drawButton(ctx, el, r, cs); continue; }
      if (tag === 'a' && el.childElementCount === 0 && el.textContent.trim()) { drawTextBlock(ctx, el, r, cs); continue; }
      if (tag === 'div' || tag === 'section' || tag === 'article' || tag === 'main' || tag === 'form' ||
          tag === 'header' || tag === 'footer' || tag === 'nav' || tag === 'aside' || tag === 'li' ||
          tag === 'ul' || tag === 'ol' || tag === 'table' || tag === 'tr' || tag === 'td' || tag === 'th' ||
          tag === 'span' || tag === 'p' || tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4' ||
          tag === 'label' || tag === 'pre' || tag === 'code' || tag === 'strong' || tag === 'em' || tag === 'small') {
        drawBlock(ctx, el, r, cs, tag);
      }
    }
    return { width: W, height: H };
  }

  function drawBlock(ctx, el, r, cs, tag) {
    ctx.save();
    const clipped = cs.overflow && cs.overflow !== 'visible';
    if (clipped) { ctx.beginPath(); ctx.rect(r.left, r.top, r.width, r.height); ctx.clip(); }

    // background
    if (cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent') {
      ctx.fillStyle = cs.backgroundColor;
      ctx.fillRect(r.left, r.top, r.width, r.height);
    }
    // background image (simple: cover draw)
    if (cs.backgroundImage && cs.backgroundImage !== 'none' && cs.backgroundImage.includes('url(')) {
      const m = /url\(["']?(.*?)["']?\)/.exec(cs.backgroundImage);
      if (m && m[1] && !m[1].startsWith('data:')) {
        const img = el.ownerDocument.createElement('img');
        if (!img.__src) { img.__src = m[1]; img.src = m[1]; img.onload = () => drawCover(ctx, img, r); }
      }
    }
    // border
    if (cs.borderTopWidth && parseFloat(cs.borderTopWidth) > 0 && cs.borderTopColor !== 'rgba(0, 0, 0, 0)') {
      ctx.strokeStyle = cs.borderTopColor;
      ctx.lineWidth = parseFloat(cs.borderTopWidth) || 1;
      ctx.strokeRect(r.left + ctx.lineWidth / 2, r.top + ctx.lineWidth / 2, Math.max(0, r.width - ctx.lineWidth), Math.max(0, r.height - ctx.lineWidth));
    }
    // text
    const hasOwnText = Array.from(el.childNodes).some(n => n.nodeType === 3 && n.textContent.trim());
    if (hasOwnText && el.textContent.trim().length < 600) {
      drawWrappedText(ctx, el.textContent.replace(/\s+/g, ' ').trim(), r, cs, tag);
    }
    ctx.restore();
  }

  function drawTextBlock(ctx, el, r, cs) {
    ctx.save();
    const hasOwnText = Array.from(el.childNodes).some(n => n.nodeType === 3 && n.textContent.trim());
    if (hasOwnText) drawWrappedText(ctx, el.textContent.replace(/\s+/g, ' ').trim(), r, cs, el.tagName.toLowerCase());
    ctx.restore();
  }

  function drawWrappedText(ctx, text, r, cs, tag) {
    if (!text) return;
    let size = parseFloat(cs.fontSize) || 16;
    if (tag === 'h1') size = Math.max(size, 28);
    else if (tag === 'h2') size = Math.max(size, 22);
    else if (tag === 'h3') size = Math.max(size, 18);
    else if (tag === 'small') size = Math.min(size, 12);
    const weight = /bold|600|700|800/.test(cs.fontWeight) ? 'bold' : 'normal';
    const family = (cs.fontFamily || 'sans-serif').split(',')[0].replace(/["']/g, '');
    ctx.font = `${weight} ${size}px ${family}`;
    ctx.fillStyle = readableColor(cs.color);
    ctx.textAlign = cs.textAlign && cs.textAlign !== 'start' ? cs.textAlign : 'left';
    ctx.textBaseline = 'top';

    const pad = 4;
    const maxW = Math.max(20, r.width - pad * 2);
    const lineH = size * 1.35;
    const maxLines = Math.max(1, Math.floor((r.height - pad) / lineH));
    const words = text.split(' ');
    let line = '', y = r.top + pad, lines = 0;
    for (let i = 0; i < words.length && lines < maxLines; i++) {
      const test = line ? line + ' ' + words[i] : words[i];
      if (ctx.measureText(test).width > maxW && line) {
        ctx.fillText(line, r.left + pad, y);
        line = words[i]; y += lineH; lines++;
      } else line = test;
    }
    if (line && lines < maxLines) ctx.fillText(line, r.left + pad, y);
  }

  function drawField(ctx, el, r, cs, tag) {
    ctx.save();
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(r.left, r.top, r.width, r.height);
    ctx.strokeStyle = '#94a3b8';
    ctx.lineWidth = 1;
    ctx.strokeRect(r.left + 0.5, r.top + 0.5, r.width - 1, r.height - 1);

    let text = '';
    let isPassword = false;
    if (tag === 'select') {
      const opt = el.options && el.options[el.selectedIndex];
      text = opt ? opt.text : '';
    } else {
      text = el.value || '';
      isPassword = el.type === 'password';
    }
    const ph = el.placeholder || '';
    const size = parseFloat(getComputedStyle(el).fontSize) || 14;
    ctx.font = `${size}px sans-serif`;
    ctx.textBaseline = 'middle';
    const pad = 6;
    if (!text && ph) { ctx.fillStyle = '#94a3b8'; ctx.fillText(ph.slice(0, Math.floor((r.width - pad * 2) / (size * 0.55))), r.left + pad, r.top + r.height / 2); }
    else if (text) {
      ctx.fillStyle = '#1e293b';
      const shown = isPassword ? '•'.repeat(text.length) : text;
      ctx.fillText(shown.slice(0, Math.floor((r.width - pad * 2) / (size * 0.55))), r.left + pad, r.top + r.height / 2);
    }
    ctx.restore();
  }

  function drawButton(ctx, el, r, cs) {
    ctx.save();
    const bg = cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)' ? cs.backgroundColor : '#e2e8f0';
    ctx.fillStyle = bg;
    const radius = parseFloat(cs.borderRadius) || 6;
    roundRect(ctx, r.left, r.top, r.width, r.height, Math.min(radius, 12));
    ctx.fill();
    ctx.strokeStyle = cs.borderColor && cs.borderColor !== 'rgba(0, 0, 0, 0)' ? cs.borderColor : 'transparent';
    ctx.lineWidth = 1;
    ctx.stroke();
    const text = el.innerText.replace(/\s+/g, ' ').trim();
    if (text) {
      const size = parseFloat(cs.fontSize) || 14;
      ctx.font = `600 ${size}px sans-serif`;
      ctx.fillStyle = readableColor(bg);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text.slice(0, 30), r.left + r.width / 2, r.top + r.height / 2);
    }
    ctx.restore();
  }

  function drawImage(ctx, el, r) {
    if (el.naturalWidth > 0 && el.naturalHeight > 0) {
      try {
        drawCover(ctx, el, r);
      } catch (e) { /* tainted/cross-origin — draw placeholder */ }
    } else {
      ctx.save();
      ctx.fillStyle = '#e2e8f0';
      ctx.fillRect(r.left, r.top, r.width, r.height);
      ctx.restore();
    }
  }

  function drawCover(ctx, img, r) {
    const ir = img.naturalWidth / img.naturalHeight;
    const rr = r.width / r.height;
    let sw, sh;
    if (ir > rr) { sh = img.naturalHeight; sw = sh * rr; }
    else { sw = img.naturalWidth; sh = sw / rr; }
    const sx = (img.naturalWidth - sw) / 2, sy = (img.naturalHeight - sh) / 2;
    ctx.save();
    ctx.beginPath(); ctx.rect(r.left, r.top, r.width, r.height); ctx.clip();
    ctx.drawImage(img, sx, sy, sw, sh, r.left, r.top, r.width, r.height);
    ctx.restore();
  }

  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function readableColor(bg) {
    if (!bg || bg === 'transparent') return '#1e293b';
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(bg);
    if (!m) return '#1e293b';
    const lum = (0.299 * +m[1] + 0.587 * +m[2] + 0.114 * +m[3]) / 255;
    return lum > 0.6 ? '#1e293b' : '#ffffff';
  }

  return { render };
});
