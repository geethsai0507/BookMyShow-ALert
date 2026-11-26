// ─────────────────────────────────────────────────────────────
// background.js  –  ShowAlert Service Worker
//
// ARCHITECTURE:
//  PRIMARY:  Content script reads window.__INITIAL_STATE__ on
//            every BMS page visit → sends PAGE_SHOW_DATA here
//            → we match against stored alerts → fire notification
//            No network calls, no Cloudflare issues.
//
//  SECONDARY: Alarm-based polling every 3min tries BMS API.
//             Often blocked by Cloudflare from service worker
//             context (no cookies). Kept as best-effort fallback.
//
// REDIRECT HANDLING:
//  When user visits future date URL, BMS redirects to today.
//  Content script sends ShowDatesArray (all upcoming dates with
//  enabled/disabled status). We check if any alert's target
//  date just became enabled → fire notification immediately.
// ─────────────────────────────────────────────────────────────

importScripts('alert_core.js');

const ALARM_NAME   = 'showalert-poll';
const ALARM_PERIOD = 3; // minutes

// ═════════════════════════════════════════════════════════════
// INSTALL / STARTUP
// ═════════════════════════════════════════════════════════════
chrome.runtime.onInstalled.addListener(async () => {
  console.log('[ShowAlert] Installed.');
  await getAlerts();          // migrates legacy alerts
  await maybeStartAlarm();
});

chrome.runtime.onStartup.addListener(async () => {
  await getAlerts();          // migrates legacy alerts
  await maybeStartAlarm();
});

async function maybeStartAlarm() {
  const s = await getSettings();
  if (!s.email) return;
  const period = s.pollIntervalMin || ALARM_PERIOD;
  await chrome.alarms.clearAll();
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: period });
  console.log(`[ShowAlert] Alarm set every ${period} min`);
}

// ═════════════════════════════════════════════════════════════
// ALARM: best-effort background polling
// (may be blocked by Cloudflare — content script is primary)
// ═════════════════════════════════════════════════════════════
chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== ALARM_NAME) return;
  await runPollCycle();
});

// ═════════════════════════════════════════════════════════════
// MESSAGE HANDLER
// ═════════════════════════════════════════════════════════════
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg.action) {

      // ── Setup / settings ─────────────────────────────────
      case 'START_MONITORING':
        await maybeStartAlarm();
        sendResponse({ ok: true });
        break;

      case 'SETTINGS_UPDATED': {
        const p = msg.settings?.pollIntervalMin || ALARM_PERIOD;
        await chrome.alarms.clearAll();
        chrome.alarms.create(ALARM_NAME, { periodInMinutes: p });
        sendResponse({ ok: true });
        break;
      }

      // ── Save BMS tokens extracted from page ──────────────
      case 'SAVE_BMS_TOKENS':
        if (msg.tokens?.bmsApiToken) {
          await chrome.storage.local.set({ bmsTokens: msg.tokens });
          console.log('[ShowAlert] BMS tokens saved from page');
        }
        sendResponse({ ok: true });
        break;

      // ── PRIMARY: Page data from content script ───────────
      // content.js sends this every time a BMS venue page loads.
      // msg contains: venueCode, theatreName, city, theatreSlug,
      //   currentDate, shows[], availableDates[], allUpcomingDates[]
      case 'PAGE_SHOW_DATA': {
        console.log(`[ShowAlert] PAGE_SHOW_DATA received:`, {
          venue:     msg.venueCode,
          date:      msg.currentDate,
          shows:     msg.shows?.length,
          available: msg.availableDates
        });
        await handlePageData(msg);
        sendResponse({ ok: true });
        break;
      }

      // ── Alert added: open a silent tab to check immediately ──
      case 'ALERT_ADDED':
        await updateAlert(msg.alert.id, { lastChecked: Date.now() });
        // Open a background tab — content scripts will extract live data
        openSilentTab(buildBMSUrl(msg.alert), msg.alert.theatreCode);
        sendResponse({ ok: true });
        break;

      // ── Force poll ───────────────────────────────────────
      case 'FORCE_POLL':
        await runPollCycle();
        sendResponse({ ok: true });
        break;

      case 'ALERT_REMOVED':
      case 'CLEAR_ALL':
      case 'BMS_PAGE_CONTEXT':
        sendResponse({ ok: true });
        break;

      default:
        sendResponse({ ok: false });
    }
  })();
  return true;
});

