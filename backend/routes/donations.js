'use strict';
/**
 * donations.js — "Donate to us" flow.
 *
 * Flow:
 *   1. Frontend POST /init  → we create a pending donation, return { reference, publicKey }
 *   2. Frontend opens the Flutterwave inline popup with that reference as tx_ref
 *   3. On success the popup callback hits GET /verify/:reference (server confirms with Flutterwave)
 *   4. Flutterwave also calls POST /webhook/flutterwave (reliable server-to-server confirmation)
 *
 * Paystack can be added later as a second gateway without changing the schema.
 */
const express  = require('express');
const crypto   = require('crypto');
const { pool } = require('../database');
const { requireAuth } = require('./auth');
const asyncHandler = require('../lib/asyncHandler');
const { sanitizeText, sanitizeEmail } = require('../security');
const router   = express.Router();

const FLW_PUBLIC  = process.env.FLUTTERWAVE_PUBLIC_KEY  || '';
const FLW_SECRET  = process.env.FLUTTERWAVE_SECRET_KEY  || '';
const FLW_WH_HASH = process.env.FLUTTERWAVE_WEBHOOK_HASH || '';

const MIN_AMOUNT = 100;          // ₦100 floor
const MAX_AMOUNT = 100000000;    // sanity ceiling

// Mark a donation paid exactly once (idempotent)
async function markDonationPaid(reference) {
  const [r] = await pool.query(
    "UPDATE donations SET status = 'paid', paid_at = CURRENT_TIMESTAMP WHERE reference = ? AND status <> 'paid'",
    [reference]
  );
  return (r && r.affectedRows) > 0;
}

// ── Public: start a donation ────────────────────────────────────────────────
router.post('/init', asyncHandler(async (req, res) => {
  const amount   = Math.round(Number(req.body.amount) * 100) / 100;
  const currency = sanitizeText(req.body.currency, 10) || 'NGN';
  const name     = sanitizeText(req.body.name, 200);
  const email    = sanitizeEmail(req.body.email);
  const message  = sanitizeText(req.body.message, 500);

  if (!amount || isNaN(amount) || amount < MIN_AMOUNT || amount > MAX_AMOUNT) {
    return res.status(400).json({ error: `Enter a valid amount (minimum ${currency} ${MIN_AMOUNT}).` });
  }

  const reference = 'DONATE-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex');
  await pool.query(
    `INSERT INTO donations (reference, donor_name, donor_email, message, amount, currency, gateway, status)
     VALUES (?,?,?,?,?,?,?,?)`,
    [reference, name, email, message, amount, currency, 'flutterwave', 'pending']
  );

  if (!FLW_PUBLIC) {
    return res.status(503).json({
      error: 'Donations are not configured yet. Add FLUTTERWAVE_PUBLIC_KEY to enable giving.',
      demo: true, reference, amount, currency,
    });
  }
  res.json({ reference, publicKey: FLW_PUBLIC, amount, currency });
}));

// ── Public: verify a donation after the popup closes ─────────────────────────
router.get('/verify/:reference', asyncHandler(async (req, res) => {
  const reference = sanitizeText(req.params.reference, 120);
  const [rows] = await pool.query('SELECT * FROM donations WHERE reference = ?', [reference]);
  const donation = rows[0];
  if (!donation) return res.status(404).json({ error: 'Donation not found' });
  if (donation.status === 'paid') return res.json({ status: 'paid', donation });

  if (FLW_SECRET) {
    const r = await fetch(
      'https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=' + encodeURIComponent(reference),
      { headers: { Authorization: 'Bearer ' + FLW_SECRET } }
    );
    const data = await r.json();
    if (data.status === 'success' && data.data &&
        data.data.status === 'successful' &&
        Number(data.data.amount) >= Number(donation.amount)) {
      await markDonationPaid(reference);
      return res.json({ status: 'paid', donation: { ...donation, status: 'paid' } });
    }
  }
  res.json({ status: donation.status, donation });
}));

// ── Webhook: Flutterwave server-to-server confirmation ───────────────────────
// req.body is a raw Buffer here (see express.raw mount in server.js)
router.post('/webhook/flutterwave', async (req, res) => {
  try {
    if (!FLW_WH_HASH) return res.sendStatus(200);
    const sig = req.headers['verif-hash'];
    if (!sig || sig !== FLW_WH_HASH) return res.sendStatus(401);

    const raw   = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : JSON.stringify(req.body);
    const event = JSON.parse(raw);
    const d = event.data || {};
    if ((event.event === 'charge.completed' || d.status === 'successful') && d.tx_ref) {
      await markDonationPaid(d.tx_ref);
    }
    res.sendStatus(200);
  } catch (err) {
    console.error('[donations/webhook]', err.message);
    res.sendStatus(200);
  }
});

// ── Admin: list donations + totals ───────────────────────────────────────────
router.get('/', requireAuth, asyncHandler(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM donations ORDER BY created_at DESC');
  const [tot]  = await pool.query(
    "SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS count FROM donations WHERE status = 'paid'"
  );
  res.json({ donations: rows, totalRaised: Number(tot[0].total), paidCount: Number(tot[0].count) });
}));

module.exports = router;
