import { jest, afterAll, afterEach, describe, expect, test } from '@jest/globals';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_HOST = '127.0.0.1';

const tempDir = mkdtempSync(join(tmpdir(), 'cavendo-factory-bg-'));
process.env.DATABASE_PATH = join(tempDir, 'test.db');
process.env.DB_DRIVER = 'sqlite';
process.env.SESSION_SECRET = 'test-secret-for-background-workers';
process.env.NODE_ENV = 'test';

const FAKE_HASH = '$2b$10$fakehashfortest';
jest.unstable_mockModule('bcrypt', () => ({
  default: { hash: async () => FAKE_HASH, compare: async () => false },
  hash: async () => FAKE_HASH,
  compare: async () => false,
}));

const mockProcessPendingDeliveries = jest.fn().mockResolvedValue();
const mockStartDispatcher = jest.fn();
const mockStopDispatcher = jest.fn();
const mockStartRetrySweep = jest.fn();
const mockStopRetrySweep = jest.fn();
const mockStartSkillsRuntimePoller = jest.fn();
const mockStopSkillsRuntimePoller = jest.fn();

jest.unstable_mockModule('../services/webhooks.js', () => ({
  processPendingDeliveries: mockProcessPendingDeliveries,
  triggerWebhook: jest.fn(),
  triggerWebhookForProject: jest.fn(),
  validateWebhookUrl: jest.fn().mockResolvedValue({ valid: true }),
}));

jest.unstable_mockModule('../services/taskDispatcher.js', () => ({
  getDispatcherStatus: jest.fn().mockResolvedValue({ running: false }),
  startDispatcher: mockStartDispatcher,
  stopDispatcher: mockStopDispatcher,
}));

jest.unstable_mockModule('../services/routeDispatcher.js', () => ({
  dispatchEvent: jest.fn(),
  dispatchRoute: jest.fn(),
  startRetrySweep: mockStartRetrySweep,
  stopRetrySweep: mockStopRetrySweep,
  testRoute: jest.fn(),
}));

jest.unstable_mockModule('../services/skills/poller.js', () => ({
  getSkillsPollerState: jest.fn().mockReturnValue({ running: false }),
  startSkillsRuntimePoller: mockStartSkillsRuntimePoller,
  stopSkillsRuntimePoller: mockStopSkillsRuntimePoller,
}));

const { createApp } = await import('../app.js');

describe('createApp background worker startup', () => {
  const serversToClose = [];

  afterEach(() => {
    jest.clearAllMocks();
  });

  afterAll(async () => {
    for (const server of serversToClose) {
      if (server.listening) {
        await new Promise((resolve) => server.close(resolve));
      }
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('default startup enables background workers', async () => {
    const instance = createApp();
    const server = await instance.start({ port: 0, host: TEST_HOST });
    serversToClose.push(server);

    await new Promise((resolve) => setImmediate(resolve));

    expect(mockProcessPendingDeliveries).toHaveBeenCalledTimes(1);
    expect(mockStartDispatcher).toHaveBeenCalledTimes(1);
    expect(mockStartRetrySweep).toHaveBeenCalledTimes(1);
    expect(mockStartSkillsRuntimePoller).toHaveBeenCalledTimes(1);
  }, 15000);

  test('startBackgroundWorkers=false skips worker startup', async () => {
    const instance = createApp({ startBackgroundWorkers: false });
    const server = await instance.start({ port: 0, host: TEST_HOST });
    serversToClose.push(server);

    await new Promise((resolve) => setImmediate(resolve));

    expect(mockProcessPendingDeliveries).not.toHaveBeenCalled();
    expect(mockStartDispatcher).not.toHaveBeenCalled();
    expect(mockStartRetrySweep).not.toHaveBeenCalled();
    expect(mockStartSkillsRuntimePoller).not.toHaveBeenCalled();
  }, 15000);
});
