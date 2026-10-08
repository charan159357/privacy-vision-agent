/**
 * yunet.js — on-device face detection with YuNet (OpenCV Zoo, ~230 KB ONNX).
 * Runs inside ONNX Runtime Web, prefer WebGPU, fallback WASM.
 *
 * Returns detections in ORIGINAL image coordinates:
 *   { x, y, w, h, score, landmarks: [{x,y} x5] }
 * 5 landmarks (left eye, right eye, nose, mouth corners) — used to draw
 * verification markers in the demo.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PVA = Object.assign(root.PVA || {}, { YuNet: api });
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const INPUT = 640;
  const SCORE_THRESH = 0.55;
  const NMS_THRESH = 0.3;
  const TOPK = 50;
  const STRIDES = [8, 16, 32];

  class FaceDetector {
    /** @param {object} ort the onnxruntime-web (or -node) module */
    constructor(ort) { this.ort = ort; this.session = null; }

    async load(modelUrl, options) {
      options = options || {};
      const ep = [];
      const pref = [];
      if (options.preferWebGPU && this.ort.env && this.ort.env.webgpu) {
        ep.push('webgpu');
        pref.push(['webgpu', 'enableGraphCapture', '1']);
      }
      if (typeof WebAssembly !== 'undefined' && typeof WebAssembly.instantiate === 'function') ep.push('wasm');
      ep.push('cpu');
      const sessionOpts = {
        executionProviders: ep,
        graphOptimizationLevel: 'all',
        logSeverityLevel: 3,
      };
      if (pref.length) sessionOpts.preferredOutputLocation = 'cpu';
      try {
        this.session = await this.ort.InferenceSession.create(modelUrl, sessionOpts);
      } catch (e) {
        // retry without exotic options
        this.session = await this.ort.InferenceSession.create(modelUrl, {
          executionProviders: ['wasm', 'cpu'], graphOptimizationLevel: 'all', logSeverityLevel: 3,
        });
      }
      return this.session;
    }

    /**
     * Detect faces in an ImageData-like {width, height, data(Uint8ClampedArray RGBA)}.
     */
    async detect(image) {
      if (!this.session) throw new Error('FaceDetector not loaded');
      const W = image.width, H = image.height;
      const scale = Math.max(W, H) / INPUT;
      const dw = (INPUT - Math.round(W / scale)) / 2;
      const dh = (INPUT - Math.round(H / scale)) / 2;

      // letterboxed BGR float input, mean-subtracted
      const input = new Float32Array(1 * 3 * INPUT * INPUT);
      const area = INPUT * INPUT;
      for (let i = 0; i < area; i++) { input[i] = 128; input[area + i] = 128; input[2 * area + i] = 128; }
      const srcW = image.width, srcH = image.height;
      const data = image.data;
      const outW = Math.round(W / scale), outH = Math.round(H / scale);
      for (let y = 0; y < outH; y++) {
        const sy = Math.min(srcH - 1, Math.round(y * scale));
        const rowBase = sy * srcW;
        for (let x = 0; x < outW; x++) {
          const sx = Math.min(srcW - 1, Math.round(x * scale));
          const si = (rowBase + sx) * 4;
          const oi = (y + dh) * INPUT + (x + dw);
          input[oi] = data[si + 2] - 128;        // B
          input[area + oi] = data[si + 1] - 128; // G
          input[2 * area + oi] = data[si] - 128; // R
        }
      }

      const feeds = {};
      feeds[this.session.inputNames[0]] = new this.ort.Tensor('float32', input, [1, 3, INPUT, INPUT]);
      const t0 = performance ? performance.now() : Date.now();
      const outputs = await this.session.run(feeds);
      const ms = (performance ? performance.now() : Date.now()) - t0;

      const dets = [];
      let s = 0;
      for (const stride of STRIDES) {
        const grid = INPUT / stride;
        const obj = outputs['obj_' + stride].data;
        const cls = outputs['cls_' + stride].data;
        const bbox = outputs['bbox_' + stride].data;
        const kps = outputs['kps_' + stride].data;
        // YuNet decode (mirrors OpenCV objdetect/src/face_detect.cpp):
        //   cx = (col + bbox[0]) * stride ; cy = (row + bbox[1]) * stride
        //   w  = exp(bbox[2]) * stride    ; h  = exp(bbox[3]) * stride
        //   score = sqrt(clamp(obj) * clamp(cls)) ; landmarks = (kps + anchor)*stride
        for (let r = 0; r < grid; r++) {
          for (let c = 0; c < grid; c++) {
            const i = r * grid + c;
            const o = Math.max(0, Math.min(1, obj[i]));
            const cl = Math.max(0, Math.min(1, cls[i]));
            const score = Math.sqrt(o * cl);
            if (score < SCORE_THRESH) continue;
            const cx = (c + bbox[i * 4 + 0]) * stride;
            const cy = (r + bbox[i * 4 + 1]) * stride;
            const bw = Math.exp(bbox[i * 4 + 2]) * stride;
            const bh = Math.exp(bbox[i * 4 + 3]) * stride;
            const x1 = (cx - bw / 2 - dw) * scale;
            const y1 = (cy - bh / 2 - dh) * scale;
            const x2 = (cx + bw / 2 - dw) * scale;
            const y2 = (cy + bh / 2 - dh) * scale;
            if (x2 <= x1 || y2 <= y1) continue;
            const landmarks = [];
            for (let k = 0; k < 5; k++) {
              landmarks.push({
                x: ((kps[i * 10 + k * 2] + c) * stride - dw) * scale,
                y: ((kps[i * 10 + k * 2 + 1] + r) * stride - dh) * scale,
              });
            }
            dets.push({
              rect: { x: Math.round(x1), y: Math.round(y1), w: Math.round(x2 - x1), h: Math.round(y2 - y1) },
              score, landmarks,
            });
            s++;
          }
        }
      }

      const sorted = dets.sort((a, b) => b.score - a.score).slice(0, TOPK);
      const kept = [];
      for (const d of sorted) {
        let sup = false;
        for (const k of kept) {
          if (iou(d.rect, k.rect) > NMS_THRESH) { sup = true; break; }
        }
        if (!sup) kept.push(d);
      }
      return { detections: kept.map(d => ({ ...d, source: 'face-model' })), inferMs: ms };
    }
  }

  function iou(a, b) {
    const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
    const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    const union = a.w * a.h + b.w * b.h - inter;
    return union > 0 ? inter / union : 0;
  }

  return { FaceDetector, INPUT };
});
