'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    clipActivitySession,
    getStaffActivityWindow,
    getZonedMidnightUtcMs,
    splitActivityAcrossDays
} = require('../services/staffActivity');

test('activity windows include the selected number of Eastern calendar days', () => {
    const window = getStaffActivityWindow(new Date('2026-03-08T06:30:00.000Z'), 14);

    assert.equal(window.startDate, '2026-02-23');
    assert.equal(window.endDate, '2026-03-09');
    assert.equal(window.endMs - window.startMs, (14 * 24 * 60 * 60 * 1000) - (60 * 60 * 1000));
});

test('Eastern calendar-day boundaries account for daylight-saving changes', () => {
    const springForward = getZonedMidnightUtcMs('2026-03-09') - getZonedMidnightUtcMs('2026-03-08');
    const fallBack = getZonedMidnightUtcMs('2026-11-02') - getZonedMidnightUtcMs('2026-11-01');

    assert.equal(springForward, 23 * 60 * 60 * 1000);
    assert.equal(fallBack, 25 * 60 * 60 * 1000);
});

test('activity is split at Eastern midnight without losing time during DST changes', () => {
    const startMs = Date.parse('2026-03-08T06:30:00.000Z');
    const endMs = Date.parse('2026-03-08T07:30:00.000Z');
    const segments = splitActivityAcrossDays(startMs, endMs);

    assert.deepEqual(segments, [{ date: '2026-03-08', seconds: 3600 }]);
});

test('activity sessions are clipped to the selected report window', () => {
    const startMs = Date.parse('2026-03-08T04:30:00.000Z');
    const endMs = Date.parse('2026-03-08T06:30:00.000Z');
    const clipped = clipActivitySession(
        '2026-03-08T03:30:00.000Z',
        '2026-03-08T07:30:00.000Z',
        startMs,
        endMs
    );

    assert.equal(clipped.startMs, startMs);
    assert.equal(clipped.endMs, endMs);
    assert.equal(clipped.seconds, 2 * 60 * 60);
});
