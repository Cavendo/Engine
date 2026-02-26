/**
 * Parse an agent's raw output to detect a structured deliverable envelope.
 *
 * An envelope is a JSON object with an `artifacts` array — the discriminator.
 * Plain JSON (object/array without `artifacts`) is treated as normal content.
 *
 * Parse-only: no file I/O, no side effects.
 */

import { isAllowedMimeType, getMimeType, validateArtifactPolicy } from './deliverableFiles.js';

const VALID_CONTENT_TYPES = new Set(['markdown', 'html', 'json', 'text', 'code']);

/**
 * Check if a string is valid base64.
 * @param {string} str
 * @returns {boolean}
 */
function isValidBase64(str) {
  if (!str || typeof str !== 'string') return false;
  const cleaned = str.replace(/\s/g, '');
  if (cleaned.length === 0) return false;
  // Regex: valid base64 charset + padding
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned)) return false;
  // Length must be a multiple of 4 (with padding)
  if (cleaned.length % 4 !== 0) return false;
  // Round-trip check: decode and re-encode to catch permissive Buffer.from edge cases
  const decoded = Buffer.from(cleaned, 'base64');
  return decoded.toString('base64') === cleaned;
}

/**
 * Parse raw agent output to detect and validate a deliverable envelope.
 *
 * @param {string} raw - Raw string output from agent
 * @returns {{
 *   isEnvelope: boolean,
 *   title?: string,
 *   summary?: string,
 *   content?: string,
 *   contentTypeHint?: string,
 *   artifacts: Array<{filename: string, mime_type: string, encoding: string, content: string}>,
 *   errors: string[]
 * }}
 */
export function parseAgentDeliverableEnvelope(raw) {
  const noEnvelope = { isEnvelope: false, artifacts: [], errors: [] };

  if (!raw || typeof raw !== 'string') {
    return noEnvelope;
  }

  const trimmed = raw.trim();

  // Must start with { to be an envelope candidate
  if (!trimmed.startsWith('{')) {
    return noEnvelope;
  }

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return noEnvelope;
  }

  // Must be a plain object (not array, not null)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return noEnvelope;
  }

  // Discriminator: must look like a deliberate envelope, not arbitrary JSON.
  // Option A: has `artifacts` key (the primary signal)
  // Option B: has `content_type` AND at least one of title/summary/content (envelope metadata)
  // This prevents plain JSON payloads with a stray `content_type` field from being misclassified.
  const hasArtifactsKey = 'artifacts' in parsed;
  const hasContentTypeKey = 'content_type' in parsed;
  const hasEnvelopeMetadata = ('title' in parsed || 'summary' in parsed || 'content' in parsed);
  if (!hasArtifactsKey && !(hasContentTypeKey && hasEnvelopeMetadata)) {
    return noEnvelope;
  }

  // It's an envelope — validate fields
  const errors = [];
  const result = {
    isEnvelope: true,
    title: undefined,
    summary: undefined,
    content: undefined,
    contentTypeHint: undefined,
    artifacts: [],
    errors
  };

  // Optional string fields
  if (parsed.title != null) {
    if (typeof parsed.title === 'string') {
      result.title = parsed.title;
    } else {
      errors.push('title must be a string');
    }
  }

  if (parsed.summary != null) {
    if (typeof parsed.summary === 'string') {
      result.summary = parsed.summary;
    } else {
      errors.push('summary must be a string');
    }
  }

  if (parsed.content != null) {
    if (typeof parsed.content === 'string') {
      result.content = parsed.content;
    } else {
      errors.push('content must be a string');
    }
  }

  // Optional content_type hint
  if (parsed.content_type != null) {
    if (typeof parsed.content_type === 'string' && VALID_CONTENT_TYPES.has(parsed.content_type)) {
      result.contentTypeHint = parsed.content_type;
    } else {
      errors.push(`Invalid content_type: ${parsed.content_type}. Must be one of: ${[...VALID_CONTENT_TYPES].join(', ')}`);
    }
  }

  // Validate artifacts array
  if (hasArtifactsKey && !Array.isArray(parsed.artifacts)) {
    errors.push('artifacts must be an array');
    return result;
  }

  const artifactsArray = Array.isArray(parsed.artifacts) ? parsed.artifacts : [];

  // Validate each artifact
  for (let i = 0; i < artifactsArray.length; i++) {
    const art = artifactsArray[i];
    const prefix = `artifacts[${i}]`;

    if (typeof art !== 'object' || art === null || Array.isArray(art)) {
      errors.push(`${prefix}: must be an object`);
      continue;
    }

    // Required: filename
    if (!art.filename || typeof art.filename !== 'string' || !art.filename.trim()) {
      errors.push(`${prefix}: filename is required and must be a non-empty string`);
      continue;
    }

    // Required: encoding must be 'base64'
    if (art.encoding !== 'base64') {
      errors.push(`${prefix}: encoding must be 'base64', got '${art.encoding}'`);
      continue;
    }

    // Required: content (base64 string)
    if (!art.content || typeof art.content !== 'string') {
      errors.push(`${prefix}: content is required and must be a base64 string`);
      continue;
    }

    if (!isValidBase64(art.content)) {
      errors.push(`${prefix}: content is not valid base64`);
      continue;
    }

    // Validate MIME type
    const extensionMime = getMimeType(art.filename);
    const mimeType = art.mime_type || extensionMime;

    if (!isAllowedMimeType(mimeType)) {
      errors.push(`${prefix}: MIME type '${mimeType}' is not allowed`);
      continue;
    }

    // Extension+MIME consistency: if both provided, they must agree
    if (art.mime_type && extensionMime !== 'application/octet-stream' && art.mime_type !== extensionMime) {
      errors.push(`${prefix}: MIME type '${art.mime_type}' does not match file extension (expected '${extensionMime}')`);
      continue;
    }

    result.artifacts.push({
      filename: art.filename.trim(),
      mime_type: mimeType,
      encoding: 'base64',
      content: art.content
    });
  }

  // Validate artifact policy (count, sizes)
  if (result.artifacts.length > 0) {
    const policy = validateArtifactPolicy(result.artifacts);
    if (!policy.valid) {
      errors.push(...policy.errors);
    }
  }

  // Reject envelopes with neither inline content nor valid artifacts
  if (!result.content && result.artifacts.length === 0 && errors.length === 0) {
    errors.push('Envelope must contain at least one of: content, or valid artifacts');
  }

  return result;
}
