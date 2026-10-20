/**
 * Detecta despliegues nuevos y pide recargar (anti-caché de JS/CSS viejos).
 */
(function () {
  'use strict';

  var POLL_MS = 45000;
  var meta = document.querySelector('meta[name="app-version"]');
  var current = meta ? String(meta.getAttribute('content') || '').trim() : '';
  var alerted = false;
  var banner = null;

  function ensureBanner() {
    if (banner) return banner;
    banner = document.createElement('div');
    banner.id = 'waUpdateBanner';
    banner.className = 'wa-update-banner';
    banner.setAttribute('role', 'alert');
    banner.innerHTML =
      '<div class="wa-update-banner-text">'
      + '<strong>El sistema se actualizó</strong>'
      + '<span>Hay una versión nueva. Recargue la página para ver los cambios (evita errores por caché).</span>'
      + '</div>'
      + '<button type="button" class="wa-update-banner-btn" id="btnReloadApp">Recargar ahora</button>';
    document.body.appendChild(banner);
    var btn = document.getElementById('btnReloadApp');
    if (btn) {
      btn.addEventListener('click', function () {
        location.reload();
      });
    }
    return banner;
  }

  function showUpdate(serverVersion) {
    ensureBanner();
    banner.classList.add('is-visible');
    if (!alerted) {
      alerted = true;
      try {
        window.alert(
          'El sistema se actualizó'
          + (serverVersion ? ' (versión ' + serverVersion + ')' : '')
          + '.\n\nRecargue la página para aplicar los cambios.'
        );
      } catch (_) { /* ignore */ }
    }
  }

  function check() {
    fetch('/api/version', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        var next = data && data.version ? String(data.version) : '';
        if (!next) return;
        if (!current) {
          current = next;
          if (meta) meta.setAttribute('content', current);
          return;
        }
        if (next !== current) showUpdate(next);
      })
      .catch(function () { /* silencioso */ });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', check);
  } else {
    check();
  }
  setInterval(check, POLL_MS);

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') check();
  });
})();
