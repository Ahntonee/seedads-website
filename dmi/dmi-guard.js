(function () {
  // ── Public DMI catalog ──────────────────────────────────────────────────
  // Anyone can browse courses and watch preview clips WITHOUT registering.
  // Full content (videos, PDFs, downloads) is unlocked only for approved (paid)
  // users — this is enforced server-side by /api/dmi and /api/dmi/download.
  //
  // This guard no longer blocks or redirects. Its only job now is to keep the
  // stored user fresh (so a newly-approved user gets full access without having
  // to log in again) and to drop a stale/expired token.
  const token = localStorage.getItem('seedads_user_token');
  if (!token) return; // anonymous visitor — browse freely

  fetch('/api/users/me', { headers: { Authorization: 'Bearer ' + token } })
    .then(function (r) {
      if (r.status === 401) {
        localStorage.removeItem('seedads_user_token');
        localStorage.removeItem('seedads_user');
        return null;
      }
      return r.json();
    })
    .then(function (data) {
      if (data && data.user) {
        localStorage.setItem('seedads_user', JSON.stringify(data.user));
      }
    })
    .catch(function () { /* offline / transient — never block the catalog */ });
})();
