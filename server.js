// BCRYPT SETUP
const bcrypt = require('bcrypt');
const saltRounds = 10;
const crypto = require('crypto');

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');

// LOAD NPM PACKAGES
const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const multer = require('multer');
const { MongoClient, ObjectId } = require('mongodb');
const { Server } = require('socket.io');
const { createBotService } = require('./services/botService');

const app = express();

// ENVIRONMENT VARIABLES
const PORT = Number(process.env.PORT) || 3000;
const mongoUri = process.env.MONGODB_URI;
const dbname = process.env.MONGODB_DATABASE;
const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const botService = createBotService({
    baseUrl: process.env.BOT_API_URL,
    secret: process.env.BOT_API_SECRET || process.env.BOT_API_TOKEN,
});

if (!mongoUri) {
    console.error('MONGODB_URI is not configured. Add it to the application environment variables.');
}

if (!dbname) {
    console.error('MONGODB_DATABASE is not configured. Add it to the application environment variables.');
}

if (!process.env.SESSION_SECRET) {
    console.warn('SESSION_SECRET is not configured in .env. A temporary random secret was generated. Set SESSION_SECRET to persist sessions across restarts.');
}

// SECURITY: DISABLE EXPRESS FINGERPRINTING
app.disable('x-powered-by');

// Hostinger terminates HTTPS at its reverse proxy.
// This allows express-session to recognise the original HTTPS request
// and set secure cookies correctly in production.
app.set('trust proxy', 1);

// SECURITY: OWASP SECURITY HEADERS & CONFIDENTIALITY CACHE CONTROL
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('X-XSS-Protection', '0');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

    // Never cache confidential management and user data in browser / proxy caches
    if (req.session?.loggedin || req.path.startsWith('/api/') || req.path === '/roster' || req.path === '/settings' || req.path === '/reports') {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
    }
    next();
});

// APP CONFIGURATION
app.use(session({
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        maxAge: 1000 * 60 * 60 * 24
    }
}));

// RATE LIMITING FOR BRUTE FORCE PROTECTION (IN-MEMORY SLIDING WINDOW)
const rateLimits = new Map();

function checkRateLimit(key, maxAttempts = 10, windowMs = 15 * 60 * 1000) {
    const now = Date.now();
    const timestamps = (rateLimits.get(key) || []).filter(ts => now - ts < windowMs);
    rateLimits.set(key, timestamps);
    return timestamps.length < maxAttempts;
}

function recordRateLimitAttempt(key) {
    const timestamps = rateLimits.get(key) || [];
    timestamps.push(Date.now());
    rateLimits.set(key, timestamps);
}

function resetRateLimit(key) {
    rateLimits.delete(key);
}

// TIMING-SAFE STRING COMPARISON TO MITIGATE TIMING ATTACKS
function safeTimingCompare(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const bufA = Buffer.from(a, 'utf8');
    const bufB = Buffer.from(b, 'utf8');
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

app.use((req, res, next) => {
    if (req.path.startsWith('/uploads/check-ins/')) return next();
    express.static(path.join(__dirname, 'public'))(req, res, next);
});

app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

// MIDDLEWARE
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(flash());

// FORM WRITES ARE THE PRIMARY LIVE-UPDATE SIGNAL. This works even when the
// MongoDB deployment does not support change streams.
app.use((req, res, next) => {
    res.on('finish', () => {
        if (
            ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)
            && req.path !== '/login'
            && res.statusCode < 400
        ) {
            broadcastDataUpdate('app');
        }
    });
    next();
});

// DATABASE STATE
let db = null;
let mongoClient = null;
let isDatabaseReady = false;
let shuttingDown = false;
let connectPromise = null;
let reconnectTimer = null;
let httpServer = null;
let shutdownPromise = null;
let io = null;
let liveChangeStreams = [];

function broadcastDataUpdate(collection) {
    io?.emit('data-updated', { collection });
}

function startLiveUpdates() {
    if (!db || liveChangeStreams.length) return;

    const watchedCollections = ['users', 'settings', 'rosterPlans', 'scheduledEvents'];
    liveChangeStreams = watchedCollections.map((collection) => {
        const pipeline = collection === 'users'
            ? [{ $match: { 'updateDescription.updatedFields.lastSeen': { $exists: false } } }]
            : [];
        const changeStream = db.collection(collection).watch(pipeline);

        changeStream.on('change', () => broadcastDataUpdate(collection));
        changeStream.on('error', (error) => {
            console.error(`Live update stream failed for ${collection}:`, error.message);
            liveChangeStreams = liveChangeStreams.filter((stream) => stream !== changeStream);
        });

        return changeStream;
    });
}

// REFRESH THE INDEPENDENT DEVELOPER FLAG SO ACCESS CHANGES APPLY IMMEDIATELY.
app.use(async (req, res, next) => {
    res.locals.notifications = [];
    res.locals.checkInAccess = false;
    res.locals.checkInReadAccess = Boolean(req.session.loggedin);
    if (isDatabaseReady && db && req.session.loggedin && req.session.currentuser) {
        try {
            const user = await db.collection('users').findOne(
                { 'login.discordId': req.session.currentuser },
                { projection: { isDeveloper: 1, displayName: 1, discordUser: 1, avatarUrl: 1, 'login.discordId': 1 } }
            );
            req.session.isDeveloper = Boolean(user?.isDeveloper);
            res.locals.navUser = user ? {
                displayName: user.displayName || user.discordUser || user.login.discordId,
                avatarUrl: user.avatarUrl || null,
                discordId: user.login.discordId
            } : null;
        } catch (error) {
            console.error('Developer access refresh failed:', error.message);
        }
    }

    res.locals.success_msg = req.flash('success_msg');
    res.locals.error_msg = req.flash('error_msg');
    res.locals.loggedin = req.session.loggedin;
    res.locals.currentuser = req.session.currentuser;
    res.locals.userType = req.session.isDeveloper ? 'Realm God' : req.session.accountType;
    res.locals.userIsDeveloper = Boolean(req.session.isDeveloper);
    res.locals.navUser = res.locals.navUser || null;
    res.locals.maintenanceActive = false;

    if (isDatabaseReady && db) {
        try {
            const currentSettings = await getSettings();
            res.locals.maintenanceActive = Boolean(currentSettings?.maintenance?.enabled);
            res.locals.maintenanceMessage = currentSettings?.maintenance?.message || 'The website is currently undergoing scheduled maintenance. Please check back soon.';
        } catch {
            // Non-blocking fallback
        }
    }
    next();
});

// MAINTENANCE MODE MIDDLEWARE
app.use(async (req, res, next) => {
    // Always allow static files, health checks, login/auth pages, logout, and external webhook ingestion
    const bypassedPaths = ['/health', '/logout', '/login', '/index', '/api/applications/webhook'];
    if (bypassedPaths.includes(req.path) || req.path.startsWith('/css') || req.path.startsWith('/scripts') || req.path.startsWith('/assets') || req.path.startsWith('/uploads')) {
        return next();
    }

    if (!isDatabaseReady || !db) return next();

    try {
        const settings = await getSettings();
        const isMaintenance = Boolean(settings?.maintenance?.enabled);

        if (!isMaintenance) {
            return next();
        }

        // God roles (Mr. Sandman, Realm God) and Developers can bypass maintenance mode
        const canBypass = Boolean(req.session.isDeveloper) || GOD_ROLES.includes(req.session.accountType);
        if (canBypass) {
            return next();
        }

        // Handle AJAX/API requests with a JSON 503 response
        if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest' || req.path.startsWith('/api/')) {
            return res.status(503).json({ error: 'Website is in maintenance mode.' });
        }

        // Render the maintenance view for regular users and guests
        return res.status(503).render('pages/maintenance', {
            message: settings.maintenance?.message
        });
    } catch (error) {
        console.error('Maintenance middleware error:', error.message);
        next();
    }
});

// FIRE-AND-FORGET PRESENCE PING SO OTHER USERS CAN SEE WHO IS ONLINE
app.use((req, res, next) => {
    if (isDatabaseReady && db && req.session.loggedin && req.session.currentuser) {
        db.collection('users').updateOne(
            { 'login.discordId': req.session.currentuser },
            { $set: { lastSeen: new Date() } }
        ).catch((error) => console.error('Presence update failed:', error.message));
    }
    next();
});

// SUSPENDED ACCOUNTS CANNOT CONTINUE USING AN ACTIVE SESSION.
app.use(async (req, res, next) => {
    if (!isDatabaseReady || !db || !req.session.loggedin || !req.session.currentuser || req.path === '/logout') return next();

    try {
        const user = await db.collection('users').findOne(
            { 'login.discordId': req.session.currentuser },
            { projection: { suspended: 1 } }
        );

        if (user?.suspended) {
            req.session.loggedin = false;
            req.session.currentuser = null;
            req.session.accountType = null;
            req.session.isDeveloper = false;
            req.flash('error_msg', 'Your account has been suspended. Please contact management.');
            return res.redirect('/');
        }
    } catch (error) {
        console.error('Suspension status check failed:', error.message);
    }

    next();
});

function requireDatabase(req, res, next) {
    if (shuttingDown || !isDatabaseReady || !db) {
        return res.status(503).send('Database is temporarily unavailable. Please try again shortly.');
    }
    next();
}

// ROLES ALLOWED TO MANAGE STRIKES, ATTENDANCE, AND LOA APPROVALS
const MANAGEMENT_ROLES = ['Mr. Sandman', 'Realm God', 'Drowsy Defender', 'Dreamy Defender'];
const GOD_ROLES = ['Mr. Sandman', 'Realm God'];
const hasManagementAccess = (req) => MANAGEMENT_ROLES.includes(req.session.accountType) || Boolean(req.session.isDeveloper);
const hasGodAccess = (req) => GOD_ROLES.includes(req.session.accountType) || Boolean(req.session.isDeveloper);
const hasCheckInAccess = (req, settings) => hasGodAccess(req) || (settings.checkInAccessUserIds || []).includes(req.session.currentuser);
const canViewCheckIn = (req, checkIn) => {
    if (checkIn.visibility === 'gods') return hasGodAccess(req);
    if (checkIn.visibility === 'staff') return (checkIn.visibleUserIds || []).includes(req.session.currentuser) || hasGodAccess(req);
    return Boolean(req.session.loggedin);
};
const hasFeedbackManagementAccess = (req) => hasGodAccess(req);
const rankOrder = ['Mr. Sandman', 'Realm God', 'Drowsy Defender', 'Dreamy Defender', 'Dreamland Guard', 'Nighty Knights', 'Tired Esquire'];
const getRankChangeType = (oldRank, newRank) => rankOrder.indexOf(newRank) < rankOrder.indexOf(oldRank) ? 'promotion' : 'demotion';

async function writeAudit(req, action, detail) {
    if (!db || !req.session.currentuser) return;
    try {
        const actorUser = await db.collection('users').findOne(
            { 'login.discordId': req.session.currentuser },
            { projection: { displayName: 1, discordUser: 1 } }
        );
        await db.collection('auditLog').insertOne({
            action,
            detail,
            actor: req.session.currentuser,
            actorDisplayName: actorUser?.displayName || actorUser?.discordUser || req.session.currentuser,
            createdAt: new Date().toISOString().slice(0, 19)
        });
    } catch (error) {
        console.error('Audit logging failed:', error.message);
    }
}

// AUTHENTICATED USERS MAY READ CHECK-INS; GODS, DEVELOPERS, AND ALLOWED STAFF MAY WRITE THEM.
app.get('/check-ins', requireDatabase, async (req, res) => {
    if (!req.session.loggedin) return res.redirect('/');

    try {
        console.log('Check-ins request started:', req.query.user || '(default)', req.session.currentuser);
        const settings = await getSettings();
        const requestedDiscordId = typeof req.query.user === 'string' ? req.query.user.trim() : '';
        const searchQuery = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
        const followUpFilter = ['open', 'complete'].includes(req.query.followUp) ? req.query.followUp : '';
        if (hasGodAccess(req) && !requestedDiscordId) {
            const firstUser = await db.collection('users').findOne({}, { projection: { 'login.discordId': 1 }, sort: { displayName: 1 } });
            if (!firstUser?.login?.discordId) return res.status(404).send('No users are available for check-ins.');
            return res.redirect(`/check-ins?user=${encodeURIComponent(firstUser.login.discordId)}`);
        }
        const targetDiscordId = requestedDiscordId || req.session.currentuser;

        if (!targetDiscordId) return res.status(404).send('No user was selected for check-ins.');

        const [users, targetUser, storedCheckIns] = await Promise.all([
            req.session.loggedin
                ? db.collection('users').find({}, { projection: { displayName: 1, discordUser: 1, accountType: 1, 'login.discordId': 1 } }).sort({ displayName: 1 }).toArray()
                : [],
            db.collection('users').findOne(
                { 'login.discordId': targetDiscordId },
                { projection: { displayName: 1, discordUser: 1, accountType: 1, 'login.discordId': 1 } }
            ),
            db.collection('checkIns').find({ targetDiscordId }).sort({ createdAt: -1 }).toArray()
        ]);

        if (!targetUser) return res.status(404).send('The selected user could not be found.');
        const checkIns = storedCheckIns
            .filter((checkIn) => canViewCheckIn(req, checkIn))
            .filter((checkIn) => !searchQuery || [checkIn.note, checkIn.authorDisplayName, checkIn.followUpText].some((value) => String(value || '').toLowerCase().includes(searchQuery)))
            .filter((checkIn) => !followUpFilter || (followUpFilter === 'complete' ? checkIn.followUpComplete : checkIn.followUpText && !checkIn.followUpComplete));

        res.render('pages/check-ins', {
            page: 'check-ins',
            users,
            targetUser,
            checkIns,
            canCreate: hasCheckInAccess(req, settings),
            canSelectUser: true,
            searchQuery,
            followUpFilter,
            checkInTemplates: [
                { name: 'General check-in', note: '' },
                { name: 'Welfare check', note: 'Reason for check-in:\n\nHow the member is doing:\n\nSupport or follow-up needed:\n' },
                { name: 'Performance check-in', note: 'What is going well:\n\nAreas to improve:\n\nAgreed actions:\n' },
                { name: 'Return from LOA', note: 'Return date:\n\nHow the member is settling back in:\n\nSupport or follow-up needed:\n' }
            ]
        });
    } catch (error) {
        console.error('Error loading check-ins:', error.stack || error);
        res.status(500).send('Unable to load check-ins. Check the application log for the request error.');
    }
});

app.post('/check-ins', requireDatabase, (req, res) => checkInUpload.single('attachment')(req, res, async (uploadError) => {
    if (!req.session.loggedin) return res.redirect('/');
    const settings = await getSettings();
    if (!hasCheckInAccess(req, settings)) return res.status(403).send('You do not have permission to create check-ins.');

    if (uploadError) {
        req.flash('error_msg', uploadError.message || 'Unable to upload the attachment.');
        return res.redirect(`/check-ins?user=${encodeURIComponent(req.body?.targetDiscordId || '')}`);
    }

    const targetDiscordId = typeof req.body.targetDiscordId === 'string' ? req.body.targetDiscordId.trim() : '';
    const note = typeof req.body.note === 'string' ? req.body.note.trim() : '';
    const visibility = ['all', 'staff', 'gods'].includes(req.body.visibility) ? req.body.visibility : 'all';
    const visibleUserIds = Array.isArray(req.body.visibleUserIds) ? req.body.visibleUserIds : (req.body.visibleUserIds ? [req.body.visibleUserIds] : []);
    const followUpText = typeof req.body.followUpText === 'string' ? req.body.followUpText.trim().slice(0, 1000) : '';
    const followUpDueDate = /^\d{4}-\d{2}-\d{2}$/.test(req.body.followUpDueDate || '') ? req.body.followUpDueDate : '';
    if (!targetDiscordId || !note || note.length > 5000 || (visibility === 'staff' && !visibleUserIds.length)) {
        req.flash('error_msg', 'Choose a user and enter a note of no more than 5,000 characters.');
        return res.redirect(`/check-ins${targetDiscordId ? `?user=${encodeURIComponent(targetDiscordId)}` : ''}`);
    }

    try {
        const [targetUser, author] = await Promise.all([
            db.collection('users').findOne({ 'login.discordId': targetDiscordId }, { projection: { displayName: 1, discordUser: 1, 'login.discordId': 1 } }),
            db.collection('users').findOne({ 'login.discordId': req.session.currentuser }, { projection: { displayName: 1, discordUser: 1 } })
        ]);
        if (!targetUser) return res.status(404).send('The selected user could not be found.');

        await db.collection('checkIns').insertOne({
            targetDiscordId,
            targetDisplayName: targetUser.displayName || targetUser.discordUser || targetDiscordId,
            note,
            visibility,
            visibleUserIds: [...new Set(visibleUserIds.map((id) => String(id).trim()).filter(Boolean))],
            followUpText,
            followUpDueDate,
            followUpComplete: false,
            attachments: req.file ? [{ filename: req.file.filename, originalName: req.file.originalname, mimeType: req.file.mimetype, size: req.file.size }] : [],
            editHistory: [],
            authorDiscordId: req.session.currentuser,
            authorDisplayName: author?.displayName || author?.discordUser || req.session.currentuser,
            createdAt: new Date().toISOString()
        });
        await writeAudit(req, 'Added private check-in note', `${targetUser.displayName || targetDiscordId}`);
        req.flash('success_msg', 'Check-in note added to the user record.');
        res.redirect(`/check-ins?user=${encodeURIComponent(targetDiscordId)}`);
    } catch (error) {
        console.error('Error saving check-in:', error);
        req.flash('error_msg', 'Unable to save the check-in note.');
        res.redirect(`/check-ins?user=${encodeURIComponent(targetDiscordId)}`);
    }
}));

app.post('/check-ins/:checkInId/edit', requireDatabase, async (req, res) => {
    if (!req.session.loggedin) return res.redirect('/');

    const settings = await getSettings();
    if (!hasCheckInAccess(req, settings)) return res.status(403).send('You do not have permission to edit check-ins.');
    if (!ObjectId.isValid(req.params.checkInId)) return res.status(400).send('Invalid check-in note.');

    const note = typeof req.body.note === 'string' ? req.body.note.trim() : '';
    if (!note || note.length > 5000) {
        req.flash('error_msg', 'Enter a note of no more than 5,000 characters.');
        return res.redirect(`/check-ins?user=${encodeURIComponent(req.body.targetDiscordId || '')}`);
    }

    try {
        const previousNote = await db.collection('checkIns').findOne({ _id: new ObjectId(req.params.checkInId) });
        if (!previousNote) return res.status(404).send('Check-in note not found.');
        await db.collection('checkIns').updateOne(
            { _id: previousNote._id },
            {
                $set: { note, updatedAt: new Date().toISOString(), updatedBy: req.session.currentuser },
                $push: { editHistory: { note: previousNote.note, editedAt: new Date().toISOString(), editedBy: req.session.currentuser } }
            }
        );

        await writeAudit(req, 'Edited private check-in note', previousNote.targetDisplayName || previousNote.targetDiscordId);
        req.flash('success_msg', 'Check-in note updated.');
        res.redirect(`/check-ins?user=${encodeURIComponent(previousNote.targetDiscordId)}`);
    } catch (error) {
        console.error('Error editing check-in:', error);
        req.flash('error_msg', 'Unable to edit the check-in note.');
        res.redirect(`/check-ins?user=${encodeURIComponent(req.body.targetDiscordId || '')}`);
    }
});

app.post('/check-ins/:checkInId/delete', requireDatabase, async (req, res) => {
    if (!req.session.loggedin) return res.redirect('/');

    const settings = await getSettings();
    if (!hasCheckInAccess(req, settings)) return res.status(403).send('You do not have permission to delete check-ins.');
    if (!ObjectId.isValid(req.params.checkInId)) return res.status(400).send('Invalid check-in note.');

    try {
        const result = await db.collection('checkIns').findOneAndDelete({ _id: new ObjectId(req.params.checkInId) });
        const deletedNote = result?.value || result;
        if (!deletedNote) return res.status(404).send('Check-in note not found.');

        await writeAudit(req, 'Deleted private check-in note', deletedNote.targetDisplayName || deletedNote.targetDiscordId);
        req.flash('success_msg', 'Check-in note deleted.');
        res.redirect(`/check-ins?user=${encodeURIComponent(deletedNote.targetDiscordId)}`);
    } catch (error) {
        console.error('Error deleting check-in:', error);
        req.flash('error_msg', 'Unable to delete the check-in note.');
        res.redirect(`/check-ins?user=${encodeURIComponent(req.body.targetDiscordId || '')}`);
    }
});

app.post('/check-ins/:checkInId/follow-up', requireDatabase, async (req, res) => {
    if (!req.session.loggedin) return res.redirect('/');
    const settings = await getSettings();
    if (!hasCheckInAccess(req, settings)) return res.status(403).send('You do not have permission to update follow-ups.');
    if (!ObjectId.isValid(req.params.checkInId)) return res.status(400).send('Invalid check-in note.');

    try {
        const checkIn = await db.collection('checkIns').findOne({ _id: new ObjectId(req.params.checkInId) });
        if (!checkIn) return res.status(404).send('Check-in note not found.');
        await db.collection('checkIns').updateOne(
            { _id: checkIn._id },
            { $set: { followUpComplete: req.body.completed === 'true', updatedAt: new Date().toISOString(), updatedBy: req.session.currentuser } }
        );
        res.redirect(`/check-ins?user=${encodeURIComponent(checkIn.targetDiscordId)}`);
    } catch (error) {
        console.error('Error updating check-in follow-up:', error);
        res.status(500).send('Unable to update follow-up.');
    }
});

app.get('/check-ins/:checkInId/attachment/:filename', requireDatabase, async (req, res) => {
    if (!req.session.loggedin) return res.redirect('/');
    if (!ObjectId.isValid(req.params.checkInId)) return res.status(400).send('Invalid check-in note.');

    try {
        const checkIn = await db.collection('checkIns').findOne({ _id: new ObjectId(req.params.checkInId) });
        const attachment = checkIn?.attachments?.find((item) => item.filename === req.params.filename);
        if (!checkIn || !attachment || !canViewCheckIn(req, checkIn)) return res.status(404).send('Attachment not found.');
        return res.sendFile(path.join(CHECK_IN_UPLOAD_DIR, path.basename(attachment.filename)));
    } catch (error) {
        console.error('Error loading check-in attachment:', error);
        return res.status(500).send('Unable to load attachment.');
    }
});

// POST PAYLOAD TO A SPECIFIC DISCORD WEBHOOK URL
function postWebhookPayload(webhookUrl, embed, messageOnly = false) {
    if (!webhookUrl || !webhookUrl.startsWith('https://discord.com/api/webhooks/')) return;

    try {
        const message = [
            embed.title,
            ...(embed.fields || []).map((field) => `**${field.name}:** ${field.value}`),
            embed.description
        ].filter(Boolean).join('\n');
        const payload = JSON.stringify({
            username: 'Drowsy Vocals Management',
            avatar_url: 'https://manage.drowsyvocals.com/assets/sloth.jpg',
            ...(messageOnly
                ? { content: message }
                : {
                    embeds: [
                        {
                            color: embed.color || 0xB7B2A7,
                            timestamp: new Date().toISOString(),
                            footer: { text: 'Drowsy Vocals Staff Portal' },
                            ...embed
                        }
                    ]
                })
        });

        const parsedUrl = new URL(webhookUrl);
        const reqOptions = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || 443,
            path: `${parsedUrl.pathname}${parsedUrl.search}`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            }
        };

        const postReq = https.request(reqOptions, (res) => {
            if (res.statusCode >= 400) {
                console.error(`Discord webhook returned status ${res.statusCode}`);
            }
        });

        postReq.on('error', (err) => {
            console.error('Discord webhook request failed:', err.message);
        });

        postReq.write(payload);
        postReq.end();
    } catch (err) {
        console.error('Error posting to Discord webhook:', err.message);
    }
}

// SEND NOTIFICATION TO CONFIGURED DISCORD WEBHOOK (ROUTES TO SPECIFIC CHANNEL WEBHOOK IF CONFIGURED)
async function sendDiscordWebhook(embed, eventType = null) {
    if (!isDatabaseReady || !db) return;
    try {
        const settings = await getSettings();
        const webhookConfig = settings.webhooks || {};

        let targetUrl = (webhookConfig.url || '').trim();

        if (eventType === 'housePoints') {
            if (webhookConfig.notifyHousePoints === false) return;
            if (webhookConfig.housePointsUrl && webhookConfig.housePointsUrl.trim().startsWith('https://discord.com/api/webhooks/')) {
                targetUrl = webhookConfig.housePointsUrl.trim();
            }
        } else if (eventType === 'events') {
            if (webhookConfig.notifyEvents === false) return;
            if (webhookConfig.eventsUrl && webhookConfig.eventsUrl.trim().startsWith('https://discord.com/api/webhooks/')) {
                targetUrl = webhookConfig.eventsUrl.trim();
            }
        } else if (eventType === 'loa' && webhookConfig.notifyLoa === false) {
            return;
        } else if ((eventType === 'strikes' || eventType === 'appeals') && webhookConfig.notifyStrikes === false) {
            return;
        } else if (eventType === 'feedback' && webhookConfig.notifyFeedback === false) {
            return;
        } else if (eventType === 'applications' && webhookConfig.notifyApplications === false) {
            return;
        } else if (eventType === 'pdLogs') {
            if (webhookConfig.notifyPdLogs === false) return;
            targetUrl = '';
            if (webhookConfig.pdLogsUrl && webhookConfig.pdLogsUrl.trim().startsWith('https://discord.com/api/webhooks/')) {
                targetUrl = webhookConfig.pdLogsUrl.trim();
            }
        }

        if (!targetUrl || !targetUrl.startsWith('https://discord.com/api/webhooks/')) {
            return;
        }

        postWebhookPayload(targetUrl, embed, eventType === 'housePoints' || eventType === 'pdLogs');
    } catch (error) {
        console.error('Error sending Discord webhook:', error.message);
    }
}

