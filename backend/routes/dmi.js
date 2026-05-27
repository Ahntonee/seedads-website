'use strict';
const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const jwt     = require('jsonwebtoken');
const db      = require('../database');
const { requireAuth } = require('./auth');
const { sanitizeText } = require('../security');
const router  = express.Router();
const SECRET  = process.env.JWT_SECRET;

// ── Upload storage ─────────────────────────────────────────────────────────
const dmiUploadsDir = path.join(__dirname, '../uploads/dmi');
if (!fs.existsSync(dmiUploadsDir)) fs.mkdirSync(dmiUploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, dmiUploadsDir),
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, Date.now() + '-' + safe);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB
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
// plan_access values: 'all' | 'Starter' | 'Growth' | 'Enterprise' | 'DMI Course'
// A user can see a resource if their plan is in the access list OR plan_access = 'all'
const PLAN_RANK = { all: 0, Starter: 1, 'DMI Course': 2, Growth: 3, Enterprise: 4 };
function canAccess(userPlan, resourcePlan) {
  if (resourcePlan === 'all') return true;
  if (!userPlan) return false;
  const userRank = PLAN_RANK[userPlan] || 0;
  const resRank = PLAN_RANK[resourcePlan] || 0;
  return userRank >= resRank;
}

// ── Protected file download ───────────────────────────────────────────────────
// Requires valid JWT (user or admin). Validates plan access for user tokens.
router.get('/download/:filename', (req, res) => {
  const auth  = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentication required to download this file' });

  let payload;
  try {
    payload = jwt.verify(token, SECRET);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  // Sanitize filename — prevent path traversal attacks
  const filename = path.basename(req.params.filename);
  const filepath = path.join(dmiUploadsDir, filename);

  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'File not found' });

  // Admins can download anything
  if (!payload.role) return res.download(filepath, filename);

  // Users: verify they have the plan required for this specific file
  const item = db.prepare('SELECT plan_access FROM dmi_content WHERE file_path LIKE ?').get('%' + filename);
  if (!item) return res.status(404).json({ error: 'File not found in content library' });

  const freshUser = db.prepare('SELECT plan, approved FROM users WHERE id = ?').get(payload.id);
  if (!freshUser || !freshUser.approved) {
    return res.status(403).json({ error: 'Your account is not yet approved. Please wait for admin approval.' });
  }
  if (!canAccess(freshUser.plan, item.plan_access)) {
    return res.status(403).json({ error: 'Your current plan does not include access to this file. Please upgrade.' });
  }

  res.download(filepath, filename);
});

// ── Public: list published content (filtered by plan) ─────────────────────
// Caller passes user JWT in Authorization header (optional — guests get 'all' content)
router.get('/', (req, res) => {
  let userPlan = null;

  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    try {
      const payload = jwt.verify(auth.slice(7), SECRET);
      // Get fresh plan from DB
      const u = db.prepare('SELECT plan FROM users WHERE id = ?').get(payload.id);
      userPlan = u ? u.plan : null;
    } catch {}
  }

  const { category } = req.query;
  let query = 'SELECT * FROM dmi_content WHERE published = 1';
  const params = [];
  if (category) { query += ' AND category = ?'; params.push(category); }
  query += ' ORDER BY sort_order ASC, created_at DESC';
  const all = db.prepare(query).all(...params);

  // Filter by plan, then mark accessible items
  const items = all.map(item => ({
    ...item,
    accessible: canAccess(userPlan, item.plan_access),
    // Never expose file_path for inaccessible items
    file_path: canAccess(userPlan, item.plan_access) ? item.file_path : null,
    file_name: canAccess(userPlan, item.plan_access) ? item.file_name : null,
    external_url: canAccess(userPlan, item.plan_access) ? item.external_url : null,
  }));

  res.json({ items, userPlan });
});

// ── Admin: list all content (no plan filter) ──────────────────────────────
router.get('/admin', requireAuth, (req, res) => {
  const items = db.prepare('SELECT * FROM dmi_content ORDER BY sort_order ASC, created_at DESC').all();
  res.json({ items });
});

// ── Admin: upload new DMI resource ────────────────────────────────────────
router.post('/', requireAuth, upload.single('file'), (req, res) => {
  const { title, description, type, external_url, plan_access, category, sort_order } = req.body;
  if (!title) return res.status(400).json({ error: 'Title is required' });

  const file_path = req.file ? '/uploads/dmi/' + req.file.filename : null;
  const file_name = req.file ? req.file.originalname : null;

  const result = db.prepare(`
    INSERT INTO dmi_content (title, description, type, file_path, file_name, external_url, plan_access, category, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    title,
    description || null,
    type || 'pdf',
    file_path,
    file_name,
    external_url || null,
    plan_access || 'all',
    category || null,
    parseInt(sort_order) || 0
  );

  res.json({ success: true, id: result.lastInsertRowid });
});

// ── Admin: update DMI resource ────────────────────────────────────────────
router.patch('/:id', requireAuth, upload.single('file'), (req, res) => {
  const { title, description, type, external_url, plan_access, category, sort_order, published } = req.body;
  const existing = db.prepare('SELECT * FROM dmi_content WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const file_path = req.file ? '/uploads/dmi/' + req.file.filename : existing.file_path;
  const file_name = req.file ? req.file.originalname : existing.file_name;

  db.prepare(`
    UPDATE dmi_content SET
      title = COALESCE(?, title),
      description = COALESCE(?, description),
      type = COALESCE(?, type),
      file_path = ?,
      file_name = ?,
      external_url = COALESCE(?, external_url),
      plan_access = COALESCE(?, plan_access),
      category = COALESCE(?, category),
      sort_order = COALESCE(?, sort_order),
      published = COALESCE(?, published),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(title, description, type, file_path, file_name, external_url, plan_access,
         category, sort_order !== undefined ? parseInt(sort_order) : null,
         published !== undefined ? parseInt(published) : null,
         req.params.id);

  res.json({ success: true });
});

// ── Admin: delete DMI resource ────────────────────────────────────────────
router.delete('/:id', requireAuth, (req, res) => {
  const item = db.prepare('SELECT file_path FROM dmi_content WHERE id = ?').get(req.params.id);
  if (item && item.file_path) {
    const abs = path.join(__dirname, '..', item.file_path);
    if (fs.existsSync(abs)) fs.unlinkSync(abs);
  }
  db.prepare('DELETE FROM dmi_content WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

module.exports = router;
