/* content.js — Privacy Vision Agent in-page panel (isolated world).
 *
 * The engine + ONNX Runtime Web are injected via the manifest's
 * content_scripts list, so `PVA` and `ort` exist here. Everything the
 * agent sees and sends is produced locally:
 *
 *   1. extract  — DOM element descriptors (labels only, never values)
 *   2. render   — page → canvas snapshot (stays on device)
 *   3. process  — face (YuNet) + PII detection, then redaction
 *   4. send     — only the *redacted* payload to the agent server
 *
 * The PrivacyGateway (loaded above) additionally scrubs every fetch/XHR
 * made from this world, so even non-agent code can't leak PII.
 */
(function () {
  'use strict';
  if (window.__PVA_EXT_LOADED__) return;
  window.__PVA_EXT_LOADED__ = true;

  var PVA = window.PVA;
  var ort = window.ort;
  if (!PVA || !ort) return; // not injected (extension pages, restricted schemes)
  if (!/^https?:$/.test(location.protocol)) return;

  var api = (typeof browser !== 'undefined' && browser.runtime) ? browser : (window.chrome || {});
  var getURL = function (p) { return (api.runtime && api.runtime.getURL) ? api.runtime.getURL(p) : p; };

  // ---- ONNX Runtime Web: wasm served from the extension (no CDN) ----
  try {
    ort.env.wasm.wasmPaths = getURL('vendor/ort/');
    ort.env.wasm.numThreads = 1; // avoids cross-origin-isolation requirement
  } catch (e) { /* keep defaults */ }
  PVA.MODELS = PVA.MODELS || {};
  PVA.MODELS.yunet = getURL('vendor/models/yunet.onnx');

  var DEFAULTS = {
    serverUrl: 'http://127.0.0.1:8787/api/agent',
    task: 'Fill the insurance claim form with demo details and submit',
    redactionStrategy: 'blur',
  };

  /* ---------------- shadow-DOM panel ---------------- */

  var host = document.createElement('div');
  host.id = '__pva-host__';
  var shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML =
    '<style>' +
    ':host{all:initial}' +
    '*{box-sizing:border-box;font-family:ui-sans-serif,system-ui,Segoe UI,Roboto,sans-serif}' +
    '.fab{position:fixed;right:14px;bottom:14px;z-index:2147483646;width:44px;height:44px;border-radius:50%;' +
    'border:1px solid #4338ca33;background:#1e3a8a;color:#fff;font-size:20px;cursor:pointer;box-shadow:0 4px 14px rgba(30,58,138,.35)}' +
    '.panel{position:fixed;right:14px;bottom:66px;z-index:2147483647;width:330px;max-height:72vh;overflow:auto;' +
    'background:#fff;border:1px solid #e2e8f0;border-radius:14px;box-shadow:0 10px 40px rgba(15,23,42,.25);' +
    'padding:14px;display:none}' +
    '.panel.open{display:block}' +
    '.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}' +
    'h3{margin:0 0 8px;font-size:14px;color:#1e3a8a}' +
    '.badge{display:inline-block;padding:2px 10px;border-radius:999px;font-size:11px;font-weight:700;background:#e2e8f0;color:#475569}' +
    '.b-run{background:#dcfce7;color:#166534}.b-done{background:#dbeafe;color:#1e40af}' +
    '.b-err{background:#fee2e2;color:#991b1b}.b-loading{background:#fef9c3;color:#854d0e}' +
    'input,select{width:100%;padding:7px 9px;border:1px solid #cbd5e1;border-radius:8px;font-size:12px;margin:4px 0}' +
    'button{padding:6px 12px;border:0;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;background:#1e3a8a;color:#fff}' +
    'button:disabled{opacity:.45;cursor:default}' +
    'button.sec{background:#e2e8f0;color:#334155}' +
    '.stat{display:flex;justify-content:space-between;font-size:11.5px;color:#475569;border-top:1px solid #f1f5f9;padding:3px 0}' +
    '.log{max-height:130px;overflow:auto;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:6px 8px;' +
    'font-size:11px;color:#334155;margin-top:8px}' +
    '.log div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.note{font-size:10.5px;color:#64748b;margin-top:8px;line-height:1.45}' +
    '</style>' +
    '<button class="fab" title="Privacy Vision Agent">🛡</button>' +
    '<div class="panel">' +
    '  <h3>Privacy Vision Agent <span class="badge b-idle" id="pva-state">idle</span></h3>' +
    '  <label style="font-size:11px;color:#64748b">Task</label>' +
    '  <input id="pva-task" placeholder="What should the agent do on this page?" />' +
    '  <div class="row">' +
    '    <label style="font-size:11px;color:#64748b">Redaction</label>' +
    '    <select id="pva-strategy" style="width:110px"><option value="blur">blur</option><option value="solid">solid</option></select>' +
    '    <button id="pva-start">▶ Start</button><button id="pva-pause" class="sec" disabled>⏸</button>' +
    '  </div>' +
    '  <div class="stat"><span>Faces redacted</span><b id="pva-faces">—</b></div>' +
    '  <div class="stat"><span>PII types</span><b id="pva-pii">—</b></div>' +
    '  <div class="stat"><span>Pixel delta</span><b id="pva-delta">—</b></div>' +
    '  <div class="stat"><span>Payload size</span><b id="pva-size">—</b></div>' +
    '  <div class="stat"><span>Gateway scrubbed</span><b id="pva-gw">—</b></div>' +
    '  <div class="stat"><span>Server commands</span><b id="pva-cmds">—</b></div>' +
    '  <div class="log" id="pva-log"><div class="note">Nothing sent yet. When the agent starts, the page is analyzed locally; only the redacted snapshot + labels go to the server.</div></div>' +
    '</div>';

  (document.body || document.documentElement).appendChild(host);
  var $ = function (id) { return shadow.getElementById('pva-' + id); };
  var panel = shadow.querySelector('.panel');
  var fab = shadow.querySelector('.fab');
  fab.addEventListener('click', function () { panel.classList.toggle('open'); });

  /* ---------------- agent ---------------- */

  var agent = null;
  var setState = function (s) {
    var b = $('state');
    b.textContent = s;
    b.className = 'badge b-' + (s === 'running' ? 'run' : s === 'error' ? 'err' : s === 'done' ? 'done' : s === 'loading' ? 'loading' : 'idle');
    $('start').disabled = s === 'running' || s === 'loading';
    $('pause').disabled = s !== 'running';
    $('pause').textContent = s === 'running' ? '⏸' : '▶';
  };
  var log = function (msg) {
    var box = $('log');
    var d = document.createElement('div');
    d.textContent = msg;
    box.prepend(d);
    while (box.children.length > 60) box.removeChild(box.lastChild);
  };

  function buildAgent() {
    agent = new PVA.Client.Agent(ort, {
      serverUrl: DEFAULTS.serverUrl,
      captureScale: 1,
      pollMs: 1500,
      sendImage: true,
      redactionStrategy: $('strategy').value,
      faceStrategy: $('strategy').value,
      enableFace: true,
      maxSteps: 40,
      debug: false,
      getTask: function () { return $('task').value || DEFAULTS.task; },
      onState: function (s) { setState(s); },
      onError: function (e) { log('⚠ ' + e); },
      onAnalysis: function (a) {
        var c = a.counts || {};
        var faceN = c.face || 0;
        var piiN = Object.keys(c).filter(function (k) { return k !== 'face'; }).length;
        $('faces').textContent = faceN;
        $('pii').textContent = piiN + ' type(s)';
        $('delta').textContent = ((a.audit && a.audit.pixelDelta || 0) * 100).toFixed(1) + '%';
        $('size').textContent = a.redacted ? (a.redacted.bytes / 1024).toFixed(1) + ' KB' : '—';
        $('gw').textContent = (agent.gateway.stats.scrubbedBodies + agent.gateway.stats.scrubbedHeaders) + ' req(s)';
        log('🔎 ' + faceN + ' face(s), ' + piiN + ' PII type(s), ' + ((a.audit && a.audit.pixelDelta || 0) * 100).toFixed(1) + '% pixels redacted');
      },
      onCommands: function (d) {
        var n = (d.commands || []).length;
        $('cmds').textContent = n + ' (step ' + d.step + ')';
        (d.commands || []).slice(0, 4).forEach(function (c) {
          log('▶ ' + c.action + (c.uid != null ? ' #' + c.uid : '') + (c.text ? ' "' + String(c.text).slice(0, 24) + '"' : ''));
        });
        if (d.commands && d.commands.length === 0) log('… waiting');
      },
      onServer: function (r) {
        log('☁ ' + (r && r.mode || '?') + (r && r.done ? ' · done ✓' : ''));
      },
    });
    agent.gateway.enable();
    setState(agent.state);
  }

  $('start').addEventListener('click', function () {
    if (!agent) buildAgent();
    if (agent.state === 'running' || agent.state === 'loading') return;
    agent.setTask($('task').value || DEFAULTS.task);
    agent.start().catch(function (e) { log('⚠ ' + e); });
  });
  $('pause').addEventListener('click', function () {
    if (!agent) return;
    if (agent.state === 'running') { agent.pause(); log('⏸ paused'); }
    else if (agent.state === 'paused') { agent.resume(); log('▶ resumed'); }
  });
  $('strategy').addEventListener('change', function () { if (agent) agent.opts.redactionStrategy = $('strategy').value; });

  // load saved settings
  if (api.storage && api.storage.local) {
    api.storage.local.get(DEFAULTS, function (d) {
      if (d && d.task) { $('task').value = d.task; DEFAULTS.task = d.task; }
      if (d && d.serverUrl) DEFAULTS.serverUrl = d.serverUrl;
    });
  }

  /* ---------------- popup messaging ---------------- */

  function statusOf() {
    var a = agent;
    var c = (a && a.lastAnalysis && a.lastAnalysis.counts) || {};
    return {
      state: a ? a.state : 'idle',
      faces: c.face || 0,
      pii: Object.keys(c).filter(function (k) { return k !== 'face'; }).length,
      delta: (a && a.lastAnalysis && a.lastAnalysis.audit) ? a.lastAnalysis.audit.pixelDelta : 0,
      gw: a ? (a.gateway.stats.scrubbedBodies + a.gateway.stats.scrubbedHeaders) : 0,
    };
  }

  if (api.runtime && api.runtime.onMessage) {
    api.runtime.onMessage.addListener(function (msg, sender, respond) {
      if (!msg || !msg.type || msg.type.indexOf('pva:') !== 0) return;
      try {
        if (msg.type === 'pva:configure') {
          if (msg.serverUrl) DEFAULTS.serverUrl = msg.serverUrl;
          if (msg.task) { DEFAULTS.task = msg.task; $('task').value = msg.task; }
          if (msg.strategy) $('strategy').value = msg.strategy;
          if (api.storage && api.storage.local) api.storage.local.set(DEFAULTS, function () {});
          respond({ ok: true });
        } else if (msg.type === 'pva:start') {
          if (!agent) buildAgent();
          agent.setTask($('task').value || DEFAULTS.task);
          agent.start().catch(function (e) { log('⚠ ' + e); });
          respond(statusOf());
        } else if (msg.type === 'pva:stop') {
          if (agent) agent.stop();
          respond(statusOf());
        } else if (msg.type === 'pva:status') {
          respond(statusOf());
        }
      } catch (e) { respond({ ok: false, error: String(e) }); }
      return true;
    });
  }
})();
