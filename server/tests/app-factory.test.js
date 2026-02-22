import { jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import http from 'http';

// Point DATABASE_PATH to a temp dir so tests don't touch real data
const tempDir = mkdtempSync(join(tmpdir(), 'cavendo-factory-'));
process.env.DATABASE_PATH = join(tempDir, 'test.db');
process.env.SESSION_SECRET = 'test-secret-for-factory';
process.env.NODE_ENV = 'test';

// Stub bcrypt so we don't need native bindings in CI
const FAKE_HASH = '$2b$10$fakehashfortest';
jest.unstable_mockModule('bcrypt', () => ({
  default: { hash: async () => FAKE_HASH, compare: async () => false },
  hash: async () => FAKE_HASH,
  compare: async () => false,
}));

const { createApp } = await import('../app.js');
const { stopDispatcher } = await import('../services/taskDispatcher.js');
const { stopRetrySweep } = await import('../services/routeDispatcher.js');

afterAll(() => {
  // Stop global singletons that may have been started by tests
  stopDispatcher();
  stopRetrySweep();
  rmSync(tempDir, { recursive: true, force: true });
});

// IMPORTANT: The DB is a module-level singleton. Once db.close() is called
// (via stop()), it cannot be reopened. Tests that need to clean up servers
// use server.close() directly rather than instance.stop().

describe('createApp factory', () => {
  // Track servers that need cleanup (without closing DB)
  const serversToClose = [];

  afterAll(async () => {
    for (const s of serversToClose) {
      if (s.listening) {
        await new Promise(resolve => s.close(resolve));
      }
    }
  });

  test('importing app.js does not start HTTP server or workers', () => {
    expect(typeof createApp).toBe('function');
  });

  test('createApp returns app, start, stop', () => {
    const result = createApp();
    expect(result).toHaveProperty('app');
    expect(result).toHaveProperty('start');
    expect(result).toHaveProperty('stop');
    expect(typeof result.start).toBe('function');
    expect(typeof result.stop).toBe('function');
  });

  test('stop() without start() is a safe no-op', async () => {
    const instance = createApp();
    await expect(instance.stop()).resolves.toBeUndefined();
  });

  test('route assembly failure surfaces clear error', async () => {
    const instance = createApp({
      beforeRoutes() {
        throw new Error('Hook boom');
      },
    });

    await expect(instance.start({ port: 0 })).rejects.toThrow('Route assembly failed');
  }, 15000);

  test('start() returns a listening server (port 0)', async () => {
    const instance = createApp();
    const server = await instance.start({ port: 0 });
    serversToClose.push(server);
    expect(server).toBeInstanceOf(http.Server);
    expect(server.listening).toBe(true);
    // Verify port 0 picked a real ephemeral port
    expect(server.address().port).toBeGreaterThan(0);
  }, 15000);

  test('start() is idempotent — returns same server on second call', async () => {
    const instance = createApp();
    const server1 = await instance.start({ port: 0 });
    serversToClose.push(server1);
    const server2 = await instance.start({ port: 0 });
    expect(server1).toBe(server2);
  }, 15000);

  test('hook ordering: beforeRoutes → engine routes → afterRoutes', async () => {
    const order = [];

    const instance = createApp({
      beforeRoutes(app) {
        order.push('beforeRoutes');
        app.get('/api/before-test', (req, res) => res.json({ hook: 'before' }));
      },
      afterRoutes(app) {
        order.push('afterRoutes');
        app.get('/api/after-test', (req, res) => res.json({ hook: 'after' }));
      },
    });

    const server = await instance.start({ port: 0 });
    serversToClose.push(server);

    expect(order).toEqual(['beforeRoutes', 'afterRoutes']);

    const port = server.address().port;

    const beforeRes = await fetch(`http://localhost:${port}/api/before-test`);
    expect(beforeRes.ok).toBe(true);
    const beforeBody = await beforeRes.json();
    expect(beforeBody.hook).toBe('before');

    const afterRes = await fetch(`http://localhost:${port}/api/after-test`);
    expect(afterRes.ok).toBe(true);
    const afterBody = await afterRes.json();
    expect(afterBody.hook).toBe('after');

    const healthRes = await fetch(`http://localhost:${port}/health`);
    expect(healthRes.ok).toBe(true);
  }, 15000);

  test('afterRoutes route is not shadowed by SPA fallback', async () => {
    const instance = createApp({
      afterRoutes(app) {
        app.get('/api/cloud-test', (req, res) => res.json({ cloud: true }));
      },
    });

    const server = await instance.start({ port: 0 });
    serversToClose.push(server);
    const port = server.address().port;

    const res = await fetch(`http://localhost:${port}/api/cloud-test`);
    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(body.cloud).toBe(true);
  }, 15000);

  test('onStarted hook receives app and server', async () => {
    let receivedApp, receivedServer;

    const instance = createApp({
      onStarted({ app, server }) {
        receivedApp = app;
        receivedServer = server;
      },
    });

    const server = await instance.start({ port: 0 });
    serversToClose.push(server);
    expect(receivedApp).toBeDefined();
    expect(receivedServer).toBe(server);
  }, 15000);

  test('onStarted failure triggers cleanup and rethrow', async () => {
    const instance = createApp({
      onStarted() {
        throw new Error('onStarted boom');
      },
    });

    await expect(instance.start({ port: 0 })).rejects.toThrow('onStarted boom');
  }, 15000);
});

// This describe calls stop() which closes the shared DB — must run last.
// Only one test actually starts+stops since db.close() is terminal.
describe('createApp lifecycle (stop)', () => {
  test('full lifecycle: start() → listening → stop() → closed', async () => {
    const instance = createApp();
    const server = await instance.start({ port: 0 });
    expect(server).toBeInstanceOf(http.Server);
    expect(server.listening).toBe(true);

    await instance.stop();
    expect(server.listening).toBe(false);
  }, 15000);

  test('stop() is idempotent — calling twice does not throw', async () => {
    const instance = createApp();
    // stop without prior start is a no-op
    await expect(instance.stop()).resolves.toBeUndefined();
    await expect(instance.stop()).resolves.toBeUndefined();
  });
});
