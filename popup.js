// ─────────────────────────────────────────────────────────────
// popup.js  –  ShowAlert Chrome Extension
// ─────────────────────────────────────────────────────────────

// ── DOM SHORTCUTS ──────────────────────────────────────────
const $ = id => document.getElementById(id);
const screenSetup  = $('screenSetup');
const screenMain   = $('screenMain');
const bmsPageBanner = $('bmsPageBanner');
const bmsHint      = $('bmsHint');
const alertsList   = $('alertsList');
const alertCount   = $('alertCount');
const modalNotify  = $('modalNotify');
const modalSettings = $('modalSettings');

// ── CURRENT TAB STATE ─────────────────────────────────────
let currentTabInfo = null;   // { theatreCode, theatreName, city, date } if on BMS page

// ═════════════════════════════════════════════════════════════
// INIT
// ═════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', async () => {
  const settings = await getSettings();

  if (!settings.email) {
    showScreen('setup');
  } else {
    showScreen('main');
    await initMainScreen(settings);
  }

  bindEvents();
  setDefaultDates();
});

async function initMainScreen(settings) {
  $('footerEmail').textContent = settings.email || '';

  // Detect if current tab is a BMS cinema buytickets page
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url) {
      const bmsInfo = parseBMSUrl(tab.url);
      if (bmsInfo) {
        currentTabInfo = bmsInfo;

        // Banner
        $('bannerTheatreName').textContent = bmsInfo.theatreName;
        $('bannerPageInfo').textContent    = `${bmsInfo.city} · ${formatDate(bmsInfo.date)}`;
        bmsPageBanner.classList.remove('hidden');

        // Pre-fill modal with all auto-detected info
        $('modalTheatreName').textContent = bmsInfo.theatreName;
        $('modalCity').textContent        = bmsInfo.city;
        $('modalCode').textContent        = bmsInfo.theatreCode;
        $('modalDate').value              = toInputDate(bmsInfo.date);

        // Screen / movie suggestions captured from this theatre's page
        const { lastBMSPage } = await chrome.storage.local.get('lastBMSPage');
        if (lastBMSPage?.theatreCode === bmsInfo.theatreCode) {
          fillDatalist('modalScreenList', lastBMSPage.screens);
          fillDatalist('modalMovieList',  lastBMSPage.movies);
        }

        // On a BMS page — hide manual add, it's not needed
        $('manualAddSection').classList.add('hidden');
        bmsHint.classList.add('hidden');
      } else {
        // Not on a BMS page — show hint and keep manual add
        bmsHint.classList.remove('hidden');
        $('manualAddSection').classList.remove('hidden');
      }
    }
  } catch (_) {
    bmsHint.classList.remove('hidden');
  }

  await renderAlerts();
  updateMonitorBadge();
}

// ═════════════════════════════════════════════════════════════
// EVENT BINDING
// ═════════════════════════════════════════════════════════════
function bindEvents() {
  // ── SETUP ──
  $('btnSaveSetup').addEventListener('click', saveSetup);
  $('setupEmail').addEventListener('keydown', e => e.key === 'Enter' && saveSetup());

  // ── MAIN HEADER ──
  $('btnSettings').addEventListener('click', openSettings);

  // ── NOTIFY ME BANNER ──
  $('btnNotifyMe').addEventListener('click', () => {
    if (currentTabInfo) openNotifyModal(currentTabInfo);
  });

  // ── NOTIFY MODAL ──
  $('btnModalClose').addEventListener('click', closeNotifyModal);
  $('btnConfirmAlert').addEventListener('click', confirmAlert);
  modalNotify.addEventListener('click', e => { if (e.target === modalNotify) closeNotifyModal(); });

  // ── MANUAL ADD ──
  $('toggleManual').addEventListener('click', toggleManualForm);
  $('btnAddManual').addEventListener('click', addManualAlert);

  // ── ALERT FORMS (screen / movie / date mode / notify mode) ──
  bindAlertForm('modal');
  bindAlertForm('manual');

  // ── SETTINGS MODAL ──
  $('btnSettingsClose').addEventListener('click', closeSettings);
  $('btnSaveSettings').addEventListener('click', saveSettings);
  modalSettings.addEventListener('click', e => { if (e.target === modalSettings) closeSettings(); });
  bindProviderCards();

  // ── CLEAR ALL ──
  $('btnClearAll').addEventListener('click', clearAllAlerts);
}

function setDefaultDates() {
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
  const iso = tomorrow.toISOString().split('T')[0];
  const today = new Date().toISOString().split('T')[0];
  $('modalDate').min  = today;
  $('manualDate').min = today;
  $('modalDate').value  = iso;
  $('manualDate').value = iso;
}

