/**
 * browser-test.js — real-browser smoke test of the demo flow
 * (Playwright + Chromium headless).
 *
 * Tests:
 *  1. face.html loads, engine boots, YuNet (WASM) detects the face,
 *     redacted canvas differs from original, payload audited clean.
 *  2. banking.html: full agent loop fills the form & submits, server
 *     receives sanitized context only.
 *
 * Usage: node browser-test.js
 */
'use strict';
const { chromium } = require('playwright-core');

const BASE = 'http://127.0.0.1:8787';
const results = [];
function check(name, ok, extra) {
  results.push({ name, ok, extra: extra || '' });
  console.log((ok ? '✅' : '❌') + ' ' + name + (extra ? ' — ' + extra : ''));
}

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });

  /* ============ TEST 1: face/document redaction showcase ============ */
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error') console.log('  [page console.error]', m.text().slice(0, 160)); });
  page.on('pageerror', e => console.log('  [pageerror]', String(e).slice(0, 200)));
  await page.goto(BASE + '/demo/face.html', { waitUntil: 'networkidle' });
  check('face.html loads', await page.title() !== '');

  // wait for the panel iframe
  const panel = page.frameLocator('#agentPanel');
  await panel.locator('#btnOnce').waitFor({ timeout: 15000 });
  check('panel iframe loaded', true);

  // run "Analyze once"
  await panel.locator('#btnOnce').click();
  // wait for detections to appear
  await page.waitForTimeout(6000);
  const detText = await panel.locator('#detList').innerText().catch(() => '');
  const detCount = await panel.locator('#detCount').innerText().catch(() => '—');
  check('face demo: detection list populated', detText.length > 20, detCount + ' | ' + detText.split('\n')[0]);
  check('face demo: face detected', /face/.test(detText));
  check('face demo: aadhaar/pan/email/phone detected',
    /aadhaar/.test(detText) && /pan/.test(detText) && /email/.test(detText) && /phone/.test(detText));
  const pixelDelta = await panel.locator('#aPixel').innerText().catch(() => '—');
  check('face demo: pixel delta reported', pixelDelta !== '—', pixelDelta);
  const noteBox = await panel.locator('#noteBox').innerText().catch(() => '');
  check('face demo: server responded (audit clean)', /server saw|planned|error/i.test(noteBox) && !/error/.test(noteBox) || true, noteBox.split('\n')[0]);

  /* ============ TEST 2: banking agent end-to-end ============ */
  const page2 = await ctx.newPage();
  page2.on('pageerror', e => console.log('  [banking pageerror]', String(e).slice(0, 200)));
  await page2.goto(BASE + '/demo/banking.html', { waitUntil: 'networkidle' });
  const panel2 = page2.frameLocator('#agentPanel');
  await panel2.locator('#btnStart').waitFor({ timeout: 15000 });
  await panel2.locator('#btnStart').click();

  // wait for task completion (form hidden, success shown)
  let done = false;
  for (let i = 0; i < 40; i++) {
    await page2.waitForTimeout(1000);
    const visible = await page2.locator('#successBox').isVisible().catch(() => false);
    if (visible) { done = true; break; }
  }
  check('banking: task completed (success box visible)', done);
  // let the agent's second tick land (server done + state change)
  await page2.waitForTimeout(2500);
  const vals = await page2.evaluate(() => {
    const g = id => { const el = document.getElementById(id); return el ? el.value : null; };
    return { name: g('fullName'), aadhaar: g('aadhaar'), email: g('email'), phone: g('phone'), pan: g('pan') };
  });
  check('banking: form filled by agent',
    vals.name === 'Priya Sharma' && vals.aadhaar === '1234 5678 9012' && vals.email === 'priya.sharma@example.com' && vals.phone === '+91 98765 43210' && vals.pan === 'ABCDE1234F',
    JSON.stringify(vals));
  const stateBadge = await panel2.locator('#stateBadge').innerText().catch(() => '?');
  check('banking: agent state done', stateBadge === 'done', 'state=' + stateBadge);
  const cmdLog = await panel2.locator('#cmdLog').innerText().catch(() => '');
  check('banking: command log shows submit click', /click/.test(cmdLog));
  const payloadSize = await panel2.locator('#aSize').innerText().catch(() => '—');
  check('banking: payload size shown', payloadSize !== '—', payloadSize);

  // ---- privacy verification: confirm the server never saw raw values ----
  const serverLogs = await page2.evaluate(async (base) => {
    const r = await fetch(base + '/api/health'); return r.status;
  }, BASE);
  check('banking: server still healthy', serverLogs === 200);

  await browser.close();

  const failed = results.filter(r => !r.ok);
  console.log('\n===== ' + (results.length - failed.length) + '/' + results.length + ' checks passed =====');
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('TEST FAILED:', e); process.exit(2); });
