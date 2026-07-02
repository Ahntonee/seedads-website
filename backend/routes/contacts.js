'use strict';
const express  = require('express');
const { pool } = require('../database');
const { requireAuth } = require('./auth');
const asyncHandler = require('../lib/asyncHandler');
const mailer   = require('../mailer');
const { sanitizeText, sanitizeEmail, sanitizePhone } = require('../security');
const router   = express.Router();

// Public: submit contact form
router.post('/', asyncHandler(async (req, res) => {
  const name    = sanitizeText(req.body.name, 200);
  const email   = sanitizeEmail(req.body.email);
  const phone   = sanitizePhone(req.body.phone);
  const service = sanitizeText(req.body.service, 200);
  const budget  = sanitizeText(req.body.budget, 100);
  const message = sanitizeText(req.body.message, 2000);

  if (!name)  return res.status(400).json({ error: 'Name is required' });
  if (!email) return res.status(400).json({ error: 'A valid email address is required' });

  const [result] = await pool.query(
    'INSERT INTO contacts (name, email, phone, service, budget, message) VALUES (?,?,?,?,?,?)',
    [name, email, phone, service, budget, message]
  );
  mailer.notifyNewContact({ name, email, phone, service, message }).catch(() => {});
  res.json({ success: true, id: result.insertId });
}));

// Admin: get all contacts
router.get('/', requireAuth, asyncHandler(async (req, res) => {
  const { status, search, page = 1, limit = 20 } = req.query;
  const pageSize   = parseInt(limit) || 20;
  const pageOffset = ((parseInt(page) || 1) - 1) * pageSize;

  let where = 'WHERE 1=1';
  const filterParams = [];

  if (status) {
    where += ' AND status = ?';
    filterParams.push(sanitizeText(status, 50));
  }
  if (search) {
    const s = '%' + sanitizeText(search, 100) + '%';
    where += ' AND (name LIKE ? OR email LIKE ?)';
    filterParams.push(s, s);
  }

  const [countRows] = await pool.query(`SELECT COUNT(*) as c FROM contacts ${where}`, filterParams);
  const total = parseInt(countRows[0].c);

  const [contacts] = await pool.query(
    `SELECT * FROM contacts ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...filterParams, pageSize, pageOffset]
  );

  res.json({ contacts, total });
}));

// Admin: update contact status/notes
router.patch('/:id', requireAuth, asyncHandler(async (req, res) => {
  const status = sanitizeText(req.body.status, 50);
  const notes  = sanitizeText(req.body.notes, 2000);
  await pool.query(
    'UPDATE contacts SET status = COALESCE(?, status), notes = COALESCE(?, notes) WHERE id = ?',
    [status || null, notes || null, req.params.id]
  );
  res.json({ success: true });
}));

// Admin: delete contact
router.delete('/:id', requireAuth, asyncHandler(async (req, res) => {
  await pool.query('DELETE FROM contacts WHERE id = ?', [req.params.id]);
  res.json({ success: true });
}));

module.exports = router;