// ═════════════════════════════════════════════════════════════
// SETUP FLOW
// ═════════════════════════════════════════════════════════════
async function saveSetup() {
  const email = $('setupEmail').value.trim();
  if (!email || !isValidEmail(email)) { showToast('Enter a valid email address', 'error'); return; }

  const btn = $('btnSaveSetup');
  btn.textContent = 'Setting up…';
  btn.disabled = true;

  const settings = {
    email,
    emailjsServiceId:  '',
    emailjsTemplateId: '',
    emailjsPublicKey:  '',
    pollIntervalMin:   3,
    setupDone: true
  };

  await chrome.storage.local.set({ settings });
  chrome.runtime.sendMessage({ action: 'START_MONITORING', settings });

  showScreen('main');
  await initMainScreen(settings);
  showToast('✅ ShowAlert is active!', 'success');
}

// ═════════════════════════════════════════════════════════════
// NOTIFY ME MODAL
// ═════════════════════════════════════════════════════════════
function openNotifyModal(info) {
  $('modalTheatreName').textContent = info.theatreName || `Theatre ${info.theatreCode}`;
  if (info.date) $('modalDate').value = toInputDate(info.date);
  modalNotify.classList.remove('hidden');
}

function closeNotifyModal() {
  modalNotify.classList.add('hidden');
}

async function confirmAlert() {
  if (!currentTabInfo) { showToast('No theatre detected', 'error'); return; }
  const form = readAlertForm('modal');
  if (form.error) { showToast(form.error, 'error'); return; }

  const alertObj = newAlert({
    theatreCode: currentTabInfo.theatreCode,
    theatreName: currentTabInfo.theatreName,
    theatreSlug: currentTabInfo.theatreSlug || '',
    citySlug:    currentTabInfo.citySlug || '',
    city:        currentTabInfo.city
  }, form);

  if (!(await saveAlert(alertObj))) return;
  chrome.runtime.sendMessage({ action: 'ALERT_ADDED', alert: alertObj });
  closeNotifyModal();
  resetAlertForm('modal');
  await renderAlerts();
  showToast(`🔔 Alert set · ${describeWhen(alertObj)}`, 'success');
}

// ═════════════════════════════════════════════════════════════
// MANUAL ADD
// ═════════════════════════════════════════════════════════════
function toggleManualForm() {
  const form = $('manualForm');
  const btn  = $('toggleManual');
  const open = form.classList.toggle('hidden');
  btn.textContent = open ? '▾ Expand' : '▴ Collapse';
}

async function addManualAlert() {
  const code = $('manualCode').value.trim().toUpperCase();
  const name = $('manualName').value.trim();
  const city = $('manualCity').value.trim();
  if (!code || !name || !city) { showToast('Fill in theatre code, name and city', 'error'); return; }

  const form = readAlertForm('manual');
  if (form.error) { showToast(form.error, 'error'); return; }

  const alertObj = newAlert({ theatreCode: code, theatreName: name, theatreSlug: '', citySlug: '', city }, form);
  if (!(await saveAlert(alertObj))) return;
  chrome.runtime.sendMessage({ action: 'ALERT_ADDED', alert: alertObj });

  $('manualCode').value = ''; $('manualName').value = ''; $('manualCity').value = '';
  resetAlertForm('manual');
  toggleManualForm();

  await renderAlerts();
  showToast('🔔 Alert added!', 'success');
}

// ═════════════════════════════════════════════════════════════
// ALERT FORM HELPERS (shared by the modal and the manual form)
// ═════════════════════════════════════════════════════════════
const formTouched = {};   // prefix → user changed a radio themselves

function radioVal(name) {
  return document.querySelector(`input[name="${name}"]:checked`)?.value;
}
function setRadio(name, value) {
  const r = document.querySelector(`input[name="${name}"][value="${value}"]`);
  if (r) r.checked = true;
}

function syncAlertForm(prefix) {
  $(prefix + 'Date').disabled  = radioVal(prefix + 'DateMode') !== 'single';
  $(prefix + 'Limit').disabled = radioVal(prefix + 'NotifyMode') !== 'limit';
}

// Defaults follow the screen box until the user picks radios themselves:
// screen given → Any date + Every new date; empty → Specific date + Once.
function applyScreenDefaults(prefix) {
  if (formTouched[prefix]) return;
  const hasScreen = !!$(prefix + 'Screen').value.trim();
  setRadio(prefix + 'DateMode',   hasScreen ? 'any'   : 'single');
  setRadio(prefix + 'NotifyMode', hasScreen ? 'every' : 'once');
  syncAlertForm(prefix);
}