// ═════════════════════════════════════════════════════════════
// PAGE DATA HANDLER (PRIMARY — from content script)
// ═════════════════════════════════════════════════════════════
async function handlePageData(data) {
  const { venueCode, theatreName, city, theatreSlug,
          currentDate, shows, availableDates, allUpcomingDates } = data;

  const alerts = await getAlerts();
  // Only check active, un-notified alerts for this theatre
  const matching = alerts.filter(a =>
    a.theatreCode === venueCode &&
    a.status      === 'watching' &&
    !a.notified
  );

  if (!matching.length) return;

  console.log(`[ShowAlert] Checking ${matching.length} alert(s) for ${venueCode}`);

  for (const alert of matching) {
    await updateAlert(alert.id, { lastChecked: Date.now() });

    // ── Case 1: Alert date = current page date AND shows exist ─
    if (alert.date === currentDate && shows.length > 0) {
      console.log(`[ShowAlert] ✅ MATCH! Shows found for ${theatreName} on ${alert.date}`);
      await notifyAlert(alert.id, [{ date: alert.date, shows }]);
      continue;
    }

    // ── Case 2: Alert date now appears as enabled in ShowDatesArray ─
    // This catches the redirect case: user visited today's page,
    // but ShowDatesArray now shows their target date is bookable.
    // IMPORTANT FIX: We now verify actual shows exist for the target date
    // before sending notification (don't just assume "available" means shows exist)
    if (availableDates.includes(alert.date)) {
      console.log(`[ShowAlert] ✅ Target date ${alert.date} just became bookable for ${theatreName}!`);
      console.log(`[ShowAlert] Opening tab to verify shows exist for target date ${alert.date}`);
      
      // Only proceed if no shows were found on current page
      // If shows exist on current date AND it matches target, we'd be in Case 1
      // So we safely assume this needs verification
      await verifyShowsForTargetDate(alert, theatreName);
      continue;
    }

    // ── Log why no notification ──────────────────────────────
    const dateStatus = allUpcomingDates?.find(d => d.dateCode === alert.date);
    if (dateStatus) {
      console.log(`[ShowAlert] Date ${alert.date} is still disabled (not bookable yet) for ${venueCode}`);
    } else {
      console.log(`[ShowAlert] Date ${alert.date} not found in ShowDatesArray for ${venueCode} — may be too far in future`);
    }
  }
}

