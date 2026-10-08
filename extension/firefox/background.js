/* background.js — Firefox MV2 background page.
 * Injects the page-world PrivacyGateway bundle on request from the popup.
 * (In Firefox MV2, tabs.executeScript runs in the page's main world.)
 */
'use strict';

browser.runtime.onInstalled.addListener(function (details) {
  if (details.reason === 'install') {
    browser.tabs.create({ url: 'http://127.0.0.1:8787/' }).catch(function () {});
  }
});

browser.runtime.onMessage.addListener(function (msg) {
  if (msg && msg.type === 'pva:injectMainGateway') {
    browser.tabs.query({ active: true, currentWindow: true }).then(function (tabs) {
      const tab = tabs && tabs[0];
      if (tab && tab.id != null) {
        browser.tabs.executeScript(tab.id, { file: 'main-gateway-bundle.js' }).catch(function () {});
      }
    });
    return Promise.resolve({ ok: true });
  }
  return null;
});
