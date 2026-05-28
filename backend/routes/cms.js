'use strict';
const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const multer   = require('multer');
const { pool } = require('../database');
const { requireAuth } = require('./auth');
const { sanitizeText } = require('../security');
const router   = express.Router();

// ── Image upload (CMS media) ──────────────────────────────────────────────────
const cmsStorage = multer.diskStorage({
  destination(req, file, cb) {
    const dir = path.join(__dirname, '../uploads/cms');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, Date.now() + '-' + Math.random().toString(36).slice(2, 8) + ext);
  },
});
const cmsUpload = multer({
  storage: cmsStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    if (/^image\/(jpeg|png|gif|webp|svg\+xml)$/.test(file.mimetype)) cb(null, true);
    else cb(Object.assign(new Error('Only image files are allowed'), { status: 400 }));
  },
});

// POST /api/cms/upload
router.post('/upload', requireAuth, cmsUpload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({ url: '/uploads/cms/' + req.file.filename, filename: req.file.filename });
});

// GET /api/cms/media
router.get('/media', requireAuth, (req, res) => {
  const dir = path.join(__dirname, '../uploads/cms');
  try {
    fs.mkdirSync(dir, { recursive: true });
    const files = fs.readdirSync(dir)
      .filter(f => /\.(jpe?g|png|gif|webp|svg)$/i.test(f))
      .map(f => {
        const stat = fs.statSync(path.join(dir, f));
        return { url: '/uploads/cms/' + f, filename: f, size: stat.size, mtime: stat.mtime };
      })
      .sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
    res.json({ files });
  } catch { res.json({ files: [] }); }
});

// DELETE /api/cms/media/:filename
router.delete('/media/:filename', requireAuth, (req, res) => {
  const safe = path.basename(req.params.filename);
  const fp   = path.join(__dirname, '../uploads/cms', safe);
  try { fs.unlinkSync(fp); res.json({ success: true }); }
  catch { res.status(404).json({ error: 'File not found' }); }
});

// Helper: build dynamic SET clause for UPDATE using ? placeholders
function buildUpdate(body, fields, maxLens) {
  const sets = [], vals = [];
  fields.forEach(f => {
    if (body[f] !== undefined) {
      sets.push(`${f} = ?`);
      vals.push(sanitizeText(body[f], maxLens[f] || 500));
    }
  });
  return { sets, vals };
}

// ── PRICING PLANS ─────────────────────────────────────────────────────────────
router.get('/pricing-plans', async (_req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM pricing_plans WHERE published = 1 ORDER BY sort_order ASC');
    res.json({ plans: rows });
  } catch (err) { console.error('[cms/pricing-plans GET]', err.message); res.status(500).json({ error: 'Internal server error' }); }
});

