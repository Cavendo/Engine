import './env.js'; // env loaded first, before any db/route imports

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync } from 'fs';

// Import routes
import agentsRouter from './routes/agents.js';
import tasksRouter from './routes/tasks.js';
import deliverablesRouter from './routes/deliverables.js';
import projectsRouter from './routes/projects.js';
import knowledgeRouter from './routes/knowledge.js';
import webhooksRouter from './routes/webhooks.js';
import authRouter from './routes/auth.js';
import activityRouter from './routes/activity.js';
import usersRouter from './routes/users.js';
import commentsRouter from './routes/comments.js';
import sprintsRouter from './routes/sprints.js';
import routesRouter from './routes/routes.js';
import connectionsRouter from './routes/connections.js';
import settingsRouter from './routes/settings.js';

// Import services
import { processPendingDeliveries } from './services/webhooks.js';
import { startDispatcher, stopDispatcher } from './services/taskDispatcher.js';
import { startRetrySweep, stopRetrySweep } from './services/routeDispatcher.js';

// Import response utilities
import * as response from './utils/response.js';

// Import database initialization and migration
import { initializeDatabase } from './db/init.js';
import { runMigrations } from './db/migrator.js';
import { runCryptoHealthCheck } from './utils/crypto.js';

// Import security middleware
import {
  apiLimiter,
  csrfProtection,
  securityHeaders,
  sanitizeRequest
} from './middleware/security.js';

// Import auth middleware for file serving
import { dualAuth } from './middleware/agentAuth.js';

// Import database adapter
import db from './db/adapter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8'));

