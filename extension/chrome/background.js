/* background.js — Chrome MV3 service worker.
 *
 * Two jobs:
 *  1. on install: open the demo hub so the user can try the full stack.
 *  2. on action click (optional): inject the PrivacyGateway into the PAGE
 *     world so that even page-owned fetch/XHR traffic is scrubbed. The
 *     content-script world gateway already protects the agent's own
 *     requests; this closes the loop for the page itself.
 */
'use strict';

chrome.runtime.onInstalled.addListener(function (details) {
  if (details.reason === 'install') {
    chrome.tabs.create({ url: 'http://127.0.0.1:8787/' }).catch(function () {
      /* server not running — user will start it via scripts/dev.sh */
    });
  }
});

chrome.action.onClicked.addListener(function (tab) {
  if (!tab || tab.id == null) return;
  // best-effort: main-world gateway for the page's own network traffic
  chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: false },
    world: 'MAIN',
    files: ['engine/geometry.js', 'engine/pii-rules.js', 'engine/gateway.js', 'main-gateway.js'],
  }).catch(function () { /* page without host permission etc. — content gateway still active */ });
});

// expose status to the popup (fallback when the content script is not yet there)
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (msg && msg.type === 'pva:openDemo') {
    chrome.tabs.create({ url: 'http://127.0.0.1:8787/demo/banking.html' });
    sendResponse({ ok: true });
  }
  return false;
});
