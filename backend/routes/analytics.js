'use strict';
const express  = require('express');
const { pool } = require('../database');
const { requireAuth } = require('./auth');
const asyncHandler = require('../lib/asyncHandler');
const router = express.Router();

// Public: log a page view
router.post('/pageview', asyncHandler(async (req, res) => {
  const { path, referrer } = req.body;
  if (!path) return res.status(400).json({ error: 'path required' });
  await pool.query(
    'INSERT INTO page_views (path, referrer) VALUES (?, ?)',
    [path.slice(0, 300), (referrer || '').slice(0, 300) || null]
  );
  res.json({ ok: true });
}));

// Admin: top pages + daily totals for last 30 days
router.get('/pageviews', requireAuth, asyncHandler(async (req, res) => {
  const [topPages] = await pool.query(`
    SELECT path, COUNT(*) as views
    FROM page_views
    WHERE created_at >= NOW() - INTERVAL 30 DAY
    GROUP BY path ORDER BY views DESC LIMIT 20
  `);

  const [daily] = await pool.query(`
    SELECT DATE(created_at) as day, COUNT(*) as views
    FROM page_views
    WHERE created_at >= NOW() - INTERVAL 30 DAY
    GROUP BY day ORDER BY day ASC
  `);

  const [totalRow] = await pool.query(`SELECT COUNT(*) as c FROM page_views WHERE created_at >= NOW() - INTERVAL 30 DAY`);
  const [todayRow] = await pool.query(`SELECT COUNT(*) as c FROM page_views WHERE DATE(created_at) = CURDATE()`);

  res.json({
    topPages,
    daily,
    total:      parseInt(totalRow[0].c),
    todayViews: parseInt(todayRow[0].c),
  });
}));

// Admin: full overview
router.get('/overview', requireAuth, asyncHandler(async (req, res) => {
  const q = (sql, params = []) => pool.query(sql, params).then(([rows]) => rows[0]);

  const [totalContactsRow, newContactsRow, totalLeadsRow, activeLeadsRow, totalRevenueRow, totalPostsRow] = await Promise.all([
    q('SELECT COUNT(*) as c FROM contacts'),
    q("SELECT COUNT(*) as c FROM contacts WHERE status = 'new'"),
    q('SELECT COUNT(*) as c FROM leads'),
    q("SELECT COUNT(*) as c FROM leads WHERE status IN ('prospect','qualified','proposal')"),
    q("SELECT COALESCE(SUM(value),0) as r FROM leads WHERE status = 'client'"),
    q('SELECT COUNT(*) as c FROM blog_posts'),
  ]);

  const [recentContacts]  = await pool.query("SELECT name, email, service, created_at FROM contacts ORDER BY created_at DESC LIMIT 5");
  const [contactsByStatus] = await pool.query("SELECT status, COUNT(*) as count FROM contacts GROUP BY status");
  const [leadsByStatus]    = await pool.query("SELECT status, COUNT(*) as count FROM leads GROUP BY status");
  const [revenueByPlan]    = await pool.query("SELECT plan, COALESCE(SUM(value),0) as total FROM leads WHERE status='client' GROUP BY plan");

  res.json({
    stats: {
      totalContacts: parseInt(totalContactsRow.c),
      newContacts:   parseInt(newContactsRow.c),
      totalLeads:    parseInt(totalLeadsRow.c),
      activeLeads:   parseInt(activeLeadsRow.c),
      totalRevenue:  parseFloat(totalRevenueRow.r),
      totalPosts:    parseInt(totalPostsRow.c),
    },
    recentContacts,
    contactsByStatus,
    leadsByStatus,
    revenueByPlan,
  });
}));

module.exports = router;
