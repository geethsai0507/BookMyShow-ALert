// ─────────────────────────────────────────────────────────────
// background.js  –  ShowAlert Service Worker
//
// ARCHITECTURE:
//  Show data only comes from BMS pages: page_extractor.js reads
//  window.__INITIAL_STATE__ and content.js relays it here as
//  PAGE_SHOW_DATA (one page = one date's shows + list of open dates).
//
//  CHECK CYCLE (alarm, every N min): for each theatre with watching
//  alerts, one tab inside a dedicated MINIMIZED window loads today's
//  page, then navigates to each open future date an alert still needs
//  and waits for that tab's PAGE_SHOW_DATA. Matching (screen / movie /
//  date) and notification state live in alert_core.js.
//
//  PASSIVE: when the user browses a theatre page themselves, that
//  page's date is matched too.
//
// REDIRECT HANDLING:
//  An open date's URL loads that date. A date that isn't open yet
//  redirects to today — so data is accepted only when its currentDate
//  equals the date we asked for.
// ─────────────────────────────────────────────────────────────

importScripts('alert_core.js');

const ALARM_NAME          = 'showalert-poll';
const ALARM_PERIOD        = 3;              // minutes
const LOCK_STALE_MS       = 3 * 60 * 1000;  // lock older than this is from a dead worker
const PER_DATE_TIMEOUT_MS = 15000;
const THEATRE_STAGGER_MS  = 4000;

// ═════════════════════════════════════════════════════════════
// INSTALL / STARTUP
// ═════════════════════════════════════════════════════════════
chrome.runtime.onInstalled.addListener(async () => {
  console.log('[ShowAlert] Installed.');
  await getAlerts();          // migrates legacy alerts
  await closeCheckWindow();
  await maybeStartAlarm();
});

chrome.runtime.onStartup.addListener(async () => {
  await getAlerts();          // migrates legacy alerts
  await closeCheckWindow();
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

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== ALARM_NAME) return;
  await runPollCycle();
});

