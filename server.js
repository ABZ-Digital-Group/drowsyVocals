// BCRYPT SETUP
const bcrypt = require('bcrypt');
const saltRounds = 10;
const crypto = require('crypto');

require('dotenv').config();
const path = require('path');

// LOAD NPM PACKAGES
const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const { MongoClient } = require('mongodb');

const app = express();

// ENVIRONMENT VARIABLES
const PORT = Number(process.env.PORT) || 3000;
const mongoUri = process.env.MONGODB_URI;
const dbname = process.env.MONGODB_DATABASE;
const sessionSecret = process.env.SESSION_SECRET;

if (!mongoUri) {
    console.error('MONGODB_URI is not configured. Add it to the application environment variables.');
}

if (!dbname) {
    console.error('MONGODB_DATABASE is not configured. Add it to the application environment variables.');
}

if (!sessionSecret) {
    console.warn('SESSION_SECRET is not configured. Add a long random value to the application environment variables.');
}

// Hostinger terminates HTTPS at its reverse proxy.
// This allows express-session to recognise the original HTTPS request
// and set secure cookies correctly in production.
app.set('trust proxy', 1);

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

app.use(express.static(path.join(__dirname, 'public')));

app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

// MIDDLEWARE
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(flash());

// DATABASE STATE
let db = null;
let mongoClient = null;
let isDatabaseReady = false;
let shuttingDown = false;
let connectPromise = null;
let reconnectTimer = null;
let httpServer = null;
let shutdownPromise = null;

// Global middleware to pass session data to templates
app.use((req, res, next) => {
    res.locals.success_msg = req.flash('success_msg');
    res.locals.error_msg = req.flash('error_msg');
    res.locals.loggedin = req.session.loggedin;
    res.locals.currentuser = req.session.currentuser;
    res.locals.userType = req.session.accountType;
    next();
});

function requireDatabase(req, res, next) {
    if (shuttingDown || !isDatabaseReady || !db) {
        return res.status(503).send('Database is temporarily unavailable. Please try again shortly.');
    }
    next();
}

// ROLES ALLOWED TO MANAGE STRIKES, ATTENDANCE, AND LOA APPROVALS
const MANAGEMENT_ROLES = ['Mr. Sandman', 'Realm God', 'Dreamy Defender'];

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
    ranks: [
        { name: 'Mr. Sandman', order: 0 },
        { name: 'Realm God', order: 1 },
        { name: 'Dreamy Defender', order: 2 },
        { name: 'Dreamland Guard', order: 3 },
        { name: 'Nighty Knights', order: 4 },
        { name: 'Tired Esquire', order: 5 }
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
    ]
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

// HEALTH CHECK
app.get('/health', (req, res) => {
    res.status(!shuttingDown && isDatabaseReady ? 200 : 503).json({
        status: !shuttingDown && isDatabaseReady ? 'ok' : 'database_unavailable'
    });
});

