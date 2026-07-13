'use strict';
const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const jwt      = require('jsonwebtoken');
const { pool } = require('../database');
const { requireAuth } = require('./auth');
const { requireUser } = require('./users');
const asyncHandler = require('../lib/asyncHandler');
const { sanitizeText } = require('../security');
const { makeUploader, persist, remove } = require('../storage');
const router   = express.Router();
const SECRET   = process.env.JWT_SECRET;

// Local fallback dir (only used when Cloudinary is not configured)
const dmiUploadsDir = path.join(__dirname, '../uploads/dmi');

// DMI files persist to Cloudinary in production (Render disk is wiped on deploy).
// Files (including the optional preview clip) are capped at 100 MB each.
const MAX_UPLOAD = 100 * 1024 * 1024; // 100 MB
const upload = makeUploader({
  subdir: 'dmi',
  limits: { fileSize: MAX_UPLOAD },
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

// Main content file + an optional short preview video (viewable before purchase)
const dmiUploadFields = upload.fields([
  { name: 'file',    maxCount: 1 },
  { name: 'preview', maxCount: 1 },
]);

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
router.get('/download/:filename', asyncHandler(async (req, res) => {
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
}));

// ── Public catalog: anyone can browse (logged in or not) ──────────────────
// Titles, descriptions and preview clips are visible to EVERYONE so visitors can
// browse and preview before buying. The full content (file_path / external_url)
// is only exposed to admins or APPROVED (paid) users whose plan grants access.
router.get('/', asyncHandler(async (req, res) => {
  let userPlan = null, userApproved = false, isAdmin = false, userId = null;
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    try {
      const payload = jwt.verify(auth.slice(7), SECRET);
      if (payload.role === 'admin') {
        isAdmin = true;
      } else {
        const [rows] = await pool.query('SELECT plan, approved FROM users WHERE id = ?', [payload.id]);
        if (rows[0]) { userPlan = rows[0].plan; userApproved = !!rows[0].approved; userId = payload.id; }
      }
    } catch {}
  }

  const { category } = req.query;
  let query  = 'SELECT * FROM dmi_content WHERE published = 1';
  const params = [];
  if (category) { query += ' AND category = ?'; params.push(category); }
  query += ' ORDER BY sort_order ASC, created_at DESC';

  const [all] = await pool.query(query, params);

  // Public like counts, and (for a logged-in user) which items they liked/bookmarked.
  const [likeRows] = await pool.query('SELECT dmi_id, COUNT(*) AS c FROM dmi_likes GROUP BY dmi_id');
  const likeCounts = {}; likeRows.forEach(r => { likeCounts[r.dmi_id] = Number(r.c); });
  let myLikes = new Set(), myBookmarks = new Set();
  if (userId) {
    const [lk] = await pool.query('SELECT dmi_id FROM dmi_likes WHERE user_id = ?', [userId]);
    const [bm] = await pool.query('SELECT dmi_id FROM dmi_bookmarks WHERE user_id = ?', [userId]);
    myLikes = new Set(lk.map(r => r.dmi_id));
    myBookmarks = new Set(bm.map(r => r.dmi_id));
  }

  // Free ('all') content stays open to everyone. Paid content requires payment
  // approval (not merely a plan on the account) AND a plan that grants access.
  const grants = (item) =>
    isAdmin ||
    item.plan_access === 'all' ||
    (userApproved && canAccess(userPlan, item.plan_access));
  const items = all.map(item => {
    const ok = grants(item);
    return {
      ...item,
      accessible:   ok,
      file_path:    ok ? item.file_path    : null,
      file_name:    ok ? item.file_name    : null,
      external_url: ok ? item.external_url : null,
      // preview_url is intentionally always exposed — it is the free preview clip.
      like_count:   likeCounts[item.id] || 0,
      liked:        myLikes.has(item.id),
      bookmarked:   myBookmarks.has(item.id),
    };
  });

  res.json({ items, userPlan });
}));

// ── User: list bookmarked courses ("Saved Courses") ────────────────────────
router.get('/bookmarks', requireUser, asyncHandler(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT d.* FROM dmi_bookmarks b JOIN dmi_content d ON d.id = b.dmi_id
     WHERE b.user_id = ? AND d.published = 1 ORDER BY b.created_at DESC`,
    [req.user.id]
  );
  const [urows] = await pool.query('SELECT plan, approved FROM users WHERE id = ?', [req.user.id]);
  const u = urows[0] || {};
  const grants = (item) => item.plan_access === 'all' || (!!u.approved && canAccess(u.plan, item.plan_access));
  const items = rows.map(item => {
    const ok = grants(item);
    return { ...item, accessible: ok, bookmarked: true,
      file_path:    ok ? item.file_path    : null,
      external_url: ok ? item.external_url : null };
  });
  res.json({ items });
}));

// ── User: toggle like (public counts; login required) ──────────────────────
router.post('/:id/like', requireUser, asyncHandler(async (req, res) => {
  const dmiId = parseInt(req.params.id);
  const [existing] = await pool.query('SELECT id FROM dmi_likes WHERE dmi_id = ? AND user_id = ?', [dmiId, req.user.id]);
  let liked;
  if (existing[0]) {
    await pool.query('DELETE FROM dmi_likes WHERE dmi_id = ? AND user_id = ?', [dmiId, req.user.id]);
    liked = false;
  } else {
    await pool.query('INSERT INTO dmi_likes (dmi_id, user_id) VALUES (?, ?) ON CONFLICT (dmi_id, user_id) DO NOTHING', [dmiId, req.user.id]);
    liked = true;
  }
  const [cnt] = await pool.query('SELECT COUNT(*) AS c FROM dmi_likes WHERE dmi_id = ?', [dmiId]);
  res.json({ liked, like_count: Number(cnt[0].c) });
}));

// ── User: toggle bookmark (login required) ─────────────────────────────────
router.post('/:id/bookmark', requireUser, asyncHandler(async (req, res) => {
  const dmiId = parseInt(req.params.id);
  const [existing] = await pool.query('SELECT id FROM dmi_bookmarks WHERE dmi_id = ? AND user_id = ?', [dmiId, req.user.id]);
  let bookmarked;
  if (existing[0]) {
    await pool.query('DELETE FROM dmi_bookmarks WHERE dmi_id = ? AND user_id = ?', [dmiId, req.user.id]);
    bookmarked = false;
  } else {
    await pool.query('INSERT INTO dmi_bookmarks (dmi_id, user_id) VALUES (?, ?) ON CONFLICT (dmi_id, user_id) DO NOTHING', [dmiId, req.user.id]);
    bookmarked = true;
  }
  res.json({ bookmarked });
}));

// ── Admin: list all content ────────────────────────────────────────────────
router.get('/admin', requireAuth, asyncHandler(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM dmi_content ORDER BY sort_order ASC, created_at DESC');
  res.json({ items: rows });
}));

// ── Admin: upload new DMI resource ─────────────────────────────────────────
router.post('/', requireAuth, dmiUploadFields, asyncHandler(async (req, res) => {
  const { title, description, type, external_url, plan_access, category, sort_order } = req.body;
  if (!title) return res.status(400).json({ error: 'Title is required' });

  const mainFile    = req.files?.file?.[0]    || null;
  const previewFile = req.files?.preview?.[0] || null;

  const { url: file_path } = await persist(mainFile, {
    folder: 'seedsads/dmi', subdir: 'dmi', resourceType: dmiResourceType(mainFile, type),
  });
  // Preview clip is always treated as a video and is publicly viewable (not gated).
  const { url: preview_url } = await persist(previewFile, {
    folder: 'seedsads/dmi/previews', subdir: 'dmi', resourceType: 'video',
  });
  const file_name = mainFile ? mainFile.originalname : null;

  const [result] = await pool.query(
    `INSERT INTO dmi_content (title, description, type, file_path, file_name, preview_url, external_url, plan_access, category, sort_order)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [title, description || null, type || 'pdf', file_path, file_name, preview_url,
     external_url || null, plan_access || 'all', category || null, parseInt(sort_order) || 0]
  );
  res.json({ success: true, id: result.insertId });
}));