router.post('/pricing-plans', requireAuth, async (req, res) => {
  try {
    const name          = sanitizeText(req.body.name, 100);
    const price         = sanitizeText(req.body.price, 50);
    const billing       = sanitizeText(req.body.billing, 50);
    const description   = sanitizeText(req.body.description, 500);
    const features      = sanitizeText(req.body.features, 5000);
    const is_popular    = req.body.is_popular ? 1 : 0;
    const badge_text    = sanitizeText(req.body.badge_text, 100);
    const badge_color   = sanitizeText(req.body.badge_color, 200);
    const button_text   = sanitizeText(req.body.button_text, 50) || 'Get Started';
    const button_style  = sanitizeText(req.body.button_style, 50) || 'secondary';
    const button_color  = sanitizeText(req.body.button_color, 200);
    const register_plan = sanitizeText(req.body.register_plan, 100);
    const sort_order    = parseInt(req.body.sort_order) || 0;
    const published     = req.body.published !== undefined ? (req.body.published ? 1 : 0) : 1;
    if (!name) return res.status(400).json({ error: 'Name is required' });
    const [result] = await pool.query(
      `INSERT INTO pricing_plans
         (name,price,billing,description,features,is_popular,badge_text,badge_color,
          button_text,button_style,button_color,register_plan,sort_order,published)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [name,price,billing,description,features,is_popular,badge_text,badge_color,
       button_text,button_style,button_color,register_plan,sort_order,published]
    );
    res.json({ success: true, id: result.insertId });
  } catch (err) { console.error('[cms/pricing-plans POST]', err.message); res.status(500).json({ error: 'Internal server error' }); }
});

router.patch('/pricing-plans/:id', requireAuth, async (req, res) => {
  try {
    const { sets, vals } = buildUpdate(req.body,
      ['name','price','billing','description','features','badge_text','badge_color',
       'button_text','button_style','button_color','register_plan'],
      { features: 5000, description: 500, badge_color: 200, button_color: 200 }
    );
    if (req.body.is_popular !== undefined) { sets.push('is_popular = ?'); vals.push(req.body.is_popular ? 1 : 0); }
    if (req.body.published  !== undefined) { sets.push('published = ?');  vals.push(req.body.published  ? 1 : 0); }
    if (req.body.sort_order !== undefined) { sets.push('sort_order = ?'); vals.push(parseInt(req.body.sort_order) || 0); }
    if (!sets.length) return res.json({ success: true });
    sets.push('updated_at = CURRENT_TIMESTAMP');
    vals.push(req.params.id);
    await pool.query(`UPDATE pricing_plans SET ${sets.join(', ')} WHERE id = ?`, vals);
    res.json({ success: true });
  } catch (err) { console.error('[cms/pricing-plans PATCH]', err.message); res.status(500).json({ error: 'Internal server error' }); }
});

router.delete('/pricing-plans/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM pricing_plans WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) { console.error('[cms/pricing-plans DELETE]', err.message); res.status(500).json({ error: 'Internal server error' }); }
});

// ── FAQs ──────────────────────────────────────────────────────────────────────
router.get('/faqs', async (_req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM faqs WHERE published = 1 ORDER BY category, sort_order ASC');
    res.json({ faqs: rows });
  } catch (err) { console.error('[cms/faqs GET]', err.message); res.status(500).json({ error: 'Internal server error' }); }
});

router.post('/faqs', requireAuth, async (req, res) => {
  try {
    const question   = sanitizeText(req.body.question, 500);
    const answer     = sanitizeText(req.body.answer, 3000);
    const category   = sanitizeText(req.body.category, 100);
    const sort_order = parseInt(req.body.sort_order) || 0;
    const published  = req.body.published !== undefined ? (req.body.published ? 1 : 0) : 1;
    if (!question) return res.status(400).json({ error: 'Question is required' });
    if (!answer)   return res.status(400).json({ error: 'Answer is required' });
    const [result] = await pool.query(
      'INSERT INTO faqs (question,answer,category,sort_order,published) VALUES (?,?,?,?,?)',
      [question, answer, category, sort_order, published]
    );
    res.json({ success: true, id: result.insertId });
  } catch (err) { console.error('[cms/faqs POST]', err.message); res.status(500).json({ error: 'Internal server error' }); }
});

router.patch('/faqs/:id', requireAuth, async (req, res) => {
  try {
    const { sets, vals } = buildUpdate(req.body, ['question','answer','category'],
      { answer: 3000, question: 500, category: 100 });
    if (req.body.published  !== undefined) { sets.push('published = ?');  vals.push(req.body.published  ? 1 : 0); }
    if (req.body.sort_order !== undefined) { sets.push('sort_order = ?'); vals.push(parseInt(req.body.sort_order) || 0); }
    if (!sets.length) return res.json({ success: true });
    vals.push(req.params.id);
    await pool.query(`UPDATE faqs SET ${sets.join(', ')} WHERE id = ?`, vals);
    res.json({ success: true });
  } catch (err) { console.error('[cms/faqs PATCH]', err.message); res.status(500).json({ error: 'Internal server error' }); }
});

router.delete('/faqs/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM faqs WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) { console.error('[cms/faqs DELETE]', err.message); res.status(500).json({ error: 'Internal server error' }); }
});

// ── TEAM MEMBERS ──────────────────────────────────────────────────────────────
router.get('/team', async (_req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT * FROM team_members WHERE published = 1 ORDER BY CASE team_type WHEN 'leadership' THEN 0 ELSE 1 END, sort_order ASC"
    );
    res.json({ members: rows });
  } catch (err) { console.error('[cms/team GET]', err.message); res.status(500).json({ error: 'Internal server error' }); }
});

router.post('/team', requireAuth, async (req, res) => {
  try {
    const name              = sanitizeText(req.body.name, 200);
    const role              = sanitizeText(req.body.role, 200);
    const bio               = sanitizeText(req.body.bio, 1000);
    const photo_url         = sanitizeText(req.body.photo_url, 500);
    const team_type         = sanitizeText(req.body.team_type, 50) || 'leadership';
    const linkedin_url      = sanitizeText(req.body.linkedin_url, 500);
    const twitter_url       = sanitizeText(req.body.twitter_url, 500);
    const other_social_icon = sanitizeText(req.body.other_social_icon, 100);
    const other_social_url  = sanitizeText(req.body.other_social_url, 500);
    const sort_order        = parseInt(req.body.sort_order) || 0;
    const published         = req.body.published !== undefined ? (req.body.published ? 1 : 0) : 1;
    if (!name) return res.status(400).json({ error: 'Name is required' });
    const [result] = await pool.query(
      `INSERT INTO team_members
         (name,role,bio,photo_url,team_type,linkedin_url,twitter_url,other_social_icon,other_social_url,sort_order,published)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [name,role,bio,photo_url||null,team_type,linkedin_url,twitter_url,other_social_icon,other_social_url,sort_order,published]
    );
    res.json({ success: true, id: result.insertId });
  } catch (err) { console.error('[cms/team POST]', err.message); res.status(500).json({ error: 'Internal server error' }); }
});

