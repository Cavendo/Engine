/**
 * Shared utilities for deliverable file handling.
 * Extracted from server/routes/deliverables.js for reuse by agentExecutor.
 */

import { promises as fs } from 'fs';
import path from 'path';

/** Directory where deliverable file attachments are stored */
export const UPLOADS_DIR = path.join(process.cwd(), 'data', 'uploads');

/** Maximum size per file (10MB) */
export const MAX_FILE_SIZE = 10 * 1024 * 1024;

/** Maximum total size of all files (50MB) */
export const MAX_TOTAL_FILES_SIZE = 50 * 1024 * 1024;

/** Maximum number of artifact files per deliverable */
export const MAX_ARTIFACT_COUNT = 5;

/** MIME type map from file extension */
const MIME_TYPES = {
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.xml': 'application/xml',
  '.zip': 'application/zip',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.csv': 'text/csv',
};

/**
 * Allowed MIME types for agent-produced artifacts.
 * Conservative allowlist: documents, images, and data formats only.
 * Excludes scriptable/web types (.html, .js, .svg, .xml, .zip, .css) to
 * prevent agents from producing executable content.
 */
const ALLOWED_ARTIFACT_MIME_TYPES = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/gif',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

/**
 * Get MIME type from filename extension.
 * @param {string} filename
 * @returns {string} MIME type string
 */
export function getMimeType(filename) {
  const ext = path.extname(filename).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

/**
 * Check whether a MIME type is in the allowed set.
 * @param {string} mimeType
 * @returns {boolean}
 */
export function isAllowedMimeType(mimeType) {
  return ALLOWED_ARTIFACT_MIME_TYPES.has(mimeType);
}

/**
 * Sanitize a filename to only safe characters.
 * @param {string} name - Original filename
 * @returns {string} Sanitized filename
 */
export function sanitizeFilename(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/**
 * Ensure the uploads directory exists.
 */
export async function ensureUploadsDir() {
  await fs.mkdir(UPLOADS_DIR, { recursive: true });
}

/**
 * Validate an array of artifacts against size and count policies.
 * @param {Array<{filename: string, content: string, encoding?: string}>} artifacts
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateArtifactPolicy(artifacts) {
  const errors = [];

  if (!Array.isArray(artifacts)) {
    return { valid: false, errors: ['artifacts must be an array'] };
  }

  if (artifacts.length > MAX_ARTIFACT_COUNT) {
    errors.push(`Too many artifacts: ${artifacts.length} exceeds maximum of ${MAX_ARTIFACT_COUNT}`);
  }

  let totalSize = 0;
  for (const artifact of artifacts) {
    let size;
    if (artifact.encoding === 'base64') {
      // Base64 string → approximate decoded size
      size = Math.ceil((artifact.content || '').length * 3 / 4);
    } else {
      size = Buffer.byteLength(artifact.content || '', 'utf8');
    }

    if (size > MAX_FILE_SIZE) {
      errors.push(`File ${artifact.filename} exceeds maximum size of 10MB`);
    }
    totalSize += size;
  }

  if (totalSize > MAX_TOTAL_FILES_SIZE) {
    errors.push('Total file size exceeds maximum of 50MB');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Save a deliverable file attachment to disk.
 * @param {string} filename - Original filename
 * @param {string} content - File content (text or base64-encoded)
 * @param {number|string} deliverableId - ID of the parent deliverable
 * @param {Object} [opts]
 * @param {boolean} [opts.isBase64=false] - If true, content is raw base64 (no 'base64:' prefix)
 * @param {string[]} [opts.existingNames] - Already-used filenames for dedup
 * @returns {Promise<{filename: string, path: string, size: number}>}
 */
export async function saveDeliverableFile(filename, content, deliverableId, opts = {}) {
  const deliverableDir = path.join(UPLOADS_DIR, 'deliverables', String(deliverableId));
  await fs.mkdir(deliverableDir, { recursive: true });

  let safeName = sanitizeFilename(filename);

  // De-duplicate against existing names
  if (opts.existingNames && opts.existingNames.includes(safeName)) {
    const ext = path.extname(safeName);
    const base = safeName.slice(0, safeName.length - ext.length);
    let counter = 1;
    while (opts.existingNames.includes(`${base}_${counter}${ext}`)) {
      counter++;
    }
    safeName = `${base}_${counter}${ext}`;
  }

  const filePath = path.join(deliverableDir, safeName);

  if (opts.isBase64) {
    await fs.writeFile(filePath, Buffer.from(content, 'base64'));
  } else if (content.startsWith('base64:')) {
    const base64Data = content.slice(7);
    await fs.writeFile(filePath, Buffer.from(base64Data, 'base64'));
  } else {
    await fs.writeFile(filePath, content, 'utf8');
  }

  const stats = await fs.stat(filePath);
  return {
    filename: safeName,
    path: `/uploads/deliverables/${deliverableId}/${safeName}`,
    size: stats.size
  };
}
