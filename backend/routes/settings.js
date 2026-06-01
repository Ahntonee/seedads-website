'use strict';
const express  = require('express');
const { pool } = require('../database');
const { requireAuth } = require('./auth');
const router = express.Router();

// Public: get all settings
router.get('/', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT key, value FROM settings');
    const settings = {};
    rows.forEach(r => { settings[r.key] = r.value; });
    res.json(settings);
  } catch (err) {
    console.error('[settings/get]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: update one or more settings
router.put('/', requireAuth, async (req, res) => {
  try {
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
  } catch (err) {
    console.error('[settings/put]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
