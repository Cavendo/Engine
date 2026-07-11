/**
 * Safe outbound HTTP helpers.
 *
 * Validation returns a resolved public IP and every connection uses that IP
 * through a custom lookup function. This closes the validate-then-re-resolve
 * window that otherwise permits DNS rebinding SSRF.
 */
import dns from 'dns/promises';
import http from 'http';
import https from 'https';
import net from 'net';
import { URL } from 'url';
import { isLocalHostname, isPrivateOrLocalIp } from './networkUtils.js';

function bareHostname(hostname) {
  return String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
}

function privateWebhooksAllowed() {
  return process.env.ALLOW_PRIVATE_WEBHOOKS === 'true' && process.env.NODE_ENV !== 'production';
}

/**
 * Validate an HTTP URL, resolve it once, and return a selected pinned address.
 */
export async function validateOutboundHttpUrl(urlString, {
  allowPrivate = privateWebhooksAllowed(),
  requireHttpsInProduction = false
} = {}) {
  let url;
  try {
    url = new URL(urlString);
  } catch {
    return { valid: false, reason: 'Invalid URL format' };
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    return { valid: false, reason: 'Only HTTP(S) URLs are allowed' };
  }
  if (url.username || url.password) {
    return { valid: false, reason: 'URLs with embedded credentials are not allowed' };
  }
  if (requireHttpsInProduction && process.env.NODE_ENV === 'production' && url.protocol !== 'https:') {
    return { valid: false, reason: 'HTTPS is required in production' };
  }

  const hostname = bareHostname(url.hostname);
  if (!allowPrivate && (isLocalHostname(hostname) || isPrivateOrLocalIp(hostname))) {
    return { valid: false, reason: 'Private/internal URLs are not allowed' };
  }

  let addresses;
  try {
    addresses = net.isIP(hostname)
      ? [{ address: hostname, family: net.isIP(hostname) }]
      : await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    return { valid: false, reason: 'Could not resolve hostname' };
  }

  if (!addresses.length) {
    return { valid: false, reason: 'Could not resolve hostname' };
  }
  if (!allowPrivate && addresses.some(({ address }) => isPrivateOrLocalIp(address))) {
    return { valid: false, reason: 'URL resolves to private IP' };
  }

  const selected = addresses[0];
  return { valid: true, url, hostname, address: selected.address, family: selected.family };
}

export function createPinnedLookup(validation) {
  const address = validation?.address;
  const family = validation?.family || net.isIP(address);
  if (!address || !family) {
    throw new Error('A validated outbound address is required');
  }

  return (_hostname, options, callback) => {
    const done = typeof options === 'function' ? options : callback;
    done(null, address, family);
  };
}

/**
 * Issue a non-redirecting request using the IP selected at validation time.
 * The URL hostname remains intact for Host and TLS certificate validation.
 */
export async function fetchPinned(validation, {
  method = 'GET',
  headers = {},
  body,
  timeoutMs = 10_000
} = {}) {
  if (!validation?.valid || !validation.url || !validation.address) {
    throw new Error('Outbound URL must be validated before connecting');
  }

  const url = validation.url;
  const transport = url.protocol === 'https:' ? https : http;
  const lookup = createPinnedLookup(validation);

  return new Promise((resolve, reject) => {
    const request = transport.request({
      protocol: url.protocol,
      hostname: bareHostname(url.hostname),
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method,
      headers,
      lookup,
      servername: bareHostname(url.hostname),
      rejectUnauthorized: true
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          ok: Boolean(res.statusCode && res.statusCode >= 200 && res.statusCode < 300),
          status: res.statusCode || 0,
          headers: res.headers,
          text: async () => text
        });
      });
    });

    request.setTimeout(timeoutMs, () => request.destroy(new Error(`Request timeout after ${timeoutMs}ms`)));
    request.once('error', reject);
    if (body !== undefined && body !== null) request.write(body);
    request.end();
  });
}

export function createPinnedAgents(validation) {
  const lookup = createPinnedLookup(validation);
  return {
    httpAgent: new http.Agent({ lookup }),
    httpsAgent: new https.Agent({ lookup })
  };
}