router.patch('/team/:id', requireAuth, async (req, res) => {
  try {
    const { sets, vals } = buildUpdate(req.body,
      ['name','role','bio','photo_url','team_type','linkedin_url','twitter_url','other_social_icon','other_social_url'],
      { bio: 1000, name: 200, role: 200, photo_url: 500, linkedin_url: 500, twitter_url: 500, other_social_url: 500 });
    if (req.body.published  !== undefined) { sets.push('published = ?');  vals.push(req.body.published  ? 1 : 0); }
    if (req.body.sort_order !== undefined) { sets.push('sort_order = ?'); vals.push(parseInt(req.body.sort_order) || 0); }
    if (!sets.length) return res.json({ success: true });
    vals.push(req.params.id);
    await pool.query(`UPDATE team_members SET ${sets.join(', ')} WHERE id = ?`, vals);
    res.json({ success: true });
  } catch (err) { console.error('[cms/team PATCH]', err.message); res.status(500).json({ error: 'Internal server error' }); }
});

router.delete('/team/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM team_members WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) { console.error('[cms/team DELETE]', err.message); res.status(500).json({ error: 'Internal server error' }); }
});

// ── PORTFOLIO ─────────────────────────────────────────────────────────────────
router.get('/portfolio', async (_req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM portfolio_items WHERE published = 1 ORDER BY sort_order ASC');
    res.json({ items: rows });
  } catch (err) { console.error('[cms/portfolio GET]', err.message); res.status(500).json({ error: 'Internal server error' }); }
});

