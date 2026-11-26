// Run with: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../alert_core.js');

// ── Task 1: migration, matching, keys, URLs, ids ─────────────

test('normalizeAlert migrates legacy notified alert', () => {
  const r = C.normalizeAlert({ id: 'a', theatreCode: 'PRHN', date: '20261223', status: 'notified', notified: true });
  assert.equal(r.status, 'done');
  assert.deepEqual(r.notifiedDates, ['20261223']);
  assert.equal(r.notificationCount, 1);
  assert.equal(r.dateMode, 'single');
  assert.equal(r.notifyMode, 'once');
  assert.equal(r.screenFilter, '');
  assert.equal(r.movieFilter, '');
  assert.equal('notified' in r, false);
});

test('normalizeAlert is idempotent', () => {
  const x = { id: 'a', theatreCode: 'PRHN', date: '20261223', status: 'notified', notified: true };
  assert.deepEqual(C.normalizeAlert(C.normalizeAlert(x)), C.normalizeAlert(x));
});

test('normalizeAlert keeps legacy watching alert watching', () => {
  const r = C.normalizeAlert({ id: 'b', theatreCode: 'PRHN', date: '20261223', status: 'watching', notified: false });
  assert.equal(r.status, 'watching');
  assert.deepEqual(r.notifiedDates, []);
  assert.equal(r.notificationCount, 0);
});

test('showMatches loose screen filter', () => {
  const a = { screenFilter: ' pcx ', movieFilter: '' };
  assert.equal(C.showMatches({ screen: 'PCX', format: '2D', movieTitle: 'X' }, a), true);
  assert.equal(C.showMatches({ screen: 'Screen 1', format: 'PCX 2D', movieTitle: 'X' }, a), true);
  assert.equal(C.showMatches({ screen: 'Screen 2', format: '2D', movieTitle: 'X' }, a), false);
});

test('showMatches movie variants', () => {
  const a = { screenFilter: '', movieFilter: 'doomsday' };
  assert.equal(C.showMatches({ screen: 'S', format: '2D', movieTitle: 'Avengers: Doomsday' }, a), true);
  assert.equal(C.showMatches({ screen: 'S', format: '2D', movieTitle: 'Doomsday (Hindi)' }, a), true);
  assert.equal(C.showMatches({ screen: 'S', format: '2D', movieTitle: 'Mufasa' }, a), false);
});

test('showMatches empty filters match everything', () => {
  assert.equal(C.showMatches({ screen: 'S', format: '2D', movieTitle: 'Any' }, { screenFilter: '', movieFilter: '' }), true);
});

test('showMatches tolerates missing fields', () => {
  assert.equal(C.showMatches({ movieTitle: 'X' }, { screenFilter: 'pcx', movieFilter: '' }), false);
});

test('matchingShows filters a list', () => {
  const shows = [{ screen: 'PCX', movieTitle: 'A' }, { screen: 'Screen 1', movieTitle: 'A' }];
  assert.deepEqual(C.matchingShows(shows, { screenFilter: 'pcx', movieFilter: '' }), [shows[0]]);
});

test('alertKey differs by screen and dateMode', () => {
  const base = { theatreCode: 'PRHN', dateMode: 'single', date: '20261223', movieFilter: '' };
  assert.notEqual(C.alertKey({ ...base, screenFilter: 'PCX' }), C.alertKey({ ...base, screenFilter: '' }));
  assert.equal(C.alertKey({ ...base, screenFilter: 'PCX' }), C.alertKey({ ...base, screenFilter: ' pcx ' }));
  const anyA = { ...base, dateMode: 'any', screenFilter: 'PCX', date: '20261223' };
  const anyB = { ...base, dateMode: 'any', screenFilter: 'PCX', date: null };
  assert.equal(C.alertKey(anyA), C.alertKey(anyB));
  assert.notEqual(C.alertKey(anyA), C.alertKey({ ...base, screenFilter: 'PCX' }));
});

test('buildBMSUrl uses citySlug verbatim', () => {
  assert.equal(
    C.buildBMSUrl({ citySlug: 'HYD', theatreSlug: 'prasads-multiplex-hyderabad', theatreCode: 'PRHN' }, '20261223'),
    'https://in.bookmyshow.com/cinemas/HYD/prasads-multiplex-hyderabad/buytickets/PRHN/20261223'
  );
});

test('buildBMSUrl falls back to city', () => {
  assert.equal(
    C.buildBMSUrl({ city: 'Hyderabad', theatreName: 'Allu Cinemas', theatreCode: 'ALUC' }, '20261224'),
    'https://in.bookmyshow.com/cinemas/hyderabad/allu-cinemas/buytickets/ALUC/20261224'
  );
});

