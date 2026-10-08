/**
 * planner.js — server-side interpretation layer ("the brain").
 *
 * Two modes:
 *   1. LLM/VLM mode  — when LLM_API_KEY is set, the sanitized context
 *      (structure + redacted screenshot + audit) is sent to an
 *      OpenAI-compatible chat model which returns structured commands.
 *   2. Fallback mode — fully offline deterministic planner that reads the
 *      redacted structure map and produces commands for the demo tasks.
 *
 * The server NEVER sees unredacted pixels: it only receives the payload the
 * client produced (masked/blurred image + structure). Redaction metadata is
 * logged, not the image content.
 */
'use strict';

const fs = require('fs');
const path = require('path');

/* ------------------------------------------------------------------ */
/* Command grammar (validated before anything is executed client-side) */
/* ------------------------------------------------------------------ */
const ACTIONS = new Set(['click', 'type', 'clear', 'scroll', 'wait', 'read', 'open_url', 'done']);
const MAX_TYPE_LEN = 200;
const MAX_SCROLL = 5000;
const MAX_COMMANDS = 8;

function validateCommands(cmds, payload) {
  if (!Array.isArray(cmds)) return [];
  const uids = new Set((payload.elements || []).map(e => e.id != null ? e.id : e.uid));
  const out = [];
  for (const raw of cmds.slice(0, MAX_COMMANDS)) {
    const c = raw || {};
    const action = String(c.action || '').toLowerCase();
    if (!ACTIONS.has(action)) continue;
    const cmd = { action };
    if (action === 'click' || action === 'clear' || action === 'type') {
      const uid = c.uid != null ? c.uid : c.id;
      if (uid == null || !uids.has(uid)) continue;   // only known elements!
      cmd.uid = uid;
      if (action === 'type') {
        cmd.text = String(c.text == null ? '' : c.text).slice(0, MAX_TYPE_LEN);
        if (!cmd.text) continue;
      }
    } else if (action === 'scroll') {
      const amount = Number(c.amount);
      cmd.amount = Number.isFinite(amount) ? Math.max(-MAX_SCROLL, Math.min(MAX_SCROLL, amount)) : 600;
      cmd.direction = c.direction === 'up' ? 'up' : 'down';
    } else if (action === 'wait') {
      cmd.ms = Math.max(0, Math.min(20000, Number(c.ms) || 500));
    } else if (action === 'open_url') {
      cmd.url = String(c.url || '').slice(0, 2000);
      if (!/^https?:\/\//i.test(cmd.url)) continue;
    }
    out.push(cmd);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Element helpers                                                      */
/* ------------------------------------------------------------------ */
function elementsOf(payload) {
  return (payload.elements || []).map((e, i) => Object.assign({}, e, { uid: e.id != null ? e.id : i }));
}

function findEl(elements, pred) {
  for (const e of elements) if (pred(e)) return e;
  return null;
}

const textOf = e => String(e.text || '').trim();

function matchText(e, re) { return re.test(textOf(e)); }

function findByLabel(elements, re) {
  // prefer interactive fields; non-interactive label wrappers are last resort
  const fields = elements.filter(e => e.role === 'input' || e.role === 'textarea' || e.role === 'select');
  return findEl(fields.filter(e => e.interactive), e => matchText(e, re)) ||
         findEl(fields, e => matchText(e, re));
}
function findByCategory(elements, cat) {
  return findEl(elements.filter(e => e.interactive), e => e.piiCategory === cat) ||
         findEl(elements, e => e.piiCategory === cat);
}
function findButton(elements, re) {
  const btns = elements.filter(e => e.role === 'button' || e.role === 'link');
  return findEl(btns.filter(e => e.interactive), e => matchText(e, re)) ||
         findEl(btns, e => matchText(e, re));
}

/* ------------------------------------------------------------------ */
/* Fallback planner — deterministic, offline, deterministic demos      */
/* ------------------------------------------------------------------ */
function fallbackPlan(payload) {
  const elements = elementsOf(payload);
  const task = String(payload.task || '').toLowerCase();
  const step = Number(payload.step) || 1;
  const cmds = [];

  // --- Task: fill contact details (bank KYC / insurance form) ---
  if (/(contact|kyc|insurance|claim|enquiry|details|profile|account.*(open|update)|register|sign ?up)/i.test(task) ||
      step > 0 && payload.task) {
    const fill = (cat, value, re) => {
      if (!value) return;
      const el = findByCategory(elements, cat) || findByLabel(elements, re);
      if (el) cmds.push({ action: 'type', uid: el.uid, text: value });
    };
    fill('name', 'Priya Sharma', /name/i);
    fill('email', 'priya.sharma@example.com', /email/i);
    fill('phone', '+91 98765 43210', /phone|mobile|contact/i);
    fill('dob', '15/08/1995', /dob|birth/i);
    fill('address', '42, MG Road, Bengaluru 560001', /address/i);
    fill('pincode', '560001', /pin ?code|postal/i);
    fill('aadhaar', '1234 5678 9012', /aadhaar/i);
    fill('pan', 'ABCDE1234F', /pan\b/i);
    fill('account_number', '50100234567890', /account/i);
    fill('ifsc', 'HDFC0001234', /ifsc/i);
    const submit = findButton(elements, /submit|save|continue|proceed|register/i);
    if (submit) cmds.push({ action: 'click', uid: submit.uid });
  }

  // --- Task: flight booking ---
  if (/flight|book|travel|ticket/i.test(task)) {
    const from = findByLabel(elements, /from|origin|departure/i);
    const to = findByLabel(elements, /to\b|destination/i);
    const date = findByLabel(elements, /date|journey|travel/i);
    const search = findButton(elements, /search|find|show/i);
    const book = findButton(elements, /book|select|choose/i);
    const pay = findButton(elements, /pay|confirm|continue|proceed/i);
    if (from && step === 1) cmds.push({ action: 'type', uid: from.uid, text: 'Delhi (DEL)' });
    if (to && step === 1) cmds.push({ action: 'type', uid: to.uid, text: 'Mumbai (BOM)' });
    if (date && step === 1) cmds.push({ action: 'type', uid: date.uid, text: '15 Sep 2026' });
    if (search && step === 1) cmds.push({ action: 'click', uid: search.uid });
    if (book && step === 2) cmds.push({ action: 'click', uid: book.uid });
    const pname = findByLabel(elements, /passenger|full name/i);
    if (pname && step === 3) cmds.push({ action: 'type', uid: pname.uid, text: 'Priya Sharma' });
    if (pay && (step === 2 || step === 3)) cmds.push({ action: 'click', uid: pay.uid });
  }

  // --- Task: login (demo) ---
  if (/login|sign ?in/i.test(task)) {
    const user = findByCategory(elements, 'username') || findByLabel(elements, /user|email/i);
    const pass = findByCategory(elements, 'password') || findByLabel(elements, /pass/i);
    const go = findButton(elements, /login|sign ?in|submit/i);
    if (user && step === 1) cmds.push({ action: 'type', uid: user.uid, text: 'demo.user' });
    if (pass && step === 1) cmds.push({ action: 'type', uid: pass.uid, text: 'Demo@12345' });
    if (go && step === 1) cmds.push({ action: 'click', uid: go.uid });
  }

  // --- Generic fallback: click the first button matching a keyword ---
  if (cmds.length === 0) {
    const words = task.split(/\s+/).filter(w => w.length > 3);
    for (const w of words) {
      const b = findButton(elements, new RegExp(w, 'i'));
      if (b) { cmds.push({ action: 'click', uid: b.uid }); break; }
    }
  }

  // --- Termination: nothing meaningful to do, or done sign visible ---
  const successVisible = findEl(elements, e => matchText(e, /(success|thank you|submitted|confirmed|booking complete|payment successful|welcome|logout)/i));
  const isDone = successVisible && cmds.length === 0 && /(flight|login|contact|kyc|insurance|claim|payment|pay)/i.test(task);

  return {
    commands: cmds,
    step: step + (cmds.length ? 1 : 0),
    done: !!isDone,
    note: isDone ? 'Task complete — success state detected in sanitized context.' : (cmds.length ? `${cmds.length} command(s) planned from redacted structure.` : 'No actionable elements found; waiting for state change.'),
    mode: 'fallback',
  };
}

/* ------------------------------------------------------------------ */
/* LLM/VLM mode — optional cloud brain (never receives raw pixels)     */
/* ------------------------------------------------------------------ */
let _llm = null;
function llmClient() {
  if (_llm) return _llm;
  const key = process.env.LLM_API_KEY;
  if (!key) return null;
  _llm = {
    key,
    base: process.env.LLM_BASE_URL || 'https://api.openai.com/v1',
    model: process.env.LLM_MODEL || 'gpt-4o-mini',
  };
  return _llm;
}

const SYSTEM_PROMPT = `You are the reasoning brain of a privacy-preserving browser agent.
You receive: (1) a SANITIZED screenshot — faces blurred, passwords/OTP blacked out, PII masked — plus (2) a structural element map of the page.
Treat the screenshot as fully anonymized; never reconstruct or request unredacted data.
Your job: decide the next UI actions to advance the user's task.
Element map format: {"id":number,"role":"input|textarea|select|button|link|img","text":label,"rect":{x,y,w,h},"inputType":...,"piiCategory":...}
Reply ONLY with JSON: {"commands":[{"action":"click|type|clear|scroll|wait|read|done","uid":<id>,"text":...,"amount":...}],"step":"<short description>","done":false,"note":"<one line>"}
Rules: uid must exist in the map. Never type into a password/OTP field a real secret — use a demo value. Never invent elements. If the task is complete (e.g. success message visible), reply {"commands":[],"done":true}.`;

function buildLLMMessages(payload, elements) {
  const textParts = [];
  const imagePart = [];
  textParts.push({
    type: 'text',
    text: `Task: "${payload.task || ''}" (attempt ${payload.step || 1})\n` +
      `Viewport: ${payload.viewport.w}x${payload.viewport.h}\n` +
      `Redaction audit (client-side, applied BEFORE sending): ${JSON.stringify((payload.redaction || {}).audit || {})}\n` +
      `Detected & redacted categories: ${JSON.stringify((payload.redaction || {}).categories || {})}\n` +
      `Page elements (sanitized, no values):\n${JSON.stringify(elements.map(e => ({ id: e.uid, role: e.role, text: e.text, rect: e.rect, inputType: e.inputType, piiCategory: e.piiCategory })))}`,
  });
  if (payload.image) {
    imagePart.push({ type: 'text', text: 'Anonymized screenshot:' });
    imagePart.push({ type: 'image_url', image_url: { url: payload.image } });
  }
  return [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: textParts.concat(imagePart) }];
}

async function llmPlan(payload, elements) {
  const llm = llmClient();
  if (!llm) return null;
  let body = { model: llm.model, messages: buildLLMMessages(payload, elements), temperature: 0.1, response_format: { type: 'json_object' } };
  const doCall = async (b) => {
    const res = await fetch(llm.base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + llm.key },
      body: JSON.stringify(b),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error('LLM HTTP ' + res.status + ' ' + (await res.text()).slice(0, 300));
    const data = await res.json();
    const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    return JSON.parse(content);
  };
  try {
    return await doCall(body);
  } catch (e1) {
    // image may not be supported by the model — retry text-only
    if (payload.image && !/HTTP 4/.test(String(e1))) {
      const b2 = Object.assign({}, body, { messages: buildLLMMessages(Object.assign({}, payload, { image: undefined }), elements) });
      try { return await doCall(b2); } catch (e2) { throw e2; }
    }
    throw e1;
  }
}

/* ------------------------------------------------------------------ */
/* Public API                                                           */
/* ------------------------------------------------------------------ */
async function plan(payload) {
  const elements = elementsOf(payload);
  const start = Date.now();

  // 1) try the LLM brain when configured
  if (llmClient()) {
    try {
      const raw = await llmPlan(payload, elements);
      const cmds = validateCommands(raw && raw.commands, payload);
      const result = {
        commands: cmds,
        step: Number(payload.step) + (cmds.length ? 1 : 0),
        done: !!(raw && raw.done) && cmds.length === 0,
        note: (raw && raw.note) || 'planned by LLM',
        mode: 'llm',
      };
      result.planMs = Date.now() - start;
      return result;
    } catch (e) {
      console.warn('[planner] LLM failed, falling back:', String(e && e.message || e).slice(0, 200));
    }
  }

  // 2) deterministic offline planner
  const fb = fallbackPlan(payload);
  fb.planMs = Date.now() - start;
  return fb;
}

module.exports = { plan, validateCommands, fallbackPlan, elementsOf };
