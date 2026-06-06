'use strict';
const express  = require('express');
const crypto   = require('crypto');
const { pool } = require('../database');
const { requireAuth } = require('./auth');
const { sanitizeText } = require('../security');
const router   = express.Router();

// ── Payment gateway config (optional — endpoints degrade gracefully if absent) ──
const PAYSTACK_SECRET        = process.env.PAYSTACK_SECRET_KEY   || '';
const STRIPE_SECRET          = process.env.STRIPE_SECRET_KEY     || '';
const STRIPE_WEBHOOK_SECRET  = process.env.STRIPE_WEBHOOK_SECRET || '';
const SITE_URL               = (process.env.SITE_URL || '').replace(/\/$/, '');

// Mark an order paid exactly once (idempotent). Returns true if it transitioned.
async function markOrderPaid(reference) {
  const [r] = await pool.query(
    "UPDATE shop_orders SET status = 'paid', paid_at = CURRENT_TIMESTAMP WHERE reference = ? AND status <> 'paid'",
    [reference]
  );
  return (r && r.affectedRows) > 0;
}

// Verify a Stripe webhook signature manually (avoids adding the stripe SDK).
// Header format: "t=timestamp,v1=signature". signed_payload = `${t}.${rawBody}`.
function verifyStripeSignature(rawBody, sigHeader, secret) {
  if (!sigHeader || !secret) return false;
  const parts = Object.fromEntries(sigHeader.split(',').map(kv => kv.split('=')));
  const t = parts.t, v1 = parts.v1;
  if (!t || !v1) return false;
  // Reject events older than 5 minutes (replay protection)
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(v1), Buffer.from(expected));
  } catch { return false; }
}

// ── Helpers ─────────────────────────────────────────────────────────────────────
function parseImages(raw) {
  if (!raw) return [];
  try { const a = JSON.parse(raw); return Array.isArray(a) ? a : []; }
  catch { return []; }
}
function shapeProduct(p) {
  return { ...p, images: parseImages(p.images), price: Number(p.price), compare_at: p.compare_at != null ? Number(p.compare_at) : null };
}
function genReference() {
  return 'SEEDS-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex');
}

const VALID_CATEGORIES = ['new', 'featured', 'trending', 'best_seller', 'hot', 'regular'];

// ════════════════════════════════════════════════════════════════════════════════
//  PUBLIC — Products
// ════════════════════════════════════════════════════════════════════════════════