// ═════════════════════════════════════════════════════════════
// VERIFY SHOWS FOR TARGET DATE (NEW FIX)
// When a date becomes available but shows for current page date
// don't match the alert date, open a tab for the target date
// and verify actual shows exist before notifying.
// ═════════════════════════════════════════════════════════════
async function verifyShowsForTargetDate(alert, theatreName) {
  return new Promise((resolve) => {
    // Build URL for the target date
    const city = (alert.city || 'hyderabad').toLowerCase().replace(/\s+/g, '-');
    const slug = (alert.theatreSlug || alert.theatreName || alert.theatreCode)
                   .toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const targetUrl = `https://in.bookmyshow.com/cinemas/${city}/${slug}/buytickets/${alert.theatreCode}/${alert.date}`;
    
    chrome.tabs.create({ url: targetUrl, active: false }, (tab) => {
      if (!tab) { 
        console.log(`[ShowAlert] Failed to open verification tab for ${alert.theatreCode}`);
        resolve(); 
        return; 
      }

      const tabId = tab.id;
      console.log(`[ShowAlert] Opened verification tab ${tabId} for target date ${alert.date}`);
      
      silentTabs.set(tabId, { 
        venueCode: alert.theatreCode, 
        openedAt: Date.now(),
        isVerification: true,
        alert
      });

      // Close tab after 20 seconds (safety net)
      const closeTimer = setTimeout(() => {
        console.log(`[ShowAlert] Verification tab ${tabId} timeout - closing`);
        silentTabs.delete(tabId);
        chrome.tabs.remove(tabId, () => {});
        resolve();
      }, 20000);

      // Listen for PAGE_SHOW_DATA response with the target date's shows
      const msgListener = (msg) => {
        if (msg.action === 'PAGE_SHOW_DATA' && msg.venueCode === alert.theatreCode) {
          console.log(`[ShowAlert] Verification received for ${alert.theatreCode}, shows: ${msg.shows?.length || 0}`);
          
          clearTimeout(closeTimer);
          chrome.runtime.onMessage.removeListener(msgListener);
          silentTabs.delete(tabId);
          
          // NOW check if actual shows exist
          if (msg.shows && msg.shows.length > 0) {
            console.log(`[ShowAlert] ✅ VERIFIED! Real shows found for ${alert.date}. Sending notification.`);
            notifyAlert(alert.id, [{ date: alert.date, shows: msg.shows }]);
          } else {
            console.log(`[ShowAlert] ⚠️ Date ${alert.date} is available but NO SHOWS yet. Keeping alert active.`);
            // Don't fire - keep the alert watching for actual shows
          }
          
          setTimeout(() => {
            chrome.tabs.remove(tabId, () => {});
            resolve();
          }, 500);
        }
      };
      chrome.runtime.onMessage.addListener(msgListener);
    });
  });
}

// ═════════════════════════════════════════════════════════════
// NOTIFY (batched: one notification per alert covering all new dates)
// found: Array<{ date: 'YYYYMMDD', shows: show[] }>  (matching shows only)
// ═════════════════════════════════════════════════════════════
async function notifyAlert(alertId, found) {
  const alerts = await getAlerts();
  const alert  = alerts.find(a => a.id === alertId);
  if (!alert || alert.status !== 'watching') return;   // stopped/paused/deleted meanwhile

  const fresh = found.filter(f => !alert.notifiedDates.includes(f.date))
                     .sort((a, b) => a.date.localeCompare(b.date));
  if (!fresh.length) return;

  // Persist FIRST (idempotency) — a second caller now sees these dates as notified
  const updated = AlertCore.applyNotification(alert, fresh.map(f => f.date));
  updated.movies = [...new Set([...(alert.movies || []), ...fresh.flatMap(f => f.shows.map(s => s.movieTitle))])];
  await updateAlert(alertId, updated);

  console.log(`[ShowAlert] 🔔 Notifying ${alert.theatreName} for ${fresh.map(f => f.date).join(', ')}`);
  await sendDesktopNotification(updated, fresh);
  await sendEmailNotification(updated, fresh);
}

// ═════════════════════════════════════════════════════════════
// BACKGROUND POLL CYCLE
// Strategy: open a silent background tab for each un-notified alert.
// The content scripts (page_extractor.js + content.js) run inside
// that tab, read __INITIAL_STATE__, and send PAGE_SHOW_DATA back.
// We close the tab after extraction completes (or after timeout).
// This bypasses Cloudflare completely — the tab has real cookies.
// ═════════════════════════════════════════════════════════════
async function runPollCycle() {
  const alerts = await getAlerts();
  const active  = alerts.filter(a => a.status === 'watching' && !a.notified);
  if (!active.length) return;

  console.log(`[ShowAlert] Poll cycle: ${active.length} active alert(s)`);

  // Deduplicate: one tab per unique theatre (covers all date alerts for that venue)
  const seen = new Set();
  for (const alert of active) {
    if (seen.has(alert.theatreCode)) continue;
    seen.add(alert.theatreCode);

    // Open the theatre's page for TODAY — this always loads with full data.
    // ShowDatesArray inside tells us which future dates just opened.
    const todayDate = todayYYYYMMDD();
    const url = buildBMSUrl(alert);

    console.log(`[ShowAlert] Opening background tab for ${alert.theatreCode}: ${url}`);
    await openSilentTab(url, alert.theatreCode);

    // Stagger between theatres to be respectful
    await sleep(4000);
  }
}

