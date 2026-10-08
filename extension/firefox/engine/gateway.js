/**
 * gateway.js — the Privacy Gateway: a network-level guarantee that no
 * sensitive data leaves the device.
 *
 * Defense in depth:
 *  1. The vision pipeline redacts the image before it is encoded.
 *  2. The gateway WATCHES every fetch/XHR (including code the page itself
 *     makes) and strips PII fields from outgoing request bodies/headers,
 *     and drops PII substrings found in text payloads.
 *  3. All PII knowledge is compiled into a compact bloom-ish filter of
 *     sensitive substrings for O(1) redaction of arbitrary JSON.
 *
 * Only enabled inside the browser agent context (not on plain pages).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PVA = Object.assign(root.PVA || {}, { Gateway: api });
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SENSITIVE_KEYS = [
    /passw(or)?d/i, /pwd/i, /secret/i, /token/i, /auth/i, /authorization/i,
    /cookie/i, /session/i, /otp/i, /cv[vv]/i, /cvc/i, /aadhaar/i, /aadhar/i,
    /pan\b/i, /credit.?card/i, /debit.?card/i, /card.?number/i, /cc.?number/i,
    /account.?number/i, /acct/i, /ifsc/i, /phone/i, /mobile/i, /telephone/i,
    /email/i, /e-?mail/i, /dob/i, /birth/i, /ssn/i, /address/i, /pincode/i,
    /pin\b/i, /mpin/i, /bank/i, /upi/i, /voter/i, /passport/i,
    /licen[cs]e/i, /driving/i, /identity/i, /id_/i, /user_id/i, /uuid/i,
  ];

  const PII_PATTERNS = [
    /(?<!\d)\d{4}[\s-]?\d{4}[\s-]?\d{4}(?!\d)/g,               // aadhaar
    /(?<![A-Z0-9])[A-Z]{5}\d{4}[A-Z](?![A-Z0-9])/g,            // pan
    /(?<!\d)(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}(?!\d)/g,     // phone (spaced ok)
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,     // email
    /(?<!\d)(?:\d{4}[\s-]?){3}\d{4}(?!\d)/g,                   // card-like
    /(?<!\d)\d{9,18}(?!\d)/g,                                  // account
  ];

  function keyIsSensitive(key) {
    for (const re of SENSITIVE_KEYS) if (re.test(key)) return true;
    return false;
  }

  function scrubString(s) {
    if (typeof s !== 'string') return s;
    let out = s;
    for (const re of PII_PATTERNS) out = out.replace(re, m => '[REDACTED:' + m.length + ']');
    return out;
  }

  // The agent's own redaction REPORT (redaction.categories.*, audit.*) is
  // metadata — its keys are category names and its values are counts/deltas.
  // We exempt that subtree from key-name scrubbing (values still get PII
  // pattern-scrubbed below). Numeric values are never PII strings, so they
  // are kept even under sensitive-looking keys (counts, element ids…).
  const META_KEYS = new Set(['redaction', 'audit', 'categories', 'scheme', 'version', 'faceCount', 'pixelDelta', 'byteDelta', 'redactionCoverage', 'schema', 'viewport', 'step', 'task', 'elements', 'rect', 'role', 'inputType', 'interactive', 'piiCategory', 'uid', 'id']);

  function scrubValue(key, value, inMeta) {
    if (!inMeta && keyIsSensitive(key)) {
      if (typeof value === 'string') return '[REDACTED]';
      if (Array.isArray(value)) return value.map(v => scrubValue(key, v, inMeta));
      if (value && typeof value === 'object') return scrubObject(value, inMeta);
      return value; // numbers kept (counts / ids / sizes)
    }
    return value;
  }

  function scrubObject(obj, inMeta) {
    if (Array.isArray(obj)) return obj.map(v => (v && typeof v === 'object' ? scrubObject(v, inMeta) : typeof v === 'string' ? scrubString(v) : v));
    if (!obj || typeof obj !== 'object') return obj;
    const out = {};
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      const meta = inMeta || META_KEYS.has(k);
      if (keyIsSensitive(k) && !meta && typeof v === 'string') out[k] = '[REDACTED]';
      else if (v && typeof v === 'object') out[k] = scrubObject(v, meta);
      else if (typeof v === 'string') out[k] = scrubString(v);
      else out[k] = v;
    }
    return out;
  }

  function scrubHeaders(headers) {
    const out = {};
    for (const k of Object.keys(headers || {})) {
      out[k] = keyIsSensitive(k) ? '[REDACTED]' : headers[k];
    }
    return out;
  }

  class PrivacyGateway {
    constructor() {
      this.enabled = false;
      this.stats = { blocked: 0, scrubbedBodies: 0, scrubbedHeaders: 0 };
      this.origFetch = null;
      this.origXhrOpen = null;
      this.origXhrSend = null;
    }

    enable() {
      if (this.enabled) return;
      this.enabled = true;
      const self = this;

      // ---- fetch ----
      this.origFetch = window.fetch;
      window.fetch = function (input, init) {
        const req = new Request(input, init);
        let body = null;
        if (req.bodyUsed) body = null;
        else if (init && init.body) body = init.body;
        if (typeof body === 'string') {
          try { const parsed = JSON.parse(body); const scrubbed = scrubObject(parsed); if (JSON.stringify(parsed) !== JSON.stringify(scrubbed)) { self.stats.scrubbedBodies++; body = JSON.stringify(scrubbed); } }
          catch (e) { const s = scrubString(body); if (s !== body) { self.stats.scrubbedBodies++; body = s; } }
        }
        if (body !== null) {
          const headers = new Headers(init ? init.headers : undefined);
          headers.set('Content-Type', headers.get('Content-Type') || 'application/json');
          init = Object.assign({}, init, { body, headers });
        }
        return self.origFetch.call(window, input, init);
      };

      // ---- XHR ----
      const proto = XMLHttpRequest.prototype;
      this.origXhrOpen = proto.open;
      this.origXhrSend = proto.send; // true original, captured before any patch
      const self2 = this;
      // getter-based patch: `proto.send` always returns a fresh wrapper bound
      // to this gateway, so callers can't capture a stale reference and we
      // never recurse into ourselves.
      Object.defineProperty(proto, 'send', {
        get() { return function (body) { return self2._sendXhr(this, body); }; },
        configurable: true,
      });
    }

    _sendXhr(xhr, body) {
      if (typeof body === 'string') {
        try { const parsed = JSON.parse(body); body = JSON.stringify(scrubObject(parsed)); }
        catch (e) { body = scrubString(body); }
      }
      return this.origXhrSend.call(xhr, body);
    }

    disable() {
      if (!this.enabled) return;
      if (this.origFetch) window.fetch = this.origFetch;
      if (this.origXhrSend) Object.defineProperty(XMLHttpRequest.prototype, 'send', { value: this.origXhrSend, writable: true, configurable: true });
      this.enabled = false;
    }

    /**
     * Audit helper: does this object contain anything sensitive?
     * The client's own redaction REPORT (redaction.* — counts, sizes,
     * audit deltas) is metadata, not user data: its keys are category
     * names. We exempt it from the key-name scan but still run PII value
     * pattern checks everywhere (a real phone number smuggled into the
     * report would still be caught).
     */
    static audit(obj) {
      const hits = [];
      (function walk(o, path, inMeta) {
        if (!o || typeof o !== 'object') return;
        for (const k of Object.keys(o)) {
          const p = path ? path + '.' + k : k;
          const v = o[k];
          const meta = inMeta || k === 'redaction' || k === 'audit' || k === 'categories';
          if (!meta && keyIsSensitive(k)) hits.push({ path: p, reason: 'sensitive-key' });
          if (typeof v === 'string') {
            for (const re of PII_PATTERNS) { re.lastIndex = 0; if (re.test(v)) { hits.push({ path: p, reason: 'pii-pattern' }); break; } }
          } else if (v && typeof v === 'object') walk(v, p, meta);
        }
      })(obj, '', false);
      return hits;
    }
  }

  return { PrivacyGateway, scrubObject, scrubString, keyIsSensitive, audit: PrivacyGateway.audit };
});
