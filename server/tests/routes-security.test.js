/**
 * Security tests for route endpoints
 * Verifies that non-admin users cannot access sensitive data
 *
 * These tests import the ACTUAL helper functions from routes.js
 * to ensure real implementation behavior is tested.
 */

import { describe, it, expect } from '@jest/globals';
import { sanitizeDestinationConfig, formatDeliveryLog, safeJsonParse, sanitizeUrl } from '../utils/routeHelpers.js';

// Mock data simulating what formatRoute and formatDeliveryLog receive
const mockWebhookConfig = {
  url: 'https://example.com/webhook',
  signing_secret: 'whsec_supersecretkey123',
  headers: {
    'Authorization': 'Bearer secret-token-abc123',
    'X-Custom-Header': 'sensitive-value'
  }
};

const mockDeliveryLog = {
  id: 1,
  route_id: 1,
  event_type: 'deliverable.approved',
  event_payload: JSON.stringify({
    event: 'deliverable.approved',
    timestamp: '2026-02-15T10:00:00Z',
    project: { id: 1, name: 'Test Project' },
    deliverable: {
      id: 123,
      title: 'Secret Report',
      content: 'This is highly confidential content that should not leak',
      summary: 'Confidential summary with sensitive details',
      status: 'approved',
      files: [{ filename: 'secret.pdf', path: '/uploads/secret.pdf' }]
    },
    task: {
      id: 456,
      title: 'Confidential Task',
      description: 'Secret task description with internal details',
      context: { api_key: 'internal-key-xyz' }
    }
  }),
  status: 'delivered',
  attempt_number: 1,
  response_status: 200,
  response_body: JSON.stringify({
    success: true,
    internal_id: 'abc123',
    debug: { token: 'leaked-token' }
  }),
  error_message: 'Connection failed: API key sk-secret-key-123 is invalid',
  dispatched_at: '2026-02-15T10:00:00Z',
  completed_at: '2026-02-15T10:00:01Z',
  duration_ms: 1000
};

