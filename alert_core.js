// ─────────────────────────────────────────────────────────────
// alert_core.js  –  pure alert logic (no chrome.* APIs)
//
// Shared by background.js (importScripts), popup.html (<script>)
// and Node tests (require). Dates are YYYYMMDD strings.
// ─────────────────────────────────────────────────────────────
(function () {
  'use strict';

  const BMS_BASE = 'https://in.bookmyshow.com/cinemas';

  function norm(s) { return String(s ?? '').trim().toLowerCase(); }

  // Fill in fields added by screen/format alerts; migrate legacy alerts.
  function normalizeAlert(alert) {
    const a = { ...alert };
    const legacyNotified = a.notified === true || a.status === 'notified';
    delete a.notified;

    if (a.status === 'notified') a.status = 'done';
    if (!a.status) a.status = 'watching';

    a.screenFilter = a.screenFilter ?? '';
    a.movieFilter  = a.movieFilter  ?? '';
    a.dateMode     = a.dateMode     ?? 'single';
    a.notifyMode   = a.notifyMode   ?? 'once';
    a.maxNotifications = a.maxNotifications ?? null;
    a.citySlug     = a.citySlug     || '';

    if (!Array.isArray(a.notifiedDates)) {
      a.notifiedDates = legacyNotified && a.date ? [a.date] : [];
    }
    if (typeof a.notificationCount !== 'number') {
      a.notificationCount = legacyNotified ? 1 : 0;
    }
    return a;
  }

  function showMatches(show, alert) {
    const screen = norm(alert.screenFilter);
    const movie  = norm(alert.movieFilter);
    if (screen && !norm(show.screen).includes(screen) && !norm(show.format).includes(screen)) return false;
    if (movie && !norm(show.movieTitle).includes(movie)) return false;
    return true;
  }

  function matchingShows(shows, alert) {
    return (shows || []).filter(s => showMatches(s, alert));
  }

  function alertKey(alert) {
    const datePart = alert.dateMode === 'any' ? '*' : alert.date;
    return [alert.theatreCode, alert.dateMode, datePart, norm(alert.screenFilter), norm(alert.movieFilter)].join('|');
  }

  function buildBMSUrl(alert, date) {
    const city = alert.citySlug
      ? alert.citySlug
      : (alert.city || 'hyderabad').toLowerCase().replace(/\s+/g, '-');
    const slug = alert.theatreSlug
      ? alert.theatreSlug
      : (alert.theatreName || alert.theatreCode).toLowerCase().replace(/[^a-z0-9]+/g, '-');
    return `${BMS_BASE}/${city}/${slug}/buytickets/${alert.theatreCode}/${date}`;
  }

  function notificationId(alertId, date) { return `showalert_${alertId}_${date}`; }

  function parseNotificationId(id) {
    const m = /^showalert_(.+)_(\d{8})$/.exec(String(id));
    return m ? { alertId: m[1], date: m[2] } : null;
  }

  function isWatching(alert) { return alert.status === 'watching'; }
  function notified(alert) { return alert.notifiedDates || []; }

  // Future open dates (excluding today) that some watching alert still needs.
  function datesToVisit(alerts, availableDates, today) {
    const out = new Set();
    for (const a of alerts) {
      if (!isWatching(a)) continue;
      for (const d of availableDates) {
        if (d <= today || notified(a).includes(d)) continue;
        if (a.dateMode === 'single' && d !== a.date) continue;
        out.add(d);
      }
    }
    return [...out].sort();
  }

  // Dates (>= today, not yet notified) with at least one matching show.
  function collectNewDates(alert, showsByDate, today) {
    if (!isWatching(alert)) return [];
    const found = [];
    for (const date of Object.keys(showsByDate).sort()) {
      if (date < today || notified(alert).includes(date)) continue;
      if (alert.dateMode === 'single' && date !== alert.date) continue;
      const shows = matchingShows(showsByDate[date], alert);
      if (shows.length) found.push({ date, shows });
    }
    return found;
  }

  // One notification covering `dates`; returns the updated alert.
  function applyNotification(alert, dates) {
    const a = { ...alert };
    a.notifiedDates = [...new Set([...notified(alert), ...dates])];
    a.notificationCount = (alert.notificationCount || 0) + 1;
    if (a.notifyMode === 'once' ||
        (a.notifyMode === 'limit' && a.notificationCount >= (a.maxNotifications || 1))) {
      a.status = 'done';
    }
    return a;
  }

  const AlertCore = {
    normalizeAlert, showMatches, matchingShows, alertKey,
    buildBMSUrl, notificationId, parseNotificationId,
    datesToVisit, collectNewDates, applyNotification
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = AlertCore;
  else self.AlertCore = AlertCore;
})();