// Build the BMS buytickets URL for a given alert
// Always uses today's date — BMS loads the venue + ShowDatesArray for all dates
function buildBMSUrl(alert) {
  const city   = (alert.city        || 'hyderabad').toLowerCase().replace(/\s+/g, '-');
  const slug   = (alert.theatreSlug || alert.theatreName || alert.theatreCode)
                   .toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const today  = todayYYYYMMDD();
  return `https://in.bookmyshow.com/cinemas/${city}/${slug}/buytickets/${alert.theatreCode}/${today}`;
}

// Open a tab in the background, let content scripts run, then close it
function openSilentTab(url, venueCode) {
  return new Promise((resolve) => {
    chrome.tabs.create({ url, active: false }, (tab) => {
      if (!tab) { resolve(); return; }

      const tabId = tab.id;

      // Track that this tab was opened by ShowAlert for cleanup
      silentTabs.set(tabId, { venueCode, openedAt: Date.now() });

      // Close the tab after 15 seconds regardless (safety net)
      const closeTimer = setTimeout(() => {
        silentTabs.delete(tabId);
        chrome.tabs.remove(tabId, () => {});
        resolve();
      }, 15000);

      // Listen for the PAGE_SHOW_DATA message that content.js sends.
      // When we receive it for this venue, close the tab sooner.
      const msgListener = (msg) => {
        if (msg.action === 'PAGE_SHOW_DATA' && msg.venueCode === venueCode) {
          clearTimeout(closeTimer);
          chrome.runtime.onMessage.removeListener(msgListener);
          silentTabs.delete(tabId);
          // Give background.js handlePageData() a moment to process first
          setTimeout(() => {
            chrome.tabs.remove(tabId, () => {});
            resolve();
          }, 800);
        }
      };
      chrome.runtime.onMessage.addListener(msgListener);
    });
  });
}

// Track silent tabs so we can clean up on restart
const silentTabs = new Map();

function todayYYYYMMDD() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

async function tryApiPoll(alert) {
  // Direct API call — kept as best-effort fallback only.
  // Usually blocked by Cloudflare from service worker context.
  try {
    const shows = await fetchBMSShows(alert.theatreCode, alert.date);
    if (shows.length > 0) {
      await updateAlert(alert.id, { lastChecked: Date.now() });
      await notifyAlert(alert.id, [{ date: alert.date, shows }]);
    }
  } catch (e) {
    // Expected — Cloudflare blocks service worker requests
  }
}

// ═════════════════════════════════════════════════════════════
// BMS API FETCH (best-effort, often blocked by Cloudflare)
// ═════════════════════════════════════════════════════════════
async function fetchBMSShows(theatreCode, date) {
  const { bmsTokens = {} } = await chrome.storage.local.get('bmsTokens');
  const token      = bmsTokens.bmsApiToken || '26x3aab5x746514b3b7b';
  const bmsId      = bmsTokens.bmsId       || '';
  const regionCode = bmsTokens.regionCode  || 'HYD';

  const params = new URLSearchParams({
    venueCode:  theatreCode,
    dateCode:   date,
    regionCode,
    appCode:    'WEBV2',
    token,
    bmsId,
    lsId:       '',
    memberId:   '',
    vc:         theatreCode
  });

  const url = `https://in.bookmyshow.com/api/venue-showtimes-functional/getShowtimesByVenue?${params}`;

  let res;
  try {
    res = await fetch(url, {
      headers: {
        'Accept':          'application/json, */*',
        'Accept-Language': 'en-IN,en;q=0.9',
        'Origin':          'https://in.bookmyshow.com',
        'Referer':         'https://in.bookmyshow.com/',
        'X-Access-Token':  '67x1xa33315o185e'
      }
    });
  } catch (e) {
    throw new Error(`Network: ${e.message}`);
  }

  if (res.status === 429) throw new Error('Rate limited');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('json')) throw new Error('Cloudflare HTML response (no cookies in service worker)');

  const data = await res.json();
  return parseVenueShowtimes(data);
}