// ═════════════════════════════════════════════════════════════
// MESSAGE HANDLER
// ═════════════════════════════════════════════════════════════
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.action) {

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

      case 'SAVE_BMS_TOKENS':
        if (msg.tokens?.bmsApiToken) await chrome.storage.local.set({ bmsTokens: msg.tokens });
        sendResponse({ ok: true });
        break;

      // Page data: from our check tab → the waiting cycle; otherwise passive match
      case 'PAGE_SHOW_DATA': {
        const tabId = sender.tab?.id;
        console.log('[ShowAlert] PAGE_SHOW_DATA', { tab: tabId, venue: msg.venueCode, date: msg.currentDate, shows: msg.shows?.length });
        if (tabId != null && waiters.has(tabId)) {
          resolveWaiter(tabId, msg);
        } else if (!(await isCheckTab(tabId))) {
          await handlePageData(msg);
        }
        sendResponse({ ok: true });
        break;
      }

      // New or resumed alert: check its theatre now (skipped if a cycle is running)
      case 'ALERT_ADDED':
      case 'ALERT_UPDATED':
        if (msg.alert?.status !== 'paused' && msg.alert?.status !== 'done') {
          runPollCycle(msg.alert.theatreCode);
        }
        sendResponse({ ok: true });
        break;

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
// PASSIVE: user is browsing a theatre page — match that page's date
// ═════════════════════════════════════════════════════════════
async function handlePageData(data) {
  if (!AlertCore.isDateCode(data.currentDate)) return;
  const today  = todayYYYYMMDD();
  const alerts = (await getAlerts()).filter(a => a.theatreCode === data.venueCode && a.status === 'watching');
  for (const alert of alerts) {
    await updateAlert(alert.id, { lastChecked: Date.now() });
    const found = AlertCore.collectNewDates(alert, { [data.currentDate]: data.shows || [] }, today);
    if (found.length) await notifyAlert(alert.id, found);
  }
}

// ═════════════════════════════════════════════════════════════
// NOTIFY (batched: one notification per alert covering all new dates)
// found: Array<{ date: 'YYYYMMDD', shows: show[] }>  (matching shows only)
// ═════════════════════════════════════════════════════════════
async function notifyAlert(alertId, found) {
  // Decide + persist inside the alert queue so concurrent callers can't both
  // notify the same date or overwrite a pause/stop with a stale copy.
  const result = await alertQueue(async () => {
    const alert = (await getAlerts()).find(a => a.id === alertId);
    if (!alert || alert.status !== 'watching') return null;   // stopped/paused/deleted meanwhile

    const fresh = found.filter(f => !alert.notifiedDates.includes(f.date))
                       .sort((a, b) => a.date.localeCompare(b.date));
    if (!fresh.length) return null;

    const delta  = AlertCore.notificationDelta(alert, fresh.map(f => f.date));
    delta.movies = [...new Set([...(alert.movies || []), ...fresh.flatMap(f => f.shows.map(s => s.movieTitle))])];
    await writeAlertFields(alertId, delta);   // persist FIRST (idempotency)
    return { alert, fresh, updated: { ...alert, ...delta } };
  });
  if (!result) return;
  const { alert, fresh, updated } = result;

  console.log(`[ShowAlert] 🔔 Notifying ${alert.theatreName} for ${fresh.map(f => f.date).join(', ')}`);
  await sendDesktopNotification(updated, fresh);
  await sendEmailNotification(updated, fresh);
}

// ═════════════════════════════════════════════════════════════
// CHECK CYCLE — one minimized window, one tab, walk open dates
// ═════════════════════════════════════════════════════════════
let cycleRunning      = false;
let checkWindowClosed = false;   // user closed the check window during this cycle
let checkWindowId     = null;    // mirrors storage.session so onRemoved can react synchronously
const waiters = new Map();   // tabId → { expectedVenue, expectedDate, resolve, timer }

async function runPollCycle(onlyTheatreCode = null) {
  if (cycleRunning || !(await acquireLock())) {
    console.log('[ShowAlert] Check cycle already running — skipping');
    return;
  }
  cycleRunning = true;
  try {
    await closeCheckWindow();       // stale window from a worker that died mid-cycle
    checkWindowClosed = false;
    const watching = (await getAlerts()).filter(a => a.status === 'watching');
    const codes = [...new Set(watching.map(a => a.theatreCode))]
      .filter(c => !onlyTheatreCode || c === onlyTheatreCode);
    if (!codes.length) return;

    console.log(`[ShowAlert] Check cycle: ${codes.length} theatre(s)`);
    for (let i = 0; i < codes.length; i++) {
      if (checkWindowClosed) { console.log('[ShowAlert] Check window closed — cycle aborted'); break; }
      await refreshLock();
      const result = await checkTheatre(codes[i]);
      if (result === 'aborted') { console.log('[ShowAlert] Check window closed — cycle aborted'); break; }
      if (i < codes.length - 1) await sleep(THEATRE_STAGGER_MS);
    }
  } catch (e) {
    console.error('[ShowAlert] Check cycle error:', e);
  } finally {
    await closeCheckWindow();
    await releaseLock();
    cycleRunning = false;
  }
}

async function watchingAlertsFor(theatreCode) {
  return (await getAlerts()).filter(a => a.theatreCode === theatreCode && a.status === 'watching');
}

async function checkTheatre(theatreCode) {
  const today = todayYYYYMMDD();
  let alerts  = await watchingAlertsFor(theatreCode);
  if (!alerts.length) return;
  const ref = alerts.find(a => a.citySlug) || alerts[0];   // best URL source

  const { tabId } = await getCheckWindow();

  // First load: accept whichever date BMS serves (today, or a redirect target)
  const first = await navigateAndWait(tabId, AlertCore.buildBMSUrl(ref, today), theatreCode, null);
  if (!first && !(await checkWindowAlive())) return 'aborted';
  if (!first) { console.log(`[ShowAlert] ${theatreCode}: no page data (timeout)`); return; }

  const showsByDate = { [first.currentDate]: first.shows || [] };

  alerts = await watchingAlertsFor(theatreCode);
  const toVisit = AlertCore.datesToVisit(alerts, first.availableDates || [], today)
    .filter(d => d !== first.currentDate);
  console.log(`[ShowAlert] ${theatreCode}: open dates ${JSON.stringify(first.availableDates)} → visiting ${JSON.stringify(toVisit)}`);

  for (const date of toVisit) {
    const data = await navigateAndWait(tabId, AlertCore.buildBMSUrl(ref, date), theatreCode, date);
    if (!data && !(await checkWindowAlive())) return 'aborted';
    if (data) showsByDate[date] = data.shows || [];
    else console.log(`[ShowAlert] ${theatreCode}: ${date} not served (redirect or timeout)`);
  }

  // Re-read: user may have paused/stopped/deleted alerts during the walk
  for (const alert of await watchingAlertsFor(theatreCode)) {
    await updateAlert(alert.id, { lastChecked: Date.now() });
    const found = AlertCore.collectNewDates(alert, showsByDate, today);
    if (found.length) await notifyAlert(alert.id, found);
  }
}

// Navigate the check tab and wait for its PAGE_SHOW_DATA for this theatre.
// expectedDate null = accept any date; otherwise a different date (redirect) → null.
// Data from another theatre (a late post from the previous page) is ignored.
function navigateAndWait(tabId, url, expectedVenue, expectedDate, timeoutMs = PER_DATE_TIMEOUT_MS) {
  return new Promise(resolve => {
    const timer = setTimeout(() => { waiters.delete(tabId); resolve(null); }, timeoutMs);
    waiters.set(tabId, { expectedVenue, expectedDate, resolve, timer });
    chrome.tabs.update(tabId, { url }).catch(() => {
      clearTimeout(timer); waiters.delete(tabId); resolve(null);
    });
  });
}

function resolveWaiter(tabId, data) {
  const w = waiters.get(tabId);
  if (!w) return;
  const verdict = AlertCore.waiterVerdict(w, data);
  if (verdict === 'ignore') return;            // stale page of another theatre — keep waiting
  clearTimeout(w.timer);
  waiters.delete(tabId);
  w.resolve(verdict === 'accept' ? data : null);
}

function resolveAllWaiters() {
  for (const tabId of [...waiters.keys()]) {
    const w = waiters.get(tabId);
    clearTimeout(w.timer);
    waiters.delete(tabId);
    w.resolve(null);
  }
}

// ── Check window (minimized, never focused) ──────────────────
async function getCheckWindow() {
  const { checkWindow } = await chrome.storage.session.get('checkWindow');
  if (checkWindow) {
    try {
      await chrome.windows.get(checkWindow.windowId);
      await chrome.tabs.get(checkWindow.tabId);
      checkWindowId = checkWindow.windowId;
      return checkWindow;
    } catch (_) { /* gone — create a new one */ }
  }
  const win = await chrome.windows.create({ url: 'about:blank', state: 'minimized', focused: false });
  const cw  = { windowId: win.id, tabId: win.tabs[0].id };
  checkWindowId = cw.windowId;
  await chrome.storage.session.set({ checkWindow: cw });
  return cw;
}

async function checkWindowAlive() {
  if (checkWindowClosed || checkWindowId == null) return false;
  try { await chrome.windows.get(checkWindowId); return true; } catch (_) { return false; }
}

async function closeCheckWindow() {
  checkWindowId = null;             // our own close must not count as "user closed it"
  const { checkWindow } = await chrome.storage.session.get('checkWindow');
  if (!checkWindow) return;
  await chrome.storage.session.remove('checkWindow');
  try { await chrome.windows.remove(checkWindow.windowId); } catch (_) { /* already closed */ }
}

async function isCheckTab(tabId) {
  if (tabId == null) return false;
  const { checkWindow } = await chrome.storage.session.get('checkWindow');
  return checkWindow?.tabId === tabId;
}

chrome.windows.onRemoved.addListener(async windowId => {
  if (windowId !== checkWindowId) return;   // not ours, or we closed it ourselves
  checkWindowClosed = true;                 // set synchronously, before any await
  checkWindowId = null;
  resolveAllWaiters();
  await chrome.storage.session.remove('checkWindow');
});

// ── Cycle lock (survives worker restarts via storage.session) ─
async function acquireLock() {
  const { cycleLock } = await chrome.storage.session.get('cycleLock');
  if (cycleLock && Date.now() - cycleLock.startedAt < LOCK_STALE_MS) return false;
  await chrome.storage.session.set({ cycleLock: { startedAt: Date.now() } });
  return true;
}
async function refreshLock() { await chrome.storage.session.set({ cycleLock: { startedAt: Date.now() } }); }
async function releaseLock() { await chrome.storage.session.remove('cycleLock'); }

function todayYYYYMMDD() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

// ═════════════════════════════════════════════════════════════
// DESKTOP NOTIFICATION
// ═════════════════════════════════════════════════════════════
function screenLabel(alert) { return (alert.screenFilter || '').trim().toUpperCase(); }

function timesOf(shows, n) {
  return shows.slice(0, n).map(AlertCore.describeShowTime).filter(Boolean).join(', ');
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
  const when = AlertCore.describeShowTime(s);
  return [s.movieTitle, when && `@ ${when}`, s.screen && `· ${s.screen}`,
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

// All alert writes in the worker go through this queue (read-modify-write is atomic here).
const alertQueue = AlertCore.createSerialQueue();

function updateAlert(id, fields) {
  return alertQueue(() => writeAlertFields(id, fields));
}

// Only call from inside alertQueue.
async function writeAlertFields(id, fields) {
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
