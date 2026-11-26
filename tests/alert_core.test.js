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
