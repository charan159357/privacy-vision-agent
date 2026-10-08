#!/usr/bin/env node
/**
 * eval.js — SIH evaluation harness for the privacy-preserving browser agent.
 *
 * Covers the 5 evaluation metrics:
 *   1. Accuracy of visual context from screen            (25%)
 *   2. Recall & precision for detection of sensitive/PII (20%)
 *   3. Precision of redaction                            (20%)
 *   4. Client-side resource utilization                  (20%)
 *   5. Overall end-to-end latency of the provided task   (15%)
 *
 * Usage:  node eval.js [--json]
 * Output: report.md / report.json  (plus console summary)
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { createCanvas, loadImage } = require('canvas');
const ort = require('onnxruntime-node');

/* ---------------- shared engine under Node ---------------- */
const root = path.join(__dirname, '..', 'server', 'static', 'js', 'engine');
const PII = require(path.join(root, 'pii-rules.js'));
const GEO = require(path.join(root, 'geometry.js'));
const YuNet = require(path.join(root, 'yunet.js'));
const gateway = require(path.join(root, 'gateway.js'));
// vision-engine reads PII/YuNet/Geo from globalThis.PVA when not in a browser
globalThis.PVA = { PII, Geo: GEO, YuNet };
const { VisionEngine } = require(path.join(root, 'vision-engine.js'));
const { TEXT_FIXTURES, FIELD_FIXTURES, bankingScreen } = require('./fixtures.js');

const SERVER = process.env.SERVER || 'http://127.0.0.1:8787';
const YUNET_URL = path.join(__dirname, '..', 'server', 'static', 'models', 'yunet.onnx');
const PORTRAIT = path.join(__dirname, '..', 'assets', 'portrait.jpg');
const ASSETS = path.join(__dirname, '..', 'assets');

const results = {};
const T0 = Date.now();

function fmt(x, d = 2) { return typeof x === 'number' ? x.toFixed(d) : String(x); }

/* ================================================================ */
/* METRIC 2a — text-level PII detection: precision & recall          */
/* ================================================================ */
async function metricPII() {
  let tp = 0, fp = 0, fn = 0;
  const perCat = {};
  const detail = [];
  for (const fx of TEXT_FIXTURES) {
    const got = PII.scanText(fx.text);
    const exp = fx.expect;
    // match by (category, match string)
    const expMatched = new Array(exp.length).fill(false);
    const gotCounted = new Array(got.length).fill(false);
    for (let i = 0; i < exp.length; i++) {
      for (let j = 0; j < got.length; j++) {
        if (!gotCounted[j] && got[j].category === exp[i].category && got[j].match === exp[i].match) {
          expMatched[i] = true; gotCounted[j] = true; tp++;
          perCat[exp[i].category] = perCat[exp[i].category] || { tp: 0, fp: 0, fn: 0 };
          perCat[exp[i].category].tp++;
          break;
        }
      }
    }
    for (let i = 0; i < exp.length; i++) if (!expMatched[i]) { fn++; perCat[exp[i].category] = perCat[exp[i].category] || { tp: 0, fp: 0, fn: 0 }; perCat[exp[i].category].fn++; }
    for (let j = 0; j < got.length; j++) if (!gotCounted[j]) { fp++; perCat[got[j].category] = perCat[got[j].category] || { tp: 0, fp: 0, fn: 0 }; perCat[got[j].category].fp++; }
    detail.push({
      text: fx.text.slice(0, 60), expected: exp.length, found: got.length,
      ok: exp.length === got.length && got.every(g => exp.some(e => e.category === g.category && e.match === g.match)),
      foundDetail: got.map(g => g.category + ':' + g.match),
    });
  }
  const precision = tp / (tp + fp + 1e-9);
  const recall = tp / (tp + fn + 1e-9);
  return { name: 'PII text detection', tp, fp, fn, precision, recall, f1: 2 * precision * recall / (precision + recall + 1e-9), detail, perCat };
}

