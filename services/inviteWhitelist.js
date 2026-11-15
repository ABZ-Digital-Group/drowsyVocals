'use strict';

function getAllowedInviteData(botLiveState, storedAllowedInviteIds) {
    const liveUsers = botLiveState.allowedInviteUsers;
    const liveItems = Array.isArray(liveUsers)
        ? liveUsers
        : (Array.isArray(liveUsers?.users)
            ? liveUsers.users
            : (Array.isArray(botLiveState.allowedInviteUserIds) ? botLiveState.allowedInviteUserIds : null));

    return botLiveState.online && liveItems !== null ? liveItems : storedAllowedInviteIds;
}

module.exports = { getAllowedInviteData };