router.post('/portfolio', requireAuth, async (req, res) => {
  try {
    const title       = sanitizeText(req.body.title, 200);
    const category    = sanitizeText(req.body.category, 100);
    const description = sanitizeText(req.body.description, 1000);
    const icon        = sanitizeText(req.body.icon, 100);
    const image_url   = sanitizeText(req.body.image_url, 500);
    const s1v = sanitizeText(req.body.stat1_value, 50), s1l = sanitizeText(req.body.stat1_label, 100);
    const s2v = sanitizeText(req.body.stat2_value, 50), s2l = sanitizeText(req.body.stat2_label, 100);
    const s3v = sanitizeText(req.body.stat3_value, 50), s3l = sanitizeText(req.body.stat3_label, 100);
    const sort_order = parseInt(req.body.sort_order) || 0;
    const published  = req.body.published !== undefined ? (req.body.published ? 1 : 0) : 1;
    if (!title) return res.status(400).json({ error: 'Title is required' });
    const [result] = await pool.query(
      `INSERT INTO portfolio_items
         (title,category,description,icon,image_url,stat1_value,stat1_label,stat2_value,stat2_label,stat3_value,stat3_label,sort_order,published)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [title,category,description,icon,image_url||null,s1v,s1l,s2v,s2l,s3v,s3l,sort_order,published]
    );
    res.json({ success: true, id: result.insertId });
  } catch (err) { console.error('[cms/portfolio POST]', err.message); res.status(500).json({ error: 'Internal server error' }); }
});

router.patch('/portfolio/:id', requireAuth, async (req, res) => {
  try {
    const { sets, vals } = buildUpdate(req.body,
      ['title','category','description','icon','image_url','stat1_value','stat1_label','stat2_value','stat2_label','stat3_value','stat3_label'],
      { description: 1000, image_url: 500 });
    if (req.body.published  !== undefined) { sets.push('published = ?');  vals.push(req.body.published  ? 1 : 0); }
    if (req.body.sort_order !== undefined) { sets.push('sort_order = ?'); vals.push(parseInt(req.body.sort_order) || 0); }
    if (!sets.length) return res.json({ success: true });
    vals.push(req.params.id);
    await pool.query(`UPDATE portfolio_items SET ${sets.join(', ')} WHERE id = ?`, vals);
    res.json({ success: true });
  } catch (err) { console.error('[cms/portfolio PATCH]', err.message); res.status(500).json({ error: 'Internal server error' }); }
});

router.delete('/portfolio/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM portfolio_items WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) { console.error('[cms/portfolio DELETE]', err.message); res.status(500).json({ error: 'Internal server error' }); }
});

// ── CASE STUDIES ──────────────────────────────────────────────────────────────
router.get('/case-studies', async (_req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM case_studies WHERE published = 1 ORDER BY sort_order ASC');
    res.json({ studies: rows });
  } catch (err) { console.error('[cms/case-studies GET]', err.message); res.status(500).json({ error: 'Internal server error' }); }
});

router.post('/case-studies', requireAuth, async (req, res) => {
  try {
    const title       = sanitizeText(req.body.title, 200);
    const category    = sanitizeText(req.body.category, 100);
    const description = sanitizeText(req.body.description, 1000);
    const icon        = sanitizeText(req.body.icon, 100);
    const image_url   = sanitizeText(req.body.image_url, 500);
    const s1v = sanitizeText(req.body.stat1_value, 50), s1l = sanitizeText(req.body.stat1_label, 100);
    const s2v = sanitizeText(req.body.stat2_value, 50), s2l = sanitizeText(req.body.stat2_label, 100);
    const s3v = sanitizeText(req.body.stat3_value, 50), s3l = sanitizeText(req.body.stat3_label, 100);
    const sort_order = parseInt(req.body.sort_order) || 0;
    const published  = req.body.published !== undefined ? (req.body.published ? 1 : 0) : 1;
    if (!title) return res.status(400).json({ error: 'Title is required' });
    const [result] = await pool.query(
      `INSERT INTO case_studies
         (title,category,description,icon,image_url,stat1_value,stat1_label,stat2_value,stat2_label,stat3_value,stat3_label,sort_order,published)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [title,category,description,icon,image_url||null,s1v,s1l,s2v,s2l,s3v,s3l,sort_order,published]
    );
    res.json({ success: true, id: result.insertId });
  } catch (err) { console.error('[cms/case-studies POST]', err.message); res.status(500).json({ error: 'Internal server error' }); }
});

router.patch('/case-studies/:id', requireAuth, async (req, res) => {
  try {
    const { sets, vals } = buildUpdate(req.body,
      ['title','category','description','icon','image_url','stat1_value','stat1_label','stat2_value','stat2_label','stat3_value','stat3_label'],
      { description: 1000, image_url: 500 });
    if (req.body.published  !== undefined) { sets.push('published = ?');  vals.push(req.body.published  ? 1 : 0); }
    if (req.body.sort_order !== undefined) { sets.push('sort_order = ?'); vals.push(parseInt(req.body.sort_order) || 0); }
    if (!sets.length) return res.json({ success: true });
    vals.push(req.params.id);
    await pool.query(`UPDATE case_studies SET ${sets.join(', ')} WHERE id = ?`, vals);
    res.json({ success: true });
  } catch (err) { console.error('[cms/case-studies PATCH]', err.message); res.status(500).json({ error: 'Internal server error' }); }
});

router.delete('/case-studies/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM case_studies WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) { console.error('[cms/case-studies DELETE]', err.message); res.status(500).json({ error: 'Internal server error' }); }
});

// ── COURSES ───────────────────────────────────────────────────────────────────
router.get('/courses', async (_req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM courses WHERE published = 1 ORDER BY sort_order ASC');
    res.json({ courses: rows });
  } catch (err) { console.error('[cms/courses GET]', err.message); res.status(500).json({ error: 'Internal server error' }); }
});

