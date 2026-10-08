/**
 * client.js — the on-device agent loop.
 *
 *   extract → render → engine.process (redact) → gateway-guarded POST
 *   → execute commands → repeat until `done`
 *
 * All heavy vision work happens in THIS file's process (the tab/browser),
 * never on the server.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PVA = Object.assign(root.PVA || {}, { Client: api });
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULTS = {
    serverUrl: '/api/agent',
    captureScale: 1,
    pollMs: 2000,
    autoStart: false,
    sendImage: true,
    redactionStrategy: 'blur',
    faceStrategy: 'blur',
    enableFace: true,
    task: null,
    maxSteps: 40,
    stepTimeoutMs: 20000,
    debug: false,
  };

  class Agent {
    constructor(ort, opts) {
      this.ort = ort;
      this.opts = Object.assign({}, DEFAULTS, opts || {});
      this.engine = new PVA.VisionEngine({
        redactionStrategy: this.opts.redactionStrategy,
        faceStrategy: this.opts.faceStrategy,
        enableFaceDetection: this.opts.enableFace,
        debug: this.opts.debug,
      });
      this.gateway = new PVA.Gateway.PrivacyGateway();
      this.state = 'idle';          // idle | loading | running | paused | done | error
      this.step = 0;
      this.elements = new Map();    // uid -> DOM node
      this.history = [];
      this.telemetry = [];
      this._timer = null;
      this._task = this.opts.task;
      this._doneResolvers = [];
      this._busy = false;
    }

    /* ---------- lifecycle ---------- */

    async start() {
      if (this.state === 'running') return;
      this.gateway.enable();
      this.state = 'loading';
      this._emit('state', this.state);
      await this.engine.ensureFaceModel(this.ort, PVA.MODELS.yunet);
      this.state = 'running';
      this._emit('state', this.state);
      this._loop();
    }

    pause() { this.state = 'paused'; this._emit('state', this.state); }

    resume() { if (this.state === 'paused') { this.state = 'running'; this._emit('state', this.state); this._loop(); } }

    stop() { this.state = 'done'; if (this._timer) clearTimeout(this._timer); this._emit('state', this.state); }

    setTask(t) { this._task = t; this.step = 0; }

    /** Single-shot analyze (no command execution) — used by the demo UI. */
    async analyzeOnce(opts) {
      opts = opts || {};
      const win = this.opts.win || window, doc = this.opts.doc || document;
      await this.engine.ensureFaceModel(this.ort, PVA.MODELS.yunet);
      const ex = PVA.Extractor.extract({ doc, win, maxElements: 400 });
      const canvas = doc.createElement ? doc.createElement('canvas') : document.createElement('canvas');
      PVA.Renderer.render(canvas, { doc, win, scale: opts.captureScale || this.opts.captureScale });
      this.lastCanvas = canvas;
      const imageData = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
      const cleanElements = ex.elements.map(e => { const c = { ...e }; delete c.node; return c; });
      const task = typeof this.opts.getTask === 'function' ? this.opts.getTask() : this._task;
      const analysis = await this.engine.process({
        imageData, elements: cleanElements, viewport: ex.viewport,
        scale: this.opts.captureScale, task,
      });
      this._emit('analysis', analysis);
      if (opts.send) {
        const resp = await fetch(this.opts.serverUrl, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(analysis.payload),
        });
        this._emit('server', await resp.json());
      }
      return analysis;
    }

    /** Run a task to completion and resolve with the final report. */
    runTask(task, timeoutMs) {
      return new Promise((resolve, reject) => {
        this._task = task; this.step = 0;
        this._doneResolvers.push({ resolve, reject });
        const to = setTimeout(() => reject(new Error('task timeout')), timeoutMs || 180000);
        this._doneResolvers[this._doneResolvers.length - 1].timer = to;
        this.start().catch(reject);
      });
    }

    /* ---------- main loop ---------- */

    _loop() {
      if (this.state !== 'running' || this._busy) return;
      this._busy = true;
      const t0 = performance.now();
      this.tick().then(() => {
        this._busy = false;
        const took = performance.now() - t0;
        if (this.state === 'running') {
          this._timer = setTimeout(() => this._loop(), Math.max(200, this.opts.pollMs - took));
        }
      }).catch(err => {
        this._busy = false;
        this.state = 'error';
        this._emit('error', String(err && err.message || err));
        this._emit('state', this.state);
      });
    }

    async tick() {
      if (this.step >= this.opts.maxSteps) {
        this.state = 'done';
        this._emit('state', this.state);
        this._emit('error', 'max steps reached');
        return;
      }
      this.step++;

      // 1. extract structure + render snapshot (all local)
      const win = this.opts.win || window, doc = this.opts.doc || document;
      const ex = PVA.Extractor.extract({ doc, win, maxElements: 400, attachNodes: true });
      const canvas = doc.createElement ? doc.createElement('canvas') : document.createElement('canvas');
      PVA.Renderer.render(canvas, { doc, win, scale: this.opts.captureScale });
      this.lastCanvas = canvas;
      const ctx = canvas.getContext('2d');
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      this.elements = new Map();
      ex.elements.forEach(e => { if (e.node) this.elements.set(e.uid, e.node); });
      // strip node refs before analysis (they are not needed there)
      const cleanElements = ex.elements.map(e => { const c = { ...e }; delete c.node; return c; });

      // 2. vision pipeline (local redaction)
      const task = typeof this.opts.getTask === 'function' ? this.opts.getTask() : this._task;
      const analysis = await this.engine.process({
        imageData,
        elements: cleanElements,
        viewport: ex.viewport,
        scale: this.opts.captureScale,
        task,
        step: this.step,
      });
      this.lastAnalysis = analysis;
      this._emit('analysis', analysis);

      // 3. network (payload is sanitized; gateway re-checks)
      const payload = analysis.payload;
      if (this.opts.beforeSend) payload = this.opts.beforeSend(payload) || payload;
      const sendStart = performance.now();
      const resp = await fetch(this.opts.serverUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const networkMs = performance.now() - sendStart;
      if (!resp.ok) throw new Error('server error ' + resp.status);
      const data = await resp.json();

      // 4. execute commands
      const cmdStart = performance.now();
      const commands = (data && data.commands) || [];
      let taskComplete = !!(data && data.done);
      let commandNotes = [];
      for (const cmd of commands) {
        const r = await this._execute(cmd);
        commandNotes.push(r);
        if (cmd.action === 'done') taskComplete = true;
      }
      const execMs = performance.now() - cmdStart;

      this.history.push({ step: this.step, task, commands, ts: Date.now() });
      this.telemetry.push({
        step: this.step, t: Date.now(),
        timing: analysis.timing,
        networkMs, execMs,
        detections: analysis.counts,
        pixelDelta: analysis.audit.pixelDelta,
      });
      if (data && data.step) this._emit('step', data.step);
      this._emit('commands', { step: this.step, commands, notes: commandNotes });

      if (taskComplete) {
        this.state = 'done';
        this._emit('state', this.state);
        for (const r of this._doneResolvers) { clearTimeout(r.timer); r.resolve({ steps: this.history, telemetry: this.telemetry }); }
        this._doneResolvers = [];
      }
    }

    /* ---------- command execution (all local) ---------- */

    async _execute(cmd) {
      const action = cmd.action;
      try {
        switch (action) {
          case 'click': {
            const el = this._byUid(cmd.uid);
            if (!el) return { action, ok: false, error: 'element not found' };
            if (el.scrollIntoView) { try { el.scrollIntoView({ block: 'center', behavior: 'auto' }); } catch (e) {} }
            el.focus && el.focus();
            el.click && el.click();
            el.dispatchEvent && el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: this.opts.win || window }));
            return { action, ok: true, uid: cmd.uid };
          }
          case 'type': {
            const el = this._byUid(cmd.uid);
            if (!el) return { action, ok: false, error: 'element not found' };
            el.focus && el.focus();
            const tag = el.tagName;
            if (this.opts.debug) console.log('[PVA:type]', cmd.uid, tag, el.id || el.name || el.className, '->', cmd.text);
            if (tag === 'INPUT' || tag === 'TEXTAREA') {
              // The agent may live in a different realm (panel iframe) than
              // the target page — use the ELEMENT's own realm prototype so
              // the native setter works (also keeps React-friendly events).
              const win = el.ownerDocument.defaultView || window;
              const proto = (tag === 'INPUT' ? win.HTMLInputElement : win.HTMLTextAreaElement).prototype;
              const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
              if (setter) setter.call(el, String(cmd.text || ''));
              else el.value = String(cmd.text || '');
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              if (this.opts.debug) console.log('[PVA:type:done]', cmd.uid, 'value now:', el.value);
            } else if (el.isContentEditable) {
              el.textContent = String(cmd.text || '');
              el.dispatchEvent(new Event('input', { bubbles: true }));
            }
            return { action, ok: true, uid: cmd.uid };
          }
          case 'scroll': {
            const amt = cmd.amount != null ? cmd.amount : (cmd.direction === 'down' ? 600 : -600);
            const win = this.opts.win || window;
            win.scrollBy({ top: amt, behavior: 'auto' });
            return { action, ok: true, amount: amt };
          }
          case 'wait': return { action, ok: true, ms: cmd.ms || 500 };
          case 'open_url': { const win = this.opts.win || window; if (cmd.url) win.location.href = cmd.url; return { action, ok: true }; }
          case 'read': {
            const doc = this.opts.doc || document;
            const text = (doc.body.innerText || '').slice(0, 4000);
            this._emit('read', { step: this.step, text });
            return { action, ok: true, chars: text.length };
          }
          case 'done': return { action, ok: true };
          default: return { action, ok: false, error: 'unknown action ' + action };
        }
      } catch (e) {
        return { action, ok: false, error: String(e && e.message || e) };
      }
    }

    _byUid(uid) {
      return this.elements.get(uid) || null;
    }

    /* ---------- plumbing ---------- */

    _emit(name, data) {
      const cb = this.opts['on' + name[0].toUpperCase() + name.slice(1)];
      if (typeof cb === 'function') cb(data);
    }
  }

  return { Agent, DEFAULTS };
});
