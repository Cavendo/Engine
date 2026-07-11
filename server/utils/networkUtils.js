/**
 * Shared IP classification utilities for SSRF protection and provider endpoint validation.
 * Single source of truth for private/local IP detection — used by:
 *   - webhooks.js (SSRF protection for outbound webhooks)
 *   - providerEndpoint.js (provider base URL locality checks)
 *   - validation.js (endpoint validation with DNS)
 */

// Private/local IPv4 patterns
const PRIVATE_IP_PATTERNS = [
  /^10\./,                          // 10.0.0.0/8
  /^172\.(1[6-9]|2[0-9]|3[01])\./,  // 172.16.0.0/12
  /^192\.168\./,                    // 192.168.0.0/16
  /^127\./,                         // 127.0.0.0/8
  /^0\./,                           // 0.0.0.0/8
  /^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./, // shared address space
  /^169\.254\./,                    // 169.254.0.0/16 (link-local)
  /^192\.0\.0\./,                  // IANA special-purpose range
];

/**
 * Check if an IP address is private or local (not routable on the public internet).
 * Covers IPv4 private ranges (RFC1918), loopback, link-local,
 * and IPv6 equivalents (::1, fe80::/10, fc00::/7).
 *
 * @param {string} ip - An IPv4 or IPv6 address string
 * @returns {boolean} true if the IP is private/local
 */
export function isPrivateOrLocalIp(ip) {
  if (!ip) return false;

  // Check IPv4 patterns
  for (const pattern of PRIVATE_IP_PATTERNS) {
    if (pattern.test(ip)) return true;
  }

  // Check IPv6 private/local ranges
  if (ip === '::' || ip === '::1') return true;    // unspecified / loopback
  if (/^fe[89ab][0-9a-f]:/i.test(ip)) return true; // link-local (fe80::/10)
  if (/^f[cd][0-9a-f]{2}:/i.test(ip)) return true; // unique local (fc00::/7)

  // IPv4-mapped IPv6 (::ffff:x.x.x.x) — extract and re-check
  const v4mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (v4mapped) {
    return isPrivateOrLocalIp(v4mapped[1]);
  }

  return false;
}

/**
 * Check if a hostname is obviously local (without DNS resolution).
 * @param {string} hostname - lowercase hostname
 * @returns {boolean}
 */
export function isLocalHostname(hostname) {
  return hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]' ||
    hostname === '0.0.0.0';
}

// Re-export the patterns for consumers that need direct access (e.g., webhooks.js)
export { PRIVATE_IP_PATTERNS };
