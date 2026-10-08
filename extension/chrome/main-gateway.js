/* main-gateway.js — runs in the PAGE world (injected by background.js via
 * chrome.scripting, world: MAIN). Enables the PrivacyGateway so that the
 * page's own fetch/XHR traffic is scrubbed of PII before it leaves the
 * device. The agent's own requests are already covered by the
 * content-script world gateway.
 */
(function () {
  'use strict';
  try {
    if (window.PVA && window.PVA.Gateway && !window.__PVA_PAGE_GATEWAY__) {
      window.__PVA_PAGE_GATEWAY__ = new window.PVA.Gateway.PrivacyGateway();
      window.__PVA_PAGE_GATEWAY__.enable();
      console.info('[PVA] page-world privacy gateway active');
    }
  } catch (e) {
    /* non-fatal: content-world gateway still protects the agent */
  }
})();
