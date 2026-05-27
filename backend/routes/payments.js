const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../database');
const { requireAuth } = require('./auth');
const { requireUser } = require('./users');
const mailer = require('../mailer');
const router = express.Router();

const uploadDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, uploadDir),
  filename: (_, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `receipt_${Date.now()}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.pdf'];
    if (allowed.includes(path.extname(file.originalname).toLowerCase())) cb(null, true);
    else cb(new Error('Only images and PDF files are allowed'));
  },
});

// User: submit payment receipt
router.post('/upload', requireUser, upload.single('receipt'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const { plan, amount } = req.body;

  const result = db.prepare(
    'INSERT INTO payments (user_id, plan, amount, receipt_path, receipt_filename, status) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(req.user.id, plan || null, amount || null, req.file.filename, req.file.originalname, 'pending');

  db.prepare("UPDATE users SET payment_status = 'pending' WHERE id = ?").run(req.user.id);

  // Notify admin
  const user = db.prepare('SELECT first_name, last_name, email FROM users WHERE id = ?').get(req.user.id);
  if (user) mailer.notifyPaymentUploaded({ ...user, plan: plan || null, amount: amount || null }).catch(() => {});

  res.json({ success: true, id: result.lastInsertRowid, filename: req.file.filename });
});

// User: get own payment history
router.get('/mine', requireUser, (req, res) => {
  const payments = db.prepare('SELECT * FROM payments WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
  res.json({ payments });
});

// Admin: list all payments
router.get('/', requireAuth, (req, res) => {
  const { status } = req.query;
  let query = `
    SELECT p.*, u.first_name, u.last_name, u.email, u.phone
    FROM payments p
    JOIN users u ON p.user_id = u.id
    WHERE 1=1
  `;
  const params = [];
  if (status) { query += ' AND p.status = ?'; params.push(status); }
  query += ' ORDER BY p.created_at DESC';
  const payments = db.prepare(query).all(...params);
  res.json({ payments });
});

// Admin: approve payment
router.patch('/:id/approve', requireAuth, (req, res) => {
  const { admin_note } = req.body;
  const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(req.params.id);
  if (!payment) return res.status(404).json({ error: 'Payment not found' });

  db.prepare(
    "UPDATE payments SET status = 'approved', admin_note = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?"
  ).run(admin_note || null, req.admin.id, req.params.id);

  db.prepare(
    "UPDATE users SET payment_status = 'paid', approved = 1, approved_at = CURRENT_TIMESTAMP WHERE id = ?"
  ).run(payment.user_id);

  // Email user
  const approvedUser = db.prepare('SELECT first_name, email, plan FROM users WHERE id = ?').get(payment.user_id);
  if (approvedUser) mailer.notifyPaymentApproved({ ...approvedUser, admin_note: admin_note || null }).catch(() => {});

  res.json({ success: true });
});

// Admin: reject payment
router.patch('/:id/reject', requireAuth, (req, res) => {
  const { admin_note } = req.body;
  const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(req.params.id);
  if (!payment) return res.status(404).json({ error: 'Payment not found' });

  db.prepare(
    "UPDATE payments SET status = 'rejected', admin_note = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?"
  ).run(admin_note || null, req.admin.id, req.params.id);

  db.prepare(
    "UPDATE users SET payment_status = 'unpaid', approved = 0 WHERE id = ?"
  ).run(payment.user_id);

  // Email user
  const rejectedUser = db.prepare('SELECT first_name, email FROM users WHERE id = ?').get(payment.user_id);
  if (rejectedUser) mailer.notifyPaymentRejected({ ...rejectedUser, admin_note: admin_note || null }).catch(() => {});

  res.json({ success: true });
});

module.exports = router;