// ROOT PAGE DOES NOT REQUIRE DATABASE ACCESS
app.get('/', (req, res) => {
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

// USER SIGN-UP
app.post('/signUp', requireDatabase, async (req, res) => {
    const { discordId, password, accountType } = req.body;

    try {
        const existingUser = await db.collection('users').findOne({ 'login.discordId': discordId });

        if (existingUser) {
            req.flash('error_msg', 'User Already Exists.');
            return res.redirect('/users');
        }

        const hash = await bcrypt.hash(password, saltRounds);
        const newUser = {
            login: { discordId, password: hash },
            accountType,
            created: new Date().toISOString().slice(0, 19)
        };

        await db.collection('users').insertOne(newUser);
        req.flash('success_msg', 'User created successfully!');
        res.redirect('/');
    } catch (error) {
        console.error('Error during sign-up:', error);
        res.redirect('/users');
    }
});

// ADD USER
app.post('/add-user', requireDatabase, async (req, res) => {
    const {
        discordId,
        displayName,
        discordUser,
        accountType,
        hireDate,
        password,
        house,
        shift,
        housePoints = 0,
        activity = 'Active',
        weeksActivity = 0
    } = req.body;

    try {
        const existingUser = await db.collection('users').findOne({ 'login.discordId': discordId });

        if (existingUser) {
            return res.redirect('/roster');
        }

        const hash = await bcrypt.hash(password, saltRounds);
        const newUser = {
            login: { discordId, password: hash },
            displayName,
            discordUser,
            accountType,
            hireDate,
            lastPromotion: hireDate || null,
            house,
            housePoints,
            activity,
            weeksActivity,
            shift,
            created: new Date().toISOString().slice(0, 19)
        };

        await db.collection('users').insertOne(newUser);
        res.redirect('/roster');
    } catch (error) {
        console.error('Error during adding user:', error);
        res.redirect('/roster');
    }
});

// UPDATE USER
app.post('/update-user', requireDatabase, async (req, res) => {
    if (!req.session.loggedin) return res.redirect('/');

    const {
        originalDiscordId,
        discordId,
        displayName,
        discordUser,
        accountType,
        hireDate,
        password,
        house,
        housePoints,
        activity,
        weeksActivity,
        shift
    } = req.body;

    try {
        if (!originalDiscordId) return res.redirect('/roster');

        const existingUser = await db.collection('users').findOne({ 'login.discordId': originalDiscordId });
        if (!existingUser) return res.redirect('/roster');

        if (discordId !== originalDiscordId) {
            const duplicateUser = await db.collection('users').findOne({ 'login.discordId': discordId });
            if (duplicateUser) return res.redirect('/roster');
        }

        const isPromotion = existingUser.accountType !== accountType;
        const nextLastPromotion = isPromotion
            ? new Date().toISOString().slice(0, 10)
            : (existingUser.lastPromotion || hireDate || null);

        const updateDoc = {
            $set: {
                'login.discordId': discordId,
                displayName,
                discordUser,
                accountType,
                hireDate,
                lastPromotion: nextLastPromotion,
                house,
                shift,
                housePoints,
                activity,
                weeksActivity
            }
        };

        if (password && password.trim()) {
            const hash = await bcrypt.hash(password.trim(), saltRounds);
            updateDoc.$set['login.password'] = hash;
        }

        await db.collection('users').updateOne(
            { 'login.discordId': originalDiscordId },
            updateDoc
        );

        res.redirect('/roster');
    } catch (error) {
        console.error('Error during user update:', error);
        res.redirect('/roster');
    }
});

// PROMOTE USER
app.post('/promote-user', requireDatabase, async (req, res) => {
    if (!req.session.loggedin) return res.redirect('/');

    const { discordId, accountType, effectiveDate, rankActionType } = req.body;

    try {
        const settings = await getSettings();
        const allowedRanks = settings.ranks.map((rank) => rank.name);

        if (!discordId || !allowedRanks.includes(accountType)) {
            return res.redirect('/roster');
        }

        const user = await db.collection('users').findOne({ 'login.discordId': discordId });
        if (!user) return res.redirect('/roster');

        if (user.accountType === accountType) {
            console.log(`No-op ${rankActionType || 'rank change'} for ${discordId}; rank unchanged.`);
            return res.redirect('/roster');
        }

        const promotionDate = effectiveDate || new Date().toISOString().slice(0, 10);

        await db.collection('users').updateOne(
            { 'login.discordId': discordId },
            {
                $set: {
                    accountType,
                    lastPromotion: promotionDate
                }
            }
        );

        if (req.session.currentuser === discordId) {
            req.session.accountType = accountType;
        }

        res.redirect('/roster');
    } catch (error) {
        console.error('Error during user promotion:', error);
        res.redirect('/roster');
    }
});

// ADD STRIKE
app.post('/add-strike', requireDatabase, async (req, res) => {
    if (!req.session.loggedin) return res.redirect('/');

    if (!MANAGEMENT_ROLES.includes(req.session.accountType)) {
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

    if (!MANAGEMENT_ROLES.includes(req.session.accountType)) {
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
        res.redirect('/roster');
    } catch (error) {
        console.error('Error removing strike:', error);
        res.redirect('/roster');
    }
});

// MARK WEEKLY MEETING ATTENDANCE FOR ALL USERS AT ONCE
app.post('/mark-attendance', requireDatabase, async (req, res) => {
    if (!req.session.loggedin) return res.redirect('/');

    if (!MANAGEMENT_ROLES.includes(req.session.accountType)) {
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
        res.redirect('/roster');
    } catch (error) {
        console.error('Error recording attendance:', error);
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

    if (!MANAGEMENT_ROLES.includes(req.session.accountType)) {
        req.flash('error_msg', 'You are not authorized to view reports.');
        return res.redirect('/dashboard');
    }

    try {
        const requestedWeek = /^\d{4}-\d{2}-\d{2}$/.test(req.query.week || '')
            ? getWeekStart(req.query.week)
            : getWeekStart(new Date());
        const weekStart = requestedWeek;
        const weekEnd = addDays(weekStart, 6);

        const users = await db.collection('users').find().toArray();

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
            if (!user.house) return;
            houseTotals[user.house] = (houseTotals[user.house] || 0) + (Number(user.housePoints) || 0);
        });

        const activitySummary = {
            active: users.filter((user) => user.activity === 'Active').length,
            semiActive: users.filter((user) => user.activity === 'Semi-Active').length,
            inactive: users.filter((user) => user.activity === 'Inactive').length,
            loa: users.filter((user) => user.activity === 'LOA').length
        };

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
            activitySummary
        });
    } catch (error) {
        console.error('Error generating weekly report:', error);
        res.status(500).send('Error generating weekly report.');
    }
});