// GET /api/shop/products?category=
router.get('/products', async (req, res) => {
  try {
    const category = sanitizeText(req.query.category, 50);
    let sql = 'SELECT * FROM shop_products WHERE published = 1';
    const params = [];
    if (category && category !== 'all' && VALID_CATEGORIES.includes(category)) {
      sql += ' AND category = ?'; params.push(category);
    }
    sql += ' ORDER BY sort_order ASC, created_at DESC';
    const [rows] = await pool.query(sql, params);
    res.json({ products: rows.map(shapeProduct) });
  } catch (err) {
    console.error('[shop/products GET]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/shop/products/:id
router.get('/products/:id', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM shop_products WHERE id = ?', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Product not found' });
    res.json({ product: shapeProduct(rows[0]) });
  } catch (err) {
    console.error('[shop/product GET]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ════════════════════════════════════════════════════════════════════════════════
//  ADMIN — Product management
// ════════════════════════════════════════════════════════════════════════════════

function readProductBody(body) {
  let images = body.images;
  if (Array.isArray(images)) images = images.filter(Boolean).slice(0, 12);
  else images = [];
  const category = VALID_CATEGORIES.includes(body.category) ? body.category : 'new';
  return {
    name:        sanitizeText(body.name, 200),
    description: sanitizeText(body.description, 2000),
    category,
    price:       Math.max(0, parseFloat(body.price) || 0),
    compare_at:  body.compare_at !== undefined && body.compare_at !== null && body.compare_at !== ''
                   ? Math.max(0, parseFloat(body.compare_at) || 0) : null,
    currency:    sanitizeText(body.currency, 10) || 'NGN',
    images:      JSON.stringify(images),
    badge:       sanitizeText(body.badge, 50),
    sku:         sanitizeText(body.sku, 100),
    in_stock:    body.in_stock !== undefined ? (body.in_stock ? 1 : 0) : 1,
    sort_order:  parseInt(body.sort_order) || 0,
    published:   body.published !== undefined ? (body.published ? 1 : 0) : 1,
  };
}

// POST /api/shop/products
router.post('/products', requireAuth, async (req, res) => {
  try {
    const p = readProductBody(req.body);
    if (!p.name) return res.status(400).json({ error: 'Product name is required' });
    const [result] = await pool.query(
      `INSERT INTO shop_products
         (name,description,category,price,compare_at,currency,images,badge,sku,in_stock,sort_order,published)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [p.name, p.description, p.category, p.price, p.compare_at, p.currency, p.images, p.badge, p.sku, p.in_stock, p.sort_order, p.published]
    );
    res.json({ success: true, id: result.insertId });
  } catch (err) {
    console.error('[shop/products POST]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/shop/products/:id
router.patch('/products/:id', requireAuth, async (req, res) => {
  try {
    const p = readProductBody(req.body);
    if (!p.name) return res.status(400).json({ error: 'Product name is required' });
    await pool.query(
      `UPDATE shop_products SET
         name=?, description=?, category=?, price=?, compare_at=?, currency=?,
         images=?, badge=?, sku=?, in_stock=?, sort_order=?, published=?
       WHERE id=?`,
      [p.name, p.description, p.category, p.price, p.compare_at, p.currency, p.images, p.badge, p.sku, p.in_stock, p.sort_order, p.published, req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('[shop/products PATCH]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/shop/products/:id
router.delete('/products/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM shop_products WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('[shop/products DELETE]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ════════════════════════════════════════════════════════════════════════════════
//  CHECKOUT
// ════════════════════════════════════════════════════════════════════════════════

// Recompute the order total server-side from real product prices (never trust the client).
async function buildOrderFromCart(cart) {
  if (!Array.isArray(cart) || !cart.length) throw new Error('Cart is empty');
  const ids = cart.map(i => parseInt(i.id)).filter(Boolean);
  if (!ids.length) throw new Error('Invalid cart');
  const placeholders = ids.map(() => '?').join(',');
  const [rows] = await pool.query(
    `SELECT * FROM shop_products WHERE id IN (${placeholders}) AND published = 1`, ids
  );
  const byId = {};
  rows.forEach(r => { byId[r.id] = r; });

  let amount = 0;
  let currency = 'NGN';
  const items = [];
  for (const line of cart) {
    const prod = byId[parseInt(line.id)];
    if (!prod) continue;
    const qty = Math.max(1, Math.min(99, parseInt(line.qty) || 1));
    const price = Number(prod.price);
    amount += price * qty;
    currency = prod.currency || 'NGN';
    items.push({ id: prod.id, name: prod.name, price, qty });
  }
  if (!items.length) throw new Error('No valid products in cart');
  return { amount: Math.round(amount * 100) / 100, currency, items };
}

// POST /api/shop/checkout/paystack   { cart:[{id,qty}], customer:{name,email,phone} }
router.post('/checkout/paystack', async (req, res) => {
  try {
    const { cart, customer } = req.body;
    const email = sanitizeText(customer?.email, 200);
    if (!email) return res.status(400).json({ error: 'Email is required' });
    const { amount, currency, items } = await buildOrderFromCart(cart);

    const reference = genReference();
    await pool.query(
      `INSERT INTO shop_orders (reference,customer_name,customer_email,customer_phone,items,amount,currency,gateway,status)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [reference, sanitizeText(customer?.name, 200), email, sanitizeText(customer?.phone, 50),
       JSON.stringify(items), amount, currency, 'paystack', 'pending']
    );

    if (!PAYSTACK_SECRET) {
      return res.status(503).json({
        error: 'Paystack is not configured yet. Add PAYSTACK_SECRET_KEY to enable live payments.',
        demo: true, reference, amount, currency,
      });
    }

    const callback_url = (SITE_URL || `${req.protocol}://${req.get('host')}`) + '/shop.html?ref=' + reference;
    const r = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + PAYSTACK_SECRET, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, amount: Math.round(amount * 100), reference, currency, callback_url }),
    });
    const data = await r.json();
    if (!data.status) throw new Error(data.message || 'Paystack initialization failed');
    res.json({ authorization_url: data.data.authorization_url, reference });
  } catch (err) {
    console.error('[shop/checkout/paystack]', err.message);
    res.status(400).json({ error: err.message });
  }
});

