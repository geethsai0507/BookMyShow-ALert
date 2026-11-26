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
      let qdata = null, qargs = {};
      const fulfilled = Object.entries(queries).filter(([, q]) => q?.status === 'fulfilled' && q?.data);
      // Prefer the query for this page's date — the store may also hold other dates.
      let hit = fulfilled.find(([key, q]) =>
        key.includes(currentDate) || String(q.originalArgs?.dateCode ?? '') === currentDate);
      if (!hit && fulfilled.length) {
        hit = fulfilled[0];
        console.warn('[ShowAlert/page] No query matched date', currentDate, '— falling back to', hit[0]);
      }
      if (hit) {
        qdata = hit[1].data;
        qargs = hit[1].originalArgs ?? {};
        console.log('[ShowAlert/page] Found query key:', hit[0]);
      }
      const apiToken   = qargs.token      ?? '';
      const bmsId      = qargs.bmsId      ?? '';
      const regionCode = qargs.regionCode ?? 'HYD';

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
        citySlug,
        city:           toTitleCase(citySlug.replace(/-/g, ' ')),
        currentDate,
        shows,
        screens:        uniq(shows.flatMap(s => [s.screen, s.format])),
        movies:         uniq(shows.map(s => s.movieTitle)),
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

  function uniq(arr) {
    return [...new Set(arr.map(v => String(v ?? '').trim()).filter(Boolean))];
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