function parseVenueShowtimes(data) {
  const shows = [];
  const root   = data?.data || data;
  const events = root?.showDetailsTransformed?.Event || root?.Event || [];

  for (const event of (Array.isArray(events) ? events : [])) {
    const movieTitle = event.EventTitle || 'Unknown';
    for (const child of (event.ChildEvents || [])) {
      const language  = child.EventLanguage  || '';
      const dimension = child.EventDimension || '2D';
      for (const slot of (child.ShowTimes || [])) {
        const avail = String(slot.AvailStatus ?? '0');
        if (avail === '0') continue;
        shows.push({
          movieTitle,
          time:     slot.ShowTime   || '',
          format:   slot.Attributes || dimension,
          language,
          screen:   slot.ScreenName || '',
          minPrice: slot.MinPrice   || '',
          maxPrice: slot.MaxPrice   || '',
          status:   (avail === '1' || avail === '2') ? 'fast_filling' : 'available'
        });
      }
    }
  }
  return shows;
}

// ═════════════════════════════════════════════════════════════
// DESKTOP NOTIFICATION
// ═════════════════════════════════════════════════════════════
function screenLabel(alert) { return (alert.screenFilter || '').trim().toUpperCase(); }

function timesOf(shows, n) {
  return shows.slice(0, n).map(s => s.time).filter(Boolean).join(', ');
}

async function sendDesktopNotification(alert, found) {
  const screen = screenLabel(alert);
  const title  = screen
    ? `🎬 ${screen} open – ${alert.theatreName}`
    : `🎬 Tickets Open! – ${alert.theatreName}`;

  const lines = found.slice(0, 4).map(f => {
    const movie = alert.movieFilter?.trim() || f.shows[0]?.movieTitle || 'Shows';
    return [movie, formatDate(f.date), timesOf(f.shows, 3)].filter(Boolean).join(' · ');
  });
  if (found.length > 4) lines.push(`+${found.length - 4} more dates`);

  const buttons = [{ title: '🎟️ Book Now' }];
  if (alert.status === 'watching') buttons.push({ title: '🛑 Stop this alert' });

  chrome.notifications.create(AlertCore.notificationId(alert.id, found[0].date), {
    type: 'basic', iconUrl: 'icons/icon128.png',
    title, message: lines.join('\n'), priority: 2, buttons
  });
}

// One listener for all notifications (ids encode alert + date)
async function openBookingFor(notifId) {
  const p = AlertCore.parseNotificationId(notifId);
  if (!p) return;
  const alert = (await getAlerts()).find(a => a.id === p.alertId);
  if (alert) chrome.tabs.create({ url: AlertCore.buildBMSUrl(alert, p.date) });
}

chrome.notifications.onButtonClicked.addListener(async (notifId, btnIdx) => {
  const p = AlertCore.parseNotificationId(notifId);
  if (!p) return;
  if (btnIdx === 0) {
    await openBookingFor(notifId);
  } else if (btnIdx === 1) {
    await updateAlert(p.alertId, { status: 'done' });
    chrome.notifications.clear(notifId);
    console.log(`[ShowAlert] Alert ${p.alertId} stopped from notification`);
  }
});

chrome.notifications.onClicked.addListener(openBookingFor);

// ═════════════════════════════════════════════════════════════
// EMAIL NOTIFICATION (multi-provider, all free)
// ═════════════════════════════════════════════════════════════
function showLine(s) {
  return [s.movieTitle, s.time && `@ ${s.time}`, s.screen && `· ${s.screen}`,
          s.format && `[${s.format}]`, s.language && `· ${s.language}`].filter(Boolean).join(' ');
}

