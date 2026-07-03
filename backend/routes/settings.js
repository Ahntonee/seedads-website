'use strict';
const express  = require('express');
const { pool } = require('../database');
const { requireAuth } = require('./auth');
const asyncHandler = require('../lib/asyncHandler');
const router = express.Router();

// Public: get all settings
router.get('/', asyncHandler(async (req, res) => {
  const [rows] = await pool.query('SELECT key, value FROM settings');
  const settings = {};
  rows.forEach(r => { settings[r.key] = r.value; });
  res.json(settings);
}));

// Admin: update one or more settings
router.put('/', requireAuth, asyncHandler(async (req, res) => {
  const allowed = ['site_name', 'contact_email', 'phone', 'whatsapp'];
  const pairs   = Object.entries(req.body).filter(([k]) => allowed.includes(k));
  if (!pairs.length) return res.status(400).json({ error: 'No valid settings provided' });

  for (const [k, v] of pairs) {
    await pool.query(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
      [k, v]
    );
  }
  res.json({ success: true });
}));

module.exports = router;
