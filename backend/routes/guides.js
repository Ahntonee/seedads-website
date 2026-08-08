'use strict';
const express  = require('express');
const { pool } = require('../database');
const { requireAuth } = require('./auth');
const asyncHandler = require('../lib/asyncHandler');
const { sanitizeText } = require('../security');
const { makeUploader, persist, remove } = require('../storage');
const router = express.Router();

// Featured image + downloadable file. Images small, files up to 50 MB.
const MAX_UPLOAD = 50 * 1024 * 1024;
const upload = makeUploader({
  subdir: 'guides',
  limits: { fileSize: MAX_UPLOAD },
  fileFilter: (req, file, cb) => {
    const allowed = [
      'image/jpeg', 'image/png', 'image/webp', 'image/gif',
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/zip', 'application/x-zip-compressed',
    ];
    if (allowed.includes(file.mimetype)) return cb(null, true);
    cb(new Error('Only images, PDF, Word docs, and ZIP files are allowed'));
  },
});
const guideUploadFields = upload.fields([
  { name: 'image', maxCount: 1 },
  { name: 'file',  maxCount: 1 },
]);

// ── Public: list published guides ──────────────────────────────────────────
router.get('/', asyncHandler(async (req, res) => {
  const [rows] = await pool.query(
    'SELECT * FROM guides WHERE published = 1 ORDER BY sort_order ASC, created_at DESC'
  );
  res.json({ guides: rows });
}));

// ── Admin: list all guides ─────────────────────────────────────────────────
router.get('/admin', requireAuth, asyncHandler(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM guides ORDER BY sort_order ASC, created_at DESC');
  res.json({ guides: rows });
}));

// ── Admin: create guide ────────────────────────────────────────────────────
router.post('/', requireAuth, guideUploadFields, asyncHandler(async (req, res) => {
  const title       = sanitizeText(req.body.title, 500);
  const description = sanitizeText(req.body.description, 2000);
  const category    = sanitizeText(req.body.category, 100);
  const external_url = sanitizeText(req.body.external_url, 500);
  const sort_order  = parseInt(req.body.sort_order) || 0;
  const published   = req.body.published !== undefined ? parseInt(req.body.published) : 1;
  if (!title) return res.status(400).json({ error: 'Title is required' });

  const imageFile = req.files?.image?.[0] || null;
  const docFile   = req.files?.file?.[0]  || null;

  const { url: image_url } = await persist(imageFile, { folder: 'seedsads/guides', subdir: 'guides', resourceType: 'image' });
  const { url: file_url }  = await persist(docFile,   { folder: 'seedsads/guides', subdir: 'guides', resourceType: 'auto' });
  const file_name = docFile ? docFile.originalname : null;

  const [result] = await pool.query(
    `INSERT INTO guides (title, description, category, image_url, file_url, file_name, external_url, published, sort_order)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [title, description || null, category || null, image_url, file_url, file_name, external_url || null, published, sort_order]
  );
  res.json({ success: true, id: result.insertId });
}));

// ── Admin: update guide ────────────────────────────────────────────────────
router.patch('/:id', requireAuth, guideUploadFields, asyncHandler(async (req, res) => {
  const [existing] = await pool.query('SELECT * FROM guides WHERE id = ?', [req.params.id]);
  if (!existing[0]) return res.status(404).json({ error: 'Not found' });

  const title       = sanitizeText(req.body.title, 500);
  const description = sanitizeText(req.body.description, 2000);
  const category    = sanitizeText(req.body.category, 100);
  const external_url = sanitizeText(req.body.external_url, 500);

  const imageFile = req.files?.image?.[0] || null;
  const docFile   = req.files?.file?.[0]  || null;

  let image_url = existing[0].image_url;
  let file_url  = existing[0].file_url;
  let file_name = existing[0].file_name;

  if (imageFile) {
    const out = await persist(imageFile, { folder: 'seedsads/guides', subdir: 'guides', resourceType: 'image' });
    await remove(existing[0].image_url, { resourceType: 'image' });
    image_url = out.url;
  }
  if (docFile) {
    const out = await persist(docFile, { folder: 'seedsads/guides', subdir: 'guides', resourceType: 'auto' });
    await remove(existing[0].file_url);
    file_url = out.url;
    file_name = docFile.originalname;
  }

  await pool.query(
    `UPDATE guides SET
      title        = COALESCE(?, title),
      description  = COALESCE(?, description),
      category     = COALESCE(?, category),
      image_url    = ?,
      file_url     = ?,
      file_name    = ?,
      external_url = COALESCE(?, external_url),
      published    = COALESCE(?, published),
      sort_order   = COALESCE(?, sort_order),
      updated_at   = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [title || null, description || null, category || null, image_url, file_url, file_name,
     external_url || null,
     req.body.published  !== undefined ? parseInt(req.body.published)  : null,
     req.body.sort_order !== undefined ? parseInt(req.body.sort_order) : null,
     req.params.id]
  );
  res.json({ success: true });
}));

// ── Admin: delete guide ────────────────────────────────────────────────────
router.delete('/:id', requireAuth, asyncHandler(async (req, res) => {
  const [rows] = await pool.query('SELECT image_url, file_url FROM guides WHERE id = ?', [req.params.id]);
  if (rows[0]) {
    if (rows[0].image_url) await remove(rows[0].image_url, { resourceType: 'image' });
    if (rows[0].file_url)  await remove(rows[0].file_url);
  }
  await pool.query('DELETE FROM guides WHERE id = ?', [req.params.id]);
  res.json({ success: true });
}));

module.exports = router;
