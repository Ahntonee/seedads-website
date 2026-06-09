/**
 * SeedsAds Custom Dialog System
 * Replaces native browser alert() / confirm() with branded modals.
 * Colors: --primary-dark #0A2540 · --primary-blue #0066FF
 *
 * Usage (async functions only):
 *   await dialogAlert('Something went wrong.');
 *   const ok = await dialogConfirm('Delete this item?');
 */
(function () {
  'use strict';

  // ── Inject styles once ────────────────────────────────────────────────────
  const STYLE = `
    .sd-dialog-backdrop {
      position: fixed; inset: 0; z-index: 99999;
      display: flex; align-items: center; justify-content: center; padding: 1rem;
      background: rgba(10, 37, 64, 0.65);
      backdrop-filter: blur(4px);
      opacity: 0; transition: opacity .2s ease;
    }
    .sd-dialog-backdrop.sd-visible { opacity: 1; }

    .sd-dialog-card {
      background: #fff;
      border-radius: 1.25rem;
      box-shadow: 0 24px 60px rgba(10,37,64,0.28);
      width: 100%; max-width: 380px;
      padding: 2rem 1.75rem 1.75rem;
      text-align: center;
      transform: scale(.94); opacity: 0;
      transition: transform .2s ease, opacity .2s ease;
    }
    .sd-dialog-backdrop.sd-visible .sd-dialog-card {
      transform: scale(1); opacity: 1;
    }

    .sd-dialog-icon {
      width: 56px; height: 56px; border-radius: .875rem;
      display: flex; align-items: center; justify-content: center;
      margin: 0 auto 1.1rem;
      font-size: 1.5rem;
    }
    .sd-icon-info    { background: rgba(0,102,255,.1); color: #0066FF; }
    .sd-icon-warning { background: rgba(245,158,11,.12); color: #d97706; }
    .sd-icon-danger  { background: rgba(239,68,68,.1);  color: #ef4444; }

    .sd-dialog-title {
      font-size: 1rem; font-weight: 700;
      color: #0A2540; margin: 0 0 .35rem;
    }
    .sd-dialog-msg {
      font-size: .875rem; line-height: 1.6;
      color: #475569; margin: 0 0 1.75rem;
    }

    .sd-dialog-btns {
      display: flex; gap: .625rem;
    }
    .sd-dialog-btns.sd-centered { justify-content: center; }

    .sd-btn {
      flex: 1; padding: .72rem 1rem;
      border-radius: .75rem; border: none;
      font-size: .875rem; font-weight: 600;
      cursor: pointer; transition: all .18s ease;
    }
    .sd-btn:hover { transform: translateY(-1px); }
    .sd-btn-cancel {
      background: transparent;
      border: 2px solid #e2e8f0;
      color: #64748b;
    }
    .sd-btn-cancel:hover { background: #f8fafc; border-color: #cbd5e1; }

    .sd-btn-confirm-info {
      background: #0066FF;
      box-shadow: 0 4px 14px rgba(0,102,255,.35);
      color: #fff;
    }
    .sd-btn-confirm-info:hover { background: #0052cc; }

    .sd-btn-confirm-danger {
      background: #ef4444;
      box-shadow: 0 4px 14px rgba(239,68,68,.35);
      color: #fff;
    }
    .sd-btn-confirm-danger:hover { background: #dc2626; }

    .sd-btn-confirm-warning {
      background: #d97706;
      box-shadow: 0 4px 14px rgba(217,119,6,.35);
      color: #fff;
    }
    .sd-btn-confirm-warning:hover { background: #b45309; }
  `;

  const styleEl = document.createElement('style');
  styleEl.textContent = STYLE;
  document.head.appendChild(styleEl);

  // ── SVG icons ─────────────────────────────────────────────────────────────
  const ICONS = {
    info:    '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
    warning: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    danger:  '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>',
  };

  // ── Core render function ───────────────────────────────────────────────────
  function createDialog({ message, title, confirmText, cancelText, variant, isAlert }) {
    return new Promise(function (resolve) {
      const v       = variant || 'info';
      const iconCls = 'sd-icon-' + v;
      const btnCls  = 'sd-btn-confirm-' + v;

      const backdrop = document.createElement('div');
      backdrop.className = 'sd-dialog-backdrop';
      backdrop.innerHTML = `
        <div class="sd-dialog-card">
          <div class="sd-dialog-icon ${iconCls}">${ICONS[v] || ICONS.info}</div>
          ${title ? `<p class="sd-dialog-title">${title}</p>` : ''}
          <p class="sd-dialog-msg">${message}</p>
          <div class="sd-dialog-btns${isAlert ? ' sd-centered' : ''}">
            ${!isAlert ? `<button class="sd-btn sd-btn-cancel">${cancelText || 'Cancel'}</button>` : ''}
            <button class="sd-btn ${btnCls}"${isAlert ? ' style="min-width:130px"' : ''}>${confirmText || 'OK'}</button>
          </div>
        </div>
      `;

      function close(result) {
        backdrop.classList.remove('sd-visible');
        setTimeout(function () {
          backdrop.remove();
          resolve(result);
        }, 200);
      }

      // Button events
      const btns = backdrop.querySelectorAll('.sd-btn');
      if (!isAlert) {
        btns[0].addEventListener('click', function () { close(false); });
        btns[1].addEventListener('click', function () { close(true); });
      } else {
        btns[0].addEventListener('click', function () { close(true); });
        // Clicking backdrop also closes for alerts
        backdrop.addEventListener('click', function (e) {
          if (e.target === backdrop) close(true);
        });
      }

      document.body.appendChild(backdrop);
      // Trigger animation on next frame
      requestAnimationFrame(function () { backdrop.classList.add('sd-visible'); });
    });
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  window.dialogAlert = function (message, opts) {
    return createDialog(Object.assign({ message, isAlert: true, variant: 'info' }, opts));
  };

  window.dialogConfirm = function (message, opts) {
    return createDialog(Object.assign({
      message, isAlert: false,
      variant: 'danger',
      confirmText: 'Delete',
      cancelText: 'Cancel',
    }, opts));
  };

  // Override window.alert (fire-and-forget is fine; callers don't need return value)
  const _nativeAlert = window.alert.bind(window);
  window.alert = function (msg) {
    window.dialogAlert(String(msg == null ? '' : msg));
  };
  window._nativeAlert = _nativeAlert; // keep original accessible if needed

})();
