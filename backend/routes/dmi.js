'use strict';
const express  = require('express');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const jwt      = require('jsonwebtoken');
const { pool } = require('../database');
const { requireAuth } = require('./auth');
const { sanitizeText } = require('../security');
const router   = express.Router();
const SECRET   = process.env.JWT_SECRET;

// ── Upload storage ─────────────────────────────────────────────────────────
const dmiUploadsDir = path.join(__dirname, '../uploads/dmi');
if (!fs.existsSync(dmiUploadsDir)) fs.mkdirSync(dmiUploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, dmiUploadsDir),
  filename:    (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, Date.now() + '-' + safe);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = [
      'application/pdf',
      'video/mp4', 'video/webm', 'video/ogg', 'video/quicktime',
      'application/zip', 'application/x-zip-compressed',
    ];
    if (allowed.includes(file.mimetype)) return cb(null, true);
    cb(new Error('Only PDF, video (mp4/webm/ogg/mov), and ZIP files are allowed'));
  },
});

// ── Plan access hierarchy ──────────────────────────────────────────────────
const PLAN_RANK = { all: 0, Starter: 1, 'DMI Course': 2, Growth: 3, Enterprise: 4 };
function canAccess(userPlan, resourcePlan) {
  if (resourcePlan === 'all') return true;
  if (!userPlan) return false;
  return (PLAN_RANK[userPlan] || 0) >= (PLAN_RANK[resourcePlan] || 0);
}

// ── Protected file download ────────────────────────────────────────────────
router.get('/download/:filename', async (req, res) => {
  try {
    const auth  = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Authentication required to download this file' });

    let payload;
    try { payload = jwt.verify(token, SECRET); }
    catch { return res.status(401).json({ error: 'Invalid or expired token' }); }

    const filename = path.basename(req.params.filename);
    const filepath = path.join(dmiUploadsDir, filename);
    if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'File not found' });

    if (!payload.role) return res.download(filepath, filename);

    const { rows: itemRows } = await pool.query(
      'SELECT plan_access FROM dmi_content WHERE file_path LIKE $1',
      ['%' + filename]
    );
    if (!itemRows[0]) return res.status(404).json({ error: 'File not found in content library' });

    const { rows: userRows } = await pool.query('SELECT plan, approved FROM users WHERE id = $1', [payload.id]);
    const freshUser = userRows[0];
    if (!freshUser || !freshUser.approved) {
      return res.status(403).json({ error: 'Your account is not yet approved. Please wait for admin approval.' });
    }
    if (!canAccess(freshUser.plan, itemRows[0].plan_access)) {
      return res.status(403).json({ error: 'Your current plan does not include access to this file. Please upgrade.' });
    }
    res.download(filepath, filename);
  } catch (err) {
    console.error('[dmi/download]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Public: list published content (filtered by plan) ─────────────────────
router.get('/', async (req, res) => {
  try {
    let userPlan = null;
    const auth = req.headers.authorization;
    if (auth && auth.startsWith('Bearer ')) {
      try {
        const payload = jwt.verify(auth.slice(7), SECRET);
        const { rows } = await pool.query('SELECT plan FROM users WHERE id = $1', [payload.id]);
        userPlan = rows[0] ? rows[0].plan : null;
      } catch {}
    }

    const { category } = req.query;
    let query  = 'SELECT * FROM dmi_content WHERE published = 1';
    const params = [];
    if (category) { query += ' AND category = $1'; params.push(category); }
    query += ' ORDER BY sort_order ASC, created_at DESC';

    const { rows: all } = await pool.query(query, params);
    const items = all.map(item => ({
      ...item,
      accessible:   canAccess(userPlan, item.plan_access),
      file_path:    canAccess(userPlan, item.plan_access) ? item.file_path    : null,
      file_name:    canAccess(userPlan, item.plan_access) ? item.file_name    : null,
      external_url: canAccess(userPlan, item.plan_access) ? item.external_url : null,
    }));

    res.json({ items, userPlan });
  } catch (err) {
    console.error('[dmi/list]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Admin: list all content ────────────────────────────────────────────────
router.get('/admin', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM dmi_content ORDER BY sort_order ASC, created_at DESC');
    res.json({ items: rows });
  } catch (err) {
    console.error('[dmi/admin]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Admin: upload new DMI resource ─────────────────────────────────────────
router.post('/', requireAuth, upload.single('file'), async (req, res) => {
  try {
    const { title, description, type, external_url, plan_access, category, sort_order } = req.body;
    if (!title) return res.status(400).json({ error: 'Title is required' });

    const file_path = req.file ? '/uploads/dmi/' + req.file.filename : null;
    const file_name = req.file ? req.file.originalname : null;

    const { rows } = await pool.query(
      `INSERT INTO dmi_content (title, description, type, file_path, file_name, external_url, plan_access, category, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [title, description || null, type || 'pdf', file_path, file_name,
       external_url || null, plan_access || 'all', category || null, parseInt(sort_order) || 0]
    );
    res.json({ success: true, id: rows[0].id });
  } catch (err) {
    console.error('[dmi/post]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Admin: update DMI resource ─────────────────────────────────────────────
router.patch('/:id', requireAuth, upload.single('file'), async (req, res) => {
  try {
    const { title, description, type, external_url, plan_access, category, sort_order, published } = req.body;
    const { rows: existing } = await pool.query('SELECT * FROM dmi_content WHERE id = $1', [req.params.id]);
    if (!existing[0]) return res.status(404).json({ error: 'Not found' });

    const file_path = req.file ? '/uploads/dmi/' + req.file.filename : existing[0].file_path;
    const file_name = req.file ? req.file.originalname : existing[0].file_name;

    await pool.query(
      `UPDATE dmi_content SET
        title        = COALESCE($1, title),
        description  = COALESCE($2, description),
        type         = COALESCE($3, type),
        file_path    = $4,
        file_name    = $5,
        external_url = COALESCE($6, external_url),
        plan_access  = COALESCE($7, plan_access),
        category     = COALESCE($8, category),
        sort_order   = COALESCE($9, sort_order),
        published    = COALESCE($10, published),
        updated_at   = CURRENT_TIMESTAMP
       WHERE id = $11`,
      [title || null, description || null, type || null, file_path, file_name,
       external_url || null, plan_access || null, category || null,
       sort_order !== undefined ? parseInt(sort_order) : null,
       published  !== undefined ? parseInt(published)  : null,
       req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('[dmi/patch]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Admin: delete DMI resource ─────────────────────────────────────────────
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT file_path FROM dmi_content WHERE id = $1', [req.params.id]);
    if (rows[0] && rows[0].file_path) {
      const abs = path.join(__dirname, '..', rows[0].file_path);
      if (fs.existsSync(abs)) fs.unlinkSync(abs);
    }
    await pool.query('DELETE FROM dmi_content WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('[dmi/delete]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
