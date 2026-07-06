import net from 'net';

export function normalizeIpAddress(ipValue) {
  const raw = String(ipValue || '').trim();
  if (!raw) return '';

  const firstHop = raw.split(',')[0]?.trim() || '';
  if (!firstHop) return '';

  const unwrapped = firstHop.startsWith('[') && firstHop.endsWith(']')
    ? firstHop.slice(1, -1)
    : firstHop;

  if (unwrapped.startsWith('::ffff:')) {
    const maybeIpv4 = unwrapped.slice('::ffff:'.length);
    if (net.isIP(maybeIpv4) === 4) return maybeIpv4;
  }

  return unwrapped;
}

function isProxyTrustEnabled(req) {
  const appTrustProxy = req?.app?.get?.('trust proxy');
  if (typeof appTrustProxy === 'number') return appTrustProxy > 0;
  if (typeof appTrustProxy === 'string') {
    const normalized = appTrustProxy.trim().toLowerCase();
    return normalized !== '' && normalized !== 'false' && normalized !== '0';
  }
  if (typeof appTrustProxy === 'boolean') return appTrustProxy;
  return Boolean(process.env.TRUST_PROXY);
}

function getHeaderValue(headers, name) {
  const raw = headers?.[name];
  if (Array.isArray(raw)) return raw.find((value) => typeof value === 'string' && value.trim()) || '';
  return typeof raw === 'string' ? raw : '';
}

export function getClientIp(req) {
  const trustedProxy = isProxyTrustEnabled(req);
  const candidates = [];

  if (trustedProxy) {
    candidates.push(getHeaderValue(req?.headers, 'cf-connecting-ip'));
    candidates.push(getHeaderValue(req?.headers, 'true-client-ip'));
    candidates.push(getHeaderValue(req?.headers, 'x-forwarded-for'));
  }

  candidates.push(req?.ip);
  candidates.push(req?.socket?.remoteAddress);

  for (const candidate of candidates) {
    const normalized = normalizeIpAddress(candidate);
    if (net.isIP(normalized)) return normalized;
  }

  return '';
}