// SETTINGS PAGE
app.get('/settings', requireDatabase, async (req, res) => {
    if (!req.session.loggedin) return res.redirect('/');

    if (!MANAGEMENT_ROLES.includes(req.session.accountType)) {
        req.flash('error_msg', 'You are not authorized to view settings.');
        return res.redirect('/dashboard');
    }

    try {
        const settings = await getSettings();
        res.render('pages/settings', { page: 'settings', settings });
    } catch (error) {
        console.error('Error loading settings:', error);
        res.status(500).send('Error loading settings.');
    }
});

// ADD SETTINGS OPTION
app.post('/settings/add-option', requireDatabase, async (req, res) => {
    if (!req.session.loggedin) return res.redirect('/');

    if (!MANAGEMENT_ROLES.includes(req.session.accountType)) {
        req.flash('error_msg', 'You are not authorized to manage settings.');
        return res.redirect('/settings');
    }

    const { category, name, color, order } = req.body;
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

    if (!MANAGEMENT_ROLES.includes(req.session.accountType)) {
        req.flash('error_msg', 'You are not authorized to manage settings.');
        return res.redirect('/settings');
    }

    const { category, originalName, name, color, order } = req.body;
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
        } else {
            updateFields[`${category}.$[item].color`] = color || '#242320';
        }

        await db.collection('settings').updateOne(
            { _id: 'appSettings' },
            { $set: updateFields },
            { arrayFilters: [{ 'item.name': originalName }] }
        );

        req.flash('success_msg', 'Option updated.');
        res.redirect('/settings');
    } catch (error) {
        console.error('Error updating settings option:', error);
        res.redirect('/settings');
    }
});

