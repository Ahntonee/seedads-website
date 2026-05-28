'use strict';
const express  = require('express');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const { pool } = require('../database');
const {
  isAdminLockedOut,
  recordFailedAttempt,
  clearAttempts,
  sanitizeText,
  validatePassword,
} = require('../security');

const router = express.Router();
const SECRET = process.env.JWT_SECRET;

// ── Admin login ───────────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const username = sanitizeText(req.body.username, 100);
    const password = req.body.password;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    if (isAdminLockedOut(username)) {
      return res.status(429).json({
        error: 'Account temporarily locked after too many failed attempts. Please try again in 30 minutes.',
      });
    }

    const ip         = req.ip || req.connection.remoteAddress;
    const identifier = 'admin:' + username.toLowerCase();
    const [rows]     = await pool.query('SELECT * FROM admins WHERE username = ?', [username]);
    const admin      = rows[0];

    if (!admin || !bcrypt.compareSync(password, admin.password)) {
      recordFailedAttempt(identifier, ip);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    clearAttempts(identifier);
    const token = jwt.sign(
      { id: admin.id, username: admin.username, name: admin.name },
      SECRET,
      { expiresIn: '24h' }
    );
    res.json({ token, name: admin.name });
  } catch (err) {
    console.error('[auth/login]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Admin change password ─────────────────────────────────────────────────────
router.post('/change-password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    const err = validatePassword(newPassword);
    if (err) return res.status(400).json({ error: err });

    const [rows] = await pool.query('SELECT * FROM admins WHERE id = ?', [req.admin.id]);
    const admin  = rows[0];
    if (!bcrypt.compareSync(currentPassword, admin.password)) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }

    const hash = bcrypt.hashSync(newPassword, 12);
    await pool.query('UPDATE admins SET password = ? WHERE id = ?', [hash, req.admin.id]);
    res.json({ success: true, message: 'Password updated successfully' });
  } catch (err) {
    console.error('[auth/change-password]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── requireAuth middleware (admin JWT) ────────────────────────────────────────
function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized — admin token required' });
  }
  try {
    req.admin = jwt.verify(auth.slice(7), SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired admin token' });
  }
}

module.exports = { router, requireAuth };
