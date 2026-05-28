'use strict';
const express  = require('express');
const { pool } = require('../database');
const { requireAuth } = require('./auth');
const { sanitizeText, sanitizeEmail, sanitizePhone } = require('../security');
const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  try {
    const { status, search, page = 1, limit = 20 } = req.query;
    const cleanStatus = sanitizeText(status, 50);
    const cleanSearch = sanitizeText(search, 200);
    const pageSize    = parseInt(limit) || 20;
    const pageOffset  = ((parseInt(page) || 1) - 1) * pageSize;

    const filterParams = [];
    let whereClause = 'WHERE 1=1';
    let idx = 1;

    if (cleanStatus) {
      whereClause += ` AND status = $${idx++}`;
      filterParams.push(cleanStatus);
    }
    if (cleanSearch) {
      whereClause += ` AND (name ILIKE $${idx} OR email ILIKE $${idx + 1} OR company ILIKE $${idx + 2})`;
      idx += 3;
      filterParams.push(`%${cleanSearch}%`, `%${cleanSearch}%`, `%${cleanSearch}%`);
    }

    const countRes = await pool.query(`SELECT COUNT(*) as c FROM leads ${whereClause}`, filterParams);
    const total    = parseInt(countRes.rows[0].c);

    const { rows: leads } = await pool.query(
      `SELECT * FROM leads ${whereClause} ORDER BY created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
      [...filterParams, pageSize, pageOffset]
    );

    res.json({ leads, total });
  } catch (err) {
    console.error('[leads/get]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/', requireAuth, async (req, res) => {
  try {
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

    const { rows } = await pool.query(
      'INSERT INTO leads (name, email, phone, company, plan, status, value, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
      [name, email, phone, company, plan, status, value, notes]
    );
    res.json({ success: true, id: rows[0].id });
  } catch (err) {
    console.error('[leads/post]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch('/:id', requireAuth, async (req, res) => {
  try {
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
        name       = COALESCE($1, name),
        email      = COALESCE($2, email),
        phone      = COALESCE($3, phone),
        company    = COALESCE($4, company),
        plan       = COALESCE($5, plan),
        status     = COALESCE($6, status),
        value      = COALESCE($7, value),
        notes      = COALESCE($8, notes),
        updated_at = CURRENT_TIMESTAMP
       WHERE id = $9`,
      [name, email, phone, company, plan, status, value, notes, req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('[leads/patch]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM leads WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('[leads/delete]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
