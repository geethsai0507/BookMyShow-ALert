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

// ── Final review fixes ───────────────────────────────────────

test('selectShowtimesQuery returns null when no query matches the page date (C1)', () => {
  const queries = { 'getShowtimesByVenue-PRHN-20261218': { status: 'fulfilled', data: { x: 1 }, originalArgs: { dateCode: '20261218' } } };
  assert.equal(C.selectShowtimesQuery(queries, '20261224'), null);
});

test('selectShowtimesQuery matches by key or by originalArgs.dateCode, fulfilled only', () => {
  const byKey = { 'q-20261224': { status: 'fulfilled', data: { a: 1 }, originalArgs: {} } };
  assert.equal(C.selectShowtimesQuery(byKey, '20261224').key, 'q-20261224');
  const byArgs = {
    pending: { status: 'pending', data: null, originalArgs: { dateCode: '20261224' } },
    other:   { status: 'fulfilled', data: { b: 1 }, originalArgs: { dateCode: '20261224' } }
  };
  const hit = C.selectShowtimesQuery(byArgs, '20261224');
  assert.equal(hit.key, 'other');
  assert.deepEqual(hit.data, { b: 1 });
  assert.deepEqual(hit.args, { dateCode: '20261224' });
  assert.equal(C.selectShowtimesQuery(undefined, '20261224'), null);
});

test('waiterVerdict ignores another theatre, rejects other date, accepts match (I1)', () => {
  assert.equal(C.waiterVerdict({ expectedVenue: 'PRHN', expectedDate: null }, { venueCode: 'ARTV', currentDate: '20261223' }), 'ignore');
  assert.equal(C.waiterVerdict({ expectedVenue: 'PRHN', expectedDate: '20261224' }, { venueCode: 'PRHN', currentDate: '20261223' }), 'reject');
  assert.equal(C.waiterVerdict({ expectedVenue: 'PRHN', expectedDate: null }, { venueCode: 'PRHN', currentDate: '20261223' }), 'accept');
  assert.equal(C.waiterVerdict({ expectedVenue: 'PRHN', expectedDate: '20261224' }, { venueCode: 'PRHN', currentDate: '20261224' }), 'accept');
});

test('createSerialQueue runs tasks one at a time in order (I2)', async () => {
  const q = C.createSerialQueue();
  const log = [];
  const task = (name, ms) => () => new Promise(r => { log.push(name + ':start'); setTimeout(() => { log.push(name + ':end'); r(name); }, ms); });
  const results = await Promise.all([q(task('a', 20)), q(task('b', 1))]);
  assert.deepEqual(results, ['a', 'b']);
  assert.deepEqual(log, ['a:start', 'a:end', 'b:start', 'b:end']);
});

test('createSerialQueue keeps going after a task throws', async () => {
  const q = C.createSerialQueue();
  await assert.rejects(q(async () => { throw new Error('boom'); }));
  assert.equal(await q(async () => 'next'), 'next');
});

test('notificationDelta contains only notification fields (I2)', () => {
  const a = W({ id: 'x', notifyMode: 'every', theatreName: 'P', lastChecked: 5 });
  assert.deepEqual(C.notificationDelta(a, ['20261224']), { notifiedDates: ['20261224'], notificationCount: 1, status: 'watching' });
});

test('isDateCode accepts only 8 digits; collectNewDates ignores malformed dates', () => {
  assert.equal(C.isDateCode('20261224'), true);
  assert.equal(C.isDateCode('<img onerror=x>'), false);
  assert.equal(C.isDateCode('2026122'), false);
  const a = W({ dateMode: 'any' });
  assert.deepEqual(C.collectNewDates(a, { '<b>9</b>': [regularShow], '20261224': [regularShow] }, '20261223').map(x => x.date), ['20261224']);
});

test('showMatches also checks the dimension field (M4)', () => {
  assert.equal(C.showMatches({ screen: 'Screen 3', format: '', dimension: 'PCX', movieTitle: 'X' }, { screenFilter: 'pcx', movieFilter: '' }), true);
});

// ── Real Prasads (PRHN) data, 2026-12-17: PCX label lives in Attributes ──
const prasads = [
  ['Avengers: Doomsday', 'SCREEN 5', '', '2D'],
  ['Avengers: Doomsday', 'SCREEN 3', 'Infinity Vision 3D', 'MS-Infinity Vsn 3d'],
  ['Avengers: Doomsday', 'SCREEN 1', 'Infinity Vision 3D', 'MS-Infinity Vsn 3d'],
  ['Dune: Part Three',   'SCREEN 4', '', 'HDR By Barco'],
  ['Dune: Part Three',   'SCREEN 6', 'PCX Screen', '2D']
].map(([movieTitle, screen, attr, dimension]) => ({ movieTitle, screen, format: attr || dimension, dimension }));

test('real Prasads data: Doomsday + PCX does not fire while PCX only plays Dune', () => {
  const a = W({ dateMode: 'any', screenFilter: 'PCX', movieFilter: 'Doomsday' });
  assert.deepEqual(C.collectNewDates(a, { '20261217': prasads }, '20261126'), []);
});

test('real Prasads data: Dune + PCX fires for SCREEN 6 only', () => {
  const a = W({ dateMode: 'any', screenFilter: 'pcx', movieFilter: 'dune' });
  const found = C.collectNewDates(a, { '20261217': prasads }, '20261126');
  assert.deepEqual(found.map(f => f.shows.map(s => s.screen)), [['SCREEN 6']]);
});

test('real Prasads data 2026-12-18: combined label "Infinity Vision 3D/PCX Screen" matches PCX', () => {
  const show = { movieTitle: 'Avengers: Doomsday', screen: 'SCREEN 6', format: 'Infinity Vision 3D/PCX Screen', dimension: 'MS-Infinity Vsn 3d', time: '08:00 AM' };
  const a = W({ dateMode: 'any', screenFilter: 'PCX', movieFilter: 'Doomsday' });
  assert.deepEqual(C.collectNewDates(a, { '20261218': [show] }, '20261126'), [{ date: '20261218', shows: [show] }]);
});
