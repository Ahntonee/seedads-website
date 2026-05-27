'use strict';
const express  = require('express');
const db       = require('../database');
const { requireAuth } = require('./auth');
const mailer   = require('../mailer');
const { sanitizeText, sanitizeEmail, sanitizePhone } = require('../security');
const router   = express.Router();

// Public: submit contact form
router.post('/', (req, res) => {
  const name    = sanitizeText(req.body.name, 200);
  const email   = sanitizeEmail(req.body.email);
  const phone   = sanitizePhone(req.body.phone);
  const service = sanitizeText(req.body.service, 200);
  const budget  = sanitizeText(req.body.budget, 100);
  const message = sanitizeText(req.body.message, 2000);

  if (!name)  return res.status(400).json({ error: 'Name is required' });
  if (!email) return res.status(400).json({ error: 'A valid email address is required' });

  const result = db.prepare(
    'INSERT INTO contacts (name, email, phone, service, budget, message) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(name, email, phone, service, budget, message);

  mailer.notifyNewContact({ name, email, phone, service, message }).catch(() => {});
  res.json({ success: true, id: result.lastInsertRowid });
});

// Admin: get all contacts
router.get('/', requireAuth, (req, res) => {
  const { status, search, page = 1, limit = 20 } = req.query;
  let query = 'SELECT * FROM contacts WHERE 1=1';
  const params = [];
  if (status) { query += ' AND status = ?'; params.push(sanitizeText(status, 50)); }
  if (search) {
    const s = '%' + sanitizeText(search, 100) + '%';
    query += ' AND (name LIKE ? OR email LIKE ?)';
    params.push(s, s);
  }
  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(parseInt(limit) || 20, ((parseInt(page) || 1) - 1) * (parseInt(limit) || 20));
  const contacts = db.prepare(query).all(...params);
  const total    = db.prepare('SELECT COUNT(*) as c FROM contacts').get().c;
  res.json({ contacts, total });
});

// Admin: update contact status/notes
router.patch('/:id', requireAuth, (req, res) => {
  const status = sanitizeText(req.body.status, 50);
  const notes  = sanitizeText(req.body.notes, 2000);
  db.prepare('UPDATE contacts SET status = COALESCE(?, status), notes = COALESCE(?, notes) WHERE id = ?')
    .run(status, notes, req.params.id);
  res.json({ success: true });
});

// Admin: delete contact
router.delete('/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM contacts WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

module.exports = router;
