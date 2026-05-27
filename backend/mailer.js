/**
 * SeedsAds Mailer - graceful degradation
 * If SMTP_USER / SMTP_PASS are not set in .env the functions
 * just log to console and resolve immediately -- the app keeps
 * working without email config.
 */
require('dotenv').config();
const nodemailer = require('nodemailer');

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@seedsads.com';
const SITE_URL    = process.env.SITE_URL    || 'http://localhost:3002';

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
  transporter = nodemailer.createTransport({
    host:   process.env.SMTP_HOST || 'smtp.gmail.com',
    port:   parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  return transporter;
}

async function send(opts) {
  const t = getTransporter();
  if (!t) {
    console.log('[mailer] (no SMTP configured) To: ' + opts.to + ' | Subject: ' + opts.subject);
    return;
  }
  try {
    await t.sendMail({ from: '"SeedsAds" <' + process.env.SMTP_USER + '>', ...opts });
  } catch (err) {
    console.error('[mailer] send error:', err.message);
  }
}

// --- Notification templates -------------------------------------------------

/** Notify admin of a new contact/lead submission */
async function notifyNewContact({ name, email, phone, service, message }) {
  await send({
    to: ADMIN_EMAIL,
    subject: 'New enquiry from ' + name + ' - SeedsAds',
    html: `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;color:#1A1A2E;">
        <div style="background:linear-gradient(135deg,#0A2540,#0066FF);padding:24px 32px;border-radius:12px 12px 0 0;">
          <h2 style="color:white;margin:0;font-size:1.2rem;">New Contact Submission</h2>
        </div>
        <div style="background:#fff;border:1px solid #e2e8f0;border-top:none;padding:28px 32px;border-radius:0 0 12px 12px;">
          <table style="width:100%;border-collapse:collapse;">
            <tr><td style="padding:6px 0;color:#6B7280;font-size:.85rem;width:110px;">Name</td><td style="padding:6px 0;font-weight:600;">${name}</td></tr>
            <tr><td style="padding:6px 0;color:#6B7280;font-size:.85rem;">Email</td><td style="padding:6px 0;"><a href="mailto:${email}" style="color:#0066FF;">${email}</a></td></tr>
            <tr><td style="padding:6px 0;color:#6B7280;font-size:.85rem;">Phone</td><td style="padding:6px 0;">${phone || '-'}</td></tr>
            <tr><td style="padding:6px 0;color:#6B7280;font-size:.85rem;">Service</td><td style="padding:6px 0;">${service || '-'}</td></tr>
            <tr><td style="padding:6px 0;color:#6B7280;font-size:.85rem;vertical-align:top;">Message</td><td style="padding:6px 0;">${message || '-'}</td></tr>
          </table>
          <div style="margin-top:20px;">
            <a href="${SITE_URL}/admin/dashboard.html" style="background:#0066FF;color:white;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:600;font-size:.88rem;">View in Dashboard</a>
          </div>
        </div>
      </div>`,
  });
}

/** Welcome email to a newly registered user */
async function welcomeUser({ first_name, email, plan }) {
  await send({
    to: email,
    subject: 'Welcome to SeedsAds!',
    html: `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;color:#1A1A2E;">
        <div style="background:linear-gradient(135deg,#0A2540,#0066FF);padding:24px 32px;border-radius:12px 12px 0 0;">
          <h2 style="color:white;margin:0;font-size:1.3rem;">Welcome to SeedsAds, ${first_name}!</h2>
        </div>
        <div style="background:#fff;border:1px solid #e2e8f0;border-top:none;padding:28px 32px;border-radius:0 0 12px 12px;">
          <p style="line-height:1.7;margin-bottom:16px;">Your account has been created successfully. ${plan ? 'You have expressed interest in our <strong>' + plan + '</strong> plan.' : ''}</p>
          <p style="line-height:1.7;margin-bottom:24px;"><strong>Next step:</strong> Upload your payment receipt in your dashboard to unlock full access to DMI courses and our marketing services.</p>
          <a href="${SITE_URL}/user/dashboard.html" style="background:#0066FF;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:.9rem;">Go to My Dashboard</a>
          <hr style="margin:28px 0;border:none;border-top:1px solid #e2e8f0;">
          <p style="font-size:.82rem;color:#6B7280;">If you have questions, reply to this email or visit our <a href="${SITE_URL}/about/contact.html" style="color:#0066FF;">contact page</a>.</p>
        </div>
      </div>`,
  });
}

/** Notify admin that a user submitted a payment receipt */
async function notifyPaymentUploaded({ first_name, last_name, email, plan, amount }) {
  await send({
    to: ADMIN_EMAIL,
    subject: 'Payment receipt uploaded - ' + first_name + ' ' + last_name,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;color:#1A1A2E;">
        <div style="background:linear-gradient(135deg,#0A2540,#0066FF);padding:24px 32px;border-radius:12px 12px 0 0;">
          <h2 style="color:white;margin:0;font-size:1.2rem;">Payment Receipt Submitted</h2>
        </div>
        <div style="background:#fff;border:1px solid #e2e8f0;border-top:none;padding:28px 32px;border-radius:0 0 12px 12px;">
          <table style="width:100%;border-collapse:collapse;">
            <tr><td style="padding:6px 0;color:#6B7280;font-size:.85rem;width:110px;">Client</td><td style="padding:6px 0;font-weight:600;">${first_name} ${last_name}</td></tr>
            <tr><td style="padding:6px 0;color:#6B7280;font-size:.85rem;">Email</td><td style="padding:6px 0;"><a href="mailto:${email}" style="color:#0066FF;">${email}</a></td></tr>
            <tr><td style="padding:6px 0;color:#6B7280;font-size:.85rem;">Plan</td><td style="padding:6px 0;">${plan || '-'}</td></tr>
            <tr><td style="padding:6px 0;color:#6B7280;font-size:.85rem;">Amount</td><td style="padding:6px 0;">&#8358;${amount ? Number(amount).toLocaleString() : '-'}</td></tr>
          </table>
          <div style="margin-top:20px;">
            <a href="${SITE_URL}/admin/dashboard.html" style="background:#0066FF;color:white;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:600;font-size:.88rem;">Review in Dashboard</a>
          </div>
        </div>
      </div>`,
  });
}

/** Notify user their payment was approved */
async function notifyPaymentApproved({ first_name, email, plan, admin_note }) {
  await send({
    to: email,
    subject: 'Payment Approved - Full Access Granted',
    html: `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;color:#1A1A2E;">
        <div style="background:linear-gradient(135deg,#0A2540,#00D4AA);padding:24px 32px;border-radius:12px 12px 0 0;">
          <h2 style="color:white;margin:0;font-size:1.2rem;">Payment Verified!</h2>
        </div>
        <div style="background:#fff;border:1px solid #e2e8f0;border-top:none;padding:28px 32px;border-radius:0 0 12px 12px;">
          <p style="line-height:1.7;margin-bottom:16px;">Hi <strong>${first_name}</strong>, your payment for the <strong>${plan || 'SeedsAds'}</strong> plan has been verified and approved.</p>
          <p style="line-height:1.7;margin-bottom:24px;">You now have <strong>full access</strong> to all DMI courses, certifications, and marketing services.</p>
          ${admin_note ? '<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:12px 16px;margin-bottom:24px;font-size:.88rem;color:#166534;">Note from admin: ' + admin_note + '</div>' : ''}
          <a href="${SITE_URL}/user/dashboard.html" style="background:#00D4AA;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:.9rem;">Access My Dashboard</a>
        </div>
      </div>`,
  });
}

/** Notify user their payment was rejected */
async function notifyPaymentRejected({ first_name, email, admin_note }) {
  await send({
    to: email,
    subject: 'Action Required - Payment Receipt Not Accepted',
    html: `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;color:#1A1A2E;">
        <div style="background:linear-gradient(135deg,#0A2540,#EF4444);padding:24px 32px;border-radius:12px 12px 0 0;">
          <h2 style="color:white;margin:0;font-size:1.2rem;">Receipt Not Accepted</h2>
        </div>
        <div style="background:#fff;border:1px solid #e2e8f0;border-top:none;padding:28px 32px;border-radius:0 0 12px 12px;">
          <p style="line-height:1.7;margin-bottom:16px;">Hi <strong>${first_name}</strong>, unfortunately your payment receipt could not be verified.</p>
          ${admin_note ? '<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:12px 16px;margin-bottom:20px;font-size:.88rem;color:#991b1b;">Reason: ' + admin_note + '</div>' : ''}
          <p style="line-height:1.7;margin-bottom:24px;">Please upload a new, clear receipt and try again. If you believe this is an error, contact our support team.</p>
          <a href="${SITE_URL}/user/dashboard.html" style="background:#0066FF;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:.9rem;">Upload New Receipt</a>
        </div>
      </div>`,
  });
}

/** Send password reset link to a user */
async function sendPasswordReset({ first_name, email, token }) {
  const resetUrl = `${SITE_URL}/user/forgot-password.html?token=${token}`;
  await send({
    to: email,
    subject: 'Reset Your SeedsAds Password',
    html: `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;color:#1A1A2E;">
        <div style="background:linear-gradient(135deg,#0A2540,#0066FF);padding:24px 32px;border-radius:12px 12px 0 0;">
          <h2 style="color:white;margin:0;font-size:1.2rem;">Password Reset Request</h2>
        </div>
        <div style="background:#fff;border:1px solid #e2e8f0;border-top:none;padding:28px 32px;border-radius:0 0 12px 12px;">
          <p style="line-height:1.7;margin-bottom:16px;">Hi <strong>${first_name}</strong>,</p>
          <p style="line-height:1.7;margin-bottom:24px;">
            We received a request to reset your password. Click the button below to set a new password.
            This link expires in <strong>1 hour</strong>.
          </p>
          <a href="${resetUrl}" style="background:#0066FF;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:.9rem;display:inline-block;">
            Reset My Password
          </a>
          <hr style="margin:28px 0;border:none;border-top:1px solid #e2e8f0;">
          <p style="font-size:.82rem;color:#6B7280;">
            If you did not request a password reset, you can safely ignore this email &mdash; your password will not change.<br><br>
            If the button above does not work, copy and paste this URL into your browser:<br>
            <a href="${resetUrl}" style="color:#0066FF;word-break:break-all;">${resetUrl}</a>
          </p>
        </div>
      </div>`,
  });
}

module.exports = {
  notifyNewContact,
  welcomeUser,
  notifyPaymentUploaded,
  notifyPaymentApproved,
  notifyPaymentRejected,
  sendPasswordReset,
};
