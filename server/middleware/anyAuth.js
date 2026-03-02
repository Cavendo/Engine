import * as response from '../utils/response.js';

/**
 * Combine non-writing auth probes. First successful probe wins.
 * Probe signature: async (req) => { ok: boolean, auth?: object }
 */
export function anyAuth(probes) {
  return async (req, res, next) => {
    for (const probe of probes) {
      try {
        const result = await probe(req);
        if (result?.ok) {
          req.auth = result.auth;
          if (req.auth?.type === 'user' && result.user) {
            req.user = result.user;
          }
          return next();
        }
      } catch {
        // Probe failures are treated as auth failure; try next probe.
      }
    }
    return response.unauthorized(res, 'Authentication required');
  };
}