/* ================================================================ */
/* METRIC 2b — field-level PII classification                        */
/* ================================================================ */
async function metricFields() {
  let tp = 0, fp = 0, fn = 0;
  const detail = [];
  for (const [name, fx] of Object.entries(FIELD_FIXTURES)) {
    for (const el of fx.elements) {
      const cls = PII.classifyField(el);
      const expRow = fx.expect.find(e => e.label === el.label);
      if (!expRow) continue; // safety
      const expected = expRow.category;
      let verdict;
      if (expected) {
        if (cls && cls.category === expected) { tp++; verdict = 'TP'; }
        else { fn++; verdict = 'FN (got ' + (cls ? cls.category : 'none') + ')'; }
      } else {
        if (cls) { fp++; verdict = 'FP (' + cls.category + ')'; }
        else verdict = 'TN';
      }
      detail.push({ scenario: name, label: el.label, expected: expected || 'clean', got: cls ? cls.category : null, verdict });
    }
  }
  const precision = tp / (tp + fp + 1e-9);
  const recall = tp / (tp + fn + 1e-9);
  return { name: 'PII field classification', tp, fp, fn, precision, recall, f1: 2 * precision * recall / (precision + recall + 1e-9), detail };
}

/* ================================================================ */
/* METRIC 1 + 3 — synthetic screen: context accuracy + redaction     */
/* ================================================================ */
async function metricScreen() {
  // 'solid' strategy for the deterministic pixel-proof; the blur path is
  // verified separately in the face test and in the live browser demo.
  const engine = new VisionEngine({ redactionStrategy: 'solid', faceStrategy: 'solid', canvasFactory: () => createCanvas(1, 1) });
  const scr = bankingScreen();
  const analysis = await engine.process({
    imageData: scr.imageData,
    elements: scr.elements,
    viewport: { w: scr.imageData.width, h: scr.imageData.height },
    scale: 1,
    task: 'none',
  });

  // --- redaction box matching (IoU >= 0.5) ---
  const pred = analysis.detections.filter(d => d.redacted).map(d => d.redacted.rect);
  const gt = scr.gtRects;
  const matched = new Array(gt.length).fill(false);
  let tp = 0;
  for (let i = 0; i < gt.length; i++) {
    for (let j = 0; j < pred.length; j++) {
      const r = GEO.iou(gt[i].rect, pred[j]);
      if (r >= 0.5) { matched[i] = true; break; }
    }
    if (matched[i]) tp++;
  }
  const boxRecall = tp / gt.length;
  const boxPrecision = tp / (pred.length || 1);

  // --- category correctness on matched boxes ---
  let catOK = 0, catN = 0;
  for (let i = 0; i < gt.length; i++) {
    const hits = analysis.detections.filter(d => d.redacted && GEO.iou(gt[i].rect, d.redacted.rect) >= 0.5);
    if (hits.length) {
      catN++;
      if (hits.some(h => h.category === gt[i].category)) catOK++;
    }
  }
  const catAcc = catN ? catOK / catN : 1;

  // --- pixel-level verification (blur strategy) ---
  const src = scr.imageData.data;
  const out = analysis.redacted.canvas.getContext('2d').getImageData(0, 0, scr.imageData.width, scr.imageData.height).data;
  const W = scr.imageData.width, H = scr.imageData.height;
  function changedIn(rect) {
    let changed = 0, n = 0;
    for (let y = Math.max(0, rect.y); y < Math.min(H, rect.y + rect.h); y += 2) {
      for (let x = Math.max(0, rect.x); x < Math.min(W, rect.x + rect.w); x += 2) {
        const i = (y * W + x) * 4;
        if (src[i] !== out[i] || src[i + 1] !== out[i + 1] || src[i + 2] !== out[i + 2]) changed++;
        n++;
      }
    }
    return n ? changed / n : 0;
  }
  const inBox = gt.map(g => changedIn(g.rect));
  const inBoxAvg = inBox.reduce((a, b) => a + b, 0) / (inBox.length || 1);
  // pixels changed OUTSIDE the ground-truth boxes (leakage measure).
  // The redactor adds a deliberate padPx=2 guard band around each box, so
  // treat boxes expanded by 3px as "inside" for this leakage check.
  const insideOf = g => (x, y) =>
    x >= g.rect.x - 3 && x < g.rect.x + g.rect.w + 3 && y >= g.rect.y - 3 && y < g.rect.y + g.rect.h + 3;
  let outChanged = 0, outN = 0;
  for (let y = 0; y < H; y += 2) {
    for (let x = 0; x < W; x += 2) {
      const inside = gt.some(g => insideOf(g)(x, y));
      if (inside) continue;
      const i = (y * W + x) * 4;
      if (src[i] !== out[i] || src[i + 1] !== out[i + 1] || src[i + 2] !== out[i + 2]) outChanged++;
      outN++;
    }
  }
  const outside = outN ? outChanged / outN : 0;

  // --- context accuracy: element summaries match ground truth ---
  const summarized = analysis.payload.elements;
  const gtFields = scr.elements.filter(e => e.role !== 'button');
  const elMatched = gtFields.filter(el => summarized.some(s => s.piiCategory && GEO.iou(el.rect, s.rect) > 0.5 && el.label.includes(s.text.split('…')[0].slice(0, 8)) || s.text && el.label && s.text.split('…')[0] === el.label.slice(0, s.text.split('…')[0].length))).length;
  const elRecall = elMatched / (gtFields.length || 1);
  const elemIoU = [];
  for (const el of gtFields) {
    const s = summarized.filter(x => x.rect);
    let best = 0;
    for (const x of s) best = Math.max(best, GEO.iou(el.rect, x.rect));
    elemIoU.push(best);
  }
  const meanIoU = elemIoU.reduce((a, b) => a + b, 0) / (elemIoU.length || 1);

  return {
    name: 'synthetic screen pipeline',
    boxPrecision, boxRecall, catAcc, inBoxAvg, outsideDelta: outside,
    contextElementRecall: elRecall, meanElementIoU: meanIoU,
    detections: analysis.detections.map(d => ({ category: d.category, conf: +d.confidence.toFixed(2), source: d.source })),
    timing: analysis.timing,
    byteDelta: analysis.audit.byteDelta,
    payloadKB: Math.round(analysis.redacted.bytes / 1024),
  };
}

