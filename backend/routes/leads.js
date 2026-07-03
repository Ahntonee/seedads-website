'use strict';
const express  = require('express');
const { pool } = require('../database');
const { requireAuth } = require('./auth');
const asyncHandler = require('../lib/asyncHandler');
const { sanitizeText, sanitizeEmail, sanitizePhone } = require('../security');
const router = express.Router();

router.get('/', requireAuth, asyncHandler(async (req, res) => {
  const { status, search, page = 1, limit = 20 } = req.query;
  const cleanStatus = sanitizeText(status, 50);
  const cleanSearch = sanitizeText(search, 200);
  const pageSize    = parseInt(limit) || 20;
  const pageOffset  = ((parseInt(page) || 1) - 1) * pageSize;

  const filterParams = [];
  let where = 'WHERE 1=1';

  if (cleanStatus) {
    where += ' AND status = ?';
    filterParams.push(cleanStatus);
  }
  if (cleanSearch) {
    where += ' AND (name LIKE ? OR email LIKE ? OR company LIKE ?)';
    filterParams.push(`%${cleanSearch}%`, `%${cleanSearch}%`, `%${cleanSearch}%`);
  }

  const [countRows] = await pool.query(`SELECT COUNT(*) as c FROM leads ${where}`, filterParams);
  const total = parseInt(countRows[0].c);

  const [leads] = await pool.query(
    `SELECT * FROM leads ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...filterParams, pageSize, pageOffset]
  );

  res.json({ leads, total });
}));

router.post('/', requireAuth, asyncHandler(async (req, res) => {
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

  const [result] = await pool.query(
    'INSERT INTO leads (name, email, phone, company, plan, status, value, notes) VALUES (?,?,?,?,?,?,?,?)',
    [name, email, phone, company, plan, status, value, notes]
  );
  res.json({ success: true, id: result.insertId });
}));

router.patch('/:id', requireAuth, asyncHandler(async (req, res) => {
  const name    = req.body.name    !== undefined ? sanitizeText(req.body.name, 200)    : null;
  const email   = req.body.email   !== undefined ? sanitizeEmail(req.body.email)       : null;
  const phone   = req.body.phone   !== undefined ? sanitizePhone(req.body.phone)       : null;
  const company = req.body.company !== undefined ? sanitizeText(req.body.company, 200) : null;
  const plan    = req.body.plan    !== undefined ? sanitizeText(req.body.plan, 100)    : null;
  const status  = req.body.status  !== undefined ? sanitizeText(req.body.status, 50)   : null;
  const notes   = req.body.notes   !== undefined ? sanitizeText(req.body.notes, 2000)  : null;
  const value   = req.body.value   !== undefined && req.body.value !== ''
    ? (isNaN(parseFloat(req.body.value)) ? null : parseFloat(req.body.value))
    : null;

  await pool.query(
    `UPDATE leads SET
      name       = COALESCE(?, name),
      email      = COALESCE(?, email),
      phone      = COALESCE(?, phone),
      company    = COALESCE(?, company),
      plan       = COALESCE(?, plan),
      status     = COALESCE(?, status),
      value      = COALESCE(?, value),
      notes      = COALESCE(?, notes),
      updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [name, email, phone, company, plan, status, value, notes, req.params.id]
  );
  res.json({ success: true });
}));

router.delete('/:id', requireAuth, asyncHandler(async (req, res) => {
  await pool.query('DELETE FROM leads WHERE id = ?', [req.params.id]);
  res.json({ success: true });
}));

module.exports = router;