describe('Route Security - Non-Admin Data Redaction', () => {

  describe('safeJsonParse', () => {
    it('should parse valid JSON', () => {
      expect(safeJsonParse('{"a":1}', {})).toEqual({ a: 1 });
    });

    it('should return default for invalid JSON', () => {
      expect(safeJsonParse('not json', { fallback: true })).toEqual({ fallback: true });
    });

    it('should return default for null/undefined', () => {
      expect(safeJsonParse(null, 'default')).toBe('default');
      expect(safeJsonParse(undefined, 'default')).toBe('default');
    });
  });

  describe('sanitizeUrl', () => {
    it('should redact embedded credentials in URL', () => {
      const result = sanitizeUrl('https://user:password123@example.com/webhook');

      expect(result).not.toContain('user');
      expect(result).not.toContain('password123');
      // URL API encodes brackets, so check for encoded version
      expect(result).toMatch(/REDACTED/);
      expect(result).toContain('example.com/webhook');
    });

    it('should leave URLs without credentials unchanged', () => {
      const url = 'https://example.com/webhook';
      expect(sanitizeUrl(url)).toBe(url);
    });

    it('should handle URL with only username', () => {
      const result = sanitizeUrl('https://apiuser@example.com/hook');

      expect(result).not.toContain('apiuser');
      expect(result).toMatch(/REDACTED/);
    });

    it('should handle null/undefined gracefully', () => {
      expect(sanitizeUrl(null)).toBeNull();
      expect(sanitizeUrl(undefined)).toBeUndefined();
    });

    it('should return original string if URL parsing fails', () => {
      expect(sanitizeUrl('not-a-url')).toBe('not-a-url');
    });
  });

  describe('sanitizeDestinationConfig', () => {
    it('should NOT redact signing_secret for admin users', () => {
      const result = sanitizeDestinationConfig(mockWebhookConfig, 'webhook', true);

      expect(result.signing_secret).toBe('whsec_supersecretkey123');
      expect(result.headers.Authorization).toBe('Bearer secret-token-abc123');
    });

    it('should redact signing_secret for non-admin users', () => {
      const result = sanitizeDestinationConfig(mockWebhookConfig, 'webhook', false);

      expect(result.signing_secret).toBe('[REDACTED]');
    });

    it('should redact header values for non-admin users', () => {
      const result = sanitizeDestinationConfig(mockWebhookConfig, 'webhook', false);

      expect(result.headers.Authorization).toBe('[REDACTED]');
      expect(result.headers['X-Custom-Header']).toBe('[REDACTED]');
    });

    it('should preserve header keys for non-admin users (for debugging)', () => {
      const result = sanitizeDestinationConfig(mockWebhookConfig, 'webhook', false);

      expect(Object.keys(result.headers)).toContain('Authorization');
      expect(Object.keys(result.headers)).toContain('X-Custom-Header');
    });

    it('should preserve non-sensitive fields for non-admin users', () => {
      const result = sanitizeDestinationConfig(mockWebhookConfig, 'webhook', false);

      expect(result.url).toBe('https://example.com/webhook');
    });

    it('should handle null config gracefully', () => {
      expect(sanitizeDestinationConfig(null, 'webhook', false)).toBeNull();
    });

    it('should redact sensitive keys in email config', () => {
      const emailConfig = {
        to: ['test@example.com'],
        api_key: 'secret-api-key',
        password: 'secret-password'
      };
      const result = sanitizeDestinationConfig(emailConfig, 'email', false);

      expect(result.api_key).toBe('[REDACTED]');
      expect(result.password).toBe('[REDACTED]');
      expect(result.to).toEqual(['test@example.com']);
    });

    it('should redact embedded credentials in webhook URL for non-admin users', () => {
      const configWithCredUrl = {
        url: 'https://apiuser:secretpass@hooks.example.com/webhook',
        signing_secret: 'whsec_123'
      };
      const result = sanitizeDestinationConfig(configWithCredUrl, 'webhook', false);

      expect(result.url).not.toContain('apiuser');
      expect(result.url).not.toContain('secretpass');
      expect(result.url).toMatch(/REDACTED/);
      expect(result.url).toContain('hooks.example.com/webhook');
    });

    it('should NOT redact URL credentials for admin users', () => {
      const configWithCredUrl = {
        url: 'https://apiuser:secretpass@hooks.example.com/webhook',
        signing_secret: 'whsec_123'
      };
      const result = sanitizeDestinationConfig(configWithCredUrl, 'webhook', true);

      expect(result.url).toContain('apiuser');
      expect(result.url).toContain('secretpass');
    });
  });

  describe('formatDeliveryLog', () => {
    it('should NOT redact event_payload for admin users', () => {
      const result = formatDeliveryLog(mockDeliveryLog, true);

      expect(result.event_payload.deliverable.content).toBe(
        'This is highly confidential content that should not leak'
      );
      expect(result.event_payload.task.description).toBe(
        'Secret task description with internal details'
      );
    });

    it('should redact deliverable content from event_payload for non-admin users', () => {
      const result = formatDeliveryLog(mockDeliveryLog, false);

      expect(result.event_payload.deliverable.content).toBeUndefined();
      expect(result.event_payload.deliverable.summary).toBeUndefined();
      expect(result.event_payload.deliverable.files).toBeUndefined();
    });

    it('should redact task description from event_payload for non-admin users', () => {
      const result = formatDeliveryLog(mockDeliveryLog, false);

      expect(result.event_payload.task.description).toBeUndefined();
      expect(result.event_payload.task.context).toBeUndefined();
    });

    it('should preserve deliverable ID, title, status for non-admin users', () => {
      const result = formatDeliveryLog(mockDeliveryLog, false);

      expect(result.event_payload.deliverable.id).toBe(123);
      expect(result.event_payload.deliverable.title).toBe('Secret Report');
      expect(result.event_payload.deliverable.status).toBe('approved');
    });

    it('should hide response_body for non-admin users', () => {
      const result = formatDeliveryLog(mockDeliveryLog, false);

      expect(result.response_body).toBe('[HIDDEN]');
    });

    it('should NOT hide response_body for admin users', () => {
      const result = formatDeliveryLog(mockDeliveryLog, true);

      expect(result.response_body).toContain('internal_id');
    });

    it('should hide error_message for non-admin users (may contain secrets)', () => {
      const result = formatDeliveryLog(mockDeliveryLog, false);

      expect(result.error_message).toBe('[HIDDEN]');
      expect(result.error_message).not.toContain('sk-secret-key-123');
    });

    it('should NOT hide error_message for admin users', () => {
      const result = formatDeliveryLog(mockDeliveryLog, true);

      expect(result.error_message).toContain('sk-secret-key-123');
    });

    it('should preserve non-sensitive log metadata for non-admin users', () => {
      const result = formatDeliveryLog(mockDeliveryLog, false);

      expect(result.id).toBe(1);
      expect(result.event_type).toBe('deliverable.approved');
      expect(result.status).toBe('delivered');
      expect(result.response_status).toBe(200);
      expect(result.duration_ms).toBe(1000);
    });

    it('should handle null response_body gracefully', () => {
      const logWithNullResponse = { ...mockDeliveryLog, response_body: null };
      const result = formatDeliveryLog(logWithNullResponse, false);

      expect(result.response_body).toBeNull();
    });

    it('should handle null error_message gracefully', () => {
      const logWithNullError = { ...mockDeliveryLog, error_message: null };
      const result = formatDeliveryLog(logWithNullError, false);

      expect(result.error_message).toBeNull();
    });

    it('should handle missing deliverable in payload', () => {
      const logWithoutDeliverable = {
        ...mockDeliveryLog,
        event_payload: JSON.stringify({
          event: 'task.created',
          timestamp: '2026-02-15T10:00:00Z'
        })
      };
      const result = formatDeliveryLog(logWithoutDeliverable, false);

      expect(result.event_payload.deliverable).toBeUndefined();
    });
  });

  describe('Full response security assertions', () => {
    it('non-admin sanitized config should NEVER contain raw signing_secret', () => {
      const result = sanitizeDestinationConfig(mockWebhookConfig, 'webhook', false);
      const serialized = JSON.stringify(result);

      expect(serialized).not.toContain('whsec_supersecretkey123');
      expect(serialized).not.toContain('secret-token-abc123');
      expect(serialized).not.toContain('sensitive-value');
    });

    it('non-admin sanitized config should NEVER contain URL credentials', () => {
      const configWithCreds = {
        url: 'https://admin:hunter2@api.example.com/hook',
        signing_secret: 'whsec_test'
      };
      const result = sanitizeDestinationConfig(configWithCreds, 'webhook', false);
      const serialized = JSON.stringify(result);

      expect(serialized).not.toContain('admin');
      expect(serialized).not.toContain('hunter2');
    });

    it('non-admin log response should NEVER contain full deliverable content', () => {
      const result = formatDeliveryLog(mockDeliveryLog, false);
      const serialized = JSON.stringify(result);

      expect(serialized).not.toContain('confidential content');
      expect(serialized).not.toContain('Confidential summary');
      expect(serialized).not.toContain('secret.pdf');
    });

    it('non-admin log response should NEVER contain task context/description', () => {
      const result = formatDeliveryLog(mockDeliveryLog, false);
      const serialized = JSON.stringify(result);

      expect(serialized).not.toContain('Secret task description');
      expect(serialized).not.toContain('internal-key-xyz');
    });

    it('non-admin log response should NEVER contain raw response_body content', () => {
      const result = formatDeliveryLog(mockDeliveryLog, false);
      const serialized = JSON.stringify(result);

      expect(serialized).not.toContain('leaked-token');
      expect(serialized).not.toContain('internal_id');
    });

    it('non-admin log response should NEVER contain raw error_message secrets', () => {
      const result = formatDeliveryLog(mockDeliveryLog, false);
      const serialized = JSON.stringify(result);

      expect(serialized).not.toContain('sk-secret-key-123');
    });
  });

  describe('Storage config redaction', () => {
    const mockStorageConfig = {
      provider: 's3',
      bucket: 'my-deliverables',
      region: 'us-east-1',
      endpoint: 'https://minio.example.com:9000',
      access_key_id: 'AKIAIOSFODNN7EXAMPLE',
      secret_access_key: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      path_prefix: 'cavendo/',
      upload_content: true,
      upload_files: true
    };

    it('should NOT redact storage config for admin users', () => {
      const result = sanitizeDestinationConfig(mockStorageConfig, 'storage', true);

      expect(result.secret_access_key).toBe('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
      expect(result.access_key_id).toBe('AKIAIOSFODNN7EXAMPLE');
    });

    it('should redact secret_access_key for non-admin users', () => {
      const result = sanitizeDestinationConfig(mockStorageConfig, 'storage', false);

      expect(result.secret_access_key).toBe('[REDACTED]');
    });

    it('should show only last 4 chars of access_key_id for non-admin users', () => {
      const result = sanitizeDestinationConfig(mockStorageConfig, 'storage', false);

      expect(result.access_key_id).toBe('...MPLE');
      expect(result.access_key_id).not.toContain('AKIAIOSFODNN7');
    });

    it('should redact embedded credentials in endpoint URL for non-admin users', () => {
      const configWithCredEndpoint = {
        ...mockStorageConfig,
        endpoint: 'https://admin:secretpass@minio.example.com:9000'
      };
      const result = sanitizeDestinationConfig(configWithCredEndpoint, 'storage', false);

      expect(result.endpoint).not.toContain('admin');
      expect(result.endpoint).not.toContain('secretpass');
      expect(result.endpoint).toMatch(/REDACTED/);
      expect(result.endpoint).toContain('minio.example.com');
    });

    it('should leave endpoint without credentials unchanged for non-admin users', () => {
      const result = sanitizeDestinationConfig(mockStorageConfig, 'storage', false);

      expect(result.endpoint).toBe('https://minio.example.com:9000');
    });

    it('should preserve non-sensitive storage fields for non-admin users', () => {
      const result = sanitizeDestinationConfig(mockStorageConfig, 'storage', false);

      expect(result.bucket).toBe('my-deliverables');
      expect(result.region).toBe('us-east-1');
      expect(result.path_prefix).toBe('cavendo/');
      expect(result.upload_content).toBe(true);
      expect(result.upload_files).toBe(true);
    });

    it('non-admin serialized storage config should NEVER contain raw credentials', () => {
      const configWithCredEndpoint = {
        ...mockStorageConfig,
        endpoint: 'https://admin:hunter2@minio.example.com:9000'
      };
      const result = sanitizeDestinationConfig(configWithCredEndpoint, 'storage', false);
      const serialized = JSON.stringify(result);

      expect(serialized).not.toContain('wJalrXUtnFEMI');
      expect(serialized).not.toContain('AKIAIOSFODNN7');
      expect(serialized).not.toContain('hunter2');
    });
  });
});