/* ================================================================ */
/* METRIC 1/4 — real image: YuNet face detection (WASM in Node)      */
/* ================================================================ */
async function metricFace() {
  const img = await loadImage(PORTRAIT);
  const W = 512, H = 512; // portrait is square — no aspect distortion
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, W, H);
  const imageData = ctx.getImageData(0, 0, W, H);

  const detector = new YuNet.FaceDetector(ort);
  await detector.load(YUNET_URL, { preferWebGPU: false });
  const t0 = Date.now();
  const faceRuns = [];
  let detections = null;
  for (let i = 0; i < 3; i++) {
    const s = Date.now();
    const r = await detector.detect(imageData);
    faceRuns.push(Date.now() - s);
    detections = r;
  }
  const inferMs = faceRuns.slice(1).reduce((a, b) => a + b, 0) / Math.max(1, faceRuns.length - 1);

  const engine = new VisionEngine({ redactionStrategy: 'blur', faceStrategy: 'blur', canvasFactory: () => createCanvas(1, 1) });
  engine.faceDetector = detector;
  const analysis = await engine.process({
    imageData, elements: [], viewport: { w: W, h: H }, scale: 1, task: 'redact faces',
  });
  const faceBoxes = analysis.detections.filter(d => d.category === 'face').map(d => d.redacted ? d.redacted.rect : d.rect);
  // pixel change inside the detected face box
  const src = imageData.data;
  const out = analysis.redacted.canvas.getContext('2d').getImageData(0, 0, W, H).data;
  let changed = 0, n = 0;
  for (const b of faceBoxes) {
    for (let y = b.y; y < Math.min(H, b.y + b.h); y += 2) {
      for (let x = b.x; x < Math.min(W, b.x + b.w); x += 2) {
        const i = (y * W + x) * 4;
        if (src[i] !== out[i] || src[i + 1] !== out[i + 1] || src[i + 2] !== out[i + 2]) changed++;
        n++;
      }
    }
  }
  return {
    name: 'YuNet face detection (WASM)',
    faces: analysis.detections.filter(d => d.category === 'face').length,
    scores: analysis.detections.filter(d => d.category === 'face').map(d => +d.confidence.toFixed(2)),
    inferMs: Math.round(inferMs),
    faceBoxPixelChanged: n ? changed / n : 0,
    analysisTiming: analysis.timing,
  };
}

