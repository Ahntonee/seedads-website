'use strict';
const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const jwt      = require('jsonwebtoken');
const { pool } = require('../database');
const { requireAuth } = require('./auth');
const { sanitizeText } = require('../security');
const { makeUploader, persist, remove } = require('../storage');
const router   = express.Router();
const SECRET   = process.env.JWT_SECRET;

// Local fallback dir (only used when Cloudinary is not configured)
const dmiUploadsDir = path.join(__dirname, '../uploads/dmi');

// DMI files persist to Cloudinary in production (Render disk is wiped on deploy).
const upload = makeUploader({
  subdir: 'dmi',
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

// Cloudinary resource type: videos → 'video', archives → 'raw', PDFs → 'auto'
function dmiResourceType(file, type) {
  if ((file && file.mimetype && file.mimetype.startsWith('video/')) || type === 'video') return 'video';
  if (file && /zip/i.test(file.mimetype || '')) return 'raw';
  return 'auto';
}

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
    const [itemRows] = await pool.query(
      'SELECT plan_access, file_path, file_name FROM dmi_content WHERE file_path LIKE ?',
      ['%' + filename + '%']
    );
    const item = itemRows[0];

    // Non-admins must be approved and on a plan that grants access
    if (payload.role !== 'admin') {
      if (!item) return res.status(404).json({ error: 'File not found in content library' });
      const [userRows] = await pool.query('SELECT plan, approved FROM users WHERE id = ?', [payload.id]);
      const freshUser = userRows[0];
      if (!freshUser || !freshUser.approved) {
        return res.status(403).json({ error: 'Your account is not yet approved. Please wait for admin approval.' });
      }
      if (!canAccess(freshUser.plan, item.plan_access)) {
        return res.status(403).json({ error: 'Your current plan does not include access to this file. Please upgrade.' });
      }
    }

    const target = item ? item.file_path : '/uploads/dmi/' + filename;
    // Cloudinary URL → redirect (access already gated above)
    if (/^https?:\/\//i.test(target)) return res.redirect(target);
    // Local disk fallback (dev)
    const filepath = path.join(dmiUploadsDir, filename);
    if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'File not found' });
    res.download(filepath, (item && item.file_name) || filename);
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
        const [rows] = await pool.query('SELECT plan FROM users WHERE id = ?', [payload.id]);
        userPlan = rows[0] ? rows[0].plan : null;
      } catch {}
    }

    const { category } = req.query;
    let query  = 'SELECT * FROM dmi_content WHERE published = 1';
    const params = [];
    if (category) { query += ' AND category = ?'; params.push(category); }
    query += ' ORDER BY sort_order ASC, created_at DESC';

    const [all] = await pool.query(query, params);
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
    const [rows] = await pool.query('SELECT * FROM dmi_content ORDER BY sort_order ASC, created_at DESC');
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

    const { url: file_path } = await persist(req.file, {
      folder: 'seedsads/dmi', subdir: 'dmi', resourceType: dmiResourceType(req.file, type),
    });
    const file_name = req.file ? req.file.originalname : null;

    const [result] = await pool.query(
      `INSERT INTO dmi_content (title, description, type, file_path, file_name, external_url, plan_access, category, sort_order)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [title, description || null, type || 'pdf', file_path, file_name,
       external_url || null, plan_access || 'all', category || null, parseInt(sort_order) || 0]
    );
    res.json({ success: true, id: result.insertId });
  } catch (err) {
    console.error('[dmi/post]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Admin: update DMI resource ─────────────────────────────────────────────
router.patch('/:id', requireAuth, upload.single('file'), async (req, res) => {
  try {
    const { title, description, type, external_url, plan_access, category, sort_order, published } = req.body;
    const [existing] = await pool.query('SELECT * FROM dmi_content WHERE id = ?', [req.params.id]);
    if (!existing[0]) return res.status(404).json({ error: 'Not found' });

    let file_path = existing[0].file_path;
    let file_name = existing[0].file_name;
    if (req.file) {
      const out = await persist(req.file, {
        folder: 'seedsads/dmi', subdir: 'dmi', resourceType: dmiResourceType(req.file, type),
      });
      // Replace old file (best-effort) to avoid orphaned storage
      await remove(existing[0].file_path, { resourceType: dmiResourceType(req.file, type) });
      file_path = out.url;
      file_name = req.file.originalname;
    }

    await pool.query(
      `UPDATE dmi_content SET
        title        = COALESCE(?, title),
        description  = COALESCE(?, description),
        type         = COALESCE(?, type),
        file_path    = ?,
        file_name    = ?,
        external_url = COALESCE(?, external_url),
        plan_access  = COALESCE(?, plan_access),
        category     = COALESCE(?, category),
        sort_order   = COALESCE(?, sort_order),
        published    = COALESCE(?, published),
        updated_at   = CURRENT_TIMESTAMP
       WHERE id = ?`,
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
    const [rows] = await pool.query('SELECT file_path FROM dmi_content WHERE id = ?', [req.params.id]);
    if (rows[0] && rows[0].file_path) {
      await remove(rows[0].file_path);
    }
    await pool.query('DELETE FROM dmi_content WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('[dmi/delete]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