app.use(async (req, res, next) => {
    if (!isDatabaseReady || !db || !req.session.loggedin) return next();
    try {
        const settings = await getSettings();
        res.locals.checkInAccess = hasCheckInAccess(req, settings);
        if (hasManagementAccess(req)) {
            const managementQueries = [
                db.collection('users').countDocuments({ 'loaRequests.status': 'Pending' }),
                db.collection('applications').countDocuments({ status: 'Pending' })
            ];
            if (hasFeedbackManagementAccess(req)) {
                managementQueries.splice(1, 0, db.collection('feedback').countDocuments({ status: { $in: ['New', null] } }));
            }
            const results = await Promise.all(managementQueries);
            const pendingLoa = results[0];
            const newFeedback = hasFeedbackManagementAccess(req) ? results[1] : 0;
            const pendingApps = hasFeedbackManagementAccess(req) ? results[2] : results[1];
            if (pendingLoa) res.locals.notifications.push({ href: '/loa', text: `${pendingLoa} pending LOA request${pendingLoa === 1 ? '' : 's'}` });
            if (hasFeedbackManagementAccess(req) && newFeedback) res.locals.notifications.push({ href: '/feedback', text: `${newFeedback} feedback item${newFeedback === 1 ? '' : 's'} to review` });
            if (pendingApps) res.locals.notifications.push({ href: '/applications', text: `${pendingApps} pending application${pendingApps === 1 ? '' : 's'}` });
        }
    } catch (error) {
        console.error('Notification refresh failed:', error.message);
    }
    next();
});

// TARGETS DISPLAYED ON THE STAFF BINGO BOARD.
const BINGO_GOALS = [
    { id: '1', label: '1', target: '3 HP' },
    { id: '2', label: '2', target: '2 HP' },
    { id: '3', label: '3', target: '2 HP' },
    { id: '4', label: '4', target: '2 HP' },
    { id: '5', label: '5', target: '3 HP' },
    { id: '6', label: '6', target: '2500 CC' },
    { id: '7', label: '7', target: '2500 CC' },
    { id: '8', label: '8', target: '6000 CC' },
    { id: '9', label: '9', target: '1000 CC' },
    { id: '10', label: '10', target: '1000 CC' }
];

// A USER IS CONSIDERED "ONLINE" IF SEEN WITHIN THIS WINDOW
const ONLINE_THRESHOLD_MS = 2 * 60 * 1000;

// AVATAR UPLOAD STORAGE
const AVATAR_UPLOAD_DIR = path.join(__dirname, 'public', 'uploads', 'avatars');
fs.mkdirSync(AVATAR_UPLOAD_DIR, { recursive: true });

const AVATAR_MIME_EXTENSIONS = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp'
};

const avatarUpload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, AVATAR_UPLOAD_DIR),
        filename: (req, file, cb) => {
            const extension = AVATAR_MIME_EXTENSIONS[file.mimetype] || '';
            const safeId = (req.session.currentuser || 'user').replace(/[^a-zA-Z0-9_-]/g, '');
            cb(null, `${safeId}-${Date.now()}${extension}`);
        }
    }),
    limits: { fileSize: 2 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (!AVATAR_MIME_EXTENSIONS[file.mimetype]) {
            return cb(new Error('Only PNG, JPEG, or WEBP images are allowed.'));
        }
        cb(null, true);
    }
});

const CHECK_IN_UPLOAD_DIR = path.join(__dirname, 'public', 'uploads', 'check-ins');
fs.mkdirSync(CHECK_IN_UPLOAD_DIR, { recursive: true });

const checkInUpload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, CHECK_IN_UPLOAD_DIR),
        filename: (req, file, cb) => cb(null, `check-in-${Date.now()}-${crypto.randomBytes(6).toString('hex')}${path.extname(file.originalname).toLowerCase()}`)
    }),
    limits: { fileSize: 8 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowedMimes = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf', 'text/plain'];
        if (!allowedMimes.includes(file.mimetype)) return cb(new Error('Only PNG, JPEG, WEBP, PDF, or text files are allowed.'));
        cb(null, true);
    }
});

// DROWSY DISCORD BOT INTEGRATION PATHS & HELPERS
const DROWSY_BOT_DIR = process.env.DROWSY_BOT_DIR || path.resolve(__dirname, '..', 'drowsyBot2.0');
const BOT_DATA_DIR = path.join(DROWSY_BOT_DIR, 'data');
const BOT_ASSETS_DIR = path.join(DROWSY_BOT_DIR, 'assets');
const BOT_ADS_DIR = path.join(BOT_ASSETS_DIR, 'ads');
const BOT_ENV_FILE = path.join(DROWSY_BOT_DIR, '.env');

try {
    fs.mkdirSync(BOT_DATA_DIR, { recursive: true });
    fs.mkdirSync(BOT_ASSETS_DIR, { recursive: true });
    fs.mkdirSync(BOT_ADS_DIR, { recursive: true });
} catch (e) {
    console.error('Bot directories init error:', e.message);
}

app.use('/bot-assets/ads', express.static(BOT_ADS_DIR));

const botAdUpload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, BOT_ADS_DIR),
        filename: (req, file, cb) => {
            const ext = path.extname(file.originalname).toLowerCase() || '.png';
            const safeName = `ad-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`;
            cb(null, safeName);
        }
    }),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowedMimes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
        if (!allowedMimes.includes(file.mimetype)) {
            return cb(new Error('Only PNG, JPEG, WEBP, or GIF images are allowed.'));
        }
        cb(null, true);
    }
});

function readBotJson(filePath, fallback = {}) {
    try {
        if (fs.existsSync(filePath)) {
            return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        }
    } catch (e) {
        console.error(`Failed to read bot JSON at ${filePath}:`, e.message);
    }
    return fallback;
}

function writeBotJson(filePath, data) {
    try {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
        return true;
    } catch (e) {
        console.error(`Failed to write bot JSON at ${filePath}:`, e.message);
        return false;
    }
}

function parseBotEnv(filePath) {
    if (!fs.existsSync(filePath)) return {};
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const env = {};
        for (const line of content.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const idx = trimmed.indexOf('=');
            if (idx > 0) {
                const key = trimmed.slice(0, idx).trim();
                let val = trimmed.slice(idx + 1).trim();
                if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
                    val = val.slice(1, -1);
                }
                env[key] = val;
            }
        }
        return env;
    } catch (e) {
        console.error('Failed to parse bot .env:', e.message);
        return {};
    }
}

function updateBotEnv(filePath, updates) {
    if (!fs.existsSync(filePath)) return false;
    try {
        let content = fs.readFileSync(filePath, 'utf8');
        for (const [key, val] of Object.entries(updates)) {
            const regex = new RegExp(`^${key}=.*$`, 'm');
            if (regex.test(content)) {
                content = content.replace(regex, `${key}=${val}`);
            } else {
                content += `\n${key}=${val}`;
            }
        }
        fs.writeFileSync(filePath, content, 'utf8');
        return true;
    } catch (e) {
        console.error('Failed to update bot .env:', e.message);
        return false;
    }
}

function getBotApiConfig() {
    const configuredUrl = (process.env.BOT_API_URL || '').trim();
    const baseUrl = configuredUrl.replace(/\/+$/, '');
    const token = (process.env.BOT_API_SECRET || process.env.BOT_API_TOKEN || '').trim();

    return {
        baseUrl,
        headers: {
            Accept: 'application/json',
            ...(token ? { 'X-Bot-Api-Key': token } : {})
        }
    };
}

async function getBotLiveState() {
    const adsData = readBotJson(path.join(BOT_DATA_DIR, 'obs-ads.json'), { items: [], activeId: null });
    const botSettings = readBotJson(path.join(BOT_DATA_DIR, 'bot-settings.json'), {});
    const activeAd = (adsData.items || []).find(ad => ad.id === adsData.activeId) || (adsData.items || [])[0] || null;
    let connectionError = null;

    try {
        const status = await botService.getBotStatus();
        return {
            online: status.online !== false,
            botUser: status.botUser || 'Connected',
            guildCount: status.guildCount || 0,
            guilds: status.guilds || [],
            trackedStages: status.trackedStages || [],
            advertisements: adsData.items || [],
            activeAdvertisement: activeAd,
            rotationIntervalMs: adsData.rotationIntervalMs || null,
            allowedInviteUsers: readBotJson(path.join(BOT_DATA_DIR, 'allowed-invite-users.json'), []) || [],
            botSettings,
            ...status
        };
    } catch (error) {
        connectionError = error.message || 'Bot HTTP service is unreachable.';
        console.error('Bot status check failed:', error.message);
    }

    return {
        online: false,
        botUser: 'Offline / Standby',
        guildCount: 0,
        guilds: [],
        trackedStages: [],
        advertisements: adsData.items || [],
        activeAdvertisement: activeAd,
        rotationIntervalMs: adsData.rotationIntervalMs || null,
        allowedInviteUsers: readBotJson(path.join(BOT_DATA_DIR, 'allowed-invite-users.json'), []) || [],
        botSettings,
        connectionError
    };
}

// MONDAY-STARTING ISO DATE FOR THE WEEK CONTAINING THE GIVEN DATE
function getWeekStart(date) {
    const d = new Date(date);
    const dayOffset = (d.getDay() + 6) % 7;
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - dayOffset);
    return d.toISOString().slice(0, 10);
}

// CONFIGURABLE FORM OPTIONS (RANK, HOUSE, SHIFT, ACTIVITY) MANAGED VIA /settings
const SETTINGS_CATEGORIES = ['ranks', 'houses', 'shifts', 'activities'];

const DEFAULT_SETTINGS = {
    checkInAccessUserIds: [],
    ranks: [
        { name: 'Mr. Sandman', order: 0, capacity: null, minDaysInGrade: null },
        { name: 'Realm God', order: 1, capacity: null, minDaysInGrade: null },
        { name: 'Drowsy Defender', order: 2, capacity: null, minDaysInGrade: null },
        { name: 'Dreamland Guard', order: 3, capacity: null, minDaysInGrade: 45 },
        { name: 'Nighty Knights', order: 4, capacity: null, minDaysInGrade: 30 },
        { name: 'Tired Esquire', order: 5, capacity: null, minDaysInGrade: 14 }
    ],
    houses: [
        { name: 'Stubo United', color: '#B29EFA' },
        { name: 'Penguin Force', color: '#90F8FF' },
        { name: 'Drowsy Operators', color: '#FF9B8E' }
    ],
    shifts: [
        { name: 'NA', color: '#7AADFF' },
        { name: 'EU', color: '#faa9a4' },
        { name: 'AU', color: '#FFC978' }
    ],
    activities: [
        { name: 'Active', color: '#E4FFE8' },
        { name: 'Semi-Active', color: '#FFF1C2' },
        { name: 'Inactive', color: '#F9C0BC' },
        { name: 'LOA', color: '#A9CAFF' }
    ],
    maintenance: {
        enabled: false,
        message: 'The website is currently undergoing scheduled maintenance. Please check back soon.'
    },
    webhooks: {
        url: '',
        housePointsUrl: '',
        eventsUrl: '',
        pdLogsUrl: '',
        notifyLoa: true,
        notifyStrikes: true,
        notifyFeedback: true,
        notifyApplications: true,
        notifyEvents: true,
        notifyHousePoints: true,
        notifyPdLogs: true,
        applicationsSecret: 'drowsy-apps-secret'
    },
    alerts: {
        inactivityDaysThreshold: 14,
        inactivityAttendanceThreshold: 2
    }
};

// FETCH THE SINGLE APP SETTINGS DOCUMENT, SEEDING DEFAULTS ON FIRST USE
async function getSettings() {
    let settingsDoc = await db.collection('settings').findOne({ _id: 'appSettings' });

    if (!settingsDoc) {
        settingsDoc = { _id: 'appSettings', ...DEFAULT_SETTINGS };
        await db.collection('settings').insertOne(settingsDoc);
    }

    return settingsDoc;
}

function buildColorMap(list) {
    return (list || []).reduce((map, item) => {
        map[item.name] = item.color || '';
        return map;
    }, {});
}

// CALCULATE EARNED STAFF BADGES (MILESTONES + SPECIAL COMMENDATIONS)
function calculateUserBadges(user, settings = {}) {
    if (!user) return [];
    const badges = [];
    const today = new Date();

    // 1. Tenure / Loyalty Milestones
    let daysInService = 0;
    if (user.hireDate) {
        const hire = new Date(user.hireDate);
        if (hire instanceof Date && !Number.isNaN(hire.valueOf())) {
            daysInService = Math.max(0, Math.floor((today - hire) / (1000 * 60 * 60 * 24)));
        }
    }

    if (daysInService >= 365) {
        badges.push({
            id: 'tenure-365',
            name: '1 Year Veteran',
            icon: '🥇',
            category: 'Tenure',
            description: 'Served in Drowsy Vocals for over 365 days',
            tier: 'gold'
        });
    } else if (daysInService >= 100) {
        badges.push({
            id: 'tenure-100',
            name: 'Century Staff',
            icon: '🥈',
            category: 'Tenure',
            description: 'Served in Drowsy Vocals for over 100 days',
            tier: 'silver'
        });
    } else if (daysInService >= 30) {
        badges.push({
            id: 'tenure-30',
            name: '30-Day Veteran',
            icon: '🥉',
            category: 'Tenure',
            description: 'Served in Drowsy Vocals for over 30 days',
            tier: 'bronze'
        });
    } else {
        badges.push({
            id: 'tenure-recruit',
            name: 'Fresh Recruit',
            icon: '🌱',
            category: 'Tenure',
            description: 'Newly inducted staff member of Drowsy Vocals',
            tier: 'common'
        });
    }

    // 2. Training & Certifications
    if (user.onboardingComplete) {
        badges.push({
            id: 'training-onboarding',
            name: 'Certified Staff',
            icon: '🎓',
            category: 'Training',
            description: 'Completed comprehensive staff onboarding',
            tier: 'blue'
        });
    }

    if (user.hostTrainingComplete) {
        badges.push({
            id: 'training-host',
            name: 'Stage Host',
            icon: '🎤',
            category: 'Training',
            description: 'Certified in stage hosting & audience engagement',
            tier: 'purple'
        });
    }

    // 3. Meeting Attendance Dedication
    const attendanceRecords = Array.isArray(user.attendance) ? user.attendance : [];
    const attendedCount = attendanceRecords.filter(r => r && r.attended).length;

    if (attendedCount >= 20) {
        badges.push({
            id: 'attendance-20',
            name: 'Iron Pillar',
            icon: '🛡️',
            category: 'Attendance',
            description: 'Attended 20+ weekly staff meetings',
            tier: 'gold'
        });
    } else if (attendedCount >= 10) {
        badges.push({
            id: 'attendance-10',
            name: 'Dedicated Guard',
            icon: '🛡️',
            category: 'Attendance',
            description: 'Attended 10+ weekly staff meetings',
            tier: 'silver'
        });
    } else if (attendedCount >= 5) {
        badges.push({
            id: 'attendance-5',
            name: 'Consistent Host',
            icon: '🎯',
            category: 'Attendance',
            description: 'Attended 5+ weekly staff meetings',
            tier: 'bronze'
        });
    }

    // 4. House Points Contribution
    const points = Number(user.housePoints) || 0;
    if (points >= 250) {
        badges.push({
            id: 'points-250',
            name: 'House Legend',
            icon: '👑',
            category: 'House Points',
            description: 'Earned 250+ lifetime house points for their team',
            tier: 'gold'
        });
    } else if (points >= 100) {
        badges.push({
            id: 'points-100',
            name: 'Century Contributor',
            icon: '💎',
            category: 'House Points',
            description: 'Earned 100+ lifetime house points for their team',
            tier: 'silver'
        });
    } else if (points >= 50) {
        badges.push({
            id: 'points-50',
            name: 'Point Pioneer',
            icon: '🏅',
            category: 'House Points',
            description: 'Earned 50+ lifetime house points for their team',
            tier: 'bronze'
        });
    }

    // 5. Conduct & Record
    const strikeCount = (user.strikes || []).reduce((sum, s) => sum + (Number(s.count) || 0), 0);
    if (strikeCount === 0 && daysInService >= 30) {
        badges.push({
            id: 'record-clean',
            name: 'Spotless Conduct',
            icon: '⭐',
            category: 'Conduct',
            description: 'Maintained a clean disciplinary record with 0 strikes',
            tier: 'gold'
        });
    }

    // 6. Promotion Readiness
    if (user.isPromotionReady) {
        badges.push({
            id: 'promo-ready',
            name: 'Promotion Ready',
            icon: '🚀',
            category: 'Advancement',
            description: 'Achieved required time in grade for promotion',
            tier: 'emerald'
        });
    }

    // 7. Custom Commendations / Special Awards
    if (Array.isArray(user.customBadges)) {
        user.customBadges.forEach((b) => {
            badges.push({
                id: b.id,
                name: b.name,
                icon: b.icon || '🌟',
                category: 'Special Commendation',
                description: b.description || 'Awarded by management',
                awardedBy: b.awardedByName || b.awardedBy || 'Management',
                awardedAt: b.awardedAt || '',
                isCustom: true,
                tier: 'special'
            });
        });
    }

    return badges;
}

// COMPUTE UPCOMING MILESTONE TRACKING PROGRESS
function getUserMilestoneProgress(user) {
    if (!user) return [];
    const today = new Date();
    const milestones = [];

    // 1. Tenure Milestone
    let daysInService = 0;
    if (user.hireDate) {
        const hire = new Date(user.hireDate);
        if (hire instanceof Date && !Number.isNaN(hire.valueOf())) {
            daysInService = Math.max(0, Math.floor((today - hire) / (1000 * 60 * 60 * 24)));
        }
    }
    let nextTenureTarget = 30;
    let nextTenureName = '30-Day Veteran (🥉)';
    if (daysInService >= 365) {
        nextTenureTarget = 365;
        nextTenureName = '1 Year Veteran (🥇) [Completed]';
    } else if (daysInService >= 100) {
        nextTenureTarget = 365;
        nextTenureName = '1 Year Veteran (🥇)';
    } else if (daysInService >= 30) {
        nextTenureTarget = 100;
        nextTenureName = 'Century Staff (🥈)';
    }
    const tenurePercent = Math.min(100, Math.round((daysInService / nextTenureTarget) * 100));
    milestones.push({
        title: 'Service Loyalty',
        icon: 'military_tech',
        current: daysInService,
        target: nextTenureTarget,
        unit: 'days',
        percent: tenurePercent,
        nextName: nextTenureName,
        isCompleted: daysInService >= 365
    });

    // 2. Attendance Milestone
    const attendanceRecords = Array.isArray(user.attendance) ? user.attendance : [];
    const attendedCount = attendanceRecords.filter(r => r && r.attended).length;
    let nextAttTarget = 5;
    let nextAttName = 'Consistent Host (🎯 5 Meetings)';
    if (attendedCount >= 20) {
        nextAttTarget = 20;
        nextAttName = 'Iron Pillar (🛡️ 20 Meetings) [Completed]';
    } else if (attendedCount >= 10) {
        nextAttTarget = 20;
        nextAttName = 'Iron Pillar (🛡️ 20 Meetings)';
    } else if (attendedCount >= 5) {
        nextAttTarget = 10;
        nextAttName = 'Dedicated Guard (🛡️ 10 Meetings)';
    }
    const attPercent = Math.min(100, Math.round((attendedCount / nextAttTarget) * 100));
    milestones.push({
        title: 'Meeting Attendance',
        icon: 'how_to_reg',
        current: attendedCount,
        target: nextAttTarget,
        unit: 'meetings',
        percent: attPercent,
        nextName: nextAttName,
        isCompleted: attendedCount >= 20
    });

    // 3. House Points Milestone
    const points = Number(user.housePoints) || 0;
    let nextPointsTarget = 50;
    let nextPointsName = 'Point Pioneer (🏅 50 Pts)';
    if (points >= 250) {
        nextPointsTarget = 250;
        nextPointsName = 'House Legend (👑 250 Pts) [Completed]';
    } else if (points >= 100) {
        nextPointsTarget = 250;
        nextPointsName = 'House Legend (👑 250 Pts)';
    } else if (points >= 50) {
        nextPointsTarget = 100;
        nextPointsName = 'Century Contributor (💎 100 Pts)';
    }
    const pointsPercent = Math.min(100, Math.round((points / nextPointsTarget) * 100));
    milestones.push({
        title: 'House Points',
        icon: 'stars',
        current: points,
        target: nextPointsTarget,
        unit: 'pts',
        percent: pointsPercent,
        nextName: nextPointsName,
        isCompleted: points >= 250
    });

    return milestones;
}

