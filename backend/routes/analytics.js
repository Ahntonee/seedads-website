const express = require('express');
const db = require('../database');
const { requireAuth } = require('./auth');
const router = express.Router();

// Public: log a page view (called by the frontend tracker)
router.post('/pageview', (req, res) => {
  const { path, referrer } = req.body;
  if (!path) return res.status(400).json({ error: 'path required' });
  db.prepare('INSERT INTO page_views (path, referrer) VALUES (?, ?)').run(
    path.slice(0, 300),
    (referrer || '').slice(0, 300) || null
  );
  res.json({ ok: true });
});

// Admin: top pages + daily totals for last 30 days
router.get('/pageviews', requireAuth, (req, res) => {
  const topPages = db.prepare(`
    SELECT path, COUNT(*) as views
    FROM page_views
    WHERE created_at >= datetime('now', '-30 days')
    GROUP BY path ORDER BY views DESC LIMIT 20
  `).all();

  const daily = db.prepare(`
    SELECT date(created_at) as day, COUNT(*) as views
    FROM page_views
    WHERE created_at >= datetime('now', '-30 days')
    GROUP BY day ORDER BY day ASC
  `).all();

  const total = db.prepare(`SELECT COUNT(*) as c FROM page_views WHERE created_at >= datetime('now','-30 days')`).get().c;
  const todayViews = db.prepare(`SELECT COUNT(*) as c FROM page_views WHERE date(created_at) = date('now')`).get().c;

  res.json({ topPages, daily, total, todayViews });
});

// Admin: full overview (existing)
router.get('/overview', requireAuth, (req, res) => {
  const totalContacts = db.prepare('SELECT COUNT(*) as c FROM contacts').get().c;
  const newContacts   = db.prepare("SELECT COUNT(*) as c FROM contacts WHERE status = 'new'").get().c;
  const totalLeads    = db.prepare('SELECT COUNT(*) as c FROM leads').get().c;
  const activeLeads   = db.prepare("SELECT COUNT(*) as c FROM leads WHERE status IN ('prospect','qualified','proposal')").get().c;
  const totalRevenue  = db.prepare("SELECT COALESCE(SUM(value),0) as r FROM leads WHERE status = 'client'").get().r;
  const totalPosts    = db.prepare('SELECT COUNT(*) as c FROM blog_posts').get().c;

  const recentContacts = db.prepare(
    "SELECT name, email, service, created_at FROM contacts ORDER BY created_at DESC LIMIT 5"
  ).all();

  const contactsByStatus = db.prepare(
    "SELECT status, COUNT(*) as count FROM contacts GROUP BY status"
  ).all();

  const leadsByStatus = db.prepare(
    "SELECT status, COUNT(*) as count FROM leads GROUP BY status"
  ).all();

  const revenueByPlan = db.prepare(
    "SELECT plan, COALESCE(SUM(value),0) as total FROM leads WHERE status='client' GROUP BY plan"
  ).all();

  res.json({
    stats: { totalContacts, newContacts, totalLeads, activeLeads, totalRevenue, totalPosts },
    recentContacts,
    contactsByStatus,
    leadsByStatus,
    revenueByPlan,
  });
});

module.exports = router;
