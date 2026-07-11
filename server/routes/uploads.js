import { Router } from 'express';
import { existsSync } from 'fs';
import path from 'path';
import db from '../db/adapter.js';
import * as response from '../utils/response.js';
import { dualAuth } from '../middleware/agentAuth.js';
import { canAccessDeliverable } from '../utils/authorization.js';
import { UPLOADS_DIR, sanitizeFilename } from '../utils/deliverableFiles.js';

const router = Router();

function safeJsonParse(value, fallback = []) {
  if (typeof value !== 'string') return value || fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

/**
 * Download a deliverable artifact. Files are deliberately never served as
 * active same-origin content: even HTML is handled as an attachment.
 */
router.get('/deliverables/:id/:filename', dualAuth, async (req, res) => {
  try {
    const deliverableId = Number(req.params.id);
    const filename = String(req.params.filename || '');
    if (!Number.isInteger(deliverableId) || deliverableId <= 0 || sanitizeFilename(filename) !== filename) {
      return response.notFound(res, 'File');
    }

    const access = await canAccessDeliverable(req, deliverableId);
    if (!access.allowed) return response.notFound(res, 'File');

    const deliverable = await db.one('SELECT files FROM deliverables WHERE id = ?', [deliverableId]);
    const files = safeJsonParse(deliverable?.files, []);
    if (!Array.isArray(files) || !files.some((file) => file?.filename === filename)) {
      return response.notFound(res, 'File');
    }

    const directory = path.resolve(UPLOADS_DIR, 'deliverables', String(deliverableId));
    const filePath = path.resolve(directory, filename);
    if (!filePath.startsWith(`${directory}${path.sep}`) || !existsSync(filePath)) {
      return response.notFound(res, 'File');
    }

    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
    return res.download(filePath, filename, (err) => {
      if (err && !res.headersSent) response.serverError(res);
    });
  } catch (err) {
    console.error('Error downloading deliverable file:', err);
    return response.serverError(res);
  }
});

export default router;
