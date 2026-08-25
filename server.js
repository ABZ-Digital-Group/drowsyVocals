// BCRYPT SETUP
const bcrypt = require('bcrypt');
const saltRounds = 10;
// const PORT = 3000;

require('dotenv').config();
const path = require('path');

process.on('uncaughtException', (e) => console.error('uncaughtException', e));
process.on('unhandledRejection', (e) => console.error('unhandledRejection', e));

// LOAD NPM PACKAGES
const express = require('express');
const session = require('express-session');
const nodemailer = require('nodemailer');
const flash = require('connect-flash');

const app = express();

// --- APP CONFIG (PATH-AWARE) ---
// This tells Express exactly where your folders are located relative to this file
app.use(session({ 
    secret: 'example', 
    resave: false, 
    saveUninitialized: true 
}));

// Serves CSS, JS, and Images from the public folder
app.use(express.static(path.join(__dirname, 'public')));

// Tells Express to look in the /views folder for your EJS files
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

// MIDDLEWARE
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(flash());

// Global Middleware to pass session data to all templates
app.use((req, res, next) => {
    res.locals.success_msg = req.flash('success_msg');
    res.locals.error_msg = req.flash('error_msg');
    res.locals.loggedin = req.session.loggedin;
    res.locals.currentuser = req.session.currentuser;
    res.locals.userType = req.session.accountType;
    next();
});

// CONNECT TO MONGO
const { MongoClient, ObjectId } = require('mongodb');
const url = 'mongodb://82.29.191.177:27017';
const client = new MongoClient(url);
const dbname = 'drowsyDB';

// --- DATABASE CONNECTION ---
let db;
connectDB();
async function connectDB(){
    await client.connect();
    console.log('✅ Connected Successfully to Server');
    db = client.db(dbname);
    app.listen(process.env.PORT, '0.0.0.0', () => {
        console.log(`✅ Drowsy Vocals server listening on Port: ${process.env.PORT}`);
    });
};

// --- EMAIL ROUTE ---
// app.post('/send-email', async (req, res) => {
//     const { name, email, dob, tel, subject, message } = req.body;

//     const transporter = nodemailer.createTransport({
//         host: process.env.SMTP_HOST,
//         port: process.env.SMTP_PORT,
//         secure: true, 
//         auth: {
//             user: process.env.SMTP_USER,
//             pass: process.env.SMTP_PASS
//         }
//     });

//     try {
//         await transporter.sendMail({
//             from: `"${name}" <${process.env.EMAIL_FROM}>`, 
//             replyTo: email, 
//             to: process.env.EMAIL_TO,
//             subject: `🔥 New Inquiry: ${subject}`,
//             html: `
//             <div style="background-color: #f9f9f9; padding: 20px; font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;">
//                 <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
                    
//                     <div style="background-color: #1a1a1a; padding: 30px; text-align: center;">
//                         <img src="cid:logo" alt="Dawid Kostecki Logo" style="width: 180px; height: auto;">
//                     </div>

//                     <div style="padding: 40px; color: #333333; line-height: 1.6;">
//                         <h2 style="margin-top: 0; color: #1a1a1a; border-bottom: 2px solid #eeeeee; padding-bottom: 10px;">New Website Inquiry</h2>
                        
//                         <p style="margin-bottom: 10px;"><strong>From:</strong> ${name}</p>
//                         <p style="margin-bottom: 10px;"><strong>DOB:</strong> ${dob}</p>
//                         <p style="margin-bottom: 10px;"><strong>Tel:</strong> ${tel}</p>
//                         <p style="margin-bottom: 25px;"><strong>Email:</strong> <a href="mailto:${email}" style="color: #007bff; text-decoration: none;">${email}</a></p>
                        
//                         <div style="background-color: #f8f9fa; border-left: 4px solid #1a1a1a; padding: 20px; font-style: italic; color: #555555;">
//                             "${message}"
//                         </div>
//                     </div>

//                     <div style="background-color: #f1f1f1; padding: 20px; text-align: center; font-size: 12px; color: #777777;">
//                         <p style="margin: 0;">This email was sent from the contact form at DawidKostecki.com</p>
//                         <p style="margin: 5px 0 0;">&copy; 2026 Dawid Kostecki Personal Trainer</p>
//                         <p style="margin: 5px 0 0;">Service by ABZ DIGITAL GROUP</p>
//                     </div>
//                 </div>
//                 <div style="text-align: center; max-width: 250px; margin: 0 auto; padding-top: 15px;">
//                     <div style="height: 3px; background-color: #D0021B; margin-bottom: 10px; width: 60px; display: inline-block;"></div>
                    
//                     <a href="https://abzdigitalgroup.com" target="_blank" style="text-decoration: none; display: block; background-color: #161616; padding: 20px; border-radius: 8px;">
//                         <img src="cid:abzLogo" 
//                             alt="ABZ Digital Group" 
//                             width="160" 
//                             style="display: block; margin: 0 auto; border: 0;">
//                     </a>
//                     <p style="margin-top: 10px; font-family: Arial, sans-serif; font-size: 11px; color: #D0021B; text-transform: uppercase; letter-spacing: 2px; font-weight: bold;">
//                         Provided By
//                     </p>
//                 </div>
//             </div>
//             `,
//             attachments: [{
//                 filename: 'logo.png',
//                 path: path.join(__dirname, 'public', 'assets', 'DawidKosteckiLogo.png'),
//                 cid: 'logo' 
//             },{
//                 filename: 'abzLogo.png',
//                 path: path.join(__dirname, 'public', 'assets', 'ABZ_Digital_Group_Logo.png'),
//                 cid: 'abzLogo' 
//             }]
//         });

