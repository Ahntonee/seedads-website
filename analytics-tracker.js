/**
 * SeedsAds page-view tracker
 * Include on any public page: <script src="/analytics-tracker.js" defer></script>
 * Fires once per page load; does not track admin or user dashboard pages.
 */
(function () {
  // Skip admin and user portal pages
  const skipPaths = ['/admin/', '/user/dashboard'];
  if (skipPaths.some(p => window.location.pathname.includes(p))) return;

  window.addEventListener('load', function () {
    try {
      fetch('/api/analytics/pageview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: window.location.pathname,
          referrer: document.referrer || null,
        }),
        keepalive: true,
      });
    } catch (_) {}
  });
})();
