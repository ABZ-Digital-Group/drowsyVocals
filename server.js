// BCRYPT SETUP
const bcrypt = require('bcrypt');
const saltRounds = 10;

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
    const allowedRanks = [
        'Mr. Sandman',
        'Realm God',
        'Dreamy Defender',
        'Dreamland Guard',
        'Nighty Knights',
        'Tired Esquire'
    ];

    try {
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

        res.render('pages/dashboard', {
            page: 'dashboard',
            currentDisplayName,
            currentDiscordId,
            accountType
        });
    } catch (error) {
        console.error('Error loading dashboard:', error);
        res.status(500).send('Error loading dashboard.');
    }
});

// ROSTER
app.get('/roster', requireDatabase, async (req, res) => {
    if (!req.session.loggedin) return res.redirect('/');

    const totalUsers = await db.collection('users').countDocuments();
    try {
        const users = await db.collection('users').find().toArray();

        const rankOrder = {
            'mr sandman': 0,
            'realm god': 1,
            'realm gods': 1,
            'drowsy defender': 2,
            'drowsy defenders': 2,
            'dreamy defender': 2,
            'dreamland guard': 3,
            'nighty knight': 4,
            'nighty knights': 4,
            'tired esquire': 5
        };

        const normalizeRank = (rank) => (rank || '')
            .toString()
            .toLowerCase()
            .replace(/\./g, '')
            .trim();

        const msPerDay = 1000 * 60 * 60 * 24;
        const today = new Date();

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

            return {
                ...user,
                timeInService: daysInService,
                timeInGrade: daysInGrade,
                totalUsers: totalUsers
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
            users: usersWithService
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