//         res.status(200).json({ status: 'success', message: 'Message sent!' });
//     } catch (error) {
//         console.error('SMTP ERROR:', error);
//         res.status(500).json({ status: 'error', message: 'Error sending email.' });
//     }
// });




// =================================================================
// --- FORM SUBMISSION & API ROUTES ---
// =================================================================

// USER SIGN-UP
    app.post('/signUp', async (req, res) => {
        const { username, discordId, password, accountType } = req.body;
        try {
            const existingUser = await db.collection('users').findOne({ "login.discordId": discordId });
            if (existingUser) {
                req.flash('error_msg', 'User Already Exists.');
                return res.redirect('/users');
            }

            const hash = await bcrypt.hash(password, saltRounds);
            const newUser = {
                login: { "discordId": discordId, password: hash },
                accountType,
                created: new Date().toISOString().slice(0, 19)
            };
            await db.collection('users').insertOne(newUser);
            req.flash('success_msg', 'User created successfully!');
            res.redirect('/');
        } catch (err) {
            console.error("❌ Error during sign-up:", err);
            res.redirect('/users');
        }
    });

//Add User
app.post('/add-user', async (req, res) => {
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
        const existingUser = await db.collection('users').findOne({ "login.discordId": discordId });
        if (existingUser) {
            console.log('error_msg', 'User Already Exists.');
            return res.redirect('/roster');
        }

        const hash = await bcrypt.hash(password, saltRounds);
        const newUser = {
            login: { "discordId": discordId, password: hash },
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
        console.log('success_msg', 'User added successfully!');
        res.redirect('/roster');
    } catch (err) {
        console.log("❌ Error during adding user:", err);
        res.redirect('/roster');
    }
});

app.post('/update-user', async (req, res) => {
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
        if (!originalDiscordId) {
            return res.redirect('/roster');
        }

        const existingUser = await db.collection('users').findOne({ "login.discordId": originalDiscordId });
        if (!existingUser) {
            return res.redirect('/roster');
        }

        if (discordId !== originalDiscordId) {
            const duplicateUser = await db.collection('users').findOne({ "login.discordId": discordId });
            if (duplicateUser) {
                console.log('error_msg', 'Discord ID is already in use.');
                return res.redirect('/roster');
            }
        }

        const isPromotion = existingUser.accountType !== accountType;
        const nextLastPromotion = isPromotion
            ? new Date().toISOString().slice(0, 10)
            : (existingUser.lastPromotion || hireDate || null);

        const updateDoc = {
            $set: {
                "login.discordId": discordId,
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
            updateDoc.$set["login.password"] = hash;
        }

        await db.collection('users').updateOne(
            { "login.discordId": originalDiscordId },
            updateDoc
        );

        res.redirect('/roster');
    } catch (err) {
        console.error("❌ Error during user update:", err);
        res.redirect('/roster');
    }
});

app.post('/promote-user', async (req, res) => {
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

        const user = await db.collection('users').findOne({ "login.discordId": discordId });
        if (!user) {
            return res.redirect('/roster');
        }

        if (user.accountType === accountType) {
            console.log('info', `No-op ${rankActionType || 'rank change'} for ${discordId}; rank unchanged.`);
            return res.redirect('/roster');
        }

        const promotionDate = effectiveDate || new Date().toISOString().slice(0, 10);

        await db.collection('users').updateOne(
            { "login.discordId": discordId },
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
    } catch (err) {
        console.error("❌ Error during user promotion:", err);
        res.redirect('/roster');
    }
});

app.post('/deleteUser', async (req, res) => {
    if (!req.session.loggedin) return res.redirect('/');
    const { discordId } = req.body;
    try {
        await db.collection('users').deleteOne({ "login.discordId": discordId });
        res.redirect('/roster');
    } catch (err) {
        console.error("Error during user deletion:", err);
        res.redirect('/roster');
    }
});


// USER LOGIN
app.post('/login', async (req, res) => {
    const { discordId, password } = req.body;
    try {
        const userDoc = await db.collection('users').findOne({ "login.discordId": discordId });
        if (!userDoc) {
            console.log('No User Found');
            return res.redirect('/');
        }

        const isMatch = await bcrypt.compare(password, userDoc.login.password);
        if (isMatch) {
            req.session.loggedin = true;
            req.session.currentuser = discordId;
            req.session.accountType = userDoc.accountType;
            console.log(`✅ User ${discordId} logged in with account type: ${userDoc.accountType}`);
            res.redirect('/dashboard');
        } else {
            console.log('Password does not match.');
            res.redirect('/');
        }
    } catch (err) {
        console.error("❌ Error during login:", err);
        res.redirect('/');
    }
});

// USER LOGOUT
app.get('/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/');
    });
});

// --- ROUTES ---
app.get('/', (req, res) => res.render('pages/index'));


app.get('/dashboard', async (req, res) => {
    if (!req.session.loggedin) return res.redirect('/');
    const currentDiscordId = req.session.currentuser;
    const userDoc = await db.collection('users').findOne({ "login.discordId": currentDiscordId });
    const currentDisplayName = userDoc?.displayName || currentDiscordId;
    const accountType = userDoc ? userDoc.accountType : null;

    res.render('pages/dashboard',{
        
        page: 'dashboard',
        currentDisplayName,
        currentDiscordId,
        accountType
    });
});


app.get('/roster', async (req, res) => {
    if (!req.session.loggedin) return res.redirect('/');
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
                timeInGrade: daysInGrade
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
    } catch (err) {
        console.error("❌ Error fetching users:", err);
        res.status(500).send("Error fetching users.");
    }
        //res.render('pages/roster');
});
