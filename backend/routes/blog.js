'use strict';
const express  = require('express');
const db       = require('../database');
const { requireAuth } = require('./auth');
const { sanitizeText, sanitizeBlogContent } = require('../security');
const router   = express.Router();

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

// Public: list posts
router.get('/', (req, res) => {
  const { status, category, page = 1, limit = 10 } = req.query;
  const cleanStatus   = sanitizeText(status, 50);
  const cleanCategory = sanitizeText(category, 100);
  const pageSize   = parseInt(limit) || 10;
  const pageOffset = ((parseInt(page) || 1) - 1) * pageSize;

  let baseWhere = 'WHERE 1=1';
  const filterParams = [];
  if (cleanStatus)   { baseWhere += ' AND status = ?';   filterParams.push(cleanStatus); }
  if (cleanCategory) { baseWhere += ' AND category = ?'; filterParams.push(cleanCategory); }

  const posts = db.prepare(
    `SELECT id, title, slug, excerpt, category, cover_image, status, author, created_at FROM blog_posts ${baseWhere} ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).all(...filterParams, pageSize, pageOffset);

  // Total count respects the same filters (for correct pagination)
  const total = db.prepare(`SELECT COUNT(*) as c FROM blog_posts ${baseWhere}`).get(...filterParams).c;

  res.json({ posts, total });
});

// Public: get single post by id
router.get('/:id', (req, res) => {
  const post = db.prepare('SELECT * FROM blog_posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  res.json(post);
});

// Admin: create post
router.post('/', requireAuth, (req, res) => {
  const title       = sanitizeText(req.body.title, 500);
  const excerpt     = sanitizeText(req.body.excerpt, 1000);
  const content     = sanitizeBlogContent(req.body.content);
  const category    = sanitizeText(req.body.category, 100);
  const status      = sanitizeText(req.body.status, 50) || 'draft';
  const author      = sanitizeText(req.body.author, 200) || 'SeedsAds Team';
  const cover_image = sanitizeText(req.body.cover_image, 500);

  if (!title) return res.status(400).json({ error: 'Title is required' });
  const slug   = slugify(title) + '-' + Date.now();
  const result = db.prepare(
    'INSERT INTO blog_posts (title, slug, excerpt, content, category, status, author, cover_image) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(title, slug, excerpt, content, category, status, author, cover_image);
  res.json({ success: true, id: result.lastInsertRowid, slug });
});

// Admin: update post
router.patch('/:id', requireAuth, (req, res) => {
  const title       = req.body.title       !== undefined ? sanitizeText(req.body.title, 500)        : undefined;
  const excerpt     = req.body.excerpt     !== undefined ? sanitizeText(req.body.excerpt, 1000)     : undefined;
  const content     = req.body.content     !== undefined ? sanitizeBlogContent(req.body.content)    : undefined;
  const category    = req.body.category    !== undefined ? sanitizeText(req.body.category, 100)     : undefined;
  const status      = req.body.status      !== undefined ? sanitizeText(req.body.status, 50)        : undefined;
  const author      = req.body.author      !== undefined ? sanitizeText(req.body.author, 200)       : undefined;
  const cover_image = req.body.cover_image !== undefined ? sanitizeText(req.body.cover_image, 500)  : undefined;

  db.prepare(
    `UPDATE blog_posts SET
      title       = COALESCE(?, title),
      excerpt     = COALESCE(?, excerpt),
      content     = COALESCE(?, content),
      category    = COALESCE(?, category),
      status      = COALESCE(?, status),
      author      = COALESCE(?, author),
      cover_image = CASE WHEN ? IS NOT NULL THEN ? ELSE cover_image END,
      updated_at  = CURRENT_TIMESTAMP
    WHERE id = ?`
  ).run(
    title       ?? null,
    excerpt     ?? null,
    content     ?? null,
    category    ?? null,
    status      ?? null,
    author      ?? null,
    cover_image !== undefined ? (cover_image || null) : null,
    cover_image !== undefined ? (cover_image || null) : null,
    req.params.id
  );
  res.json({ success: true });
});

// Admin: delete post
router.delete('/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM blog_posts WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

module.exports = router;
