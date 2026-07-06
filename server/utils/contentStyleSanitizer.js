const DEFAULT_BLOCKED_PHRASES = [
  'delve',
  'tapestry',
  'navigate the complexities of',
  'navigate the landscape',
  'in the realm of',
  'it is important to note',
  'moreover',
  'furthermore',
];

function splitFencedBlocks(text) {
  return String(text || '').split(/(```[\s\S]*?```)/g);
}

function looksLikeJsonLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return false;
  return /^[{}\[\],:]$/.test(trimmed)
    || /^["'][^"']+["']\s*:/.test(trimmed)
    || /^[{}\[\]]/.test(trimmed)
    || /[{}\[\]]$/.test(trimmed);
}

function looksLikeMarkdownRule(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed) return false;
  return /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(trimmed);
}

function looksLikeMarkdownTableSeparator(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed.includes('|') || !trimmed.includes('-')) return false;
  const cells = trimmed
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())
    .filter(Boolean);
  if (cells.length < 2) return false;
  return cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function shouldSkipLine(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed) return false;
  if (looksLikeMarkdownRule(trimmed)) return true;
  if (looksLikeMarkdownTableSeparator(trimmed)) return true;
  if (/^>/.test(trimmed)) return true;
  if (/https?:\/\/|www\./i.test(trimmed)) return true;
  if (/<[a-z][^>]*\s[a-z-]+=(["']).*?\1[^>]*>/i.test(trimmed)) return true;
  if (/^\s*<\/?[a-z][^>]*>\s*$/i.test(trimmed)) return true;
  if (looksLikeJsonLine(trimmed)) return true;
  return false;
}

function replaceDashes(line, changes) {
  let next = line;
  if (next.includes('—')) {
    next = next
      .replace(/\s+—\s+/g, ', ')
      .replace(/—/g, ', ');
    changes.push({ type: 'em_dash', replacement: 'comma' });
  }
  if (next.includes('--')) {
    next = next.replace(/\s*--\s*/g, ', ');
    changes.push({ type: 'double_hyphen', replacement: 'comma' });
  }
  return next;
}

function replaceBlockedPhrases(line, changes, blockedPhrases = DEFAULT_BLOCKED_PHRASES) {
  let next = line;
  for (const phrase of blockedPhrases) {
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`\\b${escaped}\\b`, 'ig');
    if (!pattern.test(next)) continue;
    next = next.replace(pattern, '');
    changes.push({ type: 'blocked_phrase', phrase });
  }
  return next.replace(/\s{2,}/g, ' ').replace(/\s+([,.;:!?])/g, '$1');
}

export function sanitizeGeneratedContentStyle(content, options = {}) {
  if (typeof content !== 'string' || !content) {
    return { content, changed: false, changes: [] };
  }

  const changes = [];
  const blockedPhrases = Array.isArray(options.blockedPhrases)
    ? options.blockedPhrases.filter(Boolean)
    : DEFAULT_BLOCKED_PHRASES;

  const sanitized = splitFencedBlocks(content).map((segment) => {
    if (segment.startsWith('```')) return segment;
    return segment.split('\n').map((line) => {
      if (shouldSkipLine(line)) return line;
      let next = replaceDashes(line, changes);
      next = replaceBlockedPhrases(next, changes, blockedPhrases);
      return next;
    }).join('\n');
  }).join('');

  const changed = sanitized !== content;
  return {
    content: sanitized,
    changed,
    changes: changed ? changes : [],
  };
}

export default sanitizeGeneratedContentStyle;