async function sendEmailNotification(alert, found) {
  const settings = await getSettings();
  const { email, emailProvider, emailApiKey } = settings;
  if (!emailProvider || !emailApiKey) {
    console.log('[ShowAlert] No email provider — desktop notification only');
    return;
  }

  const screen   = screenLabel(alert);
  const dateList = found.map(f => formatDate(f.date)).join(', ');
  const subject  = `🎬 ${screen || 'Tickets'} open · ${alert.theatreName} · ${dateList}`;
  const sections = found.map(f => ({
    date:  f.date,
    link:  AlertCore.buildBMSUrl(alert, f.date),
    lines: f.shows.slice(0, 10).map(showLine)
  }));

  const htmlBody = buildEmailHtml(alert, sections);
  const textBody = [
    'Tickets are now available!', '',
    `Theatre: ${alert.theatreName}`, `City: ${alert.city}`,
    screen ? `Screen: ${screen}` : null,
    alert.movieFilter ? `Movie: ${alert.movieFilter}` : null, '',
    ...sections.flatMap(s => [`${formatDate(s.date)}:`, ...s.lines, `Book: ${s.link}`, ''])
  ].filter(l => l !== null).join('\n');

  try {
    switch (emailProvider) {
      case 'resend':     await sendViaResend(emailApiKey, email, subject, htmlBody, textBody); break;
      case 'brevo':      await sendViaBrevo(emailApiKey, email, subject, htmlBody, textBody); break;
      case 'mailersend': await sendViaMailerSend(emailApiKey, email, subject, htmlBody, textBody); break;
      case 'mailjet':    await sendViaMailjet(emailApiKey, settings.emailApiSecret, email, subject, htmlBody, textBody); break;
    }
  } catch (e) {
    console.error('[ShowAlert] Email error:', e.message);
  }
}

async function sendViaResend(apiKey, to, subject, html, text) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'ShowAlert <onboarding@resend.dev>', to: [to], subject, html, text })
  });
  if (!r.ok) throw new Error(`Resend ${r.status}: ${await r.text()}`);
  console.log('[ShowAlert] ✅ Email sent via Resend');
}

async function sendViaBrevo(apiKey, to, subject, html, text) {
  const r = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sender: { name: 'ShowAlert', email: to }, to: [{ email: to }], subject, htmlContent: html, textContent: text })
  });
  if (!r.ok) throw new Error(`Brevo ${r.status}: ${await r.text()}`);
  console.log('[ShowAlert] ✅ Email sent via Brevo');
}

async function sendViaMailerSend(apiKey, to, subject, html, text) {
  const r = await fetch('https://api.mailersend.com/v1/email', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: { email: 'noreply@yourdomain.com', name: 'ShowAlert' }, to: [{ email: to }], subject, html, text })
  });
  if (!r.ok) throw new Error(`MailerSend ${r.status}: ${await r.text()}`);
  console.log('[ShowAlert] ✅ Email sent via MailerSend');
}

async function sendViaMailjet(apiKey, secretKey, to, subject, html, text) {
  const auth = btoa(`${apiKey}:${secretKey}`);
  const r = await fetch('https://api.mailjet.com/v3.1/send', {
    method: 'POST',
    headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ Messages: [{ From: { Email: to, Name: 'ShowAlert' }, To: [{ Email: to }], Subject: subject, HTMLPart: html, TextPart: text }] })
  });
  if (!r.ok) throw new Error(`Mailjet ${r.status}: ${await r.text()}`);
  console.log('[ShowAlert] ✅ Email sent via Mailjet');
}