test('notification id round-trips with uuid', () => {
  assert.deepEqual(C.parseNotificationId(C.notificationId('3f2a-11-b', '20261223')), { alertId: '3f2a-11-b', date: '20261223' });
  assert.equal(C.parseNotificationId('other'), null);
});

// ── Task 2: dates to visit, new-date collection, notification state ──

const W = (o) => ({ status: 'watching', screenFilter: '', movieFilter: '', notifiedDates: [], notificationCount: 0, ...o });

test('datesToVisit any-date skips today, past and already-notified', () => {
  const alerts = [W({ dateMode: 'any', notifiedDates: ['20261224'] })];
  assert.deepEqual(C.datesToVisit(alerts, ['20261222', '20261223', '20261224', '20261225'], '20261223'), ['20261225']);
});

test('datesToVisit single-date only if open', () => {
  const a = W({ dateMode: 'single', date: '20261226' });
  assert.deepEqual(C.datesToVisit([a], ['20261225'], '20261223'), []);
  assert.deepEqual(C.datesToVisit([a], ['20261225', '20261226'], '20261223'), ['20261226']);
});

test('datesToVisit ignores paused and done alerts', () => {
  const alerts = [W({ dateMode: 'any', status: 'paused' }), W({ dateMode: 'any', status: 'done' })];
  assert.deepEqual(C.datesToVisit(alerts, ['20261224', '20261225'], '20261223'), []);
});

test('datesToVisit unions across alerts without duplicates', () => {
  const alerts = [W({ dateMode: 'any', notifiedDates: ['20261224'] }), W({ dateMode: 'single', date: '20261224' }), W({ dateMode: 'any' })];
  assert.deepEqual(C.datesToVisit(alerts, ['20261225', '20261224'], '20261223'), ['20261224', '20261225']);
});

const pcxShow = { screen: 'PCX', format: '2D', movieTitle: 'Doomsday', time: '10:30 AM' };
const regularShow = { screen: 'Screen 1', format: '2D', movieTitle: 'Doomsday' };
const showsByDate = {
  '20261223': [{ screen: 'Screen 2', format: '2D', movieTitle: 'Doomsday' }],
  '20261224': [pcxShow, regularShow]
};

test('collectNewDates returns only matching dates with only matching shows', () => {
  const a = W({ dateMode: 'any', screenFilter: 'pcx', movieFilter: 'doomsday' });
  assert.deepEqual(C.collectNewDates(a, showsByDate, '20261223'), [{ date: '20261224', shows: [pcxShow] }]);
});

test('collectNewDates returns [] for paused alert', () => {
  const a = W({ dateMode: 'any', screenFilter: 'pcx', status: 'paused' });
  assert.deepEqual(C.collectNewDates(a, showsByDate, '20261223'), []);
});

test('collectNewDates skips past and notified dates', () => {
  const a = W({ dateMode: 'any', notifiedDates: ['20261224'] });
  const byDate = { '20261222': [regularShow], '20261224': [regularShow], '20261225': [regularShow] };
  assert.deepEqual(C.collectNewDates(a, byDate, '20261223').map(x => x.date), ['20261225']);
});

test('collectNewDates single mode ignores other dates', () => {
  const a = W({ dateMode: 'single', date: '20261225' });
  const byDate = { '20261224': [regularShow], '20261225': [regularShow] };
  assert.deepEqual(C.collectNewDates(a, byDate, '20261223').map(x => x.date), ['20261225']);
});

test('applyNotification every mode stays watching', () => {
  const r = C.applyNotification(W({ notifyMode: 'every' }), ['20261224', '20261225']);
  assert.deepEqual(r.notifiedDates, ['20261224', '20261225']);
  assert.equal(r.notificationCount, 1);
  assert.equal(r.status, 'watching');
});

test('applyNotification limit counts notifications not dates', () => {
  const a0 = W({ notifyMode: 'limit', maxNotifications: 2 });
  const a1 = C.applyNotification(a0, ['20261224', '20261225', '20261226']);
  assert.equal(a1.notificationCount, 1);
  assert.equal(a1.status, 'watching');
  const a2 = C.applyNotification(a1, ['20261227']);
  assert.equal(a2.notificationCount, 2);
  assert.equal(a2.status, 'done');
});

test('applyNotification once mode → done', () => {
  assert.equal(C.applyNotification(W({ notifyMode: 'once' }), ['20261224']).status, 'done');
});
