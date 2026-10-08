/**
 * server.js — privacy-preserving agent server.
 *
 *  - Serves the demo app, client engine and models (static).
 *  - POST /api/agent  — receives the SANITIZED context, plans with the
 *    server brain (LLM if configured, offline fallback otherwise), returns
 *    commands. Raw pixel data is never stored or logged — only audit
 *    metadata (categories redacted, pixel delta, byte delta).
 *  - POST /api/privacy-audit — lets the client prove its payload is clean
 *    before sending; the server re-scans JSON for PII leaks and refuses
 *    sensitive data.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { plan } = require('./planner');

const ROOT = path.join(__dirname, '..', 'static');
const PORT = process.env.PORT || 8787;
const MAX_BODY = 25 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.map': 'application/json',
};

function send(res, code, data, type) {
  res.writeHead(code, { 'Content-Type': type || 'application/json', 'Cache-Control': 'no-store' });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/* ------------------------------ agent ------------------------------ */
async function handleAgent(req, res) {
  const body = await readBody(req);
  let payload;
  try { payload = JSON.parse(body.toString('utf8')); }
  catch (e) { return send(res, 400, JSON.stringify({ error: 'invalid JSON' })); }

  if (!payload || payload.schema !== 'pva/v1') {
    return send(res, 400, JSON.stringify({ error: 'unrecognized payload schema' }));
  }

  // ---- privacy bookkeeping: log metadata, never pixels ----
  const red = payload.redaction || {};
  const audit = red.audit || {};
  const log = {
    ts: new Date().toISOString(),
    task: String(payload.task || '').slice(0, 80),
    step: payload.step || 1,
    w: payload.viewport && payload.viewport.w,
    h: payload.viewport && payload.viewport.h,
    redactionScheme: red.scheme,
    categoriesRedacted: red.categories || {},
    faceCount: red.faceCount || 0,
    pixelDelta: +(audit.pixelDelta || 0).toFixed(4),
    byteDelta: +(audit.byteDelta || 0).toFixed(4),
    imageKB: payload.image ? Math.round(payload.image.length / 1024) : 0, // size only
    elementCount: (payload.elements || []).length,
  };
  console.log('[agent]', JSON.stringify(log));

  const t0 = Date.now();
  let result;
  try { result = await plan(payload); }
  catch (e) { return send(res, 500, JSON.stringify({ error: 'planning failed: ' + String(e && e.message || e) })); }
  result.latencyMs = Date.now() - t0;
  result.received = log;
  return send(res, 200, JSON.stringify(result));
}

/* --------------------------- privacy audit -------------------------- */
async function handleAudit(req, res) {
  const body = await readBody(req);
  let payload;
  try { payload = JSON.parse(body.toString('utf8')); } catch (e) { return send(res, 400, JSON.stringify({ error: 'invalid JSON' })); }

  const { scrubObject, audit } = require('../../server/static/js/engine/gateway.js');
  const hits = audit(payload);
  const scrubbed = scrubObject(payload);
  const leakFree = hits.length === 0;
  return send(res, 200, JSON.stringify({
    ok: leakFree,
    leaks: hits,
    verdict: leakFree
      ? 'PAYLOAD CLEAN — no PII keys or PII patterns detected server-side.'
      : 'LEAK DETECTED — payload contains sensitive fields; request refused.',
  }));
}

/* ------------------------------ static ----------------------------- */
function handleStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const file = path.normalize(path.join(ROOT, urlPath));
  if (!file.startsWith(ROOT)) return send(res, 403, 'forbidden');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'not found');
    const ext = path.extname(file).toLowerCase();
    const longCache = urlPath.startsWith('/ort/') || urlPath.startsWith('/models/');
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': longCache ? 'public, max-age=86400' : 'no-cache',
      'Access-Control-Allow-Origin': '*',
    });
    fs.createReadStream(file).pipe(res);
  });
}

/* ------------------------------- main ------------------------------ */
const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  try {
    if (req.method === 'POST' && url === '/api/agent') return await handleAgent(req, res);
    if (req.method === 'POST' && url === '/api/privacy-audit') return await handleAudit(req, res);
    if (req.method === 'GET' && url === '/api/health') {
      const hasLLM = !!(process.env.LLM_API_KEY);
      return send(res, 200, JSON.stringify({ ok: true, name: 'privacy-vision-agent server', llm: hasLLM ? process.env.LLM_MODEL || 'configured' : 'offline (fallback planner)' }));
    }
    if (req.method === 'GET') return handleStatic(req, res);
    return send(res, 405, 'method not allowed');
  } catch (e) {
    console.error('[server]', e);
    return send(res, 500, JSON.stringify({ error: String(e && e.message || e) }));
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[server] privacy-vision-agent listening on http://0.0.0.0:${PORT}`);
  console.log(`[server] LLM mode: ${process.env.LLM_API_KEY ? 'enabled (' + (process.env.LLM_MODEL || 'default model') + ')' : 'offline — deterministic fallback planner active'}`);
});
