'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { canViewPageForUser } = require('../services/pageVisibility');

test('archived pages are hidden even when the member role is normally permitted', () => {
    assert.equal(canViewPageForUser({
        pageKey: 'bingo',
        accountType: 'Dreamy Defender',
        pagePermissions: { bingo: ['Dreamy Defender'] },
        archivedPages: ['bingo']
    }), false);
});

test('Gods and Developers retain access to archived pages so they can restore them', () => {
    assert.equal(canViewPageForUser({
        isGod: true,
        pageKey: 'house-points',
        archivedPages: ['house-points']
    }), true);
});

test('non-archived pages keep existing role restrictions', () => {
    assert.equal(canViewPageForUser({
        pageKey: 'bingo',
        accountType: 'Dreamy Defender',
        pagePermissions: { bingo: ['Dreamy Defender'] }
    }), true);
    assert.equal(canViewPageForUser({
        pageKey: 'bingo',
        accountType: 'Nighty Knights',
        pagePermissions: { bingo: ['Dreamy Defender'] }
    }), false);
});
