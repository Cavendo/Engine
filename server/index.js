import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import crypto from 'crypto';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'fs';

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
import { startDispatcher, stopDispatcher, executeTaskNow, getDispatcherStatus } from './services/taskDispatcher.js';
import { startRetrySweep, stopRetrySweep } from './services/routeDispatcher.js';

// Import response utilities
import * as response from './utils/response.js';

// Import database initialization
import { initializeDatabase } from './db/init.js';

// Import security middleware
import {
  apiLimiter,
  csrfProtection,
  securityHeaders,
  sanitizeRequest
} from './middleware/security.js';

// Import auth middleware for file serving
import { dualAuth } from './middleware/agentAuth.js';

// Import database connection for session cleanup
import db from './db/connection.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
let sessionCleanupHandle = null;
const PROJECT_ROOT = join(__dirname, '..');

// ============================================
// Auto-generate .env on first run
// ============================================
const envPath = join(PROJECT_ROOT, '.env');
const envExamplePath = join(PROJECT_ROOT, '.env.example');

if (!existsSync(envPath) && existsSync(envExamplePath)) {
  console.log('[Setup] No .env file found — generating from .env.example with secure defaults...');
  let envContent = readFileSync(envExamplePath, 'utf-8');

  // Replace placeholder secrets with random values
  const jwtSecret = crypto.randomBytes(32).toString('hex');
  const encryptionKey = crypto.randomBytes(32).toString('hex');

  envContent = envContent.replace(
    /^JWT_SECRET=.*$/m,
    `JWT_SECRET=${jwtSecret}`
  );
  envContent = envContent.replace(
    /^# ENCRYPTION_KEY=.*$/m,
    `ENCRYPTION_KEY=${encryptionKey}`
  );

  writeFileSync(envPath, envContent, 'utf-8');
  console.log('[Setup] .env created with unique secrets. Review and customize as needed.');

  // Load env vars from the newly created file
  for (const line of envContent.split('\n')) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2];
    }
  }
} else if (existsSync(envPath)) {
  // Load existing .env file into process.env (values already set take precedence)
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2];
    }
  }
}

const app = express();
const PORT = process.env.PORT || 3001;
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:5173';

// ============================================
// Middleware Stack
// ============================================

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
// Routes
// ============================================

// Health check (no rate limiting)
app.get('/health', (req, res) => {
  const dispatcherStatus = getDispatcherStatus();
  res.json({ status: 'ok', version: '0.1.0', dispatcher: dispatcherStatus });
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
app.use('/api', routesRouter);  // Handles /api/projects/:id/routes and /api/routes/:id
app.use('/api/storage-connections', connectionsRouter);
app.use('/api/settings', settingsRouter);

// Serve uploaded files (deliverable attachments) with authentication
const uploadsPath = join(__dirname, '../data/uploads');
app.use('/uploads', dualAuth, express.static(uploadsPath));

// Serve static UI in production
const uiDistPath = join(__dirname, '../ui/dist');
if (existsSync(uiDistPath)) {
  app.use(express.static(uiDistPath));
  app.get('*', (req, res) => {
    // Don't serve index.html for API routes
    if (req.path.startsWith('/api/')) {
      return response.notFound(res, 'Endpoint');
    }
    res.sendFile(join(uiDistPath, 'index.html'));
  });
}

// ============================================
// Error Handling
// ============================================

// JSON parse error handler (must come before generic error handler)
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

// ============================================
// Server Startup
// ============================================

async function startServer() {
  // Initialize database (async for bcrypt)
  try {
    await initializeDatabase();
  } catch (err) {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  }

  // Start server
  app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════════════╗
║                                                          ║
║   Cavendo Engine v0.1.0                                  ║
║   Agent Workflow Platform                                ║
║                                                          ║
║   Server:  http://localhost:${PORT}                        ║
║   UI:      ${existsSync(uiDistPath) ? `http://localhost:${PORT}` : 'Run "npm run ui:dev" for development'}             ║
║                                                          ║
║   Security: Rate limiting, CSRF protection, bcrypt       ║
║                                                          ║
╚══════════════════════════════════════════════════════════╝
    `);

    // Process any pending webhook deliveries from previous session
    processPendingDeliveries().catch(err => {
      console.error('Error processing pending deliveries:', err);
    });

    // Start the task dispatcher for automatic execution
    startDispatcher();

    // Start the delivery route retry sweep
    startRetrySweep();

    // Periodic session cleanup (every 15 minutes)
    const SESSION_CLEANUP_INTERVAL = 15 * 60 * 1000;
    sessionCleanupHandle = setInterval(() => {
      try {
        const result = db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();
        if (result.changes > 0) {
          console.log(`[Sessions] Cleaned up ${result.changes} expired session(s)`);
        }
      } catch (err) {
        console.error('[Sessions] Cleanup error:', err);
      }
    }, SESSION_CLEANUP_INTERVAL);
  });
}

// Start the server
startServer().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

// ============================================
// Graceful Shutdown
// ============================================

process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down gracefully...');
  stopDispatcher();
  stopRetrySweep();
  if (sessionCleanupHandle) clearInterval(sessionCleanupHandle);
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down gracefully...');
  stopDispatcher();
  stopRetrySweep();
  if (sessionCleanupHandle) clearInterval(sessionCleanupHandle);
  process.exit(0);
});

export default app;