export function createApp(options = {}) {
  const app = express();
  const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:5173';

  // ============================================
  // Middleware Stack
  // ============================================

  // Trust proxy for correct IP detection behind reverse proxy
  if (process.env.TRUST_PROXY) {
    app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : process.env.TRUST_PROXY);
  }

  // Security headers (additional to Helmet)
  app.use(securityHeaders);

  // Helmet for common security headers
  app.use(helmet({
    contentSecurityPolicy: false // Allow UI to load
  }));

  // CORS with credentials
  app.use(cors({
    origin: CORS_ORIGIN,
    credentials: true
  }));

  // Body parsing with size limits
  app.use(express.json({ limit: '10mb' }));

  // Cookie parsing
  app.use(cookieParser());

  // Sanitize request body
  app.use(sanitizeRequest);

  // General API rate limiting
  app.use('/api', apiLimiter);

  // CSRF protection for state-changing requests
  app.use(csrfProtection);

  // Request logging in development
  if (process.env.NODE_ENV !== 'production') {
    app.use((req, res, next) => {
      const start = Date.now();
      res.on('finish', () => {
        const duration = Date.now() - start;
        console.log(`${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
      });
      next();
    });
  }

  // ============================================
  // Route Assembly (async-safe hooks)
  // ============================================

  async function _assembleRoutes() {
    // beforeRoutes hook
    if (options.beforeRoutes) await options.beforeRoutes(app);

    // Health check (no rate limiting)
    app.get('/health', (req, res) => {
      res.json({ status: 'ok' });
    });

    // API routes
    app.use('/api/auth', authRouter);
    app.use('/api/users', usersRouter);
    app.use('/api/agents', agentsRouter);
    app.use('/api/tasks', tasksRouter);
    app.use('/api/deliverables', deliverablesRouter);
    app.use('/api/projects', projectsRouter);
    app.use('/api/knowledge', knowledgeRouter);
    app.use('/api/webhooks', webhooksRouter);
    app.use('/api/activity', activityRouter);
    app.use('/api', commentsRouter);
    app.use('/api/sprints', sprintsRouter);
    app.use('/api', routesRouter);
    app.use('/api/storage-connections', connectionsRouter);
    app.use('/api/settings', settingsRouter);

    // Serve uploaded files (deliverable attachments) with authentication
    const uploadsPath = join(__dirname, '../data/uploads');
    app.use('/uploads', dualAuth, express.static(uploadsPath));

    // afterRoutes hook — Cloud mounts its routes HERE
    if (options.afterRoutes) await options.afterRoutes(app);

    // Serve static UI in production
    const uiDistPath = join(__dirname, '../ui/dist');
    if (existsSync(uiDistPath)) {
      app.use(express.static(uiDistPath));
      app.get('*', (req, res) => {
        if (req.path.startsWith('/api/')) {
          return response.notFound(res, 'Endpoint');
        }
        res.sendFile(join(uiDistPath, 'index.html'));
      });
    }

    // ============================================
    // Error Handling
    // ============================================

    // JSON parse error handler
    app.use((err, req, res, next) => {
      if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
        return response.badRequest(res, 'Invalid JSON body');
      }
      next(err);
    });

    // Generic error handler
    app.use((err, req, res, next) => {
      console.error('Unhandled error:', err);
      const message = process.env.NODE_ENV === 'production'
        ? 'Internal server error'
        : err.message;
      response.serverError(res, message);
    });

    // 404 handler
    app.use((req, res) => {
      response.notFound(res, 'Endpoint');
    });
  }

  // Kick off assembly immediately (sync hooks complete inline)
  const assemblyPromise = _assembleRoutes();

  // ============================================
  // Lifecycle State Machine
  // ============================================
  let server = null;
  let sessionCleanupHandle = null;
  let started = false;
  let stopped = false;
  let startupPromise = null;

  async function start(bindOptions = {}) {
    if (started && server) return server;
    if (startupPromise) return startupPromise;

    if (stopped) {
      throw new Error('Cannot start after stop() — DB connection is closed. Create a new process.');
    }

    startupPromise = _doStart(bindOptions);
    try {
      const result = await startupPromise;
      started = true;
      return result;
    } catch (err) {
      started = false;
      throw err;
    } finally {
      startupPromise = null;
    }
  }

  async function _doStart(bindOptions) {
    const port = bindOptions.port ?? (process.env.PORT || 3001);
    const host = bindOptions.host ?? undefined;

    // Wait for route assembly to complete
    try {
      await assemblyPromise;
    } catch (err) {
      throw new Error(`[AppFactory] Route assembly failed: ${err.message}`, { cause: err });
    }

    // Initialize database (schema + seeding)
    try {
      await initializeDatabase(db);
    } catch (err) {
      throw new Error(`[AppFactory] Database initialization failed: ${err.message}`, { cause: err });
    }

    // Run migrations
    try {
      await runMigrations(db);
    } catch (err) {
      throw new Error(`[AppFactory] Migrations failed: ${err.message}`, { cause: err });
    }

    // Crypto health check
    try {
      const health = await runCryptoHealthCheck(db);
      if (!health.ok) {
        console.error(`[Crypto] Health check FAILED: ${health.failed}/${health.total} encrypted values cannot be decrypted`);
        for (const d of health.details.slice(0, 10)) {
          console.error(`  - ${d.table}#${d.id} ${d.column} (keyVersion=${d.keyVersion}): ${d.error}`);
        }
        if (process.env.NODE_ENV === 'production') {
          throw new Error('Crypto health check failed in production');
        }
        console.warn('[Crypto] Continuing in development mode despite crypto health failures.');
      } else if (health.total > 0) {
        console.log(`[Crypto] Health check passed: ${health.total} encrypted value(s) verified`);
      }
    } catch (err) {
      if (err.message === 'Crypto health check failed in production') throw err;
      console.error('[Crypto] Health check error:', err.message);
      if (process.env.NODE_ENV === 'production') {
        throw err;
      }
    }

    // beforeStart hook
    if (options.beforeStart) await options.beforeStart(app);

    // Listen
    await new Promise((resolve, reject) => {
      const onError = (err) => { server = null; reject(err); };

      server = app.listen(port, host, () => {
        server.off('error', onError);

        const boundPort = server.address().port;
        const uiDistPath = join(__dirname, '../ui/dist');
        console.log(`
╔══════════════════════════════════════════════════════════╗
║                                                          ║
║   Cavendo Engine v${pkg.version}                                  ║
║   Agent Workflow Platform                                ║
║                                                          ║
║   Server:  http://${host || 'localhost'}:${boundPort}                        ║
║   UI:      ${existsSync(uiDistPath) ? `http://${host || 'localhost'}:${boundPort}` : 'Run "npm run ui:dev" for development'}             ║
║                                                          ║
║   Security: Rate limiting, CSRF protection, bcrypt       ║
║                                                          ║
╚══════════════════════════════════════════════════════════╝
        `);

        // Post-listen startup tasks
        processPendingDeliveries().catch(err =>
          console.error('Error processing pending deliveries:', err));
        startDispatcher();
        startRetrySweep();

        // Session cleanup interval (every 15 min)
        sessionCleanupHandle = setInterval(() => {
          db.exec("DELETE FROM sessions WHERE expires_at < datetime('now')")
            .then(result => {
              if (result.changes > 0) {
                console.log(`[Sessions] Cleaned up ${result.changes} expired session(s)`);
              }
            })
            .catch(err => {
              console.error('[Sessions] Cleanup error:', err);
            });
        }, 15 * 60 * 1000);

        resolve(server);
      });

      server.once('error', onError);
    });

    // onStarted hook — fatal if it throws
    if (options.onStarted) {
      try {
        await options.onStarted({ app, server });
      } catch (err) {
        console.error('[AppFactory] onStarted hook failed, shutting down:', err.message);
        stopDispatcher();
        stopRetrySweep();
        if (sessionCleanupHandle) { clearInterval(sessionCleanupHandle); sessionCleanupHandle = null; }
        await new Promise(resolve => server.close(resolve));
        server = null;
        throw err;
      }
    }

    return server;
  }

  let _stopPromise = null;

  async function stop() {
    if (stopped) return;
    if (_stopPromise) return _stopPromise;
    if (!started && !startupPromise) return;

    _stopPromise = _doStop();
    try {
      await _stopPromise;
    } finally {
      _stopPromise = null;
      stopped = true;
      started = false;
    }
  }

  async function _doStop() {
    if (startupPromise) {
      try { await startupPromise; } catch { /* start failed, still clean up */ }
    }

    stopDispatcher();
    stopRetrySweep();
    if (sessionCleanupHandle) {
      clearInterval(sessionCleanupHandle);
      sessionCleanupHandle = null;
    }

    if (server) {
      await new Promise(resolve => server.close(resolve));
      server = null;
    }

    await Promise.resolve(db.close());
  }

  return { app, start, stop };
}

export default createApp;
