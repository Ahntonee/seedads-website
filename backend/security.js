/**
 * security.js — Shared security helpers
 * Login lockout, input sanitization, validation utilities
 */
'use strict';
const db = require('./database');

// ── Login lockout ────────────────────────────────────────────────────────────
const ADMIN_MAX_ATTEMPTS  = 5;
const ADMIN_WINDOW_MS     = 30 * 60 * 1000; // 30 minutes
const USER_MAX_ATTEMPTS   = 10;
const USER_WINDOW_MS      = 15 * 60 * 1000; // 15 minutes

function _recentAttempts(identifier, windowMs) {
  const cutoff = new Date(Date.now() - windowMs).toISOString();
  return db.prepare(
    'SELECT COUNT(*) as c FROM login_attempts WHERE identifier = ? AND attempt_at > ?'
  ).get(identifier, cutoff).c;
}

function isAdminLockedOut(username) {
  return _recentAttempts('admin:' + username.toLowerCase(), ADMIN_WINDOW_MS) >= ADMIN_MAX_ATTEMPTS;
}

function isUserLockedOut(email) {
  return _recentAttempts('user:' + email.toLowerCase(), USER_WINDOW_MS) >= USER_MAX_ATTEMPTS;
}

function recordFailedAttempt(identifier, ip) {
  db.prepare('INSERT INTO login_attempts (identifier, ip) VALUES (?, ?)').run(identifier, ip || null);
}

function clearAttempts(identifier) {
  db.prepare('DELETE FROM login_attempts WHERE identifier = ?').run(identifier);
}

// Prune attempts older than 24 hours (run periodically)
function pruneAttempts() {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  db.prepare('DELETE FROM login_attempts WHERE attempt_at < ?').run(cutoff);
}

// ── Input sanitization ───────────────────────────────────────────────────────

/** Strip all HTML tags from a plain-text field */
function stripHtml(str) {
  if (!str || typeof str !== 'string') return str;
  return str.replace(/<[^>]*>/g, '').trim();
}

/** Sanitize a plain-text field: strip HTML, trim, enforce max length */
function sanitizeText(str, maxLen = 500) {
  if (!str || typeof str !== 'string') return null;
  return stripHtml(str).slice(0, maxLen) || null;
}

/** Validate and normalize an email address */
function sanitizeEmail(str) {
  if (!str || typeof str !== 'string') return null;
  const trimmed = str.trim().toLowerCase().slice(0, 320);
  // RFC 5322 simplified regex
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(trimmed);
  return valid ? trimmed : null;
}

/** Sanitize a phone number — digits, spaces, +, -, (, ) only */
function sanitizePhone(str) {
  if (!str || typeof str !== 'string') return null;
  return str.replace(/[^\d\s+\-().]/g, '').trim().slice(0, 30) || null;
}

/** Sanitize blog HTML content — allow safe tags, block scripts/iframes/etc. */
function sanitizeBlogContent(html) {
  if (!html || typeof html !== 'string') return null;
  // Remove obviously dangerous elements
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/<object[\s\S]*?<\/object>/gi, '')
    .replace(/<embed[^>]*>/gi, '')
    .replace(/<link[^>]*>/gi, '')
    .replace(/on\w+\s*=\s*["'][^"']*["']/gi, '') // remove inline event handlers
    .replace(/javascript\s*:/gi, 'blocked:')       // block javascript: URIs
    .trim();
}

/** Validate password strength */
function validatePassword(password) {
  if (!password || typeof password !== 'string') return 'Password is required';
  if (password.length < 8) return 'Password must be at least 8 characters';
  if (password.length > 128) return 'Password too long';
  return null; // null = valid
}

module.exports = {
  isAdminLockedOut,
  isUserLockedOut,
  recordFailedAttempt,
  clearAttempts,
  pruneAttempts,
  sanitizeText,
  sanitizeEmail,
  sanitizePhone,
  sanitizeBlogContent,
  validatePassword,
};
