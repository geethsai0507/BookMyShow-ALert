// ─────────────────────────────────────────────────────────────
// content.js  –  ISOLATED world  (has chrome.* API access)
//
// Receives postMessage from page_extractor.js (MAIN world)
// and forwards to background.js via chrome.runtime.sendMessage.
// Also injects the floating Notify Me button.
// ─────────────────────────────────────────────────────────────
(function () {
  'use strict';

  console.log('[ShowAlert] content.js injected ✓');

  // ── Listen for data posted by page_extractor.js ──────────
  window.addEventListener('message', (event) => {
    if (event.origin !== 'https://in.bookmyshow.com') return;
    if (!event.data || event.data.type !== 'SHOWALERT_PAGE_DATA') return;

    const d = event.data;
    console.log('[ShowAlert] Received PAGE_DATA:', {
      venue:     d.venueCode,
      date:      d.currentDate,
      shows:     d.shows?.length,
      available: d.availableDates
    });

    // Save tokens so background can attempt API calls too
    if (d.tokens?.bmsApiToken) {
      safeSet({ bmsTokens: d.tokens });
    }

    // Save page context for popup
    const info = parseUrl(location.href);
    if (info) safeSet({ lastBMSPage: info });

    // Forward to background for alert matching
    safeSend({
      action:         'PAGE_SHOW_DATA',
      venueCode:      d.venueCode,
      theatreName:    d.theatreName,
      theatreSlug:    d.theatreSlug,
      city:           d.city,
      currentDate:    d.currentDate,
      shows:          d.shows          ?? [],
      availableDates: d.availableDates  ?? [],
      allDates:       d.allDates        ?? []
    });
  });

  // ── Inject floating Notify Me button ──────────────────────
  const info = parseUrl(location.href);
  if (info && !document.getElementById('showalert-root')) {
    injectButton(info);
    watchNavigation();
  }

  function injectButton(info) {
    const root = document.createElement('div');
    root.id = 'showalert-root';
    root.setAttribute('data-theatre', info.theatreCode);
    root.setAttribute('data-date', info.date);
    root.innerHTML = `
      <div id="sa-fab-wrap">
        <div id="sa-pill">
          <span id="sa-pill-icon">🔔</span>
          <div id="sa-pill-text">
            <span id="sa-pill-main">Notify Me</span>
            <span id="sa-pill-sub">ShowAlert</span>
          </div>
          <span id="sa-pill-arrow">›</span>
        </div>
        <div id="sa-tooltip">Get notified when tickets open for<br><strong>${esc(info.theatreName)}</strong></div>
      </div>`;
    document.body.appendChild(root);

    root.querySelector('#sa-pill').addEventListener('click', async () => {
      if (!chrome?.storage?.local) {
        showToast('🔄', '<strong>Please refresh this page</strong><br>Extension was updated.');
        return;
      }
      try {
        await chrome.storage.local.set({ lastBMSPage: info });
        safeSend({ action: 'BMS_PAGE_CONTEXT', ...info });
        showToast('✅', `<strong>ShowAlert ready!</strong><br>Open the extension popup and click <em>Notify Me</em>.`);
      } catch (e) {
        showToast('🔄', '<strong>Please refresh this page</strong><br>Extension context lost.');
      }
    });
  }

  function watchNavigation() {
    let lastUrl = location.href;
    new MutationObserver(() => {
      if (location.href === lastUrl) return;
      lastUrl = location.href;
      const newInfo = parseUrl(lastUrl);
      document.getElementById('showalert-root')?.remove();
      if (newInfo) setTimeout(() => injectButton(newInfo), 900);
    }).observe(document.body, { childList: true, subtree: true });
  }

  function safeSend(msg) {
    try { if (chrome?.runtime?.id) chrome.runtime.sendMessage(msg); } catch (_) {}
  }

  function safeSet(data) {
    try { if (chrome?.storage?.local) chrome.storage.local.set(data); } catch (_) {}
  }

  function showToast(icon, html) {
    document.getElementById('sa-page-toast')?.remove();
    const t = document.createElement('div');
    t.id = 'sa-page-toast';
    t.innerHTML = `<span id="sa-toast-icon">${icon}</span><div id="sa-toast-body">${html}</div>`;
    document.body.appendChild(t);
    requestAnimationFrame(() => t.classList.add('sa-toast-show'));
    setTimeout(() => { t.classList.remove('sa-toast-show'); setTimeout(() => t.remove(), 400); }, 5000);
  }

  function parseUrl(url) {
    const m = url.match(/in\.bookmyshow\.com\/cinemas\/([^/?#]+)\/([^/?#]+)\/buytickets\/([A-Z0-9]+)\/(\d{8})/);
    if (!m) return null;
    const [, citySlug, theatreSlug, theatreCode, date] = m;
    return {
      city: toTitleCase(citySlug.replace(/-/g, ' ')),
      theatreSlug,
      theatreCode,
      theatreName: toTitleCase(theatreSlug.replace(/-/g, ' ')),
      date
    };
  }

  function toTitleCase(s) { return s.replace(/\b\w/g, c => c.toUpperCase()); }
  function esc(s) { return String(s).replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

})();
