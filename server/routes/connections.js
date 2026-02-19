/**
 * Storage Connections API
 * CRUD endpoints for reusable S3 storage credentials
 */

import express from 'express';
import db from '../db/connection.js';
import { userAuth, requireRoles } from '../middleware/userAuth.js';
import * as response from '../utils/response.js';
import { validateBody, validateParams, idParamSchema } from '../utils/validation.js';
import { z } from 'zod';
import { encrypt, decrypt } from '../utils/crypto.js';
import { testS3Connection } from '../services/s3Provider.js';

const router = express.Router();

// ============================================
// Validation Schemas
// ============================================

const createConnectionSchema = z.object({
  name: z.string().min(1, 'Name is required').max(255),
  provider: z.enum(['s3']).default('s3'),
  bucket: z.string().min(1, 'Bucket name is required'),
  region: z.string().optional().default('us-east-1'),
  endpoint: z.string().url().optional().nullable(),
  access_key_id: z.string().min(1, 'Access key is required'),
  secret_access_key: z.string().min(1, 'Secret key is required')
});

const updateConnectionSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  bucket: z.string().min(1).optional(),
  region: z.string().optional(),
  endpoint: z.string().url().optional().nullable(),
  access_key_id: z.string().min(1).optional(),
  secret_access_key: z.string().min(1).optional()
}).refine(data => Object.keys(data).length > 0, {
  message: 'At least one field must be provided'
});

// ============================================
// Helper
// ============================================

function formatConnection(conn) {
  return {
    id: conn.id,
    name: conn.name,
    provider: conn.provider,
    bucket: conn.bucket,
    region: conn.region,
    endpoint: conn.endpoint || null,
    accessKeyIdPreview: conn.access_key_id_preview,
    routeCount: conn.route_count ?? 0,
    createdBy: conn.created_by,
    createdAt: conn.created_at,
    updatedAt: conn.updated_at
  };
}

// ============================================
// Endpoints
// ============================================

/**
 * GET /api/storage-connections
 * List all stored connections (credentials redacted)
 */
router.get('/', userAuth, requireRoles('admin'), async (req, res) => {
  try {
    const connections = db.prepare(`
      SELECT sc.*,
        (SELECT COUNT(*) FROM routes r
         WHERE r.destination_type = 'storage'
           AND json_extract(r.destination_config, '$.connection_id') = sc.id
        ) as route_count
      FROM storage_connections sc
      ORDER BY sc.name ASC
    `).all();
    response.success(res, connections.map(formatConnection));
  } catch (err) {
    console.error('Error listing storage connections:', err);
    response.serverError(res);
  }
});

/**
 * POST /api/storage-connections
 * Create a new stored connection
 */
