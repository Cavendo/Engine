/**
 * Detect the content type of a deliverable based on its content.
 * Pure function — no side effects.
 *
 * @param {string} input - The deliverable content string
 * @returns {'markdown'|'html'|'json'|'text'|'code'} Detected content type
 */
export function detectDeliverableContentType(input) {
  if (!input || !input.trim()) {
    return 'markdown';
  }

  const trimmed = input.trim();

  // HTML detection: DOCTYPE, structural tags, or tag-heavy content
  if (
    /^<!DOCTYPE\b/i.test(trimmed) ||
    /^<html[\s>]/i.test(trimmed) ||
    /^<head[\s>]/i.test(trimmed) ||
    /^<body[\s>]/i.test(trimmed) ||
    /^<(div|section|article|header|footer|nav|main|aside|form|table|ul|ol|span|p|h[1-6])\b/i.test(trimmed)
  ) {
    return 'html';
  }

  // JSON detection: valid object or array
  if (/^[\[{]/.test(trimmed)) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'object' && parsed !== null) {
        return 'json';
      }
    } catch {
      // Not valid JSON — fall through
    }
  }

  // Code detection: fenced code blocks dominating content, or code-like patterns
  const lines = trimmed.split('\n');
  const totalLines = lines.length;

  // Fenced code blocks (```)
  const fenceCount = lines.filter(l => /^```/.test(l.trim())).length;
  if (fenceCount >= 2) {
    // If most of the content is inside fenced code blocks, it's code
    const fencedRatio = fenceCount / totalLines;
    if (fencedRatio > 0.1 && totalLines <= 10) {
      return 'code';
    }
    // Large fenced blocks with minimal prose around them
    if (fenceCount >= 4) {
      return 'code';
    }
  }

  // Shebang line
  if (/^#!\//.test(trimmed)) {
    return 'code';
  }

  // Import/require/class/const/let/var/function patterns at start of lines
  const codePatterns = /^(import\s+|export\s+|const\s+|let\s+|var\s+|function\s+|class\s+|module\.exports|require\(|from\s+['"]|def\s+|package\s+|using\s+|#include\s+)/m;
  const codeLineCount = lines.filter(l => codePatterns.test(l.trim())).length;

  // Brace + semicolon density
  const braceCount = (trimmed.match(/[{}]/g) || []).length;
  const semicolonCount = (trimmed.match(/;/g) || []).length;
  const codeDensity = (braceCount + semicolonCount) / Math.max(totalLines, 1);

  if (codeLineCount >= 3 || (codeLineCount >= 1 && codeDensity > 1)) {
    return 'code';
  }

  // Markdown detection: headings, lists, bold/italic, links, images
  const markdownPatterns = /^(#{1,6}\s|[-*+]\s|\d+\.\s|>\s|\[.*\]\(.*\)|!\[|_{2,}|\*{2,}|\|.*\|)/m;
  const markdownLineCount = lines.filter(l => markdownPatterns.test(l.trim())).length;

  if (markdownLineCount >= 2) {
    return 'markdown';
  }

  // Plain text: mostly prose, minimal formatting markers
  if (totalLines >= 1 && markdownLineCount <= 1 && codeLineCount === 0 && codeDensity < 0.3) {
    // Check if it's actually plain prose (has sentences, no special formatting)
    const alphaRatio = (trimmed.match(/[a-zA-Z]/g) || []).length / trimmed.length;
    if (alphaRatio > 0.5) {
      return 'text';
    }
  }

  // Fallback
  return 'markdown';
}