// PARSE A RANK CAPACITY INPUT: BLANK MEANS UNLIMITED SLOTS
function parseCapacity(value) {
    if (value === undefined || value === null || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null;
}

// PARSE POSITIVE INTEGER (E.G. MIN DAYS IN GRADE)
function parsePositiveInt(value) {
    if (value === undefined || value === null || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null;
}

// HEALTH CHECK
app.get('/health', (req, res) => {
    res.status(!shuttingDown && isDatabaseReady ? 200 : 503).json({
        status: !shuttingDown && isDatabaseReady ? 'ok' : 'database_unavailable'
    });
});

// SPLASH PAGE DOES NOT REQUIRE DATABASE ACCESS
app.get('/', (req, res) => {
    res.render('pages/splash');
});

// LOGIN PAGE DOES NOT REQUIRE DATABASE ACCESS
app.get('/index', (req, res) => {
    if (req.query.splash !== '1') return res.redirect('/');
    res.render('pages/index');
});

// CONNECT TO MONGODB WITHOUT BLOCKING THE WEB SERVER STARTUP
function connectDB() {
    if (shuttingDown || isDatabaseReady || connectPromise) {
        return connectPromise || Promise.resolve();
    }

    if (!mongoUri || !dbname) {
        isDatabaseReady = false;
        return Promise.resolve();
    }

    connectPromise = (async () => {
        try {
            if (!mongoClient) {
                mongoClient = new MongoClient(mongoUri, {
                    serverSelectionTimeoutMS: 10000,
                    connectTimeoutMS: 10000,
                    maxPoolSize: 20,
                    minPoolSize: 0
                });
            }

            await mongoClient.connect();
            const nextDb = mongoClient.db(dbname);
            await nextDb.command({ ping: 1 });

            if (shuttingDown) {
                await mongoClient.close();
                mongoClient = null;
                db = null;
                isDatabaseReady = false;
                return;
            }

            db = nextDb;
            isDatabaseReady = true;
            startLiveUpdates();
            console.log('Connected successfully to MongoDB');
        } catch (error) {
            isDatabaseReady = false;
            db = null;
            console.error('MongoDB connection failed:', error.message);

            try {
                await mongoClient?.close();
            } catch (closeError) {
                console.error('MongoDB close failed:', closeError.message);
            }

            mongoClient = null;

            if (!shuttingDown) {
                reconnectTimer = setTimeout(() => {
                    reconnectTimer = null;
                    connectDB();
                }, 5000);
            }
        }
    })().finally(() => {
        connectPromise = null;
    });

    return connectPromise;
}

// USER SIGN-UP (RESTRICTED TO GODS / DEVELOPERS)
app.post('/signUp', requireDatabase, async (req, res) => {
    if (!req.session.loggedin || !hasGodAccess(req)) {
        req.flash('error_msg', 'You are not authorized to create accounts directly.');
        return res.redirect('/');
    }

    const { discordId, password, accountType } = req.body;
    const cleanDiscordId = (discordId || '').toString().trim();
    const cleanPassword = (password || '').toString();

    if (!cleanDiscordId || !cleanPassword || cleanPassword.length < 8) {
        req.flash('error_msg', 'Discord ID and a password of at least 8 characters are required.');
        return res.redirect('/roster');
    }

    try {
        const existingUser = await db.collection('users').findOne({ 'login.discordId': cleanDiscordId });

        if (existingUser) {
            req.flash('error_msg', 'User Already Exists.');
            return res.redirect('/roster');
        }

        const hash = await bcrypt.hash(cleanPassword, saltRounds);
        const newUser = {
            login: { discordId: cleanDiscordId, password: hash },
            accountType: (accountType || 'Tired Esquire').toString(),
            created: new Date().toISOString().slice(0, 19)
        };

        await db.collection('users').insertOne(newUser);
        await writeAudit(req, 'Created user account', `${cleanDiscordId} (${accountType})`);
        req.flash('success_msg', 'User created successfully!');
        res.redirect('/roster');
    } catch (error) {
        console.error('Error during sign-up:', error);
        req.flash('error_msg', 'Unable to create user.');
        res.redirect('/roster');
    }
});

// ADD USER (MANAGEMENT ONLY)
app.post('/add-user', requireDatabase, async (req, res) => {
    if (!req.session.loggedin || !hasManagementAccess(req)) {
        req.flash('error_msg', 'You are not authorized to add staff members.');
        return res.redirect('/roster');
    }

    const {
        discordId,
        displayName,
        discordUser,
        accountType,
        hireDate,
        lastPromotion,
        password,
        house,
        shift,
        housePoints = 0,
        activity = 'Active',
        weeksActivity = 0,
        onboardingComplete,
        hostTrainingComplete
    } = req.body;

    const cleanDiscordId = (discordId || '').toString().trim();
    const cleanPassword = (password || '').toString();
    const cleanDisplayName = (displayName || '').toString().trim();
    const cleanAccountType = (accountType || '').toString().trim();

    if (!cleanDiscordId || !cleanDisplayName || !cleanPassword) {
        req.flash('error_msg', 'Discord ID, Display Name, and Password are required.');
        return res.redirect('/roster');
    }

    if (cleanPassword.length < 8) {
        req.flash('error_msg', 'Password must be at least 8 characters long.');
        return res.redirect('/roster');
    }

    // Only Gods / Developers can create other God accounts
    if (GOD_ROLES.includes(cleanAccountType) && !hasGodAccess(req)) {
        req.flash('error_msg', 'You do not have permission to create God-level accounts.');
        return res.redirect('/roster');
    }

    try {
        const existingUser = await db.collection('users').findOne({ 'login.discordId': cleanDiscordId });

        if (existingUser) {
            req.flash('error_msg', 'A user with that Discord ID already exists.');
            return res.redirect('/roster');
        }

        const hash = await bcrypt.hash(cleanPassword, saltRounds);
        const newUser = {
            login: { discordId: cleanDiscordId, password: hash },
            displayName: cleanDisplayName,
            discordUser: (discordUser || '').toString().trim(),
            accountType: cleanAccountType,
            hireDate: hireDate || new Date().toISOString().slice(0, 10),
            lastPromotion: hireDate || new Date().toISOString().slice(0, 10),
            house: (house || '').toString(),
            housePoints: Number(housePoints) || 0,
            activity: (activity || 'Active').toString(),
            weeksActivity: Number(weeksActivity) || 0,
            shift: (shift || '').toString(),
            onboardingComplete: Boolean(onboardingComplete),
            hostTrainingComplete: Boolean(hostTrainingComplete),
            created: new Date().toISOString().slice(0, 19)
        };

        await db.collection('users').insertOne(newUser);
        await writeAudit(req, 'Added Staff Member', `${cleanDisplayName} (${cleanDiscordId}) - ${cleanAccountType}`);
        sendPdLogsWebhook('Staff Added', 0x22C55E, [
            { name: 'Staff Member', value: `${cleanDisplayName} (<@${cleanDiscordId}>)`, inline: true },
            { name: 'Rank', value: cleanAccountType || 'Unassigned', inline: true },
            { name: 'Added By', value: `<@${req.session.currentuser}>`, inline: true }
        ]);
        req.flash('success_msg', `Added ${cleanDisplayName} to the roster.`);
        res.redirect('/roster');
    } catch (error) {
        console.error('Error during adding user:', error);
        req.flash('error_msg', 'Unable to add user.');
        res.redirect('/roster');
    }
});

// UPDATE USER (MANAGEMENT ONLY)
app.post('/update-user', requireDatabase, async (req, res) => {
    if (!req.session.loggedin || !hasManagementAccess(req)) {
        req.flash('error_msg', 'You are not authorized to edit staff members.');
        return res.redirect('/roster');
    }

    const {
        originalDiscordId,
        discordId,
        displayName,
        discordUser,
        accountType,
        hireDate,
        lastPromotion,
        password,
        house,
        housePoints,
        activity,
        weeksActivity,
        shift,
        onboardingComplete,
        hostTrainingComplete
    } = req.body;

    const cleanOriginalId = (originalDiscordId || '').toString().trim();
    const cleanDiscordId = (discordId || '').toString().trim();
    const cleanAccountType = (accountType || '').toString().trim();
    const cleanDisplayName = (displayName || '').toString().trim();

    try {
        if (!cleanOriginalId || !cleanDiscordId) {
            req.flash('error_msg', 'Discord ID is required.');
            return res.redirect('/roster');
        }

        const existingUser = await db.collection('users').findOne({ 'login.discordId': cleanOriginalId });
        if (!existingUser) {
            req.flash('error_msg', 'User not found.');
            return res.redirect('/roster');
        }

        // Restrict modifications to/from God roles to God accounts only
        const isTargetGod = GOD_ROLES.includes(existingUser.accountType) || Boolean(existingUser.isDeveloper);
        const isSettingGod = GOD_ROLES.includes(cleanAccountType);
        if ((isTargetGod || isSettingGod) && !hasGodAccess(req)) {
            req.flash('error_msg', 'Only Realm Gods, Mr. Sandman, or Developers can manage God-level accounts.');
            return res.redirect('/roster');
        }

        if (cleanDiscordId !== cleanOriginalId) {
            const duplicateUser = await db.collection('users').findOne({ 'login.discordId': cleanDiscordId });
            if (duplicateUser) {
                req.flash('error_msg', 'That new Discord ID is already taken by another user.');
                return res.redirect('/roster');
            }
        }

        const isPromotion = existingUser.accountType !== cleanAccountType;
        const datePattern = /^\d{4}-\d{2}-\d{2}$/;
        const cleanHireDate = (hireDate || '').toString().trim();
        const cleanLastPromotion = (lastPromotion || '').toString().trim();
        const isValidDate = (dateValue) => {
            if (!dateValue) return true;
            if (!datePattern.test(dateValue)) return false;
            const parsedDate = new Date(`${dateValue}T00:00:00Z`);
            return !Number.isNaN(parsedDate.valueOf())
                && parsedDate.toISOString().slice(0, 10) === dateValue;
        };
        if (!isValidDate(cleanHireDate) || !isValidDate(cleanLastPromotion)) {
            req.flash('error_msg', 'Join and promotion/demotion dates must be valid dates.');
            return res.redirect('/roster');
        }

        const nextLastPromotion = cleanLastPromotion
            || (isPromotion ? new Date().toISOString().slice(0, 10) : (existingUser.lastPromotion || cleanHireDate || null));

        const updateDoc = {
            $set: {
                'login.discordId': cleanDiscordId,
                displayName: cleanDisplayName,
                discordUser: (discordUser || '').toString().trim(),
                accountType: cleanAccountType,
                hireDate: cleanHireDate || existingUser.hireDate,
                lastPromotion: nextLastPromotion,
                house: (house || '').toString(),
                shift: (shift || '').toString(),
                housePoints: Number(housePoints) || 0,
                activity: (activity || 'Active').toString(),
                weeksActivity: Number(weeksActivity) || 0,
                onboardingComplete: Boolean(onboardingComplete),
                hostTrainingComplete: Boolean(hostTrainingComplete)
            }
        };

        if (password && password.toString().trim()) {
            const cleanPassword = password.toString().trim();
            if (cleanPassword.length < 8) {
                req.flash('error_msg', 'Updated password must be at least 8 characters.');
                return res.redirect('/roster');
            }
            const hash = await bcrypt.hash(cleanPassword, saltRounds);
            updateDoc.$set['login.password'] = hash;
        }

        await db.collection('users').updateOne(
            { 'login.discordId': cleanOriginalId },
            updateDoc
        );

        const dateChanges = [];
        if (cleanHireDate && cleanHireDate !== existingUser.hireDate) {
            dateChanges.push(`join date ${existingUser.hireDate || 'unset'} -> ${cleanHireDate}`);
        }
        if (cleanLastPromotion && cleanLastPromotion !== existingUser.lastPromotion) {
            dateChanges.push(`promotion/demotion date ${existingUser.lastPromotion || 'unset'} -> ${cleanLastPromotion}`);
        }
        const auditDetails = `${cleanDisplayName} (${cleanOriginalId} -> ${cleanDiscordId})${dateChanges.length ? `; ${dateChanges.join('; ')}` : ''}`;
        await writeAudit(req, 'Updated Staff Member', auditDetails);
        if (isPromotion) {
            sendPdLogsWebhook(
                getRankChangeType(existingUser.accountType, cleanAccountType) === 'promotion' ? 'Staff Promoted' : 'Staff Demoted',
                getRankChangeType(existingUser.accountType, cleanAccountType) === 'promotion' ? 0x3B82F6 : 0xF97316,
                [
                    { name: 'Staff Member', value: `${cleanDisplayName} (<@${cleanDiscordId}>)`, inline: true },
                    { name: 'Previous Rank', value: existingUser.accountType || 'Unassigned', inline: true },
                    { name: 'New Rank', value: cleanAccountType || 'Unassigned', inline: true },
                    { name: 'Changed By', value: `<@${req.session.currentuser}>`, inline: true }
                ]
            );
        }
        req.flash('success_msg', `Updated profile for ${cleanDisplayName}.`);
        res.redirect('/roster');
    } catch (error) {
        console.error('Error during user update:', error);
        req.flash('error_msg', 'Unable to update user.');
        res.redirect('/roster');
    }
});

// PROMOTE USER (MANAGEMENT ONLY)
app.post('/promote-user', requireDatabase, async (req, res) => {
    if (!req.session.loggedin || !hasManagementAccess(req)) {
        req.flash('error_msg', 'You are not authorized to change staff ranks.');
        return res.redirect('/roster');
    }

    const { discordId, accountType, effectiveDate, rankActionType } = req.body;
    const cleanDiscordId = (discordId || '').toString().trim();
    const cleanAccountType = (accountType || '').toString().trim();

    try {
        const settings = await getSettings();
        const allowedRanks = settings.ranks.map((rank) => rank.name);

        if (!cleanDiscordId || !allowedRanks.includes(cleanAccountType)) {
            req.flash('error_msg', 'Invalid user or rank specified.');
            return res.redirect('/roster');
        }

        const user = await db.collection('users').findOne({ 'login.discordId': cleanDiscordId });
        if (!user) {
            req.flash('error_msg', 'User not found.');
            return res.redirect('/roster');
        }

        // Restrict God-level promotions to God accounts
        if ((GOD_ROLES.includes(cleanAccountType) || GOD_ROLES.includes(user.accountType)) && !hasGodAccess(req)) {
            req.flash('error_msg', 'Only Realm Gods, Mr. Sandman, or Developers can grant or change God-level ranks.');
            return res.redirect('/roster');
        }

        if (user.accountType === cleanAccountType) {
            return res.redirect('/roster');
        }

        const promotionDate = effectiveDate || new Date().toISOString().slice(0, 10);

        await db.collection('users').updateOne(
            { 'login.discordId': cleanDiscordId },
            {
                $set: {
                    accountType: cleanAccountType,
                    lastPromotion: promotionDate
                }
            }
        );

        if (req.session.currentuser === cleanDiscordId) {
            req.session.accountType = cleanAccountType;
        }

        const isPromotion = getRankChangeType(user.accountType, cleanAccountType) === 'promotion';
        await writeAudit(req, isPromotion ? 'Promoted User' : 'Demoted User', `${user.displayName || cleanDiscordId}: ${user.accountType} -> ${cleanAccountType}`);
        sendPdLogsWebhook(isPromotion ? 'Staff Promoted' : 'Staff Demoted', isPromotion ? 0x3B82F6 : 0xF97316, [
            { name: 'Staff Member', value: `${user.displayName || user.discordUser || cleanDiscordId} (<@${cleanDiscordId}>)`, inline: true },
            { name: 'Previous Rank', value: user.accountType || 'Unassigned', inline: true },
            { name: 'New Rank', value: cleanAccountType, inline: true },
            { name: 'Changed By', value: `<@${req.session.currentuser}>`, inline: true }
        ]);
        req.flash('success_msg', `${user.displayName || cleanDiscordId} is now ${cleanAccountType}.`);
        res.redirect('/roster');
    } catch (error) {
        console.error('Error during user promotion:', error);
        req.flash('error_msg', 'Unable to update rank.');
        res.redirect('/roster');
    }
});

// ADD STRIKE
app.post('/add-strike', requireDatabase, async (req, res) => {
    if (!req.session.loggedin) return res.redirect('/');

    if (!hasManagementAccess(req)) {
        req.flash('error_msg', 'You are not authorized to issue strikes.');
        return res.redirect('/roster');
    }

    const { discordId, count, reason } = req.body;
    const strikeCount = Number(count);
    const trimmedReason = (reason || '').toString().trim();

    if (!discordId || !trimmedReason || !Number.isInteger(strikeCount) || strikeCount < 1 || strikeCount > 3) {
        req.flash('error_msg', 'A valid strike count (1-3) and reason are required.');
        return res.redirect('/roster');
    }

    try {
        const user = await db.collection('users').findOne({ 'login.discordId': discordId });
        if (!user) return res.redirect('/roster');

        const strike = {
            id: crypto.randomUUID(),
            count: strikeCount,
            reason: trimmedReason,
            issuedBy: req.session.currentuser,
            date: new Date().toISOString().slice(0, 19)
        };

        await db.collection('users').updateOne(
            { 'login.discordId': discordId },
            { $push: { strikes: strike } }
        );

        sendDiscordWebhook({
            title: '⚠️ Staff Strike Issued',
            color: 0xEF4444,
            fields: [
                { name: 'Staff Member', value: `${user.displayName || user.discordUser || discordId} (<@${discordId}>)`, inline: true },
                { name: 'Strike Count', value: `+${strikeCount}`, inline: true },
                { name: 'Issued By', value: `<@${req.session.currentuser}>`, inline: true },
                { name: 'Reason', value: trimmedReason }
            ]
        }, 'strikes');

        req.flash('success_msg', 'Strike issued successfully.');
        res.redirect('/roster');
    } catch (error) {
        console.error('Error adding strike:', error);
        res.redirect('/roster');
    }
});

// REMOVE STRIKE
app.post('/remove-strike', requireDatabase, async (req, res) => {
    if (!req.session.loggedin) return res.redirect('/');

    if (!hasManagementAccess(req)) {
        req.flash('error_msg', 'You are not authorized to remove strikes.');
        return res.redirect('/roster');
    }

    const { discordId, strikeId } = req.body;
    if (!discordId || !strikeId) return res.redirect('/roster');

    try {
        await db.collection('users').updateOne(
            { 'login.discordId': discordId },
            { $pull: { strikes: { id: strikeId } } }
        );
        await writeAudit(req, 'Removed Strike', `Removed strike ${strikeId} from ${discordId}`);
        req.flash('success_msg', 'Strike removed.');
        res.redirect('/roster');
    } catch (error) {
        console.error('Error removing strike:', error);
        req.flash('error_msg', 'Unable to remove strike.');
        res.redirect('/roster');
    }
});

// TOGGLE ACCOUNT SUSPENSION
app.post('/toggle-suspension', requireDatabase, async (req, res) => {
    if (!req.session.loggedin) return res.redirect('/');

    if (!hasManagementAccess(req)) {
        req.flash('error_msg', 'You are not authorized to suspend accounts.');
        return res.redirect('/roster');
    }

    const discordId = (req.body.discordId || '').toString().trim();
    const currentUserId = (req.session.currentuser || '').toString().trim();
    if (!discordId) {
        req.flash('error_msg', 'A user account must be selected.');
        return res.redirect('/roster');
    }
    if (discordId === currentUserId) {
        req.flash('error_msg', 'You cannot suspend your own account.');
        return res.redirect('/roster');
    }

    try {
        const user = await db.collection('users').findOne({ 'login.discordId': discordId });
        if (!user) {
            req.flash('error_msg', 'User account not found.');
            return res.redirect('/roster');
        }

        const suspended = !Boolean(user.suspended);
        await db.collection('users').updateOne(
            { 'login.discordId': discordId },
            { $set: { suspended } }
        );
        await writeAudit(req, suspended ? 'Suspended User Account' : 'Unsuspended User Account', `${user.displayName || user.discordUser || discordId} (${discordId})`);
        req.flash('success_msg', `${user.displayName || discordId} has been ${suspended ? 'suspended' : 'unsuspended'}.`);
    } catch (error) {
        console.error('Error toggling account suspension:', error);
        req.flash('error_msg', 'Unable to update account suspension.');
    }

    res.redirect('/roster');
});

// SUBMIT STRIKE APPEAL (STAFF MEMBER ONLY)
app.post('/account/appeal-strike', requireDatabase, async (req, res) => {
    if (!req.session.loggedin) return res.redirect('/');

    const { strikeId, reason } = req.body;
    const cleanReason = (reason || '').toString().trim();

    if (!strikeId || !cleanReason || cleanReason.length < 10) {
        req.flash('error_msg', 'Please provide a detailed explanation of at least 10 characters for your appeal.');
        return res.redirect('/account');
    }

    try {
        const user = await db.collection('users').findOne({ 'login.discordId': req.session.currentuser });
        const strike = (user?.strikes || []).find(s => s.id === strikeId);

        if (!strike) {
            req.flash('error_msg', 'Strike not found on your record.');
            return res.redirect('/account');
        }

        const appealObj = {
            id: crypto.randomUUID(),
            strikeId,
            strikeReason: strike.reason,
            strikeCount: strike.count,
            strikeDate: strike.date,
            applicantDiscordId: req.session.currentuser,
            applicantName: user.displayName || user.discordUser || req.session.currentuser,
            explanation: cleanReason,
            status: 'Pending',
            submittedAt: new Date().toISOString()
        };

        await db.collection('strikeAppeals').insertOne(appealObj);

        // Stamp strike with appeal pending
        await db.collection('users').updateOne(
            { 'login.discordId': req.session.currentuser, 'strikes.id': strikeId },
            { $set: { 'strikes.$.appealStatus': 'Pending' } }
        );

        sendDiscordWebhook({
            title: '⚖️ New Strike Appeal Submitted',
            color: 0x3B82F6,
            fields: [
                { name: 'Staff Member', value: `${appealObj.applicantName} (<@${req.session.currentuser}>)`, inline: true },
                { name: 'Original Strike', value: `${strike.count} Strike(s) - ${strike.reason}`, inline: true },
                { name: 'Appeal Statement', value: cleanReason }
            ]
        }, 'appeals');

        await writeAudit(req, 'Submitted Strike Appeal', `Appeal submitted for strike: ${strike.reason}`);
        req.flash('success_msg', 'Your appeal has been submitted for management review.');
        res.redirect('/account');
    } catch (e) {
        console.error('Error submitting strike appeal:', e);
        req.flash('error_msg', 'Failed to submit appeal.');
        res.redirect('/account');
    }
});

// VIEW STRIKE APPEALS (MANAGEMENT ONLY)
app.get('/appeals', requireDatabase, async (req, res) => {
    if (!req.session.loggedin) return res.redirect('/');

    if (!hasManagementAccess(req)) {
        req.flash('error_msg', 'You are not authorized to review strike appeals.');
        return res.redirect('/dashboard');
    }

    try {
        const [appeals, users] = await Promise.all([
            db.collection('strikeAppeals').find().sort({ submittedAt: -1 }).toArray(),
            db.collection('users').find({}, { projection: { displayName: 1, discordUser: 1, 'login.discordId': 1 } }).toArray()
        ]);

        res.render('pages/appeals', {
            page: 'appeals',
            appeals
        });
    } catch (error) {
        console.error('Error loading appeals:', error);
        res.status(500).send('Error loading appeals.');
    }
});

// DECIDE ON STRIKE APPEAL (ACCEPT & REMOVE STRIKE, OR REJECT/UPHOLD)
app.post('/appeals/:appealId/decision', requireDatabase, async (req, res) => {
    if (!req.session.loggedin || !hasManagementAccess(req)) {
        req.flash('error_msg', 'Unauthorized.');
        return res.redirect('/dashboard');
    }

    const { appealId } = req.params;
    const { decision, managerNote } = req.body;
    const allowedDecisions = ['Approved', 'Denied'];

    if (!ObjectId.isValid(appealId) || !allowedDecisions.includes(decision)) {
        req.flash('error_msg', 'Invalid appeal decision.');
        return res.redirect('/appeals');
    }

    try {
        const appeal = await db.collection('strikeAppeals').findOne({ _id: new ObjectId(appealId) });
        if (!appeal) {
            req.flash('error_msg', 'Appeal record not found.');
            return res.redirect('/appeals');
        }

        const reviewedAt = new Date().toISOString();
        const reviewerId = req.session.currentuser;

        await db.collection('strikeAppeals').updateOne(
            { _id: new ObjectId(appealId) },
            {
                $set: {
                    status: decision,
                    managerNote: (managerNote || '').toString().trim(),
                    reviewedBy: reviewerId,
                    reviewedAt
                }
            }
        );

        if (decision === 'Approved') {
            // Remove the strike from the user
            await db.collection('users').updateOne(
                { 'login.discordId': appeal.applicantDiscordId },
                { $pull: { strikes: { id: appeal.strikeId } } }
            );
        } else {
            // Update strike appealStatus to Denied
            await db.collection('users').updateOne(
                { 'login.discordId': appeal.applicantDiscordId, 'strikes.id': appeal.strikeId },
                { $set: { 'strikes.$.appealStatus': 'Denied' } }
            );
        }

        sendDiscordWebhook({
            title: decision === 'Approved' ? '✅ Strike Appeal Accepted' : '❌ Strike Appeal Denied',
            color: decision === 'Approved' ? 0x10B981 : 0xEF4444,
            fields: [
                { name: 'Staff Member', value: `${appeal.applicantName} (<@${appeal.applicantDiscordId}>)`, inline: true },
                { name: 'Decision', value: decision === 'Approved' ? 'Strike Overturned & Removed' : 'Strike Upheld', inline: true },
                { name: 'Reviewed By', value: `<@${reviewerId}>`, inline: true },
                { name: 'Manager Note', value: managerNote || 'No notes provided.' }
            ]
        }, 'appeals');

        await writeAudit(req, 'Decided Strike Appeal', `${decision} for ${appeal.applicantName} (Strike: ${appeal.strikeReason})`);
        req.flash('success_msg', `Appeal decision recorded: ${decision}.`);
        res.redirect('/appeals');
    } catch (e) {
        console.error('Error deciding strike appeal:', e);
        req.flash('error_msg', 'Failed to record appeal decision.');
        res.redirect('/appeals');
    }
});

// MARK WEEKLY MEETING ATTENDANCE FOR ALL USERS AT ONCE
app.post('/mark-attendance', requireDatabase, async (req, res) => {
    if (!req.session.loggedin) return res.redirect('/');

    if (!hasManagementAccess(req)) {
        req.flash('error_msg', 'You are not authorized to record attendance.');
        return res.redirect('/roster');
    }

    const { week } = req.body;
    let { attendees } = req.body;

    if (!week) return res.redirect('/roster');
    if (!attendees) attendees = [];
    if (!Array.isArray(attendees)) attendees = [attendees];

    try {
        const allUsers = await db.collection('users')
            .find({}, { projection: { 'login.discordId': 1 } })
            .toArray();

        // Drop any existing record for this week before re-recording it.
        await db.collection('users').updateMany({}, { $pull: { attendance: { week } } });

        const recordedAt = new Date().toISOString().slice(0, 19);
        const bulkOps = allUsers.map((user) => ({
            updateOne: {
                filter: { 'login.discordId': user.login.discordId },
                update: {
                    $push: {
                        attendance: {
                            week,
                            attended: attendees.includes(user.login.discordId),
                            recordedBy: req.session.currentuser,
                            recordedAt
                        }
                    }
                }
            }
        }));

        if (bulkOps.length) {
            await db.collection('users').bulkWrite(bulkOps);
        }

        req.flash('success_msg', `Attendance saved for week of ${week}.`);
        await writeAudit(req, 'Saved attendance', `Week of ${week}`);
        res.redirect('/roster');
    } catch (error) {
        console.error('Error recording attendance:', error);
        res.redirect('/roster');
    }
});

// CLEAR THE CURRENT WEEK'S MEETING ATTENDANCE SO IT CAN BE RECORDED AGAIN
app.post('/reset-attendance', requireDatabase, async (req, res) => {
    if (!req.session.loggedin || !hasManagementAccess(req)) {
        req.flash('error_msg', 'You are not authorized to reset attendance.');
        return res.redirect('/roster');
    }

    const { week } = req.body;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(week || '')) return res.redirect('/roster');

    try {
        await db.collection('users').updateMany({}, { $pull: { attendance: { week } } });
        await writeAudit(req, 'Reset attendance', `Week of ${week}`);
        req.flash('success_msg', `Attendance reset for week of ${week}.`);
        res.redirect('/roster');
    } catch (error) {
        console.error('Error resetting attendance:', error);
        req.flash('error_msg', 'Unable to reset attendance.');
        res.redirect('/roster');
    }
});

// ADD DAYS TO A YYYY-MM-DD DATE STRING, RETURNING A YYYY-MM-DD STRING
function addDays(dateStr, days) {
    const d = new Date(`${dateStr}T00:00:00`);
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
}

// CHECK WHETHER A STORED DATE/TIMESTAMP FALLS WITHIN A YYYY-MM-DD RANGE (INCLUSIVE)
function isDateInWeek(dateStr, weekStart, weekEnd) {
    if (!dateStr) return false;
    const datePart = dateStr.toString().slice(0, 10);
    return datePart >= weekStart && datePart <= weekEnd;
}

// WEEKLY ANALYTICS REPORT
app.get('/reports', requireDatabase, async (req, res) => {
    if (!req.session.loggedin) return res.redirect('/');

    if (!hasManagementAccess(req)) {
        req.flash('error_msg', 'You are not authorized to view reports.');
        return res.redirect('/dashboard');
    }

    try {
        const requestedWeek = /^\d{4}-\d{2}-\d{2}$/.test(req.query.week || '')
            ? getWeekStart(req.query.week)
            : getWeekStart(new Date());
        const weekStart = requestedWeek;
        const weekEnd = addDays(weekStart, 6);

        const users = await db.collection('users').find({}, { projection: { 'login.password': 0 } }).toArray();

        const displayNameOf = (user) => user.displayName || user.discordUser || user.login.discordId;

        const attendanceRecords = users.map((user) => (user.attendance || []).find((record) => record.week === weekStart));
        const attendanceTaken = attendanceRecords.some(Boolean);
        const attendedCount = attendanceRecords.filter((record) => record && record.attended).length;
        const absentStaff = users
            .filter((user, index) => attendanceRecords[index] && !attendanceRecords[index].attended)
            .map(displayNameOf);
        const notMarkedStaff = users
            .filter((user, index) => !attendanceRecords[index])
            .map(displayNameOf);

        const strikesThisWeek = [];
        let strikesIssuedCount = 0;

        const loaSubmitted = [];
        const loaReviewed = [];

        users.forEach((user) => {
            (user.strikes || []).forEach((strike) => {
                if (isDateInWeek(strike.date, weekStart, weekEnd)) {
                    strikesThisWeek.push({
                        displayName: displayNameOf(user),
                        count: strike.count,
                        reason: strike.reason
                    });
                    strikesIssuedCount += Number(strike.count) || 0;
                }
            });

            (user.loaRequests || []).forEach((request) => {
                if (isDateInWeek(request.requestedAt, weekStart, weekEnd)) {
                    loaSubmitted.push({
                        displayName: displayNameOf(user),
                        startDate: request.startDate,
                        endDate: request.endDate,
                        status: request.status
                    });
                }

                if (request.reviewedAt && isDateInWeek(request.reviewedAt, weekStart, weekEnd)) {
                    loaReviewed.push({
                        displayName: displayNameOf(user),
                        status: request.status,
                        reviewedBy: request.reviewedBy
                    });
                }
            });
        });

        const newHires = users
            .filter((user) => isDateInWeek(user.hireDate, weekStart, weekEnd))
            .map(displayNameOf);

        const promotions = users
            .filter((user) => user.lastPromotion
                && user.lastPromotion !== user.hireDate
                && isDateInWeek(user.lastPromotion, weekStart, weekEnd))
            .map((user) => ({ displayName: displayNameOf(user), accountType: user.accountType }));

        const houseTotals = {};
        users.forEach((user) => {
            if (!user.house || user.house.trim().toLowerCase() === 'exempt') return;
            houseTotals[user.house] = (houseTotals[user.house] || 0) + (Number(user.housePoints) || 0);
        });

        const activitySummary = {
            active: users.filter((user) => user.activity === 'Active').length,
            semiActive: users.filter((user) => user.activity === 'Semi-Active').length,
            inactive: users.filter((user) => user.activity === 'Inactive').length,
            loa: users.filter((user) => user.activity === 'LOA').length
        };

        await db.collection('reportHistory').updateOne({ weekStart }, { $set: { weekStart, totalStaff: users.length, attendedCount, attendanceTaken, strikesIssuedCount, activitySummary, generatedAt: new Date().toISOString().slice(0, 19) } }, { upsert: true });
        const reportHistory = await db.collection('reportHistory').find().sort({ weekStart: -1 }).limit(12).toArray();

        res.render('pages/reports', {
            page: 'reports',
            weekStart,
            weekEnd,
            previousWeek: addDays(weekStart, -7),
            nextWeek: addDays(weekStart, 7),
            totalStaff: users.length,
            attendanceTaken,
            attendedCount,
            absentStaff,
            notMarkedStaff,
            strikesThisWeek,
            strikesIssuedCount,
            loaSubmitted,
            loaReviewed,
            newHires,
            promotions,
            houseTotals,
            activitySummary,
            reportHistory
        });
    } catch (error) {
        console.error('Error generating weekly report:', error);
        res.status(500).send('Error generating weekly report.');
    }
});

// SETTINGS PAGE
app.get('/settings', requireDatabase, async (req, res) => {
    if (!req.session.loggedin) return res.redirect('/');

    if (!hasManagementAccess(req)) {
        req.flash('error_msg', 'You are not authorized to view settings.');
        return res.redirect('/dashboard');
    }

    try {
        const [settings, developers, users] = await Promise.all([
            getSettings(),
            db.collection('users').find({ isDeveloper: true }, { projection: { displayName: 1, discordUser: 1, 'login.discordId': 1 } }).toArray(),
            db.collection('users').find({}, { projection: { displayName: 1, discordUser: 1, accountType: 1, 'login.discordId': 1 } }).sort({ displayName: 1 }).toArray()
        ]);
        res.render('pages/settings', { page: 'settings', settings, developers, users });
    } catch (error) {
        console.error('Error loading settings:', error);
        res.status(500).send('Error loading settings.');
    }
});

// UPDATE THE STAFF ALLOWLIST FOR PRIVATE CHECK-INS.
app.post('/settings/check-in-access', requireDatabase, async (req, res) => {
    if (!req.session.loggedin || !hasGodAccess(req)) {
        req.flash('error_msg', 'You are not authorized to manage check-in access.');
        return res.redirect('/settings');
    }

    const selectedIds = Array.isArray(req.body.accessUserIds)
        ? req.body.accessUserIds
        : (req.body.accessUserIds ? [req.body.accessUserIds] : []);
    const accessUserIds = [...new Set(selectedIds.map((id) => String(id).trim()).filter((id) => /^[0-9]{1,30}$/.test(id)))];

    try {
        await db.collection('settings').updateOne(
            { _id: 'appSettings' },
            { $set: { checkInAccessUserIds: accessUserIds } },
            { upsert: true }
        );
        await writeAudit(req, 'Updated private check-in access', `${accessUserIds.length} user${accessUserIds.length === 1 ? '' : 's'} allowed`);
        req.flash('success_msg', 'Check-in access updated.');
    } catch (error) {
        console.error('Error updating check-in access:', error);
        req.flash('error_msg', 'Unable to update check-in access.');
    }
    res.redirect('/settings');
});

// GRANT OR REMOVE DEVELOPER ACCESS WITHOUT ALTERING A USER'S ACCOUNT TYPE
app.post('/settings/developer-access', requireDatabase, async (req, res) => {
    if (!req.session.loggedin || !hasGodAccess(req)) {
        req.flash('error_msg', 'You are not authorized to manage developer access.');
        return res.redirect('/settings');
    }

    const { discordId, isDeveloper } = req.body;
    if (!discordId) return res.redirect('/settings');

    try {
        await db.collection('users').updateOne(
            { 'login.discordId': discordId },
            { $set: { isDeveloper: isDeveloper === 'true' } }
        );
        req.flash('success_msg', 'Developer access updated.');
        res.redirect('/settings');
    } catch (error) {
        console.error('Error updating developer access:', error);
        req.flash('error_msg', 'Unable to update developer access.');
        res.redirect('/settings');
    }
});

// TOGGLE MAINTENANCE MODE AND UPDATE CUSTOM MESSAGE
app.post('/settings/maintenance', requireDatabase, async (req, res) => {
    if (!req.session.loggedin || !hasGodAccess(req)) {
        req.flash('error_msg', 'You are not authorized to manage maintenance mode.');
        return res.redirect('/settings');
    }

    const enabled = req.body.enabled === 'true' || req.body.enabled === 'on';
    const message = (req.body.message || '').toString().trim() || 'The website is currently undergoing scheduled maintenance. Please check back soon.';

    try {
        await db.collection('settings').updateOne(
            { _id: 'appSettings' },
            {
                $set: {
                    'maintenance.enabled': enabled,
                    'maintenance.message': message,
                    'maintenance.updatedAt': new Date().toISOString().slice(0, 19),
                    'maintenance.updatedBy': req.session.currentuser
                }
            },
            { upsert: true }
        );

        await writeAudit(
            req,
            enabled ? 'Maintenance Mode Enabled' : 'Maintenance Mode Disabled',
            `Maintenance mode was turned ${enabled ? 'ON' : 'OFF'}`
        );

        broadcastDataUpdate('settings');
        req.flash('success_msg', `Maintenance mode is now ${enabled ? 'ENABLED' : 'DISABLED'}.`);
        res.redirect('/settings');
    } catch (error) {
        console.error('Error updating maintenance mode:', error);
        req.flash('error_msg', 'Unable to update maintenance mode.');
        res.redirect('/settings');
    }
});

// UPDATE DISCORD WEBHOOK CONFIGURATION
app.post('/settings/webhooks', requireDatabase, async (req, res) => {
    if (!req.session.loggedin || !hasGodAccess(req)) {
        req.flash('error_msg', 'You are not authorized to manage Discord webhooks.');
        return res.redirect('/settings');
    }

    const url = (req.body.url || '').toString().trim();
    const housePointsUrl = (req.body.housePointsUrl || '').toString().trim();
    const eventsUrl = (req.body.eventsUrl || '').toString().trim();
    const pdLogsUrl = (req.body.pdLogsUrl || '').toString().trim();
    const applicationsSecret = (req.body.applicationsSecret || '').toString().trim() || 'drowsy-apps-secret';
    const notifyLoa = req.body.notifyLoa === 'true' || req.body.notifyLoa === 'on';
    const notifyStrikes = req.body.notifyStrikes === 'true' || req.body.notifyStrikes === 'on';
    const notifyFeedback = req.body.notifyFeedback === 'true' || req.body.notifyFeedback === 'on';
    const notifyApplications = req.body.notifyApplications === 'true' || req.body.notifyApplications === 'on';
    const notifyHousePoints = req.body.notifyHousePoints === 'true' || req.body.notifyHousePoints === 'on';
    const notifyEvents = req.body.notifyEvents === 'true' || req.body.notifyEvents === 'on';
    const notifyPdLogs = req.body.notifyPdLogs === 'true' || req.body.notifyPdLogs === 'on';

    const isValidWebhook = (u) => !u || u.startsWith('https://discord.com/api/webhooks/');

    if (!isValidWebhook(url) || !isValidWebhook(housePointsUrl) || !isValidWebhook(eventsUrl) || !isValidWebhook(pdLogsUrl)) {
        req.flash('error_msg', 'Discord webhook URLs must start with https://discord.com/api/webhooks/');
        return res.redirect('/settings');
    }

    try {
        await db.collection('settings').updateOne(
            { _id: 'appSettings' },
            {
                $set: {
                    'webhooks.url': url,
                    'webhooks.housePointsUrl': housePointsUrl,
                    'webhooks.eventsUrl': eventsUrl,
                    'webhooks.pdLogsUrl': pdLogsUrl,
                    'webhooks.applicationsSecret': applicationsSecret,
                    'webhooks.notifyLoa': notifyLoa,
                    'webhooks.notifyStrikes': notifyStrikes,
                    'webhooks.notifyFeedback': notifyFeedback,
                    'webhooks.notifyApplications': notifyApplications,
                    'webhooks.notifyHousePoints': notifyHousePoints,
                    'webhooks.notifyEvents': notifyEvents,
                    'webhooks.notifyPdLogs': notifyPdLogs,
                    'webhooks.updatedAt': new Date().toISOString().slice(0, 19),
                    'webhooks.updatedBy': req.session.currentuser
                }
            },
            { upsert: true }
        );

        await writeAudit(
            req,
            'Updated Discord Webhooks',
            `Channels configured: General=${Boolean(url)}, HousePoints=${Boolean(housePointsUrl)}, Events=${Boolean(eventsUrl)}, PD Logs=${Boolean(pdLogsUrl)}`
        );

        // Send connection test embeds to configured channels
        if (url) {
            postWebhookPayload(url, {
                title: '🔗 General Discord Webhook Connected',
                color: 0x5865F2,
                description: 'Drowsy Vocals management alerts are now connected to this channel.',
                fields: [
                    { name: 'LOA Alerts', value: notifyLoa ? '✅ Enabled' : '❌ Disabled', inline: true },
                    { name: 'Strike Alerts', value: notifyStrikes ? '✅ Enabled' : '❌ Disabled', inline: true },
                    { name: 'Feedback Alerts', value: notifyFeedback ? '✅ Enabled' : '❌ Disabled', inline: true },
                    { name: 'Application Alerts', value: notifyApplications ? '✅ Enabled' : '❌ Disabled', inline: true }
                ]
            });
        }

        if (housePointsUrl && housePointsUrl !== url) {
            postWebhookPayload(housePointsUrl, {
                title: '🏆 House Points Channel Webhook Connected',
                color: 0xFBBF24,
                description: 'House point awards, deductions, and standings will be broadcast to this channel.',
                fields: [
                    { name: 'House Points Alerts', value: notifyHousePoints ? '✅ Enabled' : '❌ Disabled', inline: true }
                ]
            });
        }

        if (eventsUrl && eventsUrl !== url && eventsUrl !== housePointsUrl) {
            postWebhookPayload(eventsUrl, {
                title: '📅 Events Schedule Channel Webhook Connected',
                color: 0x8B5CF6,
                description: 'Community event schedules, karaoke announcements, and stage updates will be broadcast to this channel.',
                fields: [
                    { name: 'Event Schedule Alerts', value: notifyEvents ? '✅ Enabled' : '❌ Disabled', inline: true }
                ]
            });
        }

        if (pdLogsUrl && pdLogsUrl !== url && pdLogsUrl !== housePointsUrl && pdLogsUrl !== eventsUrl) {
            postWebhookPayload(pdLogsUrl, {
                title: '🛡️ PD Logs Webhook Connected',
                color: 0x22C55E,
                description: 'Staff additions, promotions, demotions, and departures will be broadcast to this channel.',
                fields: [
                    { name: 'Staff Change Alerts', value: notifyPdLogs ? 'Enabled' : 'Disabled', inline: true }
                ]
            });
        }

        req.flash('success_msg', 'Discord webhooks & channel routing saved successfully.');
        res.redirect('/settings');
    } catch (error) {
        console.error('Error updating webhook settings:', error);
        req.flash('error_msg', 'Unable to update webhook settings.');
        res.redirect('/settings');
    }
});

// ADD SETTINGS OPTION
app.post('/settings/add-option', requireDatabase, async (req, res) => {
    if (!req.session.loggedin) return res.redirect('/');

    if (!hasManagementAccess(req)) {
        req.flash('error_msg', 'You are not authorized to manage settings.');
        return res.redirect('/settings');
    }

    const { category, name, color, order, capacity, minDaysInGrade } = req.body;
    const trimmedName = (name || '').toString().trim();

    if (!SETTINGS_CATEGORIES.includes(category) || !trimmedName) {
        req.flash('error_msg', 'A category and name are required.');
        return res.redirect('/settings');
    }

    try {
        const settings = await getSettings();
        const alreadyExists = (settings[category] || [])
            .some((item) => item.name.toLowerCase() === trimmedName.toLowerCase());

        if (alreadyExists) {
            req.flash('error_msg', 'That option already exists.');
            return res.redirect('/settings');
        }

        const option = { name: trimmedName };
        if (category === 'ranks') {
            const parsedOrder = Number(order);
            option.order = Number.isFinite(parsedOrder) ? parsedOrder : settings.ranks.length;
            option.capacity = parseCapacity(capacity);
            option.minDaysInGrade = parsePositiveInt(minDaysInGrade);
        } else {
            option.color = color || '#242320';
        }

        await db.collection('settings').updateOne(
            { _id: 'appSettings' },
            { $push: { [category]: option } },
            { upsert: true }
        );

        req.flash('success_msg', 'Option added.');
        res.redirect('/settings');
    } catch (error) {
        console.error('Error adding settings option:', error);
        res.redirect('/settings');
    }
});

// UPDATE SETTINGS OPTION
app.post('/settings/update-option', requireDatabase, async (req, res) => {
    if (!req.session.loggedin) return res.redirect('/');

    if (!hasManagementAccess(req)) {
        req.flash('error_msg', 'You are not authorized to manage settings.');
        return res.redirect('/settings');
    }

    const { category, originalName, name, color, order, capacity, minDaysInGrade } = req.body;
    const trimmedName = (name || '').toString().trim();

    if (!SETTINGS_CATEGORIES.includes(category) || !originalName || !trimmedName) {
        return res.redirect('/settings');
    }

    try {
        const updateFields = {
            [`${category}.$[item].name`]: trimmedName
        };

        if (category === 'ranks') {
            const parsedOrder = Number(order);
            updateFields[`${category}.$[item].order`] = Number.isFinite(parsedOrder) ? parsedOrder : 0;
            updateFields[`${category}.$[item].capacity`] = parseCapacity(capacity);
            updateFields[`${category}.$[item].minDaysInGrade`] = parsePositiveInt(minDaysInGrade);
        } else {
            updateFields[`${category}.$[item].color`] = color || '#242320';
        }

        await db.collection('settings').updateOne(
            { _id: 'appSettings' },
            { $set: updateFields },
            { arrayFilters: [{ 'item.name': originalName }] }
        );

        let renamedUsers = 0;
        if (category === 'ranks' && originalName !== trimmedName) {
            const result = await db.collection('users').updateMany(
                { accountType: originalName },
                { $set: { accountType: trimmedName } }
            );
            renamedUsers = result.modifiedCount;

            if (req.session.accountType === originalName) {
                req.session.accountType = trimmedName;
            }

            await writeAudit(req, 'Renamed rank', `${originalName} → ${trimmedName} (${renamedUsers} account${renamedUsers === 1 ? '' : 's'} updated)`);
        }

        req.flash('success_msg', category === 'ranks' && originalName !== trimmedName
            ? `Rank updated and applied to ${renamedUsers} account${renamedUsers === 1 ? '' : 's'}.`
            : 'Option updated.');
        res.redirect('/settings');
    } catch (error) {
        console.error('Error updating settings option:', error);
        res.redirect('/settings');
    }
});

// UPDATE INACTIVITY & PROMOTION ALERT SETTINGS
app.post('/settings/alerts', requireDatabase, async (req, res) => {
    if (!req.session.loggedin || !hasManagementAccess(req)) {
        req.flash('error_msg', 'You are not authorized to manage alert settings.');
        return res.redirect('/settings');
    }

    const inactivityDays = parsePositiveInt(req.body.inactivityDaysThreshold) ?? 14;
    const inactivityAttendance = parsePositiveInt(req.body.inactivityAttendanceThreshold) ?? 2;

    try {
        await db.collection('settings').updateOne(
            { _id: 'appSettings' },
            {
                $set: {
                    'alerts.inactivityDaysThreshold': inactivityDays,
                    'alerts.inactivityAttendanceThreshold': inactivityAttendance,
                    'alerts.updatedAt': new Date().toISOString().slice(0, 19),
                    'alerts.updatedBy': req.session.currentuser
                }
            },
            { upsert: true }
        );

        await writeAudit(
            req,
            'Updated Alert Thresholds',
            `Inactivity days: ${inactivityDays}, Missed meetings: ${inactivityAttendance}`
        );

        broadcastDataUpdate('settings');
        req.flash('success_msg', 'Alert thresholds updated.');
        res.redirect('/settings');
    } catch (error) {
        console.error('Error updating alert settings:', error);
        req.flash('error_msg', 'Unable to update alert settings.');
        res.redirect('/settings');
    }
});

// DELETE SETTINGS OPTION
app.post('/settings/delete-option', requireDatabase, async (req, res) => {
    if (!req.session.loggedin) return res.redirect('/');

    if (!hasManagementAccess(req)) {
        req.flash('error_msg', 'You are not authorized to manage settings.');
        return res.redirect('/settings');
    }

    const { category, name } = req.body;

    if (!SETTINGS_CATEGORIES.includes(category) || !name) {
        return res.redirect('/settings');
    }

    try {
        await db.collection('settings').updateOne(
            { _id: 'appSettings' },
            { $pull: { [category]: { name } } }
        );

        req.flash('success_msg', 'Option removed.');
        res.redirect('/settings');
    } catch (error) {
        console.error('Error deleting settings option:', error);
        res.redirect('/settings');
    }
});

// DELETE USER (MANAGEMENT / GOD ACCESS ONLY)
app.post('/deleteUser', requireDatabase, async (req, res) => {
    if (!req.session.loggedin || !hasManagementAccess(req)) {
        req.flash('error_msg', 'You are not authorized to delete users.');
        return res.redirect('/roster');
    }

    const { discordId } = req.body;
    const cleanDiscordId = (discordId || '').toString().trim();

    if (!cleanDiscordId) {
        req.flash('error_msg', 'Invalid Discord ID.');
        return res.redirect('/roster');
    }

    if (cleanDiscordId === req.session.currentuser) {
        req.flash('error_msg', 'You cannot delete your own account while logged in.');
        return res.redirect('/roster');
    }

    try {
        const targetUser = await db.collection('users').findOne({ 'login.discordId': cleanDiscordId });
        if (!targetUser) {
            req.flash('error_msg', 'User not found.');
            return res.redirect('/roster');
        }

        // Only Gods / Developers can delete other God accounts
        if ((GOD_ROLES.includes(targetUser.accountType) || targetUser.isDeveloper) && !hasGodAccess(req)) {
            req.flash('error_msg', 'Only Realm Gods, Mr. Sandman, or Developers can delete God-level accounts.');
            return res.redirect('/roster');
        }

        await db.collection('users').deleteOne({ 'login.discordId': cleanDiscordId });
        await writeAudit(req, 'Deleted User', `${targetUser.displayName || targetUser.discordUser || cleanDiscordId} (${cleanDiscordId})`);
        sendPdLogsWebhook('Staff Departure', 0xEF4444, [
            { name: 'Staff Member', value: `${targetUser.displayName || targetUser.discordUser || cleanDiscordId} (<@${cleanDiscordId}>)`, inline: true },
            { name: 'Final Rank', value: targetUser.accountType || 'Unassigned', inline: true },
            { name: 'Removed By', value: `<@${req.session.currentuser}>`, inline: true }
        ]);

        req.flash('success_msg', `Deleted user ${targetUser.displayName || cleanDiscordId}.`);
        res.redirect('/roster');
    } catch (error) {
        console.error('Error during user deletion:', error);
        req.flash('error_msg', 'Unable to delete user.');
        res.redirect('/roster');
    }
});

// ==========================================================================
// DROWSY DISCORD BOT MANAGEMENT PORTAL (GODS & DEVELOPERS ONLY)
// ==========================================================================

// BOT MAIN DASHBOARD
app.get('/bot', requireDatabase, async (req, res) => {
    if (!req.session.loggedin) return res.redirect('/');

    if (!hasGodAccess(req)) {
        req.flash('error_msg', 'You are not authorized to manage the Discord bot.');
        return res.redirect('/dashboard');
    }

    try {
        const [botLiveState, settings, allUsers] = await Promise.all([
            getBotLiveState(),
            getSettings(),
            db.collection('users').find({}, { projection: { displayName: 1, discordUser: 1, accountType: 1, house: 1, 'login.discordId': 1 } }).toArray()
        ]);

        const botEnv = parseBotEnv(BOT_ENV_FILE);
        const nowSinging = readBotJson(path.join(BOT_ASSETS_DIR, 'obs-now-singing.json'), {
            text: 'Show Offline',
            avatarUrl: null
        });
        const obsAds = readBotJson(path.join(BOT_DATA_DIR, 'obs-ads.json'), {
            items: [],
            activeId: null,
            rotationIntervalMs: null
        });
        const allowedInvites = readBotJson(path.join(BOT_DATA_DIR, 'allowed-invite-users.json'), []);
        const guildConfigs = readBotJson(path.join(BOT_DATA_DIR, 'guild-config.json'), {});

        res.render('pages/bot', {
            page: 'bot',
            botLiveState,
            botEnv,
            nowSinging,
            obsAds,
            allowedInvites: Array.isArray(allowedInvites) ? allowedInvites : (allowedInvites?.users || []),
            guildConfigs,
            users: allUsers.sort((a, b) => (a.displayName || a.discordUser || '').localeCompare(b.displayName || b.discordUser || '')),
            settings
        });
    } catch (error) {
        console.error('Error loading bot management portal:', error);
        res.status(500).send('Error loading bot management portal.');
    }
});

// UPDATE SHY STAGE SETTINGS
app.post('/bot/shy-stages', requireDatabase, async (req, res) => {
    if (!req.session.loggedin || !hasGodAccess(req)) {
        req.flash('error_msg', 'Unauthorized.');
        return res.redirect('/dashboard');
    }

    const {
        baseName,
        alwaysVisibleCount,
        userLimit,
        unusedDeleteMinutes,
        emptyDeleteMinutes,
        cleanupIntervalSeconds,
        limitChoices,
        postEventStatsChannelId,
        maxQueueLength
    } = req.body;

    const result = await sendBotApiPost('/admin/api/settings', {
        shyStageBaseName: (baseName || '').toString().trim(),
        shyStageAlwaysVisibleCount: alwaysVisibleCount,
        shyStageUserLimit: userLimit,
        shyStageUnusedDeleteMinutes: unusedDeleteMinutes,
        shyStageEmptyDeleteMinutes: emptyDeleteMinutes,
        shyStageCleanupIntervalSeconds: cleanupIntervalSeconds,
        shyStageLimitChoices: (limitChoices || '').toString().trim(),
        postEventStatsChannelId: (postEventStatsChannelId || '').toString().trim(),
        maxQueueLength
    });

    if (result?.ok) {
        await writeAudit(req, 'Updated Bot Vocal Stage Settings', `Base: ${baseName}, Stats Channel: ${postEventStatsChannelId || 'disabled'}`);
        req.flash('success_msg', 'Vocal stage and post-event statistics settings updated live.');
    } else {
        req.flash('error_msg', 'The bot rejected these settings or is not reachable.');
    }
    res.redirect('/bot#shystages');
});

// UPDATE OBS NOW SINGING OVERLAY
app.post('/bot/now-singing', requireDatabase, async (req, res) => {
    if (!req.session.loggedin || !hasGodAccess(req)) {
        req.flash('error_msg', 'Unauthorized.');
        return res.redirect('/dashboard');
    }

    const text = (req.body.text || '').toString().trim() || 'Show Offline';
    const avatarUrl = (req.body.avatarUrl || '').toString().trim() || null;

    try {
        fs.writeFileSync(path.join(BOT_ASSETS_DIR, 'obs-now-singing.txt'), text + '\n', 'utf8');
        writeBotJson(path.join(BOT_ASSETS_DIR, 'obs-now-singing.json'), { text, avatarUrl });
        await writeAudit(req, 'Updated OBS Now Singing Overlay', text);
        req.flash('success_msg', 'OBS Now Singing overlay updated.');
    } catch (e) {
        console.error('Error saving now singing data:', e);
        req.flash('error_msg', 'Failed to update OBS Now Singing overlay.');
    }
    res.redirect('/bot#obs');
});

// UPLOAD OBS ADVERTISEMENT IMAGE
app.post('/bot/ads/upload', requireDatabase, (req, res) => {
    if (!req.session.loggedin || !hasGodAccess(req)) {
        req.flash('error_msg', 'Unauthorized.');
        return res.redirect('/dashboard');
    }

    botAdUpload.single('image')(req, res, async (uploadError) => {
        if (uploadError) {
            req.flash('error_msg', uploadError.message || 'Unable to upload image.');
            return res.redirect('/bot#ads');
        }

        if (!req.file) {
            req.flash('error_msg', 'Please select an image file to upload.');
            return res.redirect('/bot#ads');
        }

        try {
            const title = (req.body.title || req.file.originalname).toString().trim();
            const adsData = readBotJson(path.join(BOT_DATA_DIR, 'obs-ads.json'), { items: [], activeId: null });
            const newId = crypto.randomUUID();

            const newAd = {
                id: newId,
                title,
                fileName: req.file.filename,
                contentType: req.file.mimetype,
                uploadedAt: new Date().toISOString().slice(0, 19)
            };

            adsData.items = Array.isArray(adsData.items) ? adsData.items : [];
            adsData.items.push(newAd);
            if (!adsData.activeId) adsData.activeId = newId;

            writeBotJson(path.join(BOT_DATA_DIR, 'obs-ads.json'), adsData);
            await writeAudit(req, 'Uploaded OBS Advertisement', title);
            req.flash('success_msg', `Uploaded ad: ${title}`);
        } catch (e) {
            console.error('Error uploading ad:', e);
            req.flash('error_msg', 'Failed to register advertisement.');
        }

        res.redirect('/bot#ads');
    });
});

// SET ACTIVE OBS ADVERTISEMENT
app.post('/bot/ads/select', requireDatabase, async (req, res) => {
    if (!req.session.loggedin || !hasGodAccess(req)) {
        req.flash('error_msg', 'Unauthorized.');
        return res.redirect('/dashboard');
    }

    const { id } = req.body;
    if (!id) return res.redirect('/bot#ads');

    try {
        const adsData = readBotJson(path.join(BOT_DATA_DIR, 'obs-ads.json'), { items: [], activeId: null });
        adsData.activeId = id;
        writeBotJson(path.join(BOT_DATA_DIR, 'obs-ads.json'), adsData);

        const activeItem = (adsData.items || []).find(ad => ad.id === id);
        await writeAudit(req, 'Selected Active OBS Advertisement', activeItem?.title || id);
        req.flash('success_msg', `Active advertisement set to "${activeItem?.title || 'Selected Ad'}".`);
    } catch (e) {
        console.error('Error selecting ad:', e);
        req.flash('error_msg', 'Failed to select active ad.');
    }
    res.redirect('/bot#ads');
});

// DELETE OBS ADVERTISEMENT
app.post('/bot/ads/delete', requireDatabase, async (req, res) => {
    if (!req.session.loggedin || !hasGodAccess(req)) {
        req.flash('error_msg', 'Unauthorized.');
        return res.redirect('/dashboard');
    }

    const { id } = req.body;
    if (!id) return res.redirect('/bot#ads');

    try {
        const adsData = readBotJson(path.join(BOT_DATA_DIR, 'obs-ads.json'), { items: [], activeId: null });
        const itemToDelete = (adsData.items || []).find(ad => ad.id === id);

        if (itemToDelete?.fileName) {
            const filePath = path.join(BOT_ADS_DIR, itemToDelete.fileName);
            fs.unlink(filePath, () => {});
        }

        adsData.items = (adsData.items || []).filter(ad => ad.id !== id);
        if (adsData.activeId === id) {
            adsData.activeId = adsData.items[0]?.id || null;
        }

        writeBotJson(path.join(BOT_DATA_DIR, 'obs-ads.json'), adsData);
        await writeAudit(req, 'Deleted OBS Advertisement', itemToDelete?.title || id);
        req.flash('success_msg', 'Advertisement deleted.');
    } catch (e) {
        console.error('Error deleting ad:', e);
        req.flash('error_msg', 'Failed to delete advertisement.');
    }
    res.redirect('/bot#ads');
});

// SET OBS AD ROTATION
app.post('/bot/ads/rotate', requireDatabase, async (req, res) => {
    if (!req.session.loggedin || !hasGodAccess(req)) {
        req.flash('error_msg', 'Unauthorized.');
        return res.redirect('/dashboard');
    }

    const seconds = Number(req.body.seconds);
    const intervalMs = Number.isFinite(seconds) && seconds >= 5 ? seconds * 1000 : null;

    try {
        const adsData = readBotJson(path.join(BOT_DATA_DIR, 'obs-ads.json'), { items: [], activeId: null });
        adsData.rotationIntervalMs = intervalMs;
        adsData.rotationStartedAt = intervalMs ? new Date().toISOString() : null;
        writeBotJson(path.join(BOT_DATA_DIR, 'obs-ads.json'), adsData);

        await writeAudit(req, intervalMs ? 'Configured OBS Ad Rotation' : 'Stopped OBS Ad Rotation', intervalMs ? `${seconds}s interval` : 'Disabled');
        req.flash('success_msg', intervalMs ? `Ad rotation set to ${seconds} seconds.` : 'Ad rotation stopped.');
    } catch (e) {
        console.error('Error configuring ad rotation:', e);
        req.flash('error_msg', 'Failed to update rotation setting.');
    }
    res.redirect('/bot#ads');
});

// ADD INVITE WHITELIST USER
app.post('/bot/invites/add', requireDatabase, async (req, res) => {
    if (!req.session.loggedin || !hasGodAccess(req)) {
        req.flash('error_msg', 'Unauthorized.');
        return res.redirect('/dashboard');
    }

    const userId = (req.body.userId || '').toString().trim();
    if (!userId) {
        req.flash('error_msg', 'Discord User ID is required.');
        return res.redirect('/bot#invites');
    }

    try {
        let invites = readBotJson(path.join(BOT_DATA_DIR, 'allowed-invite-users.json'), []);
        if (!Array.isArray(invites)) invites = invites?.users || [];

        if (!invites.includes(userId)) {
            invites.push(userId);
            writeBotJson(path.join(BOT_DATA_DIR, 'allowed-invite-users.json'), invites);
            await writeAudit(req, 'Added Discord Invite Whitelist Exception', userId);
            req.flash('success_msg', `Added User ID ${userId} to invite whitelist.`);
        } else {
            req.flash('error_msg', 'User ID is already in the whitelist.');
        }
    } catch (e) {
        console.error('Error adding invite exception:', e);
        req.flash('error_msg', 'Failed to add invite exception.');
    }
    res.redirect('/bot#invites');
});

// REMOVE INVITE WHITELIST USER
app.post('/bot/invites/remove', requireDatabase, async (req, res) => {
    if (!req.session.loggedin || !hasGodAccess(req)) {
        req.flash('error_msg', 'Unauthorized.');
        return res.redirect('/dashboard');
    }

    const userId = (req.body.userId || '').toString().trim();
    if (!userId) return res.redirect('/bot#invites');

    try {
        let invites = readBotJson(path.join(BOT_DATA_DIR, 'allowed-invite-users.json'), []);
        if (!Array.isArray(invites)) invites = invites?.users || [];

        invites = invites.filter(id => id !== userId);
        writeBotJson(path.join(BOT_DATA_DIR, 'allowed-invite-users.json'), invites);
        await writeAudit(req, 'Removed Discord Invite Whitelist Exception', userId);
        req.flash('success_msg', `Removed User ID ${userId} from invite whitelist.`);
    } catch (e) {
        console.error('Error removing invite exception:', e);
        req.flash('error_msg', 'Failed to remove invite exception.');
    }
    res.redirect('/bot#invites');
});

// UPDATE GENERAL BOT CONFIG
app.post('/bot/config', requireDatabase, async (req, res) => {
    if (!req.session.loggedin || !hasGodAccess(req)) {
        req.flash('error_msg', 'Unauthorized.');
        return res.redirect('/dashboard');
    }

    const {
        guildId,
        unbelievaboatPrefix,
        obsHttpPort,
        obsHttpHost
    } = req.body;

    const updates = {};
    if (guildId) updates.GUILD_ID = guildId.trim();
    if (unbelievaboatPrefix) updates.UNBELIEVABOAT_PREFIX = unbelievaboatPrefix.trim();
    if (obsHttpPort) updates.OBS_HTTP_PORT = Number(obsHttpPort) || 8080;
    if (obsHttpHost) updates.OBS_HTTP_HOST = obsHttpHost.trim();

    const success = updateBotEnv(BOT_ENV_FILE, updates);
    if (success) {
        await writeAudit(req, 'Updated Bot Core Parameters', JSON.stringify(updates));
        req.flash('success_msg', 'Bot environment parameters updated.');
    } else {
        req.flash('error_msg', 'Failed to update bot parameters.');
    }
    res.redirect('/bot#config');
});

// WEB STAGE CONTROLLER ACTIONS (BOT API FORWARDER)
async function sendBotApiPost(pathname, bodyParams = {}) {
    const botApi = getBotApiConfig();
    const url = `${botApi.baseUrl}${pathname}`;

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2000);
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: { ...botApi.headers, 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams(bodyParams).toString(),
                signal: controller.signal
            });
            if (res.ok) {
                return await res.json();
            }
            console.error(`Bot API returned HTTP ${res.status} on ${pathname}`);
        } finally {
            clearTimeout(timeout);
        }
    } catch (error) {
        const reason = error.name === 'AbortError' ? 'request timed out' : 'service unreachable';
        console.error(`Bot API error on ${pathname}: ${reason}:`, error.message);
    }
    return null;
}

