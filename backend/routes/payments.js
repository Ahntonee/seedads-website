'use strict';
const express  = require('express');
const path     = require('path');
const { pool } = require('../database');
const { requireAuth } = require('./auth');
const { requireUser } = require('./users');
const asyncHandler = require('../lib/asyncHandler');
const { makeUploader, persist } = require('../storage');
const mailer   = require('../mailer');
const router   = express.Router();

// Receipts persist to Cloudinary in production (Render's disk is wiped on deploy)
// and to backend/uploads/receipts locally in dev. Random filenames prevent
// receipts from being guessed/enumerated.
const upload = makeUploader({
  subdir: 'receipts',
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.pdf'];
    if (allowed.includes(path.extname(file.originalname).toLowerCase())) cb(null, true);
    else cb(new Error('Only images and PDF files are allowed'));
  },
});

// User: submit payment receipt
router.post('/upload', requireUser, upload.single('receipt'), asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const { plan, amount } = req.body;

  // receipt_path = Cloudinary URL (prod) or /uploads/receipts/<file> (dev)
  const { url: receiptPath } = await persist(req.file, { folder: 'seedsads/receipts', subdir: 'receipts' });

  const [result] = await pool.query(
    'INSERT INTO payments (user_id, plan, amount, receipt_path, receipt_filename, status) VALUES (?,?,?,?,?,?)',
    [req.user.id, plan || null, amount || null, receiptPath, req.file.originalname, 'pending']
  );
  await pool.query("UPDATE users SET payment_status = 'pending' WHERE id = ?", [req.user.id]);

  const [uRows] = await pool.query('SELECT first_name, last_name, email FROM users WHERE id = ?', [req.user.id]);
  if (uRows[0]) mailer.notifyPaymentUploaded({ ...uRows[0], plan: plan || null, amount: amount || null }).catch(() => {});

  res.json({ success: true, id: result.insertId, receipt_path: receiptPath });
}));

// User: get own payment history
router.get('/mine', requireUser, asyncHandler(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM payments WHERE user_id = ? ORDER BY created_at DESC', [req.user.id]);
  res.json({ payments: rows });
}));

// Admin: list all payments
router.get('/', requireAuth, asyncHandler(async (req, res) => {
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
  const [rows] = await pool.query(query, params);
  res.json({ payments: rows });
}));

// Admin: approve payment
router.patch('/:id/approve', requireAuth, asyncHandler(async (req, res) => {
  const { admin_note } = req.body;
  const [rows] = await pool.query('SELECT * FROM payments WHERE id = ?', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Payment not found' });
  const payment = rows[0];

  await pool.query(
    "UPDATE payments SET status = 'approved', admin_note = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?",
    [admin_note || null, req.admin.id, req.params.id]
  );
  await pool.query(
    "UPDATE users SET payment_status = 'paid', approved = 1, approved_at = CURRENT_TIMESTAMP WHERE id = ?",
    [payment.user_id]
  );

  const [uRows] = await pool.query('SELECT first_name, email, plan FROM users WHERE id = ?', [payment.user_id]);
  if (uRows[0]) mailer.notifyPaymentApproved({ ...uRows[0], admin_note: admin_note || null }).catch(() => {});

  res.json({ success: true });
}));

// Admin: reject payment
router.patch('/:id/reject', requireAuth, asyncHandler(async (req, res) => {
  const { admin_note } = req.body;
  const [rows] = await pool.query('SELECT * FROM payments WHERE id = ?', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Payment not found' });
  const payment = rows[0];

  await pool.query(
    "UPDATE payments SET status = 'rejected', admin_note = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?",
    [admin_note || null, req.admin.id, req.params.id]
  );
  await pool.query(
    "UPDATE users SET payment_status = 'unpaid', approved = 0 WHERE id = ?",
    [payment.user_id]
  );

  const [uRows] = await pool.query('SELECT first_name, email FROM users WHERE id = ?', [payment.user_id]);
  if (uRows[0]) mailer.notifyPaymentRejected({ ...uRows[0], admin_note: admin_note || null }).catch(() => {});

  res.json({ success: true });
}));

module.exports = router;