// ── Admin: update DMI resource ─────────────────────────────────────────────
router.patch('/:id', requireAuth, dmiUploadFields, asyncHandler(async (req, res) => {
  const { title, description, type, external_url, plan_access, category, sort_order, published } = req.body;
  const [existing] = await pool.query('SELECT * FROM dmi_content WHERE id = ?', [req.params.id]);
  if (!existing[0]) return res.status(404).json({ error: 'Not found' });

  const mainFile    = req.files?.file?.[0]    || null;
  const previewFile = req.files?.preview?.[0] || null;

  let file_path   = existing[0].file_path;
  let file_name   = existing[0].file_name;
  let preview_url = existing[0].preview_url;

  if (mainFile) {
    const out = await persist(mainFile, {
      folder: 'seedsads/dmi', subdir: 'dmi', resourceType: dmiResourceType(mainFile, type),
    });
    // Replace old file (best-effort) to avoid orphaned storage
    await remove(existing[0].file_path, { resourceType: dmiResourceType(mainFile, type) });
    file_path = out.url;
    file_name = mainFile.originalname;
  }
  if (previewFile) {
    const out = await persist(previewFile, {
      folder: 'seedsads/dmi/previews', subdir: 'dmi', resourceType: 'video',
    });
    await remove(existing[0].preview_url, { resourceType: 'video' });
    preview_url = out.url;
  }

  await pool.query(
    `UPDATE dmi_content SET
      title        = COALESCE(?, title),
      description  = COALESCE(?, description),
      type         = COALESCE(?, type),
      file_path    = ?,
      file_name    = ?,
      preview_url  = ?,
      external_url = COALESCE(?, external_url),
      plan_access  = COALESCE(?, plan_access),
      category     = COALESCE(?, category),
      sort_order   = COALESCE(?, sort_order),
      published    = COALESCE(?, published),
      updated_at   = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [title || null, description || null, type || null, file_path, file_name, preview_url,
     external_url || null, plan_access || null, category || null,
     sort_order !== undefined ? parseInt(sort_order) : null,
     published  !== undefined ? parseInt(published)  : null,
     req.params.id]
  );
  res.json({ success: true });
}));

// ── Admin: delete DMI resource ─────────────────────────────────────────────
router.delete('/:id', requireAuth, asyncHandler(async (req, res) => {
  const [rows] = await pool.query('SELECT file_path, preview_url FROM dmi_content WHERE id = ?', [req.params.id]);
  if (rows[0]) {
    if (rows[0].file_path)   await remove(rows[0].file_path);
    if (rows[0].preview_url) await remove(rows[0].preview_url, { resourceType: 'video' });
  }
  await pool.query('DELETE FROM dmi_content WHERE id = ?', [req.params.id]);
  res.json({ success: true });
}));

module.exports = router;