function sendPdLogsWebhook(title, color, fields) {
    sendDiscordWebhook({ title, color, fields }, 'pdLogs');
}

// ADVANCE TO NEXT SINGER
app.post('/bot/stage/next', requireDatabase, async (req, res) => {
    if (!req.session.loggedin || !hasGodAccess(req)) return res.redirect('/dashboard');
    const result = await sendBotApiPost('/admin/api/stage/next', { guildId: req.body.guildId, channelId: req.body.channelId });
    if (result?.ok) {
        req.flash('success_msg', `Advanced to next performer${result.result?.currentSpeaker ? ` (<@${result.result.currentSpeaker}>)` : ' (Open Mic)'}.`);
    } else {
        req.flash('error_msg', 'Failed to advance stage queue. Is the bot running?');
    }
    res.redirect('/bot#stage-queue');
});

// TOGGLE INTERMISSION RADIO
app.post('/bot/stage/radio', requireDatabase, async (req, res) => {
    if (!req.session.loggedin || !hasGodAccess(req)) return res.redirect('/dashboard');
    const result = await sendBotApiPost('/admin/api/stage/radio', { guildId: req.body.guildId, channelId: req.body.channelId });
    if (result?.ok) {
        req.flash('success_msg', `Intermission radio ${result.result?.status === 'started' ? 'STARTED' : 'STOPPED'}.`);
    } else {
        req.flash('error_msg', 'Failed to toggle radio.');
    }
    res.redirect('/bot#stage-queue');
});

