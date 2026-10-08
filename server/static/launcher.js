/* launcher.js — an always-visible control bar for demo pages.
 *
 * The agent panel lives in an iframe that is hidden on narrow screens
 * (see the demo pages' @media rules). This bar puts the essential control —
 * "▶ Start Agent" — directly on the page so the demo works at ANY window
 * width. It also lets you force-open the stats panel with 📊.
 *
 * Protocol:
 *   page → panel : { type: 'pva:start' | 'pva:analyze' | 'pva:stop' }
 *   panel → page : { from: 'pva-panel', type: 'pva:state'|'pva:analysis', … }
 */
(function () {
  'use strict';
  const panel = document.getElementById('agentPanel');
  if (!panel) return; // not a demo page
  const mode = document.body.getAttribute('data-launcher-mode') || 'start'; // 'analyze' = one-shot

  const style = document.createElement('style');
  style.textContent =
    '.pva-launcher{position:fixed;left:14px;bottom:14px;z-index:2147483000;display:flex;align-items:center;gap:8px;' +
    'background:#0f172a;border:1px solid #334155;border-radius:999px;padding:8px 12px;box-shadow:0 8px 24px rgba(0,0,0,.35);' +
    'font-family:system-ui,Segoe UI,Roboto,sans-serif}' +
    '.pva-launcher .pva-start{background:#16a34a;color:#fff;border:0;border-radius:999px;padding:9px 18px;font-size:14px;font-weight:800;cursor:pointer}' +
    '.pva-launcher .pva-start:hover{background:#15803d}' +
    '.pva-launcher .pva-start:disabled{opacity:.6;cursor:default}' +
    '.pva-launcher .pva-pill{font-size:11.5px;font-weight:700;color:#94a3b8;text-transform:capitalize}' +
    '.pva-launcher .pva-pill.run{color:#4ade80}.pva-launcher .pva-pill.done{color:#22c55e}.pva-launcher .pva-pill.err{color:#f87171}' +
    '.pva-launcher .pva-toggle{background:#1e293b;border:1px solid #334155;color:#e2e8f0;border-radius:999px;padding:7px 12px;font-size:13px;cursor:pointer}' +
    '.pva-launcher .pva-detail{font-size:10.5px;color:#64748b;max-width:260px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}';
  document.head.appendChild(style);

  const bar = document.createElement('div');
  bar.className = 'pva-launcher';
  bar.innerHTML =
    '<button class="pva-start">▶ Start Agent</button>' +
    '<span class="pva-pill">idle</span>' +
    '<button class="pva-toggle" title="Show / hide the stats panel">📊</button>' +
    '<span class="pva-detail"></span>';
  document.body.appendChild(bar);

  const btnStart = bar.querySelector('.pva-start');
  const pill = bar.querySelector('.pva-pill');
  const detail = bar.querySelector('.pva-detail');
  const btnToggle = bar.querySelector('.pva-toggle');

  function send(m) { try { panel.contentWindow.postMessage(m, '*'); } catch (e) {} }

  btnStart.addEventListener('click', function () {
    if (btnStart.disabled) return;
    btnStart.disabled = true;
    btnStart.textContent = 'Running…';
    pill.textContent = 'starting…';
    pill.className = 'pva-pill run';
    detail.textContent = '';
    send({ type: mode === 'analyze' ? 'pva:analyze' : 'pva:start' });
  });

  let best = { faces: 0, pii: 0, delta: 0 }; // most informative analysis so far

  btnToggle.addEventListener('click', function () {
    // the @media rule hides the panel via the stylesheet, so read the
    // COMPUTED style to decide — then override with an inline style.
    const hidden = getComputedStyle(panel).display === 'none';
    panel.style.display = hidden ? 'block' : 'none';
    btnToggle.textContent = hidden ? '✕ close' : '📊 stats';
  });

  window.addEventListener('message', function (ev) {
    const d = ev.data || {};
    if (d.from !== 'pva-panel') return;
    if (d.type === 'pva:state') {
      const s = d.state;
      if (s === 'done') { pill.textContent = 'done ✓'; pill.className = 'pva-pill done'; }
      else if (s === 'error') { pill.textContent = 'error'; pill.className = 'pva-pill err'; }
      else if (s === 'running') { pill.textContent = 'running…'; pill.className = 'pva-pill run'; }
      else { pill.textContent = s; pill.className = 'pva-pill'; }
      if (s === 'done' || s === 'error') {
        btnStart.disabled = false;
        btnStart.textContent = '▶ Start Agent';
      }
    } else if (d.type === 'pva:analysis') {
      const counts = d.counts || {};
      const faces = counts.face || 0;
      const pii = Object.keys(counts).filter(k => k !== 'face').length;
      const delta = d.pixelDelta != null ? d.pixelDelta : 0;
      // keep the most informative snapshot (later steps may be empty)
      if (faces + pii >= best.faces + best.pii) best = { faces, pii, delta };
      detail.textContent = 'faces ' + best.faces + ' · PII ' + best.pii + ' type(s) · ' + Math.round(best.delta * 1000) / 10 + '% pixels redacted';
      if (mode === 'analyze' && !btnStart.disabled) {
        btnStart.disabled = false;
        btnStart.textContent = '▶ Analyze again';
        pill.textContent = 'analyzed ✓';
        pill.className = 'pva-pill done';
      }
    }
  });
})();
