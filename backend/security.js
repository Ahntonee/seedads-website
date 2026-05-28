/**
 * security.js — Shared security helpers
 * Login lockout (in-memory), input sanitization, validation utilities
 */
'use strict';

// ── Login lockout (in-memory) ────────────────────────────────────────────────
// Keeps attempt timestamps per identifier. Resets on server restart,
// which is acceptable — persistent lockouts can be added later if needed.

const ADMIN_MAX_ATTEMPTS  = 5;
const ADMIN_WINDOW_MS     = 30 * 60 * 1000; // 30 minutes
const USER_MAX_ATTEMPTS   = 10;
const USER_WINDOW_MS      = 15 * 60 * 1000; // 15 minutes

// identifier -> [timestamp, timestamp, ...]
const attemptStore = new Map();

function _recentAttempts(identifier, windowMs) {
  const cutoff   = Date.now() - windowMs;
  const attempts = attemptStore.get(identifier) || [];
  return attempts.filter(t => t > cutoff).length;
}

function isAdminLockedOut(username) {
  return _recentAttempts('admin:' + username.toLowerCase(), ADMIN_WINDOW_MS) >= ADMIN_MAX_ATTEMPTS;
}

function isUserLockedOut(email) {
  return _recentAttempts('user:' + email.toLowerCase(), USER_WINDOW_MS) >= USER_MAX_ATTEMPTS;
}

function recordFailedAttempt(identifier) {
  const attempts = attemptStore.get(identifier) || [];
  attempts.push(Date.now());
  attemptStore.set(identifier, attempts);
}

function clearAttempts(identifier) {
  attemptStore.delete(identifier);
}

// Prune stale entries to prevent memory growth (called every hour from server.js)
function pruneAttempts() {
  const maxWindow = Math.max(ADMIN_WINDOW_MS, USER_WINDOW_MS);
  const cutoff    = Date.now() - maxWindow;
  for (const [key, attempts] of attemptStore.entries()) {
    const fresh = attempts.filter(t => t > cutoff);
    if (fresh.length === 0) attemptStore.delete(key);
    else attemptStore.set(key, fresh);
  }
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
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/<object[\s\S]*?<\/object>/gi, '')
    .replace(/<embed[^>]*>/gi, '')
    .replace(/<link[^>]*>/gi, '')
    .replace(/on\w+\s*=\s*["'][^"']*["']/gi, '')
    .replace(/javascript\s*:/gi, 'blocked:')
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