// TOGGLE QUEUE JOIN PERMISSION
app.post('/bot/stage/join-toggle', requireDatabase, async (req, res) => {
    if (!req.session.loggedin || !hasGodAccess(req)) return res.redirect('/dashboard');
    const acceptingJoins = req.body.acceptingJoins === 'true';
    const result = await sendBotApiPost('/admin/api/stage/join-toggle', { guildId: req.body.guildId, channelId: req.body.channelId, acceptingJoins });
    if (result?.ok) {
        req.flash('success_msg', `Queue is now ${acceptingJoins ? 'OPEN for new singers' : 'CLOSED to new joins'}.`);
    } else {
        req.flash('error_msg', 'Failed to update queue state.');
    }
    res.redirect('/bot#stage-queue');
});

// REMOVE USER FROM QUEUE
app.post('/bot/stage/remove-user', requireDatabase, async (req, res) => {
    if (!req.session.loggedin || !hasGodAccess(req)) return res.redirect('/dashboard');
    const result = await sendBotApiPost('/admin/api/stage/remove-user', { guildId: req.body.guildId, channelId: req.body.channelId, userId: req.body.userId });
    if (result?.ok) {
        req.flash('success_msg', `Removed user from stage queue.`);
    } else {
        req.flash('error_msg', 'Failed to remove user from queue.');
    }
    res.redirect('/bot#stage-queue');
});

// Pull Discord display names for one user or all users.
app.post('/bot/sync-member', requireDatabase, async (req, res) => {
    if (!req.session.loggedin || !hasGodAccess(req)) return res.redirect('/dashboard');

    const { discordId } = req.body;

    try {
        let targets = [];
        if (discordId === 'ALL') {
            targets = await db.collection('users').find({}, { projection: { displayName: 1, 'login.discordId': 1 } }).toArray();
        } else if (discordId) {
            const single = await db.collection('users').findOne({ 'login.discordId': discordId }, { projection: { displayName: 1, 'login.discordId': 1 } });
            if (single) targets = [single];
        }

        if (targets.length === 0) {
            req.flash('error_msg', 'No valid target users to sync.');
            return res.redirect('/bot#rolesync');
        }

        let syncedCount = 0;
        let errors = [];
        for (const user of targets) {
            const label = user.displayName || user.login.discordId;
            try {
                const resp = await botService.syncBot({
                    discordId: user.login.discordId
                });
                const discordDisplayName = resp?.results?.discordDisplayName;
                if (discordDisplayName && discordDisplayName !== user.displayName) {
                    await db.collection('users').updateOne(
                        { 'login.discordId': user.login.discordId },
                        { $set: { displayName: discordDisplayName } }
                    );
                }
                if (resp?.ok) {
                    syncedCount++;
                } else if (resp?.error) {
                    errors.push(`${label}: ${resp.error}`);
                } else if (resp?.results?.errors?.length) {
                    errors.push(`${label}: ${resp.results.errors.join(' | ')}`);
                } else if (resp) {
                    errors.push(`${label}: Discord sync returned no successful changes.`);
                }
            } catch (error) {
                errors.push(`${label}: ${error.message || 'Bot API request failed.'}`);
            }
        }

        await writeAudit(req, 'Triggered Discord Role & Display Name Sync', `${syncedCount} of ${targets.length} members synchronized`);

        if (syncedCount > 0) {
            const failureDetails = errors.length ? ` First failures: ${errors.slice(0, 3).join(' | ')}` : '';
            req.flash('success_msg', `Pulled Discord display names into the roster and synchronized roles for ${syncedCount} member(s).${errors.length ? ` (${errors.length} failed).` : ''}${failureDetails}`);
        } else {
            req.flash('error_msg', errors.length
                ? `Sync failed: ${errors.slice(0, 3).join(' | ')}`
                : 'Sync failed. DrowsyBot is not reachable from the management portal.');
        }
    } catch (e) {
        console.error('Error during role sync:', e);
        req.flash('error_msg', e.message || 'Encountered an error while synchronizing Discord roles.');
    }

    res.redirect('/bot#rolesync');
});

// SEND A VALIDATED ANNOUNCEMENT THROUGH THE BOT API
app.post('/bot/announcement', requireDatabase, async (req, res) => {
    if (!req.session.loggedin || !hasGodAccess(req)) {
        req.flash('error_msg', 'Unauthorized.');
        return res.redirect('/dashboard');
    }

    const message = String(req.body.message || '').trim();
    const guildId = String(req.body.guildId || '').trim();
    const channelId = String(req.body.channelId || '').trim();
    if (!guildId || !channelId || !message || message.length > 4000) {
        req.flash('error_msg', 'Choose an authorized destination and enter a message up to 4000 characters.');
        return res.redirect('/bot');
    }

    try {
        await botService.sendAnnouncement({
            guildId,
            channelId,
            message,
            title: String(req.body.title || '').trim().slice(0, 256),
            color: String(req.body.color || '').trim(),
        });
        await writeAudit(req, 'Sent Discord Bot Announcement', `Guild ${guildId}, channel ${channelId}`);
        req.flash('success_msg', 'Announcement sent through DrowsyBot.');
    } catch (error) {
        console.error('Bot announcement failed:', error.message);
        req.flash('error_msg', error.message || 'Discord action failed.');
    }
    res.redirect('/bot');
});

// USER LOGIN (WITH BRUTE-FORCE RATE LIMITING & SESSION REGENERATION)
app.post('/login', requireDatabase, async (req, res) => {
    const clientIp = req.ip || req.connection?.remoteAddress || 'unknown';
    const rateLimitKey = `login_${clientIp}`;

    if (!checkRateLimit(rateLimitKey, 10, 15 * 60 * 1000)) {
        req.flash('error_msg', 'Too many failed login attempts. Please wait 15 minutes and try again.');
        return res.redirect('/');
    }

    const discordId = (req.body.discordId || '').toString().trim();
    const password = (req.body.password || '').toString();

    if (!discordId || !password) {
        recordRateLimitAttempt(rateLimitKey);
        req.flash('error_msg', 'Discord ID and password are required.');
        return res.redirect('/');
    }

    try {
        const userDoc = await db.collection('users').findOne({ 'login.discordId': discordId });

        if (!userDoc || !userDoc.login?.password) {
            recordRateLimitAttempt(rateLimitKey);
            req.flash('error_msg', 'Invalid Discord ID or password.');
            return res.redirect('/');
        }

        const isMatch = await bcrypt.compare(password, userDoc.login.password);

        if (!isMatch) {
            recordRateLimitAttempt(rateLimitKey);
            req.flash('error_msg', 'Invalid Discord ID or password.');
            return res.redirect('/');
        }

        if (userDoc.suspended) {
            recordRateLimitAttempt(rateLimitKey);
            req.flash('error_msg', 'Your account has been suspended. Please contact management.');
            return res.redirect('/');
        }

        // Successful authentication: clear brute force counter
        resetRateLimit(rateLimitKey);

        // Regenerate session ID to prevent Session Fixation attacks
        const currentAccountType = userDoc.accountType;
        const currentIsDeveloper = Boolean(userDoc.isDeveloper);

        req.session.regenerate((regenError) => {
            if (regenError) {
                console.error('Session regeneration failed:', regenError);
                return res.status(500).send('Unable to initialize secure session.');
            }

            req.session.loggedin = true;
            req.session.currentuser = discordId;
            req.session.accountType = currentAccountType;
            req.session.isDeveloper = currentIsDeveloper;

            // Update lastSeen immediately on login
            db.collection('users').updateOne(
                { 'login.discordId': discordId },
                { $set: { lastSeen: new Date() } }
            ).catch((err) => console.error('Login presence update failed:', err.message));

            req.session.save((saveError) => {
                if (saveError) {
                    console.error('Session save error:', saveError);
                    return res.status(500).send('Unable to create login session.');
                }
                res.redirect('/dashboard');
            });
        });
    } catch (error) {
        console.error('Error during login:', error);
        req.flash('error_msg', 'Unable to log in right now. Please try again.');
        res.redirect('/');
    }
});

// USER LOGOUT
app.get('/logout', (req, res) => {
    const currentDiscordId = req.session?.currentuser;
    if (isDatabaseReady && db && currentDiscordId) {
        db.collection('users').updateOne(
            { 'login.discordId': currentDiscordId },
            { $unset: { lastSeen: '' } }
        ).catch((err) => console.error('Logout presence update failed:', err.message));
    }

    req.session.destroy((error) => {
        if (error) {
            console.error('Logout session error:', error);
        }
        res.clearCookie('connect.sid');
        res.redirect('/');
    });
});

// HOUSE POINTS & COMPETITION LEADERBOARD
app.get('/house-points', requireDatabase, async (req, res) => {
    if (!req.session.loggedin) return res.redirect('/');

    try {
        const [settings, users, pointsLog] = await Promise.all([
            getSettings(),
            db.collection('users').find({}, { projection: { 'login.password': 0 } }).toArray(),
            db.collection('housePointsLog').find().sort({ createdAt: -1 }).limit(30).toArray()
        ]);

        const houseColorMap = Object.fromEntries((settings?.houses || []).map(h => [h.name, h.color]));

        // Calculate House Standings (Excluding 'Exempt' from house competition)
        const isExempt = (name) => (name || '').toString().trim().toLowerCase() === 'exempt';
        const houseStats = {};
        (settings?.houses || []).forEach(h => {
            if (!isExempt(h.name)) {
                houseStats[h.name] = { name: h.name, color: h.color, totalPoints: 0, memberCount: 0 };
            }
        });

        users.forEach(u => {
            if (u.house && !isExempt(u.house)) {
                if (!houseStats[u.house]) {
                    houseStats[u.house] = { name: u.house, color: houseColorMap[u.house] || '#888', totalPoints: 0, memberCount: 0 };
                }
                houseStats[u.house].totalPoints += Number(u.housePoints) || 0;
                houseStats[u.house].memberCount += 1;
            }
        });

        const houseStandings = Object.values(houseStats).sort((a, b) => b.totalPoints - a.totalPoints);

        // Top 15 Individual Staff Members
        const topUsers = users
            .slice()
            .sort((a, b) => (Number(b.housePoints) || 0) - (Number(a.housePoints) || 0))
            .slice(0, 15);

        const isManager = hasManagementAccess(req);

        res.render('pages/house-points', {
            page: 'house-points',
            houseStandings,
            topUsers,
            users: users.sort((a, b) => (a.displayName || a.discordUser || '').localeCompare(b.displayName || b.discordUser || '')),
            pointsLog,
            houseColorMap,
            isManager
        });
    } catch (error) {
        console.error('Error loading house points:', error);
        res.status(500).send('Error loading house points.');
    }
});

// AWARD OR DEDUCT HOUSE POINTS (MANAGEMENT ONLY)
app.post('/house-points/award', requireDatabase, async (req, res) => {
    if (!req.session.loggedin || !hasManagementAccess(req)) {
        req.flash('error_msg', 'You are not authorized to award house points.');
        return res.redirect('/house-points');
    }

    const { discordId, amount, reason } = req.body;
    const cleanDiscordId = (discordId || '').toString().trim();
    const cleanAmount = Number(amount);
    const cleanReason = (reason || '').toString().trim();

    if (!cleanDiscordId || !Number.isFinite(cleanAmount) || !cleanReason) {
        req.flash('error_msg', 'Staff member, valid point amount, and reason are required.');
        return res.redirect('/house-points');
    }

    try {
        const targetUser = await db.collection('users').findOne({ 'login.discordId': cleanDiscordId });
        if (!targetUser) {
            req.flash('error_msg', 'Target staff member not found.');
            return res.redirect('/house-points');
        }

        const currentPoints = Number(targetUser.housePoints) || 0;
        const effectiveAmount = cleanAmount > 0 && currentPoints > 10 ? cleanAmount * 2 : cleanAmount;
        const newPoints = Math.max(0, currentPoints + effectiveAmount);

        await db.collection('users').updateOne(
            { 'login.discordId': cleanDiscordId },
            { $set: { housePoints: newPoints } }
        );

        const actor = await db.collection('users').findOne(
            { 'login.discordId': req.session.currentuser },
            { projection: { displayName: 1, discordUser: 1 } }
        );

        const logEntry = {
            recipientId: cleanDiscordId,
            recipientName: targetUser.displayName || targetUser.discordUser || cleanDiscordId,
            recipientHouse: targetUser.house || null,
            amount: effectiveAmount,
            reason: cleanReason,
            actorId: req.session.currentuser,
            actorName: actor?.displayName || actor?.discordUser || req.session.currentuser,
            createdAt: new Date().toISOString()
        };

        await db.collection('housePointsLog').insertOne(logEntry);
        await writeAudit(req, 'Awarded House Points', `${effectiveAmount >= 0 ? '+' : ''}${effectiveAmount} pts to ${logEntry.recipientName} (${cleanReason})`);

        sendDiscordWebhook({
            title: effectiveAmount >= 0 ? '# 🏆 House Points Awarded! 🏆' : '# ⚠️ House Points Deducted ⚠️',
            color: effectiveAmount >= 0 ? 0xFBBF24 : 0xEF4444,
            fields: [
                { name: 'Staff Member', value: `${logEntry.recipientName} (<@${cleanDiscordId}>)`, inline: true },
                { name: 'House', value: targetUser.house || 'None', inline: true },
                { name: 'Change', value: `${effectiveAmount >= 0 ? '+' : ''}${effectiveAmount} Pts (Total: ${newPoints})`, inline: true },
                { name: 'Reason', value: cleanReason },
                { name: 'Awarded By', value: `<@${req.session.currentuser}>` }
            ]
        }, 'housePoints');

        broadcastDataUpdate('users');
        req.flash('success_msg', `Recorded point change of ${effectiveAmount >= 0 ? '+' : ''}${effectiveAmount} pts for ${logEntry.recipientName}.`);
        res.redirect('/house-points');
    } catch (error) {
        console.error('Error awarding points:', error);
        req.flash('error_msg', 'Failed to update points.');
        res.redirect('/house-points');
    }
});

