import { readFileSync } from 'fs';

function decodeEscapedChar(ch) {
  if (ch === 'n') return '\n';
  if (ch === 'r') return '\r';
  if (ch === 't') return '\t';
  return ch;
}

function parseQuotedValue(rawValue, quote) {
  let value = '';
  let escaped = false;
  let closed = false;

  for (let i = 1; i < rawValue.length; i++) {
    const ch = rawValue[i];

    if (escaped) {
      value += quote === '"' ? decodeEscapedChar(ch) : ch;
      escaped = false;
      continue;
    }

    if (ch === '\\') {
      escaped = true;
      continue;
    }

    if (ch === quote) {
      closed = true;
      break;
    }

    value += ch;
  }

  if (!closed) {
    return rawValue.slice(1);
  }

  return value;
}

function parseEnvLine(line) {
  const withoutCr = String(line || '').replace(/\r$/, '');
  if (!withoutCr.trim()) return null;
  if (/^\s*#/.test(withoutCr)) return null;

  const exported = withoutCr.replace(/^\s*export\s+/, '');
  const eqIdx = exported.indexOf('=');
  if (eqIdx < 1) return null;

  const key = exported.slice(0, eqIdx).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;

  const rawValue = exported.slice(eqIdx + 1).trim();
  if (!rawValue) return { key, value: '' };

  const first = rawValue[0];
  if (first === '"' || first === "'") {
    return { key, value: parseQuotedValue(rawValue, first) };
  }

  // Support inline comments for unquoted values when preceded by whitespace.
  const value = rawValue.replace(/\s+#.*$/, '').trim();
  return { key, value };
}

export function parseEnvContent(content) {
  const entries = [];
  for (const line of String(content || '').split('\n')) {
    const parsed = parseEnvLine(line);
    if (parsed) entries.push(parsed);
  }
  return entries;
}

export function loadEnvFromString(content, { override = false } = {}) {
  let loaded = 0;
  for (const { key, value } of parseEnvContent(content)) {
    if (override || process.env[key] === undefined) {
      process.env[key] = value;
      loaded += 1;
    }
  }
  return loaded;
}

export function loadEnvFromFile(path, { override = false } = {}) {
  const content = readFileSync(path, 'utf-8');
  return loadEnvFromString(content, { override });
}
