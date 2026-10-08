'use strict';
const { chromium } = require('playwright-core');
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', e => console.log('  [pageerror]', String(e).slice(0, 300)));
  page.on('request', req => {
    if (req.url().includes('/api/agent')) {
      const body = req.postData() || '';
      let parsed = null;
      try { parsed = JSON.parse(body); } catch (e) {}
      if (parsed) {
        const btns = (parsed.elements || []).filter(e => e.role === 'button');
        console.log(`>>> POST /api/agent step=${parsed.step} elements=${(parsed.elements || []).length} buttons=${JSON.stringify(btns.map(b => ({ id: b.id, text: b.text })))}`);
      }
    }
  });
  page.on('response', async res => {
    if (res.url().includes('/api/agent')) {
      try {
        const j = await res.json();
        console.log(`<<< ${res.status()} mode=${j.mode} commands=${JSON.stringify(j.commands)} done=${j.done}`);
      } catch (e) {}
    }
  });
  await page.goto('http://127.0.0.1:8787/demo/banking.html', { waitUntil: 'networkidle' });
  const panel = page.frameLocator('#agentPanel');
  await panel.locator('#btnStart').waitFor({ timeout: 15000 });
  await panel.locator('#btnStart').click();
  await page.waitForTimeout(15000);
  console.log('final state:', await panel.locator('#stateBadge').innerText());
  console.log('success visible:', await page.locator('#successBox').isVisible().catch(() => false));
  const vals = await page.evaluate(() => {
    const g = id => { const el = document.getElementById(id); return el ? el.value : null; };
    return { name: g('fullName'), aadhaar: g('aadhaar'), email: g('email'), phone: g('phone'), pan: g('pan'), pass: g('password'), otp: g('otp') };
  });
  console.log('form values after completion:', JSON.stringify(vals));
  // was the form ever filled? check before completion by hooking: instead, check history via panel
  const frame = page.frames().find(f => f.url().includes('demo-panel'));
  if (frame) {
    console.log('panel cmd log lines:', await frame.evaluate(() => {
      const box = document.getElementById('cmdLog');
      return box ? box.children.length : -1;
    }));
  }
  await browser.close();
})().catch(e => console.error('FATAL:', e));
