const express = require('express');
const db = require('../database');
const { requireAuth } = require('./auth');
const router = express.Router();

// Public: get all settings as a flat object
router.get('/', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  rows.forEach(r => { settings[r.key] = r.value; });
  res.json(settings);
});

// Admin: update one or more settings
router.put('/', requireAuth, (req, res) => {
  const allowed = ['site_name', 'contact_email', 'phone', 'whatsapp'];
  const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  const updateMany = db.transaction((pairs) => {
    pairs.forEach(([k, v]) => upsert.run(k, v));
  });
  const pairs = Object.entries(req.body).filter(([k]) => allowed.includes(k));
  if (!pairs.length) return res.status(400).json({ error: 'No valid settings provided' });
  updateMany(pairs);
  res.json({ success: true });
});

module.exports = router;