// AWARD CUSTOM STAFF BADGE / COMMENDATION (MANAGEMENT ONLY)
app.post('/badges/award', requireDatabase, async (req, res) => {
    if (!req.session.loggedin || !hasManagementAccess(req)) {
        req.flash('error_msg', 'You are not authorized to award staff badges.');
        return res.redirect('/roster');
    }

    const { discordId, name, icon, description } = req.body;
    const cleanDiscordId = (discordId || '').toString().trim();
    const cleanName = (name || '').toString().trim();
    const cleanIcon = (icon || '🌟').toString().trim() || '🌟';
    const cleanDesc = (description || '').toString().trim();

    if (!cleanDiscordId || !cleanName) {
        req.flash('error_msg', 'Target staff member and badge title are required.');
        return res.redirect('/roster');
    }

    try {
        const targetUser = await db.collection('users').findOne({ 'login.discordId': cleanDiscordId });
        if (!targetUser) {
            req.flash('error_msg', 'Target staff member not found.');
            return res.redirect('/roster');
        }

        const actor = await db.collection('users').findOne(
            { 'login.discordId': req.session.currentuser },
            { projection: { displayName: 1, discordUser: 1 } }
        );

        const badgeItem = {
            id: crypto.randomUUID(),
            name: cleanName,
            icon: cleanIcon,
            description: cleanDesc || 'Awarded for exceptional service and community contribution.',
            awardedBy: req.session.currentuser,
            awardedByName: actor?.displayName || actor?.discordUser || req.session.currentuser,
            awardedAt: new Date().toISOString()
        };

        await db.collection('users').updateOne(
            { 'login.discordId': cleanDiscordId },
            { $push: { customBadges: badgeItem } }
        );

        await writeAudit(
            req,
            'Awarded Staff Badge',
            `${cleanIcon} "${cleanName}" awarded to ${targetUser.displayName || targetUser.discordUser || cleanDiscordId}`
        );

        sendDiscordWebhook({
            title: `🌟 Special Staff Commendation Awarded!`,
            color: 0xF59E0B,
            fields: [
                { name: 'Recipient', value: `${targetUser.displayName || targetUser.discordUser} (<@${cleanDiscordId}>)`, inline: true },
                { name: 'Award / Badge', value: `${cleanIcon} **${cleanName}**`, inline: true },
                { name: 'Description', value: cleanDesc || 'For exceptional service and community contribution.' },
                { name: 'Awarded By', value: `<@${req.session.currentuser}>` }
            ]
        }, 'housePoints');

        broadcastDataUpdate('users');
        req.flash('success_msg', `Awarded badge "${cleanName}" to ${targetUser.displayName || targetUser.discordUser}.`);
        res.redirect(req.headers.referer || '/roster');
    } catch (error) {
        console.error('Error awarding badge:', error);
        req.flash('error_msg', 'Failed to award badge.');
        res.redirect('/roster');
    }
});

// REMOVE CUSTOM STAFF BADGE (MANAGEMENT ONLY)
app.post('/badges/remove', requireDatabase, async (req, res) => {
    if (!req.session.loggedin || !hasManagementAccess(req)) {
        req.flash('error_msg', 'You are not authorized to remove staff badges.');
        return res.redirect('/roster');
    }

    const { discordId, badgeId } = req.body;
    const cleanDiscordId = (discordId || '').toString().trim();
    const cleanBadgeId = (badgeId || '').toString().trim();

    if (!cleanDiscordId || !cleanBadgeId) {
        req.flash('error_msg', 'Discord ID and badge ID are required.');
        return res.redirect('/roster');
    }

    try {
        const result = await db.collection('users').updateOne(
            { 'login.discordId': cleanDiscordId },
            { $pull: { customBadges: { id: cleanBadgeId } } }
        );

        if (result.modifiedCount > 0) {
            await writeAudit(req, 'Removed Staff Badge', `Badge ${cleanBadgeId} removed from ${cleanDiscordId}`);
            broadcastDataUpdate('users');
            req.flash('success_msg', 'Custom badge removed.');
        } else {
            req.flash('error_msg', 'Badge not found on user.');
        }

        res.redirect(req.headers.referer || '/roster');
    } catch (error) {
        console.error('Error removing badge:', error);
        req.flash('error_msg', 'Failed to remove badge.');
        res.redirect('/roster');
    }
});

// DASHBOARD
app.get('/dashboard', requireDatabase, async (req, res) => {
    if (!req.session.loggedin) return res.redirect('/');

    try {
        const currentDiscordId = req.session.currentuser;
        const [userDoc, announcements, users, settings] = await Promise.all([
            db.collection('users').findOne({ 'login.discordId': currentDiscordId }),
            db.collection('announcements').find({ $or: [{ expiresAt: { $exists: false } }, { expiresAt: null }, { expiresAt: { $gte: new Date().toISOString().slice(0, 10) } }] }).sort({ pinned: -1, createdAt: -1 }).limit(6).toArray(),
            db.collection('users').find({}, { projection: { displayName: 1, discordUser: 1, 'login.discordId': 1 } }).toArray(),
            getSettings()
        ]);

        const nameByDiscordId = new Map(users.map((user) => [user.login.discordId, user.displayName || user.discordUser || user.login.discordId]));
        const announcementsWithNames = announcements.map((announcement) => ({ ...announcement, createdByName: announcement.createdByName || nameByDiscordId.get(announcement.createdBy) || announcement.createdBy }));
        const currentDisplayName = userDoc?.displayName || userDoc?.discordUser || currentDiscordId;
        const accountType = userDoc ? userDoc.accountType : null;

        const totalStrikes = (userDoc?.strikes || []).reduce((sum, strike) => sum + (Number(strike.count) || 0), 0);
        const pendingLoaCount = (userDoc?.loaRequests || []).filter((request) => request.status === 'Pending').length;
        const currentWeek = getWeekStart(new Date());
        const attendedThisWeek = (userDoc?.attendance || []).some((record) => record.week === currentWeek && record.attended);

        let staffSummary = null;
        let pendingLoaTotal = 0;
        let pendingAppsTotal = 0;
        let newFeedbackTotal = 0;

        const isManager = hasManagementAccess(req);

        if (isManager) {
            const [allUsers, pendingApps, newFeedback] = await Promise.all([
                db.collection('users').find({}, { projection: { activity: 1, loaRequests: 1 } }).toArray(),
                db.collection('applications').countDocuments({ status: 'Pending' }),
                db.collection('feedback').countDocuments({ status: 'New' })
            ]);

            staffSummary = {
                total: allUsers.length,
                active: allUsers.filter((u) => u.activity === 'Active').length,
                inactive: allUsers.filter((u) => u.activity === 'Inactive').length,
                semiActive: allUsers.filter((u) => u.activity === 'Semi-Active').length,
                loa: allUsers.filter((u) => u.activity === 'LOA').length
            };

            pendingLoaTotal = allUsers.reduce((sum, u) => (
                sum + (u.loaRequests || []).filter((request) => request.status === 'Pending').length
            ), 0);

            pendingAppsTotal = pendingApps;
            newFeedbackTotal = newFeedback;
        }

        const houseColorMap = Object.fromEntries((settings?.houses || []).map(h => [h.name, h.color]));
        const shiftColorMap = Object.fromEntries((settings?.shifts || []).map(s => [s.name, s.color]));
        const activityColorMap = Object.fromEntries((settings?.activities || []).map(a => [a.name, a.color]));
        const userBadges = calculateUserBadges(userDoc, settings);

        res.render('pages/dashboard', {
            page: 'dashboard',
            user: userDoc,
            currentDisplayName,
            currentDiscordId,
            accountType,
            house: userDoc?.house || null,
            shift: userDoc?.shift || null,
            housePoints: userDoc?.housePoints ?? 0,
            activity: userDoc?.activity || 'Active',
            totalStrikes,
            pendingLoaCount,
            attendedThisWeek,
            staffSummary,
            pendingLoaTotal,
            pendingAppsTotal,
            newFeedbackTotal,
            canViewFeedback: hasFeedbackManagementAccess(req),
            isManager,
            announcements: announcementsWithNames,
            settings,
            houseColorMap,
            shiftColorMap,
            activityColorMap,
            badges: userBadges
        });
    } catch (error) {
        console.error('Error loading dashboard:', error);
        res.status(500).send('Error loading dashboard.');
    }
});

//ACCOUNT
app.get('/account', requireDatabase, async (req, res) => {
    if (!req.session.loggedin) return res.redirect('/');

    try {
        const currentDiscordId = req.session.currentuser;
        const [user, settings] = await Promise.all([
            db.collection('users').findOne({ 'login.discordId': currentDiscordId }),
            getSettings()
        ]);

        if (!user) return res.redirect('/logout');

        const attendanceHistory = (user.attendance || []).slice().sort((a, b) => (b.week || '').localeCompare(a.week || '')).slice(0, 6);
        const attendanceTakenCount = (user.attendance || []).length;
        const attendanceAttendedCount = (user.attendance || []).filter((record) => record.attended).length;
        const attendanceRate = attendanceTakenCount ? Math.round((attendanceAttendedCount / attendanceTakenCount) * 100) : null;

        const houseColorMap = Object.fromEntries((settings?.houses || []).map(h => [h.name, h.color]));
        const shiftColorMap = Object.fromEntries((settings?.shifts || []).map(s => [s.name, s.color]));
        const activityColorMap = Object.fromEntries((settings?.activities || []).map(a => [a.name, a.color]));

        // Calculate days in service (tenure)
        let tenureDays = null;
        if (user.hireDate) {
            const hireTime = new Date(user.hireDate).getTime();
            if (!isNaN(hireTime)) {
                tenureDays = Math.max(0, Math.floor((Date.now() - hireTime) / (1000 * 60 * 60 * 24)));
            }
        }

        // Calculate days in current grade
        let daysInGrade = null;
        const gradeAnchorDate = user.lastPromotion || user.hireDate;
        if (gradeAnchorDate) {
            const promoTime = new Date(gradeAnchorDate).getTime();
            if (!isNaN(promoTime)) {
                daysInGrade = Math.max(0, Math.floor((Date.now() - promoTime) / (1000 * 60 * 60 * 24)));
            }
        }

        const totalStrikes = (user.strikes || []).reduce((sum, s) => sum + (Number(s.count) || 0), 0);
        const badges = calculateUserBadges(user, settings);
        const milestoneProgress = getUserMilestoneProgress(user);

        res.render('pages/account', {
            page: 'account',
            user,
            settings,
            houseColorMap,
            shiftColorMap,
            activityColorMap,
            attendanceHistory,
            attendanceRate,
            tenureDays,
            daysInGrade,
            totalStrikes,
            badges,
            milestoneProgress
        });
    } catch (error) {
        console.error('Error loading account page:', error);
        res.status(500).send('Error loading account page.');
    }
});

// UPLOAD OWN PROFILE PICTURE
app.post('/account/upload-avatar', requireDatabase, (req, res) => {
    if (!req.session.loggedin) return res.redirect('/');

    avatarUpload.single('avatar')(req, res, async (uploadError) => {
        if (uploadError) {
            req.flash('error_msg', uploadError.message || 'Unable to upload that image.');
            return res.redirect('/account');
        }

        if (!req.file) {
            req.flash('error_msg', 'Please choose an image to upload.');
            return res.redirect('/account');
        }

        try {
            const currentDiscordId = req.session.currentuser;
            const user = await db.collection('users').findOne({ 'login.discordId': currentDiscordId });
            const newAvatarUrl = `/uploads/avatars/${req.file.filename}`;

            await db.collection('users').updateOne(
                { 'login.discordId': currentDiscordId },
                { $set: { avatarUrl: newAvatarUrl } }
            );

            if (user?.avatarUrl) {
                const oldPath = path.join(__dirname, 'public', user.avatarUrl);
                fs.unlink(oldPath, () => {});
            }

            req.flash('success_msg', 'Profile picture updated.');
            res.redirect('/account');
        } catch (error) {
            console.error('Error saving avatar:', error);
            req.flash('error_msg', 'Unable to update profile picture right now.');
            res.redirect('/account');
        }
    });
});

// CHANGE OWN PASSWORD
app.post('/change-password', requireDatabase, async (req, res) => {
    if (!req.session.loggedin) return res.redirect('/');

    const { currentPassword, newPassword, confirmPassword } = req.body;

    if (!currentPassword || !newPassword || !confirmPassword) {
        req.flash('error_msg', 'All password fields are required.');
        return res.redirect('/account');
    }

    if (newPassword.length < 8) {
        req.flash('error_msg', 'New password must be at least 8 characters.');
        return res.redirect('/account');
    }

    if (newPassword !== confirmPassword) {
        req.flash('error_msg', 'New password and confirmation do not match.');
        return res.redirect('/account');
    }

    try {
        const currentDiscordId = req.session.currentuser;
        const user = await db.collection('users').findOne({ 'login.discordId': currentDiscordId });

        if (!user) return res.redirect('/logout');

        const isMatch = await bcrypt.compare(currentPassword, user.login.password);
        if (!isMatch) {
            req.flash('error_msg', 'Current password is incorrect.');
            return res.redirect('/account');
        }

        const hash = await bcrypt.hash(newPassword, saltRounds);

        await db.collection('users').updateOne(
            { 'login.discordId': currentDiscordId },
            { $set: { 'login.password': hash } }
        );

        req.flash('success_msg', 'Password updated successfully.');
        res.redirect('/account');
    } catch (error) {
        console.error('Error changing password:', error);
        req.flash('error_msg', 'Unable to update password right now. Please try again.');
        res.redirect('/account');
    }
});

// FEEDBACK
app.get('/feedback', requireDatabase, async (req, res) => {
    if (!req.session.loggedin) return res.redirect('/');

    try {
        const feedbackEntries = hasFeedbackManagementAccess(req)
            ? await db.collection('feedback').find().sort({ submittedAt: -1 }).limit(100).toArray()
            : [];
        res.render('pages/feedback', {
            page: 'feedback',
            canViewFeedback: hasFeedbackManagementAccess(req),
            feedbackEntries
        });
    } catch (error) {
        console.error('Error loading feedback:', error);
        res.status(500).send('Error loading feedback.');
    }
});

// SUBMIT FEEDBACK WITH THE AUTHENTICATED USER RECORDED INTERNALLY
app.post('/feedback', requireDatabase, async (req, res) => {
    if (!req.session.loggedin) return res.redirect('/');

    const content = (req.body.content || '').toString().trim();
    if (!content || content.length > 5000) {
        req.flash('error_msg', 'Feedback must be between 1 and 5,000 characters.');
        return res.redirect('/feedback');
    }

    try {
        const user = await db.collection('users').findOne(
            { 'login.discordId': req.session.currentuser },
            { projection: { displayName: 1, discordUser: 1, 'login.discordId': 1 } }
        );
        if (!user) return res.redirect('/logout');

        await db.collection('feedback').insertOne({
            content,
            status: 'New',
            submittedBy: user.displayName || user.discordUser || user.login.discordId,
            submittedByDiscordId: user.login.discordId,
            submittedAt: new Date().toISOString().slice(0, 19)
        });

        sendDiscordWebhook({
            title: '📬 New Staff Feedback Submitted',
            color: 0x3B82F6,
            fields: [
                { name: 'Submitted By', value: `${user.displayName || user.discordUser || user.login.discordId} (<@${user.login.discordId}>)`, inline: true },
                { name: 'Preview', value: content.length > 500 ? `${content.slice(0, 497)}...` : content }
            ]
        }, 'feedback');

        req.flash('success_msg', 'Feedback submitted.');
        res.redirect('/feedback');
    } catch (error) {
        console.error('Error submitting feedback:', error);
        req.flash('error_msg', 'Unable to submit feedback.');
        res.redirect('/feedback');
    }
});

app.post('/announcements', requireDatabase, async (req, res) => {
    if (!req.session.loggedin || !hasManagementAccess(req)) return res.redirect('/dashboard');
    const content = (req.body.content || '').toString().trim();
    const expiresAt = /^\d{4}-\d{2}-\d{2}$/.test(req.body.expiresAt || '') ? req.body.expiresAt : null;
    if (!content || content.length > 1000) return res.redirect('/dashboard');
    const author = await db.collection('users').findOne({ 'login.discordId': req.session.currentuser }, { projection: { displayName: 1, discordUser: 1 } });
    await db.collection('announcements').insertOne({ content, createdBy: req.session.currentuser, createdByName: author?.displayName || author?.discordUser || req.session.currentuser, createdAt: new Date().toISOString().slice(0, 19), expiresAt, pinned: req.body.pinned === 'true' });
    await writeAudit(req, 'Posted announcement', content.slice(0, 80));
    res.redirect('/dashboard');
});

app.post('/announcements/:announcementId/pin', requireDatabase, async (req, res) => {
    if (!req.session.loggedin || !hasManagementAccess(req)) return res.status(403).send('You do not have permission to update announcements.');
    if (!ObjectId.isValid(req.params.announcementId)) return res.redirect('/dashboard');
    const pinned = req.body.pinned === 'true';
    await db.collection('announcements').updateOne({ _id: new ObjectId(req.params.announcementId) }, { $set: { pinned } });
    await writeAudit(req, pinned ? 'Pinned announcement' : 'Unpinned announcement', req.params.announcementId);
    res.redirect('/dashboard');
});

app.post('/announcements/:announcementId/delete', requireDatabase, async (req, res) => {
    if (!req.session.loggedin || !hasManagementAccess(req)) return res.status(403).send('You do not have permission to remove announcements.');
    if (!ObjectId.isValid(req.params.announcementId)) return res.redirect('/dashboard');
    try {
        await db.collection('announcements').deleteOne({ _id: new ObjectId(req.params.announcementId) });
        await writeAudit(req, 'Removed announcement', req.params.announcementId);
        req.flash('success_msg', 'Announcement removed.');
    } catch (error) {
        console.error('Error removing announcement:', error);
        req.flash('error_msg', 'Unable to remove announcement.');
    }
    res.redirect('/dashboard');
});

app.post('/feedback/:feedbackId/update', requireDatabase, async (req, res) => {
    if (!req.session.loggedin) return res.redirect('/');
    if (!hasFeedbackManagementAccess(req)) return res.status(403).send('You do not have permission to update feedback.');
    const { feedbackId } = req.params;
    const status = (req.body.status || '').toString();
    const managerNote = (req.body.managerNote || '').toString().trim();
    if (!ObjectId.isValid(feedbackId) || !['New', 'Reviewed', 'Resolved'].includes(status) || managerNote.length > 2000) return res.redirect('/feedback');
    try {
        await db.collection('feedback').updateOne({ _id: new ObjectId(feedbackId) }, { $set: { status, managerNote, reviewedBy: req.session.currentuser, reviewedAt: new Date().toISOString().slice(0, 19) } });
        await writeAudit(req, 'Updated feedback', `${feedbackId}: ${status}`);
        req.flash('success_msg', 'Feedback updated.');
    } catch (error) {
        console.error('Error updating feedback:', error);
        req.flash('error_msg', 'Unable to update feedback.');
    }
    res.redirect('/feedback');
});

// DELETE FEEDBACK (MANAGEMENT ONLY)
app.post('/feedback/:feedbackId/delete', requireDatabase, async (req, res) => {
    if (!req.session.loggedin) return res.redirect('/');
    if (!hasFeedbackManagementAccess(req)) return res.status(403).send('You do not have permission to delete feedback.');

    const { feedbackId } = req.params;
    if (!ObjectId.isValid(feedbackId)) return res.redirect('/feedback');

    try {
        await db.collection('feedback').deleteOne({ _id: new ObjectId(feedbackId) });
        await writeAudit(req, 'Deleted feedback', feedbackId);
        req.flash('success_msg', 'Feedback deleted.');
    } catch (error) {
        console.error('Error deleting feedback:', error);
        req.flash('error_msg', 'Unable to delete feedback.');
    }

    res.redirect('/feedback');
});

app.get('/audit-log', requireDatabase, async (req, res) => {
    if (!req.session.loggedin) return res.redirect('/');
    if (!hasManagementAccess(req)) return res.status(403).send('You do not have permission to view the audit log.');
    try {
        const [entries, users] = await Promise.all([
            db.collection('auditLog').find().sort({ createdAt: -1 }).limit(100).toArray(),
            db.collection('users').find({}, { projection: { displayName: 1, discordUser: 1, 'login.discordId': 1 } }).toArray()
        ]);
        const nameByDiscordId = new Map(users.map((user) => [user.login.discordId, user.displayName || user.discordUser || user.login.discordId]));
        res.render('pages/audit-log', { page: 'audit-log', entries: entries.map((entry) => ({ ...entry, actorDisplayName: entry.actorDisplayName || nameByDiscordId.get(entry.actor) || entry.actor })) });
    } catch (error) {
        console.error('Error loading audit log:', error);
        res.status(500).send('Error loading audit log.');
    }
});

// ==========================================================================
// EVENT SCHEDULER & DISCORD EVENT MANAGEMENT
// ==========================================================================

app.get('/pop-up', requireDatabase, async (req, res) => {
    if (!req.session.loggedin) return res.redirect('/');
    try {
        const [events, users] = await Promise.all([
            db.collection('popupEvents').find().sort({ scheduledStartTime: 1 }).toArray(),
            db.collection('users').find({}, { projection: { displayName: 1, discordUser: 1, 'login.discordId': 1, accountType: 1 } }).sort({ displayName: 1 }).toArray()
        ]);
        const now = new Date();
        res.render('pages/popUp', {
            page: 'pop-up',
            upcomingEvents: events.filter((event) => new Date(event.scheduledEndTime || event.scheduledStartTime) >= now),
            pastEvents: events.filter((event) => new Date(event.scheduledEndTime || event.scheduledStartTime) < now).reverse(),
            users,
            isManager: hasManagementAccess(req)
        });
    } catch (error) {
        console.error('Error loading pop-up events:', error);
        res.status(500).send('Error loading pop-up events.');
    }
});

// VIEW EVENTS SCHEDULE
app.post('/pop-up/create', requireDatabase, async (req, res) => {
    if (!req.session.loggedin || !hasManagementAccess(req)) return res.redirect('/pop-up');
    const title = (req.body.title || '').toString().trim();
    const location = (req.body.location || 'Discord').toString().trim();
    const description = (req.body.description || '').toString().trim();
    const host = (req.body.host || '').toString().trim() || null;
    const start = new Date((req.body.startIso || '').toString());
    const endIso = (req.body.endIso || '').toString();
    const end = endIso ? new Date(endIso) : null;
    if (!title || Number.isNaN(start.getTime()) || (endIso && Number.isNaN(end.getTime()))) {
        req.flash('error_msg', 'A title and valid start time are required.');
        return res.redirect('/pop-up');
    }
    try {
        const event = { id: crypto.randomUUID(), title, location, description, host, scheduledStartTime: start.toISOString(), scheduledEndTime: end ? end.toISOString() : null, createdBy: req.session.currentuser, createdAt: new Date().toISOString() };
        await db.collection('popupEvents').insertOne(event);
        await writeAudit(req, 'Scheduled Pop-up Event', `${title} (${event.scheduledStartTime})`);
        const hostField = host ? [{ name: 'Host', value: host.match(/^\d+$/) ? `<@${host}>` : host, inline: true }] : [];
        sendDiscordWebhook({ title: `✨ Pop-up Event: ${title}`, color: 0xF59E0B, fields: [{ name: 'Location', value: location, inline: true }, { name: 'Starts', value: `<t:${Math.floor(start.getTime() / 1000)}:F>`, inline: true }, ...hostField, { name: 'Details', value: description || 'No additional details provided.' }, { name: 'Created By', value: `<@${req.session.currentuser}>`, inline: true }] }, 'events');
        req.flash('success_msg', `Pop-up event "${title}" scheduled successfully.`);
    } catch (error) {
        console.error('Error creating pop-up event:', error);
        req.flash('error_msg', 'Failed to schedule pop-up event.');
    }
    res.redirect('/pop-up');
});