function escHtml(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function buildEmailHtml(alert, sections) {
  const infoRow = (label, value, last) =>
    `<tr><td style="padding:10px 14px;${last ? '' : 'border-bottom:1px solid #2a2a38'}"><div style="font-size:10px;text-transform:uppercase;color:#6a6a80;margin-bottom:3px">${label}</div><div style="font-size:14px;font-weight:600;color:#f0eee8">${escHtml(value)}</div></td></tr>`;
  const info = [['Theatre', alert.theatreName], ['City', alert.city]];
  if (alert.screenFilter) info.push(['Screen', screenLabel(alert)]);
  if (alert.movieFilter)  info.push(['Movie', alert.movieFilter]);
  const infoRows = info.map(([l, v], i) => infoRow(l, v, i === info.length - 1)).join('');

  const dateSections = sections.map(s => {
    const rows = s.lines.map(l =>
      `<tr><td style="padding:9px 14px;border-bottom:1px solid #2a2a38;font-size:13px;color:#b0adb8">${escHtml(l)}</td></tr>`
    ).join('');
    return `<div style="font-size:11px;text-transform:uppercase;color:#6a6a80;margin-bottom:10px">${escHtml(formatDate(s.date))}</div>
<table style="width:100%;border-collapse:collapse;background:#1c1c22;border:1px solid #2a2a38;border-radius:10px;overflow:hidden;margin-bottom:10px">${rows}</table>
<a href="${s.link}" style="display:block;background:#e8003d;color:#fff;text-align:center;padding:12px;border-radius:10px;text-decoration:none;font-weight:700;font-size:14px;margin-bottom:20px">🎟️ Book ${escHtml(formatDate(s.date))} on BookMyShow →</a>`;
  }).join('');

  const heading = screenLabel(alert) ? `${screenLabel(alert)} Is Now Open!` : 'Tickets Are Now Open!';

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#0a0a0c;font-family:-apple-system,'Segoe UI',sans-serif">
<div style="max-width:520px;margin:0 auto;padding:20px">
<div style="background:linear-gradient(135deg,#1c0810,#0d0d14);border:1px solid #2a2a38;border-radius:16px;overflow:hidden">
<div style="background:#e8003d;padding:24px;text-align:center">
<div style="font-size:2rem;margin-bottom:8px">🎬</div>
<h1 style="margin:0;color:#fff;font-size:1.3rem;font-weight:700">${escHtml(heading)}</h1>
<p style="margin:6px 0 0;color:rgba(255,255,255,0.85);font-size:13px">BookMyShow · ShowAlert</p>
</div>
<div style="padding:24px">
<table style="width:100%;border-collapse:collapse;background:#1c1c22;border:1px solid #2a2a38;border-radius:10px;overflow:hidden;margin-bottom:20px">${infoRows}</table>
${dateSections}
</div>
<div style="padding:14px 24px;border-top:1px solid #2a2a38;text-align:center;font-size:11px;color:#6a6a80">Sent by ShowAlert · Not affiliated with BookMyShow</div>
</div></div></body></html>`;
}

// ═════════════════════════════════════════════════════════════
// STORAGE HELPERS
// ═════════════════════════════════════════════════════════════
async function getSettings() { const { settings = {} } = await chrome.storage.local.get('settings'); return settings; }

// Always returns normalized alerts; persists the migration if anything changed.
async function getAlerts() {
  const { alerts = [] } = await chrome.storage.local.get('alerts');
  const normalized = alerts.map(AlertCore.normalizeAlert);
  if (JSON.stringify(normalized) !== JSON.stringify(alerts)) {
    await chrome.storage.local.set({ alerts: normalized });
  }
  return normalized;
}

async function updateAlert(id, fields) {
  const alerts = await getAlerts();
  const idx    = alerts.findIndex(a => a.id === id);
  if (idx === -1) return;
  Object.assign(alerts[idx], fields);
  await chrome.storage.local.set({ alerts });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function formatDate(d) {
  if (!d || d.length !== 8) return d || '';
  return new Date(`${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}`)
    .toLocaleDateString('en-IN', { day:'numeric', month:'short', year:'numeric' });
}
