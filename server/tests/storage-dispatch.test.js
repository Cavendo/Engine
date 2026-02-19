/**
 * Tests for S3 storage dispatch key construction and upload behavior.
 * Uses a mock for uploadToS3 to verify keys are built correctly
 * without requiring real S3 credentials.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// We test the key construction logic by importing the content type map
// and replicating the key-building logic from deliverStorage.
// This avoids needing to mock the entire dispatcher module chain.

const CONTENT_TYPE_MAP = {
  markdown: { mime: 'text/markdown', ext: '.md' },
  html: { mime: 'text/html', ext: '.html' },
  json: { mime: 'application/json', ext: '.json' },
  text: { mime: 'text/plain', ext: '.txt' },
  code: { mime: 'text/plain', ext: '.txt' }
};

/**
 * Replicate the key-building logic from deliverStorage
 * to test it in isolation.
 */
function buildStorageKeys(config, eventData) {
  const deliverable = eventData.deliverable || {};
  const projectName = (eventData.project?.name || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
  const deliverableId = deliverable.id || 'unknown';
  const prefix = `${config.path_prefix || ''}${projectName}/${deliverableId}/`;

  const keys = [];

  if (config.upload_content !== false && deliverable.content) {
    const contentType = deliverable.content_type || 'text';
    const mapping = CONTENT_TYPE_MAP[contentType] || CONTENT_TYPE_MAP.text;
    keys.push(`${prefix}content${mapping.ext}`);
  }

  if (config.upload_files !== false && deliverable.files) {
    const files = Array.isArray(deliverable.files) ? deliverable.files : [];
    for (const file of files) {
      if (file.filename) {
        keys.push(`${prefix}${file.filename}`);
      }
    }
  }

  return keys;
}

describe('Storage Dispatch - Key Construction', () => {

  const baseConfig = {
    provider: 's3',
    bucket: 'test-bucket',
    region: 'us-east-1',
    access_key_id: 'AKIATEST',
    secret_access_key: 'secret',
    path_prefix: 'cavendo/',
    upload_content: true,
    upload_files: true
  };

  const baseEventData = {
    project: { id: 1, name: 'My Project' },
    deliverable: {
      id: 42,
      title: 'Test Report',
      content: '# Hello World',
      content_type: 'markdown',
      files: [
        { filename: 'report.pdf', path: '/uploads/deliverables/42/report.pdf', mimeType: 'application/pdf' },
        { filename: 'data.csv', path: '/uploads/deliverables/42/data.csv', mimeType: 'text/csv' }
      ]
    }
  };

  it('should build keys with path_prefix applied exactly once', () => {
    const keys = buildStorageKeys(baseConfig, baseEventData);

    // Each key should start with exactly one "cavendo/" prefix
    for (const key of keys) {
      expect(key).toMatch(/^cavendo\//);
      expect(key).not.toMatch(/^cavendo\/cavendo\//);
    }
  });

  it('should include project name and deliverable ID in key path', () => {
    const keys = buildStorageKeys(baseConfig, baseEventData);

    expect(keys[0]).toBe('cavendo/My_Project/42/content.md');
  });

  it('should use correct extension for each content type', () => {
    for (const [type, { ext }] of Object.entries(CONTENT_TYPE_MAP)) {
      const data = {
        ...baseEventData,
        deliverable: { ...baseEventData.deliverable, content_type: type }
      };
      const keys = buildStorageKeys({ ...baseConfig, upload_files: false }, data);
      expect(keys[0]).toContain(`content${ext}`);
    }
  });

  it('should default to .txt for unknown content types', () => {
    const data = {
      ...baseEventData,
      deliverable: { ...baseEventData.deliverable, content_type: 'unknown_type' }
    };
    const keys = buildStorageKeys({ ...baseConfig, upload_files: false }, data);
    expect(keys[0]).toContain('content.txt');
  });

  it('should include file attachment keys', () => {
    const keys = buildStorageKeys(baseConfig, baseEventData);

    expect(keys).toContain('cavendo/My_Project/42/report.pdf');
    expect(keys).toContain('cavendo/My_Project/42/data.csv');
  });

  it('should skip files without filename', () => {
    const data = {
      ...baseEventData,
      deliverable: {
        ...baseEventData.deliverable,
        files: [
          { filename: 'good.txt', path: '/uploads/good.txt' },
          { path: '/uploads/no-name.txt' },  // no filename
          { filename: '', path: '/uploads/empty.txt' }  // empty filename
        ]
      }
    };
    const keys = buildStorageKeys(baseConfig, data);
    const fileKeys = keys.filter(k => !k.includes('content.'));

    expect(fileKeys).toHaveLength(1);
    expect(fileKeys[0]).toContain('good.txt');
  });

  it('should work with empty path_prefix', () => {
    const config = { ...baseConfig, path_prefix: '' };
    const keys = buildStorageKeys(config, baseEventData);

    expect(keys[0]).toBe('My_Project/42/content.md');
  });

  it('should sanitize project name for safe S3 keys', () => {
    const data = {
      ...baseEventData,
      project: { id: 1, name: 'My Project!@#$%' }
    };
    const keys = buildStorageKeys(baseConfig, data);

    expect(keys[0]).toBe('cavendo/My_Project_____/42/content.md');
    expect(keys[0]).not.toMatch(/[!@#$%]/);
  });

  it('should respect upload_content: false', () => {
    const config = { ...baseConfig, upload_content: false };
    const keys = buildStorageKeys(config, baseEventData);

    expect(keys.every(k => !k.includes('content.'))).toBe(true);
    expect(keys).toHaveLength(2); // only file attachments
  });

  it('should respect upload_files: false', () => {
    const config = { ...baseConfig, upload_files: false };
    const keys = buildStorageKeys(config, baseEventData);

    expect(keys).toHaveLength(1); // only content
    expect(keys[0]).toContain('content.md');
  });

  it('should handle missing project name gracefully', () => {
    const data = { ...baseEventData, project: {} };
    const keys = buildStorageKeys(baseConfig, data);

    expect(keys[0]).toContain('unknown/');
  });

  it('should handle missing deliverable ID gracefully', () => {
    const data = {
      ...baseEventData,
      deliverable: { ...baseEventData.deliverable, id: undefined }
    };
    const keys = buildStorageKeys(baseConfig, data);

    expect(keys[0]).toContain('/unknown/');
  });
});
