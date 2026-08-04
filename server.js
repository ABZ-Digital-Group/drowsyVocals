require('dotenv').config();
const path = require('path');

process.on('uncaughtException', (e) => console.error('uncaughtException', e));
process.on('unhandledRejection', (e) => console.error('unhandledRejection', e));

// LOAD NPM PACKAGES
const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const nodemailer = require('nodemailer');
const fetch = require('node-fetch');

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

// --- ROUTES ---
app.get('/', (req, res) => res.render('pages/index'));
app.get('/martial-arts', (req, res) => res.render('pages/martial-arts'));
app.get('/online-coaching', (req, res) => res.render('pages/online-coaching'));
app.get('/contact', (req, res) => res.render('pages/contact'));

const PORT = process.env.PORT;
app.listen(PORT, '0.0.0.0', () => console.log('Listening on', PORT));