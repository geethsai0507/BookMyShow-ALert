// ─────────────────────────────────────────────────────────────
// page_extractor.js  –  MAIN world  (has full page JS access)
//
// Runs in the page's own JavaScript context so it can read
// window.__INITIAL_STATE__ directly.
// Sends data to content.js (ISOLATED world) via postMessage.
// ─────────────────────────────────────────────────────────────
(function () {
  'use strict';

  // Confirm injection immediately
  console.log('[ShowAlert/page] page_extractor.js injected ✓');

  function extract() {
    const state = window.__INITIAL_STATE__;
    if (!state) {
      console.log('[ShowAlert/page] __INITIAL_STATE__ not yet available');
      return false;
    }

    console.log('[ShowAlert/page] __INITIAL_STATE__ found, parsing…');

    try {
      // ── Parse URL ────────────────────────────────────────────
      const m = location.href.match(
        /in\.bookmyshow\.com\/cinemas\/([^/?#]+)\/([^/?#]+)\/buytickets\/([A-Z0-9]+)\/(\d{8})/
      );
      if (!m) { console.log('[ShowAlert/page] URL did not match BMS pattern'); return false; }

      const [, citySlug, theatreSlug, venueCode, currentDate] = m;

      // ── Find the venue showtimes query ────────────────────────
      // BMS stores it under venueShowtimesFunctionalApi.queries
      // The key is like "getShowtimesByVenue-ACEV-20260318"
      const queries = state?.venueShowtimesFunctionalApi?.queries ?? {};
      let qdata = null;
      let apiToken = '', bmsId = '', regionCode = 'HYD';

      for (const key of Object.keys(queries)) {
        const q = queries[key];
        // Find a fulfilled query with data
        if (q?.status === 'fulfilled' && q?.data) {
          qdata = q.data;
          const args = q.originalArgs ?? {};
          apiToken   = args.token      ?? '';
          bmsId      = args.bmsId      ?? '';
          regionCode = args.regionCode ?? 'HYD';
          console.log('[ShowAlert/page] Found query key:', key);
          break;
        }
      }

      if (!qdata) {
        console.warn('[ShowAlert/page] No fulfilled query data found in venueShowtimesFunctionalApi');
        return false;
      }

      // ── Parse shows from Event array ──────────────────────────
      const shows = [];
      const events = qdata?.showDetailsTransformed?.Event ?? [];
      console.log('[ShowAlert/page] Event array length:', events.length);

      for (const event of events) {
        const movieTitle = event.EventTitle ?? 'Unknown';
        for (const child of (event.ChildEvents ?? [])) {
          const language  = child.EventLanguage  ?? '';
          const dimension = child.EventDimension ?? '2D';
          for (const slot of (child.ShowTimes ?? [])) {
            // AvailStatus: "0"=sold out, "1"=fast filling, "2"=fast filling, "3"=available
            const avail = String(slot.AvailStatus ?? '0');
            if (avail === '0') continue;
            shows.push({
              movieTitle,
              time:     slot.ShowTime    ?? '',
              format:   slot.Attributes  ?? dimension,
              language,
              screen:   slot.ScreenName  ?? '',
              minPrice: slot.MinPrice    ?? '',
              maxPrice: slot.MaxPrice    ?? '',
              status:   (avail === '1' || avail === '2') ? 'fast_filling' : 'available'
            });
          }
        }
      }

      console.log(`[ShowAlert/page] Parsed ${shows.length} available shows`);

      // ── Parse ShowDatesArray ──────────────────────────────────
      const datesArr       = qdata?.ShowDatesArray ?? [];
      const availableDates = datesArr.filter(d => !d.isDisabled).map(d => d.DateCode);
      const allDates       = datesArr.map(d => ({
        dateCode:   d.DateCode ?? '',
        dispDate:   d.DispDate ?? '',
        isDisabled: !!d.isDisabled
      }));

      console.log('[ShowAlert/page] Available dates:', availableDates);

      // ── Post to content.js ────────────────────────────────────
      const payload = {
        type:           'SHOWALERT_PAGE_DATA',
        venueCode,
        theatreName:    toTitleCase(theatreSlug.replace(/-/g, ' ')),
        theatreSlug,
        city:           toTitleCase(citySlug.replace(/-/g, ' ')),
        currentDate,
        shows,
        availableDates,
        allDates,
        tokens: { bmsApiToken: apiToken, bmsId, regionCode }
      };

      window.postMessage(payload, 'https://in.bookmyshow.com');
      console.log('[ShowAlert/page] ✅ postMessage sent to content.js');
      return true;

    } catch (e) {
      console.error('[ShowAlert/page] Parse error:', e.message);
      return false;
    }
  }

  function toTitleCase(s) {
    return s.replace(/\b\w/g, c => c.toUpperCase());
  }

  // BMS sets __INITIAL_STATE__ in an inline <script> at the bottom
  // of the HTML. By document_idle it's already there. But React may
  // still be hydrating the Redux store. Try with gentle retries.
  let attempts = 0;
  function tryExtract() {
    attempts++;
    console.log(`[ShowAlert/page] Extract attempt ${attempts}`);
    const ok = extract();
    if (!ok && attempts < 10) {
      setTimeout(tryExtract, 500);
    } else if (!ok) {
      console.error('[ShowAlert/page] Gave up after', attempts, 'attempts');
    }
  }

  // Start immediately (document_idle = DOM + scripts loaded)
  tryExtract();

  // Also re-run on SPA navigation (user clicks a date tab)
  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      console.log('[ShowAlert/page] SPA navigation detected, re-extracting…');
      attempts = 0;
      setTimeout(tryExtract, 1000);
    }
  }).observe(document.body, { childList: true, subtree: true });

})();