/* ================================================================ */
/* METRIC 4 — resource utilization                                   */
/* ================================================================ */
async function metricResources(scrResult, faceResult) {
  const modelBytes = fs.statSync(YUNET_URL).size;
  const ortJs = fs.statSync(path.join(root, '..', '..', 'js', 'ort.all.min.js')).size;
  const wasm = fs.statSync(path.join(root, '..', '..', 'ort', 'ort-wasm-simd-threaded.wasm')).size;
  const ortSessionInputBytes = 1 * 3 * 640 * 640 * 4;
  const notes = [];
  const score = (v, target, dir) => dir === 'lt' ? Math.max(0, Math.min(1, 1 - v / target)) : Math.max(0, Math.min(1, v / target));
  const sModel = score(modelBytes, 1 * 1024 * 1024, 'lt');
  const sPayload = score(scrResult.payloadKB, 300, 'lt');
  const sDom = score(scrResult.timing.dom, 50, 'lt');
  const sFace = score(faceResult.inferMs, 600, 'lt');
  const sTotal = score(scrResult.timing.total, 1500, 'lt');
  notes.push(`YuNet model ${(modelBytes / 1024).toFixed(0)} KB (target <1 MB → ${(sModel * 100).toFixed(0)}%)`);
  notes.push(`ORT runtime JS ${(ortJs / 1024).toFixed(0)} KB + WASM ${(wasm / 1024 / 1024).toFixed(1)} MB (loaded once, cached)`);
  notes.push(`face-model input buffer ${(ortSessionInputBytes / 1024 / 1024).toFixed(2)} MB`);
  notes.push(`redacted payload ${scrResult.payloadKB} KB for a ${scrResult.timing && 'full'} page snapshot`);
  const resourceScore = 0.2 * sModel + 0.2 * sPayload + 0.2 * sDom + 0.2 * sFace + 0.2 * sTotal;
  return { score: resourceScore, notes, components: { modelBytes, ortJs, wasm, ortSessionInputBytes, domMs: scrResult.timing.dom, faceMs: faceResult.inferMs, totalMs: scrResult.timing.total, payloadKB: scrResult.payloadKB } };
}