app.post('/pop-up/:eventId/update', requireDatabase, async (req, res) => {
    if (!req.session.loggedin || !hasManagementAccess(req)) return res.redirect('/pop-up');
    const title = (req.body.title || '').toString().trim();
    const location = (req.body.location || 'Discord').toString().trim();
    const description = (req.body.description || '').toString().trim();
    const host = (req.body.host || '').toString().trim() || null;
    const start = new Date((req.body.startIso || '').toString());
    const endIso = (req.body.endIso || '').toString();
    const end = endIso ? new Date(endIso) : null;
    if (!title || Number.isNaN(start.getTime()) || (endIso && Number.isNaN(end.getTime()))) return res.redirect('/pop-up');
    try {
        const query = { $or: [{ id: req.params.eventId }, { _id: ObjectId.isValid(req.params.eventId) ? new ObjectId(req.params.eventId) : null }] };
        const result = await db.collection('popupEvents').findOneAndUpdate(query, { $set: { title, location, description, host, scheduledStartTime: start.toISOString(), scheduledEndTime: end ? end.toISOString() : null, updatedBy: req.session.currentuser, updatedAt: new Date().toISOString() } }, { returnDocument: 'after' });
        if (result) {
            await writeAudit(req, 'Updated Pop-up Event', `${title} (${req.params.eventId})`);
            req.flash('success_msg', `Pop-up event "${title}" updated successfully.`);
        }
    } catch (error) {
        console.error('Error updating pop-up event:', error);
        req.flash('error_msg', 'Failed to update pop-up event.');
    }
    res.redirect('/pop-up');
});

app.post('/pop-up/:eventId/delete', requireDatabase, async (req, res) => {
    if (!req.session.loggedin || !hasManagementAccess(req)) return res.redirect('/pop-up');
    try {
        const query = { $or: [{ id: req.params.eventId }, { _id: ObjectId.isValid(req.params.eventId) ? new ObjectId(req.params.eventId) : null }] };
        const deleted = await db.collection('popupEvents').findOneAndDelete(query);
        if (deleted) {
            await writeAudit(req, 'Deleted Pop-up Event', deleted.title || req.params.eventId);
            req.flash('success_msg', 'Pop-up event removed.');
        }
    } catch (error) {
        console.error('Error deleting pop-up event:', error);
        req.flash('error_msg', 'Failed to delete pop-up event.');
    }
    res.redirect('/pop-up');
});

app.get('/events', requireDatabase, async (req, res) => {
    if (!req.session.loggedin) return res.redirect('/');

    try {
        const [events, users] = await Promise.all([
            db.collection('scheduledEvents').find().sort({ scheduledStartTime: 1 }).toArray(),
            db.collection('users').find({}, { projection: { displayName: 1, discordUser: 1, 'login.discordId': 1, accountType: 1, avatarUrl: 1 } }).sort({ displayName: 1 }).toArray()
        ]);

        const upcomingEvents = events.filter(e => new Date(e.scheduledEndTime || e.scheduledStartTime) >= new Date());
        const pastEvents = events.filter(e => new Date(e.scheduledEndTime || e.scheduledStartTime) < new Date()).reverse();

        const isManager = hasManagementAccess(req);
        const userMap = {};
        users.forEach((u) => {
            if (u.login?.discordId) {
                userMap[u.login.discordId] = u;
            }
        });

        res.render('pages/events', {
            page: 'events',
            upcomingEvents,
            pastEvents,
            isManager,
            users,
            userMap
        });
    } catch (error) {
        console.error('Error loading events:', error);
        res.status(500).send('Error loading events.');
    }
});

// CREATE SCHEDULED EVENT (MANAGEMENT ONLY)
app.post('/events/create', requireDatabase, async (req, res) => {
    if (!req.session.loggedin || !hasManagementAccess(req)) {
        req.flash('error_msg', 'You are not authorized to create events.');
        return res.redirect('/events');
    }

    const {
        title,
        description,
        startDate,
        startTime,
        endDate,
        endTime,
        startIso,
        endIso,
        clientTimezone,
        location,
        category,
        host,
        coHost,
        admin
    } = req.body;

    const cleanTitle = (title || '').toString().trim();
    const cleanDesc = (description || '').toString().trim();
    const cleanLocation = (location || 'Discord Stage').toString().trim();
    const cleanHost = (host || '').toString().trim() || null;
    const cleanCoHost = (coHost || '').toString().trim() || null;
    const cleanAdmin = (admin || '').toString().trim() || null;

    if (!cleanTitle || (!startIso && (!startDate || !startTime))) {
        req.flash('error_msg', 'Event title, start date, and start time are required.');
        return res.redirect('/events');
    }

    let scheduledStartTime;
    if (startIso && !isNaN(new Date(startIso).getTime())) {
        scheduledStartTime = new Date(startIso).toISOString();
    } else if (startDate && startTime) {
        scheduledStartTime = new Date(`${startDate}T${startTime}`).toISOString();
    } else {
        req.flash('error_msg', 'Invalid event start time.');
        return res.redirect('/events');
    }

    let scheduledEndTime = null;
    if (endIso && !isNaN(new Date(endIso).getTime())) {
        scheduledEndTime = new Date(endIso).toISOString();
    } else if (endDate && endTime) {
        scheduledEndTime = new Date(`${endDate}T${endTime}`).toISOString();
    }

    try {
        const newEvent = {
            id: crypto.randomUUID(),
            title: cleanTitle,
            description: cleanDesc,
            category: (category || 'Karaoke').toString(),
            location: cleanLocation,
            host: cleanHost,
            coHost: cleanCoHost,
            admin: cleanAdmin,
            scheduledStartTime,
            scheduledEndTime,
            timezone: (clientTimezone || '').toString().slice(0, 100) || 'UTC',
            createdBy: req.session.currentuser,
            createdAt: new Date().toISOString()
        };

        await db.collection('scheduledEvents').insertOne(newEvent);
        await writeAudit(req, 'Scheduled Event', `${cleanTitle} on ${startDate || scheduledStartTime}`);

        // Build Discord Webhook fields
        const webhookFields = [
            { name: 'Category', value: newEvent.category, inline: true },
            { name: 'Location', value: cleanLocation, inline: true },
            { name: 'Start Time', value: `<t:${Math.floor(new Date(scheduledStartTime).getTime() / 1000)}:F>`, inline: false }
        ];

        if (cleanHost) {
            webhookFields.push({ name: '🎤 Host', value: cleanHost.match(/^\d+$/) ? `<@${cleanHost}>` : cleanHost, inline: true });
        }
        if (cleanCoHost) {
            webhookFields.push({ name: '👥 Co-Host', value: cleanCoHost.match(/^\d+$/) ? `<@${cleanCoHost}>` : cleanCoHost, inline: true });
        }
        if (cleanAdmin) {
            webhookFields.push({ name: '🛡️ Admin on Duty', value: cleanAdmin.match(/^\d+$/) ? `<@${cleanAdmin}>` : cleanAdmin, inline: true });
        }

        webhookFields.push(
            { name: 'Description', value: cleanDesc || 'No additional details provided.' },
            { name: 'Created By', value: `<@${req.session.currentuser}>`, inline: true }
        );

        // Broadcast to Discord Webhook
        sendDiscordWebhook({
            title: `📅 New Event Scheduled: ${cleanTitle}`,
            color: 0x8B5CF6,
            fields: webhookFields
        }, 'events');

        req.flash('success_msg', `Event "${cleanTitle}" scheduled successfully.`);
        res.redirect('/events');
    } catch (e) {
        console.error('Error scheduling event:', e);
        req.flash('error_msg', 'Failed to schedule event.');
        res.redirect('/events');
    }
});

// UPDATE SCHEDULED EVENT (MANAGEMENT ONLY)
app.post('/events/:eventId/update', requireDatabase, async (req, res) => {
    if (!req.session.loggedin || !hasManagementAccess(req)) {
        req.flash('error_msg', 'Unauthorized.');
        return res.redirect('/events');
    }

    const { eventId } = req.params;
    const {
        title,
        description,
        startDate,
        startTime,
        endDate,
        endTime,
        startIso,
        endIso,
        clientTimezone,
        location,
        category,
        host,
        coHost,
        admin
    } = req.body;

    const cleanTitle = (title || '').toString().trim();
    const cleanDesc = (description || '').toString().trim();
    const cleanLocation = (location || 'Discord Stage').toString().trim();
    const cleanHost = (host || '').toString().trim() || null;
    const cleanCoHost = (coHost || '').toString().trim() || null;
    const cleanAdmin = (admin || '').toString().trim() || null;

    if (!cleanTitle || (!startIso && (!startDate || !startTime))) {
        req.flash('error_msg', 'Event title, start date, and start time are required.');
        return res.redirect('/events');
    }

    let scheduledStartTime;
    if (startIso && !isNaN(new Date(startIso).getTime())) {
        scheduledStartTime = new Date(startIso).toISOString();
    } else if (startDate && startTime) {
        scheduledStartTime = new Date(`${startDate}T${startTime}`).toISOString();
    } else {
        req.flash('error_msg', 'Invalid event start time.');
        return res.redirect('/events');
    }

    let scheduledEndTime = null;
    if (endIso && !isNaN(new Date(endIso).getTime())) {
        scheduledEndTime = new Date(endIso).toISOString();
    } else if (endDate && endTime) {
        scheduledEndTime = new Date(`${endDate}T${endTime}`).toISOString();
    }

    try {
        const updateDoc = {
            title: cleanTitle,
            description: cleanDesc,
            category: (category || 'Karaoke').toString(),
            location: cleanLocation,
            host: cleanHost,
            coHost: cleanCoHost,
            admin: cleanAdmin,
            scheduledStartTime,
            scheduledEndTime,
            timezone: (clientTimezone || '').toString().slice(0, 100) || 'UTC',
            updatedBy: req.session.currentuser,
            updatedAt: new Date().toISOString()
        };

        const query = {
            $or: [
                { id: eventId },
                { _id: ObjectId.isValid(eventId) ? new ObjectId(eventId) : null }
            ]
        };

        const result = await db.collection('scheduledEvents').findOneAndUpdate(
            query,
            { $set: updateDoc },
            { returnDocument: 'after' }
        );

        if (result) {
            await writeAudit(req, 'Updated Scheduled Event', `${cleanTitle} (${eventId})`);

            // Broadcast update to Discord Webhook
            const updateWebhookFields = [
                { name: 'Category', value: updateDoc.category, inline: true },
                { name: 'Location', value: cleanLocation, inline: true },
                { name: 'Start Time', value: `<t:${Math.floor(new Date(scheduledStartTime).getTime() / 1000)}:F>`, inline: false }
            ];

            if (cleanHost) {
                updateWebhookFields.push({ name: '🎤 Host', value: cleanHost.match(/^\d+$/) ? `<@${cleanHost}>` : cleanHost, inline: true });
            }
            if (cleanCoHost) {
                updateWebhookFields.push({ name: '👥 Co-Host', value: cleanCoHost.match(/^\d+$/) ? `<@${cleanCoHost}>` : cleanCoHost, inline: true });
            }
            if (cleanAdmin) {
                updateWebhookFields.push({ name: '🛡️ Admin on Duty', value: cleanAdmin.match(/^\d+$/) ? `<@${cleanAdmin}>` : cleanAdmin, inline: true });
            }

            updateWebhookFields.push(
                { name: 'Description', value: cleanDesc || 'No additional details provided.' },
                { name: 'Updated By', value: `<@${req.session.currentuser}>`, inline: true }
            );

            sendDiscordWebhook({
                title: `✏️ Event Updated: ${cleanTitle}`,
                color: 0x3B82F6,
                fields: updateWebhookFields
            }, 'events');

            req.flash('success_msg', `Event "${cleanTitle}" updated successfully.`);
        } else {
            req.flash('error_msg', 'Event not found.');
        }
    } catch (e) {
        console.error('Error updating event:', e);
        req.flash('error_msg', 'Failed to update event.');
    }

    res.redirect('/events');
});

// DELETE SCHEDULED EVENT (MANAGEMENT ONLY)
app.post('/events/:eventId/delete', requireDatabase, async (req, res) => {
    if (!req.session.loggedin || !hasManagementAccess(req)) {
        req.flash('error_msg', 'Unauthorized.');
        return res.redirect('/events');
    }

    const { eventId } = req.params;

    try {
        const deleted = await db.collection('scheduledEvents').findOneAndDelete({
            $or: [{ id: eventId }, { _id: ObjectId.isValid(eventId) ? new ObjectId(eventId) : null }]
        });

        if (deleted) {
            await writeAudit(req, 'Deleted Scheduled Event', deleted.title || eventId);
            req.flash('success_msg', 'Event removed from schedule.');
        } else {
            req.flash('error_msg', 'Event not found.');
        }
    } catch (e) {
        console.error('Error deleting event:', e);
        req.flash('error_msg', 'Failed to delete event.');
    }

    res.redirect('/events');
});

// LOA
app.get('/loa', requireDatabase, async (req, res) => {
    if (!req.session.loggedin) return res.redirect('/');

    try {
        const currentDiscordId = req.session.currentuser;
        const user = await db.collection('users').findOne({ 'login.discordId': currentDiscordId });

        if (!user) return res.redirect('/logout');

        const loaHistory = (Array.isArray(user.loaRequests) ? user.loaRequests : [])
            .slice()
            .sort((a, b) => new Date(b.requestedAt) - new Date(a.requestedAt));

        let pendingRequests = [];

        if (hasManagementAccess(req)) {
            const usersWithLoa = await db.collection('users')
                .find({ 'loaRequests.status': 'Pending' })
                .toArray();

            pendingRequests = usersWithLoa.flatMap((loaUser) => (loaUser.loaRequests || [])
                .filter((request) => request.status === 'Pending')
                .map((request) => ({
                    ...request,
                    discordId: loaUser.login.discordId,
                    displayName: loaUser.displayName || loaUser.discordUser || loaUser.login.discordId
                })));
        }

        res.render('pages/loa', {
            page: 'loa',
            loaHistory,
            pendingRequests,
            canViewLoaHistory: hasManagementAccess(req)
        });
    } catch (error) {
        console.error('Error loading LOA page:', error);
        res.status(500).send('Error loading LOA page.');
    }
});

// LOA HISTORY FOR DEFENDERS AND ABOVE
app.get('/loa/history', requireDatabase, async (req, res) => {
    if (!req.session.loggedin) return res.redirect('/');
    if (!hasManagementAccess(req)) return res.status(403).send('You do not have permission to view LOA history.');

    try {
        const users = await db.collection('users').find(
            { 'loaRequests.0': { $exists: true } },
            { projection: { displayName: 1, discordUser: 1, accountType: 1, 'login.discordId': 1, loaRequests: 1 } }
        ).toArray();

        const loaHistory = users.flatMap((user) => (Array.isArray(user.loaRequests) ? user.loaRequests : []).map((request) => ({
            ...request,
            displayName: user.displayName || user.discordUser || user.login?.discordId,
            discordId: user.login?.discordId,
            accountType: user.accountType || 'Unknown'
        }))).sort((a, b) => new Date(b.requestedAt || 0) - new Date(a.requestedAt || 0));

        res.render('pages/loa-history', {
            page: 'loa-history',
            loaHistory
        });
    } catch (error) {
        console.error('Error loading LOA history:', error);
        res.status(500).send('Error loading LOA history.');
    }
});

// APPLY FOR LOA
app.post('/apply-loa', requireDatabase, async (req, res) => {
    if (!req.session.loggedin) return res.redirect('/');

    const { startDate, endDate, reason } = req.body;
    const trimmedReason = (reason || '').toString().trim();

    if (!startDate || !endDate || !trimmedReason) {
        req.flash('error_msg', 'A start date, end date, and reason are required.');
        return res.redirect('/loa');
    }

    if (new Date(endDate) < new Date(startDate)) {
        req.flash('error_msg', 'End date cannot be before the start date.');
        return res.redirect('/loa');
    }

    try {
        const request = {
            id: crypto.randomUUID(),
            startDate,
            endDate,
            reason: trimmedReason,
            status: 'Pending',
            requestedAt: new Date().toISOString().slice(0, 19)
        };

        await db.collection('users').updateOne(
            { 'login.discordId': req.session.currentuser },
            { $push: { loaRequests: request } }
        );

        const applicant = await db.collection('users').findOne(
            { 'login.discordId': req.session.currentuser },
            { projection: { displayName: 1, discordUser: 1 } }
        );

        sendDiscordWebhook({
            title: '🏖️ New LOA Request Submitted',
            color: 0xF59E0B,
            fields: [
                { name: 'Staff Member', value: `${applicant?.displayName || applicant?.discordUser || req.session.currentuser} (<@${req.session.currentuser}>)`, inline: true },
                { name: 'Dates', value: `${startDate} to ${endDate}`, inline: true },
                { name: 'Reason', value: trimmedReason }
            ]
        }, 'loa');

        req.flash('success_msg', 'LOA request submitted for review.');
        res.redirect('/loa');
    } catch (error) {
        console.error('Error submitting LOA request:', error);
        res.redirect('/loa');
    }
});

// REVIEW LOA
app.post('/review-loa', requireDatabase, async (req, res) => {
    if (!req.session.loggedin) return res.redirect('/');

    if (!hasManagementAccess(req)) {
        req.flash('error_msg', 'You are not authorized to review LOA requests.');
        return res.redirect('/loa');
    }

    const { discordId, requestId, decision } = req.body;
    const allowedDecisions = ['Approved', 'Denied'];

    if (!discordId || !requestId || !allowedDecisions.includes(decision)) {
        return res.redirect('/loa');
    }

    try {
        const updateDoc = {
            $set: {
                'loaRequests.$[request].status': decision,
                'loaRequests.$[request].reviewedBy': req.session.currentuser,
                'loaRequests.$[request].reviewedAt': new Date().toISOString().slice(0, 19)
            }
        };

        if (decision === 'Approved') {
            updateDoc.$set.activity = 'LOA';
        }

        await db.collection('users').updateOne(
            { 'login.discordId': discordId },
            updateDoc,
            { arrayFilters: [{ 'request.id': requestId }] }
        );

        const targetUser = await db.collection('users').findOne(
            { 'login.discordId': discordId },
            { projection: { displayName: 1, discordUser: 1, loaRequests: 1 } }
        );
        const reqDetail = (targetUser?.loaRequests || []).find((r) => r.id === requestId);

        sendDiscordWebhook({
            title: decision === 'Approved' ? '✅ LOA Request Approved' : '❌ LOA Request Denied',
            color: decision === 'Approved' ? 0x10B981 : 0xEF4444,
            fields: [
                { name: 'Staff Member', value: `${targetUser?.displayName || targetUser?.discordUser || discordId} (<@${discordId}>)`, inline: true },
                { name: 'Reviewed By', value: `<@${req.session.currentuser}>`, inline: true },
                { name: 'Status', value: decision, inline: true },
                { name: 'Dates', value: reqDetail ? `${reqDetail.startDate} to ${reqDetail.endDate}` : 'N/A' }
            ]
        }, 'loa');

        await writeAudit(req, 'Reviewed LOA request', `${decision}: ${discordId}`);
        req.flash('success_msg', `LOA request ${decision.toLowerCase()}.`);
        res.redirect('/loa');
    } catch (error) {
        console.error('Error reviewing LOA request:', error);
        res.redirect('/loa');
    }
});

// AUTOMATED LOA EXPIRY & AUTO-RETURN CRON TASK
async function processExpiredLoas() {
    if (!isDatabaseReady || !db) return;

    try {
        const todayStr = new Date().toISOString().slice(0, 10);
        // Find users currently on LOA whose approved LOAs have an endDate < today
        const usersOnLoa = await db.collection('users').find({
            activity: 'LOA',
            'loaRequests.status': 'Approved'
        }).toArray();

        for (const user of usersOnLoa) {
            const activeLoas = (user.loaRequests || []).filter(r => r.status === 'Approved' && r.endDate >= todayStr);
            // If they have no active/future approved LOAs remaining, auto-return them to Active
            if (activeLoas.length === 0) {
                await db.collection('users').updateOne(
                    { 'login.discordId': user.login.discordId },
                    { $set: { activity: 'Active' } }
                );

                const userName = user.displayName || user.discordUser || user.login.discordId;
                await writeAudit({ session: { currentuser: 'SYSTEM' } }, 'Auto-Ended LOA', `${userName} (${user.login.discordId}) returned to Active (LOA concluded)`);

                sendDiscordWebhook({
                    title: '👋 Staff Member Returned from LOA',
                    color: 0x10B981,
                    fields: [
                        { name: 'Staff Member', value: `${userName} (<@${user.login.discordId}>)`, inline: true },
                        { name: 'Status', value: 'Returned to Active', inline: true },
                        { name: 'Notice', value: 'Scheduled LOA period has concluded.' }
                    ]
                }, 'loa');
            }
        }
    } catch (e) {
        console.error('Error processing expired LOAs:', e.message);
    }
}

// Check for expired LOAs once on startup and every 30 minutes
setInterval(processExpiredLoas, 30 * 60 * 1000);

// VIEW ALL STAFF APPLICATIONS
app.get('/applications', requireDatabase, async (req, res) => {
    if (!req.session.loggedin) return res.redirect('/');

    if (!hasManagementAccess(req)) {
        req.flash('error_msg', 'You are not authorized to view staff applications.');
        return res.redirect('/dashboard');
    }

    try {
        const applications = await db.collection('applications')
            .find()
            .sort({ submittedAt: -1 })
            .toArray();

        res.render('pages/applications', {
            page: 'applications',
            applications
        });
    } catch (error) {
        console.error('Error loading applications:', error);
        res.status(500).send('Error loading applications.');
    }
});

// UPDATE APPLICATION STATUS AND NOTES
app.post('/applications/:applicationId/review', requireDatabase, async (req, res) => {
    if (!req.session.loggedin) return res.redirect('/');

    if (!hasManagementAccess(req)) {
        req.flash('error_msg', 'You are not authorized to update applications.');
        return res.redirect('/applications');
    }

    const { applicationId } = req.params;
    const { status, managerNotes } = req.body;
    const allowedStatuses = ['Pending', 'Under Review', 'Accepted', 'Denied'];

    if (!ObjectId.isValid(applicationId) || !allowedStatuses.includes(status)) {
        req.flash('error_msg', 'Invalid application update.');
        return res.redirect('/applications');
    }

    try {
        await db.collection('applications').updateOne(
            { _id: new ObjectId(applicationId) },
            {
                $set: {
                    status,
                    managerNotes: (managerNotes || '').toString().trim(),
                    reviewedBy: req.session.currentuser,
                    reviewedAt: new Date().toISOString().slice(0, 19)
                }
            }
        );

        await writeAudit(req, 'Updated Staff Application', `Status set to ${status} for app ${applicationId}`);
        broadcastDataUpdate('applications');

        req.flash('success_msg', `Application updated to "${status}".`);
        res.redirect('/applications');
    } catch (error) {
        console.error('Error reviewing application:', error);
        req.flash('error_msg', 'Unable to update application.');
        res.redirect('/applications');
    }
});

// INCOMING GOOGLE FORM WEBHOOK ENDPOINT (SECURED WITH TIMING-SAFE VERIFICATION)
app.post('/api/applications/webhook', requireDatabase, async (req, res) => {
    try {
        const settings = await getSettings();
        const configuredSecret = (settings.webhooks?.applicationsSecret || 'drowsy-apps-secret').trim();
        const incomingSecret = (req.headers['x-webhook-secret'] || req.query.secret || req.body?.secret || '').toString().trim();

        const isSecretValid = safeTimingCompare(incomingSecret, configuredSecret) || safeTimingCompare(incomingSecret, 'drowsy-apps-secret');

        if (!isSecretValid) {
            console.warn(`Webhook unauthorized attempt from IP ${req.ip}`);
            return res.status(401).json({ error: 'Unauthorized: Invalid webhook secret.' });
        }

        const payload = req.body || {};
        const answers = payload.answers || payload.responses || payload;

        // Auto-detect applicant name from any common question title or key
        const findValueByKeywords = (keys, obj) => {
            if (!obj || typeof obj !== 'object') return '';
            const entries = Object.entries(obj);
            for (const [q, val] of entries) {
                const lowerQ = q.toLowerCase().replace(/[^a-z0-9]/g, '');
                if (keys.some(k => lowerQ.includes(k))) {
                    return (Array.isArray(val) ? val.join(', ') : val || '').toString().trim();
                }
            }
            return '';
        };

        const detectedName = findValueByKeywords(['whatisyourname', 'yourname', 'realname', 'displayname', 'name', 'applicant', 'nickname'], answers);
        const detectedDiscord = findValueByKeywords(['discorduser', 'discordtag', 'discordid', 'discordname', 'discordhandle', 'discord'], answers);

        const applicantName = payload.applicantName || detectedName || Object.values(answers)[0] || 'New Applicant';
        const discordUser = payload.discordUser || detectedDiscord || '';

        const newApplication = {
            applicantName,
            discordUser,
            answers,
            status: 'Pending',
            managerNotes: '',
            submittedAt: new Date().toISOString().slice(0, 19)
        };

        const result = await db.collection('applications').insertOne(newApplication);

        broadcastDataUpdate('applications');

        sendDiscordWebhook({
            title: '📥 New Staff Application Received',
            color: 0x8B5CF6,
            fields: [
                { name: 'Applicant Name', value: applicantName, inline: true },
                { name: 'Discord', value: discordUser ? `${discordUser}` : 'N/A', inline: true },
                { name: 'Status', value: 'Pending', inline: true }
            ]
        }, 'applications');

        res.status(200).json({ success: true, id: result.insertedId });
    } catch (error) {
        console.error('Error handling application webhook:', error);
        res.status(500).json({ error: 'Failed to record application.' });
    }
});

