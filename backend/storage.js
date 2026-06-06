'use strict';
/**
 * storage.js — shared file storage helper.
 *
 * In production (Cloudinary env vars present) uploaded files are streamed to
 * Cloudinary so they survive deploys/restarts. On platforms like Render the
 * local filesystem is EPHEMERAL — anything written to disk is wiped on every
 * redeploy, so payment receipts and DMI course files MUST live on Cloudinary.
 *
 * In development (no Cloudinary keys) files fall back to local disk so you can
 * work without a Cloudinary account.
 */
const path       = require('path');
const fs         = require('fs');
const crypto     = require('crypto');
const multer     = require('multer');
const cloudinary = require('cloudinary').v2;

const USE_CLOUDINARY = !!(
  process.env.CLOUDINARY_CLOUD_NAME &&
  process.env.CLOUDINARY_API_KEY &&
  process.env.CLOUDINARY_API_SECRET
);

if (USE_CLOUDINARY) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key:    process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure:     true,
  });
}

/**
 * Build a multer uploader.
 *  - Cloudinary mode → memory storage (we stream the buffer up ourselves)
 *  - Local mode      → disk storage under backend/uploads/<subdir>
 * @param {object} opts { subdir, limits, fileFilter }
 */
function makeUploader({ subdir, limits, fileFilter }) {
  const storage = USE_CLOUDINARY
    ? multer.memoryStorage()
    : multer.diskStorage({
        destination(req, file, cb) {
          const dir = path.join(__dirname, 'uploads', subdir);
          fs.mkdirSync(dir, { recursive: true });
          cb(null, dir);
        },
        filename(req, file, cb) {
          const ext = path.extname(file.originalname).toLowerCase();
          cb(null, Date.now() + '-' + crypto.randomBytes(6).toString('hex') + ext);
        },
      });
  return multer({ storage, limits, fileFilter });
}

function uploadBuffer(buffer, { folder, publicId, resourceType }) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, public_id: publicId, resource_type: resourceType || 'auto' },
      (err, result) => (err ? reject(err) : resolve(result))
    );
    stream.end(buffer);
  });
}

/**
 * Persist a multer file and return a stable, web-accessible reference.
 * @param {object} file   multer file (has .buffer in Cloudinary mode, .filename on disk)
 * @param {object} opts   { folder, subdir, resourceType }
 * @returns {Promise<{url:string|null}>}  Cloudinary secure_url, or /uploads/<subdir>/<file>
 */
async function persist(file, { folder, subdir, resourceType } = {}) {
  if (!file) return { url: null };
  if (USE_CLOUDINARY) {
    const publicId = Date.now() + '-' + crypto.randomBytes(6).toString('hex');
    const result   = await uploadBuffer(file.buffer, { folder, publicId, resourceType });
    return { url: result.secure_url };
  }
  return { url: '/uploads/' + subdir + '/' + file.filename };
}

/**
 * Best-effort delete of a previously-stored file (Cloudinary or local disk).
 * Never throws — deletion failures should not break the request.
 */
async function remove(url, { resourceType } = {}) {
  if (!url) return;
  try {
    if (/^https?:\/\/res\.cloudinary\.com/.test(url)) {
      const m = url.match(/\/upload\/(?:v\d+\/)?(.+?)(?:\.[a-z0-9]+)?$/i);
      if (m) await cloudinary.uploader.destroy(m[1], { resource_type: resourceType || 'image' });
    } else if (url.startsWith('/uploads/')) {
      const abs = path.join(__dirname, url);
      if (fs.existsSync(abs)) fs.unlinkSync(abs);
    }
  } catch (e) {
    console.warn('[storage.remove]', e.message);
  }
}

module.exports = { USE_CLOUDINARY, cloudinary, makeUploader, persist, remove };
