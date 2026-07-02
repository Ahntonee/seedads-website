'use strict';
/**
 * asyncHandler — wraps an async Express handler so any thrown/rejected error
 * is forwarded to the global error handler (server.js) instead of needing a
 * try/catch in every route.
 *
 * Behaviour is identical to the previous per-route pattern: the global handler
 * logs the error and returns `{ error: 'Internal server error' }` with status
 * 500 for /api/* routes — exactly what each handler used to return itself.
 *
 *   router.get('/x', asyncHandler(async (req, res) => { ... }));
 */
module.exports = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
