/* ============================================================================
 * SeedsAds Donate Widget — self-contained floating "Donate to us" button.
 *
 * Usage (any page, any site):
 *   <script>
 *     window.DONATE_CONFIG = {
 *       apiBase: '',                       // '' = same origin; or 'https://your-backend' for a separate site
 *       publicKey: 'FLWPUBK-XXXXXXXXXXXX-X',// Flutterwave PUBLIC key (placeholder ok until you have the real one)
 *       title: 'Support Our Work',
 *       currency: 'NGN',
 *       presets: [1000, 5000, 10000, 25000]
 *     };
 *   </script>
 *   <script src="/donate-widget.js" defer></script>
 *
 * Funds go to the configured Flutterwave account. Each donation is logged +
 * verified by the backend (POST /api/donations/init, GET /api/donations/verify).
 * Paystack can be added later as a second button without touching this file's flow.
 * ========================================================================== */
(function () {
  'use strict';
  if (window.__donateWidgetLoaded) return;
  window.__donateWidgetLoaded = true;

  var CFG = Object.assign({
    apiBase: '',
    publicKey: 'FLWPUBK-XXXXXXXXXXXXXXXX-X',   // ← replace with the client's real Flutterwave public key
    title: 'Support Our Work',
    subtitle: 'Your gift helps us keep growing. Thank you! 💚',
    currency: 'NGN',
    presets: [1000, 5000, 10000, 25000]
  }, window.DONATE_CONFIG || {});

  var fmt = function (n) { return Number(n).toLocaleString(); };
  var sym = CFG.currency === 'NGN' ? '₦' : '';

  // ── Styles ────────────────────────────────────────────────────────────────
  var css = `
  .dn-float{position:fixed;bottom:30px;left:30px;display:flex;align-items:center;gap:.55rem;
    background:linear-gradient(135deg,#ff4d6d,#c9184a);color:#fff;border:none;cursor:pointer;
    padding:14px 20px 14px 16px;border-radius:50px;font:600 .95rem/1 'Inter',system-ui,sans-serif;
    box-shadow:0 6px 22px rgba(201,24,74,.45);transition:transform .25s,box-shadow .25s;z-index:998;}
  .dn-float:hover{transform:translateY(-3px) scale(1.04);box-shadow:0 10px 30px rgba(201,24,74,.6);}
  .dn-float i{font-size:1.15rem;}
  .dn-float .dn-pulse{position:absolute;inset:0;border-radius:50px;box-shadow:0 0 0 0 rgba(201,24,74,.5);
    animation:dnpulse 2.2s infinite;}
  @keyframes dnpulse{0%{box-shadow:0 0 0 0 rgba(201,24,74,.45)}70%{box-shadow:0 0 0 16px rgba(201,24,74,0)}100%{box-shadow:0 0 0 0 rgba(201,24,74,0)}}
  .dn-overlay{position:fixed;inset:0;background:rgba(10,37,64,.55);backdrop-filter:blur(3px);
    z-index:1200;display:none;align-items:center;justify-content:center;padding:1rem;}
  .dn-overlay.dn-open{display:flex;}
  .dn-modal{background:#fff;width:100%;max-width:430px;border-radius:20px;overflow:hidden;
    box-shadow:0 30px 80px rgba(10,37,64,.35);font-family:'Inter',system-ui,sans-serif;
    animation:dnpop .25s ease;}
  @keyframes dnpop{from{transform:translateY(16px) scale(.97);opacity:0}to{transform:none;opacity:1}}
  .dn-head{background:linear-gradient(135deg,#ff4d6d,#c9184a);color:#fff;padding:1.4rem 1.5rem;position:relative;}
  .dn-head h3{margin:0;font-size:1.25rem;font-weight:700;display:flex;align-items:center;gap:.5rem;}
  .dn-head p{margin:.35rem 0 0;font-size:.85rem;opacity:.92;}
  .dn-close{position:absolute;top:12px;right:12px;background:rgba(255,255,255,.2);border:none;color:#fff;
    width:32px;height:32px;border-radius:50%;cursor:pointer;font-size:1rem;display:flex;align-items:center;justify-content:center;}
  .dn-close:hover{background:rgba(255,255,255,.35);}
  .dn-body{padding:1.3rem 1.5rem 1.6rem;}
  .dn-amts{display:grid;grid-template-columns:repeat(4,1fr);gap:.5rem;margin-bottom:.9rem;}
  .dn-amt{padding:.6rem .2rem;border:1.5px solid #e6e8ee;background:#fff;border-radius:10px;cursor:pointer;
    font-weight:600;font-size:.85rem;color:#1a1a2e;transition:all .2s;}
  .dn-amt:hover{border-color:#ff4d6d;color:#c9184a;}
  .dn-amt.dn-sel{background:#c9184a;border-color:#c9184a;color:#fff;}
  .dn-field{margin-bottom:.75rem;}
  .dn-field label{display:block;font-size:.78rem;font-weight:600;color:#6b7280;margin-bottom:.3rem;}
  .dn-field input,.dn-field textarea{width:100%;padding:.7rem .8rem;border:1.5px solid #e6e8ee;border-radius:10px;
    font-size:.9rem;font-family:inherit;box-sizing:border-box;}
  .dn-field input:focus,.dn-field textarea:focus{outline:none;border-color:#ff4d6d;}
  .dn-give{width:100%;padding:.9rem;border:none;border-radius:12px;background:linear-gradient(135deg,#ff4d6d,#c9184a);
    color:#fff;font-weight:700;font-size:1rem;cursor:pointer;margin-top:.4rem;transition:opacity .2s;}
  .dn-give:hover{opacity:.92;} .dn-give:disabled{opacity:.6;cursor:not-allowed;}
  .dn-msg{font-size:.82rem;margin-top:.7rem;text-align:center;min-height:1em;}
  .dn-msg.dn-err{color:#c9184a;} .dn-msg.dn-ok{color:#0a8a4a;}
  .dn-cur{position:relative;} .dn-cur span{position:absolute;left:.8rem;top:50%;transform:translateY(-50%);color:#6b7280;font-weight:600;}
  .dn-cur input{padding-left:1.7rem;}
  @media(max-width:560px){.dn-float{bottom:20px;left:20px;padding:12px 16px 12px 14px;font-size:.85rem;}}
  `;
  var style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);

  // ── Float button ────────────────────────────────────────────────────────
  var btn = document.createElement('button');
  btn.className = 'dn-float';
  btn.setAttribute('aria-label', 'Donate');
  btn.innerHTML = '<span class="dn-pulse"></span><i class="fas fa-heart"></i> Donate';

  // ── Modal ─────────────────────────────────────────────────────────────────
  var overlay = document.createElement('div');
  overlay.className = 'dn-overlay';
  overlay.innerHTML =
    '<div class="dn-modal" role="dialog" aria-modal="true">' +
      '<div class="dn-head">' +
        '<button class="dn-close" aria-label="Close">&times;</button>' +
        '<h3><i class="fas fa-hand-holding-heart"></i> ' + CFG.title + '</h3>' +
        '<p>' + CFG.subtitle + '</p>' +
      '</div>' +
      '<div class="dn-body">' +
        '<div class="dn-amts">' +
          CFG.presets.map(function (p) {
            return '<button type="button" class="dn-amt" data-amt="' + p + '">' + sym + fmt(p) + '</button>';
          }).join('') +
        '</div>' +
        '<div class="dn-field"><label>Amount (' + CFG.currency + ')</label>' +
          '<div class="dn-cur"><span>' + sym + '</span><input type="number" id="dnAmount" min="100" placeholder="Enter amount"></div></div>' +
        '<div class="dn-field"><label>Your name (optional)</label><input type="text" id="dnName" placeholder="Jane Doe"></div>' +
        '<div class="dn-field"><label>Email</label><input type="email" id="dnEmail" placeholder="you@email.com"></div>' +
        '<div class="dn-field"><label>Message (optional)</label><textarea id="dnMessage" rows="2" placeholder="Say something kind…"></textarea></div>' +
        '<button class="dn-give" id="dnGive"><i class="fas fa-heart"></i> Donate ' + sym + '<span id="dnGiveAmt">0</span></button>' +
        '<div class="dn-msg" id="dnMsg"></div>' +
      '</div>' +
    '</div>';

  document.addEventListener('DOMContentLoaded', function () {
    document.body.appendChild(btn);
    document.body.appendChild(overlay);
    wire();
  });

  function wire() {
    var amountEl = overlay.querySelector('#dnAmount');
    var giveAmt  = overlay.querySelector('#dnGiveAmt');
    var msgEl    = overlay.querySelector('#dnMsg');
    var giveBtn  = overlay.querySelector('#dnGive');

    function setMsg(t, ok) { msgEl.textContent = t || ''; msgEl.className = 'dn-msg ' + (t ? (ok ? 'dn-ok' : 'dn-err') : ''); }
    function refresh() { giveAmt.textContent = fmt(Number(amountEl.value || 0)); }

    function open() { overlay.classList.add('dn-open'); }
    function close() { overlay.classList.remove('dn-open'); setMsg(''); }

    btn.addEventListener('click', open);
    overlay.querySelector('.dn-close').addEventListener('click', close);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });

    overlay.querySelectorAll('.dn-amt').forEach(function (b) {
      b.addEventListener('click', function () {
        overlay.querySelectorAll('.dn-amt').forEach(function (x) { x.classList.remove('dn-sel'); });
        b.classList.add('dn-sel');
        amountEl.value = b.getAttribute('data-amt');
        refresh();
      });
    });
    amountEl.addEventListener('input', function () {
      overlay.querySelectorAll('.dn-amt').forEach(function (x) { x.classList.remove('dn-sel'); });
      refresh();
    });

    giveBtn.addEventListener('click', function () { startDonation(amountEl, setMsg, giveBtn); });
  }

  function loadFlutterwave() {
    return new Promise(function (resolve, reject) {
      if (window.FlutterwaveCheckout) return resolve();
      var s = document.createElement('script');
      s.src = 'https://checkout.flutterwave.com/v3.js';
      s.onload = resolve; s.onerror = function () { reject(new Error('Could not load Flutterwave')); };
      document.head.appendChild(s);
    });
  }

  function startDonation(amountEl, setMsg, giveBtn) {
    var amount  = Number(amountEl.value || 0);
    var name    = overlay.querySelector('#dnName').value.trim();
    var email   = overlay.querySelector('#dnEmail').value.trim();
    var message = overlay.querySelector('#dnMessage').value.trim();

    if (!amount || amount < 100) return setMsg('Please enter an amount of at least ' + sym + '100.');
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return setMsg('Please enter a valid email.');

    giveBtn.disabled = true; setMsg('Starting secure donation…', true);

    fetch(CFG.apiBase + '/api/donations/init', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: amount, currency: CFG.currency, name: name, email: email, message: message })
    })
    .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
    .then(function (res) {
      var d = res.d;
      var reference = d.reference;
      var pubKey = d.publicKey || CFG.publicKey;
      if (!reference) throw new Error(d.error || 'Could not start donation.');

      return loadFlutterwave().then(function () {
        giveBtn.disabled = false; setMsg('');
        window.FlutterwaveCheckout({
          public_key: pubKey,
          tx_ref: reference,
          amount: amount,
          currency: CFG.currency,
          payment_options: 'card,banktransfer,ussd',
          customer: { email: email, name: name || 'Anonymous Donor' },
          customizations: { title: CFG.title, description: 'Donation' },
          callback: function () { verify(reference, setMsg); },
          onclose: function () {}
        });
      });
    })
    .catch(function (err) { giveBtn.disabled = false; setMsg(err.message || 'Something went wrong.'); });
  }

  function verify(reference, setMsg) {
    setMsg('Confirming your donation…', true);
    fetch(CFG.apiBase + '/api/donations/verify/' + encodeURIComponent(reference))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.status === 'paid') setMsg('Thank you so much for your donation! 💚', true);
        else setMsg('Payment received — confirmation is processing. Thank you! 💚', true);
      })
      .catch(function () { setMsg('Thank you! If charged, your donation is recorded. 💚', true); });
  }
})();
