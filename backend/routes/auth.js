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
const asyncHandler = require('../lib/asyncHandler');

const router = express.Router();
const SECRET = process.env.JWT_SECRET;

// ── Admin login ───────────────────────────────────────────────────────────────
router.post('/login', asyncHandler(async (req, res) => {
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
    { id: admin.id, username: admin.username, name: admin.name, role: 'admin' },
    SECRET,
    { expiresIn: '24h' }
  );
  res.json({ token, name: admin.name });
}));

// ── Admin change password ─────────────────────────────────────────────────────
router.post('/change-password', requireAuth, asyncHandler(async (req, res) => {
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
}));

// ── requireAuth middleware (admin JWT) ────────────────────────────────────────
// SECURITY: admin and user tokens are signed with the same JWT_SECRET, so we MUST
// confirm the token's role is 'admin'. Without this check a regular user's token
// would pass signature verification and gain admin access (privilege escalation).
function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized — admin token required' });
  }
  try {
    const payload = jwt.verify(auth.slice(7), SECRET);
    if (payload.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden — admin privileges required' });
    }
    req.admin = payload;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired admin token' });
  }
}

module.exports = { router, requireAuth };
