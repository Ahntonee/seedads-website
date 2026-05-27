const express = require('express');
const db = require('../database');
const { requireAuth } = require('./auth');
const { sanitizeText, sanitizeEmail, sanitizePhone } = require('../security');
const router = express.Router();

router.get('/', requireAuth, (req, res) => {
  const { status, search, page = 1, limit = 20 } = req.query;
  const cleanStatus = sanitizeText(status, 50);
  const cleanSearch = sanitizeText(search, 200);
  const pageSize    = parseInt(limit) || 20;
  const pageOffset  = ((parseInt(page) || 1) - 1) * pageSize;

  let baseWhere = 'WHERE 1=1';
  const filterParams = [];
  if (cleanStatus) { baseWhere += ' AND status = ?'; filterParams.push(cleanStatus); }
  if (cleanSearch) {
    baseWhere += ' AND (name LIKE ? OR email LIKE ? OR company LIKE ?)';
    filterParams.push(`%${cleanSearch}%`, `%${cleanSearch}%`, `%${cleanSearch}%`);
  }

  const leads = db.prepare(
    `SELECT * FROM leads ${baseWhere} ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).all(...filterParams, pageSize, pageOffset);

  // Total count respects the same filters (for correct pagination)
  const total = db.prepare(`SELECT COUNT(*) as c FROM leads ${baseWhere}`).get(...filterParams).c;

  res.json({ leads, total });
});

router.post('/', requireAuth, (req, res) => {
  const name    = sanitizeText(req.body.name, 200);
  const email   = sanitizeEmail(req.body.email);
  const phone   = sanitizePhone(req.body.phone);
  const company = sanitizeText(req.body.company, 200);
  const plan    = sanitizeText(req.body.plan, 100);
  const status  = sanitizeText(req.body.status, 50) || 'prospect';
  const notes   = sanitizeText(req.body.notes, 2000);
  const value   = req.body.value !== undefined && req.body.value !== '' ? parseFloat(req.body.value) || 0 : 0;

  if (!name)  return res.status(400).json({ error: 'Name is required' });
  if (!email) return res.status(400).json({ error: 'A valid email address is required' });

  const result = db.prepare(
    'INSERT INTO leads (name, email, phone, company, plan, status, value, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(name, email, phone, company, plan, status, value, notes);
  res.json({ success: true, id: result.lastInsertRowid });
});

router.patch('/:id', requireAuth, (req, res) => {
  const name    = req.body.name    !== undefined ? sanitizeText(req.body.name, 200)    : undefined;
  const email   = req.body.email   !== undefined ? sanitizeEmail(req.body.email)       : undefined;
  const phone   = req.body.phone   !== undefined ? sanitizePhone(req.body.phone)       : undefined;
  const company = req.body.company !== undefined ? sanitizeText(req.body.company, 200) : undefined;
  const plan    = req.body.plan    !== undefined ? sanitizeText(req.body.plan, 100)    : undefined;
  const status  = req.body.status  !== undefined ? sanitizeText(req.body.status, 50)   : undefined;
  const notes   = req.body.notes   !== undefined ? sanitizeText(req.body.notes, 2000)  : undefined;
  const value   = req.body.value   !== undefined && req.body.value !== ''
    ? (isNaN(parseFloat(req.body.value)) ? null : parseFloat(req.body.value))
    : null;

  db.prepare(
    `UPDATE leads SET
      name = COALESCE(?, name), email = COALESCE(?, email), phone = COALESCE(?, phone),
      company = COALESCE(?, company), plan = COALESCE(?, plan), status = COALESCE(?, status),
      value = COALESCE(?, value), notes = COALESCE(?, notes), updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(
    name ?? null, email ?? null, phone ?? null, company ?? null,
    plan ?? null, status ?? null, value, notes ?? null,
    req.params.id
  );
  res.json({ success: true });
});

router.delete('/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM leads WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

module.exports = router;
