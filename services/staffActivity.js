'use strict';

const STAFF_ACTIVITY_TIME_ZONE = 'America/New_York';

function getDateParts(date, timeZone) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).formatToParts(date);
    return Object.fromEntries(
        parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value])
    );
}

function getDateKey(date, timeZone = STAFF_ACTIVITY_TIME_ZONE) {
    const parts = getDateParts(date, timeZone);
    return `${parts.year}-${parts.month}-${parts.day}`;
}

function shiftDateKey(dateKey, dayOffset) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
    if (!match || !Number.isInteger(dayOffset)) {
        throw new TypeError('A valid date key and integer day offset are required.');
    }

    const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12));
    if (date.toISOString().slice(0, 10) !== dateKey) {
        throw new TypeError('The date key is not a valid calendar date.');
    }
    date.setUTCDate(date.getUTCDate() + dayOffset);
    return date.toISOString().slice(0, 10);
}

function getZonedMidnightUtcMs(dateKey, timeZone = STAFF_ACTIVITY_TIME_ZONE) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
    if (!match) throw new TypeError('A valid date key is required.');

    const targetWallTime = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    let timestamp = targetWallTime;
    for (let attempt = 0; attempt < 4; attempt += 1) {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hourCycle: 'h23'
        }).formatToParts(new Date(timestamp));
        const values = Object.fromEntries(
            parts.filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)])
        );
        const representedWallTime = Date.UTC(
            values.year,
            values.month - 1,
            values.day,
            values.hour,
            values.minute,
            values.second
        );
        const nextTimestamp = timestamp + (targetWallTime - representedWallTime);
        if (nextTimestamp === timestamp) return timestamp;
        timestamp = nextTimestamp;
    }

    const result = new Date(timestamp);
    if (getDateKey(result, timeZone) !== dateKey) {
        throw new Error(`Unable to resolve midnight for ${dateKey} in ${timeZone}.`);
    }
    return timestamp;
}

function getStaffActivityWindow(now, days, timeZone = STAFF_ACTIVITY_TIME_ZONE) {
    if (!(now instanceof Date) || Number.isNaN(now.getTime()) || !Number.isInteger(days) || days < 1) {
        throw new TypeError('A valid current date and positive integer day range are required.');
    }
    const today = getDateKey(now, timeZone);
    const startDate = shiftDateKey(today, 1 - days);
    const endDate = shiftDateKey(today, 1);
    return {
        startDate,
        endDate,
        startMs: getZonedMidnightUtcMs(startDate, timeZone),
        endMs: getZonedMidnightUtcMs(endDate, timeZone)
    };
}

function clipActivitySession(startedAt, endedAt, rangeStartMs, rangeEndMs) {
    const startedMs = startedAt instanceof Date ? startedAt.getTime() : Date.parse(startedAt);
    const endedMs = endedAt instanceof Date ? endedAt.getTime() : Date.parse(endedAt);
    if (!Number.isFinite(startedMs) || !Number.isFinite(endedMs)) return null;

    const startMs = Math.max(startedMs, rangeStartMs);
    const endMs = Math.min(endedMs, rangeEndMs);
    return endMs > startMs
        ? { startMs, endMs, seconds: (endMs - startMs) / 1000 }
        : null;
}

function splitActivityAcrossDays(startMs, endMs, timeZone = STAFF_ACTIVITY_TIME_ZONE) {
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return [];

    const segments = [];
    let cursor = startMs;
    while (cursor < endMs) {
        const date = getDateKey(new Date(cursor), timeZone);
        const nextDayMs = getZonedMidnightUtcMs(shiftDateKey(date, 1), timeZone);
        const segmentEndMs = Math.min(nextDayMs, endMs);
        if (segmentEndMs <= cursor) {
            throw new Error(`Unable to split activity at the ${date} day boundary.`);
        }
        segments.push({
            date,
            seconds: (segmentEndMs - cursor) / 1000
        });
        cursor = segmentEndMs;
    }
    return segments;
}

module.exports = {
    STAFF_ACTIVITY_TIME_ZONE,
    clipActivitySession,
    getStaffActivityWindow,
    getZonedMidnightUtcMs,
    shiftDateKey,
    splitActivityAcrossDays
};
