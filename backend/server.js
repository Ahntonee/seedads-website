require('dotenv').config();
'use strict';

// ── Validate critical env vars before anything else ──────────────────────────
if (!process.env.JWT_SECRET) {
  console.error('[FATAL] JWT_SECRET is not set in .env — refusing to start.');
  console.error('        Copy backend/.env.example to backend/.env and fill in your values.');
  process.exit(1);
}

const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const path       = require('path');
const fs         = require('fs');
const jwt        = require('jsonwebtoken');
const rateLimit  = require('express-rate-limit');
const { pruneAttempts } = require('./security');

const { router: authRouter }    = require('./routes/auth');
const contactsRouter            = require('./routes/contacts');
const leadsRouter               = require('./routes/leads');
const blogRouter                = require('./routes/blog');
const analyticsRouter           = require('./routes/analytics');
const { router: usersRouter }   = require('./routes/users');
const paymentsRouter            = require('./routes/payments');
const settingsRouter            = require('./routes/settings');
const dmiRouter                 = require('./routes/dmi');
const cmsRouter                 = require('./routes/cms');

const app    = express();
const PORT   = process.env.PORT   || 3002;
const SECRET = process.env.JWT_SECRET;

// ── CORS ─────────────────────────────────────────────────────────────────────
// Frontend and backend run on the same origin, so CORS is mainly for
// dev environments. Lock it down to the production domain in production.
const SITE_URL = (process.env.SITE_URL || '').replace(/\/$/, '');
const allowedOrigins = [
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
  ...(SITE_URL ? [SITE_URL] : []),
];

// ── Security headers (helmet) ─────────────────────────────────────────────────
app.use(helmet({
  // Allow inline scripts/styles the site already uses (Font Awesome CDN, Google Fonts, GSI)
  contentSecurityPolicy: false,   // Too strict without fine-tuning; client can enable later
  crossOriginEmbedderPolicy: false,
}));

app.use(cors({
  origin: (origin, cb) => {
    // Allow same-origin requests (no Origin header) and localhost in dev
    if (!origin) return cb(null, true);
    if (allowedOrigins.some(o => origin === o || origin.startsWith(o))) return cb(null, true);
    // In development (no SITE_URL set), allow all origins
    if (!SITE_URL) return cb(null, true);
    cb(Object.assign(new Error('CORS: origin not allowed — ' + origin), { status: 403 }));
  },
  credentials: true,
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: false, limit: '10mb' }));

// ── Rate limiting ─────────────────────────────────────────────────────────────
// General API limit (generous for normal usage)
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again in 15 minutes.' },
  skip: (req) => req.path === '/api/health',
});

// Auth endpoints — tight limit to prevent brute-force
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please wait 15 minutes before trying again.' },
});

// Contact/lead forms — anti-spam
const formLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,  // 1 hour
  max: 6,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many form submissions. Please try again in an hour.' },
});

app.use('/api/', apiLimiter);
app.use('/api/auth/login', authLimiter);
app.use('/api/users/login', authLimiter);
app.use('/api/users/register', authLimiter);
app.use('/api/users/forgot-password', authLimiter);
app.use('/api/users/reset-password', authLimiter);
app.use('/api/contacts', formLimiter);
app.use('/api/leads', formLimiter);

// ── Protected DMI file serving ────────────────────────────────────────────────
// DMI files are paid content — block direct unauthenticated access.
// Frontend must use /api/dmi/download/:filename (which validates auth + plan).
app.use('/uploads/dmi', (req, res) => {
  return res.status(403).json({ error: 'Direct access to DMI files is not allowed. Use the authenticated download endpoint.' });
});

// Receipts are served statically (randomized timestamps in filenames, admin only views them)
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ── Serve the website ─────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '..')));

// ── API Routes ────────────────────────────────────────────────────────────────
app.use('/api/auth',     authRouter);
app.use('/api/contacts', contactsRouter);
app.use('/api/leads',    leadsRouter);
app.use('/api/blog',     blogRouter);
app.use('/api/analytics',analyticsRouter);
app.use('/api/users',    usersRouter);
app.use('/api/payments', paymentsRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/dmi',      dmiRouter);
app.use('/api/cms',      cmsRouter);

app.get('/api/health', (_, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// ── 404 handler ───────────────────────────────────────────────────────────────
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Endpoint not found' });
  }
  const page404 = path.join(__dirname, '..', '404.html');
  if (fs.existsSync(page404)) return res.status(404).sendFile(page404);
  res.status(404).send('<h1>404 &mdash; Page Not Found</h1>');
});

// ── Global error handler ──────────────────────────────────────────────────────
// Must have 4 params so Express recognises it as an error handler
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // Multer errors (file upload validation)
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'File too large' });
  }
  if (err.message && err.message.startsWith('Only ')) {
    return res.status(400).json({ error: err.message });
  }
  // JSON parse errors
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON in request body' });
  }
  // CORS errors
  if (err.message && err.message.startsWith('CORS')) {
    return res.status(403).json({ error: err.message });
  }

  // Unexpected errors — log server-side, don't expose internals to client
  console.error('[ERROR]', new Date().toISOString(), req.method, req.path, err.message);

  if (req.path.startsWith('/api/')) {
    return res.status(err.status || 500).json({ error: 'Internal server error' });
  }
  res.status(500).send('<h1>500 &mdash; Server Error</h1><p>Something went wrong. Please try again.</p>');
});

// ── Start server ──────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('  SeedsAds Server');
  console.log('  http://localhost:' + PORT);
  console.log('  Admin:  /admin/login.html');
  console.log('  Client: /user/login.html');
  console.log('');
});

// Prune stale login attempt records every hour
setInterval(pruneAttempts, 60 * 60 * 1000);
