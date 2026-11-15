'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { getAllowedInviteData } = require('../services/inviteWhitelist');

test('an empty live whitelist does not fall back to stale local entries', () => {
    const storedAllowedInviteIds = ['removed-user'];
    const liveState = {
        online: true,
        allowedInviteUsers: [],
        allowedInviteUserIds: []
    };

    assert.deepEqual(getAllowedInviteData(liveState, storedAllowedInviteIds), []);
});

test('the local whitelist remains the fallback while the bot is offline', () => {
    const storedAllowedInviteIds = ['saved-user'];
    const liveState = { online: false, allowedInviteUsers: [], allowedInviteUserIds: [] };

    assert.equal(getAllowedInviteData(liveState, storedAllowedInviteIds), storedAllowedInviteIds);
});
