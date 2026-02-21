/**
 * Provider Endpoint Validation & Security
 *
 * Validates and normalizes provider base URLs for openai_compatible agents.
 * Enforces a two-tier security policy:
 *   - Default: only local/allowlisted endpoints permitted
 *   - Override (ALLOW_CUSTOM_PROVIDER_BASE_URLS=true): non-local remote endpoints
 *     allowed but must use HTTPS
 *
 * Environment variables:
 *   ALLOW_CUSTOM_PROVIDER_BASE_URLS - "true" to allow arbitrary remote endpoints (default: "false")
 *   PROVIDER_BASE_URL_ALLOWLIST - comma-separated hosts/IPs (e.g. "myserver.local,gpu-box.lan:11434")
 *   OPENAI_COMPAT_DEFAULT_BASE_URL - fallback base URL (default: "http://localhost:11434")
 */

import dns from 'dns/promises';
import { isPrivateOrLocalIp, isLocalHostname } from './networkUtils.js';

// Log warning at startup if override mode is active
if (process.env.ALLOW_CUSTOM_PROVIDER_BASE_URLS === 'true') {
  console.warn('[ProviderEndpoint] WARNING: ALLOW_CUSTOM_PROVIDER_BASE_URLS is enabled — remote provider endpoints are permitted (HTTPS required for non-local)');
}

/**
 * Parse the allowlist from env var.
 * Format: comma-separated hostname or hostname:port entries, case-insensitive.
 * @returns {Array<{host: string, port: string|null}>}
 */
function parseAllowlist() {
  const raw = process.env.PROVIDER_BASE_URL_ALLOWLIST || '';
  if (!raw.trim()) return [];

  return raw.split(',')
    .map(entry => entry.trim().toLowerCase())
    .filter(Boolean)
    .map(entry => {
      // Handle IPv6 bracket notation: [::1]:8080 or [::1]
      // Store the bare IPv6 address (without brackets) for comparison,
      // because URL.hostname strips brackets from IPv6 addresses.
      const ipv6Match = entry.match(/^\[([^\]]+)\](?::(\d+))?$/);
      if (ipv6Match) {
        return { host: ipv6Match[1], port: ipv6Match[2] || null };
      }
      // Standard host:port
      const lastColon = entry.lastIndexOf(':');
      if (lastColon > 0) {
        const maybePart = entry.substring(lastColon + 1);
        if (/^\d+$/.test(maybePart)) {
          return { host: entry.substring(0, lastColon), port: maybePart };
        }
      }
      return { host: entry, port: null };
    });
}

/**
 * Check if a host:port pair is in the allowlist.
 * Note: hostname should already be the value from URL.hostname (unbracketed for IPv6).
 */
function isAllowlisted(hostname, port) {
  const allowlist = parseAllowlist();
  const h = hostname.toLowerCase();
  const p = port || null;

  return allowlist.some(entry => {
    if (entry.host !== h) return false;
    // If allowlist entry has a port, it must match exactly
    if (entry.port !== null) return entry.port === p;
    // No port in allowlist entry = matches any port
    return true;
  });
}

/**
 * Determine if a URL points to a local/private endpoint.
 * Uses DNS resolution to check all resolved IPs.
 * Strict: only classified as local when ALL resolved IPs are private.
 *
 * @param {URL} parsedUrl
 * @returns {Promise<boolean>}
 */
async function isLocalEndpoint(parsedUrl) {
  const hostname = parsedUrl.hostname.toLowerCase();
  // URL.hostname keeps brackets for IPv6 (e.g. "[fd12::1]") — strip them for IP checks
  const bareHostname = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;

  // Obvious local hostnames
  if (isLocalHostname(hostname) || isLocalHostname(bareHostname)) return true;

  // Check if hostname is a raw IP (use bare form for IPv6)
  if (isPrivateOrLocalIp(bareHostname)) return true;

  // DNS resolution
  try {
    const ipv4 = await dns.resolve4(hostname).catch(() => []);
    const ipv6 = await dns.resolve6(hostname).catch(() => []);
    const allAddresses = [...ipv4, ...ipv6];

    if (allAddresses.length === 0) {
      // No DNS records — classify as non-local (safe default)
      return false;
    }

    // Strict: ALL resolved IPs must be private for it to be "local"
    return allAddresses.every(ip => isPrivateOrLocalIp(ip));
  } catch {
    return false;
  }
}

/**
 * Validate a provider base URL against security policy.
 * Enforces origin-only (scheme://host[:port]) — rejects paths, query strings, fragments.
 * Async — performs DNS resolution for locality check.
 *
 * @param {string} url - The URL to validate
 * @returns {Promise<{valid: boolean, normalizedUrl?: string, reason?: string}>}
 */
export async function validateProviderBaseUrl(url) {
  if (!url || typeof url !== 'string') {
    return { valid: false, reason: 'URL is required' };
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { valid: false, reason: 'Invalid URL format' };
  }

  // Protocol check
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { valid: false, reason: 'Only http:// and https:// protocols are allowed' };
  }

  // Origin-only enforcement — no path, query, or fragment
  if (parsed.pathname !== '/') {
    return { valid: false, reason: 'URL must be an origin only (no path). The API path /v1/chat/completions is appended automatically.' };
  }
  if (parsed.search !== '') {
    return { valid: false, reason: 'URL must not contain query parameters' };
  }
  if (parsed.hash !== '') {
    return { valid: false, reason: 'URL must not contain a fragment' };
  }

  // Normalize to origin (strips trailing slash)
  const normalizedUrl = `${parsed.protocol}//${parsed.host}`;
  const hostname = parsed.hostname.toLowerCase();
  // URL.hostname keeps brackets for IPv6 — strip for allowlist comparison
  const bareHostname = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  const port = parsed.port || null;

  const allowCustom = process.env.ALLOW_CUSTOM_PROVIDER_BASE_URLS === 'true';
  const local = await isLocalEndpoint(parsed);
  const allowlisted = isAllowlisted(bareHostname, port);

  if (local || allowlisted) {
    // Local and allowlisted endpoints: http and https both allowed
    return { valid: true, normalizedUrl };
  }

  if (!allowCustom) {
    // Default mode: non-local, non-allowlisted endpoints are blocked entirely
    return {
      valid: false,
      reason: 'Only local and allowlisted endpoints are permitted. Set ALLOW_CUSTOM_PROVIDER_BASE_URLS=true to allow remote endpoints, or add this host to PROVIDER_BASE_URL_ALLOWLIST.'
    };
  }

  // Override mode: non-local remote endpoints must use HTTPS
  if (parsed.protocol !== 'https:') {
    return {
      valid: false,
      reason: 'Remote (non-local) endpoints must use HTTPS'
    };
  }

  return { valid: true, normalizedUrl };
}

/**
 * Resolve the effective base URL for an agent.
 *
 * @param {Object} agent - Agent record with provider and provider_base_url fields
 * @returns {string|null} Base URL or null (executor uses hardcoded defaults)
 */
export function resolveBaseUrl(agent) {
  if (agent.provider === 'openai_compatible') {
    if (agent.provider_base_url) {
      return agent.provider_base_url;
    }
    return process.env.OPENAI_COMPAT_DEFAULT_BASE_URL || 'http://localhost:11434';
  }

  // openai and anthropic use hardcoded URLs in the executor
  return null;
}
