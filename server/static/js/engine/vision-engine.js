/**
 * vision-engine.js — the privacy-preserving client-side vision pipeline.
 *
 * Pipeline (all on-device):
 *   1. capture   — grab a snapshot of the page (canvas, scaled for latency)
 *   2. dom       — walk the DOM, classify fields & images against the PII
 *                  knowledge base (pii-rules.js), scan text/values
 *   3. face      — YuNet on-device face detector (WebGPU/WASM)
 *   4. redact    — blur faces / black-out passwords / mask PII with a
 *                  deterministic strategy; draw the sanitized frame
 *   5. audit     — pixel diff + byte delta to PROVE data was removed
 *   6. report    — emit { redacted dataURL (opt), meta, elements } for the
 *                  server, plus full local analysis for the UI
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PVA = Object.assign(root.PVA || {}, { VisionEngine: api.VisionEngine });
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const G = (typeof globalThis !== 'undefined' && globalThis.PVA) || {};

  const DEFAULT_OPTS = {
    redactionStrategy: 'blur',      // 'blur' | 'solid'  (solid = black-out)
    faceStrategy: 'blur',           // 'blur' | 'solid'
    blurRadius: 14,                 // box-blur radius for soft redaction
    solidColor: '#000000',
    padPx: 2,                       // padding added around redaction boxes
    scanBodyText: true,             // scan page text for PII strings
    maxBodyTextChars: 20000,
    enableFaceDetection: true,
    sendRedactedImage: true,        // include redacted JPEG in server payload
    debug: false,                   // draw debug overlay (bounding boxes + labels)
  };

  class VisionEngine {
    constructor(config) {
      this.config = Object.assign({}, DEFAULT_OPTS, config || {});
      this.faceDetector = null;
      this.ort = null;
      this.status = { faceModel: 'idle', lastError: null };
      // canvasFactory lets the engine run under Node (evaluation harness)
      this._makeCanvas = this.config.canvasFactory || function () { return document.createElement('canvas'); };
    }

    /** Inject ORT (onnxruntime-web) and load YuNet. Safe to call lazily. */
    async ensureFaceModel(ort, modelUrl) {
      if (this.faceDetector) return this.faceDetector;
      if (!ort || !modelUrl) return null;
      try {
        this.ort = ort;
        const FD = G.YuNet.FaceDetector;
        this.faceDetector = new FD(ort);
        const preferWebGPU = typeof navigator !== 'undefined' && !!navigator.gpu;
        await this.faceDetector.load(modelUrl, { preferWebGPU });
        this.status.faceModel = 'ready';
        return this.faceDetector;
      } catch (e) {
        this.status.faceModel = 'error';
        this.status.lastError = String(e && e.message || e);
        return null;
      }
    }

    get faceReady() { return !!this.faceDetector; }

    /**
     * Run the full pipeline.
     * @param {object} params
     *   imageData  — {width, height, data} RGBA snapshot
     *   elements   — DOM element descriptors (rects in viewport CSS px)
     *   viewport   — {w, h} CSS px size of the viewport
     *   scale      — imageData.width / viewport.w (pixels per CSS px)
     *   opts       — runtime overrides (strategy etc.)
     * @returns {object} analysis (see README)
     */
    async process(params) {
      const t0 = now();
      const opts = Object.assign({}, this.config, params.opts || {});
      const imageData = params.imageData;
      const W = imageData.width, H = imageData.height;
      const scale = params.scale || 1;
      const viewport = params.viewport || { w: Math.round(W / scale), h: Math.round(H / scale) };
      const elements = params.elements || [];

      // ---------- 2. DOM analysis ----------
      const tDom = now();
      const detections = this._analyzeDom(elements, opts, scale);
      const tAfterDom = now();

      // ---------- 3. Face detection (local model) ----------
      let faceInferMs = 0;
      if (opts.enableFaceDetection && this.faceDetector) {
        const fr = await this.faceDetector.detect(imageData);
        faceInferMs = fr.inferMs;
        for (const d of fr.detections) {
          detections.push({
            category: 'face', confidence: d.score, source: 'face-model',
            rect: d.rect, landmarks: d.landmarks,
          });
        }
      }
      // dedupe: a field often produces both a label hit and a value-regex
      // hit on the same box. When one box contains the other (e.g. a value
      // span inside its card container), keep the TIGHTER box — redaction
      // precision is measured on the redacted area, not the container.
      const deduped = [];
      for (const d of detections) {
        const prev = deduped.find(p =>
          p.category === d.category && overlapRatio(p.rect, d.rect) > 0.5 &&
          !(p.landmarks && !d.landmarks) && !(!p.landmarks && d.landmarks));
        if (prev) {
          const a = areaOf(prev.rect), b = areaOf(d.rect);
          if (b < a) {
            // the new detection is tighter — replace
            Object.assign(prev, { rect: d.rect, confidence: d.confidence, source: d.source, match: d.match });
          } else if (overlapRatio(prev.rect, d.rect) < 0.99) {
            prev.rect = G.Geo.unionAll([prev.rect, d.rect]) || prev.rect;
          }
          // a === b (duplicate of same box): keep as-is
        } else deduped.push(d);
      }
      detections.length = 0;
      detections.push(...deduped);
      const tAfterFace = now();

      // ---------- 4. Redaction ----------
      const redact = this._redact(imageData, detections, opts);
      const tAfterRedact = now();

      // ---------- 5. Audit ----------
      const audit = this._audit(imageData, redact, detections, opts);

      // ---------- 6. Report ----------
      const counts = {};
      for (const d of detections) counts[d.category] = (counts[d.category] || 0) + 1;

      const payload = {
        schema: 'pva/v1',
        redaction: {
          scheme: opts.redactionStrategy,
          version: '1.0',
          categories: counts,
          faceCount: counts.face || 0,
          audit: { pixelDelta: audit.pixelDelta, byteDelta: audit.byteDelta, redactionCoverage: audit.redactionCoverage },
        },
        viewport: { w: viewport.w, h: viewport.h, scale },
        elements: this._summarizeElements(elements, detections),
        task: params.task || null,
      };
      if (params.step) payload.step = params.step;
      if (opts.sendRedactedImage) payload.image = redact.dataUrl;

      return {
        version: 'pva-1.0',
        config: opts,
        image: { w: W, h: H, scale },
        detections,
        counts,
        redacted: redact,
        audit,
        payload,
        timing: {
          dom: tAfterDom - tDom,
          face: tAfterFace - tAfterDom,
          faceInfer: faceInferMs,
          redact: tAfterRedact - tAfterFace,
          encode: redact.encodeMs,
          total: now() - t0,
        },
        status: { ...this.status },
      };
    }

    /* ================= DOM-level detection ================= */

    _analyzeDom(elements, opts, scale) {
      const dets = [];
      const byId = new Map();
      for (const el of elements) byId.set(el.uid || el, el);

      for (const el of elements) {
        const r = rectToPx(el.rect, scale);
        if (!r) continue;

        // --- text scan of element's own value/content ---
        // (never scan password-type values: the box itself is redacted and
        //  the characters must not even be processed)
        let text = null;
        if (el.inputType === 'password') text = null;
        else if (el.value && typeof el.value === 'string') text = el.value;
        else if (el.text && typeof el.text === 'string' && el.text.length < 300) text = el.text;
        if (text) {
          for (const hit of G.PII.scanText(text)) {
            dets.push({
              category: hit.category, confidence: G.PII.CONF.value, source: 'text',
              rect: expandRect(r, opts.padPx), match: hit.match,
            });
          }
        }

        // --- form-field classification ---
        if (el.role === 'input' || el.role === 'textarea' || el.role === 'select') {
          const cls = G.PII.classifyField({
            type: el.inputType, name: el.name, id: el.id,
            autocomplete: el.autocomplete, label: el.label,
            placeholder: el.placeholder, ariaLabel: el.ariaLabel, className: el.className,
          });
          if (cls) {
            dets.push({
              category: cls.category, confidence: cls.confidence, source: cls.source,
              rect: expandRect(r, opts.padPx),
              match: el.label || el.placeholder || null,
            });
          }
        }

        // --- image classification ---
        if (el.role === 'img') {
          const cls = G.PII.classifyImage({ src: el.src, alt: el.alt, className: el.className, id: el.id });
          if (cls) {
            dets.push({
              category: cls.category, confidence: cls.confidence, source: cls.source,
              rect: expandRect(r, opts.padPx), match: el.alt || null,
            });
          }
        }
      }

      // --- page-body text scan (covers rendered PII not in a form field) ---
      if (opts.scanBodyText && elements.length) {
        const body = elements.find(e => e.role === 'body');
        if (body && body.text && body.text.length <= opts.maxBodyTextChars) {
          let n = 0;
          for (const hit of G.PII.scanText(body.text)) {
            if (n++ > 60) break;
            // approximate rect: locate the match inside the element list whose text contains it
            const owner = elements.find(el =>
              el !== body && (el.text && el.text.includes(hit.match)) && rectToPx(el.rect, scale));
            if (owner) {
              dets.push({
                category: hit.category, confidence: G.PII.CONF.text, source: 'text',
                rect: expandRect(rectToPx(owner.rect, scale), opts.padPx), match: hit.match,
              });
            }
          }
        }
      }
      return dets;
    }

    /* ================= Redaction ================= */

    _redact(imageData, detections, opts) {
      const t0 = now();
      const W = imageData.width, H = imageData.height;
      const canvas = this._makeCanvas();
      canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext('2d');
      ctx.putImageData(imageData, 0, 0);

      const solidCats = new Set(['password', 'otp', 'face']);

      for (const d of detections) {
        const r = clampRect(d.rect, W, H);
        if (r.w < 2 || r.h < 2) continue;
        const useSolid = opts.redactionStrategy === 'solid' || (solidCats.has(d.category) && opts.redactionStrategy !== 'blur') ||
          (d.category === 'face' && opts.faceStrategy === 'solid') ||
          (d.category !== 'face' && opts.redactionStrategy === 'solid');
        // face follows faceStrategy, others follow redactionStrategy
        const isFace = d.category === 'face';
        const solid = isFace ? opts.faceStrategy === 'solid' : (opts.redactionStrategy === 'solid' || solidCats.has(d.category));
        if (!solid) {
          this._blurRect(ctx, r, opts.blurRadius);
        } else {
          ctx.fillStyle = opts.solidColor;
          ctx.fillRect(r.x, r.y, r.w, r.h);
        }
        d.redacted = { strategy: solid ? 'solid' : 'blur', rect: { ...r } };
      }

      // encode
      const jpeg = canvas.toDataURL('image/jpeg', 0.8);
      const bytes = b64Bytes(jpeg);
      const encodeMs = now() - t0;
      return { canvas, ctx, dataUrl: jpeg, bytes, encodeMs };
    }

    /** Cheap box-blur of a region (downscale-upscale) — GPU-friendly fallback. */
    _blurRect(ctx, r, radius) {
      const rad = Math.max(1, Math.round(radius));
      const off = this._makeCanvas();
      const size = Math.max(8, Math.min(r.w, r.h, 6 * rad));
      const fx = size / r.w, fy = size / r.h;
      off.width = Math.max(1, Math.round(r.w * fx));
      off.height = Math.max(1, Math.round(r.h * fy));
      const octx = off.getContext('2d');
      octx.imageSmoothingEnabled = true;
      octx.drawImage(ctx.canvas, r.x, r.y, r.w, r.h, 0, 0, off.width, off.height);
      // downscale more for a heavier blur on large regions
      let passes = Math.max(1, Math.min(5, Math.round(r.w / (10 * rad))));
      let w = off.width, h = off.height;
      for (let i = 0; i < passes && w > 1 && h > 1; i++) {
        w = Math.max(1, w >> 1); h = Math.max(1, h >> 1);
        const tmp = this._makeCanvas();
        tmp.width = w; tmp.height = h;
        const tctx = tmp.getContext('2d');
        tctx.imageSmoothingEnabled = true;
        tctx.drawImage(off, 0, 0, off.width, off.height, 0, 0, w, h);
        off.width = w; off.height = h;
        octx.drawImage(tmp, 0, 0);
      }
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(off, 0, 0, off.width, off.height, r.x, r.y, r.w, r.h);
    }

    /* ================= Audit ================= */

    _audit(imageData, redact, detections, opts) {
      const W = imageData.width, H = imageData.height;
      const src = imageData.data;
      const out = redact.ctx.getImageData(0, 0, W, H).data;
      let changed = 0;
      const n = W * H;
      // sample every pixel for accuracy (n is bounded by capture size, e.g. 480k)
      for (let i = 0; i < n; i++) {
        const si = i * 4;
        if (src[si] !== out[si] || src[si + 1] !== out[si + 1] || src[si + 2] !== out[si + 2]) changed++;
      }
      const pixelDelta = n ? changed / n : 0;
      const byteDelta = redact.bytes ? Math.min(1, redact.bytes / (W * H * 3)) : 0;
      const totalRedacted = detections.reduce((a, d) => a + (d.redacted ? d.redacted.rect.w * d.redacted.rect.h : 0), 0);
      return {
        pixelDelta,                       // fraction of pixels altered (privacy proof)
        byteDelta,                        // compressed-size reduction vs raw pixels
        redactionCoverage: W * H ? totalRedacted / (W * H) : 0,
        changedPixels: changed,
        redactedArea: totalRedacted,
      };
    }

    _summarizeElements(elements, detections) {
      const safe = [];
      let textEls = 0;
      for (const el of elements) {
        const interactive = el.role === 'input' || el.role === 'textarea' || el.role === 'select' || el.role === 'button' || el.role === 'img';
        if (!interactive && el.role !== 'element') continue;
        const rect = rectToPx(el.rect, 1); // viewport CSS px
        if (!rect) continue;
        // NOTE: input VALUES are never sent — only labels/placeholders.
        // The redacted image carries the only visual state the server sees.
        let label;
        if (el.role === 'input' || el.role === 'textarea') label = (el.label || el.placeholder || '');
        else label = (el.text || el.label || '');
        if (!interactive) {
          // include short non-interactive text (page messages, success
          // banners…) so the planner can detect task completion — capped
          // to keep the payload small
          const t = (label || '').trim();
          if (t.length < 2 || t.length > 80) continue;
          if (textEls++ >= 60) continue;
        }
        const det = detections.find(d => d.source !== 'face-model' && overlapRatio(d.rect, rect) > 0.5);
        safe.push({
          role: el.role,
          id: el.uid || null,
          rect: { x: rect.x, y: rect.y, w: rect.w, h: rect.h },
          text: truncate(label, 60),
          inputType: el.inputType || null,
          interactive: !!el.interactive,
          piiCategory: det ? det.category : null,
        });
      }
      return safe;
    }

    /* ================= debug overlay ================= */

    drawDebugOverlay(canvas, analysis) {
      const ctx = canvas.getContext('2d');
      const W = canvas.width, H = canvas.height;
      ctx.clearRect(0, 0, W, H);
      const CAT_COLORS = {
        password: '#e11d48', otp: '#e11d48', face: '#f59e0b', aadhaar: '#7c3aed',
        pan: '#7c3aed', credit_card: '#0ea5e9', debit_card: '#0ea5e9', cvv: '#0ea5e9',
        phone: '#10b981', email: '#10b981', name: '#f97316', dob: '#f97316',
        address: '#f97316', account_number: '#0ea5e9', ifsc: '#0ea5e9',
        pincode: '#64748b', username: '#64748b', document_image: '#7c3aed',
      };
      for (const d of analysis.detections) {
        const r = d.redacted ? d.redacted.rect : d.rect;
        const color = CAT_COLORS[d.category] || '#ef4444';
        ctx.strokeStyle = color; ctx.lineWidth = 2;
        ctx.strokeRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2);
        if (d.landmarks && d.landmarks.length) {
          ctx.fillStyle = '#22c55e';
          for (const p of d.landmarks) { ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, 7); ctx.fill(); }
        }
        ctx.fillStyle = color;
        const label = `${d.category} ${Math.round(d.confidence * 100)}% (${d.source})`;
        ctx.font = '11px ui-monospace, monospace';
        const tw = ctx.measureText(label).width + 8;
        ctx.fillRect(r.x, r.y - 16 > 0 ? r.y - 16 : r.y, tw, 15);
        ctx.fillStyle = '#fff';
        ctx.fillText(label, r.x + 4, (r.y - 16 > 0 ? r.y - 16 : r.y) + 11);
      }
    }
  }

  /* ================= helpers ================= */

  function now() { return (typeof performance !== 'undefined' ? performance.now() : Date.now()); }

  function rectToPx(r, scale) {
    if (!r) return null;
    return { x: Math.round(r.x * scale), y: Math.round(r.y * scale), w: Math.round(r.w * scale), h: Math.round(r.h * scale) };
  }

  function expandRect(r, pad) {
    return { x: r.x - pad, y: r.y - pad, w: r.w + 2 * pad, h: r.h + 2 * pad };
  }

  function clampRect(r, W, H) {
    const x = Math.max(0, Math.min(W, Math.round(r.x)));
    const y = Math.max(0, Math.min(H, Math.round(r.y)));
    const x2 = Math.max(x, Math.min(W, Math.round(r.x + r.w)));
    const y2 = Math.max(y, Math.min(H, Math.round(r.y + r.h)));
    return { x, y, w: x2 - x, h: y2 - y };
  }

  function b64Bytes(dataUrl) {
    const b64 = dataUrl.split(',')[1] || '';
    const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
    return Math.floor(b64.length * 3 / 4) - pad;
  }

  function truncate(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; }

  function overlapRatio(a, b) {
    const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
    const inter = Math.max(0, x2 - x) * Math.max(0, y2 - y);
    const minArea = Math.min(a.w * a.h, b.w * b.h);
    return minArea > 0 ? inter / minArea : 0;
  }

  function areaOf(r) { return r.w * r.h; }

  return { VisionEngine, DEFAULT_OPTS };
});
