'use strict';
const express  = require('express');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const crypto   = require('crypto');
const { pool } = require('../database');
const { requireAuth } = require('./auth');
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

// ── Register ──────────────────────────────────────────────────────────────────
router.post('/register', async (req, res) => {
  try {
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

    const [existing] = await pool.query('SELECT id FROM users WHERE email = ?', [email]);
    if (existing.length) return res.status(409).json({ error: 'An account with this email already exists' });

    const hash = bcrypt.hashSync(password, 12);
    const [result] = await pool.query(
      'INSERT INTO users (first_name, last_name, email, phone, password, plan) VALUES (?,?,?,?,?,?)',
      [first_name, last_name, email, phone, hash, plan]
    );
    const newId = result.insertId;

    const token = jwt.sign(
      { id: newId, email, first_name, last_name, role: 'user' },
      SECRET, { expiresIn: '7d' }
    );
    mailer.welcomeUser({ first_name, email, plan }).catch(() => {});
    res.json({
      token,
      user: { id: newId, first_name, last_name, email, plan, payment_status: 'unpaid', approved: 0 },
    });
  } catch (err) {
    console.error('[users/register]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Login ─────────────────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
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

    clearAttempts(identifier);
    const token = jwt.sign(
      { id: user.id, email: user.email, first_name: user.first_name, last_name: user.last_name, role: 'user' },
      SECRET, { expiresIn: '7d' }
    );
    const { password: _, ...safeUser } = user;
    res.json({ token, user: safeUser });
  } catch (err) {
    console.error('[users/login]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Google OAuth ──────────────────────────────────────────────────────────────
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
        'INSERT INTO users (first_name, last_name, email, password) VALUES (?,?,?,?)',
        [first_name, last_name, email, hash]
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
router.post('/reset-password', async (req, res) => {
  try {
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
  } catch (err) {
    console.error('[users/reset-password]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Get own profile ───────────────────────────────────────────────────────────
router.get('/me', requireUser, async (req, res) => {
  try {
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
  } catch (err) {
    console.error('[users/me]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Admin: list all users ─────────────────────────────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, first_name, last_name, email, phone, plan, payment_status, approved, created_at FROM users ORDER BY created_at DESC'
    );
    res.json({ users: rows });
  } catch (err) {
    console.error('[users/list]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Admin: update user plan / status ─────────────────────────────────────────
router.patch('/:id', requireAuth, async (req, res) => {
  try {
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
  } catch (err) {
    console.error('[users/patch]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Admin: delete user ────────────────────────────────────────────────────────
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM users WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('[users/delete]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = { router, requireUser };
