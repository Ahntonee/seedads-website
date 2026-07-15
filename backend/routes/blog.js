'use strict';
const express  = require('express');
const { pool } = require('../database');
const { requireAuth } = require('./auth');
const asyncHandler = require('../lib/asyncHandler');
const { sanitizeText, sanitizeBlogContent } = require('../security');
const router   = express.Router();

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

// Public: list posts
router.get('/', asyncHandler(async (req, res) => {
  const { status, category, page = 1, limit = 10 } = req.query;
  const cleanStatus   = sanitizeText(status, 50);
  const cleanCategory = sanitizeText(category, 100);
  const pageSize   = parseInt(limit) || 10;
  const pageOffset = ((parseInt(page) || 1) - 1) * pageSize;

  const filterParams = [];
  let where = 'WHERE 1=1';

  if (cleanStatus)   { where += ' AND status = ?';   filterParams.push(cleanStatus); }
  if (cleanCategory) { where += ' AND category = ?'; filterParams.push(cleanCategory); }

  const [countRows] = await pool.query(`SELECT COUNT(*) as c FROM blog_posts ${where}`, filterParams);
  const total = parseInt(countRows[0].c);

  const [posts] = await pool.query(
    `SELECT id, title, slug, excerpt, category, cover_image, status, author, created_at
     FROM blog_posts ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...filterParams, pageSize, pageOffset]
  );

  res.json({ posts, total });
}));

// Public: get single post by id
router.get('/:id', asyncHandler(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM blog_posts WHERE id = ?', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Post not found' });
  res.json(rows[0]);
}));

// Admin: create post
router.post('/', requireAuth, asyncHandler(async (req, res) => {
  const title       = sanitizeText(req.body.title, 500);
  const excerpt     = sanitizeText(req.body.excerpt, 1000);
  const content     = sanitizeBlogContent(req.body.content);
  const category    = sanitizeText(req.body.category, 100);
  const status      = sanitizeText(req.body.status, 50) || 'draft';
  const author      = sanitizeText(req.body.author, 200) || 'SeedsAds Team';
  const cover_image = sanitizeText(req.body.cover_image, 500);

  if (!title) return res.status(400).json({ error: 'Title is required' });
  const slug = slugify(title) + '-' + Date.now();

  const [result] = await pool.query(
    'INSERT INTO blog_posts (title, slug, excerpt, content, category, status, author, cover_image) VALUES (?,?,?,?,?,?,?,?)',
    [title, slug, excerpt, content, category, status, author, cover_image]
  );
  res.json({ success: true, id: result.insertId, slug });
}));

// Admin: update post
router.patch('/:id', requireAuth, asyncHandler(async (req, res) => {
  const title       = req.body.title       !== undefined ? sanitizeText(req.body.title, 500)       : null;
  const excerpt     = req.body.excerpt     !== undefined ? sanitizeText(req.body.excerpt, 1000)    : null;
  const content     = req.body.content     !== undefined ? sanitizeBlogContent(req.body.content)   : null;
  const category    = req.body.category    !== undefined ? sanitizeText(req.body.category, 100)    : null;
  const status      = req.body.status      !== undefined ? sanitizeText(req.body.status, 50)       : null;
  const author      = req.body.author      !== undefined ? sanitizeText(req.body.author, 200)      : null;
  const cover_image = req.body.cover_image !== undefined ? (sanitizeText(req.body.cover_image, 500) || null) : null;

  await pool.query(
    `UPDATE blog_posts SET
      title       = COALESCE(?, title),
      excerpt     = COALESCE(?, excerpt),
      content     = COALESCE(?, content),
      category    = COALESCE(?, category),
      status      = COALESCE(?, status),
      author      = COALESCE(?, author),
      cover_image = COALESCE(?, cover_image),
      updated_at  = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [title, excerpt, content, category, status, author, cover_image, req.params.id]
  );
  res.json({ success: true });
}));

// Admin: delete post
router.delete('/:id', requireAuth, asyncHandler(async (req, res) => {
  await pool.query('DELETE FROM blog_posts WHERE id = ?', [req.params.id]);
  res.json({ success: true });
}));

module.exports = router;
