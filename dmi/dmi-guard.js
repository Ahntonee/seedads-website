(function () {
  const token = localStorage.getItem('seedads_user_token');
  const userRaw = localStorage.getItem('seedads_user');

  if (!token || !userRaw) {
    const redirect = encodeURIComponent(window.location.href);
    window.location.href = '/user/login.html?redirect=' + redirect;
    return;
  }

  const user = JSON.parse(userRaw);

  // Always verify with server on load
  fetch('/api/users/me', {
    headers: { Authorization: 'Bearer ' + token }
  }).then(r => {
    if (r.status === 401) {
      localStorage.removeItem('seedads_user_token');
      localStorage.removeItem('seedads_user');
      window.location.href = '/user/login.html';
      return;
    }
    return r.json();
  }).then(data => {
    if (!data) return;
    const u = data.user;
    localStorage.setItem('seedads_user', JSON.stringify(u));

    if (!u.approved) {
      // Show paywall
      document.getElementById('dmi-paywall').style.display = 'flex';
      document.body.style.overflow = 'hidden';

      const msgEl = document.getElementById('dmi-paywall-msg');
      if (u.payment_status === 'pending') {
        msgEl.innerHTML = `
          <div class="pw-icon" style="background:rgba(245,158,11,0.12);color:#F59E0B;"><i class="fas fa-clock"></i></div>
          <h2>Payment Under Review</h2>
          <p>Your receipt has been submitted and is currently being reviewed by our team. You'll receive full access once approved - usually within 24 hours.</p>
          <div style="display:flex;gap:.75rem;justify-content:center;flex-wrap:wrap;">
            <a href="/user/dashboard.html" class="pw-btn pw-btn-primary"><i class="fas fa-tachometer-alt"></i> Go to Dashboard</a>
            <a href="/index.html" class="pw-btn pw-btn-outline"><i class="fas fa-home"></i> Back to Home</a>
          </div>`;
      } else {
        msgEl.innerHTML = `
          <div class="pw-icon" style="background:rgba(0,102,255,0.1);color:#0066FF;"><i class="fas fa-lock"></i></div>
          <h2>DMI Access Requires Payment</h2>
          <p>Hi <strong>${u.first_name}</strong>, DMI courses and certifications are available after your payment is verified. Upload your receipt to get started.</p>
          <div style="display:flex;gap:.75rem;justify-content:center;flex-wrap:wrap;">
            <a href="/user/dashboard.html#payment" class="pw-btn pw-btn-primary" onclick="localStorage.setItem('dmi_tab','payment')"><i class="fas fa-upload"></i> Upload Payment Receipt</a>
            <a href="/pricing.html" class="pw-btn pw-btn-outline"><i class="fas fa-tags"></i> View Pricing</a>
          </div>`;
      }
    }
  }).catch(() => {});

  // Inject paywall HTML + styles if not already present
  document.addEventListener('DOMContentLoaded', function () {
    if (document.getElementById('dmi-paywall')) return;

    const style = document.createElement('style');
    style.textContent = `
      #dmi-paywall {
        display: none; position: fixed; inset: 0; z-index: 9999;
        background: rgba(10,37,64,0.85); backdrop-filter: blur(12px);
        align-items: center; justify-content: center; padding: 1.5rem;
      }
      .pw-card {
        background: white; border-radius: 24px; padding: 3rem 2.5rem;
        max-width: 500px; width: 100%; text-align: center;
        box-shadow: 0 40px 80px rgba(10,37,64,0.4);
        animation: pwIn .4s ease;
      }
      @keyframes pwIn { from { transform: translateY(30px) scale(.95); opacity: 0; } to { transform: none; opacity: 1; } }
      .pw-logo { font-family: 'Space Grotesk', sans-serif; font-size: 1.5rem; font-weight: 700; color: #0A2540; margin-bottom: 1.75rem; display: flex; align-items: center; justify-content: center; gap: .5rem; }
      .pw-logo span { color: #0066FF; }
      .pw-icon { width: 64px; height: 64px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 1.8rem; margin: 0 auto 1.25rem; }
      .pw-card h2 { font-size: 1.4rem; font-weight: 800; color: #0A2540; margin-bottom: .75rem; }
      .pw-card p { color: #6B7280; line-height: 1.7; margin-bottom: 1.75rem; font-size: .95rem; }
      .pw-btn { display: inline-flex; align-items: center; gap: .5rem; padding: .75rem 1.5rem; border-radius: 50px; font-size: .9rem; font-weight: 600; text-decoration: none; transition: all .2s; }
      .pw-btn-primary { background: linear-gradient(135deg,#0A2540,#0066FF); color: white; box-shadow: 0 4px 15px rgba(0,102,255,0.3); }
      .pw-btn-primary:hover { transform: translateY(-2px); box-shadow: 0 8px 25px rgba(0,102,255,0.45); }
      .pw-btn-outline { background: white; color: #0066FF; border: 2px solid #0066FF; }
      .pw-btn-outline:hover { background: #E6F0FF; }
    `;
    document.head.appendChild(style);

    const paywall = document.createElement('div');
    paywall.id = 'dmi-paywall';
    paywall.innerHTML = `<div class="pw-card"><div class="pw-logo"><i class="fas fa-seedling"></i>SeedsAds<span>.</span></div><div id="dmi-paywall-msg"></div></div>`;
    document.body.prepend(paywall);

    // Re-trigger the check now that DOM is ready
    const u = JSON.parse(localStorage.getItem('seedads_user') || '{}');
    if (u.approved === 0 || u.approved === false) {
      document.getElementById('dmi-paywall').style.display = 'flex';
      document.body.style.overflow = 'hidden';
    }
  });
})();