// DELETE SETTINGS OPTION
app.post('/settings/delete-option', requireDatabase, async (req, res) => {
    if (!req.session.loggedin) return res.redirect('/');

    if (!MANAGEMENT_ROLES.includes(req.session.accountType)) {
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

// DELETE USER
app.post('/deleteUser', requireDatabase, async (req, res) => {
    if (!req.session.loggedin) return res.redirect('/');

    const { discordId } = req.body;

    try {
        await db.collection('users').deleteOne({ 'login.discordId': discordId });
        res.redirect('/roster');
    } catch (error) {
        console.error('Error during user deletion:', error);
        res.redirect('/roster');
    }
});

// USER LOGIN
app.post('/login', requireDatabase, async (req, res) => {
    const { discordId, password } = req.body;

    try {
        const userDoc = await db.collection('users').findOne({ 'login.discordId': discordId });

        if (!userDoc) {
            req.flash('error_msg', 'Invalid Discord ID or password.');
            return res.redirect('/');
        }

        const isMatch = await bcrypt.compare(password, userDoc.login.password);

        if (!isMatch) {
            req.flash('error_msg', 'Invalid Discord ID or password.');
            return res.redirect('/');
        }

        req.session.loggedin = true;
        req.session.currentuser = discordId;
        req.session.accountType = userDoc.accountType;

        // Explicitly save the session before redirecting so the reverse proxy
        // does not receive the dashboard request before the session is stored.
        return req.session.save((error) => {
            if (error) {
                console.error('Session save error:', error);
                return res.status(500).send('Unable to create login session.');
            }

            res.redirect('/dashboard');
        });
    } catch (error) {
        console.error('Error during login:', error);
        req.flash('error_msg', 'Unable to log in right now. Please try again.');
        res.redirect('/');
    }
});

// USER LOGOUT
app.get('/logout', (req, res) => {
    req.session.destroy((error) => {
        if (error) {
            console.error('Logout session error:', error);
        }
        res.clearCookie('connect.sid');
        res.redirect('/');
    });
});

// DASHBOARD
app.get('/dashboard', requireDatabase, async (req, res) => {
    if (!req.session.loggedin) return res.redirect('/');

    try {
        const currentDiscordId = req.session.currentuser;
        const userDoc = await db.collection('users').findOne({ 'login.discordId': currentDiscordId });
        const currentDisplayName = userDoc?.displayName || currentDiscordId;
        const accountType = userDoc ? userDoc.accountType : null;

        const totalStrikes = (userDoc?.strikes || []).reduce((sum, strike) => sum + (Number(strike.count) || 0), 0);
        const pendingLoaCount = (userDoc?.loaRequests || []).filter((request) => request.status === 'Pending').length;
        const currentWeek = getWeekStart(new Date());
        const attendedThisWeek = (userDoc?.attendance || []).some((record) => record.week === currentWeek && record.attended);

        let staffSummary = null;
        let pendingLoaTotal = 0;

        if (MANAGEMENT_ROLES.includes(accountType)) {
            const allUsers = await db.collection('users').find({}, {
                projection: { activity: 1, loaRequests: 1 }
            }).toArray();

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
        }

        res.render('pages/dashboard', {
            page: 'dashboard',
            currentDisplayName,
            currentDiscordId,
            accountType,
            house: userDoc?.house || null,
            housePoints: userDoc?.housePoints ?? null,
            activity: userDoc?.activity || null,
            totalStrikes,
            pendingLoaCount,
            attendedThisWeek,
            staffSummary,
            pendingLoaTotal
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
        const user = await db.collection('users').findOne({ 'login.discordId': currentDiscordId });

        if (!user) return res.redirect('/logout');

        res.render('pages/account', {
            page: 'account',
            user
        });
    } catch (error) {
        console.error('Error loading account page:', error);
        res.status(500).send('Error loading account page.');
    }
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

        if (MANAGEMENT_ROLES.includes(req.session.accountType)) {
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
            pendingRequests
        });
    } catch (error) {
        console.error('Error loading LOA page:', error);
        res.status(500).send('Error loading LOA page.');
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

    if (!MANAGEMENT_ROLES.includes(req.session.accountType)) {
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

        req.flash('success_msg', `LOA request ${decision.toLowerCase()}.`);
        res.redirect('/loa');
    } catch (error) {
        console.error('Error reviewing LOA request:', error);
        res.redirect('/loa');
    }
});

// ROSTER
app.get('/roster', requireDatabase, async (req, res) => {
    if (!req.session.loggedin) return res.redirect('/');

    const totalUsers = await db.collection('users').countDocuments();
    try {
        const users = await db.collection('users').find().toArray();
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

            const attendanceRecord = (Array.isArray(user.attendance) ? user.attendance : [])
                .find((record) => record.week === currentWeek);

            return {
                ...user,
                timeInService: daysInService,
                timeInGrade: daysInGrade,
                attendedThisWeek: attendanceRecord ? attendanceRecord.attended : false
            };
        });

        usersWithService.sort((a, b) => {
            const rankA = rankOrder[normalizeRank(a.accountType)] ?? Number.MAX_SAFE_INTEGER;
            const rankB = rankOrder[normalizeRank(b.accountType)] ?? Number.MAX_SAFE_INTEGER;

            if (rankA !== rankB) return rankA - rankB;

            const nameA = (a.displayName || a.discordUser || a.login?.discordId || '').toString();
            const nameB = (b.displayName || b.discordUser || b.login?.discordId || '').toString();
            return nameA.localeCompare(nameB);
        });

        res.render('pages/roster', {
            page: 'roster',
            users: usersWithService,
            totalUsers,
            activeUsers,
            inactiveUsers,
            semiActiveUsers,
            loaUsers,
            currentWeek,
            settings,
            houseColorMap,
            shiftColorMap,
            activityColorMap
        });
    } catch (error) {
        console.error('Error fetching users:', error);
        res.status(500).send('Error fetching users.');
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
httpServer = app.listen(PORT, '0.0.0.0', () => {
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