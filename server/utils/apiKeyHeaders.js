function asTrimmedString(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

export function isCavendoApiKey(value) {
  const token = asTrimmedString(value);
  return token.startsWith('cav_uk_') || token.startsWith('cav_ak_');
}

export function extractApiKeyFromRequest(req) {
  const direct = asTrimmedString(req?.headers?.['x-agent-key']);
  if (direct) return direct;

  const xApiKey = asTrimmedString(req?.headers?.['x-api-key']);
  if (xApiKey) return xApiKey;

  const authHeader = asTrimmedString(req?.headers?.authorization);
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  const bearerToken = asTrimmedString(bearerMatch?.[1] || '');
  if (isCavendoApiKey(bearerToken)) return bearerToken;

  return '';
}
