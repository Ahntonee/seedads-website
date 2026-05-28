'use strict';
const express  = require('express');
const { pool } = require('../database');
const { requireAuth } = require('./auth');
const { sanitizeText, sanitizeBlogContent } = require('../security');
const router   = express.Router();

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

// Public: list posts
router.get('/', async (req, res) => {
  try {
    const { status, category, page = 1, limit = 10 } = req.query;
    const cleanStatus   = sanitizeText(status, 50);
    const cleanCategory = sanitizeText(category, 100);
    const pageSize   = parseInt(limit) || 10;
    const pageOffset = ((parseInt(page) || 1) - 1) * pageSize;

    const filterParams = [];
    let whereClause = 'WHERE 1=1';
    let idx = 1;

    if (cleanStatus)   { whereClause += ` AND status = $${idx++}`;   filterParams.push(cleanStatus); }
    if (cleanCategory) { whereClause += ` AND category = $${idx++}`; filterParams.push(cleanCategory); }

    const countRes = await pool.query(`SELECT COUNT(*) as c FROM blog_posts ${whereClause}`, filterParams);
    const total    = parseInt(countRes.rows[0].c);

    const { rows: posts } = await pool.query(
      `SELECT id, title, slug, excerpt, category, cover_image, status, author, created_at
       FROM blog_posts ${whereClause} ORDER BY created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
      [...filterParams, pageSize, pageOffset]
    );

    res.json({ posts, total });
  } catch (err) {
    console.error('[blog/list]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Public: get single post by id
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM blog_posts WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Post not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[blog/get]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: create post
router.post('/', requireAuth, async (req, res) => {
  try {
    const title       = sanitizeText(req.body.title, 500);
    const excerpt     = sanitizeText(req.body.excerpt, 1000);
    const content     = sanitizeBlogContent(req.body.content);
    const category    = sanitizeText(req.body.category, 100);
    const status      = sanitizeText(req.body.status, 50) || 'draft';
    const author      = sanitizeText(req.body.author, 200) || 'SeedsAds Team';
    const cover_image = sanitizeText(req.body.cover_image, 500);

    if (!title) return res.status(400).json({ error: 'Title is required' });
    const slug = slugify(title) + '-' + Date.now();

    const { rows } = await pool.query(
      'INSERT INTO blog_posts (title, slug, excerpt, content, category, status, author, cover_image) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
      [title, slug, excerpt, content, category, status, author, cover_image]
    );
    res.json({ success: true, id: rows[0].id, slug });
  } catch (err) {
    console.error('[blog/post]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: update post
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const title       = req.body.title       !== undefined ? sanitizeText(req.body.title, 500)       : null;
    const excerpt     = req.body.excerpt     !== undefined ? sanitizeText(req.body.excerpt, 1000)    : null;
    const content     = req.body.content     !== undefined ? sanitizeBlogContent(req.body.content)   : null;
    const category    = req.body.category    !== undefined ? sanitizeText(req.body.category, 100)    : null;
    const status      = req.body.status      !== undefined ? sanitizeText(req.body.status, 50)       : null;
    const author      = req.body.author      !== undefined ? sanitizeText(req.body.author, 200)      : null;
    const cover_image = req.body.cover_image !== undefined ? (sanitizeText(req.body.cover_image, 500) || null) : null;

    await pool.query(
      `UPDATE blog_posts SET
        title       = COALESCE($1, title),
        excerpt     = COALESCE($2, excerpt),
        content     = COALESCE($3, content),
        category    = COALESCE($4, category),
        status      = COALESCE($5, status),
        author      = COALESCE($6, author),
        cover_image = CASE WHEN $7 IS NOT NULL THEN $7 ELSE cover_image END,
        updated_at  = CURRENT_TIMESTAMP
       WHERE id = $8`,
      [title, excerpt, content, category, status, author, cover_image, req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('[blog/patch]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: delete post
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM blog_posts WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('[blog/delete]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
