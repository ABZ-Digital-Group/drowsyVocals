'use strict';

function canViewPageForUser({
    isGod,
    pageKey,
    accountType,
    pagePermissions = {},
    archivedPages = []
}) {
    if (isGod) return true;
    if (Array.isArray(archivedPages) && archivedPages.includes(pageKey)) return false;
    if (pageKey === 'privacy-requests') return true;

    const allowedRoles = pagePermissions?.[pageKey];
    return !Array.isArray(allowedRoles) || allowedRoles.includes(accountType);
}

module.exports = { canViewPageForUser };