function bindAlertForm(prefix) {
  document.querySelectorAll(`input[name="${prefix}DateMode"], input[name="${prefix}NotifyMode"]`)
    .forEach(r => r.addEventListener('change', () => { formTouched[prefix] = true; syncAlertForm(prefix); }));
  $(prefix + 'Screen').addEventListener('input', () => applyScreenDefaults(prefix));
  syncAlertForm(prefix);
}

function resetAlertForm(prefix) {
  $(prefix + 'Screen').value = '';
  $(prefix + 'Movie').value  = '';
  $(prefix + 'Limit').value  = '3';
  setRadio(prefix + 'SeatFilter', 'any');
  formTouched[prefix] = false;
  applyScreenDefaults(prefix);
}

function readAlertForm(prefix) {
  const dateMode   = radioVal(prefix + 'DateMode')   || 'single';
  const notifyMode = radioVal(prefix + 'NotifyMode') || 'once';
  const dateVal    = $(prefix + 'Date').value;
  const limit      = parseInt($(prefix + 'Limit').value, 10);

  if (dateMode === 'single' && !dateVal) return { error: 'Pick a date first' };
  if (notifyMode === 'limit' && !(limit >= 1)) return { error: 'Stop after must be 1 or more' };

  return {
    screenFilter:     $(prefix + 'Screen').value.trim(),
    movieFilter:      $(prefix + 'Movie').value.trim(),
    dateMode,
    date:             dateMode === 'single' ? fromInputDate(dateVal) : null,
    notifyMode,
    maxNotifications: notifyMode === 'limit' ? limit : null,
    seatFilter:       radioVal(prefix + 'SeatFilter') === 'available' ? 'available' : 'any'
  };
}

function newAlert(theatre, form) {
  return {
    id:                crypto.randomUUID(),
    ...theatre,
    ...form,
    status:            'watching',
    notifiedDates:     [],
    notificationCount: 0,
    createdAt:         Date.now(),
    lastChecked:       null,
    movies:            []
  };
}

function describeWhen(a) {
  const screen = a.screenFilter ? a.screenFilter.toUpperCase() + ' · ' : '';
  return screen + (a.dateMode === 'any' ? 'any date' : formatDate(a.date));
}

function fillDatalist(id, values) {
  $(id).innerHTML = (values || []).map(v => `<option value="${escAttr(v)}"></option>`).join('');
}

