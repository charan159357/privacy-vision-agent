/* popup.js — talks to the content script in the active tab. */
(function () {
  'use strict';
  var api = (typeof browser !== 'undefined' && browser.runtime) ? browser : (window.chrome || {});
  var $ = function (id) { return document.getElementById(id); };

  function send(msg) {
    return new Promise(function (resolve) {
      api.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        var tab = tabs && tabs[0];
        if (!tab || tab.id == null) return resolve(null);
        api.tabs.sendMessage(tab.id, msg, function (r) {
          if (api.runtime && api.runtime.lastError) return resolve(null);
          resolve(r);
        });
      });
    });
  }

  $('start').addEventListener('click', function () {
    $('start').disabled = true;
    // Firefox MV2: also ask the background page to install the page-world
    // gateway (tabs.executeScript runs in the page's main world there).
    if (typeof browser !== 'undefined' && browser.runtime && browser.runtime.sendMessage) {
      try { browser.runtime.sendMessage({ type: 'pva:injectMainGateway' }).catch(function () {}); } catch (e) {}
    }
    send({
      type: 'pva:configure',
      serverUrl: $('serverUrl').value,
      task: $('task').value,
      strategy: $('strategy').value,
    }).then(function () { return send({ type: 'pva:start' }); })
      .then(function (r) { $('start').disabled = false; refresh(r); })
      .catch(function () { $('start').disabled = false; });
  });
  $('stop').addEventListener('click', function () {
    send({ type: 'pva:stop' }).then(refresh);
  });

  function refresh(r) {
    if (r && r.state) {
      var b = $('state');
      b.textContent = r.state;
      b.className = 'badge b-' + r.state;
    }
    if (r) {
      if (r.faces != null) $('faces').textContent = r.faces;
      if (r.pii != null) $('pii').textContent = r.pii;
      if (r.delta != null) $('delta').textContent = (r.delta * 100).toFixed(1) + '%';
      if (r.gw != null) $('gw').textContent = r.gw;
    }
  }
  send({ type: 'pva:status' }).then(refresh);
})();
