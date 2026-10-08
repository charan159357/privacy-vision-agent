/**
 * geometry.js — lightweight rect/geometry helpers shared by the
 * browser client, the browser extension and the Node evaluation harness.
 * Rect format: {x, y, w, h} (integers).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PVA = Object.assign(root.PVA || {}, { Geo: api });
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function expand(r, pad) {
    return {
      x: Math.round(r.x - pad),
      y: Math.round(r.y - pad),
      w: Math.round(r.w + 2 * pad),
      h: Math.round(r.h + 2 * pad),
    };
  }

  function clampTo(r, W, H) {
    const x = clamp(Math.round(r.x), 0, W);
    const y = clamp(Math.round(r.y), 0, H);
    return {
      x, y,
      w: clamp(Math.round(r.w), 0, W - x),
      h: clamp(Math.round(r.h), 0, H - y),
    };
  }

  function area(r) { return r.w * r.h; }

  function intersection(a, b) {
    const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
    if (x2 <= x || y2 <= y) return { x, y, w: 0, h: 0 };
    return { x, y, w: x2 - x, h: y2 - y };
  }

  function iou(a, b) {
    const inter = area(intersection(a, b));
    if (inter === 0) return 0;
    return inter / (area(a) + area(b) - inter);
  }

  function coverage(covered, box) {
    // fraction of `box` covered by union of `covered` rects
    if (area(box) === 0) return 0;
    let hit = 0;
    for (const c of covered) hit += area(intersection(c, box));
    return clamp(hit / area(box), 0, 1);
  }

  function unionAll(rects) {
    if (!rects.length) return null;
    let x = Infinity, y = Infinity, x2 = 0, y2 = 0;
    for (const r of rects) {
      x = Math.min(x, r.x); y = Math.min(y, r.y);
      x2 = Math.max(x2, r.x + r.w); y2 = Math.max(y2, r.y + r.h);
    }
    return { x, y, w: x2 - x, h: y2 - y };
  }

  /** Non-maximum suppression on [{rect, score}] — IoU threshold based. */
  function nms(items, iouThresh) {
    const out = [];
    const sorted = items.slice().sort((a, b) => b.score - a.score);
    while (sorted.length) {
      const best = sorted.shift();
      out.push(best);
      for (let i = sorted.length - 1; i >= 0; i--) {
        if (iou(best.rect, sorted[i].rect) > iouThresh) sorted.splice(i, 1);
      }
    }
    return out;
  }

  /** Merge a list of rects into clusters of overlapping rects. */
  function cluster(rects, overlapThresh) {
    const clusters = [];
    for (const r of rects) {
      let merged = false;
      for (const c of clusters) {
        const inter = area(intersection(c, r));
        const smaller = Math.min(area(c), area(r));
        if (smaller > 0 && inter / smaller > overlapThresh) {
          const u = unionAll([c, r]);
          c.x = u.x; c.y = u.y; c.w = u.w; c.h = u.h;
          merged = true;
          break;
        }
      }
      if (!merged) clusters.push({ ...r });
    }
    return clusters;
  }

  return { clamp, expand, clampTo, area, intersection, iou, coverage, unionAll, nms, cluster };
});