// ═════════════════════════════════════════════════════════════
// RENDER ALERTS
// ═════════════════════════════════════════════════════════════
async function renderAlerts() {
  const alerts = await getAlerts();
  alertCount.textContent = alerts.length;
  alertCount.className   = 'alert-count' + (alerts.length === 0 ? ' zero' : '');

  if (!alerts.length) {
    alertsList.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🔕</div>
        <div class="empty-text">No alerts yet.<br>Visit a BMS cinema page and click <strong>Notify Me</strong>.</div>
      </div>`;
    return;
  }

  alertsList.innerHTML = alerts.map(a => {
    const statusMap = { watching: 'Watching', paused: 'Paused', done: 'Done' };
    const ago   = a.lastChecked ? timeAgo(a.lastChecked) : 'not yet';
    const where = [
      a.city,
      a.screenFilter && a.screenFilter.trim().toUpperCase(),
      a.movieFilter,
      a.dateMode === 'any' ? 'Any date' : formatDate(a.date),
      a.seatFilter === 'available' && '🟢 only'
    ].filter(Boolean).map(esc).join(' · ');

    const found = [...(a.notifiedDates || [])].sort();
    const foundStr = found.length
      ? `<span class="alert-found">Found: ${found.slice(0, 4).map(d => esc(formatShortDate(d))).join(', ')}${found.length > 4 ? ` +${found.length - 4}` : ''}</span> · `
      : '';

    const canPause = a.status === 'watching' || a.status === 'paused';
    const pauseBtn = canPause
      ? `<button class="pause-btn" data-id="${a.id}" title="${a.status === 'paused' ? 'Resume' : 'Pause'} alert">${a.status === 'paused' ? '▶' : '⏸'}</button>`
      : '';

    return `
    <div class="alert-item" data-id="${a.id}">
      <div class="alert-dot ${a.status}"></div>
      <div class="alert-body">
        <div class="alert-theatre">${esc(a.theatreName)}</div>
        <div class="alert-meta">${where}</div>
        <div class="alert-meta">${foundStr}Checked ${ago}</div>
      </div>
      <div class="alert-right">
        <span class="alert-status ${a.status}">${statusMap[a.status] || a.status}</span>
        ${pauseBtn}
        <button class="delete-btn" data-id="${a.id}" title="Remove alert">✕</button>
      </div>
    </div>`;
  }).join('');

  // Bind delete buttons
  alertsList.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const id = btn.dataset.id;
      await deleteAlert(id);
      chrome.runtime.sendMessage({ action: 'ALERT_REMOVED', id });
      await renderAlerts();
      showToast('Alert removed');
    });
  });

  // Bind pause / resume
  alertsList.querySelectorAll('.pause-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const updated = await togglePause(btn.dataset.id);
      if (updated?.status === 'watching') chrome.runtime.sendMessage({ action: 'ALERT_UPDATED', alert: updated });
      await renderAlerts();
      if (updated) showToast(updated.status === 'paused' ? 'Alert paused' : 'Alert resumed');
    });
  });
}

// ═════════════════════════════════════════════════════════════
// SETTINGS MODAL
// ═════════════════════════════════════════════════════════════
const PROVIDER_HELP = {
  none: '',
  resend: `Get a free API key at <strong>resend.com</strong> → API Keys → Create. Free tier: <strong>3,000 emails/month</strong>, no credit card. Use <em>onboarding@resend.dev</em> as sender (no domain needed on free plan).`,
  brevo:  `Get a free API key at <strong>brevo.com</strong> → SMTP & API → API Keys → Generate. Free tier: <strong>300 emails/day</strong>, no credit card required.`,
  mailjet:`Get free keys at <strong>mailjet.com</strong> → API Keys. You need both API Key and Secret Key. Free tier: <strong>6,000 emails/month</strong>, 200/day cap.`,
  mailersend: `Get a free API key at <strong>mailersend.com</strong> → API Tokens. Requires a verified domain. Free tier: <strong>3,000 emails/month</strong>.`
};

let selectedProvider = 'none';

async function openSettings() {
  const s = await getSettings();
  $('settingsEmail').value    = s.email || '';
  $('settingsInterval').value = s.pollIntervalMin || 3;
  $('settingsApiKey').value   = s.emailApiKey || '';
  $('settingsApiSecret').value= s.emailApiSecret || '';

  // Select current provider card
  selectedProvider = s.emailProvider || 'none';
  renderProviderSelection(selectedProvider);

  modalSettings.classList.remove('hidden');
}

function renderProviderSelection(prov) {
  document.querySelectorAll('.provider-card').forEach(el => {
    el.classList.toggle('selected', el.dataset.p === prov);
  });
  const pf   = $('providerFields');
  const help = $('providerHelp');
  const fsec = $('fieldApiSecret');

  if (prov === 'none') {
    pf.classList.add('hidden');
  } else {
    pf.classList.remove('hidden');
    $('labelApiKey').textContent = prov === 'mailjet' ? 'API Key' : 'API Key';
    fsec.classList.toggle('hidden', prov !== 'mailjet');
    help.innerHTML = PROVIDER_HELP[prov] || '';
  }
}

function closeSettings() { modalSettings.classList.add('hidden'); }

async function saveSettings() {
  const email = $('settingsEmail').value.trim();
  if (!email || !isValidEmail(email)) { showToast('Enter a valid email', 'error'); return; }

  const existing = await getSettings();
  const updated  = {
    ...existing,
    email,
    pollIntervalMin: parseInt($('settingsInterval').value),
    emailProvider:   selectedProvider === 'none' ? '' : selectedProvider,
    emailApiKey:     $('settingsApiKey').value.trim(),
    emailApiSecret:  $('settingsApiSecret').value.trim(),
  };

  await chrome.storage.local.set({ settings: updated });
  chrome.runtime.sendMessage({ action: 'SETTINGS_UPDATED', settings: updated });

  $('footerEmail').textContent = email;
  closeSettings();
  const provLabel = selectedProvider === 'none' ? 'desktop notifications' : selectedProvider;
  showToast(`Saved · using ${provLabel}`, 'success');
}

function bindProviderCards() {
  document.querySelectorAll('.provider-card').forEach(card => {
    card.addEventListener('click', () => {
      selectedProvider = card.dataset.p;
      renderProviderSelection(selectedProvider);
    });
  });
}

// ═════════════════════════════════════════════════════════════
// CLEAR ALL
// ═════════════════════════════════════════════════════════════
async function clearAllAlerts() {
  if (!confirm('Remove all active alerts?')) return;
  await chrome.storage.local.remove('alerts');
  chrome.runtime.sendMessage({ action: 'CLEAR_ALL' });
  await renderAlerts();
  showToast('All alerts cleared');
}

// ═════════════════════════════════════════════════════════════
// MONITOR BADGE
// ═════════════════════════════════════════════════════════════
function updateMonitorBadge() {
  const badge = $('monitorBadge');
  const label = $('monitorLabel');
  badge.classList.remove('paused');
  label.textContent = 'Monitoring';
}

// ═════════════════════════════════════════════════════════════
// STORAGE HELPERS
// ═════════════════════════════════════════════════════════════
async function getSettings() {
  const { settings = {} } = await chrome.storage.local.get('settings');
  return settings;
}

async function getAlerts() {
  const { alerts = [] } = await chrome.storage.local.get('alerts');
  return alerts.map(AlertCore.normalizeAlert);
}

// Returns true when saved; false (with a toast) for a duplicate.
async function saveAlert(alertObj) {
  const alerts = await getAlerts();
  const key = AlertCore.alertKey(alertObj);
  if (alerts.some(a => AlertCore.alertKey(a) === key)) {
    showToast('Alert already exists for this theatre + screen + date', 'error');
    return false;
  }
  alerts.push(alertObj);
  await chrome.storage.local.set({ alerts });
  return true;
}

async function togglePause(id) {
  const alerts = await getAlerts();
  const a = alerts.find(x => x.id === id);
  if (!a || (a.status !== 'watching' && a.status !== 'paused')) return null;
  a.status = a.status === 'paused' ? 'watching' : 'paused';
  await chrome.storage.local.set({ alerts });
  return a;
}

async function deleteAlert(id) {
  const alerts = await getAlerts();
  await chrome.storage.local.set({ alerts: alerts.filter(a => a.id !== id) });
}

// ═════════════════════════════════════════════════════════════
// UTILITIES
// ═════════════════════════════════════════════════════════════
function showScreen(name) {
  screenSetup.classList.toggle('hidden', name !== 'setup');
  screenMain.classList.toggle('hidden',  name !== 'main');
}

function showToast(msg, type = '') {
  const t = $('toast');
  t.textContent = msg;
  t.className   = 'toast show' + (type ? ' ' + type : '');
  setTimeout(() => { t.className = 'toast hidden'; }, 2800);
}

/**
 * Parse BookMyShow cinema buytickets URL:
 * https://in.bookmyshow.com/cinemas/{city}/{theatre-slug}/buytickets/{THEATRE_CODE}/{YYYYMMDD}
 */
function parseBMSUrl(url) {
  const re = /in\.bookmyshow\.com\/cinemas\/([^/]+)\/([^/]+)\/buytickets\/([A-Z0-9]+)\/(\d{8})/;
  const m  = url.match(re);
  if (!m) return null;
  const [, citySlug, theatreSlug, theatreCode, date] = m;
  return {
    city:        toTitleCase(citySlug.replace(/-/g, ' ')),
    citySlug,
    theatreSlug,
    theatreCode,
    theatreName: toTitleCase(theatreSlug.replace(/-/g, ' ')),
    date          // YYYYMMDD
  };
}

function formatDate(yyyymmdd) {
  if (!yyyymmdd || yyyymmdd.length !== 8) return yyyymmdd || '';
  const y = yyyymmdd.slice(0,4), m = yyyymmdd.slice(4,6), d = yyyymmdd.slice(6,8);
  return new Date(`${y}-${m}-${d}`).toLocaleDateString('en-IN', { day:'numeric', month:'short', year:'numeric' });
}

function toInputDate(yyyymmdd) {
  if (!yyyymmdd || yyyymmdd.length !== 8) return '';
  return `${yyyymmdd.slice(0,4)}-${yyyymmdd.slice(4,6)}-${yyyymmdd.slice(6,8)}`;
}

function fromInputDate(iso) { return iso.replace(/-/g, ''); }

function formatShortDate(yyyymmdd) {
  if (!AlertCore.isDateCode(yyyymmdd)) return '';
  const d = new Date(`${yyyymmdd.slice(0,4)}-${yyyymmdd.slice(4,6)}-${yyyymmdd.slice(6,8)}`);
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

function toTitleCase(str) { return str.replace(/\b\w/g, c => c.toUpperCase()); }

function isValidEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e); }

function esc(str) { return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function escAttr(str) { return esc(str).replace(/"/g, '&quot;'); }

function timeAgo(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000)    return `${Math.floor(diff/1000)}s ago`;
  if (diff < 3600000)  return `${Math.floor(diff/60000)}m ago`;
  return `${Math.floor(diff/3600000)}h ago`;
}