// POST /api/shop/checkout/stripe   { cart:[{id,qty}], customer:{name,email,phone} }
router.post('/checkout/stripe', async (req, res) => {
  try {
    const { cart, customer } = req.body;
    const email = sanitizeText(customer?.email, 200);
    if (!email) return res.status(400).json({ error: 'Email is required' });
    const { amount, currency, items } = await buildOrderFromCart(cart);

    const reference = genReference();
    await pool.query(
      `INSERT INTO shop_orders (reference,customer_name,customer_email,customer_phone,items,amount,currency,gateway,status)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [reference, sanitizeText(customer?.name, 200), email, sanitizeText(customer?.phone, 50),
       JSON.stringify(items), amount, currency, 'stripe', 'pending']
    );

    if (!STRIPE_SECRET) {
      return res.status(503).json({
        error: 'Stripe is not configured yet. Add STRIPE_SECRET_KEY to enable live payments.',
        demo: true, reference, amount, currency,
      });
    }

    const base = (SITE_URL || `${req.protocol}://${req.get('host')}`);
    const form = new URLSearchParams();
    form.append('mode', 'payment');
    form.append('success_url', base + '/shop.html?ref=' + reference + '&status=success');
    form.append('cancel_url',  base + '/shop.html?ref=' + reference + '&status=cancelled');
    form.append('customer_email', email);
    form.append('client_reference_id', reference);
    items.forEach((it, i) => {
      form.append(`line_items[${i}][price_data][currency]`, currency.toLowerCase());
      form.append(`line_items[${i}][price_data][product_data][name]`, it.name);
      form.append(`line_items[${i}][price_data][unit_amount]`, String(Math.round(it.price * 100)));
      form.append(`line_items[${i}][quantity]`, String(it.qty));
    });

    const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + STRIPE_SECRET, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    const data = await r.json();
    if (data.error) throw new Error(data.error.message || 'Stripe session failed');
    // Persist the session id so /verify can confirm payment on the customer's return
    await pool.query('UPDATE shop_orders SET gateway_session = ? WHERE reference = ?', [data.id, reference]);
    res.json({ authorization_url: data.url, reference });
  } catch (err) {
    console.error('[shop/checkout/stripe]', err.message);
    res.status(400).json({ error: err.message });
  }
});

// GET /api/shop/verify/:reference  — confirm a Paystack payment, mark order paid
router.get('/verify/:reference', async (req, res) => {
  try {
    const reference = sanitizeText(req.params.reference, 120);
    const [rows] = await pool.query('SELECT * FROM shop_orders WHERE reference = ?', [reference]);
    if (!rows[0]) return res.status(404).json({ error: 'Order not found' });
    const order = rows[0];

    if (order.status === 'paid') return res.json({ status: 'paid', order });

    // Paystack — verify by reference
    if (order.gateway === 'paystack' && PAYSTACK_SECRET) {
      const r = await fetch('https://api.paystack.co/transaction/verify/' + encodeURIComponent(reference), {
        headers: { Authorization: 'Bearer ' + PAYSTACK_SECRET },
      });
      const data = await r.json();
      if (data.status && data.data && data.data.status === 'success') {
        await markOrderPaid(reference);
        return res.json({ status: 'paid', order: { ...order, status: 'paid' } });
      }
      return res.json({ status: order.status, order });
    }

    // Stripe — retrieve the checkout session and confirm it was paid
    if (order.gateway === 'stripe' && STRIPE_SECRET && order.gateway_session) {
      const r = await fetch('https://api.stripe.com/v1/checkout/sessions/' + encodeURIComponent(order.gateway_session), {
        headers: { Authorization: 'Bearer ' + STRIPE_SECRET },
      });
      const data = await r.json();
      if (!data.error && data.payment_status === 'paid') {
        await markOrderPaid(reference);
        return res.json({ status: 'paid', order: { ...order, status: 'paid' } });
      }
      return res.json({ status: order.status, order });
    }

    res.json({ status: order.status, order });
  } catch (err) {
    console.error('[shop/verify]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ════════════════════════════════════════════════════════════════════════════════
//  WEBHOOKS — reliable server-to-server payment confirmation
//  (req.body is a raw Buffer here; see express.raw mount in server.js)
// ════════════════════════════════════════════════════════════════════════════════

// POST /api/shop/webhook/paystack
router.post('/webhook/paystack', async (req, res) => {
  try {
    if (!PAYSTACK_SECRET) return res.sendStatus(200);
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body));
    const expected = crypto.createHmac('sha512', PAYSTACK_SECRET).update(raw).digest('hex');
    const sig = req.headers['x-paystack-signature'];
    if (!sig || sig !== expected) return res.sendStatus(401);

    const event = JSON.parse(raw.toString('utf8'));
    if (event.event === 'charge.success' && event.data && event.data.reference) {
      await markOrderPaid(event.data.reference);
    }
    res.sendStatus(200);
  } catch (err) {
    console.error('[shop/webhook/paystack]', err.message);
    res.sendStatus(200); // 200 so the gateway doesn't endlessly retry on our parse errors
  }
});

// POST /api/shop/webhook/stripe
router.post('/webhook/stripe', async (req, res) => {
  try {
    if (!STRIPE_WEBHOOK_SECRET) return res.sendStatus(200);
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body));
    if (!verifyStripeSignature(raw.toString('utf8'), req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET)) {
      return res.sendStatus(401);
    }
    const event = JSON.parse(raw.toString('utf8'));
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      if (session.payment_status === 'paid' && session.client_reference_id) {
        await markOrderPaid(session.client_reference_id);
      }
    }
    res.sendStatus(200);
  } catch (err) {
    console.error('[shop/webhook/stripe]', err.message);
    res.sendStatus(200);
  }
});

// ════════════════════════════════════════════════════════════════════════════════
//  ADMIN — Orders
// ════════════════════════════════════════════════════════════════════════════════
router.get('/orders', requireAuth, async (req, res) => {
  try {
    const status = sanitizeText(req.query.status, 20);
    let sql = 'SELECT * FROM shop_orders';
    const params = [];
    if (status) { sql += ' WHERE status = ?'; params.push(status); }
    sql += ' ORDER BY created_at DESC';
    const [rows] = await pool.query(sql, params);
    const orders = rows.map(o => { try { o.items = JSON.parse(o.items || '[]'); } catch { o.items = []; } return o; });
    res.json({ orders });
  } catch (err) {
    console.error('[shop/orders GET]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
