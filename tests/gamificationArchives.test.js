'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { buildBingoArchive, buildHousePointsArchive } = require('../services/gamificationArchives');

test('house points archives preserve member totals and exclude exempt users from house standings', () => {
    const snapshot = buildHousePointsArchive(
        { houses: [{ name: 'Moon', color: '#fff' }, { name: 'Exempt', color: '#000' }] },
        [
            { displayName: 'Ari', house: 'Moon', housePoints: 12 },
            { displayName: 'Bea', house: 'Exempt', housePoints: 40 }
        ]
    );

    assert.deepEqual(snapshot.houseStandings, [
        { name: 'Moon', color: '#fff', totalPoints: 12, memberCount: 1 }
    ]);
    assert.deepEqual(snapshot.members.map((member) => [member.name, member.points]), [['Bea', 40], ['Ari', 12]]);
});

test('Bingo archives capture progress and use saved or calculated reward totals', () => {
    const snapshot = buildBingoArchive(
        {
            id: 'weekly',
            name: 'Weekly board',
            goals: [
                { id: 'goal-hp', group: 'hp', rewardValue: 5 },
                { id: 'goal-cc', group: 'cc', rewardValue: 8 }
            ]
        },
        [{
            name: 'Defender',
            users: [
                { displayName: 'Ari', bingoProgress: { 'goal-hp': true, 'goal-cc': true } },
                { displayName: 'Bea', bingoProgress: { 'goal-hp': true }, bingoTotals: { hp: 12, cc: 0 } }
            ]
        }],
        (goal) => goal.rewardValue
    );

    assert.deepEqual(snapshot.groups[0].users.map((user) => user.totals), [
        { hp: 5, cc: 8 },
        { hp: 12, cc: 0 }
    ]);
    assert.equal(snapshot.groups[0].users[0].progress['goal-hp'], true);
    assert.equal(snapshot.template.name, 'Weekly board');
});
