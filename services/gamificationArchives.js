'use strict';

function getArchivedName(user) {
    return user.displayName || user.discordUser || 'Staff member';
}

function buildHousePointsArchive(settings = {}, users = []) {
    const isExempt = (name) => (name || '').toString().trim().toLowerCase() === 'exempt';
    const houseStats = {};

    (settings.houses || []).forEach((house) => {
        if (!isExempt(house.name)) {
            houseStats[house.name] = {
                name: house.name,
                color: house.color,
                totalPoints: 0,
                memberCount: 0
            };
        }
    });

    users.forEach((user) => {
        if (!user.house || isExempt(user.house)) return;
        if (!houseStats[user.house]) {
            houseStats[user.house] = {
                name: user.house,
                color: '#888',
                totalPoints: 0,
                memberCount: 0
            };
        }
        houseStats[user.house].totalPoints += Number(user.housePoints) || 0;
        houseStats[user.house].memberCount += 1;
    });

    return {
        houseStandings: Object.values(houseStats).sort((a, b) => b.totalPoints - a.totalPoints),
        members: users
            .map((user) => ({
                name: getArchivedName(user),
                accountType: user.accountType || 'Staff',
                house: user.house || null,
                points: Number(user.housePoints) || 0
            }))
            .sort((a, b) => b.points - a.points)
    };
}

function buildBingoArchive(template, groups, getGoalRewardValue) {
    const goals = (template.goals || []).map((goal) => ({ ...goal }));
    return {
        template: {
            id: template.id,
            name: template.name,
            centerSlot: template.centerSlot,
            fillerSlots: template.fillerSlots,
            goals
        },
        groups: groups.map((group) => ({
            name: group.name,
            users: group.users.map((user) => {
                const progress = Object.fromEntries(
                    goals.map((goal) => [goal.id, Boolean(user.bingoProgress && user.bingoProgress[goal.id])])
                );
                const calculatedTotals = goals.reduce((totals, goal) => {
                    if (!progress[goal.id]) return totals;
                    if (goal.group === 'hp') totals.hp += getGoalRewardValue(goal);
                    if (goal.group === 'cc') totals.cc += getGoalRewardValue(goal);
                    return totals;
                }, { hp: 0, cc: 0 });
                const savedHp = Number(user.bingoTotals?.hp);
                const savedCc = Number(user.bingoTotals?.cc);

                return {
                    name: getArchivedName(user),
                    house: user.house || null,
                    progress,
                    totals: {
                        hp: Number.isFinite(savedHp) ? savedHp : calculatedTotals.hp,
                        cc: Number.isFinite(savedCc) ? savedCc : calculatedTotals.cc
                    }
                };
            })
        }))
    };
}

module.exports = { buildBingoArchive, buildHousePointsArchive };