router.post('/', userAuth, requireRoles('admin'), validateBody(createConnectionSchema), async (req, res) => {
  try {
    const { name, provider, bucket, region, endpoint, access_key_id, secret_access_key } = req.body;

    // Encrypt credentials
    const akEncrypted = encrypt(access_key_id);
    const skEncrypted = encrypt(secret_access_key);
    const akPreview = '...' + access_key_id.slice(-4);

    const result = db.prepare(`
      INSERT INTO storage_connections (
        name, provider, bucket, region, endpoint,
        access_key_id_encrypted, access_key_id_iv, access_key_id_preview,
        secret_access_key_encrypted, secret_access_key_iv,
        created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      name, provider || 's3', bucket, region || 'us-east-1', endpoint || null,
      akEncrypted.encrypted, akEncrypted.iv, akPreview,
      skEncrypted.encrypted, skEncrypted.iv,
      req.user?.id || null
    );

    const conn = db.prepare('SELECT * FROM storage_connections WHERE id = ?').get(result.lastInsertRowid);
    response.created(res, formatConnection(conn));
  } catch (err) {
    console.error('Error creating storage connection:', err);
    response.serverError(res);
  }
});

/**
 * PUT /api/storage-connections/:id
 * Update a stored connection
 */
router.put('/:id', userAuth, requireRoles('admin'), validateParams(idParamSchema), validateBody(updateConnectionSchema), async (req, res) => {
  try {
    const conn = db.prepare('SELECT * FROM storage_connections WHERE id = ?').get(req.params.id);
    if (!conn) return response.notFound(res, 'Storage connection');

    const { name, bucket, region, endpoint, access_key_id, secret_access_key } = req.body;

    const updates = [];
    const values = [];

    if (name !== undefined) { updates.push('name = ?'); values.push(name); }
    if (bucket !== undefined) { updates.push('bucket = ?'); values.push(bucket); }
    if (region !== undefined) { updates.push('region = ?'); values.push(region); }
    if (endpoint !== undefined) { updates.push('endpoint = ?'); values.push(endpoint || null); }

    if (access_key_id !== undefined) {
      const akEncrypted = encrypt(access_key_id);
      updates.push('access_key_id_encrypted = ?', 'access_key_id_iv = ?', 'access_key_id_preview = ?');
      values.push(akEncrypted.encrypted, akEncrypted.iv, '...' + access_key_id.slice(-4));
    }

    if (secret_access_key !== undefined) {
      const skEncrypted = encrypt(secret_access_key);
      updates.push('secret_access_key_encrypted = ?', 'secret_access_key_iv = ?');
      values.push(skEncrypted.encrypted, skEncrypted.iv);
    }

    updates.push("updated_at = datetime('now')");
    values.push(req.params.id);

    db.prepare(`UPDATE storage_connections SET ${updates.join(', ')} WHERE id = ?`).run(...values);

    const updated = db.prepare('SELECT * FROM storage_connections WHERE id = ?').get(req.params.id);
    response.success(res, formatConnection(updated));
  } catch (err) {
    console.error('Error updating storage connection:', err);
    response.serverError(res);
  }
});

/**
 * DELETE /api/storage-connections/:id
 * Delete a stored connection (blocked if routes reference it)
 */
router.delete('/:id', userAuth, requireRoles('admin'), validateParams(idParamSchema), async (req, res) => {
  try {
    const conn = db.prepare('SELECT * FROM storage_connections WHERE id = ?').get(req.params.id);
    if (!conn) return response.notFound(res, 'Storage connection');

    // Check if any routes reference this connection
    const routes = db.prepare(`
      SELECT id, name FROM routes
      WHERE destination_type = 'storage'
        AND json_extract(destination_config, '$.connection_id') = ?
    `).all(req.params.id);

    if (routes.length > 0) {
      const routeNames = routes.map(r => r.name).join(', ');
      return response.error(res,
        `Cannot delete — connection is used by ${routes.length} route(s): ${routeNames}`,
        409, 'CONNECTION_IN_USE'
      );
    }

    db.prepare('DELETE FROM storage_connections WHERE id = ?').run(req.params.id);
    response.success(res, { message: 'Storage connection deleted' });
  } catch (err) {
    console.error('Error deleting storage connection:', err);
    response.serverError(res);
  }
});

/**
 * POST /api/storage-connections/:id/test
 * Test a stored connection (decrypt credentials and HeadBucket)
 */
router.post('/:id/test', userAuth, requireRoles('admin'), validateParams(idParamSchema), async (req, res) => {
  try {
    const conn = db.prepare('SELECT * FROM storage_connections WHERE id = ?').get(req.params.id);
    if (!conn) return response.notFound(res, 'Storage connection');

    const config = {
      provider: conn.provider,
      bucket: conn.bucket,
      region: conn.region,
      endpoint: conn.endpoint,
      access_key_id: decrypt(conn.access_key_id_encrypted, conn.access_key_id_iv),
      secret_access_key: decrypt(conn.secret_access_key_encrypted, conn.secret_access_key_iv)
    };

    const result = await testS3Connection(config);

    if (result.success) {
      response.success(res, { success: true, message: result.message, detail: result.detail });
    } else {
      res.status(400).json({
        success: false,
        error: {
          code: 'CONNECTION_TEST_FAILED',
          message: result.message,
          detail: result.detail || null
        }
      });
    }
  } catch (err) {
    console.error('Error testing storage connection:', err);
    response.serverError(res);
  }
});

export default router;