router.post('/courses', requireAuth, async (req, res) => {
  try {
    const title          = sanitizeText(req.body.title, 200);
    const description    = sanitizeText(req.body.description, 1000);
    const level          = sanitizeText(req.body.level, 50);
    const duration_hours = parseInt(req.body.duration_hours) || 0;
    const students       = sanitizeText(req.body.students, 50);
    const icon           = sanitizeText(req.body.icon, 100);
    const gradient       = sanitizeText(req.body.gradient, 200);
    const level_color    = sanitizeText(req.body.level_color, 50);
    const sort_order     = parseInt(req.body.sort_order) || 0;
    const published      = req.body.published !== undefined ? (req.body.published ? 1 : 0) : 1;
    if (!title) return res.status(400).json({ error: 'Title is required' });
    const [result] = await pool.query(
      `INSERT INTO courses
         (title,description,level,duration_hours,students,icon,gradient,level_color,sort_order,published)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [title,description,level,duration_hours,students,icon,gradient,level_color,sort_order,published]
    );
    res.json({ success: true, id: result.insertId });
  } catch (err) { console.error('[cms/courses POST]', err.message); res.status(500).json({ error: 'Internal server error' }); }
});

router.patch('/courses/:id', requireAuth, async (req, res) => {
  try {
    const { sets, vals } = buildUpdate(req.body,
      ['title','description','level','students','icon','gradient','level_color'],
      { description: 1000, gradient: 200 });
    if (req.body.duration_hours !== undefined) { sets.push('duration_hours = ?'); vals.push(parseInt(req.body.duration_hours) || 0); }
    if (req.body.published      !== undefined) { sets.push('published = ?');      vals.push(req.body.published      ? 1 : 0); }
    if (req.body.sort_order     !== undefined) { sets.push('sort_order = ?');     vals.push(parseInt(req.body.sort_order) || 0); }
    if (!sets.length) return res.json({ success: true });
    vals.push(req.params.id);
    await pool.query(`UPDATE courses SET ${sets.join(', ')} WHERE id = ?`, vals);
    res.json({ success: true });
  } catch (err) { console.error('[cms/courses PATCH]', err.message); res.status(500).json({ error: 'Internal server error' }); }
});

router.delete('/courses/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM courses WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) { console.error('[cms/courses DELETE]', err.message); res.status(500).json({ error: 'Internal server error' }); }
});

// ── PAGE CONTENT ──────────────────────────────────────────────────────────────
// GET /api/cms/page-content?page=homepage  → { page, sections: { hero:{…}, … } }
router.get('/page-content', async (req, res) => {
  try {
    const page = sanitizeText(req.query.page, 100);
    if (!page) return res.status(400).json({ error: 'page query parameter is required' });
    const [rows] = await pool.query(
      'SELECT section, content FROM page_content WHERE page = ? ORDER BY section',
      [page]
    );
    const sections = {};
    rows.forEach(r => {
      try { sections[r.section] = JSON.parse(r.content); }
      catch { sections[r.section] = r.content; }
    });
    res.json({ page, sections });
  } catch (err) {
    console.error('[cms/page-content GET]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/cms/page-content  body: { page, section, content }
router.put('/page-content', requireAuth, async (req, res) => {
  try {
    const page    = sanitizeText(req.body.page, 100);
    const section = sanitizeText(req.body.section, 100);
    const { content } = req.body;
    if (!page || !section) return res.status(400).json({ error: 'page and section are required' });
    const contentStr = typeof content === 'string' ? content : JSON.stringify(content);
    await pool.query(
      'INSERT INTO page_content (page, section, content) VALUES (?,?,?) ON DUPLICATE KEY UPDATE content = ?',
      [page, section, contentStr, contentStr]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('[cms/page-content PUT]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/cms/page-content/all  → full list for admin (all pages + sections)
router.get('/page-content/all', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT page, section, content, updated_at FROM page_content ORDER BY page, section'
    );
    const result = rows.map(r => {
      let parsed = r.content;
      try { parsed = JSON.parse(r.content); } catch {}
      return { page: r.page, section: r.section, content: parsed, updated_at: r.updated_at };
    });
    res.json({ items: result });
  } catch (err) {
    console.error('[cms/page-content/all GET]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