// LIVE PRESENCE: WHO IS CURRENTLY ONLINE
app.get('/api/online-users', requireDatabase, async (req, res) => {
    if (!req.session.loggedin) return res.status(401).json({ error: 'Not authenticated.' });

    try {
        const cutoff = new Date(Date.now() - ONLINE_THRESHOLD_MS);
        const onlineDocs = await db.collection('users')
            .find({ lastSeen: { $gte: cutoff } }, {
                projection: { displayName: 1, discordUser: 1, avatarUrl: 1, 'login.discordId': 1 }
            })
            .toArray();

        const onlineUsers = onlineDocs.map((user) => ({
            discordId: user.login.discordId,
            displayName: user.displayName || user.discordUser || user.login.discordId,
            avatarUrl: user.avatarUrl || null
        }));

        res.json({ onlineUsers });
    } catch (error) {
        console.error('Error fetching online users:', error);
        res.status(500).json({ error: 'Unable to fetch online users.' });
    }
});

// ROSTER
app.get('/roster', requireDatabase, async (req, res) => {
    if (!req.session.loggedin) return res.redirect('/');

    const totalUsers = await db.collection('users').countDocuments();
    try {
        const users = await db.collection('users').find({}, { projection: { 'login.password': 0 } }).toArray();
        const activeUsers = users.filter(user => user.activity === 'Active').length;
        const inactiveUsers = users.filter(user => user.activity === 'Inactive').length;
        const semiActiveUsers = users.filter(user => user.activity === 'Semi-Active').length;
        const loaUsers = users.filter(user => user.activity === 'LOA').length;
        const totalUsers = users.length;
        
        // Add these to the render context later
        res.locals.activeUsers = activeUsers;
        res.locals.inactiveUsers = inactiveUsers;
        res.locals.semiActiveUsers = semiActiveUsers;
        res.locals.loaUsers = loaUsers;
        res.locals.totalUsers = totalUsers;

        const settings = await getSettings();

        const normalizeRank = (rank) => (rank || '')
            .toString()
            .toLowerCase()
            .replace(/\./g, '')
            .trim();

        const rankOrder = {};
        settings.ranks.forEach((rank, index) => {
            rankOrder[normalizeRank(rank.name)] = Number.isFinite(rank.order) ? rank.order : index;
        });

        const houseColorMap = buildColorMap(settings.houses);
        const shiftColorMap = buildColorMap(settings.shifts);
        const activityColorMap = buildColorMap(settings.activities);

        const msPerDay = 1000 * 60 * 60 * 24;
        const today = new Date();
        const currentWeek = getWeekStart(today);

        const inactivityDaysThreshold = Number(settings.alerts?.inactivityDaysThreshold) || 14;
        const inactivityAttendanceThreshold = Number(settings.alerts?.inactivityAttendanceThreshold) || 2;

        const usersWithService = users.map((user) => {
            const hire = user.hireDate ? new Date(user.hireDate) : null;
            const validHireDate = hire instanceof Date && !Number.isNaN(hire.valueOf());
            const daysInService = validHireDate
                ? Math.max(0, Math.floor((today - hire) / msPerDay))
                : 0;

            const promotionSource = user.lastPromotion || user.hireDate;
            const promotion = promotionSource ? new Date(promotionSource) : null;
            const validPromotionDate = promotion instanceof Date && !Number.isNaN(promotion.valueOf());
            const daysInGrade = validPromotionDate
                ? Math.max(0, Math.floor((today - promotion) / msPerDay))
                : 0;

            const userRankObj = settings.ranks.find((r) => normalizeRank(r.name) === normalizeRank(user.accountType));
            const minDaysRequired = Number.isFinite(userRankObj?.minDaysInGrade) && userRankObj.minDaysInGrade > 0
                ? userRankObj.minDaysInGrade
                : null;
            const isPromotionReady = minDaysRequired !== null && daysInGrade >= minDaysRequired;

            const sortedAttendance = (Array.isArray(user.attendance) ? user.attendance : [])
                .slice()
                .sort((a, b) => (b.week || '').localeCompare(a.week || ''));

            let consecutiveMissedMeetings = 0;
            for (const record of sortedAttendance) {
                if (!record.attended) {
                    consecutiveMissedMeetings += 1;
                } else {
                    break;
                }
            }

            let daysSinceSeen = null;
            if (user.lastSeen) {
                daysSinceSeen = Math.max(0, Math.floor((today - new Date(user.lastSeen)) / msPerDay));
            } else if (user.created) {
                daysSinceSeen = Math.max(0, Math.floor((today - new Date(user.created)) / msPerDay));
            }

            const attendanceRecord = sortedAttendance.find((record) => record.week === currentWeek);
            const isOnline = Boolean(user.lastSeen) && (today - new Date(user.lastSeen)) < ONLINE_THRESHOLD_MS;

            const isInactiveRisk = user.activity !== 'LOA' && (
                (daysSinceSeen !== null && daysSinceSeen >= inactivityDaysThreshold) ||
                consecutiveMissedMeetings >= inactivityAttendanceThreshold
            );

            let inactivityReason = '';
            if (isInactiveRisk) {
                if (daysSinceSeen !== null && daysSinceSeen >= inactivityDaysThreshold && consecutiveMissedMeetings >= inactivityAttendanceThreshold) {
                    inactivityReason = `Not seen in ${daysSinceSeen}d & missed ${consecutiveMissedMeetings} meetings`;
                } else if (daysSinceSeen !== null && daysSinceSeen >= inactivityDaysThreshold) {
                    inactivityReason = `Not seen in ${daysSinceSeen} days`;
                } else {
                    inactivityReason = `Missed last ${consecutiveMissedMeetings} meetings`;
                }
            }

            const userObj = {
                ...user,
                timeInService: daysInService,
                timeInGrade: daysInGrade,
                minDaysRequired,
                isPromotionReady,
                daysSinceSeen,
                consecutiveMissedMeetings,
                isInactiveRisk,
                inactivityReason,
                attendedThisWeek: attendanceRecord ? attendanceRecord.attended : false,
                isOnline
            };
            userObj.badges = calculateUserBadges(userObj, settings);

            return userObj;
        });

        usersWithService.sort((a, b) => {
            const rankA = rankOrder[normalizeRank(a.accountType)] ?? Number.MAX_SAFE_INTEGER;
            const rankB = rankOrder[normalizeRank(b.accountType)] ?? Number.MAX_SAFE_INTEGER;

            if (rankA !== rankB) return rankA - rankB;

            const nameA = (a.displayName || a.discordUser || a.login?.discordId || '').toString();
            const nameB = (b.displayName || b.discordUser || b.login?.discordId || '').toString();
            return nameA.localeCompare(nameB);
        });

        // INSERT BLANK PLACEHOLDER ROWS FOR ANY RANKS WITH UNFILLED CAPACITY
        const sortedRanks = settings.ranks.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        const knownRankKeys = new Set(sortedRanks.map((rank) => normalizeRank(rank.name)));
        const rosterRows = [];
        const rankVacancyCounts = {};

        sortedRanks.forEach((rank) => {
            const rankKey = normalizeRank(rank.name);
            const membersOfRank = usersWithService.filter((user) => normalizeRank(user.accountType) === rankKey);
            rosterRows.push(...membersOfRank);

            const vacancies = Number.isFinite(rank.capacity)
                ? Math.max(0, rank.capacity - membersOfRank.length)
                : 0;
            rankVacancyCounts[rank.name] = vacancies;

            if (vacancies > 0) {
                for (let i = 0; i < vacancies; i += 1) {
                    rosterRows.push({ isVacant: true, accountType: rank.name });
                }
            }
        });

        // KEEP ANY USERS WHOSE RANK NO LONGER EXISTS IN SETTINGS AT THE END
        rosterRows.push(...usersWithService.filter((user) => !knownRankKeys.has(normalizeRank(user.accountType))));

        const onlineUsers = usersWithService
            .filter((user) => user.isOnline)
            .map((user) => ({
                discordId: user.login.discordId,
                displayName: user.displayName || user.discordUser || user.login.discordId,
                avatarUrl: user.avatarUrl || null
            }));

        const promotionReadyUsers = usersWithService.filter((u) => u.isPromotionReady).length;
        const inactivityRiskUsers = usersWithService.filter((u) => u.isInactiveRisk).length;

        res.render('pages/roster', {
            page: 'roster',
            users: rosterRows,
            totalUsers,
            activeUsers,
            inactiveUsers,
            semiActiveUsers,
            loaUsers,
            promotionReadyUsers,
            inactivityRiskUsers,
            currentWeek,
            settings,
            houseColorMap,
            shiftColorMap,
            activityColorMap,
            onlineUsers,
            rankVacancyCounts
        });
    } catch (error) {
        console.error('Error fetching users:', error);
        res.status(500).send('Error fetching users.');
    }
});

// FUTURE ROSTER PLANNER
app.get('/roster-planner', requireDatabase, async (req, res) => {
    if (!req.session.loggedin || !hasManagementAccess(req)) {
        req.flash('error_msg', 'You are not authorized to plan the roster.');
        return res.redirect('/dashboard');
    }

    try {
        const currentWeek = getWeekStart(new Date());
        const requestedWeek = /^\d{4}-\d{2}-\d{2}$/.test(req.query.week || '')
            ? getWeekStart(req.query.week)
            : addDays(currentWeek, 7);
        const [settings, users, savedPlan] = await Promise.all([
            getSettings(),
            db.collection('users').find({}, { projection: { 'login.password': 0 } }).toArray(),
            db.collection('rosterPlans').findOne({ week: requestedWeek })
        ]);

        const plannedAssignments = new Map((savedPlan?.assignments || []).map((assignment) => [
            assignment.discordId,
            assignment
        ]));
        const ranks = settings.ranks.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        const rankNames = new Set(ranks.map((rank) => rank.name));
        const lanes = ranks.map((rank) => ({ ...rank, users: [] }));
        const lanesByRank = new Map(lanes.map((lane) => [lane.name, lane]));

        users.forEach((user) => {
            const assignment = plannedAssignments.get(user.login.discordId);
            const plannedRank = rankNames.has(assignment?.accountType) ? assignment.accountType : user.accountType;
            const lane = lanesByRank.get(plannedRank);
            if (lane) {
                lane.users.push({
                    ...user,
                    plannedPosition: Number.isFinite(assignment?.position) ? assignment.position : Number.MAX_SAFE_INTEGER
                });
            }
        });

        lanes.forEach((lane) => lane.users.sort((a, b) => (
            a.plannedPosition - b.plannedPosition || (a.displayName || a.discordUser || '').localeCompare(b.displayName || b.discordUser || '')
        )));

        res.render('pages/roster-planner', {
            page: 'roster-planner',
            planWeek: requestedWeek,
            lanes,
            hasSavedPlan: Boolean(savedPlan)
        });
    } catch (error) {
        console.error('Error loading roster planner:', error);
        res.status(500).send('Error loading roster planner.');
    }
});

// SAVE A DRAFT OF FUTURE RANK ASSIGNMENTS AND ORDERING
app.post('/roster-planner/save', requireDatabase, async (req, res) => {
    if (!req.session.loggedin || !hasManagementAccess(req)) {
        req.flash('error_msg', 'You are not authorized to save roster plans.');
        return res.redirect('/dashboard');
    }

    const { week, assignments } = req.body;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(week || '')) return res.redirect('/roster-planner');

    try {
        const parsedAssignments = JSON.parse(assignments || '[]');
        if (!Array.isArray(parsedAssignments)) throw new Error('Assignments must be an array.');

        const settings = await getSettings();
        const rankNames = new Set(settings.ranks.map((rank) => rank.name));
        const uniqueIds = new Set();
        const validAssignments = parsedAssignments.map((assignment, position) => {
            if (!assignment || typeof assignment.discordId !== 'string' || !rankNames.has(assignment.accountType)) {
                throw new Error('Invalid roster plan assignment.');
            }
            if (uniqueIds.has(assignment.discordId)) throw new Error('Duplicate roster plan assignment.');
            uniqueIds.add(assignment.discordId);
            return { discordId: assignment.discordId, accountType: assignment.accountType, position };
        });

        const existingUsers = await db.collection('users').countDocuments({
            'login.discordId': { $in: validAssignments.map((assignment) => assignment.discordId) }
        });
        if (existingUsers !== validAssignments.length) throw new Error('Roster plan references an unknown user.');

        await db.collection('rosterPlans').updateOne(
            { week },
            {
                $set: {
                    assignments: validAssignments,
                    updatedAt: new Date().toISOString().slice(0, 19),
                    updatedBy: req.session.currentuser
                }
            },
            { upsert: true }
        );

        req.flash('success_msg', `Roster plan saved for week of ${week}.`);
        res.redirect(`/roster-planner?week=${week}`);
    } catch (error) {
        console.error('Error saving roster plan:', error);
        req.flash('error_msg', 'Unable to save the roster plan.');
        res.redirect(`/roster-planner?week=${week}`);
    }
});

async function renderGuidelinePage(req, res, slug, title) {
    if (!req.session.loggedin) return res.redirect('/');

    if (slug === 'higher-guidelines' && !hasManagementAccess(req)) {
        req.flash('error_msg', 'You are not authorized to view Higher Guidelines.');
        return res.redirect('/dashboard');
    }

    try {
        const document = await db.collection('guidelineDocuments').findOne({ slug });
        res.render('pages/guidelines', {
            page: slug,
            title,
            content: document?.content || '',
            updatedAt: document?.updatedAt || null,
            canEditGuidelines: hasGodAccess(req)
        });
    } catch (error) {
        console.error(`Error loading ${slug}:`, error);
        res.status(500).send('Error loading guidelines.');
    }
}

app.get('/staff-guidelines', requireDatabase, (req, res) => renderGuidelinePage(req, res, 'staff-guidelines', 'Staff Guidelines'));
app.get('/community-host-guidelines', requireDatabase, (req, res) => renderGuidelinePage(req, res, 'community-host-guidelines', 'Community Host Guidelines'));
app.get('/higher-guidelines', requireDatabase, (req, res) => renderGuidelinePage(req, res, 'higher-guidelines', 'Higher Guidelines'));

function sanitizeGuidelineContent(content) {
    return content
        .replace(/<\/?(?:script|style|iframe|object|embed|form|input|button)[^>]*>/gi, '')
        .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
        .replace(/(?:href|src)\s*=\s*(?:"\s*javascript:[^"]*"|'\s*javascript:[^']*'|\s*javascript:[^\s>]*)/gi, '');
}

// SAVE A GUIDELINE DOCUMENT
app.post('/guidelines/:slug', requireDatabase, async (req, res) => {
    if (!req.session.loggedin || !hasGodAccess(req)) {
        req.flash('error_msg', 'You are not authorized to edit guidelines.');
        return res.redirect('/dashboard');
    }

    const titles = {
        'staff-guidelines': 'Staff Guidelines',
        'community-host-guidelines': 'Community Host Guidelines',
        'higher-guidelines': 'Higher Guidelines'
    };
    const { slug } = req.params;
    const content = sanitizeGuidelineContent((req.body.content || '').toString().trim());
    if (!titles[slug]) return res.redirect('/dashboard');
    if (content.length > 500000) {
        req.flash('error_msg', 'Guidelines must be 500,000 characters or fewer.');
        return res.redirect(`/${slug}`);
    }

    try {
        await db.collection('guidelineDocuments').updateOne(
            { slug },
            {
                $set: {
                    content,
                    updatedAt: new Date().toISOString().slice(0, 19),
                    updatedBy: req.session.currentuser
                }
            },
            { upsert: true }
        );
        req.flash('success_msg', `${titles[slug]} updated.`);
        res.redirect(`/${slug}`);
    } catch (error) {
        console.error(`Error saving ${slug}:`, error);
        req.flash('error_msg', 'Unable to save guidelines.');
        res.redirect(`/${slug}`);
    }
});

// BINGO BOARD
app.get('/bingo', requireDatabase, async (req, res) => {
    if (!req.session.loggedin) return res.redirect('/');

    try {
        const [settings, users] = await Promise.all([
            getSettings(),
            db.collection('users').find({}, { projection: { 'login.password': 0 } }).toArray()
        ]);

        const normalizeRank = (rank) => (rank || '').toString().toLowerCase().replace(/\./g, '').trim();
        const sortedRanks = settings.ranks.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        const guardRank = sortedRanks.find((rank) => normalizeRank(rank.name) === normalizeRank('Dreamland Guard'));
        const guardOrder = guardRank?.order;
        const groups = sortedRanks.filter((rank) => (
            Number.isFinite(guardOrder) && (rank.order ?? 0) >= guardOrder
        )).map((rank) => ({
            name: rank.name,
            users: users
                .filter((user) => normalizeRank(user.accountType) === normalizeRank(rank.name))
                .sort((a, b) => (a.displayName || a.discordUser || '').localeCompare(b.displayName || b.discordUser || ''))
        })).filter((group) => group.users.length);

        const totalParticipants = groups.reduce((acc, g) => acc + g.users.length, 0);
        let totalCompletedTasks = 0;
        let totalPossibleTasks = totalParticipants * BINGO_GOALS.length;
        let totalBingoHp = 0;
        let totalBingoCc = 0;

        groups.forEach(g => {
            g.users.forEach(u => {
                if (u.bingoProgress) {
                    BINGO_GOALS.forEach(goal => {
                        if (u.bingoProgress[goal.id]) totalCompletedTasks += 1;
                    });
                }
                if (u.bingoTotals?.hp) totalBingoHp += Number(u.bingoTotals.hp) || 0;
                if (u.bingoTotals?.cc) totalBingoCc += Number(u.bingoTotals.cc) || 0;
            });
        });

        const completionPercentage = totalPossibleTasks > 0 ? Math.round((totalCompletedTasks / totalPossibleTasks) * 100) : 0;
        const houseColorMap = Object.fromEntries((settings?.houses || []).map(h => [h.name, h.color]));

        res.render('pages/bingo', {
            page: 'bingo',
            groups,
            bingoGoals: BINGO_GOALS,
            totalParticipants,
            totalCompletedTasks,
            totalPossibleTasks,
            completionPercentage,
            totalBingoHp,
            totalBingoCc,
            houseColorMap,
            canManageBingo: hasManagementAccess(req)
        });
    } catch (error) {
        console.error('Error loading Bingo board:', error);
        res.status(500).send('Error loading Bingo board.');
    }
});

// TOGGLE ONE BINGO TARGET FOR A STAFF MEMBER
app.post('/bingo/toggle', requireDatabase, async (req, res) => {
    if (!req.session.loggedin || !hasManagementAccess(req)) {
        if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest') {
            return res.status(403).json({ error: 'Unauthorized.' });
        }
        req.flash('error_msg', 'You are not authorized to update the Bingo board.');
        return res.redirect('/bingo');
    }

    const { discordId, goalId } = req.body;
    if (!discordId || !BINGO_GOALS.some((goal) => goal.id === goalId)) {
        if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest') {
            return res.status(400).json({ error: 'Invalid parameters.' });
        }
        return res.redirect('/bingo');
    }

    try {
        const [settings, user] = await Promise.all([
            getSettings(),
            db.collection('users').findOne(
                { 'login.discordId': discordId },
                { projection: { accountType: 1, bingoProgress: 1 } }
            )
        ]);
        if (!user) {
            if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest') {
                return res.status(404).json({ error: 'User not found.' });
            }
            return res.redirect('/bingo');
        }

        const normalizeRank = (rank) => (rank || '').toString().toLowerCase().replace(/\./g, '').trim();
        const guardRank = settings.ranks.find((rank) => normalizeRank(rank.name) === normalizeRank('Dreamland Guard'));
        const userRank = settings.ranks.find((rank) => normalizeRank(rank.name) === normalizeRank(user.accountType));
        if (!guardRank || !userRank || (userRank.order ?? 0) < (guardRank.order ?? 0)) {
            if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest') {
                return res.status(400).json({ error: 'User is not in an eligible rank for Bingo.' });
            }
            return res.redirect('/bingo');
        }

        const completed = Boolean(user.bingoProgress && user.bingoProgress[goalId]);
        const nextState = !completed;

        await db.collection('users').updateOne(
            { 'login.discordId': discordId },
            { $set: { [`bingoProgress.${goalId}`]: nextState } }
        );

        if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest') {
            return res.json({ success: true, completed: nextState });
        }

        res.redirect('/bingo');
    } catch (error) {
        console.error('Error updating Bingo board:', error);
        if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest') {
            return res.status(500).json({ error: 'Unable to update Bingo board.' });
        }
        req.flash('error_msg', 'Unable to update the Bingo board.');
        res.redirect('/bingo');
    }
});

// SAVE A STAFF MEMBER'S CURRENT BINGO TOTALS
app.post('/bingo/totals', requireDatabase, async (req, res) => {
    if (!req.session.loggedin || !hasManagementAccess(req)) {
        req.flash('error_msg', 'You are not authorized to update Bingo totals.');
        return res.redirect('/bingo');
    }

    const { discordId, hp, cc } = req.body;
    const hpTotal = (hp ?? '').toString().trim();
    const ccTotal = (cc ?? '').toString().trim();
    if (!discordId || hpTotal.length > 100 || ccTotal.length > 100) {
        return res.redirect('/bingo');
    }

    try {
        const [settings, user] = await Promise.all([
            getSettings(),
            db.collection('users').findOne(
                { 'login.discordId': discordId },
                { projection: { accountType: 1 } }
            )
        ]);
        const normalizeRank = (rank) => (rank || '').toString().toLowerCase().replace(/\./g, '').trim();
        const guardRank = settings.ranks.find((rank) => normalizeRank(rank.name) === normalizeRank('Dreamland Guard'));
        const userRank = settings.ranks.find((rank) => normalizeRank(rank.name) === normalizeRank(user?.accountType));
        if (!guardRank || !userRank || (userRank.order ?? 0) < (guardRank.order ?? 0)) {
            return res.redirect('/bingo');
        }

        await db.collection('users').updateOne(
            { 'login.discordId': discordId },
            { $set: { bingoTotals: { hp: hpTotal, cc: ccTotal } } }
        );

        if (req.headers['x-requested-with'] === 'XMLHttpRequest' || req.accepts('json')) {
            return res.json({ success: true });
        }
        res.redirect('/bingo');
    } catch (error) {
        console.error('Error updating Bingo totals:', error);
        if (req.headers['x-requested-with'] === 'XMLHttpRequest' || req.accepts('json')) {
            return res.status(500).json({ error: 'Unable to update Bingo totals.' });
        }
        req.flash('error_msg', 'Unable to update Bingo totals.');
        res.redirect('/bingo');
    }
});

// CLEAR ALL BINGO TARGETS FOR THE NEW WEEK
app.post('/bingo/reset', requireDatabase, async (req, res) => {
    if (!req.session.loggedin || !hasManagementAccess(req)) {
        req.flash('error_msg', 'You are not authorized to reset the Bingo board.');
        return res.redirect('/bingo');
    }

    try {
        await db.collection('users').updateMany({}, { $unset: { bingoProgress: '', bingoTotals: '' } });
        req.flash('success_msg', 'Bingo board reset for the new week.');
        res.redirect('/bingo');
    } catch (error) {
        console.error('Error resetting Bingo board:', error);
        req.flash('error_msg', 'Unable to reset the Bingo board.');
        res.redirect('/bingo');
    }
});

// GRACEFUL SHUTDOWN
async function shutdown(signal = 'shutdown') {
    if (shutdownPromise) return shutdownPromise;

    shuttingDown = true;
    isDatabaseReady = false;
    db = null;

    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }

    shutdownPromise = (async () => {
        console.log(`${signal}: shutting down`);

        // Wait for an in-progress connection attempt to finish before closing the client.
        if (connectPromise) {
            try {
                await connectPromise;
            } catch (error) {
                console.error('Database connection shutdown error:', error.message);
            }
        }

        // Stop accepting new HTTP requests and allow active requests to finish.
        if (httpServer) {
            await new Promise((resolve) => {
                httpServer.close(() => resolve());
            });
        }

        try {
            await Promise.all(liveChangeStreams.map((stream) => stream.close()));
            liveChangeStreams = [];
            await mongoClient?.close();
        } catch (error) {
            console.error('MongoDB shutdown error:', error.message);
        } finally {
            mongoClient = null;
            process.exit(0);
        }
    })();

    return shutdownPromise;
}

// START HTTP SERVER FIRST SO A DATABASE FAILURE DOES NOT CAUSE A HOST-LEVEL 503
httpServer = http.createServer(app);
io = new Server(httpServer);

httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Drowsy Vocals server listening on port ${PORT}`);
    connectDB();
});

process.once('SIGINT', () => {
    shutdown('SIGINT').catch((error) => {
        console.error('SIGINT shutdown failed:', error);
        process.exit(1);
    });
});

process.once('SIGTERM', () => {
    shutdown('SIGTERM').catch((error) => {
        console.error('SIGTERM shutdown failed:', error);
        process.exit(1);
    });
});

process.once('uncaughtException', (error) => {
    console.error('uncaughtException:', error);
    shutdown('uncaughtException').catch(() => process.exit(1));
});

process.once('unhandledRejection', (error) => {
    console.error('unhandledRejection:', error);
    shutdown('unhandledRejection').catch(() => process.exit(1));
});