/* ================================================================ */
/* METRIC 5 — end-to-end latency against the live server             */
/* ================================================================ */
async function metricE2E() {
  const scr = bankingScreen();
  const engine = new VisionEngine({ redactionStrategy: 'blur', faceStrategy: 'blur', canvasFactory: () => createCanvas(1, 1) });
  const analysis = await engine.process({
    imageData: scr.imageData, elements: scr.elements,
    viewport: { w: scr.imageData.width, h: scr.imageData.height }, scale: 1,
    task: 'Fill the insurance claim form with demo details and submit', step: 1,
  });

  const payload = analysis.payload;
  const t0 = Date.now();
  let res;
  try {
    const r = await fetch(SERVER + '/api/agent', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    res = await r.json();
  } catch (e) {
    return { name: 'end-to-end', skipped: true, error: String(e.message || e) };
  }
  const latencyMs = Date.now() - t0;

  // simulate local execution on the element map
  const mock = { filled: {}, clicked: [] };
  for (const c of (res.commands || [])) {
    if (c.action === 'type') mock.filled[c.uid] = c.text;
    if (c.action === 'click') mock.clicked.push(c.uid);
  }
  const expectedFills = ['Priya Sharma', 'priya.sharma@example.com', '+91 98765 43210', '1234 5678 9012'];
  const fillOK = expectedFills.every(v => Object.values(mock.filled).includes(v));
  const clickOK = mock.clicked.length >= 1;

  // step 2: form hidden → success visible → server should declare done
  const successPayload = Object.assign(JSON.parse(JSON.stringify(payload)), {
    step: (res.step || 2),
    elements: [{ role: 'element', id: 50, text: 'Claim submitted successfully! Thank you for your application', rect: { x: 100, y: 100, w: 400, h: 60 } }],
    redaction: Object.assign({}, payload.redaction, { categories: {} }),
  });
  const t1 = Date.now();
  const r2 = await fetch(SERVER + '/api/agent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(successPayload) });
  const res2 = await r2.json();
  const latency2 = Date.now() - t1;

  return {
    name: 'end-to-end (server live)',
    latencyMs, latencyStep2: latency2,
    commands: (res.commands || []).length,
    fillOK, clickOK, doneDeclared: !!(res2 && res2.done),
    planMode: res.mode,
    auditOnPayload: gateway.audit(payload).length === 0,
  };
}

/* ================================================================ */
/* Report                                                             */
/* ================================================================ */
async function main() {
  const piiText = await metricPII();
  const piiFields = await metricFields();
  const screen = await metricScreen();
  const face = await metricFace();
  const resources = await metricResources(screen, face);
  const e2e = await metricE2E();

  /* -------- metric scores (0..100) -------- */
  // M1: how faithfully the agent perceives the screen = sensitive regions
  // detected (box recall) + their categories classified correctly
  const M1 = 100 * (0.5 * screen.catAcc + 0.5 * screen.boxRecall);                            // visual context accuracy
  const M2 = 100 * (0.6 * (piiText.f1) + 0.4 * (piiFields.f1));                                // PII precision/recall
  const M3 = 100 * (0.5 * screen.boxPrecision + 0.5 * Math.min(1, screen.inBoxAvg / 0.95));    // redaction precision (+pixel proof)
  const M4 = 100 * resources.score;                                                            // resource utilization
  const M5 = e2e.skipped ? null : 100 * Math.max(0, Math.min(1, 1 - e2e.latencyMs / 8000));    // e2e latency (8s budget)

  const weights = { M1: 0.25, M2: 0.20, M3: 0.20, M4: 0.20, M5: 0.15 };
  const scores = { M1, M2, M3, M4, M5: M5 != null ? M5 : 0 };
  const overall = Object.keys(weights).reduce((a, k) => a + (scores[k] != null ? scores[k] * weights[k] : 0), 0);
  const overallLabel = M5 == null ? '(M5 skipped — server not running)' : '';

  const report = {
    generatedAt: new Date().toISOString(),
    overall: +overall.toFixed(1),
    overallLabel,
    metrics: {
      M1_visualContext: { score: +M1.toFixed(1), weight: weights.M1, categoryAccuracy: +screen.catAcc.toFixed(3), meanElementIoU: +screen.meanElementIoU.toFixed(3), elementRecall: +screen.contextElementRecall.toFixed(3) },
      M2_piiDetection: { score: +M2.toFixed(1), weight: weights.M2, text: { precision: +piiText.precision.toFixed(3), recall: +piiText.recall.toFixed(3), f1: +piiText.f1.toFixed(3), tp: piiText.tp, fp: piiText.fp, fn: piiText.fn }, fields: { precision: +piiFields.precision.toFixed(3), recall: +piiFields.recall.toFixed(3), f1: +piiFields.f1.toFixed(3), tp: piiFields.tp, fp: piiFields.fp, fn: piiFields.fn } },
      M3_redaction: { score: +M3.toFixed(1), weight: weights.M3, boxPrecision: +screen.boxPrecision.toFixed(3), boxRecall: +screen.boxRecall.toFixed(3), pixelsChangedInsideGT: +screen.inBoxAvg.toFixed(3), pixelsChangedOutsideGT: +screen.outsideDelta.toFixed(4) },
      M4_resources: { score: +M4.toFixed(1), weight: weights.M4, ...resources.components, notes: resources.notes },
      M5_e2eLatency: { score: M5 == null ? null : +M5.toFixed(1), weight: weights.M5, ...(e2e.skipped ? { skipped: true, error: e2e.error } : { latencyMs: e2e.latencyMs, latencyStep2: e2e.latencyStep2, commands: e2e.commands, fillOK: e2e.fillOK, clickOK: e2e.clickOK, doneDeclared: e2e.doneDeclared, planMode: e2e.planMode, auditOnPayload: e2e.auditOnPayload }) },
    },
    detail: {
      textFixtures: piiText.detail,
      fieldFixtures: piiFields.detail,
      screenDetections: screen.detections,
      face: { faces: face.faces, scores: face.scores, inferMs: face.inferMs, faceBoxPixelChanged: +face.faceBoxPixelChanged.toFixed(3) },
      timings: { screen: screen.timing, face: face.analysisTiming },
      resourceBytes: resources.components,
    },
    elapsedSec: +((Date.now() - T0) / 1000).toFixed(1),
  };

  fs.writeFileSync(path.join(__dirname, 'report.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(__dirname, 'report.md'), renderMarkdown(report));

  // console summary
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  SIH Evaluation — Privacy-Preserving Browser Agent       ║');
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log('║ M1 Visual context accuracy      25%   ' + fmt(M1) + '   ║');
  console.log('║ M2 PII detection P/R            20%   ' + fmt(M2) + '   ║');
  console.log('║ M3 Redaction precision          20%   ' + fmt(M3) + '   ║');
  console.log('║ M4 Resource utilization         20%   ' + fmt(M4) + '   ║');
  console.log('║ M5 End-to-end latency           15%   ' + (M5 == null ? '  n/a  ' : fmt(M5)) + '   ║');
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log('║ OVERALL  ' + fmt(overall) + '/100  ' + (overallLabel || '').padEnd(24) + '  ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('PII text  : precision ' + fmt(piiText.precision) + ' | recall ' + fmt(piiText.recall) + ' (tp ' + piiText.tp + ', fp ' + piiText.fp + ', fn ' + piiText.fn + ')');
  console.log('PII fields: precision ' + fmt(piiFields.precision) + ' | recall ' + fmt(piiFields.recall) + ' (tp ' + piiFields.tp + ', fp ' + piiFields.fp + ', fn ' + piiFields.fn + ')');
  console.log('Redaction : box precision ' + fmt(screen.boxPrecision) + ' | recall ' + fmt(screen.boxRecall) + ' | in-GT pixels ' + fmt(screen.inBoxAvg) + ' | outside ' + fmt(screen.outsideDelta, 4));
  console.log('Faces     : ' + face.faces + ' detected (score ' + face.scores.join(', ') + ') | infer ' + face.inferMs + ' ms WASM | box pixels ' + fmt(face.faceBoxPixelChanged));
  if (!e2e.skipped) console.log('E2E       : ' + e2e.latencyMs + ' ms | fills OK ' + e2e.fillOK + ' | click OK ' + e2e.clickOK + ' | done ' + e2e.doneDeclared + ' | audit-clean ' + e2e.auditOnPayload);
  console.log('Wrote report.md / report.json (' + report.elapsedSec + 's)');
}

function renderMarkdown(r) {
  const M = r.metrics;
  const lines = [];
  lines.push('# SIH Evaluation Report — On-device Visual Perception for Light-weight Browser Agents');
  lines.push('');
  lines.push(`Generated: ${r.generatedAt} · Overall score: **${r.overall}/100** ${r.overallLabel || ''}`);
  lines.push('');
  lines.push('## Metric scores');
  lines.push('');
  lines.push('| Metric | Weight | Score | Key numbers |');
  lines.push('|---|---|---|---|');
  const M2 = M.M2_piiDetection, M3 = M.M3_redaction, M4 = M.M4_resources, M5 = M.M5_e2eLatency;
  lines.push(`| M1 Visual context accuracy | 25% | **${M.M1_visualContext.score}** | category accuracy ${M.M1_visualContext.categoryAccuracy}, mean element IoU ${M.M1_visualContext.meanElementIoU} |`);
  lines.push(`| M2 PII detection P/R | 20% | **${M2.score}** | text: P ${M2.text.precision} / R ${M2.text.recall} (${M2.text.tp}TP ${M2.text.fp}FP ${M2.text.fn}FN) · fields: P ${M2.fields.precision} / R ${M2.fields.recall} (${M2.fields.tp}TP ${M2.fields.fp}FP ${M2.fields.fn}FN) |`);
  lines.push(`| M3 Redaction precision | 20% | **${M3.score}** | box P ${M3.boxPrecision} / R ${M3.boxRecall}, ${(M3.pixelsChangedInsideGT * 100).toFixed(1)}% pixels changed inside GT boxes, ${(M3.pixelsChangedOutsideGT * 100).toFixed(3)}% outside |`);
  lines.push(`| M4 Resource utilization | 20% | **${M4.score}** | model ${(M4.modelBytes / 1024).toFixed(0)} KB, payload ${M4.payloadKB} KB, DOM ${M4.domMs.toFixed(0)} ms, face ${M4.faceMs.toFixed(0)} ms |`);
  lines.push(`| M5 End-to-end latency | 15% | ${M5.score == null ? '_skipped_' : '**' + M5.score + '**'} | ${M5.latencyMs == null ? M5.error || '' : M5.latencyMs + ' ms/tick, fills OK=' + M5.fillOK + ', click OK=' + M5.clickOK + ', done=' + M5.doneDeclared} |`);
  lines.push('');
  lines.push('## Notes');
  lines.push('');
  for (const n of M4.notes) lines.push('- ' + n);
  lines.push('- Face inference measured with the WASM backend in Node (browser uses WebGPU when available — typically 3–6× faster).');
  if (M5.score != null) lines.push('- End-to-end tick measured against the live planner (' + M5.planMode + ' mode); payload re-audited server-side and found clean: ' + M5.auditOnPayload + '.');
  lines.push('');
  lines.push('## Text fixture detail');
  lines.push('');
  lines.push('| fixture | expected | found | ok |');
  lines.push('|---|---|---|---|');
  for (const d of r.detail.textFixtures) lines.push(`| ${d.text.replace(/\|/g, '\\|')} | ${d.expected} | ${d.found} (${d.foundDetail.join(', ')}) | ${d.ok ? '✅' : '❌'} |`);
  lines.push('');
  lines.push('## Field fixture detail (PII classification)');
  lines.push('');
  lines.push('| scenario | field | expected | got | verdict |');
  lines.push('|---|---|---|---|---|');
  for (const d of r.detail.fieldFixtures) lines.push(`| ${d.scenario} | ${d.label} | ${d.expected} | ${d.got || '—'} | ${d.verdict} |`);
  lines.push('');
  lines.push('## Screen pipeline detections');
  lines.push('');
  for (const d of r.detail.screenDetections) lines.push(`- ${d.category} @ ${d.conf} (${d.source})`);
  lines.push('');
  lines.push('## Face detection');
  lines.push('');
  lines.push(`- ${r.detail.face.faces} face(s) found on the sample portrait, scores [${r.detail.face.scores.join(', ')}], WASM inference ${r.detail.face.inferMs} ms, ${(r.detail.face.faceBoxPixelChanged * 100).toFixed(1)}% of face-box pixels altered by redaction.`);
  return lines.join('\n');
}

main().catch(e => { console.error('eval failed:', e); process.exit(1); });
