'use strict';
const express  = require('express');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const crypto   = require('crypto');
const { pool } = require('../database');
const { requireAuth } = require('./auth');
const asyncHandler = require('../lib/asyncHandler');
const mailer   = require('../mailer');
const {
  isUserLockedOut,
  recordFailedAttempt,
  clearAttempts,
  sanitizeText,
  sanitizeEmail,
  sanitizePhone,
  validatePassword,
} = require('../security');

const router = express.Router();
const SECRET = process.env.JWT_SECRET;

// ── requireUser middleware (user JWT) ─────────────────────────────────────────
function requireUser(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized — user token required' });
  }
  try {
    req.user = jwt.verify(auth.slice(7), SECRET);
    if (req.user.role !== 'user') return res.status(403).json({ error: 'Forbidden' });
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ── Email OTP helpers ─────────────────────────────────────────────────────────
const OTP_TTL_MS = 10 * 60 * 1000;   // codes are valid for 10 minutes
const OTP_MAX_ATTEMPTS = 5;          // wrong guesses allowed before a code is burned

function generateOtp() {
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const hash = crypto.createHash('sha256').update(code).digest('hex');
  return { code, hash, expires: Date.now() + OTP_TTL_MS };
}
function hashOtp(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}

// ── Register ──────────────────────────────────────────────────────────────────
// Creates the account in an UNVERIFIED state and emails a 6-digit OTP. No login
// token is issued until the user confirms the code via /verify-otp.
router.post('/register', asyncHandler(async (req, res) => {
  const first_name = sanitizeText(req.body.first_name, 100);
  const last_name  = sanitizeText(req.body.last_name,  100);
  const email      = sanitizeEmail(req.body.email);
  const phone      = sanitizePhone(req.body.phone);
  const password   = req.body.password;
  const plan       = sanitizeText(req.body.plan, 100);

  if (!first_name || !last_name) return res.status(400).json({ error: 'First name and last name are required' });
  if (!email) return res.status(400).json({ error: 'A valid email address is required' });

  const pwErr = validatePassword(password);
  if (pwErr) return res.status(400).json({ error: pwErr });

  const [existing] = await pool.query('SELECT id, email_verified FROM users WHERE email = ?', [email]);
  if (existing.length) {
    // Allow a stalled, never-verified signup to restart cleanly.
    if (existing[0].email_verified === 0 || existing[0].email_verified === false) {
      const otp = generateOtp();
      await pool.query(
        'UPDATE users SET first_name = ?, last_name = ?, phone = ?, password = ?, plan = ?, otp_hash = ?, otp_expires = ?, otp_attempts = 0 WHERE id = ?',
        [first_name, last_name, phone, bcrypt.hashSync(password, 12), plan, otp.hash, otp.expires, existing[0].id]
      );
      mailer.sendOtp({ first_name, email, code: otp.code }).catch(() => {});
      return res.json({ needsVerification: true, email });
    }
    return res.status(409).json({ error: 'An account with this email already exists' });
  }

  const hash = bcrypt.hashSync(password, 12);
  const otp = generateOtp();
  await pool.query(
    'INSERT INTO users (first_name, last_name, email, phone, password, plan, email_verified, otp_hash, otp_expires, otp_attempts) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [first_name, last_name, email, phone, hash, plan, 0, otp.hash, otp.expires, 0]
  );

  mailer.sendOtp({ first_name, email, code: otp.code }).catch(() => {});
  res.json({ needsVerification: true, email });
}));

// ── Verify email OTP ────────────────────────────────────────────────────────
// Confirms the code, activates the account, sends the welcome email and logs in.
router.post('/verify-otp', asyncHandler(async (req, res) => {
  const email = sanitizeEmail(req.body.email);
  const code  = String(req.body.code || '').trim();
  if (!email || !/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Enter the 6-digit code sent to your email' });

  const [rows] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
  const user = rows[0];
  if (!user) return res.status(400).json({ error: 'Invalid or expired code. Please request a new one.' });
  if (user.email_verified === 1 || user.email_verified === true) {
    return res.status(400).json({ error: 'This account is already verified. Please log in.' });
  }
  if (!user.otp_hash || !user.otp_expires || Number(user.otp_expires) < Date.now()) {
    return res.status(400).json({ error: 'Your code has expired. Please request a new one.' });
  }
  if (Number(user.otp_attempts) >= OTP_MAX_ATTEMPTS) {
    return res.status(429).json({ error: 'Too many incorrect attempts. Please request a new code.' });
  }
  if (hashOtp(code) !== user.otp_hash) {
    await pool.query('UPDATE users SET otp_attempts = otp_attempts + 1 WHERE id = ?', [user.id]);
    return res.status(400).json({ error: 'Incorrect code. Please try again.' });
  }

  await pool.query(
    'UPDATE users SET email_verified = 1, otp_hash = NULL, otp_expires = NULL, otp_attempts = 0 WHERE id = ?',
    [user.id]
  );
  mailer.welcomeUser({ first_name: user.first_name, email: user.email, plan: user.plan }).catch(() => {});

  const token = jwt.sign(
    { id: user.id, email: user.email, first_name: user.first_name, last_name: user.last_name, role: 'user' },
    SECRET, { expiresIn: '7d' }
  );
  const { password: _p, otp_hash: _h, otp_expires: _e, otp_attempts: _a, ...safeUser } = user;
  res.json({ token, user: { ...safeUser, email_verified: 1 } });
}));

// ── Resend OTP ────────────────────────────────────────────────────────────────
router.post('/resend-otp', asyncHandler(async (req, res) => {
  const email = sanitizeEmail(req.body.email);
  if (!email) return res.status(400).json({ error: 'A valid email address is required' });

  const [rows] = await pool.query('SELECT id, first_name, email_verified FROM users WHERE email = ?', [email]);
  const user = rows[0];
  // Always respond the same way so we don't reveal which emails are registered.
  if (user && (user.email_verified === 0 || user.email_verified === false)) {
    const otp = generateOtp();
    await pool.query('UPDATE users SET otp_hash = ?, otp_expires = ?, otp_attempts = 0 WHERE id = ?', [otp.hash, otp.expires, user.id]);
    mailer.sendOtp({ first_name: user.first_name, email, code: otp.code }).catch(() => {});
  }
  res.json({ success: true, message: 'If your account still needs verification, a new code has been sent.' });
}));

// ── Login ─────────────────────────────────────────────────────────────────────
router.post('/login', asyncHandler(async (req, res) => {
  const email    = sanitizeEmail(req.body.email);
  const password = req.body.password;

  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

  const identifier = 'user:' + email;
  if (isUserLockedOut(email)) {
    return res.status(429).json({
      error: 'Account temporarily locked after too many failed attempts. Please try again in 15 minutes.',
    });
  }

  const ip = req.ip || req.connection.remoteAddress;
  const [rows] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
  const user = rows[0];

  if (!user || !bcrypt.compareSync(password, user.password)) {
    recordFailedAttempt(identifier, ip);
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  // Block accounts that registered but never confirmed their email OTP.
  if (user.email_verified === 0 || user.email_verified === false) {
    const otp = generateOtp();
    await pool.query('UPDATE users SET otp_hash = ?, otp_expires = ?, otp_attempts = 0 WHERE id = ?', [otp.hash, otp.expires, user.id]);
    mailer.sendOtp({ first_name: user.first_name, email, code: otp.code }).catch(() => {});
    return res.status(403).json({ needsVerification: true, email, error: 'Please verify your email. We just sent you a new code.' });
  }

  clearAttempts(identifier);
  const token = jwt.sign(
    { id: user.id, email: user.email, first_name: user.first_name, last_name: user.last_name, role: 'user' },
    SECRET, { expiresIn: '7d' }
  );
  const { password: _, ...safeUser } = user;
  res.json({ token, user: safeUser });
}));

// ── Google OAuth ──────────────────────────────────────────────────────────────
// Keeps its own try/catch — custom failure message on error.
router.post('/google', async (req, res) => {
  const { credential } = req.body;
  if (!credential) return res.status(400).json({ error: 'No Google credential provided' });

  try {
    const gRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${credential}`);
    const info = await gRes.json();
    if (!gRes.ok || info.error) return res.status(401).json({ error: 'Invalid Google token' });

    const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
    if (GOOGLE_CLIENT_ID && info.aud !== GOOGLE_CLIENT_ID) {
      return res.status(401).json({ error: 'Token audience mismatch' });
    }

    const email      = sanitizeEmail(info.email);
    const first_name = sanitizeText(info.given_name  || 'User', 100);
    const last_name  = sanitizeText(info.family_name || '',      100);
    if (!email) return res.status(400).json({ error: 'Google account has no valid email' });

    let [rows] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
    let user  = rows[0];
    let isNew = false;

    if (!user) {
      isNew      = true;
      const hash = bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 12);
      const [insResult] = await pool.query(
        'INSERT INTO users (first_name, last_name, email, password, email_verified) VALUES (?,?,?,?,?)',
        [first_name, last_name, email, hash, 1]
      );
      const [r2] = await pool.query('SELECT * FROM users WHERE id = ?', [insResult.insertId]);
      user = r2[0];
      mailer.welcomeUser({ first_name, email, plan: null }).catch(() => {});
    }

    const { password: _, ...safeUser } = user;
    const token = jwt.sign(
      { id: user.id, email: user.email, first_name: user.first_name, last_name: user.last_name, role: 'user' },
      SECRET, { expiresIn: '7d' }
    );
    res.json({ token, user: safeUser, isNew });
  } catch (err) {
    console.error('[auth] Google OAuth error:', err.message);
    res.status(500).json({ error: 'Google authentication failed. Please try again.' });
  }
});

// ── Forgot password ───────────────────────────────────────────────────────────
// Keeps its own try/catch — always returns the same success message (no info leak).
router.post('/forgot-password', async (req, res) => {
  const email = sanitizeEmail(req.body.email);
  const MSG   = 'If that email is registered, a reset link has been sent. Check your inbox (and spam folder).';
  if (!email) return res.json({ success: true, message: MSG });

  try {
    const [rows] = await pool.query('SELECT id, first_name, email FROM users WHERE email = ?', [email]);
    const user = rows[0];
    if (user) {
      const token     = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
      await pool.query('DELETE FROM password_reset_tokens WHERE user_id = ?', [user.id]);
      await pool.query(
        'INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES (?,?,?)',
        [user.id, token, expiresAt]
      );
      mailer.sendPasswordReset({ first_name: user.first_name, email: user.email, token }).catch(() => {});
    }
    res.json({ success: true, message: MSG });
  } catch (err) {
    console.error('[users/forgot-password]', err.message);
    res.json({ success: true, message: MSG }); // Don't leak errors
  }
});

// ── Reset password ────────────────────────────────────────────────────────────
router.post('/reset-password', asyncHandler(async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) {
    return res.status(400).json({ error: 'Reset token and new password are required' });
  }

  const pwErr = validatePassword(password);
  if (pwErr) return res.status(400).json({ error: pwErr });

  const [rows] = await pool.query(
    'SELECT * FROM password_reset_tokens WHERE token = ? AND used = 0',
    [token]
  );
  const record = rows[0];

  if (!record || new Date(record.expires_at) < new Date()) {
    return res.status(400).json({ error: 'This reset link is invalid or has expired. Please request a new one.' });
  }

  const hash = bcrypt.hashSync(password, 12);
  await pool.query('UPDATE users SET password = ? WHERE id = ?', [hash, record.user_id]);
  await pool.query('UPDATE password_reset_tokens SET used = 1 WHERE id = ?', [record.id]);
  res.json({ success: true, message: 'Password updated successfully. You can now log in.' });
}));

// ── Get own profile ───────────────────────────────────────────────────────────
router.get('/me', requireUser, asyncHandler(async (req, res) => {
  const [uRows] = await pool.query(
    'SELECT id, first_name, last_name, email, phone, plan, payment_status, approved, approved_at, created_at FROM users WHERE id = ?',
    [req.user.id]
  );
  if (!uRows[0]) return res.status(404).json({ error: 'User not found' });
  const [pRows] = await pool.query(
    'SELECT * FROM payments WHERE user_id = ? ORDER BY created_at DESC LIMIT 1',
    [req.user.id]
  );
  res.json({ user: uRows[0], lastPayment: pRows[0] || null });
}));

// ── Admin: list all users ─────────────────────────────────────────────────────
router.get('/', requireAuth, asyncHandler(async (req, res) => {
  const [rows] = await pool.query(
    'SELECT id, first_name, last_name, email, phone, plan, payment_status, approved, created_at FROM users ORDER BY created_at DESC'
  );
  res.json({ users: rows });
}));

// ── Admin: update user plan / status ─────────────────────────────────────────
router.patch('/:id', requireAuth, asyncHandler(async (req, res) => {
  const { plan, payment_status, approved } = req.body;
  const cleanPlan = sanitizeText(plan, 100);
  await pool.query(
    `UPDATE users SET
      plan           = COALESCE(?, plan),
      payment_status = COALESCE(?, payment_status),
      approved       = COALESCE(?, approved)
     WHERE id = ?`,
    [cleanPlan || null, payment_status ?? null, approved !== undefined ? Number(approved) : null, req.params.id]
  );
  res.json({ success: true });
}));

// ── Admin: delete user ────────────────────────────────────────────────────────
router.delete('/:id', requireAuth, asyncHandler(async (req, res) => {
  await pool.query('DELETE FROM users WHERE id = ?', [req.params.id]);
  res.json({ success: true });
}));

module.exports = { router, requireUser };